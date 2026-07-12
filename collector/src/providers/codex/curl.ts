import { spawn as nativeSpawn } from "node:child_process";

import type { CodexOAuthCredential } from "./auth.js";
import {
  CODEX_DEFAULT_MAX_RESPONSE_BYTES,
  CODEX_DEFAULT_TIMEOUT_MS,
  CODEX_MAX_TIMEOUT_MS,
  CODEX_USAGE_ENDPOINT,
  CODEX_USAGE_USER_AGENT,
} from "./fetch.js";

/** Fixed final stdout delimiter emitted by curl's write-out configuration. */
export const CODEX_CURL_STATUS_MARKER = "\n__KUOTA_CURL_HTTP_STATUS__" as const;
export const CODEX_CURL_DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

export const CODEX_CURL_ERROR_REASONS = [
  "invalid-config",
  "unavailable",
  "transport",
  "aborted",
  "timeout",
  "oversized-output",
  "malformed-response",
  "nonzero-exit",
  "http-status",
] as const;

export type CodexCurlErrorReason = (typeof CODEX_CURL_ERROR_REASONS)[number];

/** This transport only exposes parsed JSON, never child-process diagnostics. */
export type CodexCurlResult =
  | { readonly outcome: "ok"; readonly value: unknown }
  | { readonly outcome: "auth-needed" }
  | { readonly outcome: "error"; readonly reason: CodexCurlErrorReason };

export interface CodexCurlReadable {
  on(event: "data", listener: (chunk: unknown) => void): void;
  on(event: "end" | "error", listener: () => void): void;
  removeListener(event: "data", listener: (chunk: unknown) => void): void;
  removeListener(event: "end" | "error", listener: () => void): void;
}

export interface CodexCurlWritable {
  write(value: string): unknown;
  end(): unknown;
  on(event: "error", listener: () => void): void;
  removeListener(event: "error", listener: () => void): void;
}

export interface CodexCurlChild {
  readonly stdin: CodexCurlWritable | null;
  readonly stdout: CodexCurlReadable | null;
  readonly stderr: CodexCurlReadable | null;
  kill(): unknown;
  once(event: "error", listener: () => void): void;
  once(event: "close", listener: (code: unknown, signal: unknown) => void): void;
  removeListener(event: "error", listener: () => void): void;
  removeListener(event: "close", listener: (code: unknown, signal: unknown) => void): void;
}

export interface CodexCurlSpawnOptions {
  readonly shell: false;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
}

/** Injectable only for deterministic subprocess-boundary tests. */
export type CodexCurlSpawn = (
  command: string,
  args: readonly string[],
  options: CodexCurlSpawnOptions,
) => CodexCurlChild;

export interface CodexCurlOptions {
  readonly credential: CodexOAuthCredential;
  readonly signal: AbortSignal;
  readonly spawn?: CodexCurlSpawn;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxStderrBytes?: number;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_STATUS_FRAME_BYTES = Buffer.byteLength(CODEX_CURL_STATUS_MARKER) + 4;

/**
 * Runs exactly one stdin-configured curl fallback. It deliberately does not
 * access auth state, use fetch, retry, refresh, persist, or normalize usage.
 */
export async function curlCodexUsage(options: CodexCurlOptions): Promise<CodexCurlResult> {
  const timeoutMs = options.timeoutMs ?? CODEX_DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? CODEX_DEFAULT_MAX_RESPONSE_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? CODEX_CURL_DEFAULT_MAX_STDERR_BYTES;
  if (
    !isBoundedPositiveInteger(timeoutMs, CODEX_MAX_TIMEOUT_MS) ||
    !isBoundedPositiveInteger(maxResponseBytes, CODEX_DEFAULT_MAX_RESPONSE_BYTES) ||
    !isBoundedPositiveInteger(maxStderrBytes, CODEX_CURL_DEFAULT_MAX_STDERR_BYTES)
  ) return errorResult("invalid-config");
  if (options.signal.aborted) return errorResult("aborted");

  const config = buildConfig(options.credential, timeoutMs);
  if (config === undefined) return errorResult("invalid-config");

  return new Promise<CodexCurlResult>((resolve) => {
    let child: CodexCurlChild;
    try {
      child = (options.spawn ?? defaultSpawn)("curl", ["--config", "-"], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve(errorResult("unavailable"));
      return;
    }

    let stdin: CodexCurlWritable | null;
    let stdout: CodexCurlReadable | null;
    let stderr: CodexCurlReadable | null;
    try {
      stdin = child.stdin;
      stdout = child.stdout;
      stderr = child.stderr;
    } catch {
      terminateQuietly(child);
      resolve(errorResult("unavailable"));
      return;
    }
    if (stdin === null || stdout === null || stderr === null) {
      terminateQuietly(child);
      resolve(errorResult("unavailable"));
      return;
    }

    let settled = false;
    let terminated = false;
    const stdoutChunks: Uint8Array[] = [];
    let stdoutTotal = 0;
    let stderrTotal = 0;

    const terminate = (): void => {
      if (terminated) return;
      terminated = true;
      terminateQuietly(child);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      stdin.removeListener("error", onStdinError);
      stdout.removeListener("data", onStdoutData);
      stdout.removeListener("error", onStdoutError);
      stdout.removeListener("end", onStreamEnd);
      stderr.removeListener("data", onStderrData);
      stderr.removeListener("error", onStderrError);
      stderr.removeListener("end", onStreamEnd);
      child.removeListener("error", onChildError);
      child.removeListener("close", onClose);
    };
    const settle = (result: CodexCurlResult, shouldTerminate = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (shouldTerminate) terminate();
      resolve(result);
    };
    const onAbort = (): void => settle(errorResult("aborted"), true);
    const onStdinError = (): void => settle(errorResult("transport"), true);
    const onStdoutError = (): void => settle(errorResult("transport"), true);
    const onStderrError = (): void => settle(errorResult("transport"), true);
    const onStreamEnd = (): void => {
      // Data listeners stay attached until close so terminated pipes keep draining.
    };
    const onChildError = (): void => settle(errorResult("unavailable"), true);
    const onStdoutData = (chunk: unknown): void => {
      if (settled) return;
      const copied = copyChunk(chunk, maxResponseBytes + MAX_STATUS_FRAME_BYTES - stdoutTotal);
      if (copied === undefined) {
        settle(errorResult("oversized-output"), true);
        return;
      }
      if (copied === null) {
        settle(errorResult("malformed-response"), true);
        return;
      }
      stdoutTotal += copied.byteLength;
      stdoutChunks.push(copied);
    };
    const onStderrData = (chunk: unknown): void => {
      if (settled) return;
      const copied = copyChunk(chunk, maxStderrBytes - stderrTotal);
      if (copied === undefined) {
        settle(errorResult("oversized-output"), true);
        return;
      }
      if (copied === null) {
        settle(errorResult("transport"), true);
        return;
      }
      stderrTotal += copied.byteLength;
    };
    const onClose = (code: unknown, signal: unknown): void => {
      if (settled) {
        cleanup();
        return;
      }
      if (code !== 0 || signal !== null) {
        settle(errorResult("nonzero-exit"));
        cleanup();
        return;
      }
      settle(parseFramedOutput(concatChunks(stdoutChunks, stdoutTotal), maxResponseBytes));
      cleanup();
    };
    const timer = setTimeout(() => settle(errorResult("timeout"), true), timeoutMs);

    options.signal.addEventListener("abort", onAbort, { once: true });
    stdin.on("error", onStdinError);
    stdout.on("data", onStdoutData);
    stdout.on("error", onStdoutError);
    stdout.on("end", onStreamEnd);
    stderr.on("data", onStderrData);
    stderr.on("error", onStderrError);
    stderr.on("end", onStreamEnd);
    child.once("error", onChildError);
    child.once("close", onClose);

    if (options.signal.aborted) {
      onAbort();
      return;
    }
    try {
      stdin.write(config);
      stdin.end();
    } catch {
      settle(errorResult("transport"), true);
    }
  });
}

const defaultSpawn: CodexCurlSpawn = (command, args, options) => {
  const child = nativeSpawn(command, [...args], { shell: options.shell, stdio: [...options.stdio] });
  return {
    stdin: child.stdin === null ? null : readableWritable(child.stdin),
    stdout: child.stdout === null ? null : readable(child.stdout),
    stderr: child.stderr === null ? null : readable(child.stderr),
    kill: () => child.kill(),
    once: (event, listener): void => {
      if (event === "error") child.once("error", listener);
      else child.once("close", listener);
    },
    removeListener: (event, listener): void => {
      child.removeListener(event, listener);
    },
  };
};

function readable(stream: NodeJS.ReadableStream): CodexCurlReadable {
  return {
    on: (event, listener): void => {
      stream.on(event, listener);
    },
    removeListener: (event, listener): void => {
      stream.removeListener(event, listener);
    },
  };
}

function readableWritable(stream: NodeJS.WritableStream): CodexCurlWritable {
  return {
    write: (value): boolean => stream.write(value),
    end: (): void => {
      stream.end();
    },
    on: (event, listener): void => {
      stream.on(event, listener);
    },
    removeListener: (event, listener): void => {
      stream.removeListener(event, listener);
    },
  };
}

function buildConfig(credential: CodexOAuthCredential, timeoutMs: number): string | undefined {
  try {
    const access: unknown = credential.access;
    const accountId: unknown = credential.accountId;
    if (!isSafeConfigValue(access) || !isSafeConfigValue(accountId)) return undefined;
    const maxTimeSeconds = Math.ceil(timeoutMs / 1_000);
    const writeOut = `\\n${CODEX_CURL_STATUS_MARKER.slice(1)}%{http_code}\\n`;
    return [
      `url = "${escapeConfigValue(CODEX_USAGE_ENDPOINT)}"`,
      'request = "GET"',
      "silent",
      "show-error",
      `max-time = "${maxTimeSeconds}"`,
      `header = "${escapeConfigValue(`Authorization: Bearer ${access}`)}"`,
      `header = "${escapeConfigValue(`chatgpt-account-id: ${accountId}`)}"`,
      'header = "OpenAI-Beta: responses=experimental"',
      `header = "${escapeConfigValue(`User-Agent: ${CODEX_USAGE_USER_AGENT}`)}"`,
      `write-out = "${escapeConfigValue(writeOut)}"`,
      "",
    ].join("\n");
  } catch {
    return undefined;
  }
}

function isSafeConfigValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !CONTROL_CHARACTERS.test(value);
}

function escapeConfigValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function copyChunk(chunk: unknown, remaining: number): Uint8Array | null | undefined {
  try {
    if (!(chunk instanceof Uint8Array)) return null;
    const size: unknown = chunk.byteLength;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
    if (size > remaining) return undefined;
    const copied = new Uint8Array(size);
    copied.set(chunk);
    return copied;
  } catch {
    return null;
  }
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseFramedOutput(bytes: Uint8Array, maxResponseBytes: number): CodexCurlResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return errorResult("malformed-response");
  }
  const markerIndex = text.lastIndexOf(CODEX_CURL_STATUS_MARKER);
  if (
    markerIndex < 0 ||
    markerIndex !== text.indexOf(CODEX_CURL_STATUS_MARKER) ||
    markerIndex + CODEX_CURL_STATUS_MARKER.length + 4 !== text.length
  ) return errorResult("malformed-response");

  const statusText = text.slice(markerIndex + CODEX_CURL_STATUS_MARKER.length, -1);
  if (!/^[1-5]\d{2}$/.test(statusText)) return errorResult("malformed-response");
  const status = Number(statusText);
  const body = text.slice(0, markerIndex);
  if (Buffer.byteLength(body) > maxResponseBytes) return errorResult("oversized-output");
  if (status === 401 || status === 403) return { outcome: "auth-needed" };
  if (status < 200 || status >= 300) return errorResult("http-status");
  try {
    return { outcome: "ok", value: JSON.parse(body) as unknown };
  } catch {
    return errorResult("malformed-response");
  }
}

function isBoundedPositiveInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function terminateQuietly(child: CodexCurlChild): void {
  try {
    child.kill();
  } catch {
    // Child errors and diagnostics are intentionally not surfaced.
  }
}

function errorResult(reason: CodexCurlErrorReason): CodexCurlResult {
  return { outcome: "error", reason };
}
