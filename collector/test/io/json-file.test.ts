import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AtomicWriteError,
  nodeFileSystem,
  type RandomSource,
} from "../../src/io/atomic-write.js";
import {
  JsonFileError,
  readJsonFile,
  updateJsonFile,
  type JsonFileSystem,
  type JsonObject,
} from "../../src/io/json-file.js";

const SECRET = "synthetic-json-secret";
const MALFORMED = `{"token":"${SECRET}"`;

const deterministicRandom: RandomSource = {
  randomBytes(size: number): Uint8Array {
    return new Uint8Array(size).fill(0x4b);
  },
};

async function withDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "kuota-json-synthetic-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertSafeError(error: unknown, forbidden: readonly string[]): void {
  assert.ok(error instanceof Error);
  for (const value of forbidden) {
    assert.equal(error.message.includes(value), false, `error leaked ${value}`);
  }
}

test("missing JSON files read as undefined without touching a live credential path", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "missing-synthetic.json");
    assert.equal(await readJsonFile(path, { fs: nodeFileSystem }), undefined);
  });
});

test("malformed JSON fails without exposing path or content", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "malformed-synthetic.json");
    await writeFile(path, MALFORMED, "utf8");

    await assert.rejects(
      readJsonFile(path, { fs: nodeFileSystem }),
      (error: unknown) => {
        assert.ok(error instanceof JsonFileError);
        assert.equal(error.kind, "malformed");
        assertSafeError(error, [path, MALFORMED, SECRET]);
        return true;
      },
    );
  });
});

test("invalid UTF-8 fails as a constant malformed error and update preserves bytes exactly", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "invalid-utf8-synthetic.json");
    const invalidUtf8 = Uint8Array.from([
      0x7b, 0x22, 0x76, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
    ]);
    await writeFile(path, invalidUtf8);

    await assert.rejects(
      updateJsonFile(
        path,
        () => ({ replaced: true }),
        { fs: nodeFileSystem, random: deterministicRandom, policy: "preserve-existing" },
      ),
      (error: unknown) => {
        assert.ok(error instanceof JsonFileError);
        assert.equal(error.kind, "malformed");
        assert.equal(error.message, "JSON file operation failed: malformed");
        return true;
      },
    );
    assert.deepEqual(await readFile(path), Buffer.from(invalidUtf8));
  });
});

test("JSON reads return parsed values from regular files", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "value-synthetic.json");
    await writeFile(path, JSON.stringify({ nested: { count: 2 }, list: [true, null] }), "utf8");

    assert.deepEqual(await readJsonFile(path, { fs: nodeFileSystem }), {
      nested: { count: 2 },
      list: [true, null],
    });
  });
});

test("latest-read updates preserve unrelated entries and use the current document", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "auth-shaped-synthetic.json");
    await writeFile(
      path,
      JSON.stringify({ unrelated: { keep: true }, codex: { access: "synthetic-old" } }),
      "utf8",
    );
    const observed: JsonObject[] = [];

    await updateJsonFile(
      path,
      (latest) => {
        observed.push(latest);
        return {
          ...latest,
          codex: { access: "synthetic-new" },
        };
      },
      { fs: nodeFileSystem, random: deterministicRandom, policy: "preserve-existing" },
    );

    assert.deepEqual(observed, [
      { unrelated: { keep: true }, codex: { access: "synthetic-old" } },
    ]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      unrelated: { keep: true },
      codex: { access: "synthetic-new" },
    });
  });
});

test("latest-read updates start from an empty object when the file is missing", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "new-auth-shaped-synthetic.json");
    let observed: JsonObject | undefined;

    await updateJsonFile(
      path,
      (latest) => {
        observed = latest;
        return { ...latest, created: "synthetic" };
      },
      { fs: nodeFileSystem, random: deterministicRandom, policy: "preserve-existing" },
    );

    assert.deepEqual(observed, {});
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { created: "synthetic" });
  });
});

test("malformed JSON is never replaced by an updater", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "bad-auth-shaped-synthetic.json");
    await writeFile(path, MALFORMED, "utf8");

    await assert.rejects(
      updateJsonFile(
        path,
        (latest) => ({ ...latest, replaced: true }),
        { fs: nodeFileSystem, random: deterministicRandom, policy: "preserve-existing" },
      ),
      (error: unknown) => {
        assert.ok(error instanceof JsonFileError);
        assert.equal(error.kind, "malformed");
        assertSafeError(error, [path, MALFORMED, SECRET]);
        return true;
      },
    );
    assert.equal(await readFile(path, "utf8"), MALFORMED);
  });
});

test("JSON reads refuse symlink destinations and do not read through them", async () => {
  await withDirectory(async (directory) => {
    const target = join(directory, "target-synthetic.json");
    const link = join(directory, "link-synthetic.json");
    await writeFile(target, JSON.stringify({ safe: true }), "utf8");
    await symlink(target, link);

    await assert.rejects(
      readJsonFile(link, { fs: nodeFileSystem }),
      (error: unknown) => {
        assert.ok(error instanceof JsonFileError);
        assert.equal(error.kind, "unsafe-file");
        assertSafeError(error, [link, target]);
        return true;
      },
    );
  });
});

test("real symlink swap fails no-follow before target content is read", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "swap-synthetic.json");
    const target = join(directory, "swap-target-synthetic.json");
    const original = join(directory, "swap-original-synthetic.json");
    await writeFile(path, JSON.stringify({ safe: true }), "utf8");
    await writeFile(target, JSON.stringify({ target: SECRET }), "utf8");
    const fs: JsonFileSystem = {
      ...nodeFileSystem,
      async openRead(filePath) {
        await rename(filePath, original);
        await symlink(target, filePath);
        return nodeFileSystem.openRead(filePath);
      },
    };

    await assert.rejects(
      readJsonFile(path, { fs }),
      (error: unknown) => {
        assert.ok(error instanceof JsonFileError);
        assert.equal(error.kind, "unsafe-file");
        assertSafeError(error, [path, target, SECRET]);
        return true;
      },
    );
  });
});

test("read filesystem failures stay value-free", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "read-failure-synthetic.json");
    const failingFs: JsonFileSystem = {
      ...nodeFileSystem,
      async openRead(filePath) {
        const handle = await nodeFileSystem.openRead(filePath);
        return {
          fstat: () => handle.fstat(),
          read() {
            throw new Error(`read failed for ${filePath} with ${SECRET}`);
          },
          close: () => handle.close(),
        };
      },
    };
    await writeFile(path, JSON.stringify({ safe: true }), "utf8");

    await assert.rejects(
      readJsonFile(path, { fs: failingFs }),
      (error: unknown) => {
        assert.ok(error instanceof JsonFileError);
        assert.equal(error.kind, "read");
        assertSafeError(error, [path, SECRET]);
        return true;
      },
    );
  });
});

test("opens and reads through one injected handle, then closes it", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "handle-synthetic.json");
    const source = JSON.stringify({ handle: true });
    await writeFile(path, source, "utf8");
    const metadata = await nodeFileSystem.lstat(path);
    const bytes = new TextEncoder().encode(source);
    let offset = 0;
    let fstatCalls = 0;
    let readCalls = 0;
    let closeCalls = 0;
    const fs: JsonFileSystem = {
      ...nodeFileSystem,
      async openRead() {
        return {
          async fstat() {
            fstatCalls += 1;
            return metadata;
          },
          async read(buffer, bufferOffset, length) {
            readCalls += 1;
            const count = Math.min(length, bytes.byteLength - offset);
            if (count === 0) {
              return { bytesRead: 0 };
            }
            buffer.set(bytes.subarray(offset, offset + count), bufferOffset);
            offset += count;
            return { bytesRead: count };
          },
          async close() {
            closeCalls += 1;
          },
        };
      },
      async readFile() {
        throw new Error("path read seam must not be used");
      },
    };

    assert.deepEqual(await readJsonFile(path, { fs }), { handle: true });
    assert.equal(fstatCalls, 1);
    assert.ok(readCalls >= 2);
    assert.equal(closeCalls, 1);
  });
});

test("value-unsafe updater results fail before destination mutation", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "unsafe-value-synthetic.json");
    await writeFile(path, JSON.stringify({ original: true }), "utf8");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const getter: Record<string, unknown> = {};
    Object.defineProperty(getter, "hidden", {
      enumerable: true,
      get() {
        throw new Error("getter value");
      },
    });
    const symbolValue: Record<string, unknown> = {};
    Object.defineProperty(symbolValue, Symbol("secret"), { enumerable: true, value: "secret" });
    class CustomValue {
      readonly value = true;
    }
    const candidates: unknown[] = [
      new Date(),
      new Map<string, string>(),
      new CustomValue(),
      getter,
      symbolValue,
      cycle,
    ];

    for (const candidate of candidates) {
      await assert.rejects(
        updateJsonFile(path, () => candidate as JsonObject, { fs: nodeFileSystem, random: deterministicRandom }),
        (error: unknown) => {
          assert.ok(error instanceof JsonFileError);
          assert.equal(error.kind, "update");
          assertSafeError(error, [path, "getter value", "secret"]);
          return true;
        },
      );
      assert.equal(await readFile(path, "utf8"), JSON.stringify({ original: true }));
    }
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith(".")), []);
  });
});

test("latest-read update rejects an identity mismatch without overwriting", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "identity-update-synthetic.json");
    await writeFile(path, JSON.stringify({ original: true }), "utf8");
    let destinationLstatCalls = 0;
    const fs: JsonFileSystem = {
      ...nodeFileSystem,
      async lstat(filePath) {
        if (filePath === path) {
          destinationLstatCalls += 1;
        }
        const metadata = await nodeFileSystem.lstat(filePath);
        if (filePath !== path || destinationLstatCalls !== 2 || metadata.ino === undefined) {
          return metadata;
        }
        return {
          ...metadata,
          ino: typeof metadata.ino === "bigint" ? metadata.ino + 1n : Number(metadata.ino) + 1,
        };
      },
    };

    await assert.rejects(
      updateJsonFile(path, (latest) => ({ ...latest, changed: true }), {
        fs,
        random: deterministicRandom,
        policy: "preserve-existing",
      }),
      (error: unknown) => error instanceof AtomicWriteError && error.stage === "conflict",
    );
    assert.equal(await readFile(path, "utf8"), JSON.stringify({ original: true }));
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith(".")), []);
  });
});

test("real latest-read CAS preserves an external replacement and cleans this writer's temp", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "real-cas-synthetic.json");
    const externalPath = join(directory, "external-replacement-synthetic.json");
    const original = Buffer.from('{"original":true}\n', "utf8");
    const external = Buffer.from('{"external":true}\n', "utf8");
    await writeFile(path, original);

    let destinationChecks = 0;
    let replaced = false;
    const fs: JsonFileSystem = {
      ...nodeFileSystem,
      async lstat(filePath) {
        if (filePath === path) {
          destinationChecks += 1;
          if (destinationChecks === 2) {
            await writeFile(externalPath, external);
            await rename(externalPath, path);
            replaced = true;
          }
        }
        return nodeFileSystem.lstat(filePath);
      },
    };

    await assert.rejects(
      updateJsonFile(path, (latest) => ({ ...latest, changed: true }), {
        fs,
        random: deterministicRandom,
        policy: "preserve-existing",
      }),
      (error: unknown) => error instanceof AtomicWriteError && error.stage === "conflict",
    );
    assert.equal(replaced, true);
    assert.deepEqual(await readFile(path), external);
    assert.equal((await readdir(directory)).includes("external-replacement-synthetic.json"), false);
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith(".")), []);
  });
});