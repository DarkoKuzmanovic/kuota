import { homedir } from "node:os";
import { join } from "node:path";

import {
  JsonFileError,
  readJsonFile,
  type JsonFileErrorKind,
} from "../../io/json-file.js";

/** Constant safe text for mapping Codex credential state later. */
export const CODEX_AUTH_STATUS_TEXT = {
  available: "Credential available",
  expiredWithRefresh: "Credential refresh required",
  authNeeded: "Authentication required",
  error: "Provider unavailable",
} as const;

export const CODEX_AUTH_NEEDED_REASONS = [
  "missing-file",
  "missing-entry",
  "wrong-type",
  "missing-access",
  "empty-access",
  "malformed-access",
  "missing-account-id",
  "empty-account-id",
  "malformed-account-id",
  "empty-refresh",
  "malformed-refresh",
  "malformed-expires",
] as const;

export type CodexAuthNeededReason = (typeof CODEX_AUTH_NEEDED_REASONS)[number];

export const CODEX_AUTH_ERROR_REASONS = [
  "auth-file-read",
  "auth-file-malformed",
  "auth-file-unsafe",
  "auth-file-not-object",
  "auth-file-update",
  "auth-clock-invalid",
] as const;

export type CodexAuthErrorReason = (typeof CODEX_AUTH_ERROR_REASONS)[number];

/**
 * The only branches allowed to carry Codex credential values. They are internal
 * collector values for the later request/refresh flow, not normalized output.
 */
export interface CodexOAuthCredential {
  readonly access: string;
  readonly accountId: string;
  readonly refresh?: string;
  readonly expires?: number;
}

export type CodexAuthResult =
  | {
      readonly state: "available";
      readonly status: typeof CODEX_AUTH_STATUS_TEXT.available;
      readonly credential: CodexOAuthCredential;
    }
  | {
      readonly state: "expired-with-refresh";
      readonly status: typeof CODEX_AUTH_STATUS_TEXT.expiredWithRefresh;
      readonly credential: CodexOAuthCredential & { readonly refresh: string };
    }
  | {
      readonly state: "expired-without-refresh";
      readonly status: typeof CODEX_AUTH_STATUS_TEXT.authNeeded;
    }
  | {
      readonly state: "auth-needed";
      readonly reason: CodexAuthNeededReason;
      readonly status: typeof CODEX_AUTH_STATUS_TEXT.authNeeded;
    }
  | {
      readonly state: "error";
      readonly reason: CodexAuthErrorReason;
      readonly status: typeof CODEX_AUTH_STATUS_TEXT.error;
    };

export type CodexAuthReader = (path: string) => Promise<unknown>;
export type CodexAuthClock = () => number;

export interface CodexAuthOptions {
  /** Used only when authPath is omitted; no filesystem lookup occurs here. */
  readonly homeDirectory?: string;
  /** Exact path override, useful for isolated callers and tests. */
  readonly authPath?: string;
  /** Defaults to the safe no-follow JSON reader. */
  readonly readJsonFile?: CodexAuthReader;
  /** Epoch milliseconds used for OAuth expiry classification. */
  readonly now?: CodexAuthClock;
}

type PlainRecord = { readonly [key: string]: unknown };
type JsonFileErrorReason = Exclude<CodexAuthErrorReason, "auth-clock-invalid">;

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

function authNeeded(reason: CodexAuthNeededReason): CodexAuthResult {
  return {
    state: "auth-needed",
    reason,
    status: CODEX_AUTH_STATUS_TEXT.authNeeded,
  };
}

function errorResult(reason: CodexAuthErrorReason): CodexAuthResult {
  return {
    state: "error",
    reason,
    status: CODEX_AUTH_STATUS_TEXT.error,
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

function mapReadFailure(error: unknown): CodexAuthResult {
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function classifyCredential(entry: unknown, now: CodexAuthClock): CodexAuthResult {
  try {
    if (!isPlainRecord(entry)) return authNeeded("wrong-type");

    const type = ownValue(entry, "type");
    if (type !== "oauth") return authNeeded("wrong-type");

    const access = ownValue(entry, "access");
    if (access === MISSING) return authNeeded("missing-access");
    if (typeof access !== "string") return authNeeded("malformed-access");
    if (!isNonEmptyString(access)) return authNeeded("empty-access");

    const accountId = ownValue(entry, "accountId");
    if (accountId === MISSING) return authNeeded("missing-account-id");
    if (typeof accountId !== "string") return authNeeded("malformed-account-id");
    if (!isNonEmptyString(accountId)) return authNeeded("empty-account-id");

    const refresh = ownValue(entry, "refresh");
    if (refresh !== MISSING && typeof refresh !== "string") {
      return authNeeded("malformed-refresh");
    }
    if (refresh !== MISSING && !isNonEmptyString(refresh)) {
      return authNeeded("empty-refresh");
    }

    const expires = ownValue(entry, "expires");
    if (
      expires !== MISSING &&
      (typeof expires !== "number" || !Number.isFinite(expires))
    ) {
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

      if (expires <= currentTime) {
        if (refresh === MISSING) {
          return {
            state: "expired-without-refresh",
            status: CODEX_AUTH_STATUS_TEXT.authNeeded,
          };
        }
        return {
          state: "expired-with-refresh",
          status: CODEX_AUTH_STATUS_TEXT.expiredWithRefresh,
          credential: { access, accountId, refresh, expires },
        };
      }
    }

    let credential: CodexOAuthCredential;
    if (refresh === MISSING) {
      credential =
        expires === MISSING
          ? { access, accountId }
          : { access, accountId, expires };
    } else {
      credential =
        expires === MISSING
          ? { access, accountId, refresh }
          : { access, accountId, refresh, expires };
    }
    return {
      state: "available",
      status: CODEX_AUTH_STATUS_TEXT.available,
      credential,
    };
  } catch {
    return authNeeded("wrong-type");
  }
}

export function resolveCodexAuthPath(homeDirectory: string): string {
  return join(homeDirectory, ".pi", "agent", "auth.json");
}

/** Reads and classifies only the openai-codex entry from Pi's auth file. */
export async function readCodexAuth(
  options: CodexAuthOptions = {},
): Promise<CodexAuthResult> {
  const path =
    options.authPath ??
    resolveCodexAuthPath(options.homeDirectory ?? homedir());
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

    const codex = ownValue(document, "openai-codex");
    if (codex === MISSING) return authNeeded("missing-entry");

    return classifyCredential(codex, options.now ?? Date.now);
  } catch {
    return errorResult("auth-file-not-object");
  }
}
