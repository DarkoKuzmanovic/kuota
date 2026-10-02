import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { ensureKuotaCacheDirectory } from "../io/cache-directory.js";
import { readJsonFile, updateJsonFile, type JsonObject } from "../io/json-file.js";

/**
 * Kuota's own credential store (spec 2026-10-02-standalone-credentials-design.md).
 * A flat JSON object keyed by Kuota provider id. Entries are
 * `{ type: "oauth", access, refresh?, expires?, accountId? }` or
 * `{ type: "api_key", key }`. Only the collector reads it; values never leave it.
 */
export type CredentialEntry = JsonObject;

export function resolveKuotaCredentialsPath(
  homeDirectory: string = homedir(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const xdg = environment.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.length > 0 && isAbsolute(xdg) ? xdg : join(homeDirectory, ".config");
  return join(base, "kuota", "credentials.json");
}

/**
 * Optional OAuth refresh material from a plain store entry; malformed values
 * are dropped so the entry is simply treated as non-refreshable.
 */
export function refreshFields(entry: object): { refresh?: string; expires?: number } {
  const own = (key: string): unknown => Object.getOwnPropertyDescriptor(entry, key)?.value;
  const refresh = own("refresh");
  const expires = own("expires");
  return {
    ...(typeof refresh === "string" && refresh.trim().length > 0 ? { refresh } : {}),
    ...(typeof expires === "number" && Number.isFinite(expires) ? { expires } : {}),
  };
}

/** Reads the store; undefined when absent. Throws value-free JsonFileError otherwise. */
export async function readCredentialStore(path: string): Promise<unknown> {
  return readJsonFile(path);
}

async function update(path: string, change: (latest: JsonObject) => JsonObject): Promise<void> {
  // ponytail: the cache-directory helper is generic — trusted parent, 0700 child, no recursion.
  await ensureKuotaCacheDirectory(dirname(path));
  // "new-cache" forces 0600 on every write, even if the user loosened the mode.
  await updateJsonFile(path, change, { policy: "new-cache" });
}

/** Latest-read atomic merge of one provider entry; other providers are preserved. */
export function writeCredentialEntry(path: string, id: string, entry: CredentialEntry): Promise<void> {
  return update(path, (latest) => ({ ...latest, [id]: entry }));
}

export async function removeCredentialEntry(path: string, id: string): Promise<void> {
  if ((await readCredentialStore(path)) === undefined) return;
  await update(path, (latest) => {
    const next: Record<string, JsonObject[string]> = { ...latest };
    delete next[id];
    return next;
  });
}
