import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, lstat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";

import { acquireCollectorLock, resolveCollectorLockPath } from "../../src/collect/lock.js";

async function syntheticHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "kuota-lock-"));
  await mkdir(join(home, ".cache"), { mode: 0o700 });
  return home;
}

/** Ensures the Kuota lock directory exists so a test can pre-place a file at a known path. */
async function syntheticLockDirectory(home: string): Promise<string> {
  const lockDirectory = dirname(resolveCollectorLockPath(home));
  await mkdir(lockDirectory, { mode: 0o700 });
  return lockDirectory;
}

/** Finds a real OS process whose command line contains an expected, unique substring. */
async function findPidByCmdlineSubstring(substring: string): Promise<number | undefined> {
  const entries = await readdir("/proc");
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8");
      if (cmdline.split("\u0000").join(" ").includes(substring)) return pid;
    } catch {
      // The process may have exited between listing and reading; treat as absent.
    }
  }
  return undefined;
}

/** Polls for real OS process death with a bounded deadline instead of an arbitrary sleep. */
async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() >= deadline) throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function countOpenFileDescriptors(): Promise<number> {
  return (await readdir("/proc/self/fd")).length;
}

test("resolves and creates a restrictive collector lock under the Kuota cache directory", async () => {
  const home = await syntheticHome();
  try {
    assert.equal(resolveCollectorLockPath(home), join(home, ".cache", "kuota", "collector.lock"));
    const result = await acquireCollectorLock({ homeDirectory: home, startupTimeoutMs: 1_000 });
    assert.equal(result.state, "acquired");
    if (result.state === "acquired") await result.release();
    const metadata = await stat(resolveCollectorLockPath(home));
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.mode & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reports kernel contention without acquiring a second holder and releases on parent close", async () => {
  const home = await syntheticHome();
  try {
    const first = await acquireCollectorLock({ homeDirectory: home, startupTimeoutMs: 1_000 });
    assert.equal(first.state, "acquired");
    const blocked = await acquireCollectorLock({ homeDirectory: home, startupTimeoutMs: 1_000 });
    assert.equal(blocked.state, "contended");
    if (first.state === "acquired") await first.release();
    const afterRelease = await acquireCollectorLock({ homeDirectory: home, startupTimeoutMs: 1_000 });
    assert.equal(afterRelease.state, "acquired");
    if (afterRelease.state === "acquired") await afterRelease.release();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("fails safely when the absolute flock helper is unavailable before a holder starts", async () => {
  const home = await syntheticHome();
  try {
    const result = await acquireCollectorLock({
      homeDirectory: home,
      flockPath: join(home, "missing-flock"),
      startupTimeoutMs: 20,
    });
    assert.equal(result.state, "unavailable");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("releases the kernel lock after a real-process SIGKILL crash of the flock holder, allowing reacquisition", async () => {
  const home = await syntheticHome();
  try {
    const first = await acquireCollectorLock({ homeDirectory: home, startupTimeoutMs: 1_000 });
    assert.equal(first.state, "acquired");

    // -F/--no-fork makes flock exec the packaged holder in place of itself, so the
    // holder's own cmdline (not flock's original argv) identifies the real lock PID.
    const flockPid = await findPidByCmdlineSubstring("lock-holder.js");
    assert.notEqual(flockPid, undefined);
    process.kill(flockPid as number, "SIGKILL");
    await waitForProcessExit(flockPid as number);

    const reacquired = await acquireCollectorLock({ homeDirectory: home, startupTimeoutMs: 1_000 });
    assert.equal(reacquired.state, "acquired");
    if (reacquired.state === "acquired") await reacquired.release();

    // A release call after an external crash must remain a safe no-op, never a hang or throw.
    await first.release();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cleans up a startup-readiness timeout with no surviving holder, then reacquires normally", async () => {
  const home = await syntheticHome();
  const silentHolderPath = join(home, "silent-holder.js");
  await writeFile(
    silentHolderPath,
    ["process.stdin.resume();", 'process.stdin.once("end", () => undefined);', ""].join("\n"),
    { mode: 0o644 },
  );
  try {
    const result = await acquireCollectorLock({
      homeDirectory: home,
      holderPath: silentHolderPath,
      startupTimeoutMs: 50,
      releaseTimeoutMs: 300,
    });
    assert.equal(result.state, "unavailable");

    const survivorPid = await findPidByCmdlineSubstring(silentHolderPath);
    assert.equal(survivorPid, undefined);

    const reacquired = await acquireCollectorLock({ homeDirectory: home, startupTimeoutMs: 1_000 });
    assert.equal(reacquired.state, "acquired");
    if (reacquired.state === "acquired") await reacquired.release();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test(
  "escalates to SIGKILL against a stubborn real holder that ignores stdin EOF, leaving no orphan and permitting reacquisition",
  async () => {
    const home = await syntheticHome();
    const pidMarkerPath = join(home, "stubborn-holder.pid");
    const stubbornHolderPath = join(home, "stubborn-holder.js");
    await writeFile(
      stubbornHolderPath,
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(pidMarkerPath)}, String(process.pid));`,
        "try {",
        "  fs.writeSync(3, 'KUOTA_LOCK_READY\\n', null, 'utf8');",
        "} catch {",
        "  process.exitCode = 1;",
        "}",
        "process.stdin.resume();",
        "process.stdin.once('end', () => undefined); // consumes EOF but deliberately refuses to exit",
        "setInterval(() => undefined, 1_000_000); // keeps the event loop alive like a stuck holder",
        "",
      ].join("\n"),
      { mode: 0o644 },
    );
    let holderPid: number | undefined;
    try {
      const result = await acquireCollectorLock({
        homeDirectory: home,
        holderPath: stubbornHolderPath,
        startupTimeoutMs: 1_000,
        releaseTimeoutMs: 200,
      });
      assert.equal(result.state, "acquired");

      const recordedPid = (await readFile(pidMarkerPath, "utf8")).trim();
      holderPid = Number(recordedPid);
      assert.equal(Number.isInteger(holderPid) && holderPid > 0, true);
      process.kill(holderPid, 0); // confirm the real holder process is alive before release

      if (result.state === "acquired") await result.release();

      await waitForProcessExit(holderPid);
      const survivorPid = await findPidByCmdlineSubstring(stubbornHolderPath);
      assert.equal(survivorPid, undefined);

      const reacquired = await acquireCollectorLock({ homeDirectory: home, startupTimeoutMs: 1_000 });
      assert.equal(reacquired.state, "acquired");
      if (reacquired.state === "acquired") await reacquired.release();
    } finally {
      if (holderPid !== undefined) {
        try {
          process.kill(holderPid, "SIGKILL");
        } catch {
          // Already gone; nothing to clean up.
        }
      }
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("refuses a symlinked lock file without following or mutating the link target", async () => {
  const home = await syntheticHome();
  await syntheticLockDirectory(home);
  const target = join(home, "decoy-target");
  const marker = "synthetic-untouched-marker";
  await writeFile(target, marker, { mode: 0o600 });
  const lockPath = resolveCollectorLockPath(home);
  await symlink(target, lockPath);
  try {
    const result = await acquireCollectorLock({ homeDirectory: home, startupTimeoutMs: 200 });
    assert.equal(result.state, "unavailable");

    const targetContent = await readFile(target, "utf8");
    assert.equal(targetContent, marker);
    const linkMetadata = await lstat(lockPath);
    assert.equal(linkMetadata.isSymbolicLink(), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("refuses a pre-existing lock file with unsafe permissions without mutating it", async () => {
  const home = await syntheticHome();
  await syntheticLockDirectory(home);
  const lockPath = resolveCollectorLockPath(home);
  await writeFile(lockPath, "", { mode: 0o666 });
  await chmod(lockPath, 0o666); // writeFile's mode is filtered by process umask; force the exact bits.
  try {
    const result = await acquireCollectorLock({ homeDirectory: home, startupTimeoutMs: 200 });
    assert.equal(result.state, "unavailable");

    const metadata = await stat(lockPath);
    assert.equal(metadata.mode & 0o777, 0o666);
    assert.equal(metadata.size, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("refuses a symlinked holder script and never spawns anything", async () => {
  const home = await syntheticHome();
  const target = join(home, "holder-target.js");
  const marker = "synthetic-untouched-holder-marker";
  await writeFile(target, marker, { mode: 0o600 });
  const holderSymlink = join(home, "holder-symlink.js");
  await symlink(target, holderSymlink);
  try {
    const result = await acquireCollectorLock({
      homeDirectory: home,
      holderPath: holderSymlink,
      startupTimeoutMs: 200,
    });
    assert.equal(result.state, "unavailable");

    const targetContent = await readFile(target, "utf8");
    assert.equal(targetContent, marker);
    const survivorPid = await findPidByCmdlineSubstring(home);
    assert.equal(survivorPid, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("refuses a symlinked flock helper even when it targets the trusted binary", async () => {
  const home = await syntheticHome();
  const flockSymlink = join(home, "flock-symlink");
  await symlink("/usr/bin/flock", flockSymlink);
  try {
    const result = await acquireCollectorLock({
      homeDirectory: home,
      flockPath: flockSymlink,
      startupTimeoutMs: 200,
    });
    assert.equal(result.state, "unavailable");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("spawns flock with exact trusted argv, an empty environment, and no shell interpretation", async () => {
  const home = await syntheticHome();
  const recordPath = join(home, "flock-spawn-record.json");
  const flockStub = join(home, "flock-stub.js");
  await writeFile(
    flockStub,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));`,
      "process.exit(1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );

  await syntheticLockDirectory(home);
  // No slash may appear in a single path component, so the shell-injection probe below
  // touches a bare relative marker; a shell would create it in the child's cwd (ours).
  const sentinelName = `kuota-lock-shell-injection-sentinel-${process.pid}-${Date.now()}`;
  const sentinelPath = join(process.cwd(), sentinelName);
  const lockPath = join(dirname(resolveCollectorLockPath(home)), `lock-$(touch ${sentinelName})`);

  const secretEnvKey = "KUOTA_TEST_LOCK_SECRET";
  process.env[secretEnvKey] = "synthetic-lock-secret-not-real";
  let result;
  try {
    result = await acquireCollectorLock({
      homeDirectory: home,
      lockPath,
      flockPath: flockStub,
      startupTimeoutMs: 1_000,
    });
  } finally {
    delete process.env[secretEnvKey];
  }
  try {
    assert.equal(result.state, "contended");

    const recorded = JSON.parse(await readFile(recordPath, "utf8")) as {
      argv: readonly string[];
      env: Record<string, string>;
    };
    assert.equal(recorded.argv.length, 6);
    assert.deepEqual(recorded.argv.slice(0, 3), ["-n", "-x", "-F"]);
    assert.equal(recorded.argv[3], lockPath);
    assert.equal(recorded.argv[4], process.execPath);
    const holderArg = recorded.argv[5];
    assert.equal(typeof holderArg, "string");
    assert.equal(isAbsolute(holderArg ?? ""), true);
    assert.equal((holderArg ?? "").endsWith("lock-holder.js"), true);
    assert.deepEqual(recorded.env, {});

    const sentinelExists = await stat(sentinelPath).then(
      () => true,
      () => false,
    );
    assert.equal(sentinelExists, false, "no shell must interpret command substitution in argv");

    const lockFileMetadata = await lstat(lockPath);
    assert.equal(lockFileMetadata.isFile(), true);
  } finally {
    await rm(sentinelPath, { force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("leaves no leaked descriptors, holder processes, or extra artifacts after repeated normal acquire/release cycles", async () => {
  const home = await syntheticHome();
  try {
    const before = await countOpenFileDescriptors();
    for (let i = 0; i < 5; i += 1) {
      const result = await acquireCollectorLock({ homeDirectory: home, startupTimeoutMs: 1_000 });
      assert.equal(result.state, "acquired");
      if (result.state === "acquired") await result.release();
    }
    const after = await countOpenFileDescriptors();
    assert.equal(after, before);

    const survivorPid = await findPidByCmdlineSubstring(resolveCollectorLockPath(home));
    assert.equal(survivorPid, undefined);

    const lockDirectory = dirname(resolveCollectorLockPath(home));
    const entries = await readdir(lockDirectory);
    assert.deepEqual(entries, ["collector.lock"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
