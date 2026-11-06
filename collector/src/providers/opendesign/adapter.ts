import { readSessionCookie, type SessionCookieResult, type SessionCookieSpec } from "../firefox-cookies.js";
import { fetchSessionJson, type SessionFetchOptions, type SessionFetchResult } from "../session-fetch.js";
import { parseOpenDesignUsageResponse } from "./usage.js";
import {
  createNormalizedProviderResult,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderNormalizedResult,
} from "../types.js";

export const OPENDESIGN_API_ORIGIN = "https://amr-api.open-design.ai/api/v1" as const;

export const OPENDESIGN_COOKIE_SPEC: SessionCookieSpec = {
  hosts: ["amr-api.open-design.ai", ".amr-api.open-design.ai", ".open-design.ai", "open-design.ai"],
  namePattern: "__Secure-better-auth.session%",
  envKey: "OPENDESIGN_COOKIE",
};

export interface OpenDesignAdapterDependencies extends Readonly<Record<string, unknown>> {
  readonly readCookie?: (signal: AbortSignal) => Promise<SessionCookieResult>;
  readonly fetchJson?: (options: SessionFetchOptions) => Promise<SessionFetchResult>;
  readonly now?: () => number;
}

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function result(state: "auth-needed" | "error"): ProviderNormalizedResult<"opendesign"> {
  return createNormalizedProviderResult("opendesign", state === "auth-needed"
    ? { id: "opendesign", state, status: "Authentication required" }
    : { id: "opendesign", state, status: "Provider unavailable" });
}

/**
 * One cookie read, then three bounded GETs: current workspace → coding-plan usage (required)
 * → wallet balance (optional). The workspace ID only travels in the request; it is never emitted.
 */
export function createOpenDesignAdapter(
  dependencies: OpenDesignAdapterDependencies = {},
): ProviderAdapter<"opendesign", OpenDesignAdapterDependencies> {
  const readCookie = dependencies.readCookie ?? ((signal: AbortSignal) =>
    readSessionCookie(OPENDESIGN_COOKIE_SPEC, { environment: process.env, signal }));
  const fetchJson = dependencies.fetchJson ?? fetchSessionJson;
  const now = dependencies.now ?? Date.now;
  return {
    id: "opendesign",
    async collect(context: ProviderAdapterContext<OpenDesignAdapterDependencies>): Promise<ProviderNormalizedResult<"opendesign">> {
      try {
        const cookie = await readCookie(context.signal);
        if (cookie.state !== "available") return result(cookie.state === "auth-needed" ? "auth-needed" : "error");
        const headers: Record<string, string> = { Cookie: cookie.cookie, Origin: "https://open-design.ai", Referer: "https://open-design.ai/" };
        const current = await fetchJson({ url: `${OPENDESIGN_API_ORIGIN}/workspaces/current`, headers, signal: context.signal });
        if (current.outcome !== "ok") return result(current.outcome === "auth-needed" ? "auth-needed" : "error");
        const value = current.value;
        const workspaceId = typeof value === "object" && value !== null && "activeWorkspaceId" in value ? value.activeWorkspaceId : undefined;
        if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) return result("error");
        const scoped = { ...headers, "x-vela-workspace-id": workspaceId };
        const base = `${OPENDESIGN_API_ORIGIN}/workspaces/${workspaceId}`;
        const [usage, wallet] = await Promise.all([
          fetchJson({ url: `${base}/billing/coding-plan-usage`, headers: scoped, signal: context.signal }),
          fetchJson({ url: `${base}/wallet/balance`, headers: scoped, signal: context.signal }),
        ]);
        if (usage.outcome !== "ok") return result(usage.outcome === "auth-needed" ? "auth-needed" : "error");
        const parsed = parseOpenDesignUsageResponse(usage.value, wallet.outcome === "ok" ? wallet.value : undefined, new Date(now()).toISOString());
        return parsed.ok ? createNormalizedProviderResult("opendesign", parsed.record) : result("error");
      } catch {
        return result("error");
      }
    },
  };
}
