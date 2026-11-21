import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PROVIDER_IDS } from "../src/contract/schema-v1.js";
import { scanForSecrets } from "../src/security/redact.js";
import { runDoctor } from "../src/doctor/command.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("doctor reports every provider offline without revealing environment credentials", () => {
  const home = mkdtempSync(join(tmpdir(), "kuota-doctor-synthetic-"));
  const secret = "synthetic-doctor-secret-not-real";
  try {
    const result = spawnSync(process.execPath, [cli, "doctor"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", KIMI_API_KEY: secret }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /offline/i);
    for (const id of PROVIDER_IDS) assert.match(result.stdout, new RegExp(`\\b${id}\\b`));
    assert.match(result.stdout, /kimi.*environment.*present/i);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
    assert.deepEqual(scanForSecrets({ output: result.stdout, errors: result.stderr }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor classifies the browser environment fallback without exposing it", () => {
  const home = mkdtempSync(join(tmpdir(), "kuota-doctor-synthetic-"));
  const secret = "synthetic-browser-cookie-not-real";
  try {
    const result = spawnSync(process.execPath, [cli, "doctor"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", MISTRAL_SESSION_COOKIE: secret }, encoding: "utf8", timeout: 10000,
    });
    assert.match(result.stdout, /mistral.*environment.*present/i);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor reads a Firefox cookie without creating a private copy or disclosing it", () => {
  const home = mkdtempSync(join(tmpdir(), "kuota-doctor-browser-"));
  const profile = join(home, ".mozilla", "firefox", "profile.default");
  const temp = join(home, "tmp");
  mkdirSync(profile, { recursive: true });
  mkdirSync(temp);
  const db = join(profile, "cookies.sqlite");
  const secret = "synthetic-browser-session-not-real";
  try {
    const create = spawnSync("/usr/bin/sqlite3", [db, `CREATE TABLE moz_cookies(host TEXT, name TEXT, value TEXT, expiry INTEGER); INSERT INTO moz_cookies VALUES('.mistral.ai','ory_session_a','${secret}',4102444800);`]);
    assert.equal(create.status, 0);
    const before = readFileSync(db);
    const result = spawnSync(process.execPath, [cli, "doctor"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: temp }, encoding: "utf8", timeout: 10000,
    });
    assert.match(result.stdout, /mistral.*Firefox cookie.*present/i);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
    assert.deepEqual(readFileSync(db), before);
    assert.deepEqual(readdirSync(profile), ["cookies.sqlite"]);
    assert.deepEqual(readdirSync(temp), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor does not guess Cursor source when a WAL prevents a write-free read", () => {
  const home = mkdtempSync(join(tmpdir(), "kuota-doctor-cursor-"));
  const dir = join(home, ".config", "Cursor", "User", "globalStorage");
  mkdirSync(dir, { recursive: true });
  const db = join(dir, "state.vscdb");
  try {
    assert.equal(spawnSync("/usr/bin/sqlite3", [db, "CREATE TABLE ItemTable(key TEXT, value TEXT);"]).status, 0);
    writeFileSync(`${db}-wal`, "synthetic-wal");
    const result = spawnSync(process.execPath, [cli, "doctor"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", CURSOR_SESSION_TOKEN: "synthetic-cursor-not-real" }, encoding: "utf8", timeout: 10000,
    });
    assert.match(result.stdout, /cursor.*Cursor file.*unavailable/i);
    assert.deepEqual(readdirSync(dir).sort(), ["state.vscdb", "state.vscdb-wal"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor marks an insecure Kuota credential source unsafe without printing its contents", () => {
  const home = mkdtempSync(join(tmpdir(), "kuota-doctor-store-"));
  const dir = join(home, ".config", "kuota");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = "synthetic-insecure-key-not-real";
  try {
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ opencode: { type: "api_key", key: secret } }), { mode: 0o644 });
    const result = spawnSync(process.execPath, [cli, "doctor"], {
      env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 10000,
    });
    assert.match(result.stdout, /opencode.*Kuota store.*unsafe/i);
    assert.match(result.stdout, /opencode.*unsafe.*permissions/i);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
    assert.equal(result.status, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor distinguishes cached success from current state and reports active backoff", async () => {
  const home = mkdtempSync(join(tmpdir(), "kuota-doctor-cache-"));
  const dir = join(home, ".cache", "kuota");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = Date.parse("2026-11-22T12:00:00.000Z");
  const stamp = "2026-11-22T11:59:00.000Z";
  try {
    writeFileSync(join(dir, "collector.json"), JSON.stringify({
      schemaVersion: 1, savedAt: stamp,
      records: [{ id: "codex", state: "ok", lastSuccessAt: stamp, details: { codex: { credits: 3 } } }],
    }));
    writeFileSync(join(dir, "claude-backoff.json"), JSON.stringify({ schemaVersion: 1, retryAt: "2026-11-22T12:01:00.000Z" }));
    const out: string[] = [];
    await runDoctor({ write: (line) => { out.push(line); } }, home, {}, now);
    const text = out.join("");
    assert.match(text, /Collector cache: available/);
    assert.match(text, /backoff: 60s remaining/);
    assert.match(text, /Last cached observation: ok; last success 60s ago/);
    assert.match(text, /not the last refresh attempt/i);
    assert.match(text, /re-login will NOT help unless the state is auth-needed/i);
    assert.match(text, /endpoint drift/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor succeeds with all default sources present even when opt-in providers are missing", async () => {
  const home = mkdtempSync(join(tmpdir(), "kuota-doctor-ready-"));
  const config = join(home, ".config", "kuota");
  const cache = join(home, ".cache", "kuota");
  const claude = join(home, ".claude");
  for (const path of [config, cache, claude]) mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(claude, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-claude-not-real" } }), { mode: 0o600 });
    writeFileSync(join(config, "credentials.json"), JSON.stringify({
      codex: { type: "oauth", access: "synthetic-codex-not-real", accountId: "synthetic-account-not-real" },
      grok: { type: "oauth", access: "synthetic-grok-not-real" },
      kimi: { type: "api_key", key: "synthetic-kimi-not-real" },
      opencode: { type: "api_key", key: "synthetic-opencode-not-real" },
      commandcode: { type: "api_key", key: "synthetic-commandcode-not-real" },
    }), { mode: 0o600 });
    const output: string[] = [];
    const code = await runDoctor({ write: (line) => { output.push(line); } }, home, { CURSOR_SESSION_TOKEN: "synthetic-cursor-not-real" });
    assert.equal(code, 0);
    assert.match(output.join(""), /mistral.*opt-in.*missing/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor rejects extra arguments without echoing them", () => {
  const secret = "synthetic-extra-secret-not-real";
  const result = spawnSync(process.execPath, [cli, "doctor", secret], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
});

test("doctor detects a collector and Plasma package version mismatch without printing metadata", () => {
  const home = mkdtempSync(join(tmpdir(), "kuota-doctor-version-"));
  const root = join(home, "package");
  const collector = join(root, "contents", "code", "collector");
  try {
    mkdirSync(collector, { recursive: true });
    cpSync(fileURLToPath(new URL("../src/", import.meta.url)), collector, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, "metadata.json"), JSON.stringify({ KPlugin: { Version: "9.9.9" } }));
    writeFileSync(join(collector, "build-info.json"), JSON.stringify({ version: "1.2.3" }));
    const result = spawnSync(process.execPath, [join(collector, "cli.js"), "doctor"], {
      env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 10000,
    });
    assert.match(result.stdout, /collector version: 1\.2\.3/i);
    assert.match(result.stdout, /package version: 9\.9\.9/i);
    assert.match(result.stdout, /version mismatch/i);
    assert.equal(result.status, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor checks curl on the inherited PATH rather than assuming /usr/bin is searched", () => {
  const home = mkdtempSync(join(tmpdir(), "kuota-doctor-path-"));
  try {
    const result = spawnSync(process.execPath, [cli, "doctor"], {
      env: { HOME: home, PATH: "" }, encoding: "utf8", timeout: 10000,
    });
    assert.match(result.stdout, /curl: missing/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor classifies a symlinked Firefox cookie database as unsafe", () => {
  const home = mkdtempSync(join(tmpdir(), "kuota-doctor-symlink-"));
  const profile = join(home, ".mozilla", "firefox", "profile.default");
  mkdirSync(profile, { recursive: true });
  try {
    const target = join(home, "target.sqlite");
    assert.equal(spawnSync("/usr/bin/sqlite3", [target, "CREATE TABLE moz_cookies(host TEXT, name TEXT, value TEXT, expiry INTEGER);"]).status, 0);
    symlinkSync(target, join(profile, "cookies.sqlite"));
    const result = spawnSync(process.execPath, [cli, "doctor"], {
      env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 10000,
    });
    assert.match(result.stdout, /mistral.*Firefox cookie.*unsafe/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor reports expired and malformed stored credentials without printing secret fields", async () => {
  const home = mkdtempSync(join(tmpdir(), "kuota-doctor-auth-"));
  const config = join(home, ".config", "kuota");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const secret = "synthetic-expired-secret-not-real";
  try {
    writeFileSync(join(config, "credentials.json"), JSON.stringify({
      grok: { type: "oauth", access: secret, refresh: "synthetic-refresh-not-real", expires: 1 },
      kimi: { type: "api_key", key: "" },
    }), { mode: 0o600 });
    const output: string[] = [];
    await runDoctor({ write: (line) => { output.push(line); } }, home, {});
    const text = output.join("");
    assert.match(text, /grok.*Kuota store.*expired/i);
    assert.match(text, /kimi.*Kuota store.*malformed/i);
    assert.doesNotMatch(text, new RegExp(secret));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor detects an unsafe collector lock without modifying it", async () => {
  const home = mkdtempSync(join(tmpdir(), "kuota-doctor-lock-"));
  const dir = join(home, ".cache", "kuota");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const target = join(home, "target");
    writeFileSync(target, "synthetic-lock");
    symlinkSync(target, join(dir, "collector.lock"));
    const lines: string[] = [];
    const result = await runDoctor({ write: (line) => { lines.push(line); } }, home, {});
    assert.match(lines.join(""), /collector lock.*unsafe/i);
    assert.equal(readFileSync(target, "utf8"), "synthetic-lock");
    assert.equal(result, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor does not execute SQLite startup commands from the user's HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "kuota-doctor-sqliterc-"));
  const profile = join(home, ".mozilla", "firefox", "profile.default");
  mkdirSync(profile, { recursive: true });
  const sentinel = join(home, "unexpected-write");
  try {
    assert.equal(spawnSync("/usr/bin/sqlite3", [join(profile, "cookies.sqlite"), "CREATE TABLE moz_cookies(host TEXT, name TEXT, value TEXT, expiry INTEGER);"]).status, 0);
    writeFileSync(join(home, ".sqliterc"), `.shell touch ${sentinel}\n`);
    spawnSync(process.execPath, [cli, "doctor"], {
      env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(readdirSync(home).includes("unexpected-write"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor does not run Node preloads while checking the system runtime", async () => {
  const home = mkdtempSync(join(tmpdir(), "kuota-doctor-preload-"));
  const preload = join(home, "preload.cjs");
  const sentinel = join(home, "unexpected-write");
  const previous = process.env.NODE_OPTIONS;
  try {
    writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed")`);
    process.env.NODE_OPTIONS = `--require=${preload}`;
    await runDoctor({ write: () => {} }, home, {});
    assert.equal(readdirSync(home).includes("unexpected-write"), false);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
