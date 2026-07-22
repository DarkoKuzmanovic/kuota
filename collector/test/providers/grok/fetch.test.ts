import assert from "node:assert/strict";
import test from "node:test";

import type { GrokCredential } from "../../../src/providers/grok/auth.js";
import {
  GROK_BILLING_ENDPOINT,
  GROK_BILLING_WEEKLY_ENDPOINT,
  fetchGrokUsage,
  type GrokUsageFetchSeam,
} from "../../../src/providers/grok/fetch.js";

const CREDENTIAL: GrokCredential = { kind: "oauth", value: "synthetic-grok-access-not-real" };
const TOKEN_AUTH_HEADER = "xai-grok-cli";

function response(status: number, text: string) {
  const bytes = new TextEncoder().encode(text);
  let read = false;
  let cancelled = 0;
  return {
    response: {
      status,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => read ? { done: true } : (read = true, { done: false, value: bytes }),
          cancel: async () => { cancelled += 1; },
        }),
      },
    },
    cancelled: () => cancelled,
  };
}

test("performs one manual-redirect Grok GET with Bearer and x-xai-token-auth headers", async () => {
  const fixture = response(200, JSON.stringify({
    config: { monthlyLimit: { val: 1000 }, used: { val: 250 }, billingPeriodEnd: "2026-08-01T00:00:00.000Z" },
  }));
  let calls = 0;
  let seenUrl = "";
  let seenAuthorization = "";
  let seenTokenAuth = "";

  const fetch: GrokUsageFetchSeam = async (url, init) => {
    calls += 1;
    seenUrl = url;
    seenAuthorization = init.headers.Authorization ?? "";
    seenTokenAuth = init.headers["x-xai-token-auth"] ?? "";
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    return fixture.response;
  };

  const result = await fetchGrokUsage({ credential: CREDENTIAL, signal: new AbortController().signal, fetch });
  assert.deepEqual(result, {
    outcome: "ok",
    value: {
      monthly: { config: { monthlyLimit: { val: 1000 }, used: { val: 250 }, billingPeriodEnd: "2026-08-01T00:00:00.000Z" } },
    },
  });
  // fetchGrokUsage always fires the weekly endpoint too (best-effort); monthly is primary.
  assert.equal(calls, 2);
  assert.equal(seenAuthorization, `Bearer ${CREDENTIAL.value}`);
  assert.equal(seenTokenAuth, TOKEN_AUTH_HEADER);
});

test("fetches optional weekly window when monthly succeeds", async () => {
  const monthly = response(200, JSON.stringify({
    config: { monthlyLimit: { val: 1000 }, used: { val: 250 }, billingPeriodEnd: "2026-08-01T00:00:00.000Z" },
  }));
  const weekly = response(200, JSON.stringify({
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
      creditUsagePercent: 45,
      billingPeriodEnd: "2026-07-29T00:00:00.000Z",
    },
  }));
  let urls: string[] = [];

  const fetch: GrokUsageFetchSeam = async (url, init) => {
    urls.push(url);
    if (url === GROK_BILLING_ENDPOINT) return monthly.response;
    if (url === GROK_BILLING_WEEKLY_ENDPOINT) return weekly.response;
    throw new Error(`unexpected url: ${url}`);
  };

  const result = await fetchGrokUsage({ credential: CREDENTIAL, signal: new AbortController().signal, fetch });
  assert.deepEqual(result, {
    outcome: "ok",
    value: {
      monthly: { config: { monthlyLimit: { val: 1000 }, used: { val: 250 }, billingPeriodEnd: "2026-08-01T00:00:00.000Z" } },
      weekly: { config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" }, creditUsagePercent: 45, billingPeriodEnd: "2026-07-29T00:00:00.000Z" } },
    },
  });
  assert.deepEqual(urls, [GROK_BILLING_ENDPOINT, GROK_BILLING_WEEKLY_ENDPOINT]);
});

test("classifies auth, redirects, malformed payloads, caller aborts, and cancels unused bodies safely", async () => {
  const auth = response(401, "ignored");
  const redirect = response(302, "ignored");
  const malformed = response(200, "not-json");
  const aborted = new AbortController();
  aborted.abort();

  assert.deepEqual(await fetchGrokUsage({ credential: CREDENTIAL, signal: new AbortController().signal, fetch: async () => auth.response }), { outcome: "auth-needed" });
  assert.equal(auth.cancelled(), 1);
  assert.deepEqual(await fetchGrokUsage({ credential: CREDENTIAL, signal: new AbortController().signal, fetch: async () => redirect.response }), { outcome: "auth-needed" });
  assert.equal(redirect.cancelled(), 1);
  assert.deepEqual(await fetchGrokUsage({ credential: CREDENTIAL, signal: new AbortController().signal, fetch: async () => malformed.response }), { outcome: "error", reason: "malformed-response" });
  assert.deepEqual(await fetchGrokUsage({ credential: CREDENTIAL, signal: aborted.signal, fetch: async () => malformed.response }), { outcome: "error", reason: "aborted" });
});

test("ignores weekly fetch failure and still returns monthly data", async () => {
  const monthly = response(200, JSON.stringify({
    config: { monthlyLimit: { val: 1000 }, used: { val: 250 }, billingPeriodEnd: "2026-08-01T00:00:00.000Z" },
  }));
  const weekly = response(404, "not found");

  const fetch: GrokUsageFetchSeam = async (url) => {
    if (url === GROK_BILLING_ENDPOINT) return monthly.response;
    return weekly.response;
  };

  const result = await fetchGrokUsage({ credential: CREDENTIAL, signal: new AbortController().signal, fetch });
  assert.deepEqual(result, {
    outcome: "ok",
    value: {
      monthly: { config: { monthlyLimit: { val: 1000 }, used: { val: 250 }, billingPeriodEnd: "2026-08-01T00:00:00.000Z" } },
    },
  });
});

test("maps network failures to a value-free transport error", async () => {
  const result = await fetchGrokUsage({
    credential: CREDENTIAL,
    signal: new AbortController().signal,
    fetch: async () => Promise.reject(new Error(CREDENTIAL.value)),
  });
  assert.deepEqual(result, { outcome: "error", reason: "transport" });
  assert.equal(JSON.stringify(result).includes(CREDENTIAL.value), false);
});

test("keeps the local timeout active while a successful response body is streaming", { timeout: 250 }, async () => {
  let cancelled = 0;
  const fetch: GrokUsageFetchSeam = async (_url, init) => ({
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: () => new Promise((resolve) => {
          init.signal.addEventListener("abort", () => resolve({ done: true }), { once: true });
        }),
        cancel: async () => { cancelled += 1; },
      }),
    },
  });

  const result = await fetchGrokUsage({
    credential: CREDENTIAL,
    signal: new AbortController().signal,
    fetch,
    timeoutMs: 10,
  });
  assert.deepEqual(result, { outcome: "error", reason: "timeout" });
  assert.equal(cancelled, 1);
});

test("rejects declared and streamed response bodies over the configured byte cap", async () => {
  let declaredCancelled = 0;
  const declared = await fetchGrokUsage({
    credential: CREDENTIAL,
    signal: new AbortController().signal,
    maxResponseBytes: 8,
    fetch: async () => ({
      status: 200,
      headers: { get: () => "9" },
      body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => { declaredCancelled += 1; } }) },
    }),
  });
  assert.deepEqual(declared, { outcome: "error", reason: "oversized-response" });
  assert.equal(declaredCancelled, 1);

  let streamedCancelled = 0;
  const streamed = await fetchGrokUsage({
    credential: CREDENTIAL,
    signal: new AbortController().signal,
    maxResponseBytes: 8,
    fetch: async () => ({
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(9) }), cancel: async () => { streamedCancelled += 1; } }) },
    }),
  });
  assert.deepEqual(streamed, { outcome: "error", reason: "oversized-response" });
  assert.equal(streamedCancelled, 1);
});

test("rejects invalid timeout and response-size configuration before fetch", async () => {
  for (const options of [
    { timeoutMs: 0 },
    { timeoutMs: 30_001 },
    { timeoutMs: 1.5 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 256 * 1024 + 1 },
    { maxResponseBytes: Number.POSITIVE_INFINITY },
  ]) {
    let calls = 0;
    const result = await fetchGrokUsage({
      credential: CREDENTIAL,
      signal: new AbortController().signal,
      fetch: async () => { calls += 1; return response(200, "{}").response; },
      ...options,
    });
    assert.deepEqual(result, { outcome: "error", reason: "invalid-config" });
    assert.equal(calls, 0);
  }
});
