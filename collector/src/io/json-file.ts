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

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

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

function isArrayIndexKey(key: string, length: number): boolean {
  if (key === "") {
    return false;
  }
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

/**
 * Checks the object graph without invoking property accessors. The active set
 * rejects cycles while allowing a shared, non-cyclic subtree to be serialized
 * as the duplicate JSON subtree that JSON.stringify would produce.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  type Work =
    | { readonly value: unknown; readonly exit: false }
    | { readonly value: object; readonly exit: true };
  const work: Work[] = [{ value, exit: false }];
  const active = new WeakSet<object>();

  while (work.length > 0) {
    const item = work.pop();
    if (item === undefined) {
      return false;
    }
    if (item.exit) {
      active.delete(item.value);
      continue;
    }

    const current = item.value;
    if (current === null) {
      continue;
    }
    if (typeof current === "string" || typeof current === "boolean") {
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        return false;
      }
      continue;
    }
    if (typeof current !== "object") {
      return false;
    }
    if (active.has(current)) {
      return false;
    }

    let prototype: object | null;
    let keys: readonly (string | symbol)[];
    try {
      prototype = Object.getPrototypeOf(current);
      keys = Reflect.ownKeys(current);
    } catch {
      return false;
    }
    active.add(current);
    work.push({ value: current, exit: true });

    let arrayValue = false;
    try {
      arrayValue = Array.isArray(current);
    } catch {
      return false;
    }
    if (arrayValue) {
      if (prototype !== Array.prototype) {
        return false;
      }
      let lengthDescriptor: PropertyDescriptor | undefined;
      try {
        lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
      } catch {
        return false;
      }
      if (
        lengthDescriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value") ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.enumerable
      ) {
        return false;
      }
      const length = lengthDescriptor.value;
      for (const key of keys) {
        if (typeof key === "symbol") {
          return false;
        }
        if (key === "length") {
          continue;
        }
        if (!isArrayIndexKey(key, length)) {
          return false;
        }
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(current, key);
        } catch {
          return false;
        }
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")
        ) {
          return false;
        }
        work.push({ value: descriptor.value, exit: false });
      }
      continue;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    for (const key of keys) {
      if (typeof key === "symbol") {
        return false;
      }
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(current, key);
      } catch {
        return false;
      }
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        return false;
      }
      work.push({ value: descriptor.value, exit: false });
    }
  }
  return true;
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
