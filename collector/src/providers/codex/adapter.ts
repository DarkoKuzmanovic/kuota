import { homedir } from "node:os";

import {
  readCodexAuth,
  resolveCodexAuthPath,
  type CodexAuthClock,
  type CodexAuthResult,
  type CodexOAuthCredential,
} from "./auth.js";
import { curlCodexUsage, type CodexCurlResult } from "./curl.js";
import { fetchCodexUsage, type CodexFetchResult } from "./fetch.js";
import {
  persistCodexRefreshedAuth,
  type CodexPersistOutcome,
} from "./persist.js";
import {
  refreshCodexOAuth,
  type CodexRefreshedCredential,
  type CodexRefreshResult,
} from "./refresh.js";
import {
  parseCodexUsageResponse,
  type CodexUsageParseResult,
} from "./usage.js";
import {
  createNormalizedProviderResult,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderNormalizedResult,
} from "../types.js";

export interface CodexAdapterDependencies extends Readonly<Record<string, unknown>> {
  readonly resolveAuthPath?: () => string;
  readonly readAuth?: (options: {
    readonly authPath: string;
    readonly now: CodexAuthClock;
  }) => Promise<CodexAuthResult>;
  readonly fetchUsage?: (options: {
    readonly credential: CodexOAuthCredential;
    readonly signal: AbortSignal;
  }) => Promise<CodexFetchResult>;
  readonly curlUsage?: (options: {
    readonly credential: CodexOAuthCredential;
    readonly signal: AbortSignal;
  }) => Promise<CodexCurlResult>;
  readonly refresh?: (options: {
    readonly refreshToken: string;
    readonly signal: AbortSignal;
    readonly now: CodexAuthClock;
  }) => Promise<CodexRefreshResult>;
  readonly persist?: (options: {
    readonly authPath: string;
    readonly initiatingCredential: CodexOAuthCredential;
    readonly refreshedCredential: CodexRefreshedCredential;
  }) => Promise<CodexPersistOutcome>;
  readonly parseUsage?: (
    payload: unknown,
    observedAt: string,
  ) => CodexUsageParseResult;
  readonly now?: CodexAuthClock;
}

type UsagePipelineResult =
  | { readonly state: "ok"; readonly record: ProviderNormalizedResult<"codex"> }
  | { readonly state: "auth-needed" }
  | { readonly state: "refresh-eligible" }
  | { readonly state: "error" };

/**
 * Policy-owning finite Codex adapter. Mechanism seams remain isolated in their
 * own modules; this layer permits one refresh and one final usage pipeline.
 */
export function createCodexAdapter(
  dependencies: CodexAdapterDependencies = {},
): ProviderAdapter<"codex", CodexAdapterDependencies> {
  const now = dependencies.now ?? Date.now;
  // Keep home/path lookup inside collect: registration/default creation is inert.
  const resolveAuthPath = dependencies.resolveAuthPath ??
    (() => resolveCodexAuthPath(homedir()));
  const readAuth = dependencies.readAuth ??
    ((options: { readonly authPath: string; readonly now: CodexAuthClock }) =>
      readCodexAuth({ authPath: options.authPath, now: options.now }));
  const fetchUsage = dependencies.fetchUsage ??
    ((options: { readonly credential: CodexOAuthCredential; readonly signal: AbortSignal }) =>
      fetchCodexUsage(options));
  const curlUsage = dependencies.curlUsage ??
    ((options: { readonly credential: CodexOAuthCredential; readonly signal: AbortSignal }) =>
      curlCodexUsage(options));
  const refresh = dependencies.refresh ??
    ((options: { readonly refreshToken: string; readonly signal: AbortSignal; readonly now: CodexAuthClock }) =>
      refreshCodexOAuth(options));
  const persist = dependencies.persist ??
    ((options: {
      readonly authPath: string;
      readonly initiatingCredential: CodexOAuthCredential;
      readonly refreshedCredential: CodexRefreshedCredential;
    }) => persistCodexRefreshedAuth(options));
  const parseUsage = dependencies.parseUsage ?? parseCodexUsageResponse;

  return {
    id: "codex",
    async collect(context: ProviderAdapterContext<CodexAdapterDependencies>): Promise<ProviderNormalizedResult<"codex">> {
      try {
        const authPath = safeResolve(resolveAuthPath);
        if (authPath === undefined) return errorResult();
        const auth = await safeCall(() => readAuth({ authPath, now }));
        if (auth === undefined || auth.state === "error") return errorResult();
        if (auth.state === "auth-needed" || auth.state === "expired-without-refresh") {
          return authNeededResult();
        }

        if (auth.state === "expired-with-refresh") {
          return refreshThenUse(authPath, auth.credential, context, now, refresh, persist, fetchUsage, curlUsage, parseUsage);
        }

        const firstUsage = await runUsagePipeline(auth.credential, context.signal, now, fetchUsage, curlUsage, parseUsage);
        if (firstUsage.state === "ok") return firstUsage.record;
        if (firstUsage.state === "error") return errorResult();
        if (firstUsage.state === "auth-needed") return authNeededResult();
        if (!hasRefresh(auth.credential)) return authNeededResult();
        return refreshThenUse(authPath, auth.credential, context, now, refresh, persist, fetchUsage, curlUsage, parseUsage);
      } catch {
        return errorResult();
      }
    },
  };
}

async function refreshThenUse(
  authPath: string,
  initiatingCredential: CodexOAuthCredential & { readonly refresh: string },
  context: ProviderAdapterContext<CodexAdapterDependencies>,
  now: CodexAuthClock,
  refresh: CodexAdapterDependencies["refresh"] extends infer T ? Exclude<T, undefined> : never,
  persist: CodexAdapterDependencies["persist"] extends infer T ? Exclude<T, undefined> : never,
  fetchUsage: CodexAdapterDependencies["fetchUsage"] extends infer T ? Exclude<T, undefined> : never,
  curlUsage: CodexAdapterDependencies["curlUsage"] extends infer T ? Exclude<T, undefined> : never,
  parseUsage: CodexAdapterDependencies["parseUsage"] extends infer T ? Exclude<T, undefined> : never,
): Promise<ProviderNormalizedResult<"codex">> {
  const refreshed = await safeCall(() => refresh({
    refreshToken: initiatingCredential.refresh,
    signal: context.signal,
    now,
  }));
  if (refreshed === undefined || refreshed.outcome === "error") return errorResult();
  if (refreshed.outcome === "auth-needed") return authNeededResult();

  const persisted = await safeCall(() => persist({
    authPath,
    initiatingCredential,
    refreshedCredential: refreshed.credential,
  }));
  if (persisted !== "updated" && persisted !== "already-current") return errorResult();

  const usageCredential: CodexOAuthCredential = {
    access: refreshed.credential.access,
    accountId: initiatingCredential.accountId,
    refresh: refreshed.credential.refresh ?? initiatingCredential.refresh,
    ...(refreshed.credential.expires === undefined && initiatingCredential.expires === undefined
      ? {}
      : { expires: refreshed.credential.expires ?? initiatingCredential.expires }),
  };
  const finalUsage = await runUsagePipeline(usageCredential, context.signal, now, fetchUsage, curlUsage, parseUsage);
  if (finalUsage.state === "ok") return finalUsage.record;
  if (finalUsage.state === "auth-needed" || finalUsage.state === "refresh-eligible") {
    return authNeededResult();
  }
  return errorResult();
}

async function runUsagePipeline(
  credential: CodexOAuthCredential,
  signal: AbortSignal,
  now: CodexAuthClock,
  fetchUsage: CodexAdapterDependencies["fetchUsage"] extends infer T ? Exclude<T, undefined> : never,
  curlUsage: CodexAdapterDependencies["curlUsage"] extends infer T ? Exclude<T, undefined> : never,
  parseUsage: CodexAdapterDependencies["parseUsage"] extends infer T ? Exclude<T, undefined> : never,
): Promise<UsagePipelineResult> {
  const native = await safeCall(() => fetchUsage({ credential, signal }));
  if (native === undefined || native.outcome === "error") return { state: "error" };
  if (native.outcome === "auth-needed") return { state: "auth-needed" };
  if (native.outcome === "ok") return normalizePayload(native.value, now, parseUsage);

  const curl = await safeCall(() => curlUsage({ credential, signal }));
  if (curl === undefined || curl.outcome === "error") return { state: "error" };
  if (curl.outcome === "auth-needed") return { state: "refresh-eligible" };
  return normalizePayload(curl.value, now, parseUsage);
}

function normalizePayload(
  payload: unknown,
  now: CodexAuthClock,
  parseUsage: CodexAdapterDependencies["parseUsage"] extends infer T ? Exclude<T, undefined> : never,
): UsagePipelineResult {
  const observedAt = safeTimestamp(now);
  if (observedAt === undefined) return { state: "error" };
  try {
    const parsed = parseUsage(payload, observedAt);
    if (!parsed.ok) return { state: "error" };
    return { state: "ok", record: createNormalizedProviderResult("codex", parsed.record) };
  } catch {
    return { state: "error" };
  }
}

function safeResolve(resolve: () => string): string | undefined {
  try {
    const path = resolve();
    return typeof path === "string" && path.length > 0 ? path : undefined;
  } catch {
    return undefined;
  }
}

function hasRefresh(
  credential: CodexOAuthCredential,
): credential is CodexOAuthCredential & { readonly refresh: string } {
  return typeof credential.refresh === "string" && credential.refresh.length > 0;
}

async function safeCall<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch {
    return undefined;
  }
}

function safeTimestamp(clock: CodexAuthClock): string | undefined {
  try {
    const value = clock();
    if (!Number.isFinite(value)) return undefined;
    return new Date(value).toISOString();
  } catch {
    return undefined;
  }
}

function authNeededResult(): ProviderNormalizedResult<"codex"> {
  return createNormalizedProviderResult("codex", {
    id: "codex",
    state: "auth-needed",
    status: "Authentication required",
  });
}

function errorResult(): ProviderNormalizedResult<"codex"> {
  return createNormalizedProviderResult("codex", {
    id: "codex",
    state: "error",
    status: "Provider unavailable",
  });
}
