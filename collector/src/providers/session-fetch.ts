// One bounded cookie-authenticated JSON GET for the browser-session providers
// (Mistral, OpenDesign). Same policy as the Cursor/OpenCode fetchers: no retries,
// no redirects followed, capped body, timeout, value-free outcomes.

export const SESSION_DEFAULT_TIMEOUT_MS = 15_000;
export const SESSION_MAX_RESPONSE_BYTES = 256 * 1024;

export interface SessionRequestInit {
  readonly method: "GET";
  readonly headers: Record<string, string>;
  readonly redirect: "manual";
  readonly signal: AbortSignal;
}
export interface SessionBodyReader { read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>; cancel?(reason?: unknown): Promise<void> | void; }
export interface SessionResponse { readonly status: number; readonly headers: { get(name: string): string | null }; readonly body: { getReader(): SessionBodyReader } | null; }
export type SessionFetchSeam = (url: string, init: SessionRequestInit) => Promise<SessionResponse>;
export type SessionFetchResult =
  | { readonly outcome: "ok"; readonly value: unknown }
  | { readonly outcome: "auth-needed" }
  | { readonly outcome: "error"; readonly reason: "transport" | "aborted" | "timeout" | "http-status" | "oversized-response" | "malformed-response" };

export interface SessionFetchOptions {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
  readonly fetch?: SessionFetchSeam;
  readonly timeoutMs?: number;
}

const redirects = new Set([301, 302, 303, 307, 308]);

const defaultFetch: SessionFetchSeam = async (url, init) => {
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

function error(reason: Extract<SessionFetchResult, { readonly outcome: "error" }>["reason"]): SessionFetchResult {
  return { outcome: "error", reason };
}
async function cancel(response: SessionResponse): Promise<void> {
  try { await response.body?.getReader().cancel?.(); } catch { /* cleanup is best effort */ }
}
async function readJson(response: SessionResponse, signal: AbortSignal): Promise<SessionFetchResult> {
  const cap = SESSION_MAX_RESPONSE_BYTES;
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > cap) { await cancel(response); return error("oversized-response"); }
  let reader: SessionBodyReader;
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
    try { return { outcome: "ok", value: JSON.parse(text) as unknown }; } catch {
      // An expired session can be answered with the HTML login page instead of a redirect.
      return text.trimStart().startsWith("<") ? { outcome: "auth-needed" } : error("malformed-response");
    }
  } catch { await reader.cancel?.(); return signal.aborted ? error("aborted") : error("malformed-response"); }
}

/** Exactly one bounded request. 401/403 and any redirect (the login page) mean auth-needed. */
export async function fetchSessionJson(options: SessionFetchOptions): Promise<SessionFetchResult> {
  if (options.signal.aborted) return error("aborted");
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? SESSION_DEFAULT_TIMEOUT_MS);
  try {
    let response: SessionResponse;
    try {
      response = await (options.fetch ?? defaultFetch)(options.url, {
        method: "GET",
        headers: { Accept: "application/json", ...options.headers },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch { return controller.signal.aborted ? error(timedOut ? "timeout" : "aborted") : error("transport"); }
    if (controller.signal.aborted) { await cancel(response); return error(timedOut ? "timeout" : "aborted"); }
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) { await cancel(response); return error("malformed-response"); }
    if (response.status >= 200 && response.status < 300) {
      const result = await readJson(response, controller.signal);
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
