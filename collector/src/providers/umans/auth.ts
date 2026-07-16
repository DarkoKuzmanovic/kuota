import { homedir } from "node:os";
import { join } from "node:path";

import {
  JsonFileError,
  readJsonFile,
  type JsonFileErrorKind,
} from "../../io/json-file.js";

export interface UmansOAuthCredential {
  readonly kind: "oauth";
  readonly value: string;
}

export interface UmansApiKeyCredential {
  readonly kind: "api-key";
  readonly value: string;
}

export type UmansCredential = UmansOAuthCredential | UmansApiKeyCredential;

export type UmansAuthResult =
  | { readonly state: "available"; readonly credential: UmansCredential }
  | { readonly state: "auth-needed"; readonly reason: "missing-file" | "missing-entry" | "unsupported-entry" | "malformed-entry" }
  | { readonly state: "error"; readonly reason: "auth-file-read" | "auth-file-malformed" | "auth-file-unsafe" | "auth-file-not-object" };

export type UmansAuthReader = (path: string) => Promise<unknown>;

export interface UmansAuthOptions {
  readonly homeDirectory?: string;
  readonly authPath?: string;
  readonly readJsonFile?: UmansAuthReader;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

type PlainRecord = Record<string, unknown>;
const MISSING = Symbol("missing");

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

function classifyEntry(entry: unknown): UmansAuthResult {
  if (entry === MISSING) return { state: "auth-needed", reason: "missing-entry" };
  if (!isPlainRecord(entry)) return { state: "auth-needed", reason: "unsupported-entry" };
  const type = ownValue(entry, "type");
  if (type === "oauth") {
    const access = ownValue(entry, "access");
    return nonEmptyString(access)
      ? { state: "available", credential: { kind: "oauth", value: access } }
      : { state: "auth-needed", reason: "malformed-entry" };
  }
  if (type === "api_key") {
    const key = ownValue(entry, "key");
    return nonEmptyString(key)
      ? { state: "available", credential: { kind: "api-key", value: key } }
      : { state: "auth-needed", reason: "malformed-entry" };
  }
  return { state: "auth-needed", reason: "unsupported-entry" };
}

function mapReadFailure(error: unknown): UmansAuthResult {
  if (error instanceof JsonFileError) {
    const kind: JsonFileErrorKind = error.kind;
    if (kind === "unsafe-file") return { state: "error", reason: "auth-file-unsafe" };
    if (kind === "malformed") return { state: "error", reason: "auth-file-malformed" };
    if (kind === "not-object") return { state: "error", reason: "auth-file-not-object" };
  }
  return { state: "error", reason: "auth-file-read" };
}

function environmentCredential(environment: Readonly<Record<string, string | undefined>> | undefined): UmansAuthResult | undefined {
  const value = environment?.UMANS_API_KEY;
  return nonEmptyString(value)
    ? { state: "available", credential: { kind: "api-key", value } }
    : undefined;
}

export function resolveUmansAuthPath(homeDirectory: string): string {
  return join(homeDirectory, ".pi", "agent", "auth.json");
}

/** Reads only auth.umans and never exposes a rejected credential in its outcome. */
export async function readUmansAuth(options: UmansAuthOptions = {}): Promise<UmansAuthResult> {
  const path = options.authPath ?? resolveUmansAuthPath(options.homeDirectory ?? homedir());
  const read = options.readJsonFile ?? ((filePath: string) => readJsonFile(filePath));
  let document: unknown;
  try {
    document = await read(path);
  } catch (error: unknown) {
    return mapReadFailure(error);
  }
  if (document === undefined) return environmentCredential(options.environment) ?? { state: "auth-needed", reason: "missing-file" };
  if (!isPlainRecord(document)) return { state: "error", reason: "auth-file-not-object" };
  const result = classifyEntry(ownValue(document, "umans"));
  if (result.state === "available") return result;
  if (result.reason === "missing-entry" || result.reason === "unsupported-entry") {
    return environmentCredential(options.environment) ?? result;
  }
  return result;
}
