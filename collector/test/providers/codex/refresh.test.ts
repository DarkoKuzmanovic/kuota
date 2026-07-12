import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_REFRESH_DEFAULT_MAX_RESPONSE_BYTES,
  CODEX_OAUTH_TOKEN_ENDPOINT,
  refreshCodexOAuth,
  type BodyReadChunk,
  type CodexRefreshFetchSeam,
  type CodexRefreshRequestInit,
  type CodexRefreshResult,
  type FetchResponseLike,
  type ResponseBodyLike,
  type ResponseBodyReaderLike,
  type ResponseHeadersLike,
} from "../../../src/providers/codex/refresh.js";
import { CODEX_USAGE_USER_AGENT } from "../../../src/providers/codex/fetch.js";

const REFRESH = "synthetic-codex-refresh-token-not-real";
const ACCESS = "synthetic-codex-refreshed-access-not-real";
const ROTATED_REFRESH = "synthetic-codex-rotated-refresh-not-real";
const NOW = 1_700_000_000_000;

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function headers(values: Record<string, string> = {}): ResponseHeadersLike {
  const entries = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string): string | null => entries.get(name.toLowerCase()) ?? null };
}

interface StreamState {
  readonly reads: { value: number };
  readonly cancels: { value: number };
}

function stream(chunks: readonly Uint8Array[]): { readonly body: ResponseBodyLike; readonly state: StreamState } {
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
  responseHeaders: Record<string, string> = {},
): FetchResponseLike {
  return { status, body, headers: headers(responseHeaders) };
}

interface Capture {
  calls: number;
  url?: string;
  init?: CodexRefreshRequestInit;
}

function seamFor(
  result: FetchResponseLike | Promise<FetchResponseLike>,
): { readonly fetch: CodexRefreshFetchSeam; readonly capture: Capture } {
  const capture: Capture = { calls: 0 };
  return {
    capture,
    fetch: (url, init): Promise<FetchResponseLike> => {
      capture.calls += 1;
      capture.url = url;
      capture.init = init;
      return Promise.resolve(result);
    },
  };
}

function run(
  fetch: CodexRefreshFetchSeam,
  extra: {
    readonly signal?: AbortSignal;
    readonly now?: () => number;
    readonly timeoutMs?: number;
    readonly maxResponseBytes?: number;
  } = {},
): Promise<CodexRefreshResult> {
  return refreshCodexOAuth({
    refreshToken: REFRESH,
    signal: extra.signal ?? new AbortController().signal,
    fetch,
    now: extra.now ?? (() => NOW),
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
    ...(extra.maxResponseBytes === undefined ? {} : { maxResponseBytes: extra.maxResponseBytes }),
  });
}

function assertError(result: CodexRefreshResult): void {
  assert.deepEqual(result, { outcome: "error" });
}

function assertValueFree(result: CodexRefreshResult): void {
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(REFRESH), false);
  assert.equal(serialized.includes(ACCESS), false);
  assert.equal(serialized.includes(ROTATED_REFRESH), false);
}

test("issues exactly one approved manual POST with refresh credentials only in its JSON body", async () => {
  const payload = {
    access_token: ACCESS,
    refresh_token: ROTATED_REFRESH,
    expires_in: 3_600,
    id_token: "synthetic-ignored-id-token-not-real",
    unknown: "ignored",
  };
  const { fetch, capture } = seamFor(response(200, stream([encode(JSON.stringify(payload))]).body));

  const result = await run(fetch);

  assert.deepEqual(result, {
    outcome: "ok",
    credential: { access: ACCESS, refresh: ROTATED_REFRESH, expires: NOW + 3_600_000 },
  });
  assert.equal(capture.calls, 1);
  assert.equal(capture.url, CODEX_OAUTH_TOKEN_ENDPOINT);
  assert.equal(capture.url?.includes(REFRESH), false);
  assert.equal(capture.init?.method, "POST");
  assert.equal(capture.init?.redirect, "manual");
  assert.equal(capture.init?.signal.aborted, false);
  assert.deepEqual(capture.init?.headers, {
    "Content-Type": "application/json",
    "User-Agent": CODEX_USAGE_USER_AGENT,
  });
  assert.deepEqual(JSON.parse(capture.init?.body ?? ""), {
    client_id: CODEX_OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: REFRESH,
  });
});

test("accepts a fresh access token without optional rotation or expiry and ignores id_token", async () => {
  const { fetch, capture } = seamFor(
    response(201, stream([encode(JSON.stringify({ access_token: ACCESS, id_token: REFRESH }))]).body),
  );

  const result = await run(fetch);

  assert.deepEqual(result, { outcome: "ok", credential: { access: ACCESS } });
  assert.equal(capture.calls, 1);
});

test("maps OAuth rejection statuses and manual login redirects to auth-needed without reading bodies", async () => {
  for (const status of [400, 401, 403, 301, 302, 303, 307, 308]) {
    const source = stream([encode(JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH }))]);
    const { fetch, capture } = seamFor(response(status, source.body));

    const result = await run(fetch);

    assert.deepEqual(result, { outcome: "auth-needed" });
    assert.equal(capture.calls, 1);
    assert.equal(source.state.reads.value, 0);
    assert.equal(source.state.cancels.value, 1);
    assertValueFree(result);
  }
});

test("keeps all non-auth HTTP, network, missing, malformed, and oversized failures constant and value-free", async () => {
  const malformedResponses: readonly FetchResponseLike[] = [
    response(429, stream([encode(`{"error":"${REFRESH}"}`)]).body),
    response(500, stream([encode(`{"error":"${REFRESH}"}`)]).body),
    response(200, null),
    response(200, stream([new Uint8Array([0xff])]).body),
    response(200, stream([encode("not json")]).body),
    response(200, stream([encode(JSON.stringify({ refresh_token: REFRESH }))]).body),
    response(200, stream([encode(JSON.stringify({ access_token: `${ACCESS}\n` }))]).body),
    response(200, stream([encode(JSON.stringify({ access_token: ACCESS, expires_in: 0 }))]).body),
    response(200, stream([encode(JSON.stringify({ access_token: ACCESS, expires_in: Number.MAX_VALUE }))]).body),
  ];
  for (const item of malformedResponses) {
    const { fetch, capture } = seamFor(item);
    const result = await run(fetch);
    assertError(result);
    assert.equal(capture.calls, 1);
    assertValueFree(result);
  }

  const rejected: CodexRefreshFetchSeam = () =>
    Promise.reject(new Error(`synthetic refresh network failure ${REFRESH} ${ACCESS}`));
  const network = await run(rejected);
  assertError(network);
  assertValueFree(network);

  const declared = stream([encode(JSON.stringify({ access_token: ACCESS }))]);
  const oversized = await run(
    seamFor(response(200, declared.body, { "content-length": "9" })).fetch,
    { maxResponseBytes: 8 },
  );
  assertError(oversized);
  assert.equal(declared.state.reads.value, 0);
  assert.equal(declared.state.cancels.value, 1);
});

test("cancels abnormal streamed responses and uses the injected bounds before a second call is possible", async () => {
  const overflow = stream([new Uint8Array(5), new Uint8Array(5)]);
  const { fetch, capture } = seamFor(response(200, overflow.body));
  const result = await run(fetch, { maxResponseBytes: 8 });
  assertError(result);
  assert.equal(capture.calls, 1);
  assert.equal(overflow.state.cancels.value, 1);

  const controller = new AbortController();
  controller.abort();
  const preAborted = seamFor(response(200, stream([encode("{}")]).body));
  const aborted = await run(preAborted.fetch, { signal: controller.signal });
  assertError(aborted);
  assert.equal(preAborted.capture.calls, 0);

  const timeout: CodexRefreshFetchSeam = (_url, init) =>
    new Promise<FetchResponseLike>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error(`timeout ${REFRESH}`)), { once: true });
    });
  const timedOut = await run(timeout, { timeoutMs: 1 });
  assertError(timedOut);
  assertValueFree(timedOut);
});

test("rejects invalid configuration, clock values, and expiry overflow without a fetch retry", async () => {
  for (const extra of [
    { timeoutMs: 0 },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { maxResponseBytes: 0 },
    { maxResponseBytes: CODEX_REFRESH_DEFAULT_MAX_RESPONSE_BYTES + 1 },
    { now: () => Number.NaN },
  ]) {
    const candidate = seamFor(response(200, stream([encode("{}")]).body));
    const result = await run(candidate.fetch, extra);
    assertError(result);
    assert.equal(candidate.capture.calls, 0);
  }

  const expiring = seamFor(
    response(200, stream([encode(JSON.stringify({ access_token: ACCESS, expires_in: 1 }))]).body),
  );
  const overflow = await run(expiring.fetch, { now: () => Number.MAX_VALUE });
  assertError(overflow);
  assert.equal(expiring.capture.calls, 1);
});
