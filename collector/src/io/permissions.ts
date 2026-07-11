/** The mode used for every newly-created cache or sensitive file. */
export const RESTRICTIVE_FILE_MODE = 0o600;

/** Policies for replacing usage caches versus shared sensitive files. */
export type WritePermissionPolicy = "new-cache" | "preserve-existing";

/**
 * Selects the mode for the temporary file before it is renamed into place.
 * Existing sensitive files retain only ordinary permission bits; ownership,
 * ACLs, and special mode bits are outside this primitive's promise;
 * newly-created files always start and finish at 0600.
 */
export function modeForWrite(
  policy: WritePermissionPolicy,
  existingMode: number | undefined,
): number {
  if (policy === "new-cache" || existingMode === undefined) {
    return RESTRICTIVE_FILE_MODE;
  }
  return existingMode & 0o777;
}

/** True only for a regular, non-symlink destination metadata record. */
export function isRegularNonSymlinkFile(metadata: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): boolean {
  return metadata.isFile() && !metadata.isSymbolicLink();
}
