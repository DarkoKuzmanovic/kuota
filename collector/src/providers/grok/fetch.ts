import type { GrokCredential } from "./auth.js";

export const GROK_BILLING_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/billing" as const;
export const GROK_BILLING_WEEKLY_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/billing?format=credits" as const;
export const GROK_DEFAULT_TIMEOUT_MS = 15_000;
export const GROK_MAX_TIMEOUT_MS = 30_000;
export const GROK_DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
export const GROK_TOKEN_AUTH_HEADER_VALUE = "xai-grok-cli" as const;

export interface GrokUsageRequestInit {
  readonly method: "GET";
  readonly headers: Record<string, string>;
  readonly redirect: "manual";
  readonly signal: AbortSignal;
}

export interface GrokBodyReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  cancel?(reason?: unknown): Promise<void> | void;
}

export interface GrokResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: { getReader(): GrokBodyReader } | null;
}

export type GrokUsageFetchSeam = (url: string, init: GrokUsageRequestInit) => Promise<GrokResponse>;

export interface GrokUsageFetchOkValue {
  readonly monthly: unknown;
  readonly weekly?: unknown;
}

export type GrokFetchResult =
  | { readonly outcome: "ok"; readonly value: GrokUsageFetchOkValue }
  | { readonly outcome: "auth-needed" }
  | { readonly outcome: "error"; readonly reason: "invalid-config" | "transport" | "aborted" | "timeout" | "http-status" | "oversized-response" | "malformed-response" };

export interface GrokUsageFetchOptions {
  readonly credential: GrokCredential;
  readonly signal: AbortSignal;
  readonly fetch?: GrokUsageFetchSeam;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const redirects = new Set([301, 302, 303, 307, 308]);

const defaultFetch: GrokUsageFetchSeam = async (url, init) => {
  const response = await fetch(url, init);
  const nativeBody = response.body;
  return {
    status: response.status,
    headers: { get: (name: string) => response.headers.get(name) },
    body: nativeBody === null ? null : {
      getReader: () => {
        const reader = nativeBody.getReader();
        return {
          read: () => reader.read(),
          cancel: (reason?: unknown) => reader.cancel(reason),
        };
      },
    },
  };
};

function error(reason: Extract<GrokFetchResult, { readonly outcome: "error" }>["reason"]): GrokFetchResult {
  return { outcome: "error", reason };
}

type ReadJsonResult =
  | { readonly outcome: "ok"; readonly value: unknown }
  | { readonly outcome: "error"; readonly reason: "aborted" | "oversized-response" | "malformed-response" };

function readError(reason: "aborted" | "oversized-response" | "malformed-response"): ReadJsonResult {
  return { outcome: "error", reason };
}

type FetchJsonResult =
  | { readonly outcome: "ok"; readonly value: unknown }
  | { readonly outcome: "auth-needed" }
  | { readonly outcome: "error"; readonly reason: Extract<GrokFetchResult, { readonly outcome: "error" }>['reason'] };

function validPositive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

async function cancel(response: GrokResponse): Promise<void> {
  try {
    const reader = response.body?.getReader();
    await reader?.cancel?.();
  } catch {
    /* cleanup is best effort */
  }
}

async function readJson(response: GrokResponse, cap: number, signal: AbortSignal): Promise<ReadJsonResult> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > cap) {
    await cancel(response);
    return readError("oversized-response");
  }

  let reader: GrokBodyReader;
  try {
    if (response.body === null) return readError("malformed-response");
    reader = response.body.getReader();
  } catch {
    return readError("malformed-response");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel?.();
        return readError("aborted");
      }
      const chunk = await reader.read();
      if (signal.aborted) {
        await reader.cancel?.();
        return readError("aborted");
      }
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength === 0) {
        await reader.cancel?.();
        return readError("malformed-response");
      }
      if (chunk.value.byteLength > cap - total) {
        await reader.cancel?.();
        return readError("oversized-response");
      }
      total += chunk.value.byteLength;
      chunks.push(new Uint8Array(chunk.value));
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length === 0) return readError("malformed-response");
    try {
      return { outcome: "ok", value: JSON.parse(text) as unknown };
    } catch {
      return readError("malformed-response");
    }
  } catch {
    await reader.cancel?.();
    return signal.aborted ? readError("aborted") : readError("malformed-response");
  }
}

function requestHeaders(credential: GrokCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.value}`,
    "x-xai-token-auth": GROK_TOKEN_AUTH_HEADER_VALUE,
    Accept: "application/json",
  };
}

async function fetchJson(
  url: string,
  options: GrokUsageFetchOptions,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<FetchJsonResult> {
  const fetch = options.fetch ?? defaultFetch;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: requestHeaders(options.credential),
      redirect: "manual",
      signal,
    });
    if (signal.aborted) {
      await cancel(response);
      return error("aborted");
    }
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      await cancel(response);
      return error("malformed-response");
    }
    if (response.status >= 200 && response.status < 300) {
      const result = await readJson(response, maxResponseBytes, signal);
      if (result.outcome !== "ok") return result;
      return { outcome: "ok", value: result.value };
    }
    await cancel(response);
    if (response.status === 401 || response.status === 403 || redirects.has(response.status)) {
      return { outcome: "auth-needed" };
    }
    return error("http-status");
  } catch {
    return signal.aborted ? error("aborted") : error("transport");
  }
}

/** Performs bounded native requests; monthly is required, weekly is best-effort. */
export async function fetchGrokUsage(options: GrokUsageFetchOptions): Promise<GrokFetchResult> {
  const timeoutMs = options.timeoutMs ?? GROK_DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? GROK_DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !validPositive(timeoutMs) ||
    timeoutMs > GROK_MAX_TIMEOUT_MS ||
    !validPositive(maxResponseBytes) ||
    maxResponseBytes > GROK_DEFAULT_MAX_RESPONSE_BYTES
  ) {
    return error("invalid-config");
  }
  if (options.signal.aborted) return error("aborted");

  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const monthlyResult = await fetchJson(GROK_BILLING_ENDPOINT, options, controller.signal, maxResponseBytes);
    if (monthlyResult.outcome !== "ok") {
      // A timeout abort can surface as "aborted" or as a downstream error (e.g.
      // malformed-response from a truncated stream); the timeout is the root cause.
      if (monthlyResult.outcome === "error" && timedOut) {
        return error("timeout");
      }
      return monthlyResult;
    }

    const weeklyResult = await fetchJson(GROK_BILLING_WEEKLY_ENDPOINT, options, controller.signal, maxResponseBytes);
    if (weeklyResult.outcome === "ok") {
      return {
        outcome: "ok",
        value: { monthly: monthlyResult.value, weekly: weeklyResult.value },
      };
    }
    // Weekly is best-effort; its failure does not invalidate monthly.
    return { outcome: "ok", value: { monthly: monthlyResult.value } };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
  }
}
