import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchCommandCodeJson,
  COMMANDCODE_CREDITS_ENDPOINT,
  COMMANDCODE_DEFAULT_MAX_RESPONSE_BYTES,
  COMMANDCODE_SUBSCRIPTION_ENDPOINT,
  type CommandCodeResponse,
  type CommandCodeUsageFetchSeam,
} from "../../../src/providers/commandcode/fetch.js";
import { parseCommandCodeUsageResponse } from "../../../src/providers/commandcode/usage.js";

const CREDENTIAL = { kind: "oauth" as const, value: "key-abc" };

function fakeResponse(status: number, body: string | null, headers: Record<string, string> = {}): CommandCodeResponse {
  return {
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    body: body === null ? null : { getReader: () => {
      const bytes = new TextEncoder().encode(body);
      let offset = 0;
      return {
        read: async () => {
          if (offset >= bytes.length) return { done: true };
          const chunk = bytes.subarray(offset, offset + 16);
          offset += chunk.length;
          return { done: false, value: chunk };
        },
        cancel: async () => {},
      };
    } },
  };
}

function wireBody(): string {
  return JSON.stringify({
    credits: { monthlyCredits: 200, purchasedCredits: 50, freeCredits: 10, belowThreshold: false, creditThreshold: 0.2 },
    windowLimits: {
      limited: false,
      exceeded: false,
      fiveHour: { used: 420, cap: 1000, exceeded: false, resetAt: 1756735200000 },
      weekly: { used: 30, cap: 300, exceeded: false, resetAt: 1759330800000 },
    },
  });
}

test("issues the exact GET request contract to the credits endpoint with Bearer + Accept headers", async () => {
  let requestedUrl = "";
  let requestedInit: { method: string; headers: Record<string, string>; redirect: string } | undefined;
  const fetch: CommandCodeUsageFetchSeam = async (url, init) => {
    requestedUrl = url;
    requestedInit = init;
    return fakeResponse(200, wireBody());
  };
  const controller = new AbortController();
  const result = await fetchCommandCodeJson({ credential: CREDENTIAL, signal: controller.signal, fetch });
  assert.equal(result.outcome, "ok");
  assert.equal(requestedUrl, COMMANDCODE_CREDITS_ENDPOINT);
  assert.equal(requestedInit?.method, "GET");
  assert.equal(requestedInit?.redirect, "manual");
  assert.equal(requestedInit?.headers.Authorization, "Bearer key-abc");
  assert.equal(requestedInit?.headers.Accept, "application/json");
});

test("honors an explicit endpoint for the subscriptions call", async () => {
  let requestedUrl = "";
  const fetch: CommandCodeUsageFetchSeam = async (url, init) => {
    requestedUrl = url;
    return fakeResponse(200, JSON.stringify({ data: { planId: "individual-goat" } }));
  };
  const controller = new AbortController();
  const result = await fetchCommandCodeJson({ credential: CREDENTIAL, signal: controller.signal, fetch, endpoint: COMMANDCODE_SUBSCRIPTION_ENDPOINT });
  assert.equal(result.outcome, "ok");
  assert.equal(requestedUrl, COMMANDCODE_SUBSCRIPTION_ENDPOINT);
});

test("returns ok for a 2xx body and the parser accepts the real wire shape (bridge)", async () => {
  const fetch: CommandCodeUsageFetchSeam = async () => fakeResponse(200, wireBody());
  const controller = new AbortController();
  const result = await fetchCommandCodeJson({ credential: CREDENTIAL, signal: controller.signal, fetch });
  assert.equal(result.outcome, "ok");
  if (result.outcome !== "ok") return;
  const parsed = parseCommandCodeUsageResponse(result.value, "2026-09-01T12:00:00.000Z");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.record.id, "commandcode");
  assert.equal(parsed.record.windows?.[0]?.used, 420);
  assert.equal(parsed.record.windows?.[0]?.limit, 1000);
  assert.equal(parsed.record.windows?.[0]?.usedPercent, 42);
});

test("maps 401, 403, and redirects to auth-needed; other statuses to http-status error", async () => {
  const controller = new AbortController();
  for (const status of [401, 403, 301, 302, 303, 307, 308]) {
    const fetch: CommandCodeUsageFetchSeam = async () => fakeResponse(status, null);
    const result = await fetchCommandCodeJson({ credential: CREDENTIAL, signal: controller.signal, fetch });
    assert.deepEqual(result, { outcome: "auth-needed" }, `status ${status}`);
  }
  for (const status of [400, 404, 429, 500, 503]) {
    const fetch: CommandCodeUsageFetchSeam = async () => fakeResponse(status, null);
    const result = await fetchCommandCodeJson({ credential: CREDENTIAL, signal: controller.signal, fetch });
    assert.deepEqual(result, { outcome: "error", reason: "http-status" }, `status ${status}`);
  }
});

test("returns malformed-response for a non-JSON 2xx body", async () => {
  const fetch: CommandCodeUsageFetchSeam = async () => fakeResponse(200, "<html>not json</html>");
  const controller = new AbortController();
  const result = await fetchCommandCodeJson({ credential: CREDENTIAL, signal: controller.signal, fetch });
  assert.deepEqual(result, { outcome: "error", reason: "malformed-response" });
});

test("returns oversized-response when content-length or a streamed body exceeds the cap", async () => {
  const controller = new AbortController();
  const declared = await fetchCommandCodeJson({
    credential: CREDENTIAL,
    signal: controller.signal,
    fetch: async () => fakeResponse(200, wireBody(), { "content-length": String(COMMANDCODE_DEFAULT_MAX_RESPONSE_BYTES + 1) }),
  });
  assert.deepEqual(declared, { outcome: "error", reason: "oversized-response" });

  const big = wireBody().padEnd(4097, " ");
  const streamed = await fetchCommandCodeJson({
    credential: CREDENTIAL,
    signal: controller.signal,
    fetch: async () => fakeResponse(200, big),
    maxResponseBytes: 4096,
  });
  assert.deepEqual(streamed, { outcome: "error", reason: "oversized-response" });
});

test("returns transport on rejection, aborted on pre-abort, and timeout on budget elapse", async () => {
  const controller = new AbortController();
  const transport = await fetchCommandCodeJson({
    credential: CREDENTIAL,
    signal: controller.signal,
    fetch: async () => { throw new Error("network down"); },
  });
  assert.deepEqual(transport, { outcome: "error", reason: "transport" });

  const preAborted = new AbortController();
  preAborted.abort();
  const aborted = await fetchCommandCodeJson({ credential: CREDENTIAL, signal: preAborted.signal, fetch: async () => fakeResponse(200, wireBody()) });
  assert.deepEqual(aborted, { outcome: "error", reason: "aborted" });

  const timeout = await fetchCommandCodeJson({
    credential: CREDENTIAL,
    signal: controller.signal,
    fetch: (_url, init) => new Promise<CommandCodeResponse>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("abort")));
    }),
    timeoutMs: 10,
  });
  assert.deepEqual(timeout, { outcome: "error", reason: "timeout" });
});

test("rejects invalid timeout and response-size configuration before fetch", async () => {
  const controller = new AbortController();
  const base = { credential: CREDENTIAL, signal: controller.signal } as const;
  for (const options of [
    { timeoutMs: 0 },
    { timeoutMs: 30_001 },
    { timeoutMs: 1.5 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 256 * 1024 + 1 },
  ]) {
    const result = await fetchCommandCodeJson({ ...base, ...options });
    assert.deepEqual(result, { outcome: "error", reason: "invalid-config" }, JSON.stringify(options));
  }
});
