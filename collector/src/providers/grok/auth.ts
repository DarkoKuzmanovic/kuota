import { homedir } from "node:os";

import {
  JsonFileError,
  readJsonFile,
  type JsonFileErrorKind,
} from "../../io/json-file.js";
import { refreshFields, resolveKuotaCredentialsPath } from "../../credentials/store.js";

export interface GrokOAuthCredential {
  readonly kind: "oauth";
  readonly value: string;
  /** Present only for Kuota-store logins; env tokens are never refreshed. */
  readonly refresh?: string;
  readonly expires?: number;
}

export type GrokCredential = GrokOAuthCredential;

export type GrokAuthResult =
  | { readonly state: "available"; readonly credential: GrokCredential }
  | { readonly state: "auth-needed"; readonly reason: "missing-file" | "missing-entry" | "unsupported-entry" | "malformed-entry" }
  | { readonly state: "error"; readonly reason: "auth-file-read" | "auth-file-malformed" | "auth-file-unsafe" | "auth-file-not-object" };

export interface GrokAuthOptions {
  readonly homeDirectory?: string;
  readonly authPath?: string;
  readonly readJsonFile?: (path: string) => Promise<unknown>;
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

function classifyEntry(entry: unknown): GrokAuthResult {
  if (entry === MISSING) return { state: "auth-needed", reason: "missing-entry" };
  if (!isPlainRecord(entry)) return { state: "auth-needed", reason: "unsupported-entry" };
  const type = ownValue(entry, "type");
  if (type === "oauth") {
    const access = ownValue(entry, "access");
    return nonEmptyString(access)
      ? { state: "available", credential: { kind: "oauth", value: access, ...refreshFields(entry) } }
      : { state: "auth-needed", reason: "malformed-entry" };
  }
  return { state: "auth-needed", reason: "unsupported-entry" };
}

function mapReadFailure(error: unknown): GrokAuthResult {
  if (error instanceof JsonFileError) {
    const kind: JsonFileErrorKind = error.kind;
    if (kind === "unsafe-file") return { state: "error", reason: "auth-file-unsafe" };
    if (kind === "malformed") return { state: "error", reason: "auth-file-malformed" };
    if (kind === "not-object") return { state: "error", reason: "auth-file-not-object" };
  }
  return { state: "error", reason: "auth-file-read" };
}

function environmentCredential(environment: Readonly<Record<string, string | undefined>> | undefined): GrokAuthResult | undefined {
  const value = environment?.GROK_CLI_OAUTH_TOKEN;
  return nonEmptyString(value)
    ? { state: "available", credential: { kind: "oauth", value } }
    : undefined;
}

function readSupportedFileCredential(document: unknown): GrokAuthResult | undefined {
  if (!isPlainRecord(document)) return undefined;
  for (const key of ["grok"] as const) {
    const result = classifyEntry(ownValue(document, key));
    if (result.state === "available") return result;
    if (result.reason === "malformed-entry") return result;
  }
  return undefined;
}

function fileCredentialResult(document: unknown): GrokAuthResult | undefined {
  if (!isPlainRecord(document)) return undefined;
  const credential = readSupportedFileCredential(document);
  if (credential !== undefined) return credential;
  // Check whether any supported entry exists at all, even if malformed, before falling through.
  for (const key of ["grok"] as const) {
    if (ownValue(document, key) !== MISSING) {
      return { state: "auth-needed", reason: "unsupported-entry" };
    }
  }
  return undefined;
}

export function resolveGrokAuthPath(
  homeDirectory: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return resolveKuotaCredentialsPath(homeDirectory, environment);
}

/** Reads only Kuota's `grok` store entry and never exposes a rejected credential in its outcome. */
export async function readGrokAuth(options: GrokAuthOptions = {}): Promise<GrokAuthResult> {
  const path = options.authPath ?? resolveGrokAuthPath(options.homeDirectory ?? homedir());
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

  const fileResult = fileCredentialResult(document);
  if (fileResult?.state === "available") return fileResult;
  if (fileResult?.reason === "unsupported-entry") {
    return environmentCredential(options.environment) ?? fileResult;
  }
  if (fileResult?.reason === "malformed-entry") return fileResult;

  return environmentCredential(options.environment) ?? { state: "auth-needed", reason: "missing-entry" };
}
