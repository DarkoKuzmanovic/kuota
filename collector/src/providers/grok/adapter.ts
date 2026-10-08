import { homedir } from "node:os";

import {
  readGrokAuth,
  resolveGrokAuthPath,
  type GrokAuthResult,
} from "./auth.js";
import { GROK_OAUTH } from "../../credentials/oauth-clients.js";
import {
  refreshStoreOAuthIfExpired,
  type RefreshStoreOAuthOptions,
  type RefreshStoreOAuthResult,
} from "../../credentials/refresh-store-oauth.js";
import { fetchGrokUsage, type GrokFetchResult } from "./fetch.js";
import { parseGrokUsageResponse, type GrokUsageParseResult } from "./usage.js";
import {
  createNormalizedProviderResult,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderNormalizedResult,
} from "../types.js";

export interface GrokAdapterDependencies extends Readonly<Record<string, unknown>> {
  readonly resolveAuthPath?: () => string;
  readonly readAuth?: (options: { readonly authPath: string }) => Promise<GrokAuthResult>;
  readonly fetchUsage?: (options: { readonly credential: Extract<GrokAuthResult, { readonly state: "available" }> ["credential"]; readonly signal: AbortSignal }) => Promise<GrokFetchResult>;
  readonly parseUsage?: (payload: unknown, observedAt: string) => GrokUsageParseResult;
  readonly now?: () => number;
  readonly refreshIfExpired?: (options: RefreshStoreOAuthOptions) => Promise<RefreshStoreOAuthResult>;
}

function authNeeded(): ProviderNormalizedResult<"grok"> {
  return createNormalizedProviderResult("grok", { id: "grok", state: "auth-needed", status: "Authentication required" });
}

function unavailable(): ProviderNormalizedResult<"grok"> {
  return createNormalizedProviderResult("grok", { id: "grok", state: "error", status: "Provider unavailable" });
}

function safeTimestamp(now: () => number): string | undefined {
  try { const value = now(); return Number.isFinite(value) ? new Date(value).toISOString() : undefined; } catch { return undefined; }
}

/** Finite Grok policy: one auth read, one bounded fetch (monthly + best-effort weekly), no retries or writes. */
export function createGrokAdapter(
  dependencies: GrokAdapterDependencies = {},
): ProviderAdapter<"grok", GrokAdapterDependencies> {
  const now = dependencies.now ?? Date.now;
  const resolveAuthPath = dependencies.resolveAuthPath ?? (() => resolveGrokAuthPath(homedir()));
  const readAuth = dependencies.readAuth ?? ((options: { readonly authPath: string }) =>
    readGrokAuth({ authPath: options.authPath, environment: process.env }));
  const fetchUsage = dependencies.fetchUsage ?? ((options: { readonly credential: Extract<GrokAuthResult, { readonly state: "available" }> ["credential"]; readonly signal: AbortSignal }) => fetchGrokUsage(options));
  const parseUsage = dependencies.parseUsage ?? parseGrokUsageResponse;
  const refreshIfExpired = dependencies.refreshIfExpired ?? refreshStoreOAuthIfExpired;
  return {
    id: "grok",
    async collect(context: ProviderAdapterContext<GrokAdapterDependencies>): Promise<ProviderNormalizedResult<"grok">> {
      try {
        const authPath = resolveAuthPath();
        if (typeof authPath !== "string" || authPath.length === 0) return unavailable();
        const auth = await readAuth({ authPath });
        if (auth.state === "auth-needed") return authNeeded();
        if (auth.state !== "available") return unavailable();
        const fresh = await refreshIfExpired({
          id: "grok",
          client: GROK_OAUTH,
          storePath: authPath,
          credential: auth.credential,
          now,
          signal: context.signal,
        });
        if (fresh.state === "auth-needed") return authNeeded();
        if (fresh.state !== "ok") return unavailable();
        const credential = { kind: auth.credential.kind, value: fresh.access };
        const fetched = await fetchUsage({ credential, signal: context.signal });
        if (fetched.outcome === "auth-needed") return authNeeded();
        if (fetched.outcome !== "ok") return unavailable();
        const observedAt = safeTimestamp(now);
        if (observedAt === undefined) return unavailable();
        const parsed = parseUsage(fetched.value, observedAt);
        return parsed.ok ? createNormalizedProviderResult("grok", parsed.record) : unavailable();
      } catch {
        return unavailable();
      }
    },
  };
}
