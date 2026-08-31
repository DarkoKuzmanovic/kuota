import type { CommandCodeCredential } from "./auth.js";

export const COMMANDCODE_CREDITS_ENDPOINT = "https://api.commandcode.ai/alpha/billing/credits" as const;
export const COMMANDCODE_SUBSCRIPTION_ENDPOINT = "https://api.commandcode.ai/alpha/billing/subscriptions" as const;
export const COMMANDCODE_DEFAULT_TIMEOUT_MS = 15_000;
export const COMMANDCODE_MAX_TIMEOUT_MS = 30_000;
export const COMMANDCODE_DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

export interface CommandCodeUsageRequestInit {
  readonly method: "GET";
  readonly headers: Record<string, string>;
  readonly redirect: "manual";
  readonly signal: AbortSignal;
}
export interface CommandCodeBodyReader { read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>; cancel?(reason?: unknown): Promise<void> | void; }
export interface CommandCodeResponse { readonly status: number; readonly headers: { get(name: string): string | null }; readonly body: { getReader(): CommandCodeBodyReader } | null; }
export type CommandCodeUsageFetchSeam = (url: string, init: CommandCodeUsageRequestInit) => Promise<CommandCodeResponse>;
export type CommandCodeFetchResult =
  | { readonly outcome: "ok"; readonly value: unknown }
  | { readonly outcome: "auth-needed" }
  | { readonly outcome: "error"; readonly reason: "invalid-config" | "transport" | "aborted" | "timeout" | "http-status" | "oversized-response" | "malformed-response" };
export interface CommandCodeUsageFetchOptions {
  readonly credential: CommandCodeCredential;
  readonly signal: AbortSignal;
  readonly endpoint?: string;
  readonly fetch?: CommandCodeUsageFetchSeam;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const redirects = new Set([301, 302, 303, 307, 308]);

const defaultFetch: CommandCodeUsageFetchSeam = async (url, init) => {
  const response = await fetch(url, init);
  const nativeBody = response.body;
  return {
    status: response.status,
    headers: { get: (name: string) => response.headers.get(name) },
    body: nativeBody === null ? null : { getReader: () => {
      const reader = nativeBody.getReader();
      return { read: () => reader.read(), cancel: (reason?: unknown) => reader.cancel(reason) };
    } },
  };
};

function error(reason: Extract<CommandCodeFetchResult, { readonly outcome: "error" }> ["reason"]): CommandCodeFetchResult {
  return { outcome: "error", reason };
}
function validPositive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
async function cancel(response: CommandCodeResponse): Promise<void> {
  try { const reader = response.body?.getReader(); await reader?.cancel?.(); } catch { /* cleanup is best effort */ }
}
async function readJson(response: CommandCodeResponse, cap: number, signal: AbortSignal): Promise<CommandCodeFetchResult> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > cap) { await cancel(response); return error("oversized-response"); }
  let reader: CommandCodeBodyReader;
  try { if (response.body === null) return error("malformed-response"); reader = response.body.getReader(); } catch { return error("malformed-response"); }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) { await reader.cancel?.(); return error("aborted"); }
      const chunk = await reader.read();
      if (signal.aborted) { await reader.cancel?.(); return error("aborted"); }
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength === 0) { await reader.cancel?.(); return error("malformed-response"); }
      if (chunk.value.byteLength > cap - total) { await reader.cancel?.(); return error("oversized-response"); }
      total += chunk.value.byteLength;
      chunks.push(new Uint8Array(chunk.value));
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length === 0) return error("malformed-response");
    try { return { outcome: "ok", value: JSON.parse(text) as unknown }; } catch { return error("malformed-response"); }
  } catch { await reader.cancel?.(); return signal.aborted ? error("aborted") : error("malformed-response"); }
}

/** Performs exactly one bounded native request; it has no retry or persistence policy. */
export async function fetchCommandCodeJson(options: CommandCodeUsageFetchOptions): Promise<CommandCodeFetchResult> {
  const timeoutMs = options.timeoutMs ?? COMMANDCODE_DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? COMMANDCODE_DEFAULT_MAX_RESPONSE_BYTES;
  const endpoint = options.endpoint ?? COMMANDCODE_CREDITS_ENDPOINT;
  if (!validPositive(timeoutMs) || timeoutMs > COMMANDCODE_MAX_TIMEOUT_MS || !validPositive(maxResponseBytes) || maxResponseBytes > COMMANDCODE_DEFAULT_MAX_RESPONSE_BYTES) return error("invalid-config");
  if (options.signal.aborted) return error("aborted");
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    let response: CommandCodeResponse;
    try {
      response = await (options.fetch ?? defaultFetch)(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${options.credential.value}`, Accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch { return controller.signal.aborted ? error(timedOut ? "timeout" : "aborted") : error("transport"); }
    if (controller.signal.aborted) { await cancel(response); return error(timedOut ? "timeout" : "aborted"); }
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) { await cancel(response); return error("malformed-response"); }
    if (response.status >= 200 && response.status < 300) {
      const result = await readJson(response, maxResponseBytes, controller.signal);
      return controller.signal.aborted ? error(timedOut ? "timeout" : "aborted") : result;
    }
    await cancel(response);
    if (response.status === 401 || response.status === 403 || redirects.has(response.status)) return { outcome: "auth-needed" };
    return error("http-status");
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
  }
}
