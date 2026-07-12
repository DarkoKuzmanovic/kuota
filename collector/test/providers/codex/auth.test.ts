import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { nodeFileSystem } from "../../../src/io/atomic-write.js";
import { JsonFileError, readJsonFile } from "../../../src/io/json-file.js";
import {
  CODEX_AUTH_STATUS_TEXT,
  readCodexAuth,
  resolveCodexAuthPath,
  type CodexAuthResult,
} from "../../../src/providers/codex/auth.js";

const HOME = "/synthetic-home";
const AUTH_PATH = "/synthetic-home/.pi/agent/auth.json";
const NOW = 1_700_000_000_000;
const SYNTHETIC_ACCESS = "synthetic-codex-access-token";
const SYNTHETIC_ACCOUNT_ID = "synthetic-codex-account-id";
const SYNTHETIC_REFRESH = "synthetic-codex-refresh-token";

function readerReturning(value: unknown): (path: string) => Promise<unknown> {
  return async () => value;
}

async function classify(
  value: unknown,
  options: { readonly now?: number; readonly authPath?: string } = {},
): Promise<CodexAuthResult> {
  return readCodexAuth({
    homeDirectory: HOME,
    authPath: options.authPath,
    readJsonFile: readerReturning(value),
    now: () => options.now ?? NOW,
  });
}

test("resolves the default auth path from injected home and honors an exact override", async () => {
  assert.equal(resolveCodexAuthPath(HOME), AUTH_PATH);

  const requested: string[] = [];
  const result = await readCodexAuth({
    homeDirectory: "/another-home",
    authPath: AUTH_PATH,
    readJsonFile: async (path) => {
      requested.push(path);
      return undefined;
    },
  });

  assert.deepEqual(requested, [AUTH_PATH]);
  assert.deepEqual(result, {
    state: "auth-needed",
    reason: "missing-file",
    status: CODEX_AUTH_STATUS_TEXT.authNeeded,
  });
});

test("accepts only the openai-codex OAuth entry with required identity and optional refresh/expiry", async () => {
  const result = await classify({
    unrelated: { type: "oauth", access: "synthetic-other-access" },
    "openai-codex": {
      type: "oauth",
      access: SYNTHETIC_ACCESS,
      accountId: SYNTHETIC_ACCOUNT_ID,
      refresh: SYNTHETIC_REFRESH,
      expires: NOW + 60_000,
      future: { ignored: true },
    },
  });

  assert.deepEqual(result, {
    state: "available",
    status: CODEX_AUTH_STATUS_TEXT.available,
    credential: {
      access: SYNTHETIC_ACCESS,
      accountId: SYNTHETIC_ACCOUNT_ID,
      refresh: SYNTHETIC_REFRESH,
      expires: NOW + 60_000,
    },
  });

  const withoutRefresh = await classify({
    "openai-codex": {
      type: "oauth",
      access: SYNTHETIC_ACCESS,
      accountId: SYNTHETIC_ACCOUNT_ID,
      expires: NOW + 1,
    },
  });
  assert.deepEqual(withoutRefresh, {
    state: "available",
    status: CODEX_AUTH_STATUS_TEXT.available,
    credential: {
      access: SYNTHETIC_ACCESS,
      accountId: SYNTHETIC_ACCOUNT_ID,
      expires: NOW + 1,
    },
  });

  const withoutExpiry = await classify({
    "openai-codex": {
      type: "oauth",
      access: SYNTHETIC_ACCESS,
      accountId: SYNTHETIC_ACCOUNT_ID,
      refresh: SYNTHETIC_REFRESH,
    },
  });
  assert.deepEqual(withoutExpiry, {
    state: "available",
    status: CODEX_AUTH_STATUS_TEXT.available,
    credential: {
      access: SYNTHETIC_ACCESS,
      accountId: SYNTHETIC_ACCOUNT_ID,
      refresh: SYNTHETIC_REFRESH,
    },
  });
});

test("distinguishes expired credentials with and without a usable refresh token", async () => {
  const withRefresh = await classify({
    "openai-codex": {
      type: "oauth",
      access: SYNTHETIC_ACCESS,
      accountId: SYNTHETIC_ACCOUNT_ID,
      refresh: SYNTHETIC_REFRESH,
      expires: NOW,
    },
  });
  assert.deepEqual(withRefresh, {
    state: "expired-with-refresh",
    status: CODEX_AUTH_STATUS_TEXT.expiredWithRefresh,
    credential: {
      access: SYNTHETIC_ACCESS,
      accountId: SYNTHETIC_ACCOUNT_ID,
      refresh: SYNTHETIC_REFRESH,
      expires: NOW,
    },
  });

  const withoutRefresh = await classify({
    "openai-codex": {
      type: "oauth",
      access: SYNTHETIC_ACCESS,
      accountId: SYNTHETIC_ACCOUNT_ID,
      expires: NOW,
    },
  });
  assert.deepEqual(withoutRefresh, {
    state: "expired-without-refresh",
    status: CODEX_AUTH_STATUS_TEXT.authNeeded,
  });
  assert.equal(JSON.stringify(withoutRefresh).includes(SYNTHETIC_ACCESS), false);
  assert.equal(JSON.stringify(withoutRefresh).includes(SYNTHETIC_ACCOUNT_ID), false);
});

test("classifies missing and malformed Codex credentials without rejected values", async () => {
  const cases: readonly [unknown, string][] = [
    [undefined, "missing-file"],
    [{}, "missing-entry"],
    [{ "openai-codex": { type: "api_key" } }, "wrong-type"],
    [{ "openai-codex": { type: "oauth" } }, "missing-access"],
    [{ "openai-codex": { type: "oauth", access: "", accountId: SYNTHETIC_ACCOUNT_ID, expires: NOW + 1 } }, "empty-access"],
    [{ "openai-codex": { type: "oauth", access: 42, accountId: SYNTHETIC_ACCOUNT_ID, expires: NOW + 1 } }, "malformed-access"],
    [{ "openai-codex": { type: "oauth", access: SYNTHETIC_ACCESS, expires: NOW + 1 } }, "missing-account-id"],
    [{ "openai-codex": { type: "oauth", access: SYNTHETIC_ACCESS, accountId: "", expires: NOW + 1 } }, "empty-account-id"],
    [{ "openai-codex": { type: "oauth", access: SYNTHETIC_ACCESS, accountId: 42, expires: NOW + 1 } }, "malformed-account-id"],
    [{ "openai-codex": { type: "oauth", access: SYNTHETIC_ACCESS, accountId: SYNTHETIC_ACCOUNT_ID, refresh: "", expires: NOW + 1 } }, "empty-refresh"],
    [{ "openai-codex": { type: "oauth", access: SYNTHETIC_ACCESS, accountId: SYNTHETIC_ACCOUNT_ID, refresh: 42, expires: NOW + 1 } }, "malformed-refresh"],
    [{ "openai-codex": { type: "oauth", access: SYNTHETIC_ACCESS, accountId: SYNTHETIC_ACCOUNT_ID, expires: Number.NaN } }, "malformed-expires"],
  ];

  for (const [value, reason] of cases) {
    const result = await classify(value);
    assert.equal(result.state === "auth-needed" ? result.reason : undefined, reason);
    assert.equal(JSON.stringify(result).includes(SYNTHETIC_ACCESS), false);
    assert.equal(JSON.stringify(result).includes(SYNTHETIC_ACCOUNT_ID), false);
    assert.equal(JSON.stringify(result).includes(SYNTHETIC_REFRESH), false);
  }
});

test("maps unsafe and native read failures to constant value-free errors", async () => {
  const unsafeResult = await readCodexAuth({
    authPath: AUTH_PATH,
    readJsonFile: async () => {
      throw new JsonFileError("unsafe-file");
    },
  });
  assert.deepEqual(unsafeResult, {
    state: "error",
    reason: "auth-file-unsafe",
    status: CODEX_AUTH_STATUS_TEXT.error,
  });

  const nativeResult = await readCodexAuth({
    authPath: AUTH_PATH,
    readJsonFile: async () => {
      throw new Error(`${SYNTHETIC_ACCESS}:${SYNTHETIC_ACCOUNT_ID}`);
    },
  });
  assert.deepEqual(nativeResult, {
    state: "error",
    reason: "auth-file-read",
    status: CODEX_AUTH_STATUS_TEXT.error,
  });
  assert.equal(JSON.stringify(nativeResult).includes(SYNTHETIC_ACCESS), false);
  assert.equal(JSON.stringify(nativeResult).includes(SYNTHETIC_ACCOUNT_ID), false);
});

test("contains hostile parsed values and reader failures without evaluating credential accessors", async () => {
  const getterRoot: Record<string, unknown> = {};
  Object.defineProperty(getterRoot, "openai-codex", {
    enumerable: true,
    get() {
      throw new Error(SYNTHETIC_ACCESS);
    },
  });
  const rootResult = await classify(getterRoot);
  assert.deepEqual(rootResult, {
    state: "error",
    reason: "auth-file-not-object",
    status: CODEX_AUTH_STATUS_TEXT.error,
  });

  const getterEntry: Record<string, unknown> = {};
  Object.defineProperty(getterEntry, "access", {
    enumerable: true,
    get() {
      throw new Error(SYNTHETIC_ACCESS);
    },
  });
  const entryResult = await classify({ "openai-codex": getterEntry });
  assert.deepEqual(entryResult, {
    state: "auth-needed",
    reason: "wrong-type",
    status: CODEX_AUTH_STATUS_TEXT.authNeeded,
  });

  const hostileReader = new Proxy(Object.create(null), {
    getPrototypeOf() {
      throw new Error(SYNTHETIC_REFRESH);
    },
  });
  const readerResult = await readCodexAuth({
    authPath: AUTH_PATH,
    readJsonFile: async () => {
      throw hostileReader;
    },
  });
  assert.deepEqual(readerResult, {
    state: "error",
    reason: "auth-file-read",
    status: CODEX_AUTH_STATUS_TEXT.error,
  });
});

test("uses the safe reader for an injected symlink path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuota-codex-auth-synthetic-"));
  try {
    const target = join(directory, "target-auth.json");
    const link = join(directory, "auth.json");
    await writeFile(
      target,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: SYNTHETIC_ACCESS,
          accountId: SYNTHETIC_ACCOUNT_ID,
          expires: NOW + 1,
        },
      }),
      "utf8",
    );
    await symlink(target, link);

    const result = await readCodexAuth({
      authPath: link,
      readJsonFile: (path) => readJsonFile(path, { fs: nodeFileSystem }),
    });
    assert.deepEqual(result, {
      state: "error",
      reason: "auth-file-unsafe",
      status: CODEX_AUTH_STATUS_TEXT.error,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not mutate the parsed auth document while reading only the Codex entry", async () => {
  const document = {
    unrelated: { access: "synthetic-other-access" },
    "openai-codex": {
      type: "oauth",
      access: SYNTHETIC_ACCESS,
      accountId: SYNTHETIC_ACCOUNT_ID,
      expires: NOW + 1,
    },
  };
  const before = JSON.stringify(document);
  const result = await readCodexAuth({
    authPath: AUTH_PATH,
    readJsonFile: readerReturning(document),
    now: () => NOW,
  });

  assert.equal(JSON.stringify(document), before);
  assert.equal(result.state, "available");
});
