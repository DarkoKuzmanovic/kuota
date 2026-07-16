import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonFileError } from "../../src/io/json-file.js";
import { createNormalizedProviderResult } from "../../src/providers/types.js";
import {
  COLLECTOR_CACHE_SCHEMA_VERSION,
  createCollectorCacheEnvelope,
  mergeCollectorCache,
  readCollectorCache,
  resolveCollectorCachePath,
  writeCollectorCache,
  type CollectorCacheEnvelope,
} from "../../src/collect/cache.js";

const OBSERVED_AT = "2026-07-13T12:00:00.000Z";
const RESET_AT = "2026-07-13T16:00:00.000Z";
const SAVED_AT = "2026-07-13T12:05:00.000Z";
const UPDATED_SAVED_AT = "2026-07-13T12:15:00.000Z";
const SECRET = "synthetic-collector-cache-secret";

function claudeOk() {
  return createNormalizedProviderResult("claude", {
    id: "claude",
    state: "ok",
    lastSuccessAt: OBSERVED_AT,
    windows: [{ id: "session", label: "Session", usedPercent: 20, resetAt: RESET_AT }],
  });
}

function umansOk() {
  return createNormalizedProviderResult("umans", {
    id: "umans",
    state: "ok",
    lastSuccessAt: OBSERVED_AT,
    details: { umans: { requests: 3 } },
  });
}

function codexError() {
  return createNormalizedProviderResult("codex", {
    id: "codex",
    state: "error",
    status: "Provider unavailable",
  });
}

function envelope(records = [claudeOk(), umansOk()]): CollectorCacheEnvelope {
  return {
    schemaVersion: COLLECTOR_CACHE_SCHEMA_VERSION,
    savedAt: SAVED_AT,
    records,
  };
}

test("resolves the injected-home whole-collector cache path", () => {
  assert.equal(
    resolveCollectorCachePath("/synthetic-home"),
    "/synthetic-home/.cache/kuota/collector.json",
  );
});

test("constructs only canonical successful-record envelopes", () => {
  const constructed = createCollectorCacheEnvelope(SAVED_AT, [umansOk(), claudeOk()]);
  assert.ok(constructed !== undefined);
  assert.deepEqual(constructed.records.map((record) => record.id), ["claude", "umans"]);
  assert.equal(createCollectorCacheEnvelope(SAVED_AT, [codexError()]), undefined);
});

test("creates a canonical versioned envelope from a cold cache success", () => {
  const result = mergeCollectorCache(undefined, [umansOk()], SAVED_AT);

  assert.ok(result.envelope !== undefined);
  assert.equal(result.envelope.schemaVersion, COLLECTOR_CACHE_SCHEMA_VERSION);
  assert.equal(result.envelope.savedAt, SAVED_AT);
  assert.deepEqual(result.envelope.records.map((record) => record.id), ["umans"]);
});

test("merges successful providers independently and retains matching cache only for transient errors", () => {
  const result = mergeCollectorCache(envelope(), [
    createNormalizedProviderResult("claude", {
      id: "claude",
      state: "ok",
      lastSuccessAt: "2026-07-13T12:10:00.000Z",
      details: { claude: { tokens: 10 } },
    }),
    createNormalizedProviderResult("umans", {
      id: "umans",
      state: "auth-needed",
      status: "Authentication required",
    }),
    codexError(),
  ], UPDATED_SAVED_AT);

  assert.deepEqual(result.records.map((record) => [record.id, record.state]), [
    ["claude", "ok"],
    ["umans", "auth-needed"],
    ["codex", "error"],
  ]);
  assert.ok(result.envelope !== undefined);
  assert.deepEqual(result.envelope.records.map((record) => [record.id, record.state]), [
    ["claude", "ok"],
    ["umans", "ok"],
  ]);
  assert.equal(result.envelope.savedAt, UPDATED_SAVED_AT);

  const fallback = mergeCollectorCache(envelope(), [
    createNormalizedProviderResult("claude", {
      id: "claude",
      state: "error",
      status: "Provider unavailable",
    }),
  ], UPDATED_SAVED_AT);
  assert.equal(fallback.records[0]?.state, "stale");
  assert.equal(fallback.records[0]?.lastSuccessAt, OBSERVED_AT);
  assert.equal(fallback.records[0]?.status, "Using last known data");
  assert.equal(fallback.envelope?.savedAt, SAVED_AT);

  const allFailed = mergeCollectorCache(undefined, [codexError()], UPDATED_SAVED_AT);
  assert.equal(allFailed.envelope, undefined);
});

test("preserves a non-empty cache and its timestamp when every live record fails", () => {
  const result = mergeCollectorCache(envelope(), [codexError()], UPDATED_SAVED_AT);

  assert.equal(result.envelope?.savedAt, SAVED_AT);
  assert.deepEqual(result.envelope?.records.map((record) => record.id), ["claude", "umans"]);
  assert.deepEqual(result.records.map((record) => [record.id, record.state]), [["codex", "error"]]);
});

test("writes only validated ok records atomically and reads them without secrets", async () => {
  const home = await mkdtemp(join(tmpdir(), "kuota-collector-cache-"));
  const cachePath = resolveCollectorCachePath(home);
  await mkdir(join(home, ".cache"), { mode: 0o700 });
  try {
    const written = await writeCollectorCache(envelope(), {
      homeDirectory: home,
    });
    assert.equal(written.state, "written");

    const read = await readCollectorCache({ homeDirectory: home });
    assert.equal(read.state, "available");
    if (read.state === "available") {
      assert.deepEqual(read.envelope.records.map((record) => record.id), ["claude", "umans"]);
    }
    const raw = await readFile(cachePath, "utf8");
    assert.equal(raw.includes(SECRET), false);
    assert.equal(raw.includes("accessToken"), false);
    assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("treats missing or benignly corrupted cache as non-fatal and unsafe reads as value-free errors", async () => {
  const home = await mkdtemp(join(tmpdir(), "kuota-collector-cache-"));
  const cachePath = resolveCollectorCachePath(home);
  await mkdir(join(home, ".cache"), { mode: 0o700 });
  try {
    assert.equal((await readCollectorCache({ homeDirectory: home })).state, "missing");
    await writeCollectorCache(envelope(), { homeDirectory: home });
    await writeFile(cachePath, `{ "accessToken": "${SECRET}" }`, "utf8");
    const corrupt = await readCollectorCache({ homeDirectory: home });
    assert.equal(corrupt.state, "missing");
    assert.equal(JSON.stringify(corrupt).includes(SECRET), false);

    const unsafe = await readCollectorCache({
      cachePath,
      readJsonFile: async () => {
        throw new JsonFileError("unsafe-file");
      },
    });
    assert.deepEqual(unsafe, { state: "error", reason: "cache-unsafe" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
