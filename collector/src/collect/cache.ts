import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  AtomicWriteError,
  atomicWriteJson,
  nodeFileSystem,
  type AtomicFileSystem,
  type RandomSource,
} from "../io/atomic-write.js";
import {
  isJsonValue,
  JsonFileError,
  readJsonFile,
} from "../io/json-file.js";
import { validateProviderRecord } from "../contract/validate.js";
import { PROVIDER_IDS, type ProviderId, type ProviderRecord } from "../contract/schema-v1.js";
import { scanForSecrets } from "../security/redact.js";
import {
  ensureKuotaCacheDirectory,
  nodeCacheDirectoryFileSystem,
  resolveKuotaCacheDirectory,
  type CacheDirectoryFileSystem,
} from "../io/cache-directory.js";

export const COLLECTOR_CACHE_SCHEMA_VERSION = 1 as const;

const CACHE_KEYS = new Set(["schemaVersion", "savedAt", "records"]);
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export interface CollectorCacheEnvelope {
  readonly schemaVersion: typeof COLLECTOR_CACHE_SCHEMA_VERSION;
  readonly savedAt: string;
  readonly records: readonly ProviderRecord[];
}

export type CollectorCacheReadResult =
  | { readonly state: "missing" }
  | { readonly state: "available"; readonly envelope: CollectorCacheEnvelope }
  | { readonly state: "error"; readonly reason: "cache-read" | "cache-unsafe" };

export type CollectorCacheWriteResult =
  | { readonly state: "written" }
  | { readonly state: "error"; readonly reason: "cache-invalid" | "cache-directory" | "cache-write" }
  | { readonly state: "indeterminate" };

export interface CollectorCacheReadOptions {
  readonly homeDirectory?: string;
  readonly cachePath?: string;
  readonly readJsonFile?: (path: string) => Promise<unknown>;
}

export interface CollectorCacheWriteOptions {
  readonly homeDirectory?: string;
  readonly cachePath?: string;
  readonly directoryFs?: CacheDirectoryFileSystem;
  readonly fs?: AtomicFileSystem;
  readonly random?: RandomSource;
  /** Re-reads after an indeterminate post-commit failure; never retries a write. */
  readonly readJsonFile?: (path: string) => Promise<unknown>;
}

export interface CollectorCacheMergeResult {
  readonly records: readonly ProviderRecord[];
  readonly envelope?: CollectorCacheEnvelope;
}

export function resolveCollectorCachePath(homeDirectory: string): string {
  return join(resolveKuotaCacheDirectory(homeDirectory), "collector.json");
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UTC_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function hasRetainedData(record: ProviderRecord): boolean {
  return (
    (record.windows !== undefined && record.windows.length > 0) ||
    (record.details !== undefined && Object.keys(record.details).length > 0)
  );
}

function cloneRecord(record: ProviderRecord): ProviderRecord | undefined {
  try {
    const cloned: unknown = JSON.parse(JSON.stringify(record));
    const validation = validateProviderRecord(cloned);
    return validation.ok ? validation.value : undefined;
  } catch {
    return undefined;
  }
}

function validateStorableRecord(value: unknown): ProviderRecord | undefined {
  try {
    if (!isJsonValue(value) || scanForSecrets(value).length > 0) return undefined;
    const validation = validateProviderRecord(value);
    if (!validation.ok) return undefined;
    const record = validation.value;
    if (
      record.state !== "ok" ||
      record.lastSuccessAt === undefined ||
      !hasRetainedData(record)
    ) {
      return undefined;
    }
    return cloneRecord(record);
  } catch {
    return undefined;
  }
}

function validateEnvelope(value: unknown): CollectorCacheEnvelope | undefined {
  try {
    if (!isJsonValue(value) || scanForSecrets(value).length > 0) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const keys = Object.keys(value);
    if (keys.length !== CACHE_KEYS.size || keys.some((key) => !CACHE_KEYS.has(key))) {
      return undefined;
    }
    if (value.schemaVersion !== COLLECTOR_CACHE_SCHEMA_VERSION || !isCanonicalTimestamp(value.savedAt)) {
      return undefined;
    }
    if (!Array.isArray(value.records) || value.records.length === 0) return undefined;

    const records = new Map<ProviderId, ProviderRecord>();
    for (const rawRecord of value.records) {
      const record = validateStorableRecord(rawRecord);
      if (record === undefined || records.has(record.id)) return undefined;
      records.set(record.id, record);
    }
    return createEnvelopeFromRecords(value.savedAt, records);
  } catch {
    return undefined;
  }
}

function createEnvelopeFromRecords(
  savedAt: string,
  records: ReadonlyMap<ProviderId, ProviderRecord>,
): CollectorCacheEnvelope | undefined {
  if (!isCanonicalTimestamp(savedAt) || records.size === 0) return undefined;
  const canonical: ProviderRecord[] = [];
  for (const id of PROVIDER_IDS) {
    const record = records.get(id);
    if (record === undefined) continue;
    const cloned = validateStorableRecord(record);
    if (cloned === undefined) return undefined;
    canonical.push(cloned);
  }
  if (canonical.length !== records.size) return undefined;
  return Object.freeze({
    schemaVersion: COLLECTOR_CACHE_SCHEMA_VERSION,
    savedAt,
    records: Object.freeze(canonical),
  });
}

/** Constructs a storable envelope from validated successful records and a caller-owned timestamp. */
export function createCollectorCacheEnvelope(
  savedAt: string,
  records: readonly ProviderRecord[],
): CollectorCacheEnvelope | undefined {
  const byId = new Map<ProviderId, ProviderRecord>();
  for (const record of records) {
    const storable = validateStorableRecord(record);
    if (storable === undefined || byId.has(storable.id)) return undefined;
    byId.set(storable.id, storable);
  }
  return createEnvelopeFromRecords(savedAt, byId);
}

function staleFromCached(record: ProviderRecord): ProviderRecord | undefined {
  const candidate: unknown = {
    ...record,
    state: "stale",
    status: "Using last known data",
  };
  try {
    const validation = validateProviderRecord(candidate);
    if (!validation.ok || validation.value.state !== "stale") return undefined;
    return cloneRecord(validation.value);
  } catch {
    return undefined;
  }
}

/**
 * Merges independent live provider results with fallback-only LKG data. Only an
 * `error` record may use a matching cached successful record; authentication
 * failures remain visible. `savedAt` belongs to the completed live collection:
 * only a canonical timestamp can stamp a successful cache update. This is pure
 * and deliberately does not suppress any future live collection.
 */
export function mergeCollectorCache(
  cached: CollectorCacheEnvelope | undefined,
  liveRecords: readonly ProviderRecord[],
  savedAt: string,
): CollectorCacheMergeResult {
  const cacheById = new Map<ProviderId, ProviderRecord>();
  if (cached !== undefined) {
    for (const record of cached.records) cacheById.set(record.id, record);
  }

  const liveById = new Map<ProviderId, ProviderRecord>();
  for (const record of liveRecords) liveById.set(record.id, record);

  const canUpdateCache = isCanonicalTimestamp(savedAt);
  let cacheUpdated = false;
  const mergedRecords: ProviderRecord[] = [];
  for (const id of PROVIDER_IDS) {
    const live = liveById.get(id);
    if (live === undefined) continue;
    const cachedRecord = cacheById.get(id);
    if (live.state === "ok") {
      const storable = validateStorableRecord(live);
      if (storable !== undefined && canUpdateCache) {
        cacheById.set(id, storable);
        cacheUpdated = true;
      }
      mergedRecords.push(live);
      continue;
    }
    if (live.state === "error" && cachedRecord !== undefined) {
      const stale = staleFromCached(cachedRecord);
      if (stale !== undefined) {
        mergedRecords.push(stale);
        continue;
      }
    }
    mergedRecords.push(live);
  }

  const envelope = cacheUpdated
    ? createEnvelopeFromRecords(savedAt, cacheById)
    : cached;
  return {
    records: Object.freeze(mergedRecords.map((record) => cloneRecord(record) ?? record)),
    ...(envelope === undefined ? {} : { envelope }),
  };
}

function readError(error: unknown): CollectorCacheReadResult {
  if (error instanceof JsonFileError && error.kind === "malformed") {
    return { state: "missing" };
  }
  if (error instanceof JsonFileError && error.kind === "unsafe-file") {
    return { state: "error", reason: "cache-unsafe" };
  }
  return { state: "error", reason: "cache-read" };
}

export async function readCollectorCache(
  options: CollectorCacheReadOptions = {},
): Promise<CollectorCacheReadResult> {
  const path = options.cachePath ?? resolveCollectorCachePath(options.homeDirectory ?? homedir());
  const read = options.readJsonFile ?? ((filePath: string) => readJsonFile(filePath));
  let raw: unknown;
  try {
    raw = await read(path);
  } catch (error: unknown) {
    return readError(error);
  }
  if (raw === undefined) return { state: "missing" };
  const envelope = validateEnvelope(raw);
  return envelope === undefined ? { state: "missing" } : { state: "available", envelope };
}

/** Writes a validated envelope once; post-commit failures trigger one re-read, never a retry. */
export async function writeCollectorCache(
  input: unknown,
  options: CollectorCacheWriteOptions = {},
): Promise<CollectorCacheWriteResult> {
  const envelope = validateEnvelope(input);
  if (envelope === undefined) return { state: "error", reason: "cache-invalid" };

  const path = options.cachePath ?? resolveCollectorCachePath(options.homeDirectory ?? homedir());
  try {
    await ensureKuotaCacheDirectory(dirname(path), options.directoryFs ?? nodeCacheDirectoryFileSystem);
  } catch {
    return { state: "error", reason: "cache-directory" };
  }

  try {
    await atomicWriteJson(path, envelope, {
      fs: options.fs ?? nodeFileSystem,
      random: options.random,
      policy: "new-cache",
    });
    return { state: "written" };
  } catch (error: unknown) {
    if (error instanceof AtomicWriteError && error.stage === "post-commit") {
      const read = options.readJsonFile ?? ((filePath: string) => readJsonFile(filePath));
      try {
        await read(path);
      } catch {
        // The re-read is best effort; the write remains indeterminate either way.
      }
      return { state: "indeterminate" };
    }
    return { state: "error", reason: "cache-write" };
  }
}
