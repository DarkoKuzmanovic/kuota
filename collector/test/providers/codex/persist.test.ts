import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  nodeFileSystem,
  type FileMetadata,
  type RandomSource,
} from "../../../src/io/atomic-write.js";
import type { JsonFileSystem } from "../../../src/io/json-file.js";
import {
  persistCodexRefreshedAuth,
  type CodexPersistOptions,
} from "../../../src/providers/codex/persist.js";

const INITIATING = {
  accountId: "synthetic-account",
  access: "synthetic-old-access",
  refresh: "synthetic-old-refresh",
} as const;
const REFRESHED = {
  access: "synthetic-new-access",
  refresh: "synthetic-new-refresh",
  expires: 1_800_000_000_000,
} as const;
const RANDOM: RandomSource = {
  randomBytes(size: number): Uint8Array {
    return new Uint8Array(size).fill(0x50);
  },
};

async function withDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "kuota-codex-persist-synthetic-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function authDocument(codex: unknown): Record<string, unknown> {
  return {
    anthropic: { type: "oauth", access: "synthetic-unrelated" },
    "openai-codex": codex,
    umans: { type: "api_key", key: "synthetic-unrelated" },
  };
}

function initiatingEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "oauth",
    accountId: INITIATING.accountId,
    access: INITIATING.access,
    refresh: INITIATING.refresh,
    unknownCodexField: { preserve: true },
    ...overrides,
  };
}

async function writeAuth(path: string, codex = initiatingEntry()): Promise<void> {
  await writeFile(path, JSON.stringify(authDocument(codex)), "utf8");
}

function persist(path: string, overrides: Partial<CodexPersistOptions> = {}) {
  return persistCodexRefreshedAuth({
    authPath: path,
    initiatingCredential: INITIATING,
    refreshedCredential: REFRESHED,
    random: RANDOM,
    ...overrides,
  });
}

async function assertNoTemporary(directory: string): Promise<void> {
  assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith(".")), []);
}

function changedIdentity(metadata: FileMetadata): FileMetadata {
  if (metadata.ino === undefined) throw new Error("synthetic metadata must identify files");
  return {
    ...metadata,
    ino: typeof metadata.ino === "bigint" ? metadata.ino + 1n : metadata.ino + 1,
  };
}

test("persists a matching Codex refresh without changing mode or unrelated fields", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "auth.json");
    await writeAuth(path);
    await chmod(path, 0o640);

    assert.equal(await persist(path), "updated");
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), authDocument({
      type: "oauth",
      accountId: INITIATING.accountId,
      access: REFRESHED.access,
      refresh: REFRESHED.refresh,
      expires: REFRESHED.expires,
      unknownCodexField: { preserve: true },
    }));
  });
});

test("preserves latest refresh and expiry when the refresh response omits them", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "auth.json");
    await writeAuth(path, initiatingEntry({ expires: 1_700_000_000_000 }));

    assert.equal(await persist(path, {
      refreshedCredential: { access: REFRESHED.access },
    }), "updated");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), authDocument({
      type: "oauth",
      accountId: INITIATING.accountId,
      access: REFRESHED.access,
      refresh: INITIATING.refresh,
      expires: 1_700_000_000_000,
      unknownCodexField: { preserve: true },
    }));
  });
});

test("already-current refreshes perform no write", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "auth.json");
    await writeAuth(path, initiatingEntry({
      access: REFRESHED.access,
      refresh: REFRESHED.refresh,
      expires: REFRESHED.expires,
    }));
    let writeOpens = 0;
    const fs: JsonFileSystem = {
      ...nodeFileSystem,
      async open(filePath, flags, mode) {
        writeOpens += 1;
        return nodeFileSystem.open(filePath, flags, mode);
      },
    };

    assert.equal(await persist(path, { fs }), "already-current");
    assert.equal(writeOpens, 0);
  });
});

test("does not accept a refreshed access token paired with another process's rotated refresh", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "auth.json");
    await writeAuth(path, initiatingEntry({
      access: REFRESHED.access,
      refresh: "synthetic-other-refresh",
    }));
    let writeOpens = 0;
    const fs: JsonFileSystem = {
      ...nodeFileSystem,
      async open(filePath, flags, mode) {
        writeOpens += 1;
        return nodeFileSystem.open(filePath, flags, mode);
      },
    };

    assert.equal(await persist(path, { fs, refreshedCredential: { access: REFRESHED.access } }), "conflict");
    assert.equal(writeOpens, 0);
  });
});

test("missing, malformed, and mismatched Codex entries conflict without writing", async () => {
  await withDirectory(async (directory) => {
    const cases: readonly [string, unknown | undefined][] = [
      ["missing-file", undefined],
      ["missing-entry", { unrelated: true }],
      ["malformed-entry", authDocument("not-an-entry")],
      ["wrong-type", authDocument(initiatingEntry({ type: "api_key" }))],
      ["account-mismatch", authDocument(initiatingEntry({ accountId: "synthetic-other-account" }))],
      ["access-mismatch", authDocument(initiatingEntry({ access: "synthetic-other-access" }))],
      ["refresh-mismatch", authDocument(initiatingEntry({ refresh: "synthetic-other-refresh" }))],
    ];

    for (const [name, document] of cases) {
      const path = join(directory, `${name}.json`);
      if (document !== undefined) {
        await writeFile(path, JSON.stringify(document), "utf8");
      }
      let writeOpens = 0;
      const fs: JsonFileSystem = {
        ...nodeFileSystem,
        async open(filePath, flags, mode) {
          writeOpens += 1;
          return nodeFileSystem.open(filePath, flags, mode);
        },
      };

      assert.equal(await persist(path, { fs }), "conflict", name);
      assert.equal(writeOpens, 0, name);
    }
  });
});

test("injected destination identity changes conflict without overwriting", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "auth.json");
    await writeAuth(path);
    let destinationChecks = 0;
    const fs: JsonFileSystem = {
      ...nodeFileSystem,
      async lstat(filePath) {
        const metadata = await nodeFileSystem.lstat(filePath);
        if (filePath !== path) return metadata;
        destinationChecks += 1;
        return destinationChecks === 2 ? changedIdentity(metadata) : metadata;
      },
    };

    assert.equal(await persist(path, { fs }), "conflict");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), authDocument(initiatingEntry()));
    await assertNoTemporary(directory);
  });
});

test("latest-read identity races preserve the external writer and clean the temporary file", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "auth.json");
    const externalPath = join(directory, "external.json");
    const external = JSON.stringify(authDocument(initiatingEntry({ access: "synthetic-external-access" })));
    await writeAuth(path);
    let destinationChecks = 0;
    const fs: JsonFileSystem = {
      ...nodeFileSystem,
      async lstat(filePath) {
        if (filePath === path) {
          destinationChecks += 1;
          if (destinationChecks === 2) {
            await writeFile(externalPath, external, "utf8");
            await rename(externalPath, path);
          }
        }
        return nodeFileSystem.lstat(filePath);
      },
    };

    assert.equal(await persist(path, { fs }), "conflict");
    assert.equal(await readFile(path, "utf8"), external);
    await assertNoTemporary(directory);
  });
});

for (const stage of ["open", "write", "fsync", "chmod", "close", "rename"] as const) {
  test(`maps ${stage} failure to a value-free error and cleans its temporary file`, async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, "auth.json");
      await writeAuth(path);
      const fs: JsonFileSystem = {
        ...nodeFileSystem,
        async open(filePath, flags, mode) {
          if (stage === "open") throw new Error("synthetic-open-secret");
          const handle = await nodeFileSystem.open(filePath, flags, mode);
          if (stage === "write") {
            return { ...handle, async write() { throw new Error("synthetic-write-secret"); } };
          }
          if (stage === "fsync") {
            return { ...handle, async sync() { throw new Error("synthetic-fsync-secret"); } };
          }
          if (stage === "close") {
            return {
              ...handle,
              async close() {
                await handle.close();
                throw new Error("synthetic-close-secret");
              },
            };
          }
          return handle;
        },
        async chmod(filePath, mode) {
          if (stage === "chmod") throw new Error("synthetic-chmod-secret");
          return nodeFileSystem.chmod(filePath, mode);
        },
        async rename(from, to) {
          if (stage === "rename") throw new Error("synthetic-rename-secret");
          return nodeFileSystem.rename(from, to);
        },
      };

      assert.equal(await persist(path, { fs }), "error");
      await assertNoTemporary(directory);
    });
  });
}

test("maps serialization failure to a value-free error before opening a temporary file", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "auth.json");
    await writeAuth(path);
    const original = Object.getOwnPropertyDescriptor(JSON, "stringify");
    if (original === undefined) throw new Error("missing JSON stringify");
    Object.defineProperty(JSON, "stringify", {
      configurable: true,
      writable: true,
      value: () => { throw new Error("synthetic-serialize-secret"); },
    });
    try {
      assert.equal(await persist(path), "error");
    } finally {
      Object.defineProperty(JSON, "stringify", original);
    }
    await assertNoTemporary(directory);
  });
});

test("post-commit parent-sync failure performs one read-back and remains indeterminate", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "auth.json");
    await writeAuth(path);
    let writes = 0;
    let reads = 0;
    const fs: JsonFileSystem = {
      ...nodeFileSystem,
      async open(filePath, flags, mode) {
        writes += 1;
        return nodeFileSystem.open(filePath, flags, mode);
      },
      async openRead(filePath) {
        reads += 1;
        return nodeFileSystem.openRead(filePath);
      },
      async openDirectory() {
        return {
          async sync() { throw new Error("synthetic-parent-sync-secret"); },
          async close() {},
        };
      },
    };

    assert.equal(await persist(path, { fs }), "indeterminate");
    assert.equal(writes, 1);
    assert.equal(reads, 2);
    await assertNoTemporary(directory);
  });
});
