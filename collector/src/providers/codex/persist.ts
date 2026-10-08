import {
  AtomicWriteError,
  nodeFileSystem,
  type RandomSource,
} from "../../io/atomic-write.js";
import {
  JsonFileError,
  updateJsonFile,
  readJsonFile,
  type JsonFileSystem,
  type JsonObject,
  type JsonValue,
} from "../../io/json-file.js";
import type { CodexOAuthCredential } from "./auth.js";
import type { CodexRefreshedCredential } from "./refresh.js";

/** The initiating store credential; accountId exists only for Codex. */
export type StoredOAuthCredential = Omit<CodexOAuthCredential, "accountId"> & {
  readonly accountId?: string;
};

export const CODEX_PERSIST_OUTCOMES = [
  "updated",
  "already-current",
  "conflict",
  "error",
  "indeterminate",
] as const;

export type CodexPersistOutcome = (typeof CODEX_PERSIST_OUTCOMES)[number];

/** Inputs and filesystem seams for the latest-read Codex auth persistence boundary. */
export interface CodexPersistOptions {
  readonly authPath: string;
  /** Kuota store entry; Codex by default. Grok/Kimi reuse this CAS merge. */
  readonly entryKey?: string;
  readonly initiatingCredential: StoredOAuthCredential;
  readonly refreshedCredential: CodexRefreshedCredential;
  readonly fs?: JsonFileSystem;
  readonly random?: RandomSource;
}

const CODEX_AUTH_ENTRY = "codex";
const MISSING = Symbol("missing");

type PlainJsonObject = { readonly [key: string]: JsonValue };

function ownValue(object: PlainJsonObject, key: string): JsonValue | typeof MISSING {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor === undefined ? MISSING : descriptor.value;
}

function isPlainJsonObject(value: unknown): value is PlainJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validInputs(options: CodexPersistOptions): boolean {
  const initiating = options.initiatingCredential;
  const refreshed = options.refreshedCredential;
  return (
    isNonEmptyString(options.authPath) &&
    (initiating.accountId === undefined || isNonEmptyString(initiating.accountId)) &&
    isNonEmptyString(initiating.access) &&
    isNonEmptyString(initiating.refresh) &&
    isNonEmptyString(refreshed.access) &&
    (refreshed.refresh === undefined || isNonEmptyString(refreshed.refresh)) &&
    (refreshed.expires === undefined || Number.isFinite(refreshed.expires))
  );
}

function sameAccount(entry: PlainJsonObject, accountId: string | undefined): boolean {
  const stored = ownValue(entry, "accountId");
  return accountId === undefined ? stored === MISSING : stored === accountId;
}

function isAlreadyCurrent(
  entry: PlainJsonObject,
  initiating: StoredOAuthCredential,
  refreshed: CodexRefreshedCredential,
): boolean {
  if (
    ownValue(entry, "type") !== "oauth" ||
    !sameAccount(entry, initiating.accountId) ||
    ownValue(entry, "access") !== refreshed.access
  ) {
    return false;
  }
  const expectedRefresh = refreshed.refresh ?? initiating.refresh;
  if (ownValue(entry, "refresh") !== expectedRefresh) {
    return false;
  }
  return refreshed.expires === undefined || ownValue(entry, "expires") === refreshed.expires;
}

function matchesInitiatingCredential(entry: PlainJsonObject, initiating: StoredOAuthCredential): boolean {
  return (
    ownValue(entry, "type") === "oauth" &&
    sameAccount(entry, initiating.accountId) &&
    ownValue(entry, "access") === initiating.access &&
    ownValue(entry, "refresh") === initiating.refresh
  );
}

function refreshedEntry(
  entry: PlainJsonObject,
  refreshed: CodexRefreshedCredential,
): JsonObject {
  const next: JsonObject = { ...entry, access: refreshed.access };
  if (refreshed.refresh !== undefined) {
    return { ...next, refresh: refreshed.refresh, ...(refreshed.expires === undefined ? {} : { expires: refreshed.expires }) };
  }
  return refreshed.expires === undefined ? next : { ...next, expires: refreshed.expires };
}

/**
 * Merges a successful Codex OAuth refresh only into the exact credential that
 * initiated it. All persistence is delegated to the generic latest-read CAS
 * helper so its trusted-parent, no-follow, atomic replacement, and durability
 * guarantees remain the sole write mechanism.
 */
export async function persistCodexRefreshedAuth(
  options: CodexPersistOptions,
): Promise<CodexPersistOutcome> {
  if (!validInputs(options)) return "error";

  const fs = options.fs ?? nodeFileSystem;
  const entryKey = options.entryKey ?? CODEX_AUTH_ENTRY;
  let preimageResult: "already-current" | "conflict" | undefined;
  try {
    await updateJsonFile(
      options.authPath,
      (latest) => {
        const entry = ownValue(latest, entryKey);
        if (!isPlainJsonObject(entry)) {
          preimageResult = "conflict";
          throw new Error("conflict");
        }
        if (isAlreadyCurrent(entry, options.initiatingCredential, options.refreshedCredential)) {
          preimageResult = "already-current";
          throw new Error("already-current");
        }
        if (!matchesInitiatingCredential(entry, options.initiatingCredential)) {
          preimageResult = "conflict";
          throw new Error("conflict");
        }
        return { ...latest, [entryKey]: refreshedEntry(entry, options.refreshedCredential) };
      },
      { fs, random: options.random, policy: "new-cache" },
    );
    return "updated";
  } catch (error: unknown) {
    if (preimageResult !== undefined) {
      return preimageResult;
    }
    if (error instanceof AtomicWriteError) {
      if (error.stage === "post-commit") {
        try {
          await readJsonFile(options.authPath, { fs });
        } catch {
          // A single read-back is evidence only; durability remains indeterminate.
        }
        return "indeterminate";
      }
      return error.stage === "conflict" ? "conflict" : "error";
    }
    if (error instanceof JsonFileError) return "error";
    return "error";
  }
}
