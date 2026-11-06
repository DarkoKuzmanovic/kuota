import { copyFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { defaultRunSqlite, type CursorSqliteRunner } from "./cursor/auth.js";

/** Which session cookies a browser-session provider needs (constants only; they become SQL). */
export interface SessionCookieSpec {
  readonly hosts: readonly string[];
  /** SQL LIKE pattern over cookie names. */
  readonly namePattern: string;
  /** Env var holding a full `Cookie` header value, used when Firefox has no session. */
  readonly envKey: string;
}

export type SessionCookieResult =
  | { readonly state: "available"; readonly cookie: string }
  | { readonly state: "auth-needed" }
  | { readonly state: "error"; readonly reason: "sqlite-unavailable" | "sqlite-failed" };

export interface SessionCookieOptions {
  readonly signal?: AbortSignal;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runSqlite?: CursorSqliteRunner;
  readonly tempRoot?: string;
}

const SAFE_SQL_TOKEN = /^[A-Za-z0-9._%-]+$/;
// A Cookie header value: printable ASCII without CR/LF (fetch rejects anything else anyway).
const SAFE_COOKIE = /^[\x20-\x7e]+$/;

/** The profile whose cookies.sqlite changed most recently is taken as the active one. */
async function newestCookiesDb(homeDirectory: string): Promise<string | undefined> {
  const root = join(homeDirectory, ".mozilla", "firefox");
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return undefined;
  }
  let best: { readonly path: string; readonly mtimeMs: number } | undefined;
  for (const name of names) {
    const path = join(root, name, "cookies.sqlite");
    try {
      const info = await stat(path);
      if (info.isFile() && (best === undefined || info.mtimeMs > best.mtimeMs)) best = { path, mtimeMs: info.mtimeMs };
    } catch {
      // profile without a cookie store
    }
  }
  return best?.path;
}

function query(spec: SessionCookieSpec): string | undefined {
  if (!spec.hosts.every((host) => SAFE_SQL_TOKEN.test(host)) || !SAFE_SQL_TOKEN.test(spec.namePattern)) return undefined;
  const hosts = spec.hosts.map((host) => `'${host}'`).join(",");
  return "SELECT name || char(9) || value FROM moz_cookies " +
    `WHERE host IN (${hosts}) AND name LIKE '${spec.namePattern}' ` +
    "AND (expiry = 0 OR expiry > strftime('%s','now')) ORDER BY name;";
}

function toCookieHeader(stdout: string): string | undefined {
  const pairs: string[] = [];
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0 || tab === line.length - 1) continue;
    const pair = `${line.slice(0, tab)}=${line.slice(tab + 1)}`;
    if (SAFE_COOKIE.test(pair)) pairs.push(pair);
  }
  return pairs.length === 0 ? undefined : pairs.join("; ");
}

type FirefoxRead = { readonly kind: "cookie"; readonly cookie: string } | { readonly kind: "missing" }
  | { readonly kind: "sqlite-unavailable" } | { readonly kind: "failed" };

/**
 * Firefox keeps cookies.sqlite under an exclusive lock, so the store (+ WAL) is copied into a
 * fresh 0700 temp dir, queried read-only for this provider's cookies, and always deleted.
 */
async function readFirefox(spec: SessionCookieSpec, options: SessionCookieOptions): Promise<FirefoxRead> {
  const sql = query(spec);
  if (sql === undefined) return { kind: "failed" };
  const dbPath = await newestCookiesDb(options.homeDirectory ?? homedir());
  if (dbPath === undefined) return { kind: "missing" };
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), "kuota-cookies-"));
    const copy = join(dir, "cookies.sqlite");
    await copyFile(dbPath, copy);
    try {
      await copyFile(`${dbPath}-wal`, `${copy}-wal`);
    } catch {
      // no WAL: the main file is current
    }
    const result = await (options.runSqlite ?? defaultRunSqlite)(["-readonly", copy, sql], options.signal);
    if (result.terminated === true) return { kind: "failed" };
    if (result.code === 127) return { kind: "sqlite-unavailable" };
    if (result.code !== 0) return { kind: "failed" };
    const cookie = toCookieHeader(result.stdout);
    return cookie === undefined ? { kind: "missing" } : { kind: "cookie", cookie };
  } catch {
    return { kind: "failed" };
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Firefox session first, then the provider's env var; never persisted, never refreshed. */
export async function readSessionCookie(
  spec: SessionCookieSpec,
  options: SessionCookieOptions = {},
): Promise<SessionCookieResult> {
  const firefox = await readFirefox(spec, options);
  if (firefox.kind === "cookie") return { state: "available", cookie: firefox.cookie };
  const env = options.environment?.[spec.envKey]?.trim();
  if (env !== undefined && env.length > 0 && SAFE_COOKIE.test(env)) return { state: "available", cookie: env };
  if (firefox.kind === "sqlite-unavailable") return { state: "error", reason: "sqlite-unavailable" };
  if (firefox.kind === "failed") return { state: "error", reason: "sqlite-failed" };
  return { state: "auth-needed" };
}
