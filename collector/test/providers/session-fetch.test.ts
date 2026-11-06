import assert from "node:assert/strict";
import test from "node:test";

import { fetchSessionJson, type SessionFetchSeam } from "../../src/providers/session-fetch.js";

function respond(status: number, body: string, headers: Record<string, string> = {}): SessionFetchSeam {
  return async () => {
    let sent = false;
    return {
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      body: { getReader: () => ({
        read: async () => {
          if (sent || body.length === 0) return { done: true };
          sent = true;
          return { done: false, value: new TextEncoder().encode(body) };
        },
      }) },
    };
  };
}

const signal = new AbortController().signal;
const base = { url: "https://synthetic.test/usage", headers: { Cookie: "synthetic=not-real" }, signal };

test("session fetch maps JSON, login redirects, login HTML, and server errors", async () => {
  assert.deepEqual(await fetchSessionJson({ ...base, fetch: respond(200, '{"a":1}') }), { outcome: "ok", value: { a: 1 } });
  assert.deepEqual(await fetchSessionJson({ ...base, fetch: respond(302, "") }), { outcome: "auth-needed" });
  assert.deepEqual(await fetchSessionJson({ ...base, fetch: respond(401, "") }), { outcome: "auth-needed" });
  assert.deepEqual(await fetchSessionJson({ ...base, fetch: respond(200, "<!DOCTYPE html><html>login</html>") }), { outcome: "auth-needed" });
  assert.deepEqual(await fetchSessionJson({ ...base, fetch: respond(200, "not json") }), { outcome: "error", reason: "malformed-response" });
  assert.deepEqual(await fetchSessionJson({ ...base, fetch: respond(500, "") }), { outcome: "error", reason: "http-status" });
  assert.deepEqual(await fetchSessionJson({ ...base, fetch: respond(200, "{}", { "content-length": "999999999" }) }),
    { outcome: "error", reason: "oversized-response" });
});

test("session fetch sends the cookie, never follows redirects, and accepts JSON", async () => {
  let seen: Parameters<SessionFetchSeam>[1] | undefined;
  await fetchSessionJson({ ...base, fetch: async (url, init) => { seen = init; return respond(200, "{}")(url, init); } });
  assert.equal(seen?.redirect, "manual");
  assert.equal(seen?.headers.Cookie, "synthetic=not-real");
  assert.equal(seen?.headers.Accept, "application/json");
});
