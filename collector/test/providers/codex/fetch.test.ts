import assert from "node:assert/strict";
import test from "node:test";

import type { CodexOAuthCredential } from "../../../src/providers/codex/auth.js";
import {
  CODEX_DEFAULT_MAX_RESPONSE_BYTES,
  CODEX_DEFAULT_TIMEOUT_MS,
  CODEX_USAGE_ENDPOINT,
  CODEX_USAGE_USER_AGENT,
  fetchCodexUsage,
  type BodyReadChunk,
  type CodexFetchErrorReason,
  type CodexFetchResult,
  type CodexUsageFetchSeam,
  type CodexUsageRequestInit,
  type FetchResponseLike,
  type ResponseBodyLike,
  type ResponseBodyReaderLike,
  type ResponseHeadersLike,
} from "../../../src/providers/codex/fetch.js";

const ACCESS = "synthetic-codex-access-value-001-not-real";
const ACCOUNT_ID = "synthetic-codex-account-id-001-not-real";
const CREDENTIAL: CodexOAuthCredential = { access: ACCESS, accountId: ACCOUNT_ID };

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function fakeHeaders(values: Record<string, string> = {}): ResponseHeadersLike {
  const lower = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) lower.set(key.toLowerCase(), value);
  return { get: (name: string): string | null => lower.get(name.toLowerCase()) ?? null };
}

interface StreamState {
  readonly reads: { value: number };
  readonly cancels: { value: number };
}

function stream(
  chunks: readonly Uint8Array[],
): { readonly body: ResponseBodyLike; readonly state: StreamState } {
  const reads = { value: 0 };
  const cancels = { value: 0 };
  let index = 0;
  return {
    state: { reads, cancels },
    body: {
      getReader(): ResponseBodyReaderLike {
        return {
          async read(): Promise<BodyReadChunk> {
            reads.value += 1;
            const value = chunks[index];
            index += 1;
            return value === undefined ? { done: true } : { done: false, value };
          },
          async cancel(): Promise<void> {
            cancels.value += 1;
          },
        };
      },
    },
  };
}

function response(
  status: number,
  body: ResponseBodyLike | null,
  headers: Record<string, string> = {},
): FetchResponseLike {
  return { status, body, headers: fakeHeaders(headers) };
}

interface Capture {
  calls: number;
  url?: string;
  init?: CodexUsageRequestInit;
}

function seamFor(
  result: FetchResponseLike | Promise<FetchResponseLike>,
): { readonly seam: CodexUsageFetchSeam; readonly capture: Capture } {
  const capture: Capture = { calls: 0 };
  return {
    capture,
    seam: (url, init): Promise<FetchResponseLike> => {
      capture.calls += 1;
      capture.url = url;
      capture.init = init;
      return Promise.resolve(result);
    },
  };
}

function run(
  fetch: CodexUsageFetchSeam,
  extra: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly maxResponseBytes?: number;
  } = {},
): Promise<CodexFetchResult> {
  return fetchCodexUsage({
    credential: CREDENTIAL,
    signal: extra.signal ?? new AbortController().signal,
    fetch,
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
    ...(extra.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: extra.maxResponseBytes }),
  });
}

function assertError(result: CodexFetchResult, reason: CodexFetchErrorReason): void {
  assert.equal(result.outcome, "error");
  if (result.outcome === "error") assert.equal(result.reason, reason);
}

function assertValueFree(result: CodexFetchResult): void {
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(ACCESS), false);
  assert.equal(serialized.includes(ACCOUNT_ID), false);
}

test("issues the approved bounded native GET with credentials only in pi-hud-compatible headers", async () => {
  const controller = new AbortController();
  const payload = { rate_limit: { primary_window: { used_percent: 10 } } };
  const { body } = stream([encode(JSON.stringify(payload))]);
  const { seam, capture } = seamFor(response(200, body));

  const result = await run(seam, { signal: controller.signal });

  assert.deepEqual(result, { outcome: "ok", value: payload });
  assert.equal(capture.calls, 1);
  assert.equal(capture.url, CODEX_USAGE_ENDPOINT);
  assert.equal(capture.url?.includes(ACCESS), false);
  assert.equal(capture.url?.includes(ACCOUNT_ID), false);
  assert.equal(capture.init?.method, "GET");
  assert.equal(capture.init?.redirect, "manual");
  assert.equal(capture.init?.signal.aborted, false);
  assert.deepEqual(capture.init?.headers, {
    Authorization: `Bearer ${ACCESS}`,
    "chatgpt-account-id": ACCOUNT_ID,
    "OpenAI-Beta": "responses=experimental",
    "User-Agent": CODEX_USAGE_USER_AGENT,
  });
});

test("exposes the owner-approved endpoint and conservative transport bounds", () => {
  assert.equal(CODEX_USAGE_ENDPOINT, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(CODEX_USAGE_USER_AGENT, "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36");
  assert.equal(CODEX_DEFAULT_TIMEOUT_MS, 15_000);
  assert.equal(CODEX_DEFAULT_MAX_RESPONSE_BYTES, 256 * 1024);
});

test("makes only native 401 and 403 curl-eligible without reading their bodies", async () => {
  for (const status of [401, 403]) {
    const source = stream([encode('{"not":"read"}')]);
    const result = await run(seamFor(response(status, source.body)).seam);
    assert.deepEqual(result, { outcome: "curl-eligible" });
    assert.equal(source.state.reads.value, 0);
    assert.equal(source.state.cancels.value, 1);
    assertValueFree(result);
  }
});

test("maps manual login redirects to auth-needed without curl eligibility or body reads", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const source = stream([encode('{"not":"read"}')]);
    const result = await run(seamFor(response(status, source.body)).seam);
    assert.deepEqual(result, { outcome: "auth-needed" });
    assert.equal(source.state.reads.value, 0);
    assert.equal(source.state.cancels.value, 1);
    assertValueFree(result);
  }
});

test("keeps 429, other HTTP statuses, and network failures terminal and value-free", async () => {
  for (const status of [300, 400, 429, 500, 599]) {
    const source = stream([encode('{"not":"read"}')]);
    const result = await run(seamFor(response(status, source.body)).seam);
    assertError(result, "http-status");
    assert.equal(source.state.reads.value, 0);
    assert.equal(source.state.cancels.value, 1);
    assertValueFree(result);
  }
  const rejected: CodexUsageFetchSeam = () =>
    Promise.reject(new Error(`synthetic network failure ${ACCESS} ${ACCOUNT_ID}`));
  const result = await run(rejected);
  assertError(result, "transport");
  assertValueFree(result);
});

test("does not call fetch when the caller signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const { seam, capture } = seamFor(response(200, stream([encode("{}")] ).body));

  const result = await run(seam, { signal: controller.signal });

  assertError(result, "aborted");
  assert.equal(capture.calls, 0);
});

test("prevents zero-progress body loops and cancels abnormal streams", async () => {
  let reads = 0;
  let cancels = 0;
  const body: ResponseBodyLike = {
    getReader: (): ResponseBodyReaderLike => ({
      read: async (): Promise<BodyReadChunk> => {
        reads += 1;
        return { done: false, value: new Uint8Array(0) };
      },
      cancel: async (): Promise<void> => {
        cancels += 1;
      },
    }),
  };

  const result = await run(seamFor(response(200, body)).seam);

  assertError(result, "malformed-response");
  assert.equal(reads, 1);
  assert.equal(cancels, 1);
});

test("bounds streamed bytes, handles missing bodies, and accepts the exact byte cap", async () => {
  const overflow = stream([new Uint8Array(5), new Uint8Array(5)]);
  const tooLarge = await run(seamFor(response(200, overflow.body)).seam, {
    maxResponseBytes: 8,
  });
  assertError(tooLarge, "oversized-response");
  assert.equal(overflow.state.cancels.value, 1);

  const declaredOversized = stream([encode('{"not":"read"}')]);
  const declared = await run(
    seamFor(response(200, declaredOversized.body, { "content-length": "9" })).seam,
    { maxResponseBytes: 8 },
  );
  assertError(declared, "oversized-response");
  assert.equal(declaredOversized.state.reads.value, 0);
  assert.equal(declaredOversized.state.cancels.value, 1);

  const missing = await run(seamFor(response(200, null)).seam);
  assertError(missing, "malformed-response");

  const bytes = encode('{"rate_limit":{}}');
  const exact = await run(seamFor(response(200, stream([bytes]).body)).seam, {
    maxResponseBytes: bytes.byteLength,
  });
  assert.deepEqual(exact, { outcome: "ok", value: { rate_limit: {} } });
});

test("classifies malformed UTF-8 and JSON without exposing native content", async () => {
  const invalidUtf8 = await run(
    seamFor(response(200, stream([new Uint8Array([0xff])]).body)).seam,
  );
  assertError(invalidUtf8, "malformed-response");

  const invalidJson = await run(
    seamFor(response(200, stream([encode("not json")]).body)).seam,
  );
  assertError(invalidJson, "malformed-response");
});

test("classifies a caller abort that occurs during streaming and cancels the reader", async () => {
  const controller = new AbortController();
  let cancels = 0;
  const body: ResponseBodyLike = {
    getReader: (): ResponseBodyReaderLike => ({
      read: async (): Promise<BodyReadChunk> => {
        controller.abort();
        return { done: true };
      },
      cancel: async (): Promise<void> => {
        cancels += 1;
      },
    }),
  };

  const result = await run(seamFor(response(200, body)).seam, { signal: controller.signal });

  assertError(result, "aborted");
  assert.equal(cancels, 1);
});

test("uses the bounded timeout signal when the fetch seam observes cancellation", async () => {
  const seam: CodexUsageFetchSeam = (_url, init) =>
    new Promise<FetchResponseLike>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("synthetic timeout")), {
        once: true,
      });
    });

  const result = await run(seam, { timeoutMs: 1 });

  assertError(result, "timeout");
});

test("rejects invalid configured timeout and byte bounds before calling fetch", async () => {
  for (const extra of [
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: 1.5 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: Number.POSITIVE_INFINITY },
    { maxResponseBytes: CODEX_DEFAULT_MAX_RESPONSE_BYTES + 1 },
  ]) {
    const { seam, capture } = seamFor(response(200, stream([encode("{}")] ).body));
    const result = await run(seam, extra);
    assertError(result, "invalid-config");
    assert.equal(capture.calls, 0);
  }
});
