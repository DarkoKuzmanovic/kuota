import { mkdir as nodeMkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  nodeFileSystem,
  type DirectoryHandle,
  type FileMetadata,
} from "./atomic-write.js";

/** Mode used when creating a Kuota-owned private cache directory. */
const CACHE_DIRECTORY_MODE = 0o700;

/**
 * A narrow injected directory seam. Only the immediate private cache directory
 * is created; the parent must already exist as a trusted local directory.
 */
export interface CacheDirectoryFileSystem {
  lstat(path: string): Promise<FileMetadata>;
  mkdir(path: string, mode: number): Promise<void>;
  getEffectiveUserId?(): number | bigint | undefined;
  openDirectory?(path: string): Promise<DirectoryHandle>;
}

/** The production directory seam; tests may replace every operation. */
export const nodeCacheDirectoryFileSystem: CacheDirectoryFileSystem = {
  lstat(path: string): Promise<FileMetadata> {
    return nodeFileSystem.lstat(path);
  },
  getEffectiveUserId(): number | bigint | undefined {
    return nodeFileSystem.getEffectiveUserId?.();
  },
  async mkdir(path: string, mode: number): Promise<void> {
    await nodeMkdir(path, { recursive: false, mode });
  },
  openDirectory(path: string): Promise<DirectoryHandle> {
    return nodeFileSystem.openDirectory(path);
  },
};

/** A value-free failure while preparing a Kuota-owned private cache directory. */
export class CacheDirectoryError extends Error {
  constructor() {
    super("Cache directory preparation failed");
    this.name = "CacheDirectoryError";
  }
}

/** Resolves the Kuota-owned cache directory without inspecting the filesystem. */
export function resolveKuotaCacheDirectory(homeDirectory: string): string {
  return join(homeDirectory, ".cache", "kuota");
}

/**
 * Ensures only the immediate private cache directory exists. The parent must
 * already be a real, current-user-owned directory without group/other write
 * permission; the child is created non-recursively with mode 0700, tolerating
 * an EEXIST race and revalidating afterwards. This trusts the ancestor chain
 * above the parent — it is a caller-path precondition, not protection against a
 * malicious ancestor replacement.
 */
export async function ensureKuotaCacheDirectory(
  directory: string,
  fs: CacheDirectoryFileSystem = nodeCacheDirectoryFileSystem,
): Promise<void> {
  const parent = dirname(directory);
  const parentMeta = await requiredLstat(fs, parent);
  assertPrivateDirectory(parentMeta, fs);

  const existing = await optionalLstat(fs, directory);
  if (existing !== undefined) {
    assertPrivateDirectory(existing, fs);
    return;
  }

  let created = false;
  try {
    await fs.mkdir(directory, CACHE_DIRECTORY_MODE);
    created = true;
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") {
      throw new CacheDirectoryError();
    }
  }

  if (created) {
    await syncDirectory(fs, parent);
  }

  const revalidated = await requiredLstat(fs, directory);
  assertPrivateDirectory(revalidated, fs);
}

function assertPrivateDirectory(
  metadata: FileMetadata,
  fs: CacheDirectoryFileSystem,
): void {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new CacheDirectoryError();
  }
  const effectiveUserId = fs.getEffectiveUserId?.();
  if (
    effectiveUserId !== undefined &&
    (metadata.uid === undefined ||
      String(metadata.uid) !== String(effectiveUserId))
  ) {
    throw new CacheDirectoryError();
  }
}

async function requiredLstat(
  fs: CacheDirectoryFileSystem,
  path: string,
): Promise<FileMetadata> {
  try {
    return await fs.lstat(path);
  } catch {
    throw new CacheDirectoryError();
  }
}

async function optionalLstat(
  fs: CacheDirectoryFileSystem,
  path: string,
): Promise<FileMetadata | undefined> {
  try {
    return await fs.lstat(path);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw new CacheDirectoryError();
  }
}

async function syncDirectory(
  fs: CacheDirectoryFileSystem,
  path: string,
): Promise<void> {
  if (fs.openDirectory === undefined) {
    return;
  }
  let handle: DirectoryHandle | undefined;
  let failed = false;
  try {
    handle = await fs.openDirectory(path);
    await handle.sync();
  } catch {
    failed = true;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        failed = true;
      }
    }
  }
  if (failed) {
    throw new CacheDirectoryError();
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return typeof descriptor?.value === "string" ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
