import {
  atomicWriteJson,
  identityFromMetadata,
  nodeFileSystem,
  type AtomicFileSystem,
  type AtomicWriteOptions,
  type FileIdentity,
  type FileMetadata,
  type RandomSource,
  type ReadFileHandle,
} from "./atomic-write.js";
import { isRegularNonSymlinkFile, type WritePermissionPolicy } from "./permissions.js";

import { isJsonValue, type JsonValue, type JsonObject } from "./json-value.js";
export { isJsonValue, type JsonPrimitive, type JsonValue, type JsonObject } from "./json-value.js";

export interface JsonFileSystem extends AtomicFileSystem {
  /** Opens with no-follow semantics and is the only handle used for the read. */
  openRead(path: string): Promise<ReadFileHandle>;
  /** Retained only as a compatibility seam; reads use openRead above. */
  readFile?(path: string): Promise<string>;
}

export type JsonFileErrorKind = "read" | "malformed" | "unsafe-file" | "not-object" | "update";

/** A value-free JSON file failure. */
export class JsonFileError extends Error {
  readonly kind: JsonFileErrorKind;

  constructor(kind: JsonFileErrorKind) {
    super(`JSON file operation failed: ${kind}`);
    this.name = "JsonFileError";
    this.kind = kind;
  }
}

export interface ReadJsonOptions {
  readonly fs?: JsonFileSystem;
}

export interface UpdateJsonOptions extends AtomicWriteOptions {
  readonly fs?: JsonFileSystem;
  readonly random?: RandomSource;
  readonly policy?: WritePermissionPolicy;
}

export type JsonObjectUpdater = (
  latest: JsonObject,
) => JsonObject | Promise<JsonObject>;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isJsonValue(value) && typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readAll(handle: ReadFileHandle): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = new Uint8Array(64 * 1024);
    const result = await handle.read(chunk, 0, chunk.byteLength, null);
    if (
      !Number.isInteger(result.bytesRead) ||
      result.bytesRead < 0 ||
      result.bytesRead > chunk.byteLength
    ) {
      throw new JsonFileError("read");
    }
    if (result.bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, result.bytesRead));
    total += result.bytesRead;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new JsonFileError("malformed");
  }
}

interface JsonSnapshot {
  readonly value: JsonValue;
  readonly identity: FileIdentity;
}

async function readJsonSnapshot(
  fs: JsonFileSystem,
  path: string,
): Promise<JsonSnapshot | undefined> {
  let handle: ReadFileHandle | undefined;
  let result: JsonSnapshot | undefined;
  let missing = false;
  let failure: JsonFileError | undefined;
  try {
    handle = await fs.openRead(path);
    let metadata: FileMetadata | undefined;
    try {
      metadata = await handle.fstat();
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") {
        missing = true;
      } else if (errorCode(error) === "ELOOP") {
        throw new JsonFileError("unsafe-file");
      } else {
        throw new JsonFileError("read");
    }
    }
    if (!missing && metadata === undefined) {
      throw new JsonFileError("read");
    }
    if (!missing && metadata !== undefined) {
      if (!isRegularNonSymlinkFile(metadata)) {
        throw new JsonFileError("unsafe-file");
      }
      const identity = identityFromMetadata(metadata);
      if (identity === undefined) {
        throw new JsonFileError("read");
      }
      const text = await readAll(handle);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new JsonFileError("malformed");
      }
      if (!isJsonValue(parsed)) {
        throw new JsonFileError("malformed");
      }
      result = { value: parsed, identity };
    }
  } catch (error: unknown) {
    if (error instanceof JsonFileError) {
      failure = error;
    } else if (errorCode(error) === "ENOENT") {
      missing = true;
    } else if (errorCode(error) === "ELOOP") {
      failure = new JsonFileError("unsafe-file");
    } else {
      failure = new JsonFileError("read");
    }
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        if (failure === undefined) {
          failure = new JsonFileError("read");
          result = undefined;
          missing = false;
        }
      }
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
  if (missing) {
    return undefined;
  }
  return result;
}

/** Reads a regular JSON file without echoing its path, bytes, or values in errors. */
export async function readJsonFile(
  path: string,
  options: ReadJsonOptions = {},
): Promise<JsonValue | undefined> {
  const fs = options.fs ?? nodeFileSystem;
  const snapshot = await readJsonSnapshot(fs, path);
  return snapshot?.value;
}

/**
 * Reads immediately before invoking the updater, then atomically writes its
 * returned object. A missing file starts with an empty object; malformed or
 * non-object files are never replaced.
 */
export async function updateJsonFile(
  path: string,
  update: JsonObjectUpdater,
  options: UpdateJsonOptions = {},
): Promise<void> {
  const fs = options.fs ?? nodeFileSystem;
  const snapshot = await readJsonSnapshot(fs, path);
  const latest = snapshot?.value;
  if (latest !== undefined && !isJsonObject(latest)) {
    throw new JsonFileError("not-object");
  }
  const base = latest === undefined ? {} : latest;

  let updated: JsonObject;
  try {
    const candidate = await update(base);
    if (!isJsonObject(candidate)) {
      throw new JsonFileError("update");
    }
    updated = candidate;
  } catch {
    throw new JsonFileError("update");
  }

  const atomicOptions: AtomicWriteOptions = {
    fs,
    random: options.random,
    policy: options.policy,
    expectedIdentity: snapshot?.identity ?? null,
  };
  await atomicWriteJson(path, updated, atomicOptions);
}
