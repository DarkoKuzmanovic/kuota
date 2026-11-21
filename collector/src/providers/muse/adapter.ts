import { readSessionCookie, type SessionCookieResult, type SessionCookieSpec } from "../firefox-cookies.js";
import { fetchSessionJson, type SessionFetchOptions, type SessionFetchResult } from "../session-fetch.js";
import { createNormalizedProviderResult, type ProviderAdapter, type ProviderAdapterContext, type ProviderNormalizedResult } from "../types.js";
import { parseMuseUsageResponse } from "./usage.js";

const API_ORIGIN = "https://dev.meta.ai/api/portal/teams";
const MAX_TEAMS = 5;
export const MUSE_COOKIE_SPEC: SessionCookieSpec = {
  hosts: ["dev.meta.ai", ".dev.meta.ai", ".meta.ai", "meta.ai"],
  namePattern: "llama_dev_sess",
  envKey: "MUSE_SESSION_COOKIE",
};

export interface MuseAdapterDependencies extends Readonly<Record<string, unknown>> {
  readonly readCookie?: (signal: AbortSignal) => Promise<SessionCookieResult>;
  readonly fetchJson?: (options: SessionFetchOptions) => Promise<SessionFetchResult>;
  readonly now?: () => number;
}

function result(state: "auth-needed" | "error", status?: string): ProviderNormalizedResult<"muse"> {
  return createNormalizedProviderResult("muse", { id: "muse", state, status: status ?? (state === "auth-needed" ? "Authentication required" : "Provider unavailable") });
}

function teamId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
  return /^\d{1,32}$/.test(id) ? id : undefined;
}

/** At most five quota probes, all required to rule out multiple subscriptions. */
export function createMuseAdapter(dependencies: MuseAdapterDependencies = {}): ProviderAdapter<"muse", MuseAdapterDependencies> {
  const readCookie = dependencies.readCookie ?? ((signal: AbortSignal) => readSessionCookie(MUSE_COOKIE_SPEC, { environment: process.env, signal }));
  const fetchJson = dependencies.fetchJson ?? fetchSessionJson;
  const now = dependencies.now ?? Date.now;
  return {
    id: "muse",
    async collect(context: ProviderAdapterContext<MuseAdapterDependencies>): Promise<ProviderNormalizedResult<"muse">> {
      try {
        const cookie = await readCookie(context.signal);
        if (cookie.state !== "available") return result(cookie.state === "auth-needed" ? "auth-needed" : "error");
        const headers = { Cookie: cookie.cookie };
        const teams = await fetchJson({ url: API_ORIGIN, headers, signal: context.signal });
        if (teams.outcome !== "ok") return result(teams.outcome === "auth-needed" ? "auth-needed" : "error");
        const value = teams.value;
        if (typeof value !== "object" || value === null || !("teams" in value) || !Array.isArray(value.teams)) return result("error");
        if (value.teams.length === 0) return result("error", "No team");
        if (value.teams.length > MAX_TEAMS) return result("error");
        const ids: string[] = [];
        for (const entry of value.teams) {
          if (typeof entry !== "object" || entry === null || !("team_id" in entry)) return result("error");
          const id = teamId(entry.team_id);
          if (id === undefined || ids.includes(id)) return result("error");
          ids.push(id);
        }
        const probes = await Promise.all(ids.map((id) => fetchJson({ url: `${API_ORIGIN}/${id}/subscription-quota`, headers, signal: context.signal })));
        if (probes.some((probe) => probe.outcome === "auth-needed")) return result("auth-needed");
        if (probes.some((probe) => probe.outcome !== "ok")) return result("error");
        let selected: unknown;
        for (const probe of probes) {
          if (probe.outcome !== "ok") return result("error");
          const payload = probe.value;
          if (typeof payload !== "object" || payload === null || !("subscription_quota" in payload)) return result("error");
          if (payload.subscription_quota === null) continue;
          if (typeof payload.subscription_quota !== "object" || Array.isArray(payload.subscription_quota) || selected !== undefined) return result("error");
          selected = payload;
        }
        if (selected === undefined) return result("error");
        const parsed = parseMuseUsageResponse(selected, new Date(now()).toISOString());
        return parsed.ok ? createNormalizedProviderResult("muse", parsed.record) : result("error");
      } catch {
        return result("error");
      }
    },
  };
}
