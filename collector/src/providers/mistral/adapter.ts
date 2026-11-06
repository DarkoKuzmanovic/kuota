import { readSessionCookie, type SessionCookieResult, type SessionCookieSpec } from "../firefox-cookies.js";
import { fetchSessionJson, type SessionFetchOptions, type SessionFetchResult } from "../session-fetch.js";
import { parseMistralUsageResponse } from "./usage.js";
import {
  createNormalizedProviderResult,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderNormalizedResult,
} from "../types.js";

export const MISTRAL_BUDGET_ENDPOINT = "https://admin.mistral.ai/api/billing/v2/budget" as const;

export const MISTRAL_COOKIE_SPEC: SessionCookieSpec = {
  hosts: [".mistral.ai", "admin.mistral.ai", "console.mistral.ai", "chat.mistral.ai"],
  namePattern: "ory_session_%",
  envKey: "MISTRAL_SESSION_COOKIE",
};

export interface MistralAdapterDependencies extends Readonly<Record<string, unknown>> {
  readonly readCookie?: (signal: AbortSignal) => Promise<SessionCookieResult>;
  readonly fetchJson?: (options: SessionFetchOptions) => Promise<SessionFetchResult>;
  readonly now?: () => number;
}

function result(state: "auth-needed" | "error"): ProviderNormalizedResult<"mistral"> {
  return createNormalizedProviderResult("mistral", state === "auth-needed"
    ? { id: "mistral", state, status: "Authentication required" }
    : { id: "mistral", state, status: "Provider unavailable" });
}

/** One cookie read, one bounded budget request, no retries or writes. */
export function createMistralAdapter(
  dependencies: MistralAdapterDependencies = {},
): ProviderAdapter<"mistral", MistralAdapterDependencies> {
  const readCookie = dependencies.readCookie ?? ((signal: AbortSignal) =>
    readSessionCookie(MISTRAL_COOKIE_SPEC, { environment: process.env, signal }));
  const fetchJson = dependencies.fetchJson ?? fetchSessionJson;
  const now = dependencies.now ?? Date.now;
  return {
    id: "mistral",
    async collect(context: ProviderAdapterContext<MistralAdapterDependencies>): Promise<ProviderNormalizedResult<"mistral">> {
      try {
        const cookie = await readCookie(context.signal);
        if (cookie.state !== "available") return result(cookie.state === "auth-needed" ? "auth-needed" : "error");
        const fetched = await fetchJson({ url: MISTRAL_BUDGET_ENDPOINT, headers: { Cookie: cookie.cookie }, signal: context.signal });
        if (fetched.outcome !== "ok") return result(fetched.outcome === "auth-needed" ? "auth-needed" : "error");
        const parsed = parseMistralUsageResponse(fetched.value, new Date(now()).toISOString());
        return parsed.ok ? createNormalizedProviderResult("mistral", parsed.record) : result("error");
      } catch {
        return result("error");
      }
    },
  };
}
