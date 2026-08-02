import assert from "node:assert/strict";
import test from "node:test";

import {
  readCursorAuth,
} from "../../../src/providers/cursor/auth.js";

const LOCAL_TOKEN = "local-token-synthetic";
const ENV_TOKEN = "env-token-synthetic";

test("prefers local state.vscdb token over env", async () => {
  const result = await readCursorAuth({
    homeDirectory: "/tmp/synthetic-home",
    environment: { CURSOR_SESSION_TOKEN: ENV_TOKEN },
    stateDbCandidates: ["/tmp/synthetic-home/.config/Cursor/User/globalStorage/state.vscdb"],
    runSqlite: async () => ({ code: 0, stdout: `${LOCAL_TOKEN}\n`, stderr: "" }),
  });
  assert.equal(result.state, "available");
  if (result.state === "available") assert.equal(result.credential.value, LOCAL_TOKEN);
});

test("falls back to CURSOR_SESSION_TOKEN when local missing", async () => {
  const result = await readCursorAuth({
    environment: { CURSOR_SESSION_TOKEN: ENV_TOKEN },
    stateDbCandidates: ["/tmp/missing/state.vscdb"],
    runSqlite: async () => ({ code: 1, stdout: "", stderr: "unable to open" }),
  });
  assert.equal(result.state, "available");
  if (result.state === "available") assert.equal(result.credential.value, ENV_TOKEN);
});

test("auth-needed when local and env both unusable", async () => {
  const result = await readCursorAuth({
    environment: {},
    stateDbCandidates: ["/tmp/missing/state.vscdb"],
    runSqlite: async () => ({ code: 1, stdout: "", stderr: "" }),
  });
  assert.equal(result.state, "auth-needed");
});

test("never echoes discovered tokens outside the credential value", async () => {
  const result = await readCursorAuth({
    environment: { CURSOR_SESSION_TOKEN: ENV_TOKEN },
    stateDbCandidates: ["/tmp/missing/state.vscdb"],
    runSqlite: async () => ({ code: 1, stdout: "", stderr: "" }),
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(ENV_TOKEN), result.state === "available");
  if (result.state !== "available") {
    assert.equal(serialized.includes(ENV_TOKEN), false);
  }
});

test("returns sqlite-unavailable when sqlite3 is missing and env is absent", async () => {
  const result = await readCursorAuth({
    environment: {},
    stateDbCandidates: ["/tmp/missing/state.vscdb"],
    runSqlite: async () => ({ code: 127, stdout: "", stderr: "sqlite3 unavailable" }),
  });
  assert.deepEqual(result, { state: "error", reason: "sqlite-unavailable" });
});
