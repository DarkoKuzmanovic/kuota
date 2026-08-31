import assert from "node:assert/strict";
import test from "node:test";

import { createOpencodeAdapter } from "../../../src/providers/opencode/adapter.js";
import type { OpencodeAuthResult } from "../../../src/providers/opencode/auth.js";
import { fetchOpencodeUsage, type OpencodeResponse } from "../../../src/providers/opencode/fetch.js";
import { parseOpencodeUsageResponse } from "../../../src/providers/opencode/usage.js";
import type { ProviderAdapterContext } from "../../../src/providers/types.js";

const AUTH_PATH = "/home/uzer/.pi/agent/auth.json";
const AVAILABLE: OpencodeAuthResult = { state: "available", credential: { kind: "api-key", value: "real-key" } };
const OBSERVED_AT = "2026-09-01T12:00:00.000Z";

function context(): ProviderAdapterContext { return { signal: new AbortController().signal, dependencies: {} }; }

function wirePayload(): unknown {
  return {
    usage: {
      rolling: { status: "ok", percent: 5, resetsAt: "2026-09-01T13:00:00+02:00" },
      weekly: { status: "ok", percent: 71.25, resetsAt: "2026-09-08T00:00:00+02:00" },
      monthly: { status: "ok", percent: 12.5, resetsAt: "2026-10-01T00:00:00+02:00" },
    },
  };
}

test("composes exactly one auth read and one fetch into a schema-valid OpenCode record", async () => {
  let authCalls = 0;
  let fetchCalls = 0;
  const adapter = createOpencodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => { authCalls += 1; return AVAILABLE; },
    fetchUsage: async () => { fetchCalls += 1; return { outcome: "ok", value: wirePayload() }; },
    parseUsage: (payload, observedAt) => parseOpencodeUsageResponse(payload, observedAt),
    now: () => Date.parse(OBSERVED_AT),
  });
  const result = await adapter.collect(context());
  assert.equal(result.id, "opencode");
  assert.equal(result.state, "ok");
  assert.equal(authCalls, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(result.windows?.[0]?.id, "rolling");
  assert.equal(result.windows?.[0]?.usedPercent, 5);
});

test("maps unavailable credentials and transport/parse failures to safe records without fetching after auth failure", async () => {
  let fetchCalls = 0;
  const authNeeded = createOpencodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => ({ state: "auth-needed", reason: "missing-entry" }),
    fetchUsage: async () => { fetchCalls += 1; return { outcome: "auth-needed" }; },
  });
  const failed = await authNeeded.collect(context());
  assert.deepEqual(failed, { id: "opencode", state: "auth-needed", status: "Authentication required" });
  assert.equal(fetchCalls, 0);
});

test("maps fetch auth-needed to auth-needed and fetch error to unavailable", async () => {
  const authNeededFetch = createOpencodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => AVAILABLE,
    fetchUsage: async () => ({ outcome: "auth-needed" }),
  });
  assert.deepEqual(await authNeededFetch.collect(context()), { id: "opencode", state: "auth-needed", status: "Authentication required" });

  const errorAdapter = createOpencodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => AVAILABLE,
    fetchUsage: async () => ({ outcome: "error", reason: "http-status" }),
  });
  assert.deepEqual(await errorAdapter.collect(context()), { id: "opencode", state: "error", status: "Provider unavailable" });
});

test("maps an unparseable payload to unavailable", async () => {
  const adapter = createOpencodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => AVAILABLE,
    fetchUsage: async () => ({ outcome: "ok", value: { usage: "not-a-record" } }),
  });
  const result = await adapter.collect(context());
  assert.deepEqual(result, { id: "opencode", state: "error", status: "Provider unavailable" });
});

test("never emits credentials in any normalized result (value-free outcomes)", async () => {
  const authNeeded = createOpencodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => ({ state: "auth-needed", reason: "missing-entry" }),
    fetchUsage: async () => ({ outcome: "auth-needed" }),
  });
  assert.equal(JSON.stringify(await authNeeded.collect(context())).includes("real-key"), false);

  const fetchNeeded = createOpencodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => AVAILABLE,
    fetchUsage: async () => ({ outcome: "auth-needed" }),
  });
  assert.equal(JSON.stringify(await fetchNeeded.collect(context())).includes("real-key"), false);

  const parseFailure = createOpencodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => AVAILABLE,
    fetchUsage: async () => ({ outcome: "ok", value: "leaky" }),
  });
  assert.equal(JSON.stringify(await parseFailure.collect(context())).includes("real-key"), false);

  const ok = createOpencodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => AVAILABLE,
    fetchUsage: async () => ({ outcome: "ok", value: wirePayload() }),
    parseUsage: (payload, observedAt) => parseOpencodeUsageResponse(payload, observedAt),
    now: () => Date.parse(OBSERVED_AT),
  });
  assert.equal(JSON.stringify(await ok.collect(context())).includes("real-key"), false);
});

test("bridge: real wire shape flows from real fetch through the real parser", async () => {
  const reader: OpencodeResponse = {
    status: 200,
    headers: { get: () => null },
    body: { getReader: () => {
      const bytes = new TextEncoder().encode(JSON.stringify(wirePayload()));
      let offset = 0;
      return {
        read: async () => {
          if (offset >= bytes.length) return { done: true };
          const chunk = bytes.subarray(offset, offset + 16);
          offset += chunk.length;
          return { done: false, value: chunk };
        },
      };
    } },
  };
  const adapter = createOpencodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => AVAILABLE,
    fetchUsage: (options) => fetchOpencodeUsage({ credential: options.credential, signal: options.signal, fetch: async () => reader }),
    now: () => Date.parse(OBSERVED_AT),
  });
  const result = await adapter.collect(context());
  assert.equal(result.state, "ok");
  assert.equal(result.windows?.[1]?.resetAt, "2026-09-07T22:00:00.000Z");
  assert.equal(result.lastSuccessAt, OBSERVED_AT);
});

test("a rejected parse result leaves the adapter unavailable without leaking raw payload", async () => {
  const adapter = createOpencodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => AVAILABLE,
    fetchUsage: async () => ({ outcome: "ok", value: wirePayload() }),
    parseUsage: () => ({ ok: false, reason: "malformed-response", status: "Provider unavailable" }),
  });
  const result = await adapter.collect(context());
  assert.deepEqual(result, { id: "opencode", state: "error", status: "Provider unavailable" });
});
