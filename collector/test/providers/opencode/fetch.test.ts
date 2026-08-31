import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchOpencodeUsage,
  OPENCODE_DEFAULT_MAX_RESPONSE_BYTES,
  OPENCODE_USAGE_ENDPOINT,
  type OpencodeResponse,
  type OpencodeUsageFetchSeam,
} from "../../../src/providers/opencode/fetch.js";
import { parseOpencodeUsageResponse } from "../../../src/providers/opencode/usage.js";

const CREDENTIAL = { kind: "api-key" as const, value: "key-abc" };

function fakeResponse(status: number, body: string | null, headers: Record<string, string> = {}): OpencodeResponse {
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

function wireBody(percent = 42.5, resetsAt = "2026-09-08T00:00:00+02:00"): string {
  return JSON.stringify({
    usage: {
      rolling: { status: "ok", percent, resetsAt },
      weekly: { status: "ok", percent: 71.25, resetsAt },
      monthly: { status: "ok", percent: 12.5, resetsAt },
    },
  });
}

test("issues the exact GET request contract to the OpenCode Go endpoint", async () => {
  let requestedUrl = "";
  let requestedInit: { method: string; headers: Record<string, string>; redirect: string } | undefined;
  const fetch: OpencodeUsageFetchSeam = async (url, init) => {
    requestedUrl = url;
    requestedInit = init;
    return fakeResponse(200, wireBody());
  };
  const controller = new AbortController();
  const result = await fetchOpencodeUsage({ credential: CREDENTIAL, signal: controller.signal, fetch });
  assert.equal(result.outcome, "ok");
  assert.equal(requestedUrl, OPENCODE_USAGE_ENDPOINT);
  assert.equal(requestedInit?.method, "GET");
  assert.equal(requestedInit?.redirect, "manual");
  assert.equal(requestedInit?.headers.Authorization, "Bearer key-abc");
  assert.equal(requestedInit?.headers["Content-Type"], undefined);
});

test("returns ok for a 2xx body and the parser accepts the real wire shape (bridge)", async () => {
  const fetch: OpencodeUsageFetchSeam = async () => fakeResponse(200, wireBody(42.5));
  const controller = new AbortController();
  const result = await fetchOpencodeUsage({ credential: CREDENTIAL, signal: controller.signal, fetch });
  assert.equal(result.outcome, "ok");
  if (result.outcome !== "ok") return;
  const parsed = parseOpencodeUsageResponse(result.value, "2026-09-01T12:00:00.000Z");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.record.id, "opencode");
  assert.equal(parsed.record.state, "ok");
  assert.equal(parsed.record.windows?.length, 3);
  assert.equal(parsed.record.windows?.[0]?.id, "rolling");
  assert.equal(parsed.record.windows?.[0]?.usedPercent, 42.5);
});

test("maps 401 to auth-needed", async () => {
  const fetch: OpencodeUsageFetchSeam = async () => fakeResponse(401, null);
  const controller = new AbortController();
  const result = await fetchOpencodeUsage({ credential: CREDENTIAL, signal: controller.signal, fetch });
  assert.deepEqual(result, { outcome: "auth-needed" });
});

test("maps 403 and redirects to auth-needed", async () => {
  const controller = new AbortController();
  for (const status of [403, 301, 302, 303, 307, 308]) {
    const fetch: OpencodeUsageFetchSeam = async () => fakeResponse(status, null);
    const result = await fetchOpencodeUsage({ credential: CREDENTIAL, signal: controller.signal, fetch });
    assert.deepEqual(result, { outcome: "auth-needed" }, `status ${status}`);
  }
});

test("maps other 4xx/5xx to http-status error", async () => {
  const controller = new AbortController();
  for (const status of [400, 404, 429, 500, 503]) {
    const fetch: OpencodeUsageFetchSeam = async () => fakeResponse(status, null);
    const result = await fetchOpencodeUsage({ credential: CREDENTIAL, signal: controller.signal, fetch });
    assert.deepEqual(result, { outcome: "error", reason: "http-status" }, `status ${status}`);
  }
});

test("returns malformed-response for a non-JSON 2xx body", async () => {
  const fetch: OpencodeUsageFetchSeam = async () => fakeResponse(200, "<html>not json</html>");
  const controller = new AbortController();
  const result = await fetchOpencodeUsage({ credential: CREDENTIAL, signal: controller.signal, fetch });
  assert.deepEqual(result, { outcome: "error", reason: "malformed-response" });
});

test("returns oversized-response when content-length exceeds the cap", async () => {
  const fetch: OpencodeUsageFetchSeam = async () => fakeResponse(200, wireBody(), { "content-length": String(OPENCODE_DEFAULT_MAX_RESPONSE_BYTES + 1) });
  const controller = new AbortController();
  const result = await fetchOpencodeUsage({ credential: CREDENTIAL, signal: controller.signal, fetch });
  assert.deepEqual(result, { outcome: "error", reason: "oversized-response" });
});

test("returns oversized-response when a streamed body exceeds the cap", async () => {
  const big = `{"usage":{"rolling":{"status":"ok","percent":1,"resetsAt":"2026-09-08T00:00:00+02:00"},"weekly":{"status":"ok","percent":1,"resetsAt":"2026-09-08T00:00:00+02:00"},"monthly":{"status":"ok","percent":1,"resetsAt":"2026-09-08T00:00:00+02:00"}}}`.padEnd(OPENCODE_DEFAULT_MAX_RESPONSE_BYTES + 1, " ");
  const fetch: OpencodeUsageFetchSeam = async () => fakeResponse(200, big);
  const controller = new AbortController();
  const result = await fetchOpencodeUsage({ credential: CREDENTIAL, signal: controller.signal, fetch, maxResponseBytes: 4096 });
  assert.deepEqual(result, { outcome: "error", reason: "oversized-response" });
});

test("returns transport on a rejected fetch and aborted on signal abort (no timeout blamed)", async () => {
  const fetch: OpencodeUsageFetchSeam = async () => { throw new Error("network down"); };
  const controller = new AbortController();
  const result = await fetchOpencodeUsage({ credential: CREDENTIAL, signal: controller.signal, fetch });
  assert.deepEqual(result, { outcome: "error", reason: "transport" });
  const aborted = new AbortController();
  aborted.abort();
  const result2 = await fetchOpencodeUsage({ credential: CREDENTIAL, signal: aborted.signal, fetch });
  assert.deepEqual(result2, { outcome: "error", reason: "aborted" });
});

test("returns timeout when the configured budget elapses", async () => {
  const fetch: OpencodeUsageFetchSeam = async (_url, init) =>
    new Promise<OpencodeResponse>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("abort")));
    });
  const controller = new AbortController();
  const result = await fetchOpencodeUsage({ credential: CREDENTIAL, signal: controller.signal, fetch, timeoutMs: 10 });
  assert.deepEqual(result, { outcome: "error", reason: "timeout" });
});

test("rejects invalid configuration (timeout zero, negative, absurd caps)", async () => {
  const controller = new AbortController();
  const base = { credential: CREDENTIAL, signal: controller.signal } as const;
  const zeroTimeout = await fetchOpencodeUsage({ ...base, timeoutMs: 0 });
  assert.deepEqual(zeroTimeout, { outcome: "error", reason: "invalid-config" });
  const bigCap = await fetchOpencodeUsage({ ...base, maxResponseBytes: OPENCODE_DEFAULT_MAX_RESPONSE_BYTES + 1 });
  assert.deepEqual(bigCap, { outcome: "error", reason: "invalid-config" });
});
