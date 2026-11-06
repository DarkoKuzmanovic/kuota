import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readSessionCookie, type SessionCookieSpec } from "../../src/providers/firefox-cookies.js";

// Synthetic Firefox profiles; every cookie value is a recognizable non-secret.
const SPEC: SessionCookieSpec = { hosts: [".example-synthetic.test"], namePattern: "ory_session_%", envKey: "SYNTHETIC_COOKIE" };
const FUTURE = 4_102_444_800; // 2100-01-01

async function profile(home: string, name: string, rows: readonly (readonly [string, string, string, number])[]): Promise<string> {
  const dir = join(home, ".mozilla", "firefox", name);
  await mkdir(dir, { recursive: true });
  const db = join(dir, "cookies.sqlite");
  const values = rows.map(([host, n, v, expiry]) => `('${host}','${n}','${v}',${expiry})`).join(",");
  execFileSync("/usr/bin/sqlite3", [db,
    `CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, expiry INTEGER);${rows.length > 0 ? `INSERT INTO moz_cookies VALUES ${values};` : ""}`]);
  return db;
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "kuota-ff-synthetic-"));
  const tempRoot = await mkdtemp(join(tmpdir(), "kuota-ff-temp-"));
  return { home, tempRoot, cleanup: async () => { await rm(home, { recursive: true, force: true }); await rm(tempRoot, { recursive: true, force: true }); } };
}

test("reads only the provider's live session cookies from the newest profile and deletes the copy", async () => {
  const { home, tempRoot, cleanup } = await fixture();
  try {
    const old = await profile(home, "old.default", [[".example-synthetic.test", "ory_session_a", "synthetic-old-not-real", FUTURE]]);
    await utimes(old, new Date(1_000_000), new Date(1_000_000));
    await profile(home, "new.default", [
      [".example-synthetic.test", "ory_session_a", "synthetic-new-not-real", FUTURE],
      [".example-synthetic.test", "ory_session_expired", "synthetic-expired", 1],
      [".example-synthetic.test", "unrelated", "synthetic-unrelated", FUTURE],
      [".other-synthetic.test", "ory_session_b", "synthetic-other-host", FUTURE],
    ]);
    const result = await readSessionCookie(SPEC, { homeDirectory: home, environment: {}, tempRoot });
    assert.deepEqual(result, { state: "available", cookie: "ory_session_a=synthetic-new-not-real" });
    assert.deepEqual(await readdir(tempRoot), [], "temporary cookie copy removed");
  } finally {
    await cleanup();
  }
});

test("falls back to the env cookie only when Firefox has no session", async () => {
  const { home, tempRoot, cleanup } = await fixture();
  try {
    const environment = { SYNTHETIC_COOKIE: "ory_session_x=synthetic-env-not-real" };
    assert.deepEqual(await readSessionCookie(SPEC, { homeDirectory: home, environment, tempRoot }),
      { state: "available", cookie: "ory_session_x=synthetic-env-not-real" });
    await profile(home, "p.default", []);
    assert.deepEqual(await readSessionCookie(SPEC, { homeDirectory: home, environment: {}, tempRoot }), { state: "auth-needed" });
    assert.deepEqual(await readSessionCookie(SPEC, { homeDirectory: home, environment: { SYNTHETIC_COOKIE: "bad\r\nInjected: header" }, tempRoot }),
      { state: "auth-needed" }, "header-unsafe env value rejected");
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await cleanup();
  }
});

test("missing sqlite3 is an error unless the env cookie is set; failures still clean up", async () => {
  const { home, tempRoot, cleanup } = await fixture();
  try {
    await profile(home, "p.default", [[".example-synthetic.test", "ory_session_a", "synthetic-not-real", FUTURE]]);
    const runSqlite = async () => ({ code: 127, stdout: "", stderr: "" });
    assert.deepEqual(await readSessionCookie(SPEC, { homeDirectory: home, environment: {}, tempRoot, runSqlite }),
      { state: "error", reason: "sqlite-unavailable" });
    assert.deepEqual(await readSessionCookie(SPEC, { homeDirectory: home, environment: { SYNTHETIC_COOKIE: "a=synthetic" }, tempRoot, runSqlite }),
      { state: "available", cookie: "a=synthetic" });
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await cleanup();
  }
});

test("refuses a spec whose tokens could escape the SQL literal", async () => {
  const { home, tempRoot, cleanup } = await fixture();
  try {
    await profile(home, "p.default", []);
    let ran = false;
    const runSqlite = async () => { ran = true; return { code: 0, stdout: "", stderr: "" }; };
    const result = await readSessionCookie({ ...SPEC, hosts: ["x' OR '1'='1"] }, { homeDirectory: home, environment: {}, tempRoot, runSqlite });
    assert.deepEqual(result, { state: "error", reason: "sqlite-failed" });
    assert.equal(ran, false);
  } finally {
    await cleanup();
  }
});
