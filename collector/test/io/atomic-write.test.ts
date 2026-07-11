import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  atomicWrite,
  atomicWriteJson,
  AtomicWriteError,
  identityFromMetadata,
  nodeFileSystem,
  type AtomicFileSystem,
  type FileHandle,
  type RandomSource,
} from "../../src/io/atomic-write.js";
import type { JsonFileSystem } from "../../src/io/json-file.js";

const CACHE_MODE = 0o600;
const ORIGINAL = "original-synthetic-content";
const PROPOSED = "proposed-synthetic-content";
const SECRET = "synthetic-secret-value";

type FailureStage = "lstat" | "random" | "open" | "write" | "fsync" | "close" | "chmod" | "rename" | "post-commit";

const deterministicRandom: RandomSource = {
  randomBytes(size: number): Uint8Array {
    return new Uint8Array(size).fill(0x2a);
  },
};

function errorFor(stage: FailureStage): Error {
  return new Error(`synthetic ${stage} failure at ${SECRET}`);
}

function failingFileSystem(stage: Exclude<FailureStage, "random">): JsonFileSystem {
  const base = nodeFileSystem;
  const fs: JsonFileSystem = {
    ...base,
    async lstat(filePath) {
      if (stage === "lstat") {
        throw errorFor(stage);
      }
      return base.lstat(filePath);
    },
    async open(filePath, flags, mode) {
      if (stage === "open") {
        throw errorFor(stage);
      }
      const handle = await base.open(filePath, flags, mode);
      const wrapped: FileHandle = {
        async write(data, offset, length, position) {
          if (stage === "write") {
            throw errorFor(stage);
          }
          return handle.write(data, offset, length, position);
        },
        async sync() {
          if (stage === "fsync") {
            throw errorFor(stage);
          }
          return handle.sync();
        },
        async close() {
          if (stage === "close") {
            await handle.close();
            throw errorFor(stage);
          }
          return handle.close();
        },
      };
      return wrapped;
    },
    async chmod(filePath, mode) {
      if (stage === "chmod") {
        throw errorFor(stage);
      }
      return base.chmod(filePath, mode);
    },
    async rename(from, to) {
      if (stage === "rename") {
        throw errorFor(stage);
      }
      return base.rename(from, to);
    },
    async openDirectory(directoryPath) {
      const handle = await base.openDirectory(directoryPath);
      if (stage === "post-commit") {
        return {
          sync() {
            throw errorFor(stage);
          },
          close: () => handle.close(),
        };
      }
      return handle;
    },
  };
  return fs;
}

function failingRandom(): RandomSource {
  return {
    randomBytes(): Uint8Array {
      throw errorFor("random");
    },
  };
}

async function withDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "kuota-atomic-synthetic-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function temporaryEntries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.includes(".tmp-"));
}

function assertSafeError(error: unknown, forbidden: readonly string[]): void {
  assert.ok(error instanceof Error);
  for (const value of forbidden) {
    assert.equal(error.message.includes(value), false, `error leaked ${value}`);
  }
}

async function writeInitial(path: string): Promise<void> {
  await writeFile(path, ORIGINAL, { encoding: "utf8", mode: CACHE_MODE });
  await chmod(path, CACHE_MODE);
}

test("atomic JSON writes create restrictive cache files and replace atomically", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "usage-cache.json");
    await atomicWriteJson(
      path,
      { usage: 42, marker: "synthetic" },
      { fs: nodeFileSystem, random: deterministicRandom, policy: "new-cache" },
    );

    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      usage: 42,
      marker: "synthetic",
    });
    assert.equal((await stat(path)).mode & 0o777, CACHE_MODE);
    assert.deepEqual(await temporaryEntries(directory), []);
  });
});

test("atomic replacement changes the destination inode without leaving a temp file", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "usage-cache.json");
    await writeInitial(path);
    const originalInode = (await stat(path)).ino;

    await atomicWrite(path, PROPOSED, {
      fs: nodeFileSystem,
      random: deterministicRandom,
      policy: "new-cache",
    });

    assert.equal(await readFile(path, "utf8"), PROPOSED);
    assert.notEqual((await stat(path)).ino, originalInode);
    assert.deepEqual(await temporaryEntries(directory), []);
  });
});

test("permission-preserving writes retain an existing sensitive file mode", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "auth-shaped-synthetic.json");
    await writeFile(path, JSON.stringify({ unrelated: "preserve-me" }), "utf8");
    await chmod(path, 0o640);

    await atomicWriteJson(
      path,
      { unrelated: "preserve-me", refreshed: true },
      {
        fs: nodeFileSystem,
        random: deterministicRandom,
        policy: "preserve-existing",
      },
    );

    assert.equal((await stat(path)).mode & 0o777, 0o640);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      unrelated: "preserve-me",
      refreshed: true,
    });
  });
});

test("permission-preserving writes use 0600 for a new sensitive file", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "new-auth-shaped-synthetic.json");
    await atomicWriteJson(
      path,
      { synthetic: true },
      { fs: nodeFileSystem, random: deterministicRandom, policy: "preserve-existing" },
    );

    assert.equal((await stat(path)).mode & 0o777, CACHE_MODE);
  });
});

test("serialization happens before any filesystem operation and preserves the original", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "serialization-synthetic.json");
    await writeInitial(path);
    const calls: string[] = [];
    const observingFs: AtomicFileSystem = {
      ...nodeFileSystem,
      async lstat(filePath) {
        calls.push(`lstat:${filePath}`);
        return nodeFileSystem.lstat(filePath);
      },
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await assert.rejects(
      atomicWriteJson(path, cyclic, {
        fs: observingFs,
        random: deterministicRandom,
        policy: "new-cache",
      }),
      (error: unknown) => {
        assert.ok(error instanceof AtomicWriteError);
        assert.equal(error.stage, "serialize");
        assertSafeError(error, [path, SECRET, PROPOSED]);
        return true;
      },
    );

    assert.deepEqual(calls, []);
    assert.equal(await readFile(path, "utf8"), ORIGINAL);
    assert.deepEqual(await temporaryEntries(directory), []);
  });
});

test("rejects native, accessor, symbol, and cyclic JSON values as serialization failures", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "value-shapes-synthetic.json");
    const getter: Record<string, unknown> = {};
    Object.defineProperty(getter, "value", {
      enumerable: true,
      get() {
        throw new Error(`getter failed with ${SECRET}`);
      },
    });
    const symbolValue: Record<string, unknown> = {};
    Object.defineProperty(symbolValue, Symbol("value"), { enumerable: true, value: true });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    class CustomValue {
      readonly value = true;
    }
    const candidates: readonly unknown[] = [
      new Date(),
      new Map<string, string>(),
      new CustomValue(),
      getter,
      symbolValue,
      cycle,
    ];

    for (const candidate of candidates) {
      await assert.rejects(
        atomicWriteJson(path, candidate, { fs: nodeFileSystem, random: deterministicRandom }),
        (error: unknown) => error instanceof AtomicWriteError && error.stage === "serialize",
      );
    }
    assert.deepEqual(await temporaryEntries(directory), []);
  });
});

test("all injected pre-rename failures preserve the original and clean temporary files", async () => {
  const stages: readonly FailureStage[] = [
    "lstat",
    "random",
    "open",
    "write",
    "fsync",
    "close",
    "chmod",
    "rename",
  ];

  for (const stage of stages) {
    await withDirectory(async (directory) => {
      const path = join(directory, `failure-${stage}.json`);
      await writeInitial(path);
      const fs = stage === "random" ? nodeFileSystem : failingFileSystem(stage);
      const random = stage === "random" ? failingRandom() : deterministicRandom;

      await assert.rejects(
        atomicWrite(path, PROPOSED, {
          fs,
          random,
          policy: "new-cache",
        }),
        (error: unknown) => {
          assert.ok(error instanceof AtomicWriteError);
          assert.equal(error.stage, stage === "lstat" ? "inspect" : stage);
          assertSafeError(error, [path, ORIGINAL, PROPOSED, SECRET]);
          return true;
        },
      );

      assert.equal(await readFile(path, "utf8"), ORIGINAL, stage);
      assert.deepEqual(await temporaryEntries(directory), [], stage);
    });
  }
});

test("writes refuse symlink and non-regular destinations", async () => {
  await withDirectory(async (directory) => {
    const target = join(directory, "target-synthetic.json");
    const link = join(directory, "link-synthetic.json");
    await writeInitial(target);
    await symlink(target, link);

    await assert.rejects(
      atomicWrite(link, PROPOSED, {
        fs: nodeFileSystem,
        random: deterministicRandom,
        policy: "new-cache",
      }),
      (error: unknown) => {
        assert.ok(error instanceof AtomicWriteError);
        assert.equal(error.stage, "inspect");
        assertSafeError(error, [link, target, PROPOSED]);
        return true;
      },
    );
    assert.equal(await readFile(target, "utf8"), ORIGINAL);

    const directoryPath = join(directory, "directory-destination");
    await mkdir(directoryPath);
    await assert.rejects(
      atomicWrite(directoryPath, PROPOSED, {
        fs: nodeFileSystem,
        random: deterministicRandom,
        policy: "new-cache",
      }),
      (error: unknown) => {
        assert.ok(error instanceof AtomicWriteError);
        assert.equal(error.stage, "inspect");
        return true;
      },
    );
  });
});

test("rejects unsafe immediate parents before creating any temporary file", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "parent-precondition-synthetic.json");
    const cases = [
      {
        label: "group-or-other-writable",
        metadata: {
          mode: 0o40770,
          uid: 1000,
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        },
      },
      {
        label: "wrong-owner",
        metadata: {
          mode: 0o40700,
          uid: 1001,
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        },
      },
      {
        label: "symlink",
        metadata: {
          mode: 0o40700,
          uid: 1000,
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => true,
        },
      },
      {
        label: "non-directory",
        metadata: {
          mode: 0o100700,
          uid: 1000,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        },
      },
    ] as const;

    for (const candidate of cases) {
      const operations: string[] = [];
      const fs: AtomicFileSystem = {
        ...nodeFileSystem,
        getEffectiveUserId: () => 1000,
        async lstat(filePath) {
          if (filePath === path) {
            const error = new Error("missing destination");
            Object.assign(error, { code: "ENOENT" });
            throw error;
          }
          if (filePath === directory) {
            return candidate.metadata;
          }
          return nodeFileSystem.lstat(filePath);
        },
        async open() {
          operations.push("open");
          throw new Error("temporary creation must not be reached");
        },
        async chmod() {
          operations.push("chmod");
        },
        async rename() {
          operations.push("rename");
        },
      };

      await assert.rejects(
        atomicWrite(path, PROPOSED, { fs, random: deterministicRandom, policy: "new-cache" }),
        (error: unknown) => error instanceof AtomicWriteError && error.stage === "inspect",
        candidate.label,
      );
      assert.deepEqual(operations, [], candidate.label);
      assert.deepEqual(await temporaryEntries(directory), [], candidate.label);
      await assert.rejects(stat(path), candidate.label);
    }
  });
});

test("writes partial chunks and follows the durability order", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "order-synthetic.json");
    const calls: string[] = [];
    const fs: AtomicFileSystem = {
      ...nodeFileSystem,
      async lstat(filePath) {
        calls.push("lstat");
        return nodeFileSystem.lstat(filePath);
      },
      async open(filePath, flags, mode) {
        calls.push("open");
        const handle = await nodeFileSystem.open(filePath, flags, mode);
        return {
          async write(data, offset, length, position) {
            calls.push("write");
            return handle.write(data, offset, Math.min(2, length), position);
          },
          async sync() {
            calls.push("fsync");
            await handle.sync();
          },
          async close() {
            calls.push("close");
            await handle.close();
          },
        };
      },
      async chmod(filePath, mode) {
        calls.push("chmod");
        await nodeFileSystem.chmod(filePath, mode);
      },
      async rename(from, to) {
        calls.push("rename");
        await nodeFileSystem.rename(from, to);
      },
      async openDirectory(directoryPath) {
        calls.push("directory-open");
        const handle = await nodeFileSystem.openDirectory(directoryPath);
        return {
          async sync() {
            calls.push("directory-sync");
            await handle.sync();
          },
          async close() {
            calls.push("directory-close");
            await handle.close();
          },
        };
      },
    };

    await atomicWrite(path, PROPOSED, { fs, random: deterministicRandom, policy: "new-cache" });
    assert.equal(await readFile(path, "utf8"), PROPOSED);
    assert.ok(calls.filter((call) => call === "write").length > 1);
    assert.deepEqual(calls.filter((call) => call !== "write"), [
      "lstat",
      "lstat",
      "open",
      "chmod",
      "fsync",
      "close",
      "lstat",
      "lstat",
      "rename",
      "directory-open",
      "directory-sync",
      "directory-close",
    ]);
  });
});

test("retries a colliding temporary name without unlinking the collision", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "collision-synthetic.json");
    const collision = join(directory, ".collision-synthetic.json.tmp-" + "2a".repeat(16));
    await writeFile(collision, "collision-synthetic-content", "utf8");

    await atomicWrite(path, PROPOSED, { fs: nodeFileSystem, random: deterministicRandom, policy: "new-cache" });
    assert.equal(await readFile(path, "utf8"), PROPOSED);
    assert.equal(await readFile(collision, "utf8"), "collision-synthetic-content");
    assert.equal((await readdir(directory)).filter((entry) => entry.startsWith(".collision-synthetic.json.tmp-")).length, 1);
  });
});

test("bounds temporary collision retries and leaves every collision untouched", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "collision-exhaustion-synthetic.json");
    const opened: string[] = [];
    let unlinkCalls = 0;
    const fs: AtomicFileSystem = {
      ...nodeFileSystem,
      async open(filePath) {
        opened.push(filePath);
        const error = new Error("collision");
        Object.assign(error, { code: "EEXIST" });
        throw error;
      },
      async unlink(filePath) {
        unlinkCalls += 1;
        await nodeFileSystem.unlink(filePath);
      },
    };

    await assert.rejects(
      atomicWrite(path, PROPOSED, { fs, random: deterministicRandom, policy: "new-cache" }),
      (error: unknown) => error instanceof AtomicWriteError && error.stage === "open",
    );
    assert.equal(opened.length, 8);
    assert.equal(unlinkCalls, 0);
  });
});

test("aborts on an identity change immediately before rename", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "identity-synthetic.json");
    await writeInitial(path);
    const originalMetadata = await nodeFileSystem.lstat(path);
    const expected = identityFromMetadata(originalMetadata);
    assert.ok(expected);
    let destinationLstatCalls = 0;
    const fs: AtomicFileSystem = {
      ...nodeFileSystem,
      async lstat(filePath) {
        if (filePath === path) {
          destinationLstatCalls += 1;
        }
        const metadata = await nodeFileSystem.lstat(filePath);
        if (filePath === path && destinationLstatCalls === 2) {
          return {
            ...metadata,
            ino: typeof metadata.ino === "bigint" ? metadata.ino + 1n : Number(metadata.ino) + 1,
          };
        }
        return metadata;
      },
    };

    await assert.rejects(
      atomicWrite(path, PROPOSED, {
        fs,
        random: deterministicRandom,
        policy: "preserve-existing",
        expectedIdentity: expected,
      }),
      (error: unknown) => error instanceof AtomicWriteError && error.stage === "conflict",
    );
    assert.equal(await readFile(path, "utf8"), ORIGINAL);
    assert.deepEqual(await temporaryEntries(directory), []);
  });
});

test("reports post-commit directory durability failure after leaving the new destination", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "directory-sync-synthetic.json");
    const fs: AtomicFileSystem = {
      ...nodeFileSystem,
      async openDirectory(directoryPath) {
        const handle = await nodeFileSystem.openDirectory(directoryPath);
        return {
          async sync() {
            await handle.close();
            throw new Error(`directory sync failed with ${SECRET}`);
          },
          close: () => handle.close(),
        };
      },
    };

    await assert.rejects(
      atomicWrite(path, PROPOSED, { fs, random: deterministicRandom, policy: "new-cache" }),
      (error: unknown) => {
        assert.ok(error instanceof AtomicWriteError);
        assert.equal(error.stage, "post-commit");
        assertSafeError(error, [path, ORIGINAL, PROPOSED, SECRET]);
        return true;
      },
    );
    assert.equal(await readFile(path, "utf8"), PROPOSED);
    assert.deepEqual(await temporaryEntries(directory), []);
  });
});

test("preserves only ordinary permission bits", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "ordinary-mode-synthetic.json");
    await writeInitial(path);
    await chmod(path, 0o6751);

    await atomicWrite(path, PROPOSED, {
      fs: nodeFileSystem,
      random: deterministicRandom,
      policy: "preserve-existing",
    });
    assert.equal((await stat(path)).mode & 0o7777, 0o751);
  });
});