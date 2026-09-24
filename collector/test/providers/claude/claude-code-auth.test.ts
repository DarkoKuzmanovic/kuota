import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { nodeFileSystem } from "../../../src/io/atomic-write.js";
import { readJsonFile } from "../../../src/io/json-file.js";
import { scanForSecrets } from "../../../src/security/redact.js";

import {
  CLAUDE_AUTH_STATUS_TEXT,
  readClaudeAuth,
  readClaudeCodeAuth,
  resolveClaudeCodeCredentialsPath,
  resolvePiClaudeAuthPath,
  type ClaudeAuthNeededReason,
  type ClaudeAuthResult,
} from "../../../src/providers/claude/auth.js";

const HOME = "/synthetic-home";
const CC_PATH = "/synthetic-home/.claude/.credentials.json";
const PI_PATH = "/synthetic-home/.pi/agent/auth.json";
const NOW = 1_700_000_000_000;
const CC_ACCESS = "synthetic-claude-code-access-token";
const CC_REFRESH = "synthetic-claude-code-refresh-token";
const MCP_SECRET = "synthetic-mcp-oauth-token";
const PI_ACCESS = "synthetic-pi-access-token";
const PROFILE_SCOPES = ["user:inference", "user:profile"];

function ccDocument(oauth: unknown): Record<string, unknown> {
  return {
    claudeAiOauth: oauth,
    mcpOAuth: { "synthetic-server": { accessToken: MCP_SECRET } },
  };
}

function authNeeded(reason: ClaudeAuthNeededReason): ClaudeAuthResult {
  return { state: "auth-needed", reason, status: CLAUDE_AUTH_STATUS_TEXT.authNeeded };
}

async function classifyCc(document: unknown): Promise<ClaudeAuthResult> {
  return readClaudeCodeAuth({
    homeDirectory: HOME,
    readJsonFile: async () => document,
    now: () => NOW,
  });
}

/** Chain reader over an in-memory filesystem keyed by exact path; records read order. */
function chain(files: Readonly<Record<string, unknown>>) {
  const requested: string[] = [];
  const result = readClaudeAuth({
    homeDirectory: HOME,
    readJsonFile: async (path) => {
      requested.push(path);
      const value = files[path];
      if (value instanceof Error) throw value;
      return value;
    },
    now: () => NOW,
  });
  return { result, requested };
}

test("resolves the Claude Code credentials path from an injected home", async () => {
  assert.equal(resolveClaudeCodeCredentialsPath(HOME), CC_PATH);
  assert.equal(resolvePiClaudeAuthPath(HOME), PI_PATH);

  const requested: string[] = [];
  const result = await readClaudeCodeAuth({
    homeDirectory: HOME,
    readJsonFile: async (path) => {
      requested.push(path);
      return undefined;
    },
    now: () => NOW,
  });
  assert.deepEqual(requested, [CC_PATH]);
  assert.deepEqual(result, authNeeded("missing-file"));
});

test("maps the Claude Code OAuth entry to the shared private credential", async () => {
  const result = await classifyCc(
    ccDocument({
      accessToken: CC_ACCESS,
      refreshToken: CC_REFRESH,
      expiresAt: NOW + 60_000,
      scopes: PROFILE_SCOPES,
      subscriptionType: "synthetic-plan",
    }),
  );
  assert.deepEqual(result, {
    state: "available",
    status: CLAUDE_AUTH_STATUS_TEXT.available,
    credential: { access: CC_ACCESS, expires: NOW + 60_000 },
  });

  const withoutOptional = await classifyCc(ccDocument({ accessToken: CC_ACCESS }));
  assert.deepEqual(withoutOptional, {
    state: "available",
    status: CLAUDE_AUTH_STATUS_TEXT.available,
    credential: { access: CC_ACCESS },
  });
});

test("never carries the refresh token or MCP credentials into any result", async () => {
  const result = await classifyCc(
    ccDocument({ accessToken: CC_ACCESS, refreshToken: CC_REFRESH, scopes: PROFILE_SCOPES }),
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(CC_REFRESH), false);
  assert.equal(serialized.includes(MCP_SECRET), false);

  const failed = await classifyCc(ccDocument({ refreshToken: CC_REFRESH }));
  assert.deepEqual(failed, authNeeded("missing-access"));
  assert.deepEqual(scanForSecrets(failed), []);
  assert.equal(JSON.stringify(failed).includes(CC_REFRESH), false);
});

test("classifies missing, malformed, empty, and expired Claude Code credentials", async () => {
  assert.deepEqual(await classifyCc({ mcpOAuth: {} }), authNeeded("missing-entry"));
  assert.deepEqual(await classifyCc(ccDocument("synthetic-not-an-object")), authNeeded("wrong-type"));
  assert.deepEqual(await classifyCc(ccDocument({})), authNeeded("missing-access"));
  assert.deepEqual(await classifyCc(ccDocument({ accessToken: 42 })), authNeeded("malformed-access"));
  assert.deepEqual(await classifyCc(ccDocument({ accessToken: "  " })), authNeeded("empty-access"));
  assert.deepEqual(
    await classifyCc(ccDocument({ accessToken: CC_ACCESS, expiresAt: "soon" })),
    authNeeded("malformed-expires"),
  );
  assert.deepEqual(
    await classifyCc(ccDocument({ accessToken: CC_ACCESS, expiresAt: NOW })),
    authNeeded("expired"),
  );
  assert.equal(
    (await classifyCc(ccDocument({ accessToken: CC_ACCESS, expiresAt: NOW + 1 }))).state,
    "available",
  );
});

test("requires the profile scope when Claude Code declares scopes", async () => {
  assert.deepEqual(
    await classifyCc(ccDocument({ accessToken: CC_ACCESS, scopes: ["user:inference"] })),
    authNeeded("insufficient-scope"),
  );
  assert.deepEqual(
    await classifyCc(ccDocument({ accessToken: CC_ACCESS, scopes: "user:profile" })),
    authNeeded("malformed-scopes"),
  );
  assert.deepEqual(
    await classifyCc(ccDocument({ accessToken: CC_ACCESS, scopes: ["user:profile", 7] })),
    authNeeded("malformed-scopes"),
  );
});

test("maps Claude Code whole-file failures to value-free errors", async () => {
  assert.deepEqual(await classifyCc(["synthetic-array"]), {
    state: "error",
    reason: "auth-file-not-object",
    status: CLAUDE_AUTH_STATUS_TEXT.error,
  });
  const thrown = await readClaudeCodeAuth({
    credentialsPath: CC_PATH,
    readJsonFile: async () => {
      throw new Error(CC_ACCESS);
    },
  });
  assert.deepEqual(thrown, {
    state: "error",
    reason: "auth-file-read",
    status: CLAUDE_AUTH_STATUS_TEXT.error,
  });
  assert.equal(JSON.stringify(thrown).includes(CC_ACCESS), false);
});

test("refuses a symlinked Claude Code credentials file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuota-claude-code-auth-synthetic-"));
  try {
    const target = join(directory, "target.json");
    const link = join(directory, ".credentials.json");
    await writeFile(target, JSON.stringify(ccDocument({ accessToken: CC_ACCESS })), "utf8");
    await symlink(target, link);

    const result = await readClaudeCodeAuth({
      credentialsPath: link,
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

test("chain prefers an available Claude Code credential and never reads Pi", async () => {
  const { result, requested } = chain({
    [CC_PATH]: ccDocument({ accessToken: CC_ACCESS, scopes: PROFILE_SCOPES }),
    [PI_PATH]: { anthropic: { type: "oauth", access: PI_ACCESS } },
  });
  assert.deepEqual(await result, {
    state: "available",
    status: CLAUDE_AUTH_STATUS_TEXT.available,
    credential: { access: CC_ACCESS },
  });
  assert.deepEqual(requested, [CC_PATH]);
});

test("chain falls back to Pi when Claude Code is expired, missing, unscoped, or unsafe", async () => {
  const piAvailable = {
    state: "available",
    status: CLAUDE_AUTH_STATUS_TEXT.available,
    credential: { access: PI_ACCESS },
  };
  const pi = { anthropic: { type: "oauth", access: PI_ACCESS } };

  for (const ccFile of [
    ccDocument({ accessToken: CC_ACCESS, expiresAt: NOW - 1 }),
    undefined,
    ccDocument({ accessToken: CC_ACCESS, scopes: ["user:inference"] }),
    new Error("synthetic unreadable credentials"),
  ]) {
    const { result, requested } = chain({ [CC_PATH]: ccFile, [PI_PATH]: pi });
    assert.deepEqual(await result, piAvailable);
    assert.deepEqual(requested, [CC_PATH, PI_PATH]);
  }
});

test("chain reports auth-needed when neither source is usable and any needs sign-in", async () => {
  const expiredCc = ccDocument({ accessToken: CC_ACCESS, expiresAt: NOW - 1 });
  const expiredPi = { anthropic: { type: "oauth", access: PI_ACCESS, expires: NOW - 1 } };

  assert.deepEqual(await chain({ [CC_PATH]: expiredCc, [PI_PATH]: expiredPi }).result, authNeeded("expired"));
  assert.deepEqual(await chain({}).result, authNeeded("missing-file"));
  // A Claude Code read error does not mask an actionable Pi sign-in state.
  assert.deepEqual(
    await chain({ [CC_PATH]: new Error("synthetic"), [PI_PATH]: expiredPi }).result,
    authNeeded("expired"),
  );
  // Both sources erroring stays an error.
  assert.deepEqual(
    await chain({ [CC_PATH]: ["synthetic"], [PI_PATH]: ["synthetic"] }).result,
    {
      state: "error",
      reason: "auth-file-not-object",
      status: CLAUDE_AUTH_STATUS_TEXT.error,
    },
  );
});

test("chain honors exact per-source path overrides", async () => {
  const ccExact = "/synthetic-exact/cc.json";
  const piExact = "/synthetic-exact/pi.json";
  const requested: string[] = [];
  const result = await readClaudeAuth({
    homeDirectory: "/synthetic-other-home",
    claudeCodeCredentialsPath: ccExact,
    piAuthPath: piExact,
    readJsonFile: async (path) => {
      requested.push(path);
      return path === piExact ? { anthropic: { type: "oauth", access: PI_ACCESS } } : undefined;
    },
    now: () => NOW,
  });
  assert.deepEqual(requested, [ccExact, piExact]);
  assert.equal(result.state, "available");
});

test("chain returns the Claude Code sign-in reason when Pi errors", async () => {
  const { result } = chain({
    [CC_PATH]: ccDocument({ accessToken: CC_ACCESS, expiresAt: NOW - 1 }),
    [PI_PATH]: ["synthetic"],
  });
  assert.deepEqual(await result, authNeeded("expired"));
});

test("chain falls back to a non-expiring Pi credential when the clock fails for Claude Code", async () => {
  const result = await readClaudeAuth({
    homeDirectory: HOME,
    readJsonFile: async (path) =>
      path === CC_PATH
        ? ccDocument({ accessToken: CC_ACCESS, expiresAt: NOW + 1 })
        : { anthropic: { type: "oauth", access: PI_ACCESS } },
    now: () => Number.NaN,
  });
  assert.deepEqual(result, {
    state: "available",
    status: CLAUDE_AUTH_STATUS_TEXT.available,
    credential: { access: PI_ACCESS },
  });
});
