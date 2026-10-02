import assert from "node:assert/strict";
import test from "node:test";

import { JsonFileError } from "../../../src/io/json-file.js";

import {
  CLAUDE_AUTH_STATUS_TEXT,
  readClaudeCodeAuth,
  type ClaudeAuthResult,
} from "../../../src/providers/claude/auth.js";

// Shared whole-file failure mapping, exercised through the only Claude source
// (Claude Code). The Pi reader was removed by
// docs/specs/2026-10-02-standalone-credentials-design.md.
const CC_PATH = "/synthetic-home/.claude/.credentials.json";
const NOW = 1_700_000_000_000;
const SYNTHETIC_ACCESS = "synthetic-claude-access-token";

async function classify(value: unknown): Promise<ClaudeAuthResult> {
  return readClaudeCodeAuth({ credentialsPath: CC_PATH, readJsonFile: async () => value, now: () => NOW });
}

function failingWith(thrown: unknown): Promise<ClaudeAuthResult> {
  return readClaudeCodeAuth({
    credentialsPath: CC_PATH,
    readJsonFile: async () => {
      throw thrown;
    },
  });
}

test("rejects malformed whole-file roots and shape attacks as collector errors", async () => {
  for (const root of [null, [], "synthetic-root", 42, new Date(0)]) {
    assert.deepEqual(await classify(root), {
      state: "error",
      reason: "auth-file-not-object",
      status: CLAUDE_AUTH_STATUS_TEXT.error,
    });
  }

  const getterRoot: Record<string, unknown> = {};
  Object.defineProperty(getterRoot, "claudeAiOauth", {
    enumerable: true,
    get() {
      throw new Error(SYNTHETIC_ACCESS);
    },
  });
  const getterResult = await classify(getterRoot);
  assert.equal(getterResult.state, "error");
  assert.equal(JSON.stringify(getterResult).includes(SYNTHETIC_ACCESS), false);
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
    assert.deepEqual(await failingWith(new JsonFileError(kind)), {
      state: "error",
      reason,
      status: CLAUDE_AUTH_STATUS_TEXT.error,
    });
  }

  const nativeFailure = await failingWith(new Error(`${CC_PATH}:${SYNTHETIC_ACCESS}`));
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
      throw new Error(`${CC_PATH}:${SYNTHETIC_ACCESS}`);
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
      throw new Error(`${CC_PATH}:${SYNTHETIC_ACCESS}`);
    },
  });

  for (const thrown of [
    getPrototypeTrap,
    forgedFailure,
    forgedDirect,
    throwingKind,
    null,
    undefined,
    Symbol("hostile-reader-failure"),
    42,
    "hostile-reader-failure",
  ]) {
    assert.deepEqual(await failingWith(thrown), {
      state: "error",
      reason: "auth-file-read",
      status: CLAUDE_AUTH_STATUS_TEXT.error,
    });
  }
});
