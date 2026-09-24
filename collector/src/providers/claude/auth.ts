import { homedir } from "node:os";
import { join } from "node:path";

import {
  JsonFileError,
  readJsonFile,
  type JsonFileErrorKind,
} from "../../io/json-file.js";

/** Constant safe text for mapping Claude credential state later. */
export const CLAUDE_AUTH_STATUS_TEXT = {
  available: "Credential available",
  authNeeded: "Authentication required",
  error: "Provider unavailable",
} as const;

export const CLAUDE_AUTH_NEEDED_REASONS = [
  "missing-file",
  "missing-entry",
  "wrong-type",
  "missing-access",
  "empty-access",
  "malformed-access",
  "malformed-expires",
  "expired",
  "insufficient-scope",
  "malformed-scopes",
] as const;

export type ClaudeAuthNeededReason = (typeof CLAUDE_AUTH_NEEDED_REASONS)[number];

export const CLAUDE_AUTH_ERROR_REASONS = [
  "auth-file-read",
  "auth-file-malformed",
  "auth-file-unsafe",
  "auth-file-not-object",
  "auth-file-update",
  "auth-clock-invalid",
] as const;

export type ClaudeAuthErrorReason = (typeof CLAUDE_AUTH_ERROR_REASONS)[number];

/**
 * The only branch allowed to carry the access token. It is an internal
 * collector value for the future request builder, not normalized output.
 */
export interface ClaudeOAuthCredential {
  readonly access: string;
  readonly expires?: number;
}

export type ClaudeAuthResult =
  | {
      readonly state: "available";
      readonly status: typeof CLAUDE_AUTH_STATUS_TEXT.available;
      readonly credential: ClaudeOAuthCredential;
    }
  | {
      readonly state: "auth-needed";
      readonly reason: ClaudeAuthNeededReason;
      readonly status: typeof CLAUDE_AUTH_STATUS_TEXT.authNeeded;
    }
  | {
      readonly state: "error";
      readonly reason: ClaudeAuthErrorReason;
      readonly status: typeof CLAUDE_AUTH_STATUS_TEXT.error;
    };

export type ClaudeAuthReader = (path: string) => Promise<unknown>;
export type ClaudeAuthClock = () => number;

interface ClaudeAuthSourceOptions {
  /** Used only when the exact path is omitted; no filesystem lookup occurs here. */
  readonly homeDirectory?: string;
  /** Defaults to the safe no-follow JSON reader. */
  readonly readJsonFile?: ClaudeAuthReader;
  /** Epoch milliseconds used for optional OAuth expiry classification. */
  readonly now?: ClaudeAuthClock;
}

export interface PiClaudeAuthOptions extends ClaudeAuthSourceOptions {
  /** Exact Pi auth path override, useful for isolated callers and tests. */
  readonly authPath?: string;
}

export interface ClaudeCodeAuthOptions extends ClaudeAuthSourceOptions {
  /** Exact Claude Code credentials path override, useful for isolated callers and tests. */
  readonly credentialsPath?: string;
}

export interface ClaudeAuthOptions extends ClaudeAuthSourceOptions {
  readonly piAuthPath?: string;
  readonly claudeCodeCredentialsPath?: string;
}

/** Scope the usage endpoint requires; checked only when Claude Code declares scopes. */
const CLAUDE_USAGE_REQUIRED_SCOPE = "user:profile";

type PlainRecord = { readonly [key: string]: unknown };
type JsonFileErrorReason = Exclude<ClaudeAuthErrorReason, "auth-clock-invalid">;

const MISSING = Symbol("missing");

const JSON_FILE_ERROR_REASONS: Readonly<Record<JsonFileErrorKind, JsonFileErrorReason>> = {
  read: "auth-file-read",
  malformed: "auth-file-malformed",
  "unsafe-file": "auth-file-unsafe",
  "not-object": "auth-file-not-object",
  update: "auth-file-update",
};

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null) return false;

  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function ownValue(record: PlainRecord, key: string): unknown | typeof MISSING {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor === undefined ? MISSING : descriptor.value;
}

function authNeeded(reason: ClaudeAuthNeededReason): ClaudeAuthResult {
  return {
    state: "auth-needed",
    reason,
    status: CLAUDE_AUTH_STATUS_TEXT.authNeeded,
  };
}

function errorResult(reason: ClaudeAuthErrorReason): ClaudeAuthResult {
  return {
    state: "error",
    reason,
    status: CLAUDE_AUTH_STATUS_TEXT.error,
  };
}

function isJsonFileErrorKind(value: string): value is JsonFileErrorKind {
  return (
    value === "read" ||
    value === "malformed" ||
    value === "unsafe-file" ||
    value === "not-object" ||
    value === "update"
  );
}

function mapReadFailure(error: unknown): ClaudeAuthResult {
  try {
    if (typeof error !== "object" || error === null) {
      return errorResult("auth-file-read");
    }
    if (Object.getPrototypeOf(error) !== JsonFileError.prototype) {
      return errorResult("auth-file-read");
    }

    const name = Object.getOwnPropertyDescriptor(error, "name");
    const message = Object.getOwnPropertyDescriptor(error, "message");
    const kind = Object.getOwnPropertyDescriptor(error, "kind");
    if (
      name === undefined ||
      !Object.prototype.hasOwnProperty.call(name, "value") ||
      name.value !== "JsonFileError" ||
      message === undefined ||
      !Object.prototype.hasOwnProperty.call(message, "value") ||
      kind === undefined ||
      !Object.prototype.hasOwnProperty.call(kind, "value")
    ) {
      return errorResult("auth-file-read");
    }

    const value = kind.value;
    if (typeof value !== "string" || !isJsonFileErrorKind(value)) {
      return errorResult("auth-file-read");
    }
    return errorResult(JSON_FILE_ERROR_REASONS[value]);
  } catch {
    return errorResult("auth-file-read");
  }
}

/** Shared access/expiry classification; the only place the access token is copied. */
function classifyAccess(
  access: unknown,
  expires: unknown,
  now: ClaudeAuthClock,
): ClaudeAuthResult {
  if (access === MISSING) return authNeeded("missing-access");
  if (typeof access !== "string") return authNeeded("malformed-access");
  if (access.trim().length === 0) return authNeeded("empty-access");

  if (expires !== MISSING && (typeof expires !== "number" || !Number.isFinite(expires))) {
    return authNeeded("malformed-expires");
  }

  if (typeof expires === "number") {
    let currentTime: number;
    try {
      currentTime = now();
    } catch {
      return errorResult("auth-clock-invalid");
    }
    if (!Number.isFinite(currentTime)) return errorResult("auth-clock-invalid");
    if (expires <= currentTime) return authNeeded("expired");
  }

  const credential: ClaudeOAuthCredential =
    typeof expires === "number" ? { access, expires } : { access };
  return {
    state: "available",
    status: CLAUDE_AUTH_STATUS_TEXT.available,
    credential,
  };
}

function classifyPiCredential(entry: unknown, now: ClaudeAuthClock): ClaudeAuthResult {
  try {
    if (!isPlainRecord(entry)) return authNeeded("wrong-type");
    if (ownValue(entry, "type") !== "oauth") return authNeeded("wrong-type");
    return classifyAccess(ownValue(entry, "access"), ownValue(entry, "expires"), now);
  } catch {
    return authNeeded("wrong-type");
  }
}

/**
 * Reads only `accessToken`, `expiresAt`, and `scopes`; the refresh token and MCP
 * credentials in the same file are never read into a value.
 */
function classifyClaudeCodeCredential(entry: unknown, now: ClaudeAuthClock): ClaudeAuthResult {
  try {
    if (!isPlainRecord(entry)) return authNeeded("wrong-type");

    const scopes = ownValue(entry, "scopes");
    if (scopes !== MISSING) {
      if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) {
        return authNeeded("malformed-scopes");
      }
      if (!scopes.includes(CLAUDE_USAGE_REQUIRED_SCOPE)) return authNeeded("insufficient-scope");
    }

    return classifyAccess(ownValue(entry, "accessToken"), ownValue(entry, "expiresAt"), now);
  } catch {
    return authNeeded("wrong-type");
  }
}

async function readEntry(
  path: string,
  entryKey: string,
  options: ClaudeAuthSourceOptions,
  classify: (entry: unknown, now: ClaudeAuthClock) => ClaudeAuthResult,
): Promise<ClaudeAuthResult> {
  const read = options.readJsonFile ?? ((filePath: string) => readJsonFile(filePath));

  let document: unknown;
  try {
    document = await read(path);
  } catch (error: unknown) {
    return mapReadFailure(error);
  }

  if (document === undefined) return authNeeded("missing-file");

  try {
    if (!isPlainRecord(document)) return errorResult("auth-file-not-object");

    const entry = ownValue(document, entryKey);
    if (entry === MISSING) return authNeeded("missing-entry");

    return classify(entry, options.now ?? Date.now);
  } catch {
    return errorResult("auth-file-not-object");
  }
}

export function resolvePiClaudeAuthPath(homeDirectory: string): string {
  return join(homeDirectory, ".pi", "agent", "auth.json");
}

export function resolveClaudeCodeCredentialsPath(homeDirectory: string): string {
  return join(homeDirectory, ".claude", ".credentials.json");
}

/** Reads and classifies only the Anthropic entry from Pi's auth file. */
export async function readPiClaudeAuth(
  options: PiClaudeAuthOptions = {},
): Promise<ClaudeAuthResult> {
  const path = options.authPath ?? resolvePiClaudeAuthPath(options.homeDirectory ?? homedir());
  return readEntry(path, "anthropic", options, classifyPiCredential);
}

/** Reads and classifies only the `claudeAiOauth` entry from Claude Code's credentials. */
export async function readClaudeCodeAuth(
  options: ClaudeCodeAuthOptions = {},
): Promise<ClaudeAuthResult> {
  const path =
    options.credentialsPath ??
    resolveClaudeCodeCredentialsPath(options.homeDirectory ?? homedir());
  return readEntry(path, "claudeAiOauth", options, classifyClaudeCodeCredential);
}

/**
 * Read-only credential chain: Claude Code first, Pi second. Kuota never refreshes
 * either token; refreshing would rotate the owning tool's refresh token.
 * When neither is usable, an actionable auth-needed state wins over a read error.
 */
export async function readClaudeAuth(
  options: ClaudeAuthOptions = {},
): Promise<ClaudeAuthResult> {
  const shared: ClaudeAuthSourceOptions = {
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    ...(options.readJsonFile === undefined ? {} : { readJsonFile: options.readJsonFile }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };

  const primary = await readClaudeCodeAuth({
    ...shared,
    ...(options.claudeCodeCredentialsPath === undefined
      ? {}
      : { credentialsPath: options.claudeCodeCredentialsPath }),
  });
  if (primary.state === "available") return primary;

  const fallback = await readPiClaudeAuth({
    ...shared,
    ...(options.piAuthPath === undefined ? {} : { authPath: options.piAuthPath }),
  });
  if (fallback.state === "available") return fallback;

  if (primary.state === "auth-needed") return primary;
  if (fallback.state === "auth-needed") return fallback;
  return primary;
}
