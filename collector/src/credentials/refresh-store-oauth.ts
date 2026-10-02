import {
  persistCodexRefreshedAuth,
  type CodexPersistOptions,
  type CodexPersistOutcome,
} from "../providers/codex/persist.js";
import {
  refreshCodexOAuth,
  type CodexRefreshOptions,
  type CodexRefreshResult,
} from "../providers/codex/refresh.js";

export type RefreshStoreOAuthResult =
  | { readonly state: "ok"; readonly access: string }
  | { readonly state: "auth-needed" }
  | { readonly state: "error" };

export interface RefreshStoreOAuthOptions {
  readonly id: "grok" | "kimi";
  readonly client: { readonly tokenEndpoint: string; readonly clientId: string };
  readonly storePath: string;
  readonly credential: { readonly value: string; readonly refresh?: string; readonly expires?: number };
  readonly now: () => number;
  readonly signal: AbortSignal;
  readonly refresh?: (options: CodexRefreshOptions) => Promise<CodexRefreshResult>;
  readonly persist?: (options: CodexPersistOptions) => Promise<CodexPersistOutcome>;
}

/**
 * Refreshes a Kuota-store OAuth login once when it has expired, persisting the
 * result into its own store entry with the latest-read CAS merge. Only store
 * logins carry `refresh`, so env tokens and other tools' logins never reach the
 * refresh call. ponytail: refresh-on-expiry only; add refresh-on-401 if a
 * provider revokes before `expires`.
 */
export async function refreshStoreOAuthIfExpired(
  options: RefreshStoreOAuthOptions,
): Promise<RefreshStoreOAuthResult> {
  try {
    const { credential } = options;
    if (credential.refresh === undefined || credential.expires === undefined || credential.expires > options.now()) {
      return { state: "ok", access: credential.value };
    }
    const refreshed = await (options.refresh ?? refreshCodexOAuth)({
      refreshToken: credential.refresh,
      client: options.client,
      signal: options.signal,
      now: options.now,
    });
    if (refreshed.outcome === "auth-needed") return { state: "auth-needed" };
    if (refreshed.outcome !== "ok") return { state: "error" };

    const persisted = await (options.persist ?? persistCodexRefreshedAuth)({
      authPath: options.storePath,
      entryKey: options.id,
      initiatingCredential: { access: credential.value, refresh: credential.refresh, expires: credential.expires },
      refreshedCredential: refreshed.credential,
    });
    if (persisted !== "updated" && persisted !== "already-current") return { state: "error" };
    return { state: "ok", access: refreshed.credential.access };
  } catch {
    return { state: "error" };
  }
}
