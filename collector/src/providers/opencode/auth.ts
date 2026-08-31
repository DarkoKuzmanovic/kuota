import { homedir } from "node:os";
import { join } from "node:path";

import {
  JsonFileError,
  readJsonFile,
  type JsonFileErrorKind,
} from "../../io/json-file.js";

export type OpencodeCredential =
  | { readonly kind: "oauth"; readonly value: string }
  | { readonly kind: "api-key"; readonly value: string };

export type OpencodeAuthResult =
  | { readonly state: "available"; readonly credential: OpencodeCredential }
  | { readonly state: "auth-needed"; readonly reason: "missing-file" | "missing-entry" | "unsupported-entry" | "malformed-entry" }
  | { readonly state: "error"; readonly reason: "auth-file-read" | "auth-file-malformed" | "auth-file-unsafe" | "auth-file-not-object" };

export type OpencodeAuthReader = (path: string) => Promise<unknown>;

export interface OpencodeAuthOptions {
  readonly homeDirectory?: string;
  readonly authPath?: string;
  readonly readJsonFile?: OpencodeAuthReader;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

type PlainRecord = Record<string, unknown>;
const MISSING = Symbol("missing");

// `opencode-go` is the provider id the OpenCode CLI writes
// (`opencode auth login -p opencode-go`); `opencode` is the manual-setup alias.
const ENTRY_KEYS = ["opencode-go", "opencode"] as const;
const ENV_KEY = "OPENCODE_API_KEY";

function isPlainRecord(value: unknown): value is PlainRecord {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value");
    });
  } catch {
    return false;
  }
}

function ownValue(record: PlainRecord, key: string): unknown | typeof MISSING {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor === undefined ? MISSING : descriptor.value;
  } catch {
    return MISSING;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function classifyEntry(entry: unknown): OpencodeAuthResult | undefined {
  if (entry === MISSING) return undefined;
  if (!isPlainRecord(entry)) return { state: "auth-needed", reason: "unsupported-entry" };
  const type = ownValue(entry, "type");
  const key = ownValue(entry, "key");
  const access = ownValue(entry, "access");
  if (type === "oauth") {
    return nonEmptyString(access)
      ? { state: "available", credential: { kind: "oauth", value: access } }
      : { state: "auth-needed", reason: "malformed-entry" };
  }
  if (type === "api" || type === "api_key") {
    // `api` is the OpenCode CLI's own entry shape (`{ type: "api", key }`).
    return nonEmptyString(key)
      ? { state: "available", credential: { kind: "api-key", value: key } }
      : { state: "auth-needed", reason: "malformed-entry" };
  }
  return { state: "auth-needed", reason: "unsupported-entry" };
}

function mapReadFailure(error: unknown): OpencodeAuthResult {
  if (error instanceof JsonFileError) {
    const kind: JsonFileErrorKind = error.kind;
    if (kind === "unsafe-file") return { state: "error", reason: "auth-file-unsafe" };
    if (kind === "malformed") return { state: "error", reason: "auth-file-malformed" };
    if (kind === "not-object") return { state: "error", reason: "auth-file-not-object" };
  }
  return { state: "error", reason: "auth-file-read" };
}

function environmentCredential(
  environment: Readonly<Record<string, string | undefined>> | undefined,
): OpencodeAuthResult | undefined {
  const value = environment?.[ENV_KEY];
  return nonEmptyString(value)
    ? { state: "available", credential: { kind: "api-key", value } }
    : undefined;
}

export function resolveOpencodeAuthPath(homeDirectory: string): string {
  return join(homeDirectory, ".pi", "agent", "auth.json");
}

/** Reads auth["opencode-go"] (alias "opencode") and never exposes a rejected credential in its outcome. */
export async function readOpencodeAuth(
  options: OpencodeAuthOptions = {},
): Promise<OpencodeAuthResult> {
  const path = options.authPath ?? resolveOpencodeAuthPath(options.homeDirectory ?? homedir());
  const read = options.readJsonFile ?? ((filePath: string) => readJsonFile(filePath));
  let document: unknown;
  try {
    document = await read(path);
  } catch (error: unknown) {
    return mapReadFailure(error);
  }
  if (document === undefined) {
    return environmentCredential(options.environment) ?? { state: "auth-needed", reason: "missing-file" };
  }
  if (!isPlainRecord(document)) return { state: "error", reason: "auth-file-not-object" };

  let fallthrough = false;
  for (const key of ENTRY_KEYS) {
    const entry = ownValue(document, key);
    if (entry === MISSING) {
      fallthrough = true;
      continue;
    }
    const result = classifyEntry(entry);
    if (result === undefined) {
      fallthrough = true;
      continue;
    }
    if (result.state === "available") return result;
    // A malformed supported entry fails closed (like Kimi); an unsupported
    // entry shape falls through to the next alias / environment.
    if (result.reason === "malformed-entry") return result;
    fallthrough = result.reason === "unsupported-entry";
    if (!fallthrough) return result;
  }
  return (
    environmentCredential(options.environment) ??
    { state: "auth-needed", reason: fallthrough ? "missing-entry" : "unsupported-entry" }
  );
}
