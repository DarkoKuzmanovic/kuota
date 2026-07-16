import { spawn, type ChildProcess } from "node:child_process";
import { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } from "node:constants";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearTimeout as clearNodeTimeout,
  setImmediate as setNodeImmediate,
  setTimeout as setNodeTimeout,
} from "node:timers";

import { ensureKuotaCacheDirectory, resolveKuotaCacheDirectory } from "../io/cache-directory.js";

const FLOCK_PATH = "/usr/bin/flock";
const READY_FRAME = "KUOTA_LOCK_READY\n";
const LOCK_MODE = 0o600;
const STARTUP_TIMEOUT_MS = 1_000;
const RELEASE_TIMEOUT_MS = 1_000;

export type CollectorLockResult =
  | { readonly state: "acquired"; readonly release: () => Promise<void> }
  | { readonly state: "contended" }
  | { readonly state: "unavailable" };

export interface CollectorLockOptions {
  readonly homeDirectory?: string;
  readonly lockPath?: string;
  readonly flockPath?: string;
  readonly holderPath?: string;
  readonly nodePath?: string;
  readonly startupTimeoutMs?: number;
  readonly releaseTimeoutMs?: number;
}

export function resolveCollectorLockPath(homeDirectory: string): string {
  return join(resolveKuotaCacheDirectory(homeDirectory), "collector.lock");
}

async function trustedExecutable(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      (metadata.mode & 0o022) === 0 &&
      (metadata.mode & 0o111) !== 0
    );
  } catch {
    return false;
  }
}

async function trustedRegularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

async function ensureLockFile(path: string): Promise<boolean> {
  try {
    const handle = await open(path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, LOCK_MODE);
    await handle.close();
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EEXIST") return false;
  }
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === LOCK_MODE;
  } catch {
    return false;
  }
}

function waitForReady(child: ChildProcess, timeoutMs: number): Promise<"ready" | "contended" | "failed"> {
  return new Promise((resolve) => {
    let settled = false;
    let received = "";
    const finish = (result: "ready" | "contended" | "failed"): void => {
      if (settled) return;
      settled = true;
      clearNodeTimeout(timeout);
      ready?.removeAllListeners();
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      resolve(result);
    };
    const timeout = setNodeTimeout(() => finish("failed"), timeoutMs);
    const ready = child.stdio[3];
    const onError = (): void => finish("failed");
    const onExit = (code: number | null): void => finish(code === 1 ? "contended" : "failed");
    if (ready === null || ready === undefined || !("on" in ready)) {
      finish("failed");
      return;
    }
    ready.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received === READY_FRAME) setNodeImmediate(() => finish("ready"));
      else if (received.length >= READY_FRAME.length) finish("failed");
    });
    ready.once("error", onError);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function terminate(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearNodeTimeout(timeout);
      child.removeListener("exit", finish);
      resolve();
    };
    const timeout = setNodeTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already be gone.
      }
      finish();
    }, timeoutMs);
    child.once("exit", finish);
    try {
      child.stdin?.end();
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already be gone.
      }
    }
  });
}

/**
 * Acquires a whole-collection advisory lock. The helper runs with an empty
 * environment and only absolute executable paths; its stdout/stderr are piped
 * solely to drain them, never surfaced to the caller.
 */
export async function acquireCollectorLock(
  options: CollectorLockOptions = {},
): Promise<CollectorLockResult> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const lockPath = options.lockPath ?? resolveCollectorLockPath(homeDirectory);
  const flockPath = options.flockPath ?? FLOCK_PATH;
  const holderPath = options.holderPath ?? fileURLToPath(new URL("./lock-holder.js", import.meta.url));
  const nodePath = options.nodePath ?? process.execPath;
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const releaseTimeoutMs = options.releaseTimeoutMs ?? RELEASE_TIMEOUT_MS;
  if (
    !Number.isFinite(startupTimeoutMs) ||
    startupTimeoutMs <= 0 ||
    !Number.isFinite(releaseTimeoutMs) ||
    releaseTimeoutMs <= 0 ||
    !isAbsolute(lockPath) ||
    !isAbsolute(flockPath) ||
    !isAbsolute(nodePath) ||
    !isAbsolute(holderPath)
  ) {
    return { state: "unavailable" };
  }
  try {
    await ensureKuotaCacheDirectory(dirname(lockPath));
  } catch {
    return { state: "unavailable" };
  }
  if (
    !(await ensureLockFile(lockPath)) ||
    !(await trustedExecutable(flockPath)) ||
    !(await trustedExecutable(nodePath)) ||
    !(await trustedRegularFile(holderPath))
  ) {
    return { state: "unavailable" };
  }

  let child: ChildProcess;
  // -F/--no-fork makes flock exec the holder in place of itself, so `child.pid`
  // IS the real lock-holding process (no forked grandchild to orphan on SIGKILL).
  try {
    child = spawn(flockPath, ["-n", "-x", "-F", lockPath, nodePath, holderPath], {
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
  } catch {
    return { state: "unavailable" };
  }
  child.stdout?.resume();
  child.stderr?.resume();
  const ready = await waitForReady(child, startupTimeoutMs);
  if (ready !== "ready") {
    await terminate(child, releaseTimeoutMs);
    return { state: ready === "contended" ? "contended" : "unavailable" };
  }
  let released = false;
  return {
    state: "acquired",
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await terminate(child, releaseTimeoutMs);
    },
  };
}
