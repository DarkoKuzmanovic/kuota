import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  nodeFileSystem,
  type AtomicFileSystem,
  type DirectoryHandle,
  type FileMetadata,
} from "../../../src/io/atomic-write.js";
import { JsonFileError, readJsonFile } from "../../../src/io/json-file.js";
import { scanForSecrets } from "../../../src/security/redact.js";
import {
  parseClaudeUsageResponse,
  type ClaudeUsageSuccessRecord,
} from "../../../src/providers/claude/usage.js";
import {
  CacheDirectoryError,
  CLAUDE_CACHE_STATUS_TEXT,
  CLAUDE_CACHE_WRITE_STATUS_TEXT,
  ensureClaudeCacheDirectory,
  readClaudeCache,
  resolveClaudeCacheDirectory,
  resolveClaudeCachePath,
  writeClaudeCache,
  type CacheDirectoryFileSystem,
  type ClaudeCacheReadResult,
} from "../../../src/providers/claude/cache.js";

const HOME = "/synthetic-home";
const CACHE_DIR = "/synthetic-home/.cache/kuota";
const CACHE_PARENT = "/synthetic-home/.cache";
const CACHE_PATH = "/synthetic-home/.cache/kuota/claude.json";

const OBSERVED_AT = "2026-07-11T10:00:00.000Z";
const OBSERVED_AT_B = "2026-07-11T11:30:00.000Z";
const SESSION_RESET = "2026-07-11T15:00:00.000Z";
const WEEKLY_RESET = "2026-07-18T10:00:00.000Z";
const SAVED_AT = "2026-07-11T12:00:00.000Z";
const SAVED_MILLIS = Date.parse(SAVED_AT);
const SECRET = "synthetic-cache-secret-value";

function okRecord(observedAt = OBSERVED_AT): ClaudeUsageSuccessRecord {
  const result = parseClaudeUsageResponse(
    {
      five_hour: { utilization: 25.5, resets_at: SESSION_RESET },
      seven_day: { utilization: 40, resets_at: WEEKLY_RESET },
      extra_usage: { is_enabled: true, monthly_limit: 25, used_credits: 4 },
    },
    observedAt,
  );
  if (!result.ok) {
    throw new Error("expected a successful synthetic Claude record");
  }
  return result.record;
}

function expectedStale(observedAt = OBSERVED_AT): Record<string, unknown> {
  return {
    id: "claude",
    state: "stale",
    status: CLAUDE_CACHE_STATUS_TEXT.available,
    lastSuccessAt: observedAt,
    windows: [
      { id: "session", label: "Session (5-hour)", usedPercent: 25.5, resetAt: SESSION_RESET },
      { id: "weekly-all", label: "Weekly (all)", usedPercent: 40, resetAt: WEEKLY_RESET },
    ],
    details: {
      claude: {
        extraUsageEnabled: true,
        extraUsageUsedCredits: 4,
        extraUsageMonthlyLimit: 25,
      },
    },
  };
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: "claude",
    savedAt: SAVED_AT,
    record: okRecord(),
    ...overrides,
  };
}

function readerReturning(value: unknown): (path: string) => Promise<unknown> {
  return async () => value;
}

async function readValue(value: unknown): Promise<ClaudeCacheReadResult> {
  return readClaudeCache({ cachePath: CACHE_PATH, readJsonFile: readerReturning(value) });
}

function assertSafeString(value: string, forbidden: readonly string[]): void {
  for (const entry of forbidden) {
    assert.equal(value.includes(entry), false, `leaked ${entry}`);
  }
}

function enoent(): Error {
  const error = new Error("missing");
  Object.assign(error, { code: "ENOENT" });
  return error;
}

function withCode(code: string): Error {
  const error = new Error(`synthetic ${code} at ${SECRET}`);
  Object.assign(error, { code });
  return error;
}

function dirMeta(mode = 0o40700, uid = 1000): FileMetadata {
  return {
    mode,
    uid,
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

function symlinkDirMeta(): FileMetadata {
  return {
    mode: 0o40700,
    uid: 1000,
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => true,
  };
}

function fileMeta(): FileMetadata {
  return {
    mode: 0o100700,
    uid: 1000,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
}

async function withTempCache<T>(
  callback: (cachePath: string, base: string) => Promise<T>,
): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "kuota-cache-synthetic-"));
  try {
    const cacheHome = join(base, ".cache");
    await mkdir(cacheHome, { mode: 0o700 });
    await chmod(cacheHome, 0o700);
    return await callback(join(cacheHome, "kuota", "claude.json"), base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

test("resolves the Kuota-owned cache path from injected home without env or pi-hud fallback", async () => {
  assert.equal(resolveClaudeCacheDirectory(HOME), CACHE_DIR);
  assert.equal(resolveClaudeCachePath(HOME), CACHE_PATH);
  assert.equal(resolveClaudeCachePath(HOME).includes("pi-hud"), false);

  const requested: string[] = [];
  const result = await readClaudeCache({
    homeDirectory: HOME,
    readJsonFile: async (path) => {
      requested.push(path);
      return undefined;
    },
  });

  assert.deepEqual(requested, [CACHE_PATH]);
  assert.deepEqual(result, {
    state: "missing",
    status: CLAUDE_CACHE_STATUS_TEXT.missing,
  });
});

test("a missing cache reads as missing and never creates a directory", async () => {
  await withTempCache(async (cachePath) => {
    const result = await readClaudeCache({ cachePath });
    assert.deepEqual(result, {
      state: "missing",
      status: CLAUDE_CACHE_STATUS_TEXT.missing,
    });
    // Reading did not create the kuota directory.
    await assert.rejects(stat(dirname(cachePath)));
  });
});

// ---------------------------------------------------------------------------
// Read — valid envelope
// ---------------------------------------------------------------------------

test("reconstructs an exact validated stale record without mutating the parsed source", async () => {
  const source = envelope();
  const before = JSON.stringify(source);
  const result = await readClaudeCache({
    cachePath: CACHE_PATH,
    readJsonFile: async () => source,
  });

  assert.equal(result.state, "available");
  if (result.state !== "available") return;

  assert.equal(result.status, CLAUDE_CACHE_STATUS_TEXT.available);
  assert.deepEqual(result.record, expectedStale());
  // The returned record is a freshly built object, not the parsed reference.
  assert.notEqual(result.record, source.record);
  assert.notEqual(result.record.windows, (source.record as { windows: unknown }).windows);
  // The parsed source is untouched.
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(scanForSecrets(result), []);
});

test("reconstructs a details-only stale record when the cached record has no windows", async () => {
  const detailsOnly = {
    id: "claude",
    state: "ok",
    lastSuccessAt: OBSERVED_AT,
    details: { claude: { extraUsageEnabled: true, extraUsageMonthlyLimit: 25 } },
  };
  const result = await readValue(envelope({ record: detailsOnly }));

  assert.equal(result.state, "available");
  if (result.state !== "available") return;
  assert.deepEqual(result.record, {
    id: "claude",
    state: "stale",
    status: CLAUDE_CACHE_STATUS_TEXT.available,
    lastSuccessAt: OBSERVED_AT,
    details: { claude: { extraUsageEnabled: true, extraUsageMonthlyLimit: 25 } },
  });
});

// ---------------------------------------------------------------------------
// Read — malformed envelopes
// ---------------------------------------------------------------------------

test("rejects every malformed or future-incompatible envelope shape", async () => {
  const cases: readonly unknown[] = [
    envelope({ schemaVersion: 2 }),
    envelope({ schemaVersion: "1" }),
    envelope({ schemaVersion: 0 }),
    envelope({ provider: "codex" }),
    envelope({ provider: "Claude" }),
    envelope({ savedAt: "not-a-timestamp" }),
    envelope({ savedAt: SAVED_MILLIS }),
    envelope({ savedAt: "2026-13-01T00:00:00.000Z" }),
    envelope({ savedAt: "2026-07-11T12:00:00" }),
    { provider: "claude", savedAt: SAVED_AT, record: okRecord() },
    envelope({ extra: true }),
    envelope({ record: [] }),
    envelope({ record: "not-an-object" }),
    envelope({ record: 42 }),
    envelope({ record: null }),
    [],
    "not-an-object",
    42,
    null,
    true,
  ];

  for (const value of cases) {
    const result = await readValue(value);
    assert.deepEqual(
      result,
      {
        state: "error",
        reason: "cache-invalid-envelope",
        status: CLAUDE_CACHE_STATUS_TEXT.error,
      },
      JSON.stringify(value),
    );
  }
});

test("rejects envelopes whose record is not successful Claude usage", async () => {
  const records: readonly unknown[] = [
    { id: "claude", state: "stale", lastSuccessAt: OBSERVED_AT, windows: [{ id: "session", label: "Session (5-hour)", usedPercent: 10 }] },
    { id: "claude", state: "error", status: "Provider unavailable" },
    { id: "claude", state: "auth-needed", status: "Authentication required" },
    { id: "umans", state: "ok", lastSuccessAt: OBSERVED_AT },
    { id: "claude", state: "ok" },
    { id: "claude", state: "ok", lastSuccessAt: "2026-07-11T10:00:00", windows: [{ id: "session", label: "Session (5-hour)", usedPercent: 10 }] },
    { id: "claude", state: "ok", lastSuccessAt: OBSERVED_AT, windows: [{ id: "session", label: "Session (5-hour)", usedPercent: 10 }], unexpected: true },
    { id: "claude", state: "ok", lastSuccessAt: OBSERVED_AT, windows: [{ id: "session", label: "Session (5-hour)", usedPercent: 150 }] },
  ];

  for (const record of records) {
    const result = await readValue(envelope({ record }));
    assert.deepEqual(
      result,
      {
        state: "error",
        reason: "cache-invalid-record",
        status: CLAUDE_CACHE_STATUS_TEXT.error,
      },
      JSON.stringify(record),
    );
  }
});

// ---------------------------------------------------------------------------
// Read — hostile reader output and failures
// ---------------------------------------------------------------------------

test("rejects hostile non-JSON reader output as a value-free malformed error", async () => {
  const getterGraph: Record<string, unknown> = { schemaVersion: 1, provider: "claude", savedAt: SAVED_AT };
  Object.defineProperty(getterGraph, "record", {
    enumerable: true,
    get() {
      throw new Error(SECRET);
    },
  });
  const cyclic: Record<string, unknown> = { schemaVersion: 1 };
  cyclic.self = cyclic;
  const symbolKeyed: Record<string, unknown> = { schemaVersion: 1, provider: "claude", savedAt: SAVED_AT };
  Object.defineProperty(symbolKeyed, Symbol("record"), { enumerable: true, value: okRecord() });

  const hostile: readonly unknown[] = [
    getterGraph,
    cyclic,
    symbolKeyed,
    new Map<string, string>([["record", SECRET]]),
    new Date(0),
  ];

  for (const value of hostile) {
    const result = await readValue(value);
    assert.deepEqual(result, {
      state: "error",
      reason: "cache-malformed",
      status: CLAUDE_CACHE_STATUS_TEXT.error,
    });
    assertSafeString(JSON.stringify(result), [SECRET]);
  }
});

test("maps JsonFileError kinds and hostile thrown values to constant value-free errors", async () => {
  const mapped: readonly [string, string][] = [
    ["malformed", "cache-malformed"],
    ["unsafe-file", "cache-unsafe"],
    ["read", "cache-read"],
    ["not-object", "cache-read"],
    ["update", "cache-read"],
  ];
  for (const [kind, reason] of mapped) {
    const result = await readClaudeCache({
      cachePath: CACHE_PATH,
      readJsonFile: async () => {
        throw new JsonFileError(kind as JsonFileError["kind"]);
      },
    });
    assert.deepEqual(result, {
      state: "error",
      reason,
      status: CLAUDE_CACHE_STATUS_TEXT.error,
    });
  }

  const prototypeTrap = new Proxy(Object.create(null), {
    getPrototypeOf() {
      throw new Error(`${CACHE_PATH}:${SECRET}`);
    },
  });
  const forgedName = Object.create(JsonFileError.prototype) as object;
  Object.defineProperty(forgedName, "name", { enumerable: true, value: "JsonFileError" });
  Object.defineProperty(forgedName, "kind", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error(SECRET);
    },
  });

  const hostile: readonly unknown[] = [
    null,
    undefined,
    Symbol("hostile"),
    42,
    "hostile-string",
    prototypeTrap,
    forgedName,
    new Error(`${CACHE_PATH}:${SECRET}`),
  ];
  for (const thrown of hostile) {
    const result = await readClaudeCache({
      cachePath: CACHE_PATH,
      readJsonFile: async () => {
        throw thrown;
      },
    });
    assert.deepEqual(result, {
      state: "error",
      reason: "cache-read",
      status: CLAUDE_CACHE_STATUS_TEXT.error,
    });
    assertSafeString(JSON.stringify(result), [SECRET]);
  }
});

test("refuses a symlinked cache file through the safe no-follow reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuota-cache-symlink-"));
  try {
    const target = join(directory, "target-claude.json");
    const link = join(directory, "claude.json");
    await writeFile(target, JSON.stringify(envelope()), "utf8");
    await symlink(target, link);

    const result = await readClaudeCache({
      cachePath: link,
      readJsonFile: (path) => readJsonFile(path, { fs: nodeFileSystem }),
    });
    assert.deepEqual(result, {
      state: "error",
      reason: "cache-unsafe",
      status: CLAUDE_CACHE_STATUS_TEXT.error,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Directory preparation
// ---------------------------------------------------------------------------

test("creates the private cache directory with mode 0700, parent fsync, and correct order", async () => {
  const calls: string[] = [];
  let childLstats = 0;
  const fs: CacheDirectoryFileSystem = {
    async lstat(path) {
      if (path === CACHE_PARENT) {
        calls.push("lstat:parent");
        return dirMeta();
      }
      if (path === CACHE_DIR) {
        calls.push("lstat:child");
        childLstats += 1;
        if (childLstats === 1) throw enoent();
        return dirMeta();
      }
      throw enoent();
    },
    getEffectiveUserId: () => 1000,
    async mkdir(path, mode) {
      calls.push(`mkdir:${path}:${mode.toString(8)}`);
    },
    async openDirectory(path): Promise<DirectoryHandle> {
      calls.push(`dir-open:${path}`);
      return {
        async sync() {
          calls.push("dir-sync");
        },
        async close() {
          calls.push("dir-close");
        },
      };
    },
  };

  await ensureClaudeCacheDirectory(CACHE_DIR, fs);
  assert.deepEqual(calls, [
    "lstat:parent",
    "lstat:child",
    `mkdir:${CACHE_DIR}:700`,
    `dir-open:${CACHE_PARENT}`,
    "dir-sync",
    "dir-close",
    "lstat:child",
  ]);
});

test("accepts an existing private directory without mkdir or fsync", async () => {
  const calls: string[] = [];
  const fs: CacheDirectoryFileSystem = {
    async lstat(path) {
      calls.push(path === CACHE_PARENT ? "lstat:parent" : "lstat:child");
      return dirMeta();
    },
    getEffectiveUserId: () => 1000,
    async mkdir() {
      calls.push("mkdir");
    },
    async openDirectory(): Promise<DirectoryHandle> {
      calls.push("dir-open");
      return { async sync() {}, async close() {} };
    },
  };

  await ensureClaudeCacheDirectory(CACHE_DIR, fs);
  assert.deepEqual(calls, ["lstat:parent", "lstat:child"]);
});

test("tolerates an EEXIST creation race and revalidates the child without fsync", async () => {
  const calls: string[] = [];
  let childLstats = 0;
  const fs: CacheDirectoryFileSystem = {
    async lstat(path) {
      if (path === CACHE_PARENT) {
        calls.push("lstat:parent");
        return dirMeta();
      }
      calls.push("lstat:child");
      childLstats += 1;
      if (childLstats === 1) throw enoent();
      return dirMeta();
    },
    getEffectiveUserId: () => 1000,
    async mkdir() {
      calls.push("mkdir");
      throw withCode("EEXIST");
    },
    async openDirectory(): Promise<DirectoryHandle> {
      calls.push("dir-open");
      return { async sync() {}, async close() {} };
    },
  };

  await ensureClaudeCacheDirectory(CACHE_DIR, fs);
  assert.deepEqual(calls, ["lstat:parent", "lstat:child", "mkdir", "lstat:child"]);
});

test("rejects unsafe parent directories before creating anything", async () => {
  const parents: readonly [string, FileMetadata][] = [
    ["group-or-other-writable", dirMeta(0o40770)],
    ["wrong-owner", dirMeta(0o40700, 1001)],
    ["symlink", symlinkDirMeta()],
    ["non-directory", fileMeta()],
  ];

  for (const [label, parentMeta] of parents) {
    let mkdirCalled = false;
    const fs: CacheDirectoryFileSystem = {
      async lstat(path) {
        if (path === CACHE_PARENT) return parentMeta;
        throw enoent();
      },
      getEffectiveUserId: () => 1000,
      async mkdir() {
        mkdirCalled = true;
      },
    };
    await assert.rejects(
      ensureClaudeCacheDirectory(CACHE_DIR, fs),
      (error: unknown) => error instanceof CacheDirectoryError,
      label,
    );
    assert.equal(mkdirCalled, false, label);
  }
});

test("rejects unsafe existing child directories", async () => {
  const children: readonly [string, FileMetadata][] = [
    ["group-or-other-writable", dirMeta(0o40707)],
    ["wrong-owner", dirMeta(0o40700, 1001)],
    ["symlink", symlinkDirMeta()],
    ["non-directory", fileMeta()],
  ];

  for (const [label, childMeta] of children) {
    let mkdirCalled = false;
    const fs: CacheDirectoryFileSystem = {
      async lstat(path) {
        if (path === CACHE_PARENT) return dirMeta();
        return childMeta;
      },
      getEffectiveUserId: () => 1000,
      async mkdir() {
        mkdirCalled = true;
      },
    };
    await assert.rejects(
      ensureClaudeCacheDirectory(CACHE_DIR, fs),
      (error: unknown) => error instanceof CacheDirectoryError,
      label,
    );
    assert.equal(mkdirCalled, false, label);
  }
});

test("rejects a missing parent and non-EEXIST creation failures as value-free errors", async () => {
  const missingParent: CacheDirectoryFileSystem = {
    async lstat(path) {
      if (path === CACHE_PARENT) throw enoent();
      throw enoent();
    },
    getEffectiveUserId: () => 1000,
    async mkdir() {
      throw new Error("must not create the parent");
    },
  };
  await assert.rejects(ensureClaudeCacheDirectory(CACHE_DIR, missingParent), (error: unknown) => {
    assert.ok(error instanceof CacheDirectoryError);
    assertSafeString(error.message, [SECRET, CACHE_DIR]);
    return true;
  });

  const deniedCreate: CacheDirectoryFileSystem = {
    async lstat(path) {
      if (path === CACHE_PARENT) return dirMeta();
      throw enoent();
    },
    getEffectiveUserId: () => 1000,
    async mkdir() {
      throw withCode("EACCES");
    },
  };
  await assert.rejects(ensureClaudeCacheDirectory(CACHE_DIR, deniedCreate), (error: unknown) => {
    assert.ok(error instanceof CacheDirectoryError);
    assertSafeString(error.message, [SECRET, CACHE_DIR]);
    return true;
  });
});

test("propagates a parent fsync failure as a value-free directory error", async () => {
  let childLstats = 0;
  const fs: CacheDirectoryFileSystem = {
    async lstat(path) {
      if (path === CACHE_PARENT) return dirMeta();
      childLstats += 1;
      if (childLstats === 1) throw enoent();
      return dirMeta();
    },
    getEffectiveUserId: () => 1000,
    async mkdir() {},
    async openDirectory(): Promise<DirectoryHandle> {
      return {
        async sync() {
          throw new Error(`directory sync failed with ${SECRET}`);
        },
        async close() {},
      };
    },
  };
  await assert.rejects(ensureClaudeCacheDirectory(CACHE_DIR, fs), (error: unknown) => {
    assert.ok(error instanceof CacheDirectoryError);
    assertSafeString(error.message, [SECRET]);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Write — roundtrip and replacement
// ---------------------------------------------------------------------------

test("writes a restrictive envelope that reads back as a stale record", async () => {
  await withTempCache(async (cachePath) => {
    const writeResult = await writeClaudeCache(okRecord(), {
      cachePath,
      now: () => SAVED_MILLIS,
    });
    assert.deepEqual(writeResult, {
      state: "written",
      status: CLAUDE_CACHE_WRITE_STATUS_TEXT.written,
    });

    assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(cachePath))).mode & 0o077, 0);

    const persisted = JSON.parse(await readFile(cachePath, "utf8"));
    assert.deepEqual(persisted, {
      schemaVersion: 1,
      provider: "claude",
      savedAt: SAVED_AT,
      record: okRecord(),
    });
    assert.deepEqual(scanForSecrets(persisted), []);

    const readResult = await readClaudeCache({ cachePath });
    assert.equal(readResult.state, "available");
    if (readResult.state !== "available") return;
    assert.deepEqual(readResult.record, expectedStale());
    assert.deepEqual(scanForSecrets(readResult), []);
  });
});

test("overwrites a corrupted Kuota-owned cache instead of trapping on malformed content", async () => {
  await withTempCache(async (cachePath) => {
    await mkdir(dirname(cachePath), { mode: 0o700 });
    await chmod(dirname(cachePath), 0o700);
    await writeFile(cachePath, `{"corrupted": true`, { encoding: "utf8", mode: 0o600 });

    const writeResult = await writeClaudeCache(okRecord(), {
      cachePath,
      now: () => SAVED_MILLIS,
    });
    assert.deepEqual(writeResult, {
      state: "written",
      status: CLAUDE_CACHE_WRITE_STATUS_TEXT.written,
    });

    const readResult = await readClaudeCache({ cachePath });
    assert.equal(readResult.state, "available");
    if (readResult.state !== "available") return;
    assert.deepEqual(readResult.record, expectedStale());
  });
});

// ---------------------------------------------------------------------------
// Write — validation and serialization happen before the filesystem
// ---------------------------------------------------------------------------

test("validation and serialization failures never touch the directory or write seams", async () => {
  const untouchedDirectoryFs: CacheDirectoryFileSystem = {
    async lstat() {
      throw new Error("directory seam must not be used");
    },
    async mkdir() {
      throw new Error("directory seam must not be used");
    },
    getEffectiveUserId: () => 1000,
    async openDirectory(): Promise<DirectoryHandle> {
      throw new Error("directory seam must not be used");
    },
  };
  const untouchedAtomicFs: AtomicFileSystem = {
    async lstat() {
      throw new Error("atomic seam must not be used");
    },
    getEffectiveUserId: () => 1000,
    async open() {
      throw new Error("atomic seam must not be used");
    },
    async chmod() {
      throw new Error("atomic seam must not be used");
    },
    async rename() {
      throw new Error("atomic seam must not be used");
    },
    async unlink() {
      throw new Error("atomic seam must not be used");
    },
  };

  const invalidRecord = {
    id: "claude",
    state: "ok",
    windows: [{ id: "session", label: "Session (5-hour)", usedPercent: 10 }],
  } as unknown as ClaudeUsageSuccessRecord;
  const invalidResult = await writeClaudeCache(invalidRecord, {
    cachePath: CACHE_PATH,
    now: () => SAVED_MILLIS,
    directoryFs: untouchedDirectoryFs,
    fs: untouchedAtomicFs,
  });
  assert.deepEqual(invalidResult, {
    state: "error",
    reason: "cache-invalid-record",
    status: CLAUDE_CACHE_WRITE_STATUS_TEXT.error,
  });

  const badClockResult = await writeClaudeCache(okRecord(), {
    cachePath: CACHE_PATH,
    now: () => Number.NaN,
    directoryFs: untouchedDirectoryFs,
    fs: untouchedAtomicFs,
  });
  assert.deepEqual(badClockResult, {
    state: "error",
    reason: "cache-serialize",
    status: CLAUDE_CACHE_WRITE_STATUS_TEXT.error,
  });
});

test("maps directory preparation failures to a constant write error", async () => {
  const failingDirectoryFs: CacheDirectoryFileSystem = {
    async lstat() {
      throw enoent();
    },
    getEffectiveUserId: () => 1000,
    async mkdir() {
      throw new Error("unreachable");
    },
  };
  const result = await writeClaudeCache(okRecord(), {
    cachePath: CACHE_PATH,
    now: () => SAVED_MILLIS,
    directoryFs: failingDirectoryFs,
  });
  assert.deepEqual(result, {
    state: "error",
    reason: "cache-directory",
    status: CLAUDE_CACHE_WRITE_STATUS_TEXT.error,
  });
});

// ---------------------------------------------------------------------------
// Write — atomic pre-commit and post-commit behavior
// ---------------------------------------------------------------------------

test("a pre-commit atomic failure preserves the previous cache for re-read", async () => {
  await withTempCache(async (cachePath) => {
    const first = await writeClaudeCache(okRecord(OBSERVED_AT), {
      cachePath,
      now: () => SAVED_MILLIS,
    });
    assert.equal(first.state, "written");

    const failingRenameFs: AtomicFileSystem = {
      ...nodeFileSystem,
      async rename() {
        throw new Error(`synthetic rename failure ${SECRET}`);
      },
    };
    const second = await writeClaudeCache(okRecord(OBSERVED_AT_B), {
      cachePath,
      now: () => SAVED_MILLIS,
      fs: failingRenameFs,
    });
    assert.deepEqual(second, {
      state: "error",
      reason: "cache-write",
      status: CLAUDE_CACHE_WRITE_STATUS_TEXT.error,
    });

    const readResult = await readClaudeCache({ cachePath });
    assert.equal(readResult.state, "available");
    if (readResult.state !== "available") return;
    assert.equal(readResult.record.lastSuccessAt, OBSERVED_AT);
  });
});

test("a post-commit durability failure reports indeterminate and leaves the new record", async () => {
  await withTempCache(async (cachePath) => {
    const first = await writeClaudeCache(okRecord(OBSERVED_AT), {
      cachePath,
      now: () => SAVED_MILLIS,
    });
    assert.equal(first.state, "written");

    const postCommitFailingFs: AtomicFileSystem = {
      ...nodeFileSystem,
      async openDirectory(path) {
        const handle = await nodeFileSystem.openDirectory(path);
        return {
          async sync() {
            await handle.close();
            throw new Error(`directory sync failed ${SECRET}`);
          },
          close: () => handle.close(),
        };
      },
    };
    const second = await writeClaudeCache(okRecord(OBSERVED_AT_B), {
      cachePath,
      now: () => SAVED_MILLIS,
      fs: postCommitFailingFs,
    });
    assert.deepEqual(second, {
      state: "error",
      reason: "cache-indeterminate",
      status: CLAUDE_CACHE_WRITE_STATUS_TEXT.error,
    });

    const readResult = await readClaudeCache({ cachePath });
    assert.equal(readResult.state, "available");
    if (readResult.state !== "available") return;
    assert.equal(readResult.record.lastSuccessAt, OBSERVED_AT_B);
  });
});

// ---------------------------------------------------------------------------
// Secret safety
// ---------------------------------------------------------------------------

test("keeps tokens and raw responses out of every cache surface", async () => {
  await withTempCache(async (cachePath) => {
    const writeResult = await writeClaudeCache(okRecord(), {
      cachePath,
      now: () => SAVED_MILLIS,
    });
    assert.deepEqual(scanForSecrets(writeResult), []);

    const content = await readFile(cachePath, "utf8");
    assertSafeString(content, [SECRET, "access", "Bearer", "refresh_token", "sk-ant"]);
    assert.deepEqual(scanForSecrets(JSON.parse(content)), []);

    const readResult = await readClaudeCache({ cachePath });
    assert.deepEqual(scanForSecrets(readResult), []);
  });
});
