import assert from "node:assert/strict";
import test from "node:test";
import { scanForSecrets } from "../../../src/security/redact.js";

import {
  createClaudeAdapter,
  type ClaudeAdapterDependencies,
} from "../../../src/providers/claude/adapter.js";
import type { ClaudeAuthResult } from "../../../src/providers/claude/auth.js";
import { CLAUDE_BACKOFF_CLEAR_RETRY_AT } from "../../../src/providers/claude/backoff.js";
import type {
  ClaudeCacheReadErrorReason,
  ClaudeCacheReadResult,
  ClaudeCacheStaleRecord,
  ClaudeCacheWriteResult,
} from "../../../src/providers/claude/cache.js";
import {
  CLAUDE_MAX_BACKOFF_MS,
  type ClaudeFetchResult,
} from "../../../src/providers/claude/fetch.js";
import type { ClaudeUsageSuccessRecord } from "../../../src/providers/claude/usage.js";
import type { ProviderAdapterContext } from "../../../src/providers/types.js";

const NOW = Date.parse("2026-07-12T12:00:00.000Z");
const TOKEN = "synthetic-oauth-access-value-002-not-real";

const successRecord: ClaudeUsageSuccessRecord = {
  id: "claude",
  state: "ok",
  lastSuccessAt: "2026-07-12T11:59:00.000Z",
  windows: [{ id: "session", label: "Session (5-hour)", usedPercent: 20 }],
};

const staleRecord: ClaudeCacheStaleRecord = {
  id: "claude",
  state: "stale",
  status: "Showing cached usage",
  lastSuccessAt: "2026-07-12T11:59:00.000Z",
  windows: [{ id: "session", label: "Session (5-hour)", usedPercent: 20 }],
};

function cacheAvailable(record = staleRecord): ClaudeCacheReadResult {
  return { state: "available", status: "Showing cached usage", record };
}

function authAvailable(): ClaudeAuthResult {
  return {
    state: "available",
    status: "Credential available",
    credential: { access: TOKEN },
  };
}

function fetchOk(record = successRecord): ClaudeFetchResult {
  return { outcome: "ok", status: "Usage updated", record };
}

function writtenCache(): ClaudeCacheWriteResult {
  return { state: "written", status: "Cached usage stored" };
}

function context(): ProviderAdapterContext<ClaudeAdapterDependencies> {
  return {
    signal: new AbortController().signal,
    dependencies: {},
  };
}

function adapterWith(overrides: Partial<ClaudeAdapterDependencies> = {}) {
  let cacheReads = 0;
  let authReads = 0;
  let fetches = 0;
  const dependencies: ClaudeAdapterDependencies = {
    now: () => NOW,
    readBackoff: async () => ({ state: "missing" }),
    readCache: async () => {
      cacheReads += 1;
      return { state: "missing", status: "No cached usage" };
    },
    writeCache: async () => writtenCache(),
    clearBackoff: async () => ({ state: "cleared" }),
    writeBackoff: async () => ({ state: "written" }),
    readAuth: async () => {
      authReads += 1;
      return authAvailable();
    },
    fetchUsage: async () => {
      fetches += 1;
      return fetchOk();
    },
    ...overrides,
  };
  return {
    adapter: createClaudeAdapter(dependencies),
    counts: {
      cacheReads: () => cacheReads,
      authReads: () => authReads,
      fetches: () => fetches,
    },
  };
}

test("returns a fresh own-cache record before auth or fetch at ages zero and just below five minutes", async () => {
  for (const lastSuccessAt of [
    "2026-07-12T12:00:00.000Z",
    "2026-07-12T11:55:00.001Z",
  ]) {
    const { adapter, counts } = adapterWith({
      readCache: async () => cacheAvailable({ ...staleRecord, lastSuccessAt }),
    });
    const result = await adapter.collect(context());

    assert.equal(result.state, "ok");
    assert.equal(result.lastSuccessAt, lastSuccessAt);
    assert.equal(counts.authReads(), 0);
    assert.equal(counts.fetches(), 0);
  }
});

test("does not treat an exactly-five-minute or future cache timestamp as fresh", async () => {
  for (const lastSuccessAt of [
    "2026-07-12T11:55:00.000Z",
    "2026-07-12T12:00:00.001Z",
  ]) {
    const { adapter, counts } = adapterWith({
      readCache: async () => cacheAvailable({ ...staleRecord, lastSuccessAt }),
    });
    const result = await adapter.collect(context());

    assert.equal(result.state, "ok");
    assert.equal(counts.authReads(), 1);
    assert.equal(counts.fetches(), 1);
  }
});

test("persists a rate limit and returns the stale cache without exposing credentials", async () => {
  let savedRetryAt: string | undefined;
  const { adapter } = adapterWith({
    readCache: async () =>
      cacheAvailable({ ...staleRecord, lastSuccessAt: "2026-07-12T11:54:59.999Z" }),
    fetchUsage: async () => ({
      outcome: "rate-limited",
      status: "Rate limited",
      retryAfterMs: 300_000,
      retryAt: "2026-07-12T12:05:00.000Z",
    }),
    writeBackoff: async (retryAt: string) => {
      savedRetryAt = retryAt;
      return { state: "written" };
    },
  });
  const result = await adapter.collect(context());

  assert.equal(result.state, "stale");
  assert.equal(savedRetryAt, "2026-07-12T12:05:00.000Z");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("maps auth-needed and safe fetch failures to stale when cached data exists", async () => {
  for (const scenario of [
    { readAuth: async (): Promise<ClaudeAuthResult> => ({ state: "auth-needed", reason: "expired", status: "Authentication required" }) },
    { fetchUsage: async (): Promise<ClaudeFetchResult> => ({ outcome: "error", reason: "transport", status: "Provider unavailable" }) },
  ]) {
    const { adapter } = adapterWith({
      readCache: async () =>
        cacheAvailable({ ...staleRecord, lastSuccessAt: "2026-07-12T11:54:59.999Z" }),
      ...scenario,
    });
    assert.equal((await adapter.collect(context())).state, "stale");
  }
});

test("returns auth-needed without cache and preserves a live result when cache persistence fails", async () => {
  const unauthenticated = adapterWith({
    readAuth: async () => ({ state: "auth-needed", reason: "missing-entry", status: "Authentication required" }),
  });
  assert.equal((await unauthenticated.adapter.collect(context())).state, "auth-needed");

  const persistenceFailure = adapterWith({
    writeCache: async () => ({ state: "error", reason: "cache-write", status: "Cache write failed" }),
    clearBackoff: async () => ({ state: "error", reason: "backoff-write" }),
  });
  assert.equal((await persistenceFailure.adapter.collect(context())).state, "ok");
});


test("active backoff skips auth and fetch, while expired or corrupt sidecars fail open", async () => {
  const active = adapterWith({
    readBackoff: async () => ({ state: "available", retryAt: "2026-07-12T12:05:00.000Z" }),
    readCache: async () => cacheAvailable(),
  });
  assert.equal((await active.adapter.collect(context())).state, "stale");
  assert.equal(active.counts.authReads(), 0);
  assert.equal(active.counts.fetches(), 0);

  for (const readBackoff of [
    async () => ({ state: "available" as const, retryAt: CLAUDE_BACKOFF_CLEAR_RETRY_AT }),
    async () => ({ state: "error" as const }),
  ]) {
    const { adapter, counts } = adapterWith({ readBackoff });
    assert.equal((await adapter.collect(context())).state, "ok");
    assert.equal(counts.fetches(), 1);
  }
});


test("honors a persisted backoff only through the documented maximum horizon", async () => {
  const exactMaximum = new Date(NOW + CLAUDE_MAX_BACKOFF_MS).toISOString();
  const justBeyondMaximum = new Date(NOW + CLAUDE_MAX_BACKOFF_MS + 1).toISOString();
  const absurdFuture = new Date(NOW + CLAUDE_MAX_BACKOFF_MS * 100).toISOString();

  const exact = adapterWith({
    readBackoff: async () => ({ state: "available", retryAt: exactMaximum }),
    readCache: async () => cacheAvailable({ ...staleRecord, lastSuccessAt: "2026-07-12T11:54:59.999Z" }),
  });
  assert.equal((await exact.adapter.collect(context())).state, "stale");
  assert.equal(exact.counts.fetches(), 0);

  for (const retryAt of [justBeyondMaximum, absurdFuture]) {
    const candidate = adapterWith({
      readBackoff: async () => ({ state: "available", retryAt }),
      readCache: async () => cacheAvailable({ ...staleRecord, lastSuccessAt: "2026-07-12T11:54:59.999Z" }),
    });
    assert.equal((await candidate.adapter.collect(context())).state, "ok");
    assert.equal(candidate.counts.fetches(), 1);
  }
});

test("rate limits without cached data safely degrade to error", async () => {
  const rateLimited = adapterWith({
    fetchUsage: async () => ({
      outcome: "rate-limited",
      status: "Rate limited",
      retryAfterMs: 300_000,
      retryAt: "2026-07-12T12:05:00.000Z",
    }),
  });
  assert.equal((await rateLimited.adapter.collect(context())).state, "error");
});

test("recovers from every benign cache error through a bounded live fetch and self-healing write", async () => {
  const recoverableReasons: readonly ClaudeCacheReadErrorReason[] = [
    "cache-read",
    "cache-malformed",
    "cache-invalid-envelope",
    "cache-invalid-record",
  ];
  for (const reason of recoverableReasons) {
    let writes = 0;
    const cacheFailure = adapterWith({
      readCache: async () => ({
        state: "error",
        reason,
        status: "Cache unavailable",
      }),
      writeCache: async () => {
        writes += 1;
        return { state: "error", reason: "cache-write", status: "Cache write failed" };
      },
    });

    const result = await cacheFailure.adapter.collect(context());

    assert.equal(result.state, "ok");
    assert.equal(cacheFailure.counts.authReads(), 1);
    assert.equal(cacheFailure.counts.fetches(), 1);
    assert.equal(writes, 1);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.deepEqual(scanForSecrets(result), []);
  }
});

test("maps downstream auth and fetch failures normally after a recoverable cache error", async () => {
  const cacheError: ClaudeCacheReadResult = {
    state: "error",
    reason: "cache-invalid-envelope",
    status: "Cache unavailable",
  };
  let authNeededReads = 0;
  const authNeeded = adapterWith({
    readCache: async () => cacheError,
    readAuth: async () => {
      authNeededReads += 1;
      return {
        state: "auth-needed",
        reason: "missing-entry",
        status: "Authentication required",
      };
    },
  });
  const authResult = await authNeeded.adapter.collect(context());
  assert.equal(authResult.state, "auth-needed");
  assert.equal(authNeededReads, 1);
  assert.equal(authNeeded.counts.fetches(), 0);

  let failedFetches = 0;
  const fetchFailed = adapterWith({
    readCache: async () => cacheError,
    fetchUsage: async () => {
      failedFetches += 1;
      return {
        outcome: "error",
        reason: "transport",
        status: "Provider unavailable",
      };
    },
  });
  const fetchResult = await fetchFailed.adapter.collect(context());
  assert.equal(fetchResult.state, "error");
  assert.equal(fetchFailed.counts.authReads(), 1);
  assert.equal(failedFetches, 1);
  assert.equal(JSON.stringify(fetchResult).includes(TOKEN), false);
  assert.deepEqual(scanForSecrets(fetchResult), []);
});

test("fails closed without auth or fetch for unsafe or thrown cache reads", async () => {
  const unsafe = adapterWith({
    readCache: async () => ({
      state: "error",
      reason: "cache-unsafe",
      status: "Cache unavailable",
    }),
  });
  const unsafeResult = await unsafe.adapter.collect(context());
  assert.equal(unsafeResult.state, "error");
  assert.equal(unsafe.counts.authReads(), 0);
  assert.equal(unsafe.counts.fetches(), 0);
  assert.equal(JSON.stringify(unsafeResult).includes("cache-unsafe"), false);
  assert.deepEqual(scanForSecrets(unsafeResult), []);

  const thrown = adapterWith({
    readCache: async () => {
      throw new Error(`hostile cache seam ${TOKEN}`);
    },
  });
  const thrownResult = await thrown.adapter.collect(context());
  assert.equal(thrownResult.state, "error");
  assert.equal(thrown.counts.authReads(), 0);
  assert.equal(thrown.counts.fetches(), 0);
  assert.equal(JSON.stringify(thrownResult).includes(TOKEN), false);
  assert.deepEqual(scanForSecrets(thrownResult), []);
});

test("active backoff does not bypass itself after a recoverable cache error", async () => {
  const backoff = adapterWith({
    readBackoff: async () => ({
      state: "available",
      retryAt: "2026-07-12T12:05:00.000Z",
    }),
    readCache: async () => ({
      state: "error",
      reason: "cache-malformed",
      status: "Cache unavailable",
    }),
  });

  const result = await backoff.adapter.collect(context());
  assert.equal(result.state, "error");
  assert.equal(backoff.counts.authReads(), 0);
  assert.equal(backoff.counts.fetches(), 0);
});

test("maps auth, malformed, abort, and hostile dependency failures to safe records", async () => {
  const scenarios: Partial<ClaudeAdapterDependencies>[] = [
    { readAuth: async () => ({ state: "error", reason: "auth-file-read", status: "Provider unavailable" }) },
    { fetchUsage: async () => ({ outcome: "error", reason: "malformed-response", status: "Provider unavailable" }) },
    { fetchUsage: async () => ({ outcome: "error", reason: "aborted", status: "Provider unavailable" }) },
    { readAuth: async () => { throw new Error(`hostile ${TOKEN}`); } },
  ];
  for (const scenario of scenarios) {
    const { adapter } = adapterWith(scenario);
    const result = await adapter.collect(context());
    assert.equal(result.state, "error");
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  }
  const hostileBackoff = adapterWith({
    readBackoff: async () => { throw new Error(`hostile ${TOKEN}`); },
  });
  const recovered = await hostileBackoff.adapter.collect(context());
  assert.equal(recovered.state, "ok");
  assert.equal(JSON.stringify(recovered).includes(TOKEN), false);
});

test("attempts LKG write and backoff clear on live success but preserves the live record on failures", async () => {
  let writes = 0;
  let clears = 0;
  const { adapter } = adapterWith({
    writeCache: async () => {
      writes += 1;
      return { state: "error", reason: "cache-write", status: "Cache write failed" };
    },
    clearBackoff: async () => {
      clears += 1;
      return { state: "error", reason: "backoff-write" };
    },
  });
  const result = await adapter.collect(context());

  assert.equal(result.state, "ok");
  assert.equal(writes, 1);
  assert.equal(clears, 1);
});

test("returns safe errors when backoff persistence or cache writes throw", async () => {
  const rateLimited = adapterWith({
    fetchUsage: async () => ({
      outcome: "rate-limited",
      status: "Rate limited",
      retryAfterMs: 300_000,
      retryAt: "2026-07-12T12:05:00.000Z",
    }),
    writeBackoff: async () => { throw new Error(`hostile ${TOKEN}`); },
  });
  assert.equal((await rateLimited.adapter.collect(context())).state, "error");

  const live = adapterWith({
    writeCache: async () => { throw new Error(`hostile ${TOKEN}`); },
    clearBackoff: async () => { throw new Error(`hostile ${TOKEN}`); },
  });
  const result = await live.adapter.collect(context());
  assert.equal(result.state, "ok");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});


test("contains hostile result accessors and retains stale data", async () => {
  const hostile: ClaudeFetchResult = {
    outcome: "error",
    reason: "transport",
    status: "Provider unavailable",
  };
  Object.defineProperty(hostile, "outcome", {
    get(): never {
      throw new Error(`hostile ${TOKEN}`);
    },
  });
  const { adapter } = adapterWith({
    readCache: async () =>
      cacheAvailable({ ...staleRecord, lastSuccessAt: "2026-07-12T11:54:59.999Z" }),
    fetchUsage: async () => hostile,
  });

  const result = await adapter.collect(context());
  assert.equal(result.state, "stale");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.deepEqual(scanForSecrets(result), []);
});
