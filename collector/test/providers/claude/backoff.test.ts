import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  nodeFileSystem,
  type AtomicFileSystem,
} from "../../../src/io/atomic-write.js";
import { scanForSecrets } from "../../../src/security/redact.js";
import {
  CLAUDE_BACKOFF_CLEAR_RETRY_AT,
  CLAUDE_BACKOFF_SCHEMA_VERSION,
  clearClaudeBackoff,
  readClaudeBackoff,
  writeClaudeBackoff,
} from "../../../src/providers/claude/backoff.js";
import {
  type CacheDirectoryFileSystem,
} from "../../../src/providers/claude/cache.js";

const RETRY_AT = "2026-07-12T12:05:00.000Z";
const RETRY_AT_B = "2026-07-12T12:10:00.000Z";
const SECRET = "synthetic-backoff-secret-value";

async function withTempBackoff<T>(
  callback: (backoffPath: string, base: string) => Promise<T>,
): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "kuota-backoff-synthetic-"));
  try {
    const cacheParent = join(base, ".cache");
    await mkdir(cacheParent, { mode: 0o700 });
    await chmod(cacheParent, 0o700);
    return await callback(join(cacheParent, "kuota", "claude-backoff.json"), base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function assertSecretFree(value: unknown): void {
  assert.deepEqual(scanForSecrets(value), []);
  assert.equal(JSON.stringify(value).includes(SECRET), false);
}

test("accepts only a versioned secret-free retry timestamp and fails open for corrupt sidecars", async () => {
  const valid = await readClaudeBackoff({
    readJsonFile: async () => ({
      schemaVersion: CLAUDE_BACKOFF_SCHEMA_VERSION,
      retryAt: RETRY_AT,
    }),
  });
  assert.deepEqual(valid, { state: "available", retryAt: RETRY_AT });

  for (const document of [
    { schemaVersion: CLAUDE_BACKOFF_SCHEMA_VERSION, retryAt: "not-a-time" },
    { schemaVersion: 99, retryAt: RETRY_AT },
    {
      schemaVersion: CLAUDE_BACKOFF_SCHEMA_VERSION,
      retryAt: RETRY_AT,
      token: "synthetic-oauth-access-value-003-not-real",
    },
  ]) {
    const result = await readClaudeBackoff({ readJsonFile: async () => document });
    assert.equal(result.state, "error");
    assert.equal(
      JSON.stringify(result).includes("synthetic-oauth-access-value-003-not-real"),
      false,
    );
  }
});

test("contains hostile backoff documents without leaking their thrown value", async () => {
  const marker = "synthetic-oauth-access-value-004-not-real";
  const hostile = new Proxy({}, {
    ownKeys(): never {
      throw new Error(marker);
    },
  });

  const result = await readClaudeBackoff({ readJsonFile: async () => hostile });
  assert.deepEqual(result, { state: "error" });
  assert.equal(JSON.stringify(result).includes(marker), false);
});

test("rejects a noncanonical retry time before touching directory or atomic-write seams", async () => {
  let directoryCalls = 0;
  const untouchedDirectoryFs: CacheDirectoryFileSystem = {
    async lstat() {
      directoryCalls += 1;
      throw new Error(`directory seam touched ${SECRET}`);
    },
    async mkdir() {
      directoryCalls += 1;
      throw new Error(`directory seam touched ${SECRET}`);
    },
  };

  const result = await writeClaudeBackoff("2026-07-12T12:05:00Z", {
    backoffPath: "/synthetic/.cache/kuota/claude-backoff.json",
    directoryFs: untouchedDirectoryFs,
  });

  assert.deepEqual(result, { state: "error" });
  assert.equal(directoryCalls, 0);
  assertSecretFree(result);
});

test("writes an exact restrictive envelope, round-trips it, and clears through the epoch sentinel", async () => {
  await withTempBackoff(async (backoffPath) => {
    const written = await writeClaudeBackoff(RETRY_AT, { backoffPath });
    assert.deepEqual(written, { state: "written" });
    assert.equal((await stat(backoffPath)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(backoffPath))).mode & 0o077, 0);

    const persisted = JSON.parse(await readFile(backoffPath, "utf8"));
    assert.deepEqual(persisted, {
      schemaVersion: CLAUDE_BACKOFF_SCHEMA_VERSION,
      retryAt: RETRY_AT,
    });
    assertSecretFree(persisted);
    assert.deepEqual(await readClaudeBackoff({ backoffPath }), {
      state: "available",
      retryAt: RETRY_AT,
    });

    const cleared = await clearClaudeBackoff({ backoffPath });
    assert.deepEqual(cleared, { state: "cleared" });
    assert.deepEqual(await readClaudeBackoff({ backoffPath }), {
      state: "available",
      retryAt: CLAUDE_BACKOFF_CLEAR_RETRY_AT,
    });
  });
});

test("refuses an untrusted cache parent without writing a sidecar", async () => {
  await withTempBackoff(async (backoffPath) => {
    await chmod(dirname(dirname(backoffPath)), 0o777);
    const result = await writeClaudeBackoff(RETRY_AT, { backoffPath });

    assert.deepEqual(result, { state: "error" });
    await assert.rejects(stat(backoffPath));
    assertSecretFree(result);
  });
});

test("preserves the prior sidecar on a pre-commit failure and keeps failures value-free", async () => {
  await withTempBackoff(async (backoffPath) => {
    assert.deepEqual(await writeClaudeBackoff(RETRY_AT, { backoffPath }), {
      state: "written",
    });
    const failingRenameFs: AtomicFileSystem = {
      ...nodeFileSystem,
      async rename() {
        throw new Error(`rename failure ${SECRET}`);
      },
    };

    const result = await writeClaudeBackoff(RETRY_AT_B, {
      backoffPath,
      fs: failingRenameFs,
    });
    assert.deepEqual(result, { state: "error" });
    assert.deepEqual(await readClaudeBackoff({ backoffPath }), {
      state: "available",
      retryAt: RETRY_AT,
    });
    assertSecretFree(result);
  });
});

test("reports post-commit durability failure safely while the new sidecar remains readable", async () => {
  await withTempBackoff(async (backoffPath) => {
    assert.deepEqual(await writeClaudeBackoff(RETRY_AT, { backoffPath }), {
      state: "written",
    });
    const postCommitFailingFs: AtomicFileSystem = {
      ...nodeFileSystem,
      async openDirectory(path) {
        const handle = await nodeFileSystem.openDirectory(path);
        return {
          async sync() {
            await handle.close();
            throw new Error(`directory sync failure ${SECRET}`);
          },
          close: () => handle.close(),
        };
      },
    };

    const result = await writeClaudeBackoff(RETRY_AT_B, {
      backoffPath,
      fs: postCommitFailingFs,
    });
    assert.deepEqual(result, { state: "error" });
    assert.deepEqual(await readClaudeBackoff({ backoffPath }), {
      state: "available",
      retryAt: RETRY_AT_B,
    });
    assertSecretFree(result);
  });
});
