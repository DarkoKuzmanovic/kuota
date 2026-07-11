import assert from "node:assert/strict";
import test from "node:test";

import { scanForSecrets } from "../../../src/security/redact.js";
import type { ClaudeOAuthCredential } from "../../../src/providers/claude/auth.js";
import {
  CLAUDE_DEFAULT_MAX_RESPONSE_BYTES,
  CLAUDE_FETCH_STATUS_TEXT,
  CLAUDE_MAX_BACKOFF_MS,
  CLAUDE_MIN_BACKOFF_MS,
  CLAUDE_USAGE_ANTHROPIC_BETA,
  CLAUDE_USAGE_ENDPOINT,
  CLAUDE_USAGE_USER_AGENT,
  fetchClaudeUsage,
  type BodyReadChunk,
  type ClaudeFetchClock,
  type ClaudeFetchErrorReason,
  type ClaudeFetchResult,
  type ClaudeUsageFetchSeam,
  type ClaudeUsageRequestInit,
  type FetchResponseLike,
  type ResponseBodyLike,
  type ResponseBodyReaderLike,
  type ResponseHeadersLike,
} from "../../../src/providers/claude/fetch.js";

// ---------------------------------------------------------------------------
// Synthetic constants
// ---------------------------------------------------------------------------

/** Synthetic OAuth token. Deliberately does not match any credential pattern. */
const TOKEN = "synthetic-oauth-access-value-001-not-real";
const CREDENTIAL: ClaudeOAuthCredential = { access: TOKEN };

const OBSERVED_AT = "2026-07-11T10:00:00.000Z";
const FIXED_MS = Date.parse(OBSERVED_AT);
const SESSION_RESET = "2026-07-11T15:00:00.000Z";
const WEEKLY_RESET = "2026-07-18T10:00:00.000Z";

const fixedNow: ClaudeFetchClock = () => FIXED_MS;

const USAGE_JSON = {
  five_hour: { utilization: 25.5, resets_at: SESSION_RESET },
  seven_day: { utilization: 40, resets_at: WEEKLY_RESET },
};

const EXPECTED_WINDOWS = [
  {
    id: "session",
    label: "Session (5-hour)",
    usedPercent: 25.5,
    resetAt: SESSION_RESET,
  },
  { id: "weekly-all", label: "Weekly (all)", usedPercent: 40, resetAt: WEEKLY_RESET },
];

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function splitBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.byteLength; i += size) {
    chunks.push(bytes.subarray(i, Math.min(i + size, bytes.byteLength)));
  }
  return chunks;
}

function fakeHeaders(map: Record<string, string> = {}): ResponseHeadersLike {
  const lower = new Map<string, string>();
  for (const [key, value] of Object.entries(map)) {
    lower.set(key.toLowerCase(), value);
  }
  return {
    get(name: string): string | null {
      return lower.get(name.toLowerCase()) ?? null;
    },
  };
}

interface StreamState {
  getReader: number;
  read: number;
  cancel: number;
}

interface StreamOptions {
  readonly getReaderThrows?: unknown;
  readonly rejectReadOnCall?: number;
  readonly readRejection?: unknown;
  readonly cancelThrows?: unknown;
  readonly cancelReturnsRejecting?: boolean;
  readonly omitCancel?: boolean;
  readonly hostileChunk?: unknown;
}

function makeStream(
  chunks: readonly Uint8Array[],
  options: StreamOptions = {},
): { body: ResponseBodyLike; state: StreamState } {
  const state: StreamState = { getReader: 0, read: 0, cancel: 0 };
  const body: ResponseBodyLike = {
    getReader(): ResponseBodyReaderLike {
      state.getReader += 1;
      if (options.getReaderThrows !== undefined) {
        throw options.getReaderThrows;
      }
      let index = 0;
      let hostileSent = false;
      const reader: ResponseBodyReaderLike = {
        async read(): Promise<BodyReadChunk> {
          state.read += 1;
          if (options.rejectReadOnCall === state.read) {
            throw options.readRejection ?? new Error("synthetic read failure");
          }
          if (options.hostileChunk !== undefined && !hostileSent) {
            hostileSent = true;
            return { done: false, value: options.hostileChunk as unknown as Uint8Array };
          }
          if (index < chunks.length) {
            const value = chunks[index];
            index += 1;
            if (value === undefined) {
              return { done: true };
            }
            return { done: false, value };
          }
          return { done: true };
        },
      };
      if (!options.omitCancel) {
        reader.cancel = (): Promise<void> | void => {
          state.cancel += 1;
          if (options.cancelThrows !== undefined) {
            throw options.cancelThrows;
          }
          if (options.cancelReturnsRejecting) {
            return Promise.reject(new Error("synthetic cancel rejection"));
          }
          return undefined;
        };
      }
      return reader;
    },
  };
  return { body, state };
}

function usageStream(
  payload: unknown = USAGE_JSON,
  chunkSize?: number,
): { body: ResponseBodyLike; state: StreamState } {
  const bytes = encode(JSON.stringify(payload));
  const chunks = chunkSize === undefined ? [bytes] : splitBytes(bytes, chunkSize);
  return makeStream(chunks);
}

function makeResponse(
  status: number,
  headers: Record<string, string> = {},
  body: ResponseBodyLike | null = null,
): FetchResponseLike {
  return { status, headers: fakeHeaders(headers), body };
}

interface SeamCapture {
  calls: number;
  url?: string;
  init?: ClaudeUsageRequestInit;
}

function recordingSeam(
  handler: (
    url: string,
    init: ClaudeUsageRequestInit,
  ) => Promise<FetchResponseLike>,
): { seam: ClaudeUsageFetchSeam; capture: SeamCapture } {
  const capture: SeamCapture = { calls: 0 };
  const seam: ClaudeUsageFetchSeam = (url, init) => {
    capture.calls += 1;
    capture.url = url;
    capture.init = init;
    return handler(url, init);
  };
  return { seam, capture };
}

function respondWith(
  response: FetchResponseLike,
): { seam: ClaudeUsageFetchSeam; capture: SeamCapture } {
  return recordingSeam(() => Promise.resolve(response));
}

function rejectWith(
  error: unknown,
): { seam: ClaudeUsageFetchSeam; capture: SeamCapture } {
  return recordingSeam(() => Promise.reject(error));
}

function runFetch(
  seam: ClaudeUsageFetchSeam,
  extra: {
    signal?: AbortSignal;
    now?: ClaudeFetchClock;
    maxResponseBytes?: number;
    credential?: ClaudeOAuthCredential;
  } = {},
): Promise<ClaudeFetchResult> {
  return fetchClaudeUsage({
    credential: extra.credential ?? CREDENTIAL,
    signal: extra.signal ?? new AbortController().signal,
    fetch: seam,
    now: extra.now ?? fixedNow,
    ...(extra.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: extra.maxResponseBytes }),
  });
}

function assertError(
  result: ClaudeFetchResult,
  reason: ClaudeFetchErrorReason,
): void {
  assert.equal(result.outcome, "error");
  if (result.outcome === "error") {
    assert.equal(result.reason, reason);
    assert.equal(result.status, CLAUDE_FETCH_STATUS_TEXT.error);
  }
}

function assertNoToken(result: ClaudeFetchResult): void {
  assert.deepEqual(scanForSecrets(result), []);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
}

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

test("issues the exact GET request contract with the token only in Authorization", async () => {
  const controller = new AbortController();
  const { seam, capture } = respondWith(makeResponse(200, {}, usageStream().body));

  const result = await runFetch(seam, { signal: controller.signal });

  assert.equal(result.outcome, "ok");
  assert.equal(capture.calls, 1);
  assert.equal(capture.url, CLAUDE_USAGE_ENDPOINT);
  assert.equal(capture.init?.method, "GET");
  assert.equal(capture.init?.redirect, "manual");
  assert.equal(capture.init?.signal, controller.signal);
  assert.deepEqual(capture.init?.headers, {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "User-Agent": CLAUDE_USAGE_USER_AGENT,
    Authorization: `Bearer ${TOKEN}`,
    "anthropic-beta": CLAUDE_USAGE_ANTHROPIC_BETA,
  });
  // The endpoint URL never carries the token.
  assert.equal(capture.url?.includes(TOKEN), false);
});

test("exposes the documented request-contract constants", () => {
  assert.equal(CLAUDE_USAGE_ENDPOINT, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(CLAUDE_USAGE_USER_AGENT, "claude-code/2.0.31");
  assert.equal(CLAUDE_USAGE_ANTHROPIC_BETA, "oauth-2025-04-20");
  assert.equal(CLAUDE_MIN_BACKOFF_MS, 5 * 60_000);
  assert.equal(CLAUDE_MAX_BACKOFF_MS, 24 * 60 * 60_000);
  assert.equal(CLAUDE_DEFAULT_MAX_RESPONSE_BYTES, 256 * 1024);
});

// ---------------------------------------------------------------------------
// Success normalization + deterministic observedAt
// ---------------------------------------------------------------------------

test("normalizes a legacy-window 2xx body into a validated ok record", async () => {
  const { seam } = respondWith(makeResponse(200, {}, usageStream().body));
  const result = await runFetch(seam);

  assert.equal(result.outcome, "ok");
  if (result.outcome !== "ok") return;
  assert.equal(result.status, CLAUDE_FETCH_STATUS_TEXT.ok);
  assert.deepEqual(result.record, {
    id: "claude",
    state: "ok",
    lastSuccessAt: OBSERVED_AT,
    windows: EXPECTED_WINDOWS,
  });
  assertNoToken(result);
});

test("normalizes a current limits[] 2xx body into a validated ok record", async () => {
  const payload = {
    limits: [
      { kind: "session", utilization: 12, resets_at: SESSION_RESET },
      { kind: "weekly_all", utilization: 34, resets_at: WEEKLY_RESET },
      {
        kind: "weekly_scoped",
        utilization: 8,
        scope: { model: { id: "synthetic-opus-id", display_name: "Synthetic Opus" } },
      },
    ],
  };
  const { seam } = respondWith(makeResponse(200, {}, usageStream(payload).body));
  const result = await runFetch(seam);

  assert.equal(result.outcome, "ok");
  if (result.outcome !== "ok") return;
  assert.deepEqual(result.record.windows, [
    { id: "session", label: "Session (5-hour)", usedPercent: 12, resetAt: SESSION_RESET },
    { id: "weekly-all", label: "Weekly (all)", usedPercent: 34, resetAt: WEEKLY_RESET },
    { id: "weekly-synthetic-opus", label: "Weekly Synthetic Opus", usedPercent: 8 },
  ]);
  assertNoToken(result);
});

test("stamps a deterministic observedAt from the injected clock", async () => {
  const alt = "2026-07-11T18:45:30.000Z";
  const { seam } = respondWith(makeResponse(200, {}, usageStream().body));
  const result = await runFetch(seam, { now: () => Date.parse(alt) });

  assert.equal(result.outcome, "ok");
  if (result.outcome !== "ok") return;
  assert.equal(result.record.lastSuccessAt, alt);
});

test("reassembles a body streamed as many small partial chunks", async () => {
  const { seam } = respondWith(makeResponse(200, {}, usageStream(USAGE_JSON, 3).body));
  const result = await runFetch(seam);

  assert.equal(result.outcome, "ok");
  if (result.outcome !== "ok") return;
  assert.deepEqual(result.record.windows, EXPECTED_WINDOWS);
});

test("reassembles a multibyte character split across chunk boundaries", async () => {
  const payload = { ...USAGE_JSON, note: "caf\u00e9-\u2603" };
  // size 1 guarantees the 2- and 3-byte sequences are split across chunks.
  const { seam } = respondWith(makeResponse(200, {}, usageStream(payload, 1).body));
  const result = await runFetch(seam);

  assert.equal(result.outcome, "ok");
  if (result.outcome !== "ok") return;
  assert.deepEqual(result.record.windows, EXPECTED_WINDOWS);
  // The forward-compatible field never survives into the normalized record.
  assert.equal(JSON.stringify(result.record).includes("note"), false);
});

// ---------------------------------------------------------------------------
// Status classification
// ---------------------------------------------------------------------------

test("maps 401 and 403 to a constant auth-needed result without reading the body", async () => {
  for (const status of [401, 403]) {
    const { body, state } = makeStream([]);
    const { seam } = respondWith(makeResponse(status, {}, body));
    const result = await runFetch(seam);

    assert.equal(result.outcome, "auth-needed");
    if (result.outcome === "auth-needed") {
      assert.equal(result.reason, "unauthorized");
      assert.equal(result.status, CLAUDE_FETCH_STATUS_TEXT.authNeeded);
    }
    assert.equal(state.getReader, 0);
    assert.equal(state.read, 0);
    assertNoToken(result);
  }
});

test("maps manual auth redirects to a constant auth-needed result without reading the body", async () => {
  for (const status of [302, 303, 307, 308]) {
    const { body, state } = makeStream([]);
    const { seam } = respondWith(makeResponse(status, {}, body));
    const result = await runFetch(seam);

    assert.equal(result.outcome, "auth-needed");
    if (result.outcome === "auth-needed") {
      assert.equal(result.reason, "login-redirect");
    }
    assert.equal(state.getReader, 0);
    assertNoToken(result);
  }
});

test("maps other 3xx/4xx/5xx to a constant http error without reading the body", async () => {
  for (const status of [300, 301, 400, 404, 418, 500, 503]) {
    const { body, state } = makeStream([]);
    const { seam } = respondWith(makeResponse(status, {}, body));
    const result = await runFetch(seam);

    assertError(result, "http-status");
    assert.equal(state.getReader, 0);
    assert.equal(state.read, 0);
    assertNoToken(result);
  }
});

test("maps a fractional or out-of-range HTTP status to malformed without reading the body", async () => {
  for (const status of [
    99,
    600,
    0,
    -1,
    -200,
    700,
    200.5,
    404.9,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    const { body, state } = makeStream([]);
    const { seam } = respondWith(makeResponse(status, {}, body));
    const result = await runFetch(seam);

    assertError(result, "malformed-response");
    assert.equal(state.getReader, 0);
    assert.equal(state.read, 0);
    assertNoToken(result);
  }
});

test("accepts boundary integer statuses 100 and 599 as http errors", async () => {
  for (const status of [100, 599]) {
    const { body, state } = makeStream([]);
    const { seam } = respondWith(makeResponse(status, {}, body));
    assertError(await runFetch(seam), "http-status");
    assert.equal(state.getReader, 0);
  }
});

// ---------------------------------------------------------------------------
// 429 + Retry-After boundaries
// ---------------------------------------------------------------------------

async function rateLimited(
  headers: Record<string, string>,
  now: ClaudeFetchClock = fixedNow,
): Promise<{ result: ClaudeFetchResult; state: StreamState }> {
  const { body, state } = makeStream([]);
  const { seam } = respondWith(makeResponse(429, headers, body));
  const result = await runFetch(seam, { now });
  return { result, state };
}

function assertRateLimited(
  result: ClaudeFetchResult,
  retryAfterMs: number,
  now = FIXED_MS,
): void {
  assert.equal(result.outcome, "rate-limited");
  if (result.outcome !== "rate-limited") return;
  assert.equal(result.status, CLAUDE_FETCH_STATUS_TEXT.rateLimited);
  assert.equal(result.retryAfterMs, retryAfterMs);
  assert.equal(result.retryAt, new Date(now + retryAfterMs).toISOString());
}

test("honors an in-range Retry-After given as integer seconds", async () => {
  const { result, state } = await rateLimited({ "retry-after": "600" });
  assertRateLimited(result, 600_000);
  assert.equal(state.getReader, 0);
  assertNoToken(result);
});

test("clamps a below-minimum Retry-After up to the 5-minute floor", async () => {
  const { result } = await rateLimited({ "retry-after": "60" });
  assertRateLimited(result, CLAUDE_MIN_BACKOFF_MS);
});

test("uses the minimum backoff for a zero, missing, empty, or junk Retry-After", async () => {
  const cases: Record<string, string>[] = [
    { "retry-after": "0" },
    {},
    { "retry-after": "   " },
    { "retry-after": "100abc" },
    { "retry-after": "soon" },
    { "retry-after": "+30" },
  ];
  for (const headers of cases) {
    const { result } = await rateLimited(headers);
    assertRateLimited(result, CLAUDE_MIN_BACKOFF_MS);
  }
});

test("caps an absurd Retry-After at the documented 24-hour maximum", async () => {
  const { result } = await rateLimited({ "retry-after": "999999999999" });
  assertRateLimited(result, CLAUDE_MAX_BACKOFF_MS);
});

test("honors the exact minimum and maximum Retry-After seconds", async () => {
  const min = await rateLimited({ "retry-after": String(CLAUDE_MIN_BACKOFF_MS / 1000) });
  assertRateLimited(min.result, CLAUDE_MIN_BACKOFF_MS);
  const max = await rateLimited({ "retry-after": String(CLAUDE_MAX_BACKOFF_MS / 1000) });
  assertRateLimited(max.result, CLAUDE_MAX_BACKOFF_MS);
});

test("resolves a future HTTP-date Retry-After against the injected clock", async () => {
  const deltaMs = 20 * 60_000;
  const httpDate = new Date(FIXED_MS + deltaMs).toUTCString();
  const { result } = await rateLimited({ "retry-after": httpDate });
  assertRateLimited(result, deltaMs);
});

test("uses the minimum backoff for a past HTTP-date Retry-After", async () => {
  const httpDate = new Date(FIXED_MS - 60_000).toUTCString();
  const { result } = await rateLimited({ "retry-after": httpDate });
  assertRateLimited(result, CLAUDE_MIN_BACKOFF_MS);
});

// ---------------------------------------------------------------------------
// Body size limits
// ---------------------------------------------------------------------------

test("rejects an oversized declared Content-Length before reading the body", async () => {
  const { body, state } = usageStream();
  const { seam } = respondWith(
    makeResponse(200, { "content-length": "999999" }, body),
  );
  const result = await runFetch(seam, { maxResponseBytes: 1024 });

  assertError(result, "oversized-response");
  assert.equal(state.getReader, 0);
  assertNoToken(result);
});

test("ignores a non-numeric Content-Length and relies on the stream cap", async () => {
  const { seam } = respondWith(
    makeResponse(200, { "content-length": "not-a-number" }, usageStream().body),
  );
  const result = await runFetch(seam);
  assert.equal(result.outcome, "ok");
});

test("rejects and cancels when the streamed bytes exceed the cap", async () => {
  const chunk = new Uint8Array(5);
  const { body, state } = makeStream([chunk, chunk, chunk]);
  const { seam } = respondWith(makeResponse(200, {}, body));
  const result = await runFetch(seam, { maxResponseBytes: 8 });

  assertError(result, "oversized-response");
  assert.equal(state.cancel, 1);
});


test("rejects a zero-length data chunk instead of allowing an unbounded read loop", async () => {
  let reads = 0;
  let cancels = 0;
  const body: ResponseBodyLike = {
    getReader: (): ResponseBodyReaderLike => ({
      read: async (): Promise<BodyReadChunk> => {
        reads += 1;
        return reads <= 3
          ? { done: false, value: new Uint8Array(0) }
          : { done: true };
      },
      cancel: async (): Promise<void> => {
        cancels += 1;
      },
    }),
  };
  const { seam } = respondWith(makeResponse(200, {}, body));

  assertError(await runFetch(seam), "malformed-response");
  assert.equal(reads, 1);
  assert.equal(cancels, 1);
});

test("honors an abort that occurs while a custom body read resolves normally", async () => {
  const controller = new AbortController();
  let reads = 0;
  let cancels = 0;
  const body: ResponseBodyLike = {
    getReader: (): ResponseBodyReaderLike => ({
      read: async (): Promise<BodyReadChunk> => {
        reads += 1;
        controller.abort();
        return { done: true };
      },
      cancel: async (): Promise<void> => {
        cancels += 1;
      },
    }),
  };
  const { seam } = respondWith(makeResponse(200, {}, body));

  assertError(await runFetch(seam, { signal: controller.signal }), "aborted");
  assert.equal(reads, 1);
  assert.equal(cancels, 1);
});

test("honors an abort after fetch resolves but before the first body read", async () => {
  const controller = new AbortController();
  let reads = 0;
  let cancels = 0;
  const body: ResponseBodyLike = {
    getReader: (): ResponseBodyReaderLike => ({
      read: async (): Promise<BodyReadChunk> => {
        reads += 1;
        return { done: true };
      },
      cancel: async (): Promise<void> => {
        cancels += 1;
      },
    }),
  };
  const { seam } = recordingSeam(() => {
    controller.abort();
    return Promise.resolve(makeResponse(200, {}, body));
  });

  assertError(await runFetch(seam, { signal: controller.signal }), "aborted");
  assert.equal(reads, 0);
  assert.equal(cancels, 1);
});

test("accepts a valid response whose streamed body and Content-Length exactly equal the cap", async () => {
  const bytes = encode(JSON.stringify(USAGE_JSON));
  const { body } = makeStream([bytes]);
  const { seam } = respondWith(
    makeResponse(200, { "content-length": String(bytes.byteLength) }, body),
  );

  const result = await runFetch(seam, { maxResponseBytes: bytes.byteLength });
  assert.equal(result.outcome, "ok");
});

// ---------------------------------------------------------------------------
// Malformed / empty / bodyless / decode / JSON
// ---------------------------------------------------------------------------

test("maps a null body on a 2xx response to malformed", async () => {
  const { seam } = respondWith(makeResponse(200, {}, null));
  assertError(await runFetch(seam), "malformed-response");
});

test("maps an empty 2xx body to malformed", async () => {
  const { seam } = respondWith(makeResponse(200, {}, makeStream([]).body));
  assertError(await runFetch(seam), "malformed-response");
});

test("maps invalid JSON to malformed", async () => {
  const { seam } = respondWith(
    makeResponse(200, {}, makeStream([encode("not json {")]).body),
  );
  assertError(await runFetch(seam), "malformed-response");
});

test("maps a 2xx body the usage parser rejects to malformed", async () => {
  const { seam } = respondWith(
    makeResponse(200, {}, usageStream({ five_hour: { utilization: 900 } }).body),
  );
  assertError(await runFetch(seam), "malformed-response");
});

test("fatally rejects invalid UTF-8 bytes", async () => {
  const { seam } = respondWith(
    makeResponse(200, {}, makeStream([new Uint8Array([0xff, 0xfe])]).body),
  );
  assertError(await runFetch(seam), "malformed-response");
});

test("fatally rejects a truncated trailing multibyte sequence", async () => {
  const truncated = new Uint8Array([
    ...encode('{"five_hour":{"utilization":1}}'),
    0xc3,
  ]);
  const { seam } = respondWith(makeResponse(200, {}, makeStream([truncated]).body));
  assertError(await runFetch(seam), "malformed-response");
});

// ---------------------------------------------------------------------------
// Abort handling
// ---------------------------------------------------------------------------

test("returns aborted and never calls fetch when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const { seam, capture } = respondWith(makeResponse(200, {}, usageStream().body));

  const result = await runFetch(seam, { signal: controller.signal });

  assertError(result, "aborted");
  assert.equal(capture.calls, 0);
});

test("classifies a fetch rejection as aborted when the signal is aborted", async () => {
  const controller = new AbortController();
  const seam: ClaudeUsageFetchSeam = () => {
    controller.abort();
    return Promise.reject(new Error("synthetic abort"));
  };
  assertError(await runFetch(seam, { signal: controller.signal }), "aborted");
});

test("classifies an abort during the body stream as aborted", async () => {
  const controller = new AbortController();
  const body: ResponseBodyLike = {
    getReader: (): ResponseBodyReaderLike => ({
      read: async (): Promise<BodyReadChunk> => {
        controller.abort();
        throw new Error("synthetic mid-stream abort");
      },
      cancel: async () => undefined,
    }),
  };
  const { seam } = respondWith(makeResponse(200, {}, body));
  assertError(await runFetch(seam, { signal: controller.signal }), "aborted");
});

// ---------------------------------------------------------------------------
// Transport + hostile injections
// ---------------------------------------------------------------------------

test("classifies a plain fetch rejection as transport without inspecting it", async () => {
  const { seam } = rejectWith(new Error(`network exploded with ${TOKEN}`));
  const result = await runFetch(seam);
  assertError(result, "transport");
  assertNoToken(result);
});

test("classifies a hostile rejecting thenable as transport", async () => {
  const seam: ClaudeUsageFetchSeam = () =>
    ({
      then(_resolve: unknown, reject: (reason: unknown) => void): void {
        reject(new Error("synthetic hostile thenable"));
      },
    }) as unknown as Promise<FetchResponseLike>;
  assertError(await runFetch(seam), "transport");
});

test("maps a response with a throwing status getter to malformed", async () => {
  const hostile = {} as { status: number; headers: ResponseHeadersLike; body: null };
  Object.defineProperty(hostile, "status", {
    get() {
      throw new Error("hostile status getter");
    },
  });
  Object.defineProperty(hostile, "headers", { value: fakeHeaders() });
  Object.defineProperty(hostile, "body", { value: null });
  const { seam } = respondWith(hostile);
  assertError(await runFetch(seam), "malformed-response");
});

test("treats a throwing header getter on a 429 as a missing Retry-After", async () => {
  const throwingHeaders: ResponseHeadersLike = {
    get(): string | null {
      throw new Error("hostile header getter");
    },
  };
  const response: FetchResponseLike = {
    status: 429,
    headers: throwingHeaders,
    body: makeStream([]).body,
  };
  const { seam } = respondWith(response);
  assertRateLimited(await runFetch(seam), CLAUDE_MIN_BACKOFF_MS);
});

test("maps a throwing body getter on a 2xx response to malformed", async () => {
  const hostile = { status: 200, headers: fakeHeaders() } as {
    status: number;
    headers: ResponseHeadersLike;
    body: ResponseBodyLike | null;
  };
  Object.defineProperty(hostile, "body", {
    get() {
      throw new Error("hostile body getter");
    },
  });
  const { seam } = respondWith(hostile);
  assertError(await runFetch(seam), "malformed-response");
});

test("maps a throwing getReader to malformed", async () => {
  const { body } = makeStream([], { getReaderThrows: new Error("hostile getReader") });
  const { seam } = respondWith(makeResponse(200, {}, body));
  assertError(await runFetch(seam), "malformed-response");
});

test("maps a non-Uint8Array chunk value to malformed", async () => {
  const { body } = makeStream([], { hostileChunk: { evil: true } });
  const { seam } = respondWith(makeResponse(200, {}, body));
  assertError(await runFetch(seam), "malformed-response");
});

test("maps a rejecting read (no abort) to malformed", async () => {
  const { body } = makeStream([], {
    rejectReadOnCall: 1,
    readRejection: new Error("synthetic read rejection"),
  });
  const { seam } = respondWith(makeResponse(200, {}, body));
  assertError(await runFetch(seam), "malformed-response");
});

// ---------------------------------------------------------------------------
// Hostile chunk snapshots (throwing getters, proxied Uint8Array traps)
// ---------------------------------------------------------------------------

/**
 * A body whose single read resolves with a caller-supplied chunk object, then
 * reports done. `beforeReturn` runs before the chunk is handed back, letting a
 * test abort the signal mid-stream. Cancellation is counted so abnormal exits
 * can be asserted.
 */
function hostileChunkBody(
  makeChunk: () => BodyReadChunk,
  beforeReturn?: () => void,
): { body: ResponseBodyLike; state: StreamState } {
  const state: StreamState = { getReader: 0, read: 0, cancel: 0 };
  const body: ResponseBodyLike = {
    getReader(): ResponseBodyReaderLike {
      state.getReader += 1;
      let sent = false;
      return {
        read(): Promise<BodyReadChunk> {
          state.read += 1;
          if (sent) {
            return Promise.resolve({ done: true });
          }
          sent = true;
          if (beforeReturn !== undefined) {
            beforeReturn();
          }
          return Promise.resolve(makeChunk());
        },
        cancel: (): Promise<void> | void => {
          state.cancel += 1;
          return undefined;
        },
      };
    },
  };
  return { body, state };
}

/** A chunk object whose `done` property throws when read. */
function throwingDoneChunk(message: string): BodyReadChunk {
  const chunk = {} as BodyReadChunk;
  Object.defineProperty(chunk, "done", {
    get(): boolean {
      throw new Error(message);
    },
  });
  return chunk;
}

/** A chunk object whose `value` property throws when read. */
function throwingValueChunk(message: string): BodyReadChunk {
  const chunk = { done: false } as BodyReadChunk;
  Object.defineProperty(chunk, "value", {
    get(): Uint8Array {
      throw new Error(message);
    },
  });
  return chunk;
}

test("maps a throwing chunk done getter to malformed and cancels the reader", async () => {
  const { body, state } = hostileChunkBody(() => throwingDoneChunk("hostile done getter"));
  const { seam } = respondWith(makeResponse(200, {}, body));
  const result = await runFetch(seam);
  assertError(result, "malformed-response");
  assert.equal(state.cancel, 1);
});

test("maps a throwing chunk value getter to malformed and cancels the reader", async () => {
  const { body, state } = hostileChunkBody(() => throwingValueChunk("hostile value getter"));
  const { seam } = respondWith(makeResponse(200, {}, body));
  const result = await runFetch(seam);
  assertError(result, "malformed-response");
  assert.equal(state.cancel, 1);
});

test("maps a throwing chunk getter to aborted when the signal has aborted", async () => {
  const controller = new AbortController();
  const { body } = hostileChunkBody(
    () => throwingDoneChunk("hostile done getter after abort"),
    () => controller.abort(),
  );
  const { seam } = respondWith(makeResponse(200, {}, body));
  assertError(await runFetch(seam, { signal: controller.signal }), "aborted");
});

test("maps a proxied Uint8Array with a throwing byteLength trap to malformed", async () => {
  const real = new Uint8Array([1, 2, 3]);
  const proxy = new Proxy(real, {
    get(target, prop, receiver): unknown {
      if (prop === "byteLength") {
        throw new Error("hostile byteLength trap");
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  assert.equal(proxy instanceof Uint8Array, true);
  const { body, state } = hostileChunkBody(
    () => ({ done: false, value: proxy as unknown as Uint8Array }),
  );
  const { seam } = respondWith(makeResponse(200, {}, body));
  assertError(await runFetch(seam), "malformed-response");
  assert.equal(state.cancel, 1);
});

test("maps a proxied Uint8Array with a throwing copy trap to malformed", async () => {
  const real = new Uint8Array([1, 2, 3]);
  const proxy = new Proxy(real, {
    get(target, prop, receiver): unknown {
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        throw new Error("hostile index trap");
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  assert.equal(proxy instanceof Uint8Array, true);
  const { body, state } = hostileChunkBody(
    () => ({ done: false, value: proxy as unknown as Uint8Array }),
  );
  const { seam } = respondWith(makeResponse(200, {}, body));
  assertError(await runFetch(seam), "malformed-response");
  assert.equal(state.cancel, 1);
});

test("maps a proxied Uint8Array with a fractional byteLength to malformed", async () => {
  const real = new Uint8Array([1, 2, 3]);
  const proxy = new Proxy(real, {
    get(target, prop, receiver): unknown {
      if (prop === "byteLength") {
        return 1.5;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const { body } = hostileChunkBody(
    () => ({ done: false, value: proxy as unknown as Uint8Array }),
  );
  const { seam } = respondWith(makeResponse(200, {}, body));
  assertError(await runFetch(seam), "malformed-response");
});

test("rejects a hostile huge claimed byteLength before allocating or copying", async () => {
  const real = new Uint8Array([1, 2, 3]);
  let copyTrapRuns = 0;
  // A claimed length far above the configured cap, yet a safe integer so the
  // fractional/NaN/negative guards do not reject it first. Allocating a buffer
  // of this size (1 TiB) would exhaust memory; the cap bound must fire earlier.
  const HUGE = 2 ** 40;
  const proxy = new Proxy(real, {
    get(target, prop, receiver): unknown {
      if (prop === "byteLength") {
        return HUGE;
      }
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        // An index read means a copy was attempted — it must never happen.
        copyTrapRuns += 1;
        throw new Error("copy trap must not run");
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  assert.equal(proxy instanceof Uint8Array, true);
  const { body, state } = hostileChunkBody(
    () => ({ done: false, value: proxy as unknown as Uint8Array }),
  );
  const { seam } = respondWith(makeResponse(200, {}, body));
  const result = await runFetch(seam, { maxResponseBytes: 8 });

  // The claimed length exceeds the remaining budget, so it is rejected before
  // any allocation or copy: the index (copy) trap never runs, the result is
  // oversized, and the reader is cancelled on the abnormal exit.
  assertError(result, "oversized-response");
  assert.equal(copyTrapRuns, 0);
  assert.equal(state.cancel, 1);
  assertNoToken(result);
});

test("never leaks a token embedded in a hostile chunk getter", async () => {
  const { body } = hostileChunkBody(() => throwingDoneChunk(`hostile getter ${TOKEN}`));
  const { seam } = respondWith(makeResponse(200, {}, body));
  const result = await runFetch(seam);
  assertError(result, "malformed-response");
  assertNoToken(result);
});

test("does not leak unhandled rejections from hostile chunk snapshots", async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const proxy = new Proxy(new Uint8Array([1, 2, 3]), {
      get(target, prop, receiver): unknown {
        if (prop === "byteLength") {
          throw new Error("hostile byteLength trap");
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const cases: (() => BodyReadChunk)[] = [
      () => throwingDoneChunk("hostile done getter"),
      () => throwingValueChunk("hostile value getter"),
      () => ({ done: false, value: proxy as unknown as Uint8Array }),
    ];
    for (const makeChunk of cases) {
      const { body } = hostileChunkBody(makeChunk);
      assertError(
        await runFetch(respondWith(makeResponse(200, {}, body)).seam),
        "malformed-response",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(rejections, []);
});

// ---------------------------------------------------------------------------
// No unhandled late rejections
// ---------------------------------------------------------------------------

test("does not leak unhandled rejections from cancel or read failures", async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    // Overflow path whose cancel returns a rejecting promise.
    const chunk = new Uint8Array(5);
    const overflow = makeStream([chunk, chunk], { cancelReturnsRejecting: true });
    assertError(
      await runFetch(respondWith(makeResponse(200, {}, overflow.body)).seam, {
        maxResponseBytes: 6,
      }),
      "oversized-response",
    );

    // Overflow path whose cancel throws synchronously.
    const throwing = makeStream([chunk, chunk], {
      cancelThrows: new Error("synthetic cancel throw"),
    });
    assertError(
      await runFetch(respondWith(makeResponse(200, {}, throwing.body)).seam, {
        maxResponseBytes: 6,
      }),
      "oversized-response",
    );

    // Overflow path with no cancel method at all.
    const noCancel = makeStream([chunk, chunk], { omitCancel: true });
    assertError(
      await runFetch(respondWith(makeResponse(200, {}, noCancel.body)).seam, {
        maxResponseBytes: 6,
      }),
      "oversized-response",
    );

    // Let any deferred microtasks/macrotasks settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(rejections, []);
});

// ---------------------------------------------------------------------------
// Cap / clock validation before fetch
// ---------------------------------------------------------------------------

test("rejects an invalid byte cap before calling fetch", async () => {
  for (const cap of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { seam, capture } = respondWith(makeResponse(200, {}, usageStream().body));
    const result = await runFetch(seam, { maxResponseBytes: cap });
    assertError(result, "invalid-config");
    assert.equal(capture.calls, 0);
  }
});

test("rejects an unusable clock before calling fetch", async () => {
  const clocks: ClaudeFetchClock[] = [
    () => {
      throw new Error("synthetic clock failure");
    },
    () => Number.NaN,
    () => Number.POSITIVE_INFINITY,
    () => Number.NEGATIVE_INFINITY,
  ];
  for (const now of clocks) {
    const { seam, capture } = respondWith(makeResponse(200, {}, usageStream().body));
    const result = await runFetch(seam, { now });
    assertError(result, "invalid-config");
    assert.equal(capture.calls, 0);
  }
});

// ---------------------------------------------------------------------------
// Secret safety across every outcome surface
// ---------------------------------------------------------------------------

test("keeps the token out of every outcome and its stringified form", async () => {
  const scenarios: ClaudeUsageFetchSeam[] = [
    respondWith(makeResponse(200, {}, usageStream().body)).seam,
    respondWith(makeResponse(401, {}, makeStream([]).body)).seam,
    respondWith(makeResponse(429, { "retry-after": "600" }, makeStream([]).body)).seam,
    respondWith(makeResponse(500, {}, makeStream([]).body)).seam,
    rejectWith(new Error(`boom ${TOKEN}`)).seam,
  ];
  for (const seam of scenarios) {
    assertNoToken(await runFetch(seam));
  }
});
