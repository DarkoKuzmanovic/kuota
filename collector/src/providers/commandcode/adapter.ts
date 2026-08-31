import { homedir } from "node:os";

import {
  readCommandCodeAuth,
  resolveCommandCodeAuthPath,
  type CommandCodeAuthResult,
} from "./auth.js";
import {
  fetchCommandCodeJson,
  COMMANDCODE_CREDITS_ENDPOINT,
  COMMANDCODE_SUBSCRIPTION_ENDPOINT,
  type CommandCodeFetchResult,
} from "./fetch.js";
import {
  commandCodePlanName,
  parseCommandCodeUsageResponse,
  type CommandCodeUsageParseResult,
} from "./usage.js";
import {
  createNormalizedProviderResult,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderNormalizedResult,
} from "../types.js";

export interface CommandCodeAdapterDependencies extends Readonly<Record<string, unknown>> {
  readonly resolveAuthPath?: () => string;
  readonly readAuth?: (options: { readonly authPath: string }) => Promise<CommandCodeAuthResult>;
  readonly fetchUsage?: (options: { readonly credential: Extract<CommandCodeAuthResult, { readonly state: "available" }> ["credential"]; readonly signal: AbortSignal }) => Promise<CommandCodeFetchResult>;
  readonly fetchSubscription?: (options: { readonly credential: Extract<CommandCodeAuthResult, { readonly state: "available" }> ["credential"]; readonly signal: AbortSignal }) => Promise<CommandCodeFetchResult>;
  readonly parseUsage?: (payload: unknown, observedAt: string, planName?: string) => CommandCodeUsageParseResult;
  readonly now?: () => number;
}

function authNeeded(): ProviderNormalizedResult<"commandcode"> {
  return createNormalizedProviderResult("commandcode", { id: "commandcode", state: "auth-needed", status: "Authentication required" });
}

function unavailable(): ProviderNormalizedResult<"commandcode"> {
  return createNormalizedProviderResult("commandcode", { id: "commandcode", state: "error", status: "Provider unavailable" });
}

function safeTimestamp(now: () => number): string | undefined {
  try { const value = now(); return Number.isFinite(value) ? new Date(value).toISOString() : undefined; } catch { return undefined; }
}

/**
 * CommandCode policy: one auth read, one required credits request, then at
 * most one optional subscriptions request; no retries or writes.
 */
export function createCommandCodeAdapter(
  dependencies: CommandCodeAdapterDependencies = {},
): ProviderAdapter<"commandcode", CommandCodeAdapterDependencies> {
  const now = dependencies.now ?? Date.now;
  const resolveAuthPath = dependencies.resolveAuthPath ?? (() => resolveCommandCodeAuthPath(homedir()));
  const readAuth = dependencies.readAuth ?? ((options: { readonly authPath: string }) =>
    readCommandCodeAuth({ authPath: options.authPath, environment: process.env }));
  const fetchUsage = dependencies.fetchUsage ?? ((options: { readonly credential: Extract<CommandCodeAuthResult, { readonly state: "available" }> ["credential"]; readonly signal: AbortSignal }) =>
    fetchCommandCodeJson({ credential: options.credential, signal: options.signal, endpoint: COMMANDCODE_CREDITS_ENDPOINT }));
  const fetchSubscription = dependencies.fetchSubscription ?? ((options: { readonly credential: Extract<CommandCodeAuthResult, { readonly state: "available" }> ["credential"]; readonly signal: AbortSignal }) =>
    fetchCommandCodeJson({ credential: options.credential, signal: options.signal, endpoint: COMMANDCODE_SUBSCRIPTION_ENDPOINT }));
  const parseUsage = dependencies.parseUsage ?? parseCommandCodeUsageResponse;
  return {
    id: "commandcode",
    async collect(context: ProviderAdapterContext<CommandCodeAdapterDependencies>): Promise<ProviderNormalizedResult<"commandcode">> {
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

        let planName: string | undefined;
        const subscription = await fetchSubscription({ credential: auth.credential, signal: context.signal });
        if (subscription.outcome === "ok" && isPlanRecord(subscription.value)) {
          planName = commandCodePlanName(subscription.value.data.planId);
        }
        // Any subscription failure is ignored: the credits record stands alone.

        const parsed = parseUsage(fetched.value, observedAt, planName);
        return parsed.ok ? createNormalizedProviderResult("commandcode", parsed.record) : unavailable();
      } catch {
        return unavailable();
      }
    },
  };
}

function isPlanRecord(value: unknown): value is { readonly data: { readonly planId: unknown } } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "data" in value && typeof value.data === "object" && value.data !== null && !Array.isArray(value.data) &&
    "planId" in value.data;
}
