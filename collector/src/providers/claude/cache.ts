import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir as nodeMkdir } from "node:fs/promises";

import {
  atomicWriteJson,
  AtomicWriteError,
  nodeFileSystem,
  type AtomicFileSystem,
  type DirectoryHandle,
  type FileMetadata,
  type RandomSource,
} from "../../io/atomic-write.js";
import {
  isJsonValue,
  JsonFileError,
  readJsonFile,
  type JsonFileErrorKind,
  type JsonValue,
} from "../../io/json-file.js";
import { validateProviderRecord } from "../../contract/validate.js";
import type {
  ClaudeProviderRecord,
  ProviderRecord,
} from "../../contract/schema-v1.js";
import type { ClaudeUsageSuccessRecord } from "./usage.js";

/**
 * Kuota owns its Claude last-known-good cache. It never reads or writes the
 * pi-hud shared cache format. The default location is
 * `<home>/.cache/kuota/claude.json`; tests inject the home or exact path so no
 * live cache is ever touched.
 */

/** Version of the Kuota cache envelope, independent of the collector schema. */
export const CLAUDE_CACHE_SCHEMA_VERSION = 1 as const;

/** The only provider this cache stores. */
export const CLAUDE_CACHE_PROVIDER = "claude" as const;

/** Mode used when creating the private cache directory. */
const CACHE_DIRECTORY_MODE = 0o700;

const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "provider",
  "savedAt",
  "record",
]);

const CACHE_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** Constant, value-free status text for a cache read. */
export const CLAUDE_CACHE_STATUS_TEXT = {
  missing: "No cached usage",
  available: "Showing cached usage",
  error: "Cache unavailable",
} as const;

/** Constant, value-free status text for a cache write. */
export const CLAUDE_CACHE_WRITE_STATUS_TEXT = {
  written: "Cached usage stored",
  error: "Cache write failed",
} as const;

export const CLAUDE_CACHE_READ_ERROR_REASONS = [
  "cache-read",
  "cache-malformed",
  "cache-unsafe",
  "cache-invalid-envelope",
  "cache-invalid-record",
] as const;

export type ClaudeCacheReadErrorReason =
  (typeof CLAUDE_CACHE_READ_ERROR_REASONS)[number];

export const CLAUDE_CACHE_WRITE_ERROR_REASONS = [
  "cache-invalid-record",
  "cache-serialize",
  "cache-directory",
  "cache-write",
  "cache-indeterminate",
] as const;

export type ClaudeCacheWriteErrorReason =
  (typeof CLAUDE_CACHE_WRITE_ERROR_REASONS)[number];

/** A newly constructed stale Claude record reconstructed from cached usage. */
export type ClaudeCacheStaleRecord = Extract<
  ClaudeProviderRecord,
  { readonly state: "stale" }
>;

export type ClaudeCacheReadResult =
  | {
      readonly state: "missing";
      readonly status: typeof CLAUDE_CACHE_STATUS_TEXT.missing;
    }
  | {
      readonly state: "available";
      readonly status: typeof CLAUDE_CACHE_STATUS_TEXT.available;
      readonly record: ClaudeCacheStaleRecord;
    }
  | {
      readonly state: "error";
      readonly reason: ClaudeCacheReadErrorReason;
      readonly status: typeof CLAUDE_CACHE_STATUS_TEXT.error;
    };

export type ClaudeCacheWriteResult =
  | {
      readonly state: "written";
      readonly status: typeof CLAUDE_CACHE_WRITE_STATUS_TEXT.written;
    }
  | {
      readonly state: "error";
      readonly reason: ClaudeCacheWriteErrorReason;
      readonly status: typeof CLAUDE_CACHE_WRITE_STATUS_TEXT.error;
    };

export type ClaudeCacheReader = (path: string) => Promise<unknown>;
export type ClaudeCacheClock = () => number;

/**
 * A narrow injected directory seam. Only the immediate private cache directory
 * is created; the parent must already exist as a trusted local directory.
 */
export interface CacheDirectoryFileSystem {
  lstat(path: string): Promise<FileMetadata>;
  mkdir(path: string, mode: number): Promise<void>;
  getEffectiveUserId?(): number | bigint | undefined;
  openDirectory?(path: string): Promise<DirectoryHandle>;
}

/** The production directory seam; tests may replace every operation. */
export const nodeCacheDirectoryFileSystem: CacheDirectoryFileSystem = {
  lstat(path: string): Promise<FileMetadata> {
    return nodeFileSystem.lstat(path);
  },
  getEffectiveUserId(): number | bigint | undefined {
    return nodeFileSystem.getEffectiveUserId?.();
  },
  async mkdir(path: string, mode: number): Promise<void> {
    await nodeMkdir(path, { recursive: false, mode });
  },
  openDirectory(path: string): Promise<DirectoryHandle> {
    return nodeFileSystem.openDirectory(path);
  },
};

export interface ClaudeCacheReadOptions {
  /** Used only when cachePath is omitted; no filesystem lookup occurs here. */
  readonly homeDirectory?: string;
  /** Exact path override, useful for isolated callers and tests. */
  readonly cachePath?: string;
  /** Defaults to the safe no-follow JSON reader. */
  readonly readJsonFile?: ClaudeCacheReader;
}

export interface ClaudeCacheWriteOptions {
  /** Used only when cachePath is omitted; no filesystem lookup occurs here. */
  readonly homeDirectory?: string;
  /** Exact path override, useful for isolated callers and tests. */
  readonly cachePath?: string;
  /** Epoch milliseconds used to stamp the envelope. Defaults to Date.now. */
  readonly now?: ClaudeCacheClock;
  /** Directory seam; defaults to the production node seam. */
  readonly directoryFs?: CacheDirectoryFileSystem;
  /** Atomic write seam; defaults to the production node filesystem. */
  readonly fs?: AtomicFileSystem;
  readonly random?: RandomSource;
}

/** A value-free failure while preparing the private cache directory. */
export class CacheDirectoryError extends Error {
  constructor() {
    super("Cache directory preparation failed");
    this.name = "CacheDirectoryError";
  }
}

export function resolveClaudeCacheDirectory(homeDirectory: string): string {
  return join(homeDirectory, ".cache", "kuota");
}

export function resolveClaudeCachePath(homeDirectory: string): string {
  return join(resolveClaudeCacheDirectory(homeDirectory), "claude.json");
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Reads the Kuota-owned Claude cache with safe no-follow semantics, validates
 * the exact envelope and stored record, and reconstructs a fresh stale record.
 * A missing file (or missing parent) reads as `missing`; no directory is ever
 * created on the read path. Parsed object references are never retained or
 * mutated: the returned record is rebuilt through the runtime validator.
 */
export async function readClaudeCache(
  options: ClaudeCacheReadOptions = {},
): Promise<ClaudeCacheReadResult> {
  const path =
    options.cachePath ??
    resolveClaudeCachePath(options.homeDirectory ?? homedir());
  const read = options.readJsonFile ?? ((filePath: string) => readJsonFile(filePath));

  let raw: unknown;
  try {
    raw = await read(path);
  } catch (error: unknown) {
    return readErrorFromThrow(error);
  }

  if (raw === undefined) {
    return { state: "missing", status: CLAUDE_CACHE_STATUS_TEXT.missing };
  }

  let safe = false;
  try {
    safe = isJsonValue(raw);
  } catch {
    safe = false;
  }
  if (!safe) {
    return readError("cache-malformed");
  }

  const record = parseEnvelope(raw as JsonValue);
  if (record === undefined) {
    return readError("cache-invalid-envelope");
  }

  const okRecord = validateCachedRecord(record);
  if (okRecord === undefined) {
    return readError("cache-invalid-record");
  }

  const stale = reconstructStaleRecord(okRecord);
  if (stale === undefined) {
    return readError("cache-invalid-record");
  }

  return {
    state: "available",
    status: CLAUDE_CACHE_STATUS_TEXT.available,
    record: stale,
  };
}

function parseEnvelope(value: JsonValue): JsonValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length !== ENVELOPE_KEYS.size) {
    return undefined;
  }
  for (const key of keys) {
    if (!ENVELOPE_KEYS.has(key)) {
      return undefined;
    }
  }
  if (value.schemaVersion !== CLAUDE_CACHE_SCHEMA_VERSION) {
    return undefined;
  }
  if (value.provider !== CLAUDE_CACHE_PROVIDER) {
    return undefined;
  }
  if (!isCanonicalUtcTimestamp(value.savedAt)) {
    return undefined;
  }
  const record = value.record;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return undefined;
  }
  return record;
}

function validateCachedRecord(
  record: JsonValue,
): ClaudeUsageSuccessRecord | undefined {
  let value: ProviderRecord | undefined;
  try {
    const validation = validateProviderRecord(record);
    if (!validation.ok) {
      return undefined;
    }
    value = validation.value;
  } catch {
    return undefined;
  }
  if (!isClaudeOkRecord(value) || value.lastSuccessAt === undefined) {
    return undefined;
  }
  return value;
}

function reconstructStaleRecord(
  record: ClaudeUsageSuccessRecord,
): ClaudeCacheStaleRecord | undefined {
  const candidate: Record<string, unknown> = {
    id: CLAUDE_CACHE_PROVIDER,
    state: "stale",
    status: CLAUDE_CACHE_STATUS_TEXT.available,
    lastSuccessAt: record.lastSuccessAt,
  };
  if (record.windows !== undefined && record.windows.length > 0) {
    candidate.windows = record.windows;
  }
  if (record.details !== undefined) {
    candidate.details = record.details;
  }
  let value: ProviderRecord | undefined;
  try {
    const validation = validateProviderRecord(candidate);
    if (!validation.ok) {
      return undefined;
    }
    value = validation.value;
  } catch {
    return undefined;
  }
  return isClaudeStaleRecord(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Writes a validated successful Claude record as a versioned cache envelope.
 * The envelope is serialized and validated before any filesystem mutation, the
 * private cache directory is ensured, and the file is replaced atomically with
 * restrictive permissions. A corrupted Kuota-owned cache is overwritten safely;
 * a post-commit durability failure is reported as an indeterminate error and
 * the caller must re-read.
 */
export async function writeClaudeCache(
  record: ClaudeUsageSuccessRecord,
  options: ClaudeCacheWriteOptions = {},
): Promise<ClaudeCacheWriteResult> {
  const path =
    options.cachePath ??
    resolveClaudeCachePath(options.homeDirectory ?? homedir());
  const now = options.now ?? Date.now;
  const directoryFs = options.directoryFs ?? nodeCacheDirectoryFileSystem;
  const atomicFs = options.fs ?? nodeFileSystem;

  const okRecord = validateStorableRecord(record);
  if (okRecord === undefined) {
    return writeError("cache-invalid-record");
  }

  const savedAt = computeSavedAt(now);
  if (savedAt === undefined) {
    return writeError("cache-serialize");
  }

  const envelope = {
    schemaVersion: CLAUDE_CACHE_SCHEMA_VERSION,
    provider: CLAUDE_CACHE_PROVIDER,
    savedAt,
    record: okRecord,
  };

  let serializable = false;
  try {
    serializable = isJsonValue(envelope);
  } catch {
    serializable = false;
  }
  if (!serializable) {
    return writeError("cache-serialize");
  }

  try {
    await ensureClaudeCacheDirectory(dirname(path), directoryFs);
  } catch {
    return writeError("cache-directory");
  }

  try {
    await atomicWriteJson(path, envelope, {
      fs: atomicFs,
      random: options.random,
      policy: "new-cache",
    });
  } catch (error: unknown) {
    if (error instanceof AtomicWriteError && error.stage === "post-commit") {
      return writeError("cache-indeterminate");
    }
    return writeError("cache-write");
  }

  return { state: "written", status: CLAUDE_CACHE_WRITE_STATUS_TEXT.written };
}

function validateStorableRecord(
  record: unknown,
): ClaudeUsageSuccessRecord | undefined {
  let value: ProviderRecord | undefined;
  try {
    const validation = validateProviderRecord(record);
    if (!validation.ok) {
      return undefined;
    }
    value = validation.value;
  } catch {
    return undefined;
  }
  if (
    !isClaudeOkRecord(value) ||
    value.lastSuccessAt === undefined ||
    !hasRetainedData(value)
  ) {
    return undefined;
  }
  return value;
}

function computeSavedAt(now: ClaudeCacheClock): string | undefined {
  let millis: number;
  try {
    millis = now();
  } catch {
    return undefined;
  }
  if (typeof millis !== "number" || !Number.isFinite(millis)) {
    return undefined;
  }
  let iso: string;
  try {
    iso = new Date(millis).toISOString();
  } catch {
    return undefined;
  }
  return isCanonicalUtcTimestamp(iso) ? iso : undefined;
}

// ---------------------------------------------------------------------------
// Directory preparation
// ---------------------------------------------------------------------------

/**
 * Ensures only the immediate private cache directory exists. The parent must
 * already be a real, current-user-owned directory without group/other write
 * permission; the child is created non-recursively with mode 0700, tolerating
 * an EEXIST race and revalidating afterwards. This trusts the ancestor chain
 * above the parent — it is a caller-path precondition, not protection against a
 * malicious ancestor replacement.
 */
export async function ensureClaudeCacheDirectory(
  directory: string,
  fs: CacheDirectoryFileSystem = nodeCacheDirectoryFileSystem,
): Promise<void> {
  const parent = dirname(directory);
  const parentMeta = await requiredLstat(fs, parent);
  assertPrivateDirectory(parentMeta, fs);

  const existing = await optionalLstat(fs, directory);
  if (existing !== undefined) {
    assertPrivateDirectory(existing, fs);
    return;
  }

  let created = false;
  try {
    await fs.mkdir(directory, CACHE_DIRECTORY_MODE);
    created = true;
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") {
      throw new CacheDirectoryError();
    }
  }

  if (created) {
    await syncDirectory(fs, parent);
  }

  const revalidated = await requiredLstat(fs, directory);
  assertPrivateDirectory(revalidated, fs);
}

function assertPrivateDirectory(
  metadata: FileMetadata,
  fs: CacheDirectoryFileSystem,
): void {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new CacheDirectoryError();
  }
  const effectiveUserId = fs.getEffectiveUserId?.();
  if (
    effectiveUserId !== undefined &&
    (metadata.uid === undefined ||
      String(metadata.uid) !== String(effectiveUserId))
  ) {
    throw new CacheDirectoryError();
  }
}

async function requiredLstat(
  fs: CacheDirectoryFileSystem,
  path: string,
): Promise<FileMetadata> {
  try {
    return await fs.lstat(path);
  } catch {
    throw new CacheDirectoryError();
  }
}

async function optionalLstat(
  fs: CacheDirectoryFileSystem,
  path: string,
): Promise<FileMetadata | undefined> {
  try {
    return await fs.lstat(path);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw new CacheDirectoryError();
  }
}

async function syncDirectory(
  fs: CacheDirectoryFileSystem,
  path: string,
): Promise<void> {
  if (fs.openDirectory === undefined) {
    return;
  }
  let handle: DirectoryHandle | undefined;
  let failed = false;
  try {
    handle = await fs.openDirectory(path);
    await handle.sync();
  } catch {
    failed = true;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        failed = true;
      }
    }
  }
  if (failed) {
    throw new CacheDirectoryError();
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function hasRetainedData(record: ClaudeProviderRecord): boolean {
  if (record.windows !== undefined && record.windows.length > 0) {
    return true;
  }
  const details = record.details;
  if (details !== undefined && "claude" in details) {
    return Object.keys(details.claude).length > 0;
  }
  return false;
}

function isClaudeOkRecord(
  record: ProviderRecord,
): record is ClaudeUsageSuccessRecord {
  return record.id === "claude" && record.state === "ok";
}

function isClaudeStaleRecord(
  record: ProviderRecord,
): record is ClaudeCacheStaleRecord {
  return record.id === "claude" && record.state === "stale";
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CACHE_UTC_TIMESTAMP.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  const fractional = /\.(\d{3})Z$/.exec(value)?.[1];
  const canonical =
    fractional === undefined ? `${value.slice(0, -1)}.000Z` : value;
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== canonical) {
    return false;
  }
  return true;
}

function readError(reason: ClaudeCacheReadErrorReason): ClaudeCacheReadResult {
  return { state: "error", reason, status: CLAUDE_CACHE_STATUS_TEXT.error };
}

function writeError(
  reason: ClaudeCacheWriteErrorReason,
): ClaudeCacheWriteResult {
  return {
    state: "error",
    reason,
    status: CLAUDE_CACHE_WRITE_STATUS_TEXT.error,
  };
}

function readErrorFromThrow(error: unknown): ClaudeCacheReadResult {
  const kind = jsonFileErrorKind(error);
  if (kind === "malformed") {
    return readError("cache-malformed");
  }
  if (kind === "unsafe-file") {
    return readError("cache-unsafe");
  }
  return readError("cache-read");
}

function jsonFileErrorKind(error: unknown): JsonFileErrorKind | undefined {
  try {
    if (typeof error !== "object" || error === null) {
      return undefined;
    }
    if (Object.getPrototypeOf(error) !== JsonFileError.prototype) {
      return undefined;
    }
    const nameDescriptor = Object.getOwnPropertyDescriptor(error, "name");
    const kindDescriptor = Object.getOwnPropertyDescriptor(error, "kind");
    if (
      nameDescriptor === undefined ||
      !hasOwnValue(nameDescriptor) ||
      nameDescriptor.value !== "JsonFileError" ||
      kindDescriptor === undefined ||
      !hasOwnValue(kindDescriptor)
    ) {
      return undefined;
    }
    const value = kindDescriptor.value;
    return typeof value === "string" && isJsonFileErrorKind(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function hasOwnValue(descriptor: PropertyDescriptor): boolean {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function isJsonFileErrorKind(value: string): value is JsonFileErrorKind {
  return (
    value === "read" ||
    value === "malformed" ||
    value === "unsafe-file" ||
    value === "not-object" ||
    value === "update"
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
