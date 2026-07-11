import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { nodeFileSystem } from "../../../src/io/atomic-write.js";
import { JsonFileError, readJsonFile } from "../../../src/io/json-file.js";
import { scanForSecrets } from "../../../src/security/redact.js";

import {
  CLAUDE_AUTH_STATUS_TEXT,
  readClaudeAuth,
  resolveClaudeAuthPath,
  type ClaudeAuthResult,
} from "../../../src/providers/claude/auth.js";

const HOME = "/synthetic-home";
const AUTH_PATH = "/synthetic-home/.pi/agent/auth.json";
const NOW = 1_700_000_000_000;
const SYNTHETIC_ACCESS = "synthetic-claude-access-token";

function readerReturning(value: unknown): (path: string) => Promise<unknown> {
  return async () => value;
}

async function classify(value: unknown, options: {
  readonly now?: number;
  readonly authPath?: string;
} = {}): Promise<ClaudeAuthResult> {
  const result = await readClaudeAuth({
    homeDirectory: HOME,
    authPath: options.authPath,
    readJsonFile: readerReturning(value),
    now: () => options.now ?? NOW,
  });
  return result;
}

test("resolves the default auth path from injected home without reading live auth", async () => {
  assert.equal(resolveClaudeAuthPath(HOME), AUTH_PATH);

  const requested: string[] = [];
  const result = await readClaudeAuth({
    homeDirectory: HOME,
    readJsonFile: async (path) => {
      requested.push(path);
      return undefined;
    },
    now: () => NOW,
  });

  assert.deepEqual(result, {
    state: "auth-needed",
    reason: "missing-file",
    status: CLAUDE_AUTH_STATUS_TEXT.authNeeded,
  });
  assert.deepEqual(requested, [AUTH_PATH]);
});

test("accepts the Anthropic OAuth entry and preserves optional expiry privately", async () => {
  const result = await classify({
    unrelated: { type: "oauth", access: "synthetic-other-provider" },
    anthropic: {
      type: "oauth",
      access: SYNTHETIC_ACCESS,
      refresh: "synthetic-refresh-token",
      expires: NOW + 60_000,
      other: { future: true },
    },
  });

  assert.deepEqual(result, {
    state: "available",
    status: CLAUDE_AUTH_STATUS_TEXT.available,
    credential: { access: SYNTHETIC_ACCESS, expires: NOW + 60_000 },
  });

  const withoutExpiry = await classify({
    anthropic: { type: "oauth", access: SYNTHETIC_ACCESS },
  });
  assert.deepEqual(withoutExpiry, {
    state: "available",
    status: CLAUDE_AUTH_STATUS_TEXT.available,
    credential: { access: SYNTHETIC_ACCESS },
  });
});

test("classifies a missing file or Anthropic entry as authentication-needed", async () => {
  const missingFile = await classify(undefined);
  assert.deepEqual(missingFile, {
    state: "auth-needed",
    reason: "missing-file",
    status: CLAUDE_AUTH_STATUS_TEXT.authNeeded,
  });

  const missingEntry = await classify({ codex: { type: "oauth" } });
  assert.deepEqual(missingEntry, {
    state: "auth-needed",
    reason: "missing-entry",
    status: CLAUDE_AUTH_STATUS_TEXT.authNeeded,
  });
});

test("classifies wrong credential types and access fields without exposing values", async () => {
  const cases: readonly [unknown, string][] = [
    [{ anthropic: { type: "api_key", access: SYNTHETIC_ACCESS } }, "wrong-type"],
    [{ anthropic: { type: "oauth" } }, "missing-access"],
    [{ anthropic: { type: "oauth", access: "" } }, "empty-access"],
    [{ anthropic: { type: "oauth", access: 42 } }, "malformed-access"],
  ];

  for (const [value, reason] of cases) {
    const result = await classify(value);
    assert.deepEqual(result, {
      state: "auth-needed",
      reason,
      status: CLAUDE_AUTH_STATUS_TEXT.authNeeded,
    });
    assert.equal(JSON.stringify(result).includes(SYNTHETIC_ACCESS), false);
  }
});

test("treats expiry as expired at the exact boundary and available in the future", async () => {
  const atBoundary = await classify(
    { anthropic: { type: "oauth", access: SYNTHETIC_ACCESS, expires: NOW } },
    { now: NOW },
  );
  assert.deepEqual(atBoundary, {
    state: "auth-needed",
    reason: "expired",
    status: CLAUDE_AUTH_STATUS_TEXT.authNeeded,
  });

  const future = await classify(
    { anthropic: { type: "oauth", access: SYNTHETIC_ACCESS, expires: NOW + 1 } },
    { now: NOW },
  );
  assert.deepEqual(future, {
    state: "available",
    status: CLAUDE_AUTH_STATUS_TEXT.available,
    credential: { access: SYNTHETIC_ACCESS, expires: NOW + 1 },
  });
});


test("rejects malformed expiry and credential fields as authentication-needed", async () => {
  const malformedExpiryValues: readonly unknown[] = [
    null,
    "synthetic-expiry",
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ];

  for (const expires of malformedExpiryValues) {
    const result = await classify({
      anthropic: { type: "oauth", access: SYNTHETIC_ACCESS, expires },
    });
    assert.deepEqual(result, {
      state: "auth-needed",
      reason: "malformed-expires",
      status: CLAUDE_AUTH_STATUS_TEXT.authNeeded,
    });
  }

});

test("rejects malformed whole-file roots and shape attacks as collector errors", async () => {
  const malformedRoots: readonly unknown[] = [null, [], "synthetic-root", 42, new Date(0)];
  for (const root of malformedRoots) {
    const result = await classify(root);
    assert.deepEqual(result, {
      state: "error",
      reason: "auth-file-not-object",
      status: CLAUDE_AUTH_STATUS_TEXT.error,
    });
  }

  const getterRoot: Record<string, unknown> = {};
  Object.defineProperty(getterRoot, "anthropic", {
    enumerable: true,
    get() {
      throw new Error(SYNTHETIC_ACCESS);
    },
  });
  const getterResult = await classify(getterRoot);
  assert.deepEqual(getterResult, {
    state: "error",
    reason: "auth-file-not-object",
    status: CLAUDE_AUTH_STATUS_TEXT.error,
  });

  const getterEntry: Record<string, unknown> = {};
  Object.defineProperty(getterEntry, "type", {
    enumerable: true,
    get() {
      throw new Error(SYNTHETIC_ACCESS);
    },
  });
  const entryResult = await classify({ anthropic: getterEntry });
  assert.deepEqual(entryResult, {
    state: "auth-needed",
    reason: "wrong-type",
    status: CLAUDE_AUTH_STATUS_TEXT.authNeeded,
  });
});

test("maps every JsonFileError category and native failures to value-free errors", async () => {
  const cases = [
    ["read", "auth-file-read"],
    ["malformed", "auth-file-malformed"],
    ["unsafe-file", "auth-file-unsafe"],
    ["not-object", "auth-file-not-object"],
    ["update", "auth-file-update"],
  ] as const;

  for (const [kind, reason] of cases) {
    const result = await readClaudeAuth({
      authPath: AUTH_PATH,
      readJsonFile: async () => {
        throw new JsonFileError(kind);
      },
    });
    assert.deepEqual(result, {
      state: "error",
      reason,
      status: CLAUDE_AUTH_STATUS_TEXT.error,
    });
  }

  const nativeFailure = await readClaudeAuth({
    authPath: AUTH_PATH,
    readJsonFile: async () => {
      throw new Error(`${AUTH_PATH}:${SYNTHETIC_ACCESS}`);
    },
  });
  assert.deepEqual(nativeFailure, {
    state: "error",
    reason: "auth-file-read",
    status: CLAUDE_AUTH_STATUS_TEXT.error,
  });
  assert.equal(JSON.stringify(nativeFailure).includes(SYNTHETIC_ACCESS), false);
});

test("maps hostile reader failures to a constant without inspecting unsafe values", async () => {
  const getPrototypeTrap = new Proxy(Object.create(null), {
    getPrototypeOf() {
      throw new Error(`${AUTH_PATH}:${SYNTHETIC_ACCESS}`);
    },
  });
  const forgedPrototype = Object.create(JsonFileError.prototype) as object;
  Object.defineProperty(forgedPrototype, "kind", { value: "unsafe-file" });
  const forgedFailure = Object.create(forgedPrototype);
  const forgedDirect = Object.create(JsonFileError.prototype) as object;
  Object.defineProperty(forgedDirect, "kind", { value: "unsafe-file" });
  const throwingKind = new JsonFileError("malformed");
  Object.defineProperty(throwingKind, "kind", {
    configurable: true,
    get() {
      throw new Error(`${AUTH_PATH}:${SYNTHETIC_ACCESS}`);
    },
  });

  const hostileValues: readonly unknown[] = [
    getPrototypeTrap,
    forgedFailure,
    forgedDirect,
    throwingKind,
    null,
    undefined,
    Symbol("hostile-reader-failure"),
    42,
    "hostile-reader-failure",
  ];
  for (const thrown of hostileValues) {
    const result = await readClaudeAuth({
      authPath: AUTH_PATH,
      readJsonFile: async () => {
        throw thrown;
      },
    });
    assert.deepEqual(result, {
      state: "error",
      reason: "auth-file-read",
      status: CLAUDE_AUTH_STATUS_TEXT.error,
    });
  }
});

test("refuses a symlink auth file through the safe no-follow JSON reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuota-claude-auth-synthetic-"));
  try {
    const target = join(directory, "target-auth.json");
    const link = join(directory, "auth.json");
    await writeFile(
      target,
      JSON.stringify({ anthropic: { type: "oauth", access: SYNTHETIC_ACCESS } }),
      "utf8",
    );
    await symlink(target, link);

    const result = await readClaudeAuth({
      authPath: link,
      readJsonFile: (path) => readJsonFile(path, { fs: nodeFileSystem }),
    });
    assert.deepEqual(result, {
      state: "error",
      reason: "auth-file-unsafe",
      status: CLAUDE_AUTH_STATUS_TEXT.error,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps tokens out of safe result surfaces and never uses env or Claude Code fallback", async () => {
  const envKeys = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_TOKEN"] as const;
  const previous = new Map<string, string | undefined>();
  for (const key of envKeys) {
    previous.set(key, process.env[key]);
    process.env[key] = SYNTHETIC_ACCESS;
  }

  try {
    const result = await readClaudeAuth({
      homeDirectory: HOME,
      readJsonFile: async (path) => {
        assert.equal(path, AUTH_PATH);
        return { claudeCode: { type: "oauth", access: SYNTHETIC_ACCESS } };
      },
      now: () => NOW,
    });
    assert.deepEqual(result, {
      state: "auth-needed",
      reason: "missing-entry",
      status: CLAUDE_AUTH_STATUS_TEXT.authNeeded,
    });

    const available = await classify({
      anthropic: { type: "oauth", access: SYNTHETIC_ACCESS },
    });
    assert.equal(available.state, "available");
    if (available.state !== "available") return;

    const safeSurface = {
      state: available.state,
      status: available.status,
    };
    assert.equal(JSON.stringify(safeSurface).includes(SYNTHETIC_ACCESS), false);
    assert.equal(JSON.stringify(available.credential).includes(SYNTHETIC_ACCESS), true);
    assert.deepEqual(scanForSecrets(safeSurface), []);
    assert.deepEqual(scanForSecrets(available), [
      { path: "credential", reason: "secret key detected" },
      { path: "credential.access", reason: "secret key detected" },
    ]);

    const diagnostic = `${result.status} (${result.reason})`;
    assert.equal(diagnostic.includes(SYNTHETIC_ACCESS), false);
  } finally {
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("uses an injected exact auth path instead of consulting another home or fallback", async () => {
  const exactPath = "/synthetic-exact/auth.json";
  const requested: string[] = [];
  const result = await readClaudeAuth({
    homeDirectory: "/synthetic-other-home",
    authPath: exactPath,
    readJsonFile: async (path) => {
      requested.push(path);
      return undefined;
    },
  });

  assert.deepEqual(requested, [exactPath]);
  assert.deepEqual(result, {
    state: "auth-needed",
    reason: "missing-file",
    status: CLAUDE_AUTH_STATUS_TEXT.authNeeded,
  });
});

test("does not mutate the parsed auth document while classifying it", async () => {
  const document = {
    unrelated: { enabled: true },
    anthropic: { type: "oauth", access: SYNTHETIC_ACCESS, expires: NOW + 1 },
  };
  const before = JSON.stringify(document);
  let readCount = 0;
  const result = await readClaudeAuth({
    authPath: AUTH_PATH,
    readJsonFile: async () => {
      readCount += 1;
      return document;
    },
    now: () => NOW,
  });

  assert.equal(readCount, 1);
  assert.equal(JSON.stringify(document), before);
  assert.equal(result.state, "available");
});
