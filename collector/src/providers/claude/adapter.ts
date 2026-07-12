import {
  clearClaudeBackoff,
  readClaudeBackoff,
  writeClaudeBackoff,
  type ClaudeBackoffReadResult,
  type ClaudeBackoffWriteResult,
} from "./backoff.js";
import { readClaudeAuth, type ClaudeAuthResult } from "./auth.js";
import {
  readClaudeCache,
  writeClaudeCache,
  type ClaudeCacheReadResult,
  type ClaudeCacheStaleRecord,
  type ClaudeCacheWriteResult,
} from "./cache.js";
import {
  CLAUDE_MAX_BACKOFF_MS,
  fetchClaudeUsage,
  type ClaudeFetchResult,
} from "./fetch.js";
import type { ClaudeOAuthCredential } from "./auth.js";
import type { ClaudeUsageSuccessRecord } from "./usage.js";
import {
  createNormalizedProviderResult,
  type ProviderAdapter,
  type ProviderNormalizedResult,
} from "../types.js";

/** A fresh Kuota-owned Claude record suppresses live requests for five minutes. */
export const CLAUDE_CACHE_FRESH_TTL_MS = 5 * 60_000;

export interface ClaudeAdapterDependencies extends Readonly<Record<string, unknown>> {
  readonly now?: () => number;
  readonly readBackoff?: () => Promise<ClaudeBackoffReadResult>;
  readonly readCache?: () => Promise<ClaudeCacheReadResult>;
  readonly writeCache?: (
    record: ClaudeUsageSuccessRecord,
  ) => Promise<ClaudeCacheWriteResult>;
  readonly clearBackoff?: () => Promise<ClaudeBackoffWriteResult>;
  readonly writeBackoff?: (retryAt: string) => Promise<ClaudeBackoffWriteResult>;
  readonly readAuth?: () => Promise<ClaudeAuthResult>;
  readonly fetchUsage?: (options: {
    readonly credential: ClaudeOAuthCredential;
    readonly signal: AbortSignal;
  }) => Promise<ClaudeFetchResult>;
}

/**
 * Policy-owning Claude adapter. Its mechanisms remain isolated in auth/cache/
 * fetch modules; this layer decides precedence, stale retention, and backoff.
 */
export function createClaudeAdapter(
  dependencies: ClaudeAdapterDependencies = {},
): ProviderAdapter<"claude", ClaudeAdapterDependencies> {
  const now = dependencies.now ?? Date.now;
  const readBackoff = dependencies.readBackoff ?? (() => readClaudeBackoff());
  const readCache = dependencies.readCache ?? (() => readClaudeCache());
  const writeCache = dependencies.writeCache ?? ((record) => writeClaudeCache(record));
  const clearBackoff = dependencies.clearBackoff ?? (() => clearClaudeBackoff());
  const writeBackoff = dependencies.writeBackoff ?? ((retryAt) => writeClaudeBackoff(retryAt));
  const readAuth = dependencies.readAuth ?? (() => readClaudeAuth());
  const fetchUsage = dependencies.fetchUsage ?? ((options) => fetchClaudeUsage(options));

  return {
    id: "claude",
    async collect(context): Promise<ProviderNormalizedResult<"claude">> {
      let stale: ClaudeCacheStaleRecord | undefined;
      try {
        const currentTime = safeNow(now);
        if (currentTime === undefined) return errorResult();

        const backoff = await safeCall(readBackoff);
        const cache = await safeCall(readCache);
        if (cache === undefined) return errorResult();
        const cacheDisposition = classifyCacheRead(cache);
        if (cacheDisposition.kind === "unsafe") return errorResult();
        stale = cacheDisposition.stale;

        if (backoff?.state === "available" && isBackoffActive(backoff.retryAt, currentTime)) {
          return staleOrError(stale);
        }

        if (stale !== undefined && isFresh(stale.lastSuccessAt, currentTime)) {
          return freshOrError(stale);
        }

        const auth = await safeCall(readAuth);
        if (auth === undefined || auth.state === "error") return staleOrError(stale);
        if (auth.state === "auth-needed") {
          return stale === undefined ? authNeededResult() : staleOrError(stale);
        }

        const fetched = await safeCall(() =>
          fetchUsage({ credential: auth.credential, signal: context.signal }),
        );
        if (fetched === undefined || fetched.outcome === "error") return staleOrError(stale);
        if (fetched.outcome === "auth-needed") {
          return stale === undefined ? authNeededResult() : staleOrError(stale);
        }
        if (fetched.outcome === "rate-limited") {
          if (isCanonicalTimestamp(fetched.retryAt)) {
            await safeCall(() => writeBackoff(fetched.retryAt));
          }
          return staleOrError(stale);
        }

        // Persistence is non-critical after a validated live response: cache/backoff
        // write failures may lose future optimization but never hide genuine usage.
        await safeCall(() => writeCache(fetched.record));
        await safeCall(clearBackoff);
        return normalizeLiveOrError(fetched.record);
      } catch {
        return staleOrError(stale);
      }
    },
  };
}

function safeNow(clock: () => number): number | undefined {
  try {
    const value = clock();
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function safeCall<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch {
    return undefined;
  }
}


type CacheReadDisposition =
  | { readonly kind: "available"; readonly stale: ClaudeCacheStaleRecord }
  | { readonly kind: "missing"; readonly stale: undefined }
  | { readonly kind: "recoverable-error"; readonly stale: undefined }
  | { readonly kind: "unsafe"; readonly stale: undefined };

/**
 * Cache failures have different policy consequences. Corruption and ordinary
 * read failures leave no usable data and may self-heal through a bounded live
 * fetch; an unsafe file boundary must prevent both mutation and network I/O.
 */
function classifyCacheRead(cache: ClaudeCacheReadResult): CacheReadDisposition {
  switch (cache.state) {
    case "available":
      return { kind: "available", stale: cache.record };
    case "missing":
      return { kind: "missing", stale: undefined };
    case "error":
      switch (cache.reason) {
        case "cache-read":
        case "cache-malformed":
        case "cache-invalid-envelope":
        case "cache-invalid-record":
          return { kind: "recoverable-error", stale: undefined };
        case "cache-unsafe":
          return { kind: "unsafe", stale: undefined };
        default:
          return unreachable(cache.reason);
      }
    default:
      return unreachable(cache);
  }
}

function unreachable(value: never): never {
  void value;
  throw new Error("Invalid Claude cache state");
}

function isFresh(lastSuccessAt: string, now: number): boolean {
  const timestamp = parseCanonicalTimestamp(lastSuccessAt);
  return timestamp !== undefined && timestamp <= now && now - timestamp < CLAUDE_CACHE_FRESH_TTL_MS;
}

function isBackoffActive(retryAt: string, now: number): boolean {
  const timestamp = parseCanonicalTimestamp(retryAt);
  return (
    timestamp !== undefined &&
    timestamp > now &&
    timestamp - now <= CLAUDE_MAX_BACKOFF_MS
  );
}

function parseCanonicalTimestamp(value: string): number | undefined {
  try {
    const date = new Date(value);
    const timestamp = date.getTime();
    return Number.isFinite(timestamp) && date.toISOString() === value ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && parseCanonicalTimestamp(value) !== undefined;
}

function freshOrError(
  stale: ClaudeCacheStaleRecord,
): ProviderNormalizedResult<"claude"> {
  try {
    const { status: _status, state: _state, ...record } = stale;
    return createNormalizedProviderResult("claude", { ...record, state: "ok" });
  } catch {
    return errorResult();
  }
}

function staleOrError(
  stale: ClaudeCacheStaleRecord | undefined,
): ProviderNormalizedResult<"claude"> {
  if (stale === undefined) return errorResult();
  try {
    return createNormalizedProviderResult("claude", {
      ...stale,
      status: "Using last known data",
    });
  } catch {
    return errorResult();
  }
}

function authNeededResult(): ProviderNormalizedResult<"claude"> {
  return createNormalizedProviderResult("claude", {
    id: "claude",
    state: "auth-needed",
    status: "Authentication required",
  });
}

function normalizeLiveOrError(
  record: ClaudeUsageSuccessRecord,
): ProviderNormalizedResult<"claude"> {
  try {
    return createNormalizedProviderResult("claude", record);
  } catch {
    return errorResult();
  }
}

function errorResult(): ProviderNormalizedResult<"claude"> {
  return createNormalizedProviderResult("claude", {
    id: "claude",
    state: "error",
    status: "Provider unavailable",
  });
}
