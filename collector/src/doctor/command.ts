import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_COLLECTOR_CONFIG } from "../collect/config.js";
import { resolveCollectorLockPath } from "../collect/lock.js";
import { readCollectorCache } from "../collect/cache.js";
import { PROVIDER_IDS, SCHEMA_VERSION, type ProviderId } from "../contract/schema-v1.js";
import { resolveKuotaCredentialsPath } from "../credentials/store.js";
import { readJsonFile } from "../io/json-file.js";
import { readClaudeAuth } from "../providers/claude/auth.js";
import { readClaudeCache } from "../providers/claude/cache.js";
import { readClaudeBackoff } from "../providers/claude/backoff.js";
import { readCodexAuth } from "../providers/codex/auth.js";
import { readGrokAuth } from "../providers/grok/auth.js";
import { readKimiAuth } from "../providers/kimi/auth.js";
import { defaultRunSqlite, readCursorAuth, type CursorSqliteRunner } from "../providers/cursor/auth.js";
import { readOpencodeAuth } from "../providers/opencode/auth.js";
import { readCommandCodeAuth } from "../providers/commandcode/auth.js";
import { readSessionCookie, type SessionCookieSpec } from "../providers/firefox-cookies.js";
import { MISTRAL_COOKIE_SPEC } from "../providers/mistral/adapter.js";
import { OPENDESIGN_COOKIE_SPEC } from "../providers/opendesign/adapter.js";
import { redact } from "../security/redact.js";

interface AuthResult {
  readonly state: string;
  readonly reason?: string;
  readonly credential?: unknown;
}
type Source = "Claude Code file" | "Codex CLI file" | "Kuota store" | "Cursor file" | "Firefox cookie" | "environment fallback";
type Classification = "present" | "missing" | "malformed" | "unsafe" | "expired" | "unavailable";
interface Diagnosis { readonly source: Source; readonly classification: Classification }
type Reader = (environment: Readonly<Record<string, string | undefined>>) => Promise<AuthResult>;

const HINTS: Readonly<Record<ProviderId, string>> = {
  claude: "sign in to Claude Code", codex: "run in a terminal: kuota login codex",
  grok: "run in a terminal: kuota login grok", kimi: "run in a terminal: kuota login kimi",
  cursor: "sign in to the Cursor app", opencode: "run in a terminal: kuota login opencode",
  commandcode: "run in a terminal: kuota login commandcode",
  mistral: "sign in at admin.mistral.ai in Firefox", opendesign: "sign in at open-design.ai in Firefox",
};

function advice(id: ProviderId, diagnosis: Diagnosis): string {
  switch (diagnosis.classification) {
    case "present": return "Local presence does not establish server acceptance.";
    case "unsafe": return "Check ownership, permissions and symlinks before using this source.";
    case "unavailable": return "Check local file access, SQLite and active WAL files; retry when safe.";
    case "expired": return diagnosis.source === "Kuota store"
      ? `Kuota may refresh its own login on collection; if that fails, ${HINTS[id]}.`
      : `${HINTS[id]}.`;
    case "malformed": return `Repair the local credential or ${HINTS[id]}.`;
    case "missing": return `${HINTS[id]}.`;
  }
}

function classify(result: AuthResult, now: number): Classification {
  if (result.state.startsWith("expired") || result.reason === "expired") return "expired";
  if (result.state === "available") {
    const credential = result.credential;
    return typeof credential === "object" && credential !== null && "expires" in credential &&
      typeof credential.expires === "number" && credential.expires <= now ? "expired" : "present";
  }
  if (result.reason?.includes("unsafe")) return "unsafe";
  if (result.reason?.includes("malformed") || result.reason === "wrong-type" || result.reason === "unsupported-entry" || result.reason === "auth-file-not-object") return "malformed";
  if (result.state === "error") return "unavailable";
  return "missing";
}

async function fallback(read: Reader, primary: Source, environment: Readonly<Record<string, string | undefined>>, now: number): Promise<Diagnosis> {
  const local = await read({});
  const actual = await read(environment);
  return actual.state === "available" && local.state !== "available"
    ? { source: "environment fallback", classification: classify(actual, now) }
    : { source: primary, classification: classify(actual, now) };
}

async function browserCookie(spec: SessionCookieSpec, home: string, environment: Readonly<Record<string, string | undefined>>, now: number): Promise<Diagnosis> {
  const local = await readSessionCookie(spec, { homeDirectory: home, environment: {}, noWrites: true });
  if (local.state === "available" || local.state === "error") return { source: "Firefox cookie", classification: classify(local, now) };
  const actual = await readSessionCookie(spec, { homeDirectory: home, environment, noWrites: true });
  return { source: actual.state === "available" ? "environment fallback" : "Firefox cookie", classification: classify(actual, now) };
}

const readOnlySqlite: CursorSqliteRunner = async (args, signal) => {
  const path = args[1];
  if (path === undefined) return { code: 1, stdout: "", stderr: "", terminated: true };
  try {
    const db = await lstat(path);
    if (!db.isFile() || db.isSymbolicLink()) return { code: 1, stdout: "", stderr: "", terminated: true };
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { code: 1, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "", terminated: true };
  }
  try {
    await lstat(`${path}-wal`);
    return { code: 1, stdout: "", stderr: "", terminated: true };
  } catch (error: unknown) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) return { code: 1, stdout: "", stderr: "", terminated: true };
  }
  return defaultRunSqlite([args[0] ?? "-readonly", `${pathToFileURL(path).href}?immutable=1`, ...args.slice(2)], signal);
};

async function directory(path: string, mode: number, file: boolean): Promise<Classification> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (file ? !info.isFile() : !info.isDirectory()) || info.uid !== process.getuid?.() || (info.mode & 0o777) !== mode) return "unsafe";
    return "present";
  } catch (error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT" ? "missing" : "unavailable";
  }
}

async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

async function curlAvailable(path: string | undefined): Promise<boolean> {
  for (const entry of (path ?? "/usr/bin:/bin").split(":")) {
    if (await executable(join(entry || ".", "curl"))) return true;
  }
  return false;
}

async function nodeVersion(): Promise<boolean> {
  try { return Number(/^v(\d+)/.exec(execFileSync("/usr/bin/node", ["--version"], { encoding: "utf8", timeout: 2000 }))?.[1]) >= 20; } catch { return false; }
}

function age(timestamp: string | undefined, now: number): string {
  if (timestamp === undefined) return "unknown";
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? `${Math.max(0, Math.floor((now - ms) / 1000))}s ago` : "unknown";
}

async function versionFile(url: URL, nested: boolean): Promise<string | undefined> {
  try {
    const data = await readJsonFile(fileURLToPath(url));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
    const parent = nested ? data.KPlugin : data;
    if (typeof parent !== "object" || parent === null || Array.isArray(parent)) return undefined;
    const value = nested ? parent.Version : parent.version;
    return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function runDoctor(stdout: { write(chunk: string): void }, home = homedir(), environment: Readonly<Record<string, string | undefined>> = process.env, now = Date.now()): Promise<number> {
  const lines: string[] = ["Kuota doctor — offline local diagnostics", `Collector schema: ${SCHEMA_VERSION}`];
  let failed = false;
  const store = resolveKuotaCredentialsPath(home, environment);
  const cacheDir = join(home, ".cache", "kuota");
  const collectorVersion = await versionFile(new URL("../build-info.json", import.meta.url), false);
  const packageVersion = await versionFile(new URL("../../../../metadata.json", import.meta.url), true);
  lines.push(`Collector version: ${collectorVersion ?? "unavailable"}`);
  lines.push(`Package version: ${packageVersion ?? "unavailable"}`);
  if (collectorVersion !== undefined && packageVersion !== undefined && collectorVersion !== packageVersion) {
    lines.push("Version mismatch: rebuild and reinstall Kuota, then reload the widget.");
    failed = true;
  }
  for (const [label, ok] of [
    ["/usr/bin/node >=20", await nodeVersion()], ["/usr/bin/flock", await executable("/usr/bin/flock")],
    ["/usr/bin/sqlite3", await executable("/usr/bin/sqlite3")], ["curl", await curlAvailable(environment.PATH)],
  ] as const) {
    lines.push(`${label}: ${ok ? "present" : "missing or unsupported"}`);
    if (!ok) failed = true;
  }
  const configSafety = await directory(dirname(store), 0o700, false);
  const storeSafety = await directory(store, 0o600, true);
  for (const [label, result] of [
    ["Kuota cache directory (0700)", await directory(cacheDir, 0o700, false)],
    ["Kuota config directory (0700)", configSafety],
    ["Kuota credentials file (0600)", storeSafety],
  ] as const) {
    lines.push(`${label}: ${result}`);
    if (result !== "present") failed = true;
  }
  const lock = await directory(resolveCollectorLockPath(home), 0o600, true);
  lines.push(`Collector lock (0600): ${lock}${lock === "missing" ? " (created on collection)" : ""}`);
  if (lock === "unsafe" || lock === "unavailable") failed = true;

  const collector = await readCollectorCache({ homeDirectory: home });
  const claudeCache = await readClaudeCache({ homeDirectory: home });
  const backoff = await readClaudeBackoff({ homeDirectory: home });
  lines.push(`Collector cache: ${collector.state}; Claude cache: ${claudeCache.state}; cached observations are not the last refresh attempt.`);
  if (backoff.state === "available" && Date.parse(backoff.retryAt) > now) lines.push(`Claude backoff: ${Math.ceil((Date.parse(backoff.retryAt) - now) / 1000)}s remaining`);
  else lines.push(`Claude backoff: ${backoff.state === "error" ? "unavailable" : "not active"}`);

  const readers: Record<ProviderId, () => Promise<Diagnosis>> = {
    claude: async () => ({ source: "Claude Code file", classification: classify(await readClaudeAuth({ homeDirectory: home, now: () => now }), now) }),
    codex: async () => {
      let cliRead = false;
      const result = await readCodexAuth({ homeDirectory: home, environment, now: () => now, readJsonFile: async (path) => { if (path !== store) cliRead = true; return readJsonFile(path); } });
      return { source: cliRead && result.state === "available" ? "Codex CLI file" : "Kuota store", classification: classify(result, now) };
    },
    grok: () => fallback((env) => readGrokAuth({ authPath: store, environment: env }), "Kuota store", environment, now),
    kimi: () => fallback((env) => readKimiAuth({ authPath: store, environment: env }), "Kuota store", environment, now),
    opencode: () => fallback((env) => readOpencodeAuth({ authPath: store, environment: env }), "Kuota store", environment, now),
    commandcode: () => fallback((env) => readCommandCodeAuth({ authPath: store, environment: env }), "Kuota store", environment, now),
    cursor: () => fallback((env) => readCursorAuth({ homeDirectory: home, environment: env, runSqlite: readOnlySqlite }), "Cursor file", environment, now),
    mistral: () => browserCookie(MISTRAL_COOKIE_SPEC, home, environment, now),
    opendesign: () => browserCookie(OPENDESIGN_COOKIE_SPEC, home, environment, now),
  };
  for (const id of PROVIDER_IDS) {
    const enabled = DEFAULT_COLLECTOR_CONFIG.providers.some((provider) => provider.id === id && provider.enabled);
    const discovered = await readers[id]();
    const diagnosis = discovered.source === "Kuota store" && (configSafety === "unsafe" || storeSafety === "unsafe")
      ? { ...discovered, classification: "unsafe" as const }
      : discovered;
    if (enabled && diagnosis.classification !== "present") failed = true;
    lines.push(`${id} (${enabled ? "default" : "opt-in"}): ${diagnosis.source} — ${diagnosis.classification}. ${advice(id, diagnosis)}`);
    const record = collector.state === "available" ? collector.envelope.records.find((r) => r.id === id) : undefined;
    const cached = record ?? (id === "claude" && claudeCache.state === "available" ? claudeCache.record : undefined);
    if (cached !== undefined) lines.push(`  Last cached observation: ${cached.state}; last success ${age(cached.lastSuccessAt, now)}. Cached data may be stale; re-login will NOT help unless the state is auth-needed. Check for endpoint drift.`);
    else lines.push("  Last cached observation: unavailable; no success time known.");
  }
  for (const line of lines) {
    const safe = redact(line);
    stdout.write(`${typeof safe === "string" ? safe : "[REDACTED]"}\n`);
  }
  return failed ? 1 : 0;
}
