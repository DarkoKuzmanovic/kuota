import assert from "node:assert/strict";
import test from "node:test";

import type { CursorSessionCredential } from "../../../src/providers/cursor/auth.js";
import { formatSessionCookieValue } from "../../../src/providers/cursor/cookie.js";
import {
  CURSOR_USAGE_SUMMARY_ENDPOINT,
  fetchCursorUsage,
  type CursorUsageFetchSeam,
} from "../../../src/providers/cursor/fetch.js";

const RAW_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzeW50aGV0aWMtdXNlci0xMjMifQ.signature";
const SHAPED_TOKEN = `synthetic-user-123::${RAW_JWT}`;
const CREDENTIAL: CursorSessionCredential = { kind: "session", value: RAW_JWT };

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

test("formatSessionCookieValue shapes raw JWT and already-shaped tokens", () => {
  assert.equal(formatSessionCookieValue(RAW_JWT), SHAPED_TOKEN);
  assert.equal(formatSessionCookieValue(SHAPED_TOKEN), SHAPED_TOKEN);
  assert.equal(formatSessionCookieValue(encodeURIComponent(SHAPED_TOKEN)), SHAPED_TOKEN);
});

test("performs one manual-redirect Cursor GET with shaped session cookie only", async () => {
  const fixture = response(200, '{"individualUsage":{"plan":{"used":1}}}');
  let calls = 0;
  let seenUrl = "";
  let seenCookie = "";
  const fetch: CursorUsageFetchSeam = async (url, init) => {
    calls += 1;
    seenUrl = url;
    seenCookie = init.headers.Cookie ?? "";
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    return fixture.response;
  };
  const result = await fetchCursorUsage({ credential: CREDENTIAL, signal: new AbortController().signal, fetch });
  assert.equal(result.outcome, "ok");
  assert.equal(calls, 1);
  assert.equal(seenUrl, CURSOR_USAGE_SUMMARY_ENDPOINT);
  assert.equal(seenCookie, `WorkosCursorSessionToken=${SHAPED_TOKEN}`);
});

test("classifies auth, redirects, malformed payloads, caller aborts, and cancels unused bodies safely", async () => {
  const auth = response(401, "ignored");
  const redirect = response(302, "ignored");
  const malformed = response(200, "not-json");
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await fetchCursorUsage({ credential: CREDENTIAL, signal: new AbortController().signal, fetch: async () => auth.response }), { outcome: "auth-needed" });
  assert.equal(auth.cancelled(), 1);
  assert.deepEqual(await fetchCursorUsage({ credential: CREDENTIAL, signal: new AbortController().signal, fetch: async () => redirect.response }), { outcome: "auth-needed" });
  assert.equal(redirect.cancelled(), 1);
  assert.deepEqual(await fetchCursorUsage({ credential: CREDENTIAL, signal: new AbortController().signal, fetch: async () => malformed.response }), { outcome: "error", reason: "malformed-response" });
  assert.deepEqual(await fetchCursorUsage({ credential: CREDENTIAL, signal: aborted.signal, fetch: async () => malformed.response }), { outcome: "error", reason: "aborted" });
});

test("classifies 403 as auth-needed and cancels its unread body", async () => {
  const forbidden = response(403, "ignored");
  const result = await fetchCursorUsage({
    credential: CREDENTIAL,
    signal: new AbortController().signal,
    fetch: async () => forbidden.response,
  });
  assert.deepEqual(result, { outcome: "auth-needed" });
  assert.equal(forbidden.cancelled(), 1);
});

test("maps network failures to a value-free transport error", async () => {
  const result = await fetchCursorUsage({
    credential: CREDENTIAL,
    signal: new AbortController().signal,
    fetch: async () => Promise.reject(new Error(CREDENTIAL.value)),
  });
  assert.deepEqual(result, { outcome: "error", reason: "transport" });
  assert.equal(JSON.stringify(result).includes(CREDENTIAL.value), false);
  assert.equal(JSON.stringify(result).includes(SHAPED_TOKEN), false);
});
