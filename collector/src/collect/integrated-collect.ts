import { SCHEMA_VERSION, type CollectorDocument, type ProviderId, type ProviderRecord } from "../contract/schema-v1.js";
import { validateCollectorDocument } from "../contract/validate.js";
import { createNormalizedProviderResult } from "../providers/types.js";
import { createProviderRegistry } from "../providers/registry.js";
import {
  mergeCollectorCache,
  readCollectorCache,
  writeCollectorCache,
} from "./cache.js";
import { collect, CollectorValidationError, type CollectOptions, type CollectorConfig } from "./collect.js";
import { parseCollectorConfig } from "./config.js";
import { acquireCollectorLock } from "./lock.js";

export interface IntegratedCollectOptions extends CollectOptions {
  readonly homeDirectory?: string;
}

function timestampFor(options: IntegratedCollectOptions): string {
  const milliseconds = options.clock?.now() ?? Date.now();
  try {
    const timestamp = new Date(milliseconds).toISOString();
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error();
    return timestamp;
  } catch {
    throw new CollectorValidationError();
  }
}

function resolvedConfig(options: IntegratedCollectOptions): CollectorConfig {
  return options.config ?? parseCollectorConfig(undefined);
}

function safeError(id: ProviderId): ProviderRecord {
  return createNormalizedProviderResult(id, {
    id,
    state: "error",
    status: "Provider unavailable",
  });
}

function validatedDocument(
  startedAt: string,
  finishedAt: string,
  records: readonly ProviderRecord[],
): CollectorDocument {
  const validation = validateCollectorDocument({
    schemaVersion: SCHEMA_VERSION,
    collectionStartedAt: startedAt,
    collectionFinishedAt: finishedAt,
    providers: records,
  });
  if (!validation.ok) throw new CollectorValidationError();
  return validation.value;
}

async function lockedFallback(
  options: IntegratedCollectOptions,
  config: CollectorConfig,
): Promise<CollectorDocument> {
  const selected = (options.registry ?? createProviderRegistry()).selectEnabled(config.providers);
  const cache = await readCollectorCache({ homeDirectory: options.homeDirectory });
  const cached = cache.state === "available" ? cache.envelope : undefined;
  const timestamp = timestampFor(options);
  const merged = mergeCollectorCache(
    cached,
    selected.map((provider) => safeError(provider.id)),
    timestamp,
  );
  return validatedDocument(timestamp, timestamp, merged.records);
}

/**
 * Owns the lock/cache boundary around the existing concurrent provider
 * collector. Cache failures remain non-fatal and the lock is held through the
 * validation and one possible cache persistence operation.
 */
export async function collectIntegrated(
  options: IntegratedCollectOptions = {},
): Promise<CollectorDocument> {
  const config = resolvedConfig(options);
  const lock = await acquireCollectorLock({ homeDirectory: options.homeDirectory });
  if (lock.state !== "acquired") return lockedFallback(options, config);
  try {
    const cache = await readCollectorCache({ homeDirectory: options.homeDirectory });
    const cached = cache.state === "available" ? cache.envelope : undefined;
    const live = await collect({ ...options, config });
    const merged = mergeCollectorCache(cached, live.providers, live.collectionFinishedAt);
    const document = validatedDocument(
      live.collectionStartedAt,
      live.collectionFinishedAt,
      merged.records,
    );
    if (merged.envelope !== undefined && merged.envelope !== cached) {
      await writeCollectorCache(merged.envelope, { homeDirectory: options.homeDirectory });
    }
    return document;
  } finally {
    await lock.release();
  }
}
