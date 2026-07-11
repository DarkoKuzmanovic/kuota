import type { ClaudeOAuthCredential } from "./auth.js";
import {
  parseClaudeUsageResponse,
  type ClaudeUsageSuccessRecord,
} from "./usage.js";

/**
 * Provider-specific, bounded Claude OAuth usage fetch.
 *
 * This module owns exactly one thing: turning an already-classified OAuth
 * credential into either a validated {@link ClaudeUsageSuccessRecord} or a
 * constant, value-free classification (auth-needed / rate-limited / error). It
 * performs no caching, no auth-file access, no registry wiring, and no timeout
 * management — the collector orchestration (M1) owns the timeout and passes the
 * native {@link AbortSignal}. The access token enters only the injected
 * request's `Authorization` header; it never appears in the URL, the result,
 * a thrown value, or any diagnostic surface.
 *
 * All external I/O flows through a narrow structural seam so tests never need a
 * real `Response`. Production defaults to the global `fetch` and stays
 * Node >= 20 compatible.
 */

// ---------------------------------------------------------------------------
// Request contract (mirrors the proven pi-hud Anthropic usage request)
// ---------------------------------------------------------------------------

/** The Anthropic OAuth usage endpoint. */
export const CLAUDE_USAGE_ENDPOINT =
  "https://api.anthropic.com/api/oauth/usage" as const;

/** User-Agent presented to the usage endpoint. */
export const CLAUDE_USAGE_USER_AGENT = "claude-code/2.0.31" as const;

/** Anthropic beta header required by the OAuth usage endpoint. */
export const CLAUDE_USAGE_ANTHROPIC_BETA = "oauth-2025-04-20" as const;

/**
 * Conservative default streamed-body cap (256 KiB). The usage document is a
 * few hundred bytes; anything larger is rejected as oversized.
 */
export const CLAUDE_DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

/** Minimum 429 backoff (5 minutes). Never retry sooner, whatever the header. */
export const CLAUDE_MIN_BACKOFF_MS = 5 * 60_000;

/** Documented maximum 429 backoff (24 hours). Caps absurd Retry-After values. */
export const CLAUDE_MAX_BACKOFF_MS = 24 * 60 * 60_000;

/** Manual-redirect status codes that mean "the session needs to log in". */
const AUTH_REDIRECT_CODES: ReadonlySet<number> = new Set([302, 303, 307, 308]);

// ---------------------------------------------------------------------------
// Structural fetch seam
// ---------------------------------------------------------------------------

/** The only request shape this module issues. */
export interface ClaudeUsageRequestInit {
  readonly method: "GET";
  readonly headers: Record<string, string>;
  readonly redirect: "manual";
  readonly signal: AbortSignal;
}

/** One chunk yielded by a body reader. */
export interface BodyReadChunk {
  readonly done: boolean;
  readonly value?: Uint8Array;
}

/** A minimal streaming body reader. */
export interface ResponseBodyReaderLike {
  read(): Promise<BodyReadChunk>;
  cancel?(reason?: unknown): Promise<void> | void;
}

/** A minimal readable body. */
export interface ResponseBodyLike {
  getReader(): ResponseBodyReaderLike;
}

/** A minimal header accessor. */
export interface ResponseHeadersLike {
  get(name: string): string | null;
}

/** The minimal response surface this module reads. */
export interface FetchResponseLike {
  readonly status: number;
  readonly headers: ResponseHeadersLike;
  readonly body: ResponseBodyLike | null;
}

/** The injected fetch boundary. Production defaults to the global `fetch`. */
export type ClaudeUsageFetchSeam = (
  url: string,
  init: ClaudeUsageRequestInit,
) => Promise<FetchResponseLike>;

/** Injected epoch-millisecond clock. */
export type ClaudeFetchClock = () => number;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Constant, value-free status text for each outcome. */
export const CLAUDE_FETCH_STATUS_TEXT = {
  ok: "Usage updated",
  authNeeded: "Authentication required",
  rateLimited: "Rate limited",
  error: "Provider unavailable",
} as const;

export const CLAUDE_FETCH_AUTH_NEEDED_REASONS = [
  "unauthorized",
  "login-redirect",
] as const;

export type ClaudeFetchAuthNeededReason =
  (typeof CLAUDE_FETCH_AUTH_NEEDED_REASONS)[number];

export const CLAUDE_FETCH_ERROR_REASONS = [
  "invalid-config",
  "transport",
  "aborted",
  "http-status",
  "oversized-response",
  "malformed-response",
] as const;

export type ClaudeFetchErrorReason =
  (typeof CLAUDE_FETCH_ERROR_REASONS)[number];

export type ClaudeFetchResult =
  | {
      readonly outcome: "ok";
      readonly status: typeof CLAUDE_FETCH_STATUS_TEXT.ok;
      readonly record: ClaudeUsageSuccessRecord;
    }
  | {
      readonly outcome: "auth-needed";
      readonly reason: ClaudeFetchAuthNeededReason;
      readonly status: typeof CLAUDE_FETCH_STATUS_TEXT.authNeeded;
    }
  | {
      readonly outcome: "rate-limited";
      readonly retryAfterMs: number;
      readonly retryAt: string;
      readonly status: typeof CLAUDE_FETCH_STATUS_TEXT.rateLimited;
    }
  | {
      readonly outcome: "error";
      readonly reason: ClaudeFetchErrorReason;
      readonly status: typeof CLAUDE_FETCH_STATUS_TEXT.error;
    };

export interface ClaudeUsageFetchOptions {
  /** Already-classified OAuth credential; only its access token is sent. */
  readonly credential: ClaudeOAuthCredential;
  /** Native cancellation signal owned by the collector orchestration. */
  readonly signal: AbortSignal;
  /** Fetch seam; defaults to the global `fetch`. */
  readonly fetch?: ClaudeUsageFetchSeam;
  /** Epoch-millisecond clock; defaults to `Date.now`. */
  readonly now?: ClaudeFetchClock;
  /** Streamed-body cap in bytes; defaults to {@link CLAUDE_DEFAULT_MAX_RESPONSE_BYTES}. */
  readonly maxResponseBytes?: number;
}

// ---------------------------------------------------------------------------
// Default production seam
// ---------------------------------------------------------------------------

const defaultFetchSeam: ClaudeUsageFetchSeam = async (url, init) => {
  const response = await fetch(url, init);
  const nativeBody = response.body;
  const body: ResponseBodyLike | null =
    nativeBody === null
      ? null
      : {
          getReader(): ResponseBodyReaderLike {
            const reader = nativeBody.getReader();
            return {
              read: () => reader.read(),
              cancel: (reason?: unknown) => reader.cancel(reason),
            };
          },
        };
  return {
    status: response.status,
    headers: {
      get: (name: string): string | null => response.headers.get(name),
    },
    body,
  };
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Fetches and classifies Claude OAuth usage. The returned value is always one
 * of the four total outcomes; no code path throws a raw value, and no branch
 * carries a body, header, token, or native error.
 */
export async function fetchClaudeUsage(
  options: ClaudeUsageFetchOptions,
): Promise<ClaudeFetchResult> {
  const { credential, signal } = options;
  const fetchSeam = options.fetch ?? defaultFetchSeam;
  const clock = options.now ?? Date.now;
  const cap = options.maxResponseBytes ?? CLAUDE_DEFAULT_MAX_RESPONSE_BYTES;

  // Validate the byte cap before any request.
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    return errorResult("invalid-config");
  }

  // Validate the clock and derive a deterministic observation timestamp before
  // any request, so an unusable clock can never reach the network.
  let now: number;
  try {
    now = clock();
  } catch {
    return errorResult("invalid-config");
  }
  if (typeof now !== "number" || !Number.isFinite(now)) {
    return errorResult("invalid-config");
  }
  const observedAt = toIsoTimestamp(now);
  if (observedAt === undefined) {
    return errorResult("invalid-config");
  }

  // An already-aborted signal must never reach the fetch seam.
  if (signal.aborted) {
    return errorResult("aborted");
  }

  const init: ClaudeUsageRequestInit = {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": CLAUDE_USAGE_USER_AGENT,
      Authorization: `Bearer ${credential.access}`,
      "anthropic-beta": CLAUDE_USAGE_ANTHROPIC_BETA,
    },
    redirect: "manual",
    signal,
  };

  let response: FetchResponseLike;
  try {
    response = await fetchSeam(CLAUDE_USAGE_ENDPOINT, init);
  } catch {
    // Never inspect the rejected value; classify from the signal only.
    return signal.aborted ? errorResult("aborted") : errorResult("transport");
  }

  const status = readStatus(response);
  if (status === undefined) {
    return errorResult("malformed-response");
  }

  if (status >= 200 && status < 300) {
    return handleSuccess(response, cap, observedAt, signal);
  }
  if (status === 401 || status === 403) {
    return authNeededResult("unauthorized");
  }
  if (AUTH_REDIRECT_CODES.has(status)) {
    return authNeededResult("login-redirect");
  }
  if (status === 429) {
    return rateLimitedResult(response, now);
  }
  // Any other 3xx/4xx/5xx: no body is read.
  return errorResult("http-status");
}

// ---------------------------------------------------------------------------
// 2xx handling
// ---------------------------------------------------------------------------

async function handleSuccess(
  response: FetchResponseLike,
  cap: number,
  observedAt: string,
  signal: AbortSignal,
): Promise<ClaudeFetchResult> {
  // Reject an oversized declared length before reading a single byte.
  if (isOversizedContentLength(getHeader(response, "content-length"), cap)) {
    return errorResult("oversized-response");
  }

  const body = safeBody(response);
  if (!isBodyLike(body)) {
    return errorResult("malformed-response");
  }

  const read = await readBody(body, cap, signal);
  if (read.kind === "oversized") {
    return errorResult("oversized-response");
  }
  if (read.kind === "aborted") {
    return errorResult("aborted");
  }
  if (read.kind === "malformed") {
    return errorResult("malformed-response");
  }

  const text = decodeUtf8(read.bytes);
  if (text === undefined) {
    return errorResult("malformed-response");
  }

  const parsedJson = parseJson(text);
  if (!parsedJson.ok) {
    return errorResult("malformed-response");
  }

  const parsed = parseClaudeUsageResponse(parsedJson.value, observedAt);
  if (!parsed.ok) {
    return errorResult("malformed-response");
  }
  return {
    outcome: "ok",
    status: CLAUDE_FETCH_STATUS_TEXT.ok,
    record: parsed.record,
  };
}

type BodyReadOutcome =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "oversized" }
  | { readonly kind: "malformed" }
  | { readonly kind: "aborted" };

async function readBody(
  body: ResponseBodyLike,
  cap: number,
  signal: AbortSignal,
): Promise<BodyReadOutcome> {
  let reader: ResponseBodyReaderLike;
  try {
    const candidate = body.getReader();
    if (!isReaderLike(candidate)) {
      return { kind: "malformed" };
    }
    reader = candidate;
  } catch {
    return { kind: "malformed" };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let outcome: BodyReadOutcome | undefined;

  while (outcome === undefined) {
    if (signal.aborted) {
      outcome = { kind: "aborted" };
      break;
    }
    let chunk: BodyReadChunk;
    try {
      chunk = await reader.read();
    } catch {
      outcome = signal.aborted ? { kind: "aborted" } : { kind: "malformed" };
      break;
    }
    // A custom reader may resolve normally after cancellation instead of rejecting.
    // Re-check after every awaited read so orchestration cancellation still wins.
    if (signal.aborted) {
      outcome = { kind: "aborted" };
      break;
    }
    if (chunk === null || typeof chunk !== "object") {
      outcome = { kind: "malformed" };
      break;
    }
    // The remaining byte budget bounds this chunk. A claimed byteLength above
    // it is rejected inside the snapshot before any allocation or copy runs, so
    // a hostile huge (yet safe-integer) length can never force a large buffer.
    const snapshot = snapshotChunk(chunk, cap - total);
    if (snapshot.kind === "hostile") {
      // A throwing getter or proxy trap encountered while snapshotting `done`,
      // `value`, or the byte payload never propagates as a raw value: aborted
      // when the signal fired, otherwise malformed.
      outcome = signal.aborted ? { kind: "aborted" } : { kind: "malformed" };
      break;
    }
    if (snapshot.kind === "oversized") {
      outcome = { kind: "oversized" };
      break;
    }
    if (snapshot.kind === "done") {
      outcome = { kind: "bytes", bytes: concatChunks(chunks, total) };
      break;
    }
    // A data chunk must make progress toward the byte cap. Rejecting an empty
    // non-terminal chunk prevents a hostile reader from keeping this invocation
    // alive forever without consuming any of the bounded response budget.
    if (snapshot.bytes.byteLength === 0) {
      outcome = { kind: "malformed" };
      break;
    }
    // `snapshot.bytes` is a fresh, genuine copy whose byteLength was bounded by
    // the remaining budget above, so this addition can reach cap but never pass
    // it. The exact `total === cap` boundary is intentionally accepted.
    total += snapshot.bytes.byteLength;
    chunks.push(snapshot.bytes);
  }

  // Cancel on every abnormal exit; a fully drained stream needs no cancel.
  if (outcome.kind !== "bytes") {
    await cancelQuietly(reader);
  }
  return outcome;
}

/**
 * The result of snapshotting one hostile-provided chunk. `data` always carries a
 * fresh, genuine {@link Uint8Array} copy — never the caller's object. `oversized`
 * means the chunk's claimed byte length exceeded the remaining budget and was
 * rejected before any allocation or copy ran.
 */
type ChunkSnapshot =
  | { readonly kind: "done" }
  | { readonly kind: "data"; readonly bytes: Uint8Array }
  | { readonly kind: "oversized" }
  | { readonly kind: "hostile" };

/**
 * Total a chunk into a fresh, trusted copy without trusting any getter, proxy
 * trap, or `instanceof` result. Reading `done`, `value`, the byte length, or the
 * bytes themselves is fully guarded: any throw maps to `hostile`, and the caller
 * decides whether an aborted signal reclassifies that as aborted vs malformed.
 * `maxBytes` is the remaining response budget; a claimed length above it yields
 * `oversized` before allocating or copying, so a hostile huge (yet safe-integer)
 * byteLength can never force a large allocation or run a copy trap.
 */
function snapshotChunk(chunk: BodyReadChunk, maxBytes: number): ChunkSnapshot {
  try {
    if (chunk.done === true) {
      return { kind: "done" };
    }
    const copied = copyGenuineBytes(chunk.value, maxBytes);
    if (copied.kind === "invalid") {
      return { kind: "hostile" };
    }
    if (copied.kind === "oversized") {
      return { kind: "oversized" };
    }
    return { kind: "data", bytes: copied.bytes };
  } catch {
    return { kind: "hostile" };
  }
}

/**
 * The outcome of copying a purported {@link Uint8Array} into a fresh buffer:
 * `bytes` on success, `oversized` when the claimed length exceeds the remaining
 * budget, or `invalid` when the value is not usable byte data.
 */
type GenuineBytesResult =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "oversized" }
  | { readonly kind: "invalid" };

/**
 * Copy a purported {@link Uint8Array} into a fresh, genuine buffer. `instanceof`
 * alone is not trusted: a Proxy over a typed array passes it, so the byte length
 * is snapshotted and validated as a safe non-negative integer. A claimed length
 * above `maxBytes` (the remaining response budget) returns `oversized` before any
 * allocation or copy, so a hostile huge byteLength cannot force a large buffer or
 * run an index/copy trap. Within budget, the bytes are copied through a genuine
 * destination so hostile length or index traps surface as thrown errors for the
 * caller's guard to catch.
 */
function copyGenuineBytes(value: unknown, maxBytes: number): GenuineBytesResult {
  if (!(value instanceof Uint8Array)) {
    return { kind: "invalid" };
  }
  const length: unknown = value.byteLength;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    return { kind: "invalid" };
  }
  // Reject a claimed length beyond the remaining budget before allocating or
  // copying, so a hostile huge (yet safe-integer) byteLength can neither force a
  // large allocation nor trip a copy/index trap.
  if (length > maxBytes) {
    return { kind: "oversized" };
  }
  // Allocating a genuine destination bounds the length to real memory and gives
  // a trap-free copy target.
  const out = new Uint8Array(length);
  // `out.set` reads the source through [[Get]] for a proxied value, so any
  // index or length trap throws and is caught by the caller.
  out.set(value);
  return { kind: "bytes", bytes: out };
}

// ---------------------------------------------------------------------------
// 429 handling
// ---------------------------------------------------------------------------

function rateLimitedResult(
  response: FetchResponseLike,
  now: number,
): ClaudeFetchResult {
  const retryAfterMs = computeRetryAfterMs(
    getHeader(response, "retry-after"),
    now,
  );
  const retryAt = toIsoTimestamp(now + retryAfterMs);
  if (retryAt === undefined) {
    // Only reachable with an astronomically extreme clock; degrade safely.
    return errorResult("malformed-response");
  }
  return {
    outcome: "rate-limited",
    status: CLAUDE_FETCH_STATUS_TEXT.rateLimited,
    retryAfterMs,
    retryAt,
  };
}

/**
 * Resolves the effective backoff. A valid future Retry-After is honored but
 * clamped to [{@link CLAUDE_MIN_BACKOFF_MS}, {@link CLAUDE_MAX_BACKOFF_MS}];
 * a missing, invalid, past, or zero value uses the minimum.
 */
function computeRetryAfterMs(
  headerValue: string | undefined,
  now: number,
): number {
  const raw = parseRetryAfter(headerValue, now);
  if (raw === undefined) {
    return CLAUDE_MIN_BACKOFF_MS;
  }
  return Math.min(Math.max(raw, CLAUDE_MIN_BACKOFF_MS), CLAUDE_MAX_BACKOFF_MS);
}

/**
 * Parses Retry-After as strict integer seconds or an HTTP-date, returning a
 * non-negative millisecond delay (possibly `Infinity` for absurd values, which
 * the caller clamps) or `undefined` when unparseable.
 */
function parseRetryAfter(
  headerValue: string | undefined,
  now: number,
): number | undefined {
  if (headerValue === undefined) {
    return undefined;
  }
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  // Strict integer seconds — reject `parseInt`-style trailing junk.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const ms = seconds * 1000;
    return Number.isNaN(ms) ? undefined : ms;
  }
  // HTTP-date form, resolved against the injected clock.
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - now;
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Hostile-safe response readers
// ---------------------------------------------------------------------------

function readStatus(response: FetchResponseLike): number | undefined {
  try {
    const status: unknown = response.status;
    // Accept only integer HTTP status codes in the 100..599 range; a
    // fractional or out-of-range value is treated as a malformed response.
    return typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
      ? status
      : undefined;
  } catch {
    return undefined;
  }
}

function safeBody(response: FetchResponseLike): unknown {
  try {
    return response.body;
  } catch {
    return undefined;
  }
}

function getHeader(
  response: FetchResponseLike,
  name: string,
): string | undefined {
  try {
    const headers: unknown = response.headers;
    if (headers === null || typeof headers !== "object") {
      return undefined;
    }
    const getter = (headers as { get?: unknown }).get;
    if (typeof getter !== "function") {
      return undefined;
    }
    const value: unknown = getter.call(headers, name);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function isOversizedContentLength(
  value: string | undefined,
  cap: number,
): boolean {
  if (value === undefined) {
    return false;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    // Non-numeric declared length is ignored; the stream cap still enforces.
    return false;
  }
  const declared = Number(trimmed);
  if (!Number.isFinite(declared)) {
    return true;
  }
  return declared > cap;
}

function isBodyLike(value: unknown): value is ResponseBodyLike {
  try {
    if (value === null || typeof value !== "object") {
      return false;
    }
    return typeof (value as { getReader?: unknown }).getReader === "function";
  } catch {
    return false;
  }
}

function isReaderLike(value: unknown): value is ResponseBodyReaderLike {
  try {
    if (value === null || typeof value !== "object") {
      return false;
    }
    return typeof (value as { read?: unknown }).read === "function";
  } catch {
    return false;
  }
}

async function cancelQuietly(reader: ResponseBodyReaderLike): Promise<void> {
  try {
    const cancel = reader.cancel;
    if (typeof cancel !== "function") {
      return;
    }
    const result: unknown = cancel.call(reader);
    if (isThenable(result)) {
      await result;
    }
  } catch {
    // Cancellation failures are non-fatal and must not leak a late rejection.
  }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const text = decoder.decode(bytes);
    return text.length === 0 ? undefined : text;
  } catch {
    return undefined;
  }
}

function parseJson(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toIsoTimestamp(ms: number): string | undefined {
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function authNeededResult(
  reason: ClaudeFetchAuthNeededReason,
): ClaudeFetchResult {
  return {
    outcome: "auth-needed",
    reason,
    status: CLAUDE_FETCH_STATUS_TEXT.authNeeded,
  };
}

function errorResult(reason: ClaudeFetchErrorReason): ClaudeFetchResult {
  return {
    outcome: "error",
    reason,
    status: CLAUDE_FETCH_STATUS_TEXT.error,
  };
}
