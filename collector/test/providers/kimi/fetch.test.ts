import assert from "node:assert/strict";
import test from "node:test";

import type { KimiCredential } from "../../../src/providers/kimi/auth.js";
import {
  KIMI_USAGE_ENDPOINT,
  fetchKimiUsage,
  type KimiUsageFetchSeam,
} from "../../../src/providers/kimi/fetch.js";

const CREDENTIAL: KimiCredential = { kind: "oauth", value: "synthetic-kimi-access-not-real" };

function response(status: number, text: string) {
  const bytes = new TextEncoder().encode(text);
  let read = false;
  let cancelled = 0;
  return {
    response: {
      status,
      headers: { get: () => null },
      body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { done: false, value: bytes }), cancel: async () => { cancelled += 1; } }) },
    },
    cancelled: () => cancelled,
  };
}

test("performs one manual-redirect Kimi GET with the credential only in Bearer authorization", async () => {
  const fixture = response(200, '{"usage":{"used":"1"}}');
  let calls = 0;
  let seenUrl = "";
  let seenAuthorization = "";
  const fetch: KimiUsageFetchSeam = async (url, init) => {
    calls += 1;
    seenUrl = url;
    seenAuthorization = init.headers.Authorization ?? "";
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    return fixture.response;
  };
  const result = await fetchKimiUsage({ credential: CREDENTIAL, signal: new AbortController().signal, fetch });
  assert.deepEqual(result, { outcome: "ok", value: { usage: { used: "1" } } });
  assert.equal(calls, 1);
  assert.equal(seenUrl, KIMI_USAGE_ENDPOINT);
  assert.equal(seenAuthorization, `Bearer ${CREDENTIAL.value}`);
});

test("classifies auth, redirects, malformed payloads, caller aborts, and cancels unused bodies safely", async () => {
  const auth = response(401, "ignored");
  const redirect = response(302, "ignored");
  const malformed = response(200, "not-json");
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await fetchKimiUsage({ credential: CREDENTIAL, signal: new AbortController().signal, fetch: async () => auth.response }), { outcome: "auth-needed" });
  assert.equal(auth.cancelled(), 1);
  assert.deepEqual(await fetchKimiUsage({ credential: CREDENTIAL, signal: new AbortController().signal, fetch: async () => redirect.response }), { outcome: "auth-needed" });
  assert.equal(redirect.cancelled(), 1);
  assert.deepEqual(await fetchKimiUsage({ credential: CREDENTIAL, signal: new AbortController().signal, fetch: async () => malformed.response }), { outcome: "error", reason: "malformed-response" });
  assert.deepEqual(await fetchKimiUsage({ credential: CREDENTIAL, signal: aborted.signal, fetch: async () => malformed.response }), { outcome: "error", reason: "aborted" });
});

test("classifies 403 as auth-needed and cancels its unread body", async () => {
  const forbidden = response(403, "ignored");
  const result = await fetchKimiUsage({
    credential: CREDENTIAL,
    signal: new AbortController().signal,
    fetch: async () => forbidden.response,
  });
  assert.deepEqual(result, { outcome: "auth-needed" });
  assert.equal(forbidden.cancelled(), 1);
});

test("maps network failures to a value-free transport error", async () => {
  const result = await fetchKimiUsage({
    credential: CREDENTIAL,
    signal: new AbortController().signal,
    fetch: async () => Promise.reject(new Error(CREDENTIAL.value)),
  });
  assert.deepEqual(result, { outcome: "error", reason: "transport" });
  assert.equal(JSON.stringify(result).includes(CREDENTIAL.value), false);
});

test("keeps the local timeout active while a successful response body is streaming", { timeout: 250 }, async () => {
  let cancelled = 0;
  const fetch: KimiUsageFetchSeam = async (_url, init) => ({
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
  const result = await fetchKimiUsage({
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
  const declared = await fetchKimiUsage({
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
  const streamed = await fetchKimiUsage({
    credential: CREDENTIAL,
    signal: new AbortController().signal,
    maxResponseBytes: 8,
    fetch: async () => {
      let read = false;
      return {
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () => read ? { done: true } : (read = true, { done: false, value: new Uint8Array(9) }),
            cancel: async () => { streamedCancelled += 1; },
          }),
        },
      };
    },
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
    const result = await fetchKimiUsage({
      credential: CREDENTIAL,
      signal: new AbortController().signal,
      fetch: async () => { calls += 1; return response(200, "{}").response; },
      ...options,
    });
    assert.deepEqual(result, { outcome: "error", reason: "invalid-config" });
    assert.equal(calls, 0);
  }
});
