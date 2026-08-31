import assert from "node:assert/strict";
import test from "node:test";

import { createCommandCodeAdapter } from "../../../src/providers/commandcode/adapter.js";
import type { CommandCodeAuthResult } from "../../../src/providers/commandcode/auth.js";
import { fetchCommandCodeJson, type CommandCodeResponse } from "../../../src/providers/commandcode/fetch.js";
import { parseCommandCodeUsageResponse } from "../../../src/providers/commandcode/usage.js";
import type { ProviderAdapterContext } from "../../../src/providers/types.js";

const AUTH_PATH = "/home/uzer/.pi/agent/auth.json";
const AVAILABLE: CommandCodeAuthResult = { state: "available", credential: { kind: "oauth", value: "real-key" } };
const OBSERVED_AT = "2026-09-01T12:00:00.000Z";

function context(): ProviderAdapterContext { return { signal: new AbortController().signal, dependencies: {} }; }

function wirePayload(): unknown {
  return {
    credits: { monthlyCredits: 200, purchasedCredits: 50, freeCredits: 10 },
    windowLimits: {
      exceeded: false,
      fiveHour: { used: 420, cap: 1000, exceeded: false, resetAt: 1756735200000 },
      weekly: { used: 30, cap: 300, exceeded: false, resetAt: 1759330800000 },
    },
  };
}

function subscriptionPayload(planId: unknown = "individual-goat"): unknown {
  return { data: { planId } };
}

test("collects one auth read, one credits fetch, and one subscriptions fetch into a schema-valid record", async () => {
  let authCalls = 0;
  let creditsCalls = 0;
  let subscriptionCalls = 0;
  const adapter = createCommandCodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => { authCalls += 1; return AVAILABLE; },
    fetchUsage: async () => { creditsCalls += 1; return { outcome: "ok", value: wirePayload() }; },
    fetchSubscription: async () => { subscriptionCalls += 1; return { outcome: "ok", value: subscriptionPayload() }; },
    parseUsage: (payload, observedAt, planName) => parseCommandCodeUsageResponse(payload, observedAt, planName),
    now: () => Date.parse(OBSERVED_AT),
  });
  const result = await adapter.collect(context());
  assert.equal(result.id, "commandcode");
  assert.equal(result.state, "ok");
  assert.equal(authCalls, 1);
  assert.equal(creditsCalls, 1);
  assert.equal(subscriptionCalls, 1);
  assert.equal(result.windows?.[0]?.usedPercent, 42);
  assert.equal(result.details?.commandcode.planName, "GOAT");
});

test("keeps the credits record when the subscriptions call fails or yields an unknown plan", async () => {
  for (const subscription of [
    { outcome: "error" as const, reason: "http-status" as const },
    { outcome: "auth-needed" as const },
    { outcome: "ok" as const, value: subscriptionPayload("not-a-plan") },
    { outcome: "ok" as const, value: "garbage" },
  ]) {
    const adapter = createCommandCodeAdapter({
      resolveAuthPath: () => AUTH_PATH,
      readAuth: async () => AVAILABLE,
      fetchUsage: async () => ({ outcome: "ok", value: wirePayload() }),
      fetchSubscription: async () => subscription,
      parseUsage: (payload, observedAt, planName) => parseCommandCodeUsageResponse(payload, observedAt, planName),
      now: () => Date.parse(OBSERVED_AT),
    });
    const result = await adapter.collect(context());
    assert.equal(result.state, "ok", JSON.stringify(subscription));
    if (result.state === "ok") assert.equal(result.details?.commandcode.planName, undefined);
  }
});

test("maps auth and credits failures to safe records without fetching after auth failure", async () => {
  let fetchCalls = 0;
  const authNeeded = createCommandCodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => ({ state: "auth-needed", reason: "missing-entry" }),
    fetchUsage: async () => { fetchCalls += 1; return { outcome: "auth-needed" }; },
  });
  assert.deepEqual(await authNeeded.collect(context()), { id: "commandcode", state: "auth-needed", status: "Authentication required" });
  assert.equal(fetchCalls, 0);

  const fetchAuthNeeded = createCommandCodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => AVAILABLE,
    fetchUsage: async () => ({ outcome: "auth-needed" }),
  });
  assert.deepEqual(await fetchAuthNeeded.collect(context()), { id: "commandcode", state: "auth-needed", status: "Authentication required" });

  const errorAdapter = createCommandCodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => AVAILABLE,
    fetchUsage: async () => ({ outcome: "error", reason: "timeout" }),
  });
  assert.deepEqual(await errorAdapter.collect(context()), { id: "commandcode", state: "error", status: "Provider unavailable" });
});

test("maps an unparseable credits payload to unavailable", async () => {
  const adapter = createCommandCodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => AVAILABLE,
    fetchUsage: async () => ({ outcome: "ok", value: { credits: "nope" } }),
    fetchSubscription: async () => ({ outcome: "ok", value: subscriptionPayload() }),
  });
  assert.deepEqual(await adapter.collect(context()), { id: "commandcode", state: "error", status: "Provider unavailable" });
});

test("never emits credentials in any normalized result (value-free outcomes)", async () => {
  const variants = [
    createCommandCodeAdapter({ resolveAuthPath: () => AUTH_PATH, readAuth: async () => ({ state: "auth-needed", reason: "missing-entry" }), fetchUsage: async () => ({ outcome: "auth-needed" }) }),
    createCommandCodeAdapter({ resolveAuthPath: () => AUTH_PATH, readAuth: async () => AVAILABLE, fetchUsage: async () => ({ outcome: "auth-needed" }) }),
    createCommandCodeAdapter({ resolveAuthPath: () => AUTH_PATH, readAuth: async () => AVAILABLE, fetchUsage: async () => ({ outcome: "ok", value: "leaky" }) }),
    createCommandCodeAdapter({
      resolveAuthPath: () => AUTH_PATH,
      readAuth: async () => AVAILABLE,
      fetchUsage: async () => ({ outcome: "ok", value: wirePayload() }),
      fetchSubscription: async () => ({ outcome: "ok", value: subscriptionPayload() }),
      parseUsage: (payload, observedAt, planName) => parseCommandCodeUsageResponse(payload, observedAt, planName),
      now: () => Date.parse(OBSERVED_AT),
    }),
  ];
  for (const adapter of variants) {
    const result = await adapter.collect(context());
    assert.equal(JSON.stringify(result).includes("real-key"), false);
  }
});

test("bridge: real wire shape flows from real fetch through the real parser with plan merge", async () => {
  const creditsReader: CommandCodeResponse = {
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
  const subscriptionReader: CommandCodeResponse = {
    status: 200,
    headers: { get: () => null },
    body: { getReader: () => {
      const bytes = new TextEncoder().encode(JSON.stringify(subscriptionPayload()));
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
  const adapter = createCommandCodeAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => AVAILABLE,
    fetchUsage: (options) => fetchCommandCodeJson({ credential: options.credential, signal: options.signal, fetch: async () => creditsReader }),
    fetchSubscription: (options) => fetchCommandCodeJson({ credential: options.credential, signal: options.signal, fetch: async () => subscriptionReader }),
    now: () => Date.parse(OBSERVED_AT),
  });
  const result = await adapter.collect(context());
  assert.equal(result.state, "ok");
  assert.equal(result.windows?.[0]?.usedPercent, 42);
  assert.equal(result.details?.commandcode.planName, "GOAT");
  assert.equal(result.lastSuccessAt, OBSERVED_AT);
});
