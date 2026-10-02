import { homedir } from "node:os";

import { GROK_OAUTH, KIMI_OAUTH } from "../credentials/oauth-clients.js";
import {
  readCredentialStore,
  removeCredentialEntry,
  resolveKuotaCredentialsPath,
  writeCredentialEntry,
  type CredentialEntry,
} from "../credentials/store.js";
import { CODEX_OAUTH_CLIENT_ID } from "../providers/codex/refresh.js";

/**
 * `kuota login|logout|status` — the human-facing account commands
 * (spec docs/specs/2026-10-02-standalone-credentials-design.md). This mode is
 * never launched by the widget, so the one-JSON-document stdout contract does
 * not apply. It still never prints a secret: only fixed messages, the device
 * verification URL/code, HTTP status numbers, and allowlisted error codes.
 */

const STORE_PROVIDERS = ["codex", "grok", "kimi", "opencode", "commandcode"] as const;
type StoreProvider = (typeof STORE_PROVIDERS)[number];
const KEY_PROVIDERS: ReadonlySet<StoreProvider> = new Set(["opencode", "commandcode", "kimi"]);
const DEVICE_PROVIDERS: ReadonlySet<StoreProvider> = new Set(["codex", "grok", "kimi"]);

const ENV_KEYS: Readonly<Record<string, string>> = {
  grok: "GROK_CLI_OAUTH_TOKEN",
  kimi: "KIMI_API_KEY",
  opencode: "OPENCODE_API_KEY",
  commandcode: "COMMANDCODE_API_KEY",
  cursor: "CURSOR_SESSION_TOKEN",
};

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_KEY_LENGTH = 4096;
const DEFAULT_DEVICE_TIMEOUT_S = 15 * 60;

const CODEX_DEVICE = {
  userCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  pollUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
  verificationUri: "https://auth.openai.com/codex/device",
  tokenUrl: "https://auth.openai.com/oauth/token",
  redirectUri: "https://auth.openai.com/deviceauth/callback",
} as const;

export type FetchSeam = (url: string, init: RequestInit) => Promise<Response>;

export interface AccountCommandIo {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
  readonly fetch?: FetchSeam;
  /** Reads one secret line without echo; never from argv. */
  readonly readSecret?: (prompt: string) => Promise<string>;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly storePath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

type Json = Record<string, unknown>;

/** Plain own-data copy of a parsed JSON object; anything else reads as empty. */
function record(value: unknown): Json {
  const out: Json = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const key of Object.keys(value)) out[key] = Object.getOwnPropertyDescriptor(value, key)?.value;
  return out;
}
type Poll =
  | { readonly status: "pending" }
  | { readonly status: "slow_down" }
  | { readonly status: "complete"; readonly entry: CredentialEntry }
  | { readonly status: "failed"; readonly message: string };

interface DeviceStart {
  readonly verificationUri: string;
  readonly userCode: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
  readonly poll: () => Promise<Poll>;
}

class LoginError extends Error {}

const USAGE = [
  "Usage:",
  "  kuota login <codex|grok|kimi>        Sign in with a browser code",
  "  kuota login <opencode|commandcode>   Store an API key (typed hidden, or piped on stdin)",
  "  kuota login kimi --api-key           Store a Kimi API key instead",
  "  kuota logout <provider>              Remove Kuota's stored login",
  "  kuota status                         Show which providers Kuota has a login for",
  "",
].join("\n");

export function isAccountCommand(argv: readonly string[]): boolean {
  return argv[0] === "login" || argv[0] === "logout" || argv[0] === "status";
}

function isStoreProvider(value: string | undefined): value is StoreProvider {
  return STORE_PROVIDERS.some((id) => id === value);
}

export async function runAccountCommand(argv: readonly string[], io: AccountCommandIo): Promise<number> {
  const environment = io.environment ?? process.env;
  const storePath = io.storePath ?? resolveKuotaCredentialsPath(homedir(), environment);
  const [command, provider, ...rest] = argv;
  try {
    if (command === "status" && provider === undefined) {
      await status(storePath, environment, io, (io.now ?? Date.now)());
      return 0;
    }
    if (!isStoreProvider(provider)) {
      io.stderr.write(provider === "claude" || provider === "cursor"
        ? `Kuota reads ${provider === "claude" ? "Claude Code's" : "the Cursor app's"} own login; sign in there.\n`
        : USAGE);
      return 2;
    }
    if (command === "logout" && rest.length === 0) {
      await removeCredentialEntry(storePath, provider);
      io.stdout.write(`Removed Kuota's ${provider} login.\n`);
      return 0;
    }
    if (command !== "login") {
      io.stderr.write(USAGE);
      return 2;
    }
    const wantsKey = rest.length === 1 && rest[0] === "--api-key" && KEY_PROVIDERS.has(provider);
    if (rest.length > 0 && !wantsKey) {
      // Anything extra might be a pasted secret: refuse without echoing it.
      io.stderr.write("API keys are never accepted as arguments (they would be visible in `ps`). Pipe them on stdin instead.\n");
      return 2;
    }
    const entry = DEVICE_PROVIDERS.has(provider) && !wantsKey
      ? await deviceLogin(provider, io)
      : KEY_PROVIDERS.has(provider)
        ? await keyLogin(provider, io)
        : undefined;
    if (entry === undefined) {
      io.stderr.write(USAGE);
      return 2;
    }
    await writeCredentialEntry(storePath, provider, entry);
    io.stdout.write(`Signed in: Kuota will use this ${provider} login on its next refresh.\n`);
    return 0;
  } catch (error: unknown) {
    io.stderr.write(error instanceof LoginError ? `${error.message}\n` : "Kuota could not complete the command.\n");
    return 1;
  }
}

async function status(
  storePath: string,
  environment: Readonly<Record<string, string | undefined>>,
  io: AccountCommandIo,
  now: number,
): Promise<void> {
  const store = record(await readCredentialStore(storePath));
  io.stdout.write(`Credential store: ${storePath}\n`);
  for (const id of ["claude", ...STORE_PROVIDERS, "cursor"]) {
    const entry = record(store[id]);
    const parts: string[] = [];
    if (Object.keys(entry).length > 0) {
      const type = entry.type;
      const expires = entry.expires;
      parts.push(type === "oauth" ? "kuota login" : type === "api_key" ? "kuota api key" : "kuota (unrecognized entry)");
      if (typeof expires === "number" && Number.isFinite(expires)) {
        parts.push(expires > now ? `expires ${new Date(expires).toISOString()}` : "expired (refreshes on next use)");
      }
    }
    if (id === "claude") parts.push("Claude Code login (read-only)");
    if (id === "codex") parts.push("Codex CLI login fallback (read-only)");
    if (id === "cursor") parts.push("Cursor app login (read-only)");
    const envKey = ENV_KEYS[id];
    if (envKey !== undefined && (environment[envKey] ?? "").trim().length > 0) parts.push(`${envKey} set`);
    io.stdout.write(`  ${id}: ${parts.length > 0 ? parts.join("; ") : "not signed in"}\n`);
  }
}

async function keyLogin(provider: StoreProvider, io: AccountCommandIo): Promise<CredentialEntry> {
  const read = io.readSecret ?? readSecretFromStdin;
  const key = (await read(`Paste your ${provider} API key (input hidden): `)).trim();
  if (key.length === 0 || key.length > MAX_KEY_LENGTH || /[\s\u0000-\u001f\u007f]/.test(key)) {
    throw new LoginError("That doesn't look like an API key (empty, too long, or contains spaces). Nothing was saved.");
  }
  return { type: "api_key", key };
}

async function deviceLogin(provider: StoreProvider, io: AccountCommandIo): Promise<CredentialEntry> {
  const signal = io.signal ?? new AbortController().signal;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? abortableSleep;
  const start = provider === "codex" ? await startCodex(io, signal, now)
    : await startRfc8628(provider === "grok" ? GROK_OAUTH : KIMI_OAUTH, provider === "grok" ? GROK_OAUTH.scope : undefined, io, signal, now);

  io.stderr.write(`Open ${start.verificationUri} and enter the code: ${start.userCode}\nWaiting for approval (Ctrl-C to cancel)…\n`);
  const deadline = now() + start.expiresInSeconds * 1000;
  let intervalMs = Math.max(1000, start.intervalSeconds * 1000);
  while (now() < deadline) {
    await sleep(intervalMs, signal);
    const result = await start.poll();
    if (result.status === "complete") return result.entry;
    if (result.status === "failed") throw new LoginError(result.message);
    if (result.status === "slow_down") intervalMs += 5000;
  }
  throw new LoginError("The sign-in code expired before it was approved. Nothing was saved.");
}

async function request(
  io: AccountCommandIo,
  signal: AbortSignal,
  url: string,
  body: Readonly<Record<string, string>>,
  form: boolean,
): Promise<{ status: number; json: Json }> {
  // Manual timeout (not AbortSignal.any) keeps the declared Node >=20 floor working.
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    return await boundedRequest(io, controller.signal, url, body, form);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function boundedRequest(
  io: AccountCommandIo,
  signal: AbortSignal,
  url: string,
  body: Readonly<Record<string, string>>,
  form: boolean,
): Promise<{ status: number; json: Json }> {
  if (signal.aborted) throw new LoginError("Cancelled. Nothing was saved.");
  const response = await (io.fetch ?? fetch)(url, {
    method: "POST",
    headers: form
      ? { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }
      : { "Content-Type": "application/json", Accept: "application/json" },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    redirect: "manual",
    signal,
  });
  const text = await readCapped(response);
  if (text === undefined) throw new LoginError(`Sign-in server sent an oversized response (HTTP ${response.status}).`);
  let json: unknown;
  try {
    json = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    json = {};
  }
  return { status: response.status, json: record(json) };
}

/** Streams the body and stops at MAX_RESPONSE_BYTES instead of buffering it all first. */
async function readCapped(response: Response): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function str(json: Json, key: string): string | undefined {
  const value = json[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(json: Json, key: string): number | undefined {
  const raw = json[key];
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Server error codes are echoed only when they look like a plain OAuth code. */
function safeCode(json: Json): string {
  const raw = json.error;
  const code = typeof raw === "object" && raw !== null ? record(raw).code : raw;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "";
}

function httpsUri(value: string | undefined): string {
  if (value === undefined) throw new LoginError("Sign-in server sent no verification address.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LoginError("Sign-in server sent an invalid verification address.");
  }
  if (url.protocol !== "https:") throw new LoginError("Sign-in server sent a non-https verification address.");
  return url.href;
}

function oauthEntry(json: Json, now: () => number, extra: { readonly accountId?: string } = {}): CredentialEntry | undefined {
  const access = str(json, "access_token");
  const refresh = str(json, "refresh_token");
  const expiresIn = num(json, "expires_in");
  if (access === undefined || refresh === undefined) return undefined;
  return {
    type: "oauth",
    access,
    refresh,
    ...(expiresIn === undefined ? {} : { expires: now() + expiresIn * 1000 }),
    ...(extra.accountId === undefined ? {} : { accountId: extra.accountId }),
  };
}

async function startRfc8628(
  client: { readonly clientId: string; readonly deviceEndpoint: string; readonly tokenEndpoint: string },
  scope: string | undefined,
  io: AccountCommandIo,
  signal: AbortSignal,
  now: () => number,
): Promise<DeviceStart> {
  const started = await request(io, signal, client.deviceEndpoint, { client_id: client.clientId, ...(scope === undefined ? {} : { scope }) }, true);
  const deviceCode = str(started.json, "device_code");
  const userCode = str(started.json, "user_code");
  if (started.status !== 200 || deviceCode === undefined || userCode === undefined) {
    throw new LoginError(`Could not start sign-in (HTTP ${started.status}).`);
  }
  return {
    verificationUri: httpsUri(str(started.json, "verification_uri_complete") ?? str(started.json, "verification_uri")),
    userCode,
    intervalSeconds: num(started.json, "interval") || 5,
    expiresInSeconds: num(started.json, "expires_in") || DEFAULT_DEVICE_TIMEOUT_S,
    poll: async () => {
      const polled = await request(io, signal, client.tokenEndpoint, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: client.clientId,
        device_code: deviceCode,
      }, true);
      if (polled.status === 200) {
        const entry = oauthEntry(polled.json, now);
        return entry === undefined ? { status: "failed", message: "Sign-in server sent an incomplete token. Nothing was saved." } : { status: "complete", entry };
      }
      const code = safeCode(polled.json);
      if (code === "authorization_pending") return { status: "pending" };
      if (code === "slow_down") return { status: "slow_down" };
      if (code === "access_denied" || code === "authorization_denied") return { status: "failed", message: "Sign-in was denied. Nothing was saved." };
      if (code === "expired_token") return { status: "failed", message: "The sign-in code expired. Nothing was saved." };
      return { status: "failed", message: `Sign-in failed (HTTP ${polled.status}${code ? `, ${code}` : ""}). Nothing was saved.` };
    },
  };
}

async function startCodex(io: AccountCommandIo, signal: AbortSignal, now: () => number): Promise<DeviceStart> {
  const started = await request(io, signal, CODEX_DEVICE.userCodeUrl, { client_id: CODEX_OAUTH_CLIENT_ID }, false);
  const deviceAuthId = str(started.json, "device_auth_id");
  const userCode = str(started.json, "user_code");
  if (started.status === 404) {
    throw new LoginError("ChatGPT device-code sign-in is not available for this account. Enable it in ChatGPT security settings, or report this so browser sign-in can be added.");
  }
  if (started.status !== 200 || deviceAuthId === undefined || userCode === undefined) {
    throw new LoginError(`Could not start ChatGPT sign-in (HTTP ${started.status}).`);
  }
  return {
    verificationUri: CODEX_DEVICE.verificationUri,
    userCode,
    intervalSeconds: num(started.json, "interval") ?? 5,
    expiresInSeconds: DEFAULT_DEVICE_TIMEOUT_S,
    poll: async () => {
      const polled = await request(io, signal, CODEX_DEVICE.pollUrl, { device_auth_id: deviceAuthId, user_code: userCode }, false);
      if (polled.status === 403 || polled.status === 404) return { status: "pending" };
      if (polled.status !== 200) {
        const code = safeCode(polled.json);
        if (code === "deviceauth_authorization_pending") return { status: "pending" };
        if (code === "slow_down") return { status: "slow_down" };
        return { status: "failed", message: `ChatGPT sign-in failed (HTTP ${polled.status}${code ? `, ${code}` : ""}). Nothing was saved.` };
      }
      const code = str(polled.json, "authorization_code");
      const verifier = str(polled.json, "code_verifier");
      if (code === undefined || verifier === undefined) return { status: "failed", message: "ChatGPT sent an incomplete approval. Nothing was saved." };
      const exchanged = await request(io, signal, CODEX_DEVICE.tokenUrl, {
        grant_type: "authorization_code",
        client_id: CODEX_OAUTH_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: CODEX_DEVICE.redirectUri,
      }, true);
      const access = str(exchanged.json, "access_token");
      const accountId = access === undefined ? undefined : chatgptAccountId(access);
      const entry = exchanged.status === 200 && accountId !== undefined ? oauthEntry(exchanged.json, now, { accountId }) : undefined;
      return entry === undefined
        ? { status: "failed", message: `ChatGPT token exchange failed (HTTP ${exchanged.status}). Nothing was saved.` }
        : { status: "complete", entry };
    },
  };
}

/** The usage endpoint needs the ChatGPT account id carried in the access token. */
export function chatgptAccountId(accessToken: string): string | undefined {
  try {
    const payload = accessToken.split(".")[1];
    if (payload === undefined) return undefined;
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const id = record(record(claims)["https://api.openai.com/auth"]).chatgpt_account_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new LoginError("Cancelled. Nothing was saved."));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LoginError("Cancelled. Nothing was saved."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Hidden-input prompt on a TTY; otherwise the first line of piped stdin. */
function readSecretFromStdin(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = "";
      stdin.setEncoding("utf8");
      let oversized = false;
      stdin.on("data", (chunk: string) => {
        // Keep draining so "end" fires; an oversized input becomes "" and is rejected.
        if (data.length + chunk.length > MAX_KEY_LENGTH * 2) oversized = true;
        else data += chunk;
      });
      stdin.on("end", () => resolve(oversized ? "" : (data.split(/\r?\n/)[0] ?? "")));
      stdin.on("error", reject);
    });
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    let value = "";
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const done = (error?: Error): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new LoginError("Cancelled. Nothing was saved."));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (value.length <= MAX_KEY_LENGTH) value += char;
      }
    };
    stdin.on("data", onData);
  });
}
