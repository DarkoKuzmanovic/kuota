import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
  O_DIRECTORY,
  O_NOFOLLOW,
  O_RDONLY,
} from "node:constants";
import {
  chmod as nodeChmod,
  lstat as nodeLstat,
  open as nodeOpen,
  rename as nodeRename,
  unlink as nodeUnlink,
} from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { basename, dirname, join } from "node:path";

function metadataFromStat(stat: BigIntStats): FileMetadata {
  return {
    mode: Number(stat.mode),
    uid: stat.uid,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    isFile: () => stat.isFile(),
    isSymbolicLink: () => stat.isSymbolicLink(),
    isDirectory: () => stat.isDirectory(),
  };
}

import {
  isRegularNonSymlinkFile,
  modeForWrite,
  RESTRICTIVE_FILE_MODE,
  type WritePermissionPolicy,
} from "./permissions.js";

export type { WritePermissionPolicy } from "./permissions.js";

export interface FileHandle {
  write(
    data: Uint8Array,
    offset: number,
    length: number,
    position?: number | null,
  ): Promise<{ readonly bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ReadFileHandle {
  fstat(): Promise<FileMetadata>;
  read(
    data: Uint8Array,
    offset: number,
    length: number,
    position?: number | null,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

export interface DirectoryHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface FileMetadata {
  readonly mode: number;
  readonly uid?: number | bigint;
  readonly dev?: number | bigint;
  readonly ino?: number | bigint;
  readonly size?: number | bigint;
  readonly mtimeNs?: number | bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
}

export interface AtomicFileSystem {
  lstat(path: string): Promise<FileMetadata>;
  getEffectiveUserId?(): number | bigint | undefined;
  open(path: string, flags: string | number, mode: number): Promise<FileHandle>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  openDirectory?(path: string): Promise<DirectoryHandle>;
}

export interface RandomSource {
  randomBytes(size: number): Uint8Array;
}

export type AtomicWriteStage =
  | "serialize"
  | "inspect"
  | "random"
  | "open"
  | "write"
  | "fsync"
  | "close"
  | "chmod"
  | "conflict"
  | "rename"
  | "post-commit";

/** A value-free failure from an atomic write operation. */
export class AtomicWriteError extends Error {
  readonly stage: AtomicWriteStage;

  constructor(stage: AtomicWriteStage) {
    super(`Atomic write failed during ${stage}`);
    this.name = "AtomicWriteError";
    this.stage = stage;
  }
}

function nodeFileHandle(handle: Awaited<ReturnType<typeof nodeOpen>>): FileHandle {
  return {
    write(data, offset, length, position) {
      return handle.write(data, offset, length, position);
    },
    sync() {
      return handle.sync();
    },
    close() {
      return handle.close();
    },
  };
}

function nodeReadFileHandle(handle: Awaited<ReturnType<typeof nodeOpen>>): ReadFileHandle {
  return {
    fstat() {
      return handle.stat({ bigint: true }).then(metadataFromStat);
    },
    read(data, offset, length, position) {
      return handle.read(data, offset, length, position);
    },
    close() {
      return handle.close();
    },
  };
}

function nodeDirectoryHandle(handle: Awaited<ReturnType<typeof nodeOpen>>): DirectoryHandle {
  return {
    sync() {
      return handle.sync();
    },
    close() {
      return handle.close();
    },
  };
}

/** The production Node filesystem seam; tests may replace every operation. */
export const nodeFileSystem = {
  async lstat(path: string): Promise<FileMetadata> {
    return metadataFromStat(await nodeLstat(path, { bigint: true }));
  },
  getEffectiveUserId(): number | bigint | undefined {
    return typeof process.geteuid === "function" ? process.geteuid() : undefined;
  },
  async open(path: string, flags: string | number, mode: number): Promise<FileHandle> {
    return nodeFileHandle(await nodeOpen(path, flags, mode));
  },
  async openRead(path: string): Promise<ReadFileHandle> {
    return nodeReadFileHandle(await nodeOpen(path, O_RDONLY | O_NOFOLLOW));
  },
  async openDirectory(path: string): Promise<DirectoryHandle> {
    return nodeDirectoryHandle(await nodeOpen(path, O_RDONLY | O_DIRECTORY));
  },
  async chmod(path: string, mode: number): Promise<void> {
    await nodeChmod(path, mode);
  },
  async rename(from: string, to: string): Promise<void> {
    await nodeRename(from, to);
  },
  async unlink(path: string): Promise<void> {
    await nodeUnlink(path);
  },
} satisfies AtomicFileSystem & {
  openRead(path: string): Promise<ReadFileHandle>;
  openDirectory(path: string): Promise<DirectoryHandle>;
};

export type NodeFileSystem = typeof nodeFileSystem;

export const nodeRandomSource: RandomSource = {
  randomBytes(size: number): Uint8Array {
    return nodeRandomBytes(size);
  },
};

export interface AtomicWriteOptions {
  readonly fs?: AtomicFileSystem;
  readonly random?: RandomSource;
  readonly policy?: WritePermissionPolicy;
  /** Snapshot identity from the opened source read; null means the destination was absent. */
  readonly expectedIdentity?: FileIdentity | null;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

export function identityFromMetadata(metadata: FileMetadata): FileIdentity | undefined {
  try {
    if (
      metadata.dev === undefined ||
      metadata.ino === undefined ||
      metadata.size === undefined ||
      metadata.mtimeNs === undefined
    ) {
      return undefined;
    }
    return {
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      size: String(metadata.size),
      mtimeNs: String(metadata.mtimeNs),
    };
  } catch {
    return undefined;
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

interface DestinationSnapshot {
  readonly metadata: FileMetadata;
  readonly identity: FileIdentity | undefined;
}

async function inspectDestination(
  fs: AtomicFileSystem,
  destination: string,
): Promise<DestinationSnapshot | undefined> {
  try {
    const metadata = await fs.lstat(destination);
    if (!isRegularNonSymlinkFile(metadata)) {
      throw new AtomicWriteError("inspect");
    }
    return { metadata, identity: identityFromMetadata(metadata) };
  } catch (error: unknown) {
    if (error instanceof AtomicWriteError) {
      throw error;
    }
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw new AtomicWriteError("inspect");
  }
}

/**
 * Requires the destination's immediate parent to be a trusted local directory.
 * This is a caller-path precondition, not protection from malicious ancestor replacement.
 */
async function assertTrustedParentDirectory(
  fs: AtomicFileSystem,
  destination: string,
): Promise<void> {
  try {
    const parent = await fs.lstat(dirname(destination));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0) {
      throw new AtomicWriteError("inspect");
    }
    const effectiveUserId = fs.getEffectiveUserId?.();
    if (effectiveUserId !== undefined &&
        (parent.uid === undefined || String(parent.uid) !== String(effectiveUserId))) {
      throw new AtomicWriteError("inspect");
    }
  } catch (error: unknown) {
    if (error instanceof AtomicWriteError) {
      throw error;
    }
    throw new AtomicWriteError("inspect");
  }
}

function randomSuffix(random: RandomSource): string {
  let bytes: Uint8Array;
  try {
    bytes = random.randomBytes(16);
  } catch {
    throw new AtomicWriteError("random");
  }
  if (bytes.byteLength !== 16) {
    throw new AtomicWriteError("random");
  }
  let suffix = "";
  for (const byte of bytes) {
    suffix += byte.toString(16).padStart(2, "0");
  }
  return suffix;
}

function temporaryPath(destination: string, suffix: string, attempt: number): string {
  const retrySuffix = attempt === 0 ? "" : `-${attempt}`;
  return join(dirname(destination), `.${basename(destination)}.tmp-${suffix}${retrySuffix}`);
}

async function writeAll(handle: FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const remaining = data.byteLength - offset;
    const result = await handle.write(data, offset, remaining);
    if (
      !Number.isInteger(result.bytesWritten) ||
      result.bytesWritten <= 0 ||
      result.bytesWritten > remaining
    ) {
      throw new AtomicWriteError("write");
    }
    offset += result.bytesWritten;
  }
}

async function prepareTemporary(
  fs: AtomicFileSystem,
  handle: FileHandle,
  data: Uint8Array,
  temporary: string,
  mode: number,
): Promise<void> {
  let failure: AtomicWriteError | undefined;
  try {
    await writeAll(handle, data);
  } catch (error: unknown) {
    failure = error instanceof AtomicWriteError ? error : new AtomicWriteError("write");
  }

  if (failure === undefined) {
    try {
      // The handle remains open, so the mode and the bytes are synced together.
      await fs.chmod(temporary, mode);
    } catch {
      failure = new AtomicWriteError("chmod");
    }
  }

  if (failure === undefined) {
    try {
      await handle.sync();
    } catch {
      failure = new AtomicWriteError("fsync");
    }
  }

  try {
    await handle.close();
  } catch {
    if (failure === undefined) {
      failure = new AtomicWriteError("close");
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
}

async function removeTemporary(fs: AtomicFileSystem, path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
    // Cleanup must never replace the operation's value-free failure.
  }
}

function matchesExpected(
  snapshot: DestinationSnapshot | undefined,
  expected: FileIdentity | null | undefined,
): boolean {
  if (expected === undefined) {
    return true;
  }
  if (expected === null) {
    return snapshot === undefined;
  }
  return snapshot !== undefined && snapshot.identity !== undefined && sameIdentity(snapshot.identity, expected);
}

async function syncParentDirectory(fs: AtomicFileSystem, destination: string): Promise<void> {
  if (fs.openDirectory === undefined) {
    throw new AtomicWriteError("post-commit");
  }
  let handle: DirectoryHandle | undefined;
  let failure = false;
  try {
    handle = await fs.openDirectory(dirname(destination));
    await handle.sync();
  } catch {
    failure = true;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        failure = true;
      }
    }
  }
  if (failure) {
    throw new AtomicWriteError("post-commit");
  }
}

/**
 * Atomically replaces a regular destination with already-serialized content.
 * The destination is not opened for writing until serialization is complete.
 */
export async function atomicWrite(
  destination: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const fs = options.fs ?? nodeFileSystem;
  const random = options.random ?? nodeRandomSource;
  const policy = options.policy ?? "new-cache";
  const initial = await inspectDestination(fs, destination);
  const expected = options.expectedIdentity !== undefined
    ? options.expectedIdentity
    : initial === undefined
      ? null
      : initial.identity;

  if (!matchesExpected(initial, expected)) {
    throw new AtomicWriteError("conflict");
  }

  await assertTrustedParentDirectory(fs, destination);

  let data: Uint8Array;
  try {
    data = new TextEncoder().encode(content);
  } catch {
    throw new AtomicWriteError("write");
  }

  const suffix = randomSuffix(random);
  let temporary = "";
  let temporaryCreated = false;
  let renamed = false;

  try {
    let handle: FileHandle | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      temporary = temporaryPath(destination, suffix, attempt);
      try {
        handle = await fs.open(temporary, "wx", RESTRICTIVE_FILE_MODE);
        break;
      } catch (error: unknown) {
        if (errorCode(error) === "EEXIST" && attempt < 7) {
          continue;
        }
        throw new AtomicWriteError("open");
      }
    }
    if (handle === undefined) {
      throw new AtomicWriteError("open");
    }
    temporaryCreated = true;

    const mode = modeForWrite(policy, initial?.metadata.mode);
    await prepareTemporary(fs, handle, data, temporary, mode);

    // Recheck the destination and trusted immediate parent immediately before rename.
    // A changed or newly appearing destination is never overwritten after detection.
    const current = await inspectDestination(fs, destination);
    if (!matchesExpected(current, expected)) {
      throw new AtomicWriteError("conflict");
    }
    await assertTrustedParentDirectory(fs, destination);
    try {
      await fs.rename(temporary, destination);
      renamed = true;
    } catch {
      throw new AtomicWriteError("rename");
    }
    await syncParentDirectory(fs, destination);
  } finally {
    if (temporaryCreated && !renamed) {
      await removeTemporary(fs, temporary);
    }
  }
}

/** Validates JSON-shaped data without invoking getters or traversing cyclic graphs. */
export function isJsonValue(value: unknown): boolean {
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
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        return false;
      }
      continue;
    }
    if (typeof current !== "object" || active.has(current)) {
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
        const index = Number(key);
        if (!(Number.isInteger(index) && index >= 0 && index < length && String(index) === key)) {
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

/** Serializes and validates before any destination inspection or filesystem operation. */
export async function atomicWriteJson(
  destination: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  try {
    if (!isJsonValue(value)) {
      throw new AtomicWriteError("serialize");
    }
  } catch (error: unknown) {
    if (error instanceof AtomicWriteError) {
      throw error;
    }
    throw new AtomicWriteError("serialize");
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new AtomicWriteError("serialize");
  }
  if (serialized === undefined) {
    throw new AtomicWriteError("serialize");
  }
  await atomicWrite(destination, `${serialized}\n`, options);
}
