import { homedir } from "node:os";

import {
  readKimiAuth,
  resolveKimiAuthPath,
  type KimiAuthResult,
} from "./auth.js";
import { KIMI_OAUTH } from "../../credentials/oauth-clients.js";
import {
  refreshStoreOAuthIfExpired,
  type RefreshStoreOAuthOptions,
  type RefreshStoreOAuthResult,
} from "../../credentials/refresh-store-oauth.js";
import { fetchKimiUsage, type KimiFetchResult } from "./fetch.js";
import { parseKimiUsageResponse, type KimiUsageParseResult } from "./usage.js";
import {
  createNormalizedProviderResult,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderNormalizedResult,
} from "../types.js";

export interface KimiAdapterDependencies extends Readonly<Record<string, unknown>> {
  readonly resolveAuthPath?: () => string;
  readonly readAuth?: (options: { readonly authPath: string }) => Promise<KimiAuthResult>;
  readonly fetchUsage?: (options: { readonly credential: Extract<KimiAuthResult, { readonly state: "available" }> ["credential"]; readonly signal: AbortSignal }) => Promise<KimiFetchResult>;
  readonly parseUsage?: (payload: unknown, observedAt: string) => KimiUsageParseResult;
  readonly now?: () => number;
  readonly refreshIfExpired?: (options: RefreshStoreOAuthOptions) => Promise<RefreshStoreOAuthResult>;
}

function authNeeded(): ProviderNormalizedResult<"kimi"> {
  return createNormalizedProviderResult("kimi", { id: "kimi", state: "auth-needed", status: "Authentication required" });
}

function unavailable(): ProviderNormalizedResult<"kimi"> {
  return createNormalizedProviderResult("kimi", { id: "kimi", state: "error", status: "Provider unavailable" });
}

function safeTimestamp(now: () => number): string | undefined {
  try { const value = now(); return Number.isFinite(value) ? new Date(value).toISOString() : undefined; } catch { return undefined; }
}

/** Finite Kimi policy: one auth read, at most one usage request, no retries or writes. */
export function createKimiAdapter(
  dependencies: KimiAdapterDependencies = {},
): ProviderAdapter<"kimi", KimiAdapterDependencies> {
  const now = dependencies.now ?? Date.now;
  const resolveAuthPath = dependencies.resolveAuthPath ?? (() => resolveKimiAuthPath(homedir()));
  const readAuth = dependencies.readAuth ?? ((options: { readonly authPath: string }) =>
    readKimiAuth({ authPath: options.authPath, environment: process.env }));
  const fetchUsage = dependencies.fetchUsage ?? ((options: { readonly credential: Extract<KimiAuthResult, { readonly state: "available" }> ["credential"]; readonly signal: AbortSignal }) => fetchKimiUsage(options));
  const parseUsage = dependencies.parseUsage ?? parseKimiUsageResponse;
  const refreshIfExpired = dependencies.refreshIfExpired ?? refreshStoreOAuthIfExpired;
  return {
    id: "kimi",
    async collect(context: ProviderAdapterContext<KimiAdapterDependencies>): Promise<ProviderNormalizedResult<"kimi">> {
      try {
        const authPath = resolveAuthPath();
        if (typeof authPath !== "string" || authPath.length === 0) return unavailable();
        const auth = await readAuth({ authPath });
        if (auth.state === "auth-needed") return authNeeded();
        if (auth.state !== "available") return unavailable();
        const fresh = await refreshIfExpired({
          id: "kimi",
          client: KIMI_OAUTH,
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
        return parsed.ok ? createNormalizedProviderResult("kimi", parsed.record) : unavailable();
      } catch {
        return unavailable();
      }
    },
  };
}
