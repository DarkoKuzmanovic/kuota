import { homedir } from "node:os";

import {
  readOpencodeAuth,
  resolveOpencodeAuthPath,
  type OpencodeAuthResult,
} from "./auth.js";
import { fetchOpencodeUsage, type OpencodeFetchResult } from "./fetch.js";
import { parseOpencodeUsageResponse, type OpencodeUsageParseResult } from "./usage.js";
import {
  createNormalizedProviderResult,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderNormalizedResult,
} from "../types.js";

export interface OpencodeAdapterDependencies extends Readonly<Record<string, unknown>> {
  readonly resolveAuthPath?: () => string;
  readonly readAuth?: (options: { readonly authPath: string }) => Promise<OpencodeAuthResult>;
  readonly fetchUsage?: (options: { readonly credential: Extract<OpencodeAuthResult, { readonly state: "available" }> ["credential"]; readonly signal: AbortSignal }) => Promise<OpencodeFetchResult>;
  readonly parseUsage?: (payload: unknown, observedAt: string) => OpencodeUsageParseResult;
  readonly now?: () => number;
}

function authNeeded(): ProviderNormalizedResult<"opencode"> {
  return createNormalizedProviderResult("opencode", { id: "opencode", state: "auth-needed", status: "Authentication required" });
}

function unavailable(): ProviderNormalizedResult<"opencode"> {
  return createNormalizedProviderResult("opencode", { id: "opencode", state: "error", status: "Provider unavailable" });
}

function safeTimestamp(now: () => number): string | undefined {
  try { const value = now(); return Number.isFinite(value) ? new Date(value).toISOString() : undefined; } catch { return undefined; }
}

/** OpenCode policy: one auth read, at most one usage request, no retries or writes. */
export function createOpencodeAdapter(
  dependencies: OpencodeAdapterDependencies = {},
): ProviderAdapter<"opencode", OpencodeAdapterDependencies> {
  const now = dependencies.now ?? Date.now;
  const resolveAuthPath = dependencies.resolveAuthPath ?? (() => resolveOpencodeAuthPath(homedir()));
  const readAuth = dependencies.readAuth ?? ((options: { readonly authPath: string }) =>
    readOpencodeAuth({ authPath: options.authPath, environment: process.env }));
  const fetchUsage = dependencies.fetchUsage ?? ((options: { readonly credential: Extract<OpencodeAuthResult, { readonly state: "available" }> ["credential"]; readonly signal: AbortSignal }) => fetchOpencodeUsage(options));
  const parseUsage = dependencies.parseUsage ?? parseOpencodeUsageResponse;
  return {
    id: "opencode",
    async collect(context: ProviderAdapterContext<OpencodeAdapterDependencies>): Promise<ProviderNormalizedResult<"opencode">> {
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
        return parsed.ok ? createNormalizedProviderResult("opencode", parsed.record) : unavailable();
      } catch {
        return unavailable();
      }
    },
  };
}
