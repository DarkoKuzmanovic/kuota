import type { CodexOAuthCredential } from "./auth.js";

/** Owner-approved native Codex usage endpoint. */
export const CODEX_USAGE_ENDPOINT =
  "https://chatgpt.com/backend-api/wham/usage" as const;

/** The browser-style identity proven by pi-hud's Codex transport. */
export const CODEX_USAGE_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" as const;

/** A usage document is small; streamed responses may never exceed this cap. */
export const CODEX_DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

/** Native transport wall-clock budget. */
export const CODEX_DEFAULT_TIMEOUT_MS = 15_000;

/** Prevent a caller-provided timeout from creating an unbounded request. */
export const CODEX_MAX_TIMEOUT_MS = 30_000;

const AUTH_REDIRECT_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export interface CodexUsageRequestInit {
  readonly method: "GET";
  readonly headers: Record<string, string>;
  readonly redirect: "manual";
  readonly signal: AbortSignal;
}

export interface BodyReadChunk {
  readonly done: boolean;
  readonly value?: Uint8Array;
}

export interface ResponseBodyReaderLike {
  read(): Promise<BodyReadChunk>;
  cancel?(reason?: unknown): Promise<void> | void;
}

export interface ResponseBodyLike {
  getReader(): ResponseBodyReaderLike;
}

export interface ResponseHeadersLike {
  get(name: string): string | null;
}

export interface FetchResponseLike {
  readonly status: number;
  readonly headers: ResponseHeadersLike;
  readonly body: ResponseBodyLike | null;
}

export type CodexUsageFetchSeam = (
  url: string,
  init: CodexUsageRequestInit,
) => Promise<FetchResponseLike>;

export const CODEX_FETCH_ERROR_REASONS = [
  "invalid-config",
  "transport",
  "aborted",
  "timeout",
  "http-status",
  "oversized-response",
  "malformed-response",
] as const;

export type CodexFetchErrorReason = (typeof CODEX_FETCH_ERROR_REASONS)[number];

/**
 * The native transport has no provider-specific interpretation of a successful
 * document. It passes only a parsed `unknown` value to M3.2; it never returns
 * the raw response text, headers, credentials, status code, or native errors.
 */
export type CodexFetchResult =
  | { readonly outcome: "ok"; readonly value: unknown }
  | { readonly outcome: "curl-eligible" }
  | { readonly outcome: "auth-needed" }
  | { readonly outcome: "error"; readonly reason: CodexFetchErrorReason };

export interface CodexUsageFetchOptions {
  readonly credential: CodexOAuthCredential;
  readonly signal: AbortSignal;
  readonly fetch?: CodexUsageFetchSeam;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const defaultFetchSeam: CodexUsageFetchSeam = async (url, init) => {
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
    headers: { get: (name: string): string | null => response.headers.get(name) },
    body,
  };
};

/**
 * Performs one bounded native request. This layer deliberately does not invoke
 * curl, refresh credentials, read or write auth state, parse usage fields, or
 * retry. Only an actual native 401/403 gives the later curl layer eligibility.
 */
export async function fetchCodexUsage(
  options: CodexUsageFetchOptions,
): Promise<CodexFetchResult> {
  const timeoutMs = options.timeoutMs ?? CODEX_DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? CODEX_DEFAULT_MAX_RESPONSE_BYTES;
  if (!isPositiveSafeInteger(timeoutMs) || timeoutMs > CODEX_MAX_TIMEOUT_MS) {
    return errorResult("invalid-config");
  }
  if (
    !isPositiveSafeInteger(maxResponseBytes) ||
    maxResponseBytes > CODEX_DEFAULT_MAX_RESPONSE_BYTES
  ) return errorResult("invalid-config");
  if (options.signal.aborted) return errorResult("aborted");

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = (): void => controller.abort();
  options.signal.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const init: CodexUsageRequestInit = {
      method: "GET",
      headers: {
        Authorization: `Bearer ${options.credential.access}`,
        "chatgpt-account-id": options.credential.accountId,
        "OpenAI-Beta": "responses=experimental",
        "User-Agent": CODEX_USAGE_USER_AGENT,
      },
      redirect: "manual",
      signal: controller.signal,
    };

    let response: FetchResponseLike;
    try {
      response = await (options.fetch ?? defaultFetchSeam)(CODEX_USAGE_ENDPOINT, init);
    } catch {
      return classifyAbort(controller.signal, timedOut, "transport");
    }

    if (controller.signal.aborted) return abortResult(timedOut);
    const status = readStatus(response);
    if (status === undefined) {
      await cancelResponseBodyQuietly(response);
      return errorResult("malformed-response");
    }
    if (status >= 200 && status < 300) {
      const result = await handleSuccess(response, maxResponseBytes, controller.signal, timedOut);
      return controller.signal.aborted ? abortResult(timedOut) : result;
    }
    await cancelResponseBodyQuietly(response);
    if (status === 401 || status === 403) return { outcome: "curl-eligible" };
    if (AUTH_REDIRECT_CODES.has(status)) return { outcome: "auth-needed" };
    return errorResult("http-status");
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abortFromCaller);
  }
}

async function handleSuccess(
  response: FetchResponseLike,
  cap: number,
  signal: AbortSignal,
  timedOut: boolean,
): Promise<CodexFetchResult> {
  if (isOversizedContentLength(getHeader(response, "content-length"), cap)) {
    await cancelResponseBodyQuietly(response);
    return errorResult("oversized-response");
  }
  const body = safeBody(response);
  if (!isBodyLike(body)) return errorResult("malformed-response");

  const read = await readBody(body, cap, signal);
  if (read.kind === "aborted") return abortResult(timedOut);
  if (read.kind === "oversized") return errorResult("oversized-response");
  if (read.kind === "malformed") return errorResult("malformed-response");

  const text = decodeUtf8(read.bytes);
  if (text === undefined) return errorResult("malformed-response");
  const parsed = parseJson(text);
  return parsed.ok ? { outcome: "ok", value: parsed.value } : errorResult("malformed-response");
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
    if (!isReaderLike(candidate)) return { kind: "malformed" };
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
    if (signal.aborted) {
      outcome = { kind: "aborted" };
      break;
    }
    const snapshot = snapshotChunk(chunk, cap - total);
    if (snapshot.kind === "hostile") {
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
    if (snapshot.bytes.byteLength === 0) {
      outcome = { kind: "malformed" };
      break;
    }
    total += snapshot.bytes.byteLength;
    chunks.push(snapshot.bytes);
  }

  if (outcome.kind !== "bytes") await cancelQuietly(reader);
  return outcome;
}

type ChunkSnapshot =
  | { readonly kind: "done" }
  | { readonly kind: "data"; readonly bytes: Uint8Array }
  | { readonly kind: "oversized" }
  | { readonly kind: "hostile" };

function snapshotChunk(chunk: BodyReadChunk, maxBytes: number): ChunkSnapshot {
  try {
    if (chunk.done === true) return { kind: "done" };
    const copied = copyGenuineBytes(chunk.value, maxBytes);
    if (copied.kind === "invalid") return { kind: "hostile" };
    if (copied.kind === "oversized") return { kind: "oversized" };
    return { kind: "data", bytes: copied.bytes };
  } catch {
    return { kind: "hostile" };
  }
}

type GenuineBytesResult =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "oversized" }
  | { readonly kind: "invalid" };

function copyGenuineBytes(value: unknown, maxBytes: number): GenuineBytesResult {
  if (!(value instanceof Uint8Array)) return { kind: "invalid" };
  const length: unknown = value.byteLength;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    return { kind: "invalid" };
  }
  if (length > maxBytes) return { kind: "oversized" };
  const out = new Uint8Array(length);
  out.set(value);
  return { kind: "bytes", bytes: out };
}

function readStatus(response: FetchResponseLike): number | undefined {
  try {
    const status: unknown = response.status;
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

function getHeader(response: FetchResponseLike, name: string): string | undefined {
  try {
    const headers: unknown = response.headers;
    if (headers === null || typeof headers !== "object") return undefined;
    const getter = (headers as { get?: unknown }).get;
    if (typeof getter !== "function") return undefined;
    const value: unknown = getter.call(headers, name);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function cancelResponseBodyQuietly(response: FetchResponseLike): Promise<void> {
  const body = safeBody(response);
  if (!isBodyLike(body)) return;
  try {
    const reader = body.getReader();
    if (!isReaderLike(reader)) return;
    await cancelQuietly(reader);
  } catch {
    // Response cleanup is best-effort and must remain value-free.
  }
}

function isOversizedContentLength(value: string | undefined, cap: number): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  const declared = Number(trimmed);
  return !Number.isFinite(declared) || declared > cap;
}

function isBodyLike(value: unknown): value is ResponseBodyLike {
  try {
    return value !== null &&
      typeof value === "object" &&
      typeof (value as { getReader?: unknown }).getReader === "function";
  } catch {
    return false;
  }
}

function isReaderLike(value: unknown): value is ResponseBodyReaderLike {
  try {
    return value !== null &&
      typeof value === "object" &&
      typeof (value as { read?: unknown }).read === "function";
  } catch {
    return false;
  }
}

async function cancelQuietly(reader: ResponseBodyReaderLike): Promise<void> {
  try {
    const cancel = reader.cancel;
    if (typeof cancel !== "function") return;
    const result: unknown = cancel.call(reader);
    if (isThenable(result)) await result;
  } catch {
    // A cancellation error is deliberately terminal and value-free.
  }
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.length === 0 ? undefined : text;
  } catch {
    return undefined;
  }
}

function parseJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
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

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function classifyAbort(
  signal: AbortSignal,
  timedOut: boolean,
  fallback: CodexFetchErrorReason,
): CodexFetchResult {
  return signal.aborted ? abortResult(timedOut) : errorResult(fallback);
}

function abortResult(timedOut: boolean): CodexFetchResult {
  return errorResult(timedOut ? "timeout" : "aborted");
}

function errorResult(reason: CodexFetchErrorReason): CodexFetchResult {
  return { outcome: "error", reason };
}
