import { homedir } from "node:os";

import {
  readCursorAuth,
  type CursorAuthResult,
} from "./auth.js";
import { fetchCursorUsage, type CursorFetchResult } from "./fetch.js";
import { parseCursorUsageResponse, type CursorUsageParseResult } from "./usage.js";
import {
  createNormalizedProviderResult,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderNormalizedResult,
} from "../types.js";

export interface CursorAdapterDependencies extends Readonly<Record<string, unknown>> {
  readonly readAuth?: (signal: AbortSignal) => Promise<CursorAuthResult>;
  readonly fetchUsage?: (options: { readonly credential: Extract<CursorAuthResult, { readonly state: "available" }> ["credential"]; readonly signal: AbortSignal }) => Promise<CursorFetchResult>;
  readonly parseUsage?: (payload: unknown, observedAt: string) => CursorUsageParseResult;
  readonly now?: () => number;
}

function authNeeded(): ProviderNormalizedResult<"cursor"> {
  return createNormalizedProviderResult("cursor", { id: "cursor", state: "auth-needed", status: "Authentication required" });
}

function unavailable(): ProviderNormalizedResult<"cursor"> {
  return createNormalizedProviderResult("cursor", { id: "cursor", state: "error", status: "Provider unavailable" });
}

function safeTimestamp(now: () => number): string | undefined {
  try { const value = now(); return Number.isFinite(value) ? new Date(value).toISOString() : undefined; } catch { return undefined; }
}

/** Finite Cursor policy: one auth read, one bounded fetch, no retries or writes. */
export function createCursorAdapter(
  dependencies: CursorAdapterDependencies = {},
): ProviderAdapter<"cursor", CursorAdapterDependencies> {
  const now = dependencies.now ?? Date.now;
  const readAuth = dependencies.readAuth ?? ((signal: AbortSignal) =>
    readCursorAuth({ homeDirectory: homedir(), environment: process.env, signal }));
  const fetchUsage = dependencies.fetchUsage ?? ((options: { readonly credential: Extract<CursorAuthResult, { readonly state: "available" }> ["credential"]; readonly signal: AbortSignal }) => fetchCursorUsage(options));
  const parseUsage = dependencies.parseUsage ?? parseCursorUsageResponse;
  return {
    id: "cursor",
    async collect(context: ProviderAdapterContext<CursorAdapterDependencies>): Promise<ProviderNormalizedResult<"cursor">> {
      try {
        if (context.signal.aborted) return unavailable();
        const auth = await readAuth(context.signal);
        if (context.signal.aborted) return unavailable();
        if (auth.state === "auth-needed") return authNeeded();
        if (auth.state !== "available") return unavailable();
        const fetched = await fetchUsage({ credential: auth.credential, signal: context.signal });
        if (fetched.outcome === "auth-needed") return authNeeded();
        if (fetched.outcome !== "ok") return unavailable();
        const observedAt = safeTimestamp(now);
        if (observedAt === undefined) return unavailable();
        const parsed = parseUsage(fetched.value, observedAt);
        return parsed.ok ? createNormalizedProviderResult("cursor", parsed.record) : unavailable();
      } catch {
        return unavailable();
      }
    },
  };
}
