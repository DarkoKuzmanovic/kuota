import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  atomicWriteJson,
  nodeFileSystem,
  type AtomicFileSystem,
  type RandomSource,
} from "../../io/atomic-write.js";
import { isJsonValue, readJsonFile } from "../../io/json-file.js";
import {
  ensureClaudeCacheDirectory,
  nodeCacheDirectoryFileSystem,
  resolveClaudeCacheDirectory,
  type CacheDirectoryFileSystem,
} from "./cache.js";

/** Separate from the LKG envelope so only successful usage records live there. */
export const CLAUDE_BACKOFF_SCHEMA_VERSION = 1 as const;
export const CLAUDE_BACKOFF_CLEAR_RETRY_AT = "1970-01-01T00:00:00.000Z" as const;

export type ClaudeBackoffReadResult =
  | { readonly state: "missing" }
  | { readonly state: "available"; readonly retryAt: string }
  | { readonly state: "error" };

export type ClaudeBackoffWriteResult =
  | { readonly state: "written" }
  | { readonly state: "cleared" }
  | { readonly state: "error" };

export interface ClaudeBackoffReadOptions {
  readonly homeDirectory?: string;
  readonly backoffPath?: string;
  readonly readJsonFile?: (path: string) => Promise<unknown>;
}

export interface ClaudeBackoffWriteOptions {
  readonly homeDirectory?: string;
  readonly backoffPath?: string;
  readonly directoryFs?: CacheDirectoryFileSystem;
  readonly fs?: AtomicFileSystem;
  readonly random?: RandomSource;
}

export function resolveClaudeBackoffPath(homeDirectory: string): string {
  return join(resolveClaudeCacheDirectory(homeDirectory), "claude-backoff.json");
}

/** Reads an untrusted sidecar; malformed or unsafe content fails open at policy level. */
export async function readClaudeBackoff(
  options: ClaudeBackoffReadOptions = {},
): Promise<ClaudeBackoffReadResult> {
  const path = options.backoffPath ?? resolveClaudeBackoffPath(options.homeDirectory ?? homedir());
  const reader = options.readJsonFile ?? readJsonFile;
  let value: unknown;
  try {
    value = await reader(path);
  } catch {
    return { state: "error" };
  }
  if (value === undefined) return { state: "missing" };
  if (!isJsonValue(value) || !isBackoffEnvelope(value)) return { state: "error" };
  return { state: "available", retryAt: value.retryAt };
}

/** Persists only a validated absolute retry time. */
export async function writeClaudeBackoff(
  retryAt: string,
  options: ClaudeBackoffWriteOptions = {},
): Promise<ClaudeBackoffWriteResult> {
  return writeEnvelope(retryAt, "written", options);
}

/** Atomically marks the sidecar expired; a clear failure is non-critical to live usage. */
export async function clearClaudeBackoff(
  options: ClaudeBackoffWriteOptions = {},
): Promise<ClaudeBackoffWriteResult> {
  return writeEnvelope(CLAUDE_BACKOFF_CLEAR_RETRY_AT, "cleared", options);
}

async function writeEnvelope(
  retryAt: string,
  success: "written" | "cleared",
  options: ClaudeBackoffWriteOptions,
): Promise<ClaudeBackoffWriteResult> {
  if (!isCanonicalTimestamp(retryAt)) return { state: "error" };
  const path = options.backoffPath ?? resolveClaudeBackoffPath(options.homeDirectory ?? homedir());
  const envelope = { schemaVersion: CLAUDE_BACKOFF_SCHEMA_VERSION, retryAt };
  if (!isJsonValue(envelope)) return { state: "error" };
  try {
    await ensureClaudeCacheDirectory(
      dirname(path),
      options.directoryFs ?? nodeCacheDirectoryFileSystem,
    );
    await atomicWriteJson(path, envelope, {
      fs: options.fs ?? nodeFileSystem,
      random: options.random,
      policy: "new-cache",
    });
  } catch {
    return { state: "error" };
  }
  return { state: success };
}

function isBackoffEnvelope(value: unknown): value is {
  readonly schemaVersion: typeof CLAUDE_BACKOFF_SCHEMA_VERSION;
  readonly retryAt: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("schemaVersion") || !keys.includes("retryAt")) {
    return false;
  }
  const schemaVersion = Object.getOwnPropertyDescriptor(value, "schemaVersion")?.value;
  const retryAt = Object.getOwnPropertyDescriptor(value, "retryAt")?.value;
  return (
    schemaVersion === CLAUDE_BACKOFF_SCHEMA_VERSION &&
    typeof retryAt === "string" &&
    isCanonicalTimestamp(retryAt)
  );
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  } catch {
    return false;
  }
}
