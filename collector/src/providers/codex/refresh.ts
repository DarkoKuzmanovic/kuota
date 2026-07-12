/** OpenAI Codex's public OAuth client identifier; it is not a secret. */
import { CODEX_USAGE_USER_AGENT } from "./fetch.js";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann" as const;
export const CODEX_OAUTH_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token" as const;
export const CODEX_REFRESH_DEFAULT_TIMEOUT_MS = 15_000;
export const CODEX_REFRESH_DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
export const CODEX_REFRESH_MAX_TIMEOUT_MS = 30_000;

const AUTH_REDIRECT_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface CodexRefreshRequestInit {
  readonly method: "POST";
  readonly headers: {
    readonly "Content-Type": "application/json";
    readonly "User-Agent": typeof CODEX_USAGE_USER_AGENT;
  };
  readonly body: string;
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

export type CodexRefreshFetchSeam = (
  url: string,
  init: CodexRefreshRequestInit,
) => Promise<FetchResponseLike>;

export type CodexRefreshClock = () => number;

/** Fresh internal credential material for the later auth persistence boundary. */
export interface CodexRefreshedCredential {
  readonly access: string;
  readonly refresh?: string;
  readonly expires?: number;
}

export type CodexRefreshResult =
  | { readonly outcome: "ok"; readonly credential: CodexRefreshedCredential }
  | { readonly outcome: "auth-needed" }
  | { readonly outcome: "error" };

export interface CodexRefreshOptions {
  readonly refreshToken: string;
  readonly signal: AbortSignal;
  readonly fetch?: CodexRefreshFetchSeam;
  readonly now?: CodexRefreshClock;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const AUTH_NEEDED_RESULT: CodexRefreshResult = { outcome: "auth-needed" };
const ERROR_RESULT: CodexRefreshResult = { outcome: "error" };

const defaultFetchSeam: CodexRefreshFetchSeam = async (url, init) => {
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
 * Performs exactly one bounded OAuth refresh request. It does not retry, read or
 * persist auth state, invoke usage transports, or expose request/response values.
 */
export async function refreshCodexOAuth(
  options: CodexRefreshOptions,
): Promise<CodexRefreshResult> {
  const timeoutMs = options.timeoutMs ?? CODEX_REFRESH_DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? CODEX_REFRESH_DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !isNonEmptyControlFreeString(options.refreshToken) ||
    !isPositiveSafeInteger(timeoutMs) ||
    timeoutMs > CODEX_REFRESH_MAX_TIMEOUT_MS ||
    !isPositiveSafeInteger(maxResponseBytes) ||
    maxResponseBytes > CODEX_REFRESH_DEFAULT_MAX_RESPONSE_BYTES ||
    options.signal.aborted
  ) return ERROR_RESULT;

  let observedNow: number;
  try {
    observedNow = (options.now ?? Date.now)();
  } catch {
    return ERROR_RESULT;
  }
  if (!Number.isFinite(observedNow)) return ERROR_RESULT;

  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort();
  options.signal.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const init: CodexRefreshRequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": CODEX_USAGE_USER_AGENT,
      },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: options.refreshToken,
      }),
      redirect: "manual",
      signal: controller.signal,
    };

    let response: FetchResponseLike;
    try {
      response = await (options.fetch ?? defaultFetchSeam)(CODEX_OAUTH_TOKEN_ENDPOINT, init);
    } catch {
      return ERROR_RESULT;
    }

    if (controller.signal.aborted) {
      await cancelResponseBodyQuietly(response);
      return ERROR_RESULT;
    }
    const status = readStatus(response);
    if (status === undefined) {
      await cancelResponseBodyQuietly(response);
      return ERROR_RESULT;
    }
    if (status >= 200 && status < 300) {
      return handleSuccess(response, maxResponseBytes, controller.signal, observedNow);
    }

    await cancelResponseBodyQuietly(response);
    if (status === 400 || status === 401 || status === 403 || AUTH_REDIRECT_CODES.has(status)) {
      return AUTH_NEEDED_RESULT;
    }
    return ERROR_RESULT;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abortFromCaller);
  }
}

async function handleSuccess(
  response: FetchResponseLike,
  cap: number,
  signal: AbortSignal,
  observedNow: number,
): Promise<CodexRefreshResult> {
  if (isOversizedContentLength(getHeader(response, "content-length"), cap)) {
    await cancelResponseBodyQuietly(response);
    return ERROR_RESULT;
  }
  const body = safeBody(response);
  if (!isBodyLike(body)) return ERROR_RESULT;

  const read = await readBody(body, cap, signal);
  if (read === undefined) return ERROR_RESULT;
  const text = decodeUtf8(read);
  if (text === undefined) return ERROR_RESULT;
  const parsed = parseJson(text);
  if (parsed === undefined) return ERROR_RESULT;
  return parseRefreshPayload(parsed, observedNow) ?? ERROR_RESULT;
}

async function readBody(
  body: ResponseBodyLike,
  cap: number,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  let reader: ResponseBodyReaderLike;
  try {
    const candidate = body.getReader();
    if (!isReaderLike(candidate)) return undefined;
    reader = candidate;
  } catch {
    return undefined;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (signal.aborted) break;
      if (chunk.done === true) {
        complete = true;
        break;
      }
      const bytes = copyGenuineBytes(chunk.value, cap - total);
      if (bytes === undefined || bytes.byteLength === 0) break;
      total += bytes.byteLength;
      chunks.push(bytes);
    }
  } catch {
    // All body-read failures remain indistinguishable and value-free.
  }

  if (!complete) {
    await cancelQuietly(reader);
    return undefined;
  }
  return concatChunks(chunks, total);
}

function parseRefreshPayload(input: unknown, observedNow: number): CodexRefreshResult | undefined {
  if (!isPlainRecord(input)) return undefined;
  const access = ownValue(input, "access_token");
  if (!isNonEmptyControlFreeString(access)) return undefined;

  const refresh = ownValue(input, "refresh_token");
  if (refresh !== undefined && !isNonEmptyControlFreeString(refresh)) return undefined;

  const expiresIn = ownValue(input, "expires_in");
  let expires: number | undefined;
  if (expiresIn !== undefined) {
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      return undefined;
    }
    const milliseconds = expiresIn * 1_000;
    if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > Number.MAX_VALUE - Math.abs(observedNow)) {
      return undefined;
    }
    expires = observedNow + milliseconds;
    if (!Number.isFinite(expires)) return undefined;
  }

  return {
    outcome: "ok",
    credential: {
      access,
      ...(refresh === undefined ? {} : { refresh }),
      ...(expires === undefined ? {} : { expires }),
    },
  };
}

function readStatus(response: FetchResponseLike): number | undefined {
  try {
    const status: unknown = response.status;
    return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
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
    // Cleanup is best-effort and must not expose response content.
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
    // Cancellation failures are deliberately ignored.
  }
}

function copyGenuineBytes(value: unknown, maxBytes: number): Uint8Array | undefined {
  if (!(value instanceof Uint8Array)) return undefined;
  const length: unknown = value.byteLength;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length <= 0 || length > maxBytes) {
    return undefined;
  }
  const out = new Uint8Array(length);
  out.set(value);
  return out;
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

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.length === 0 ? undefined : text;
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function ownValue(input: Record<string, unknown>, key: string): unknown | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

function isNonEmptyControlFreeString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !CONTROL_CHARS.test(value);
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
}
