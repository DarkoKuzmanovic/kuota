import { homedir } from "node:os";

import {
  readUmansAuth,
  resolveUmansAuthPath,
  type UmansAuthResult,
} from "./auth.js";
import { fetchUmansUsage, type UmansFetchResult } from "./fetch.js";
import { parseUmansUsageResponse, type UmansUsageParseResult } from "./usage.js";
import {
  createNormalizedProviderResult,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderNormalizedResult,
} from "../types.js";

export interface UmansAdapterDependencies extends Readonly<Record<string, unknown>> {
  readonly resolveAuthPath?: () => string;
  readonly readAuth?: (options: { readonly authPath: string }) => Promise<UmansAuthResult>;
  readonly fetchUsage?: (options: { readonly credential: Extract<UmansAuthResult, { readonly state: "available" }> ["credential"]; readonly signal: AbortSignal }) => Promise<UmansFetchResult>;
  readonly parseUsage?: (payload: unknown, observedAt: string) => UmansUsageParseResult;
  readonly now?: () => number;
}

function authNeeded(): ProviderNormalizedResult<"umans"> {
  return createNormalizedProviderResult("umans", { id: "umans", state: "auth-needed", status: "Authentication required" });
}
function unavailable(): ProviderNormalizedResult<"umans"> {
  return createNormalizedProviderResult("umans", { id: "umans", state: "error", status: "Provider unavailable" });
}
function safeTimestamp(now: () => number): string | undefined {
  try { const value = now(); return Number.isFinite(value) ? new Date(value).toISOString() : undefined; } catch { return undefined; }
}

/** Finite Umans policy: one auth read, at most one usage request, no retries or writes. */
export function createUmansAdapter(
  dependencies: UmansAdapterDependencies = {},
): ProviderAdapter<"umans", UmansAdapterDependencies> {
  const now = dependencies.now ?? Date.now;
  const resolveAuthPath = dependencies.resolveAuthPath ?? (() => resolveUmansAuthPath(homedir()));
  const readAuth = dependencies.readAuth ?? ((options: { readonly authPath: string }) =>
    readUmansAuth({ authPath: options.authPath, environment: process.env }));
  const fetchUsage = dependencies.fetchUsage ?? ((options: { readonly credential: Extract<UmansAuthResult, { readonly state: "available" }> ["credential"]; readonly signal: AbortSignal }) => fetchUmansUsage(options));
  const parseUsage = dependencies.parseUsage ?? parseUmansUsageResponse;
  return {
    id: "umans",
    async collect(context: ProviderAdapterContext<UmansAdapterDependencies>): Promise<ProviderNormalizedResult<"umans">> {
      try {
        const authPath = resolveAuthPath();
        if (typeof authPath !== "string" || authPath.length === 0) return unavailable();
        const auth = await readAuth({ authPath });
        if (auth.state === "auth-needed") return authNeeded();
        if (auth.state !== "available") return unavailable();
        const fetched = await fetchUsage({ credential: auth.credential, signal: context.signal });
        if (fetched.outcome === "auth-needed") return authNeeded();
        if (fetched.outcome !== "ok") return unavailable();
        const observedAt = safeTimestamp(now);
        if (observedAt === undefined) return unavailable();
        const parsed = parseUsage(fetched.value, observedAt);
        return parsed.ok ? createNormalizedProviderResult("umans", parsed.record) : unavailable();
      } catch {
        return unavailable();
      }
    },
  };
}
