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

export interface ClaudeAuthOptions {
  /** Used only when authPath is omitted; no filesystem lookup occurs here. */
  readonly homeDirectory?: string;
  /** Exact path override, useful for isolated callers and tests. */
  readonly authPath?: string;
  /** Defaults to the safe no-follow JSON reader. */
  readonly readJsonFile?: ClaudeAuthReader;
  /** Epoch milliseconds used for optional OAuth expiry classification. */
  readonly now?: ClaudeAuthClock;
}

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

function classifyCredential(
  entry: unknown,
  now: ClaudeAuthClock,
): ClaudeAuthResult {
  try {
    if (!isPlainRecord(entry)) return authNeeded("wrong-type");

    const type = ownValue(entry, "type");
    if (type !== "oauth") return authNeeded("wrong-type");

    const access = ownValue(entry, "access");
    if (access === MISSING) return authNeeded("missing-access");
    if (typeof access !== "string") return authNeeded("malformed-access");
    if (access.trim().length === 0) return authNeeded("empty-access");

    const expires = ownValue(entry, "expires");
    if (expires !== MISSING && (typeof expires !== "number" || !Number.isFinite(expires))) {
      return authNeeded("malformed-expires");
    }

    if (expires !== MISSING) {
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
      expires === MISSING
        ? { access }
        : { access, expires };
    return {
      state: "available",
      status: CLAUDE_AUTH_STATUS_TEXT.available,
      credential,
    };
  } catch {
    return authNeeded("wrong-type");
  }
}

export function resolveClaudeAuthPath(homeDirectory: string): string {
  return join(homeDirectory, ".pi", "agent", "auth.json");
}

/** Reads and classifies only the Anthropic entry from Pi's auth file. */
export async function readClaudeAuth(
  options: ClaudeAuthOptions = {},
): Promise<ClaudeAuthResult> {
  const path =
    options.authPath ??
    resolveClaudeAuthPath(options.homeDirectory ?? homedir());
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

    const anthropic = ownValue(document, "anthropic");
    if (anthropic === MISSING) return authNeeded("missing-entry");

    return classifyCredential(anthropic, options.now ?? Date.now);
  } catch {
    return errorResult("auth-file-not-object");
  }
}
