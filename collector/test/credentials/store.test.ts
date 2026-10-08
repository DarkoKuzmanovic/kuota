import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readCredentialStore,
  removeCredentialEntry,
  resolveKuotaCredentialsPath,
  writeCredentialEntry,
} from "../../src/credentials/store.js";

// Spec: docs/specs/2026-10-02-standalone-credentials-design.md (credential store).
const SECRET = "synthetic-store-secret";

async function withHome<T>(callback: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "kuota-store-synthetic-"));
  try {
    await mkdir(join(home, ".config"), { mode: 0o700 });
    return await callback(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("store path honors absolute XDG_CONFIG_HOME and ignores relative or empty values", () => {
  assert.equal(resolveKuotaCredentialsPath("/h", {}), "/h/.config/kuota/credentials.json");
  assert.equal(resolveKuotaCredentialsPath("/h", { XDG_CONFIG_HOME: "/x" }), "/x/kuota/credentials.json");
  assert.equal(resolveKuotaCredentialsPath("/h", { XDG_CONFIG_HOME: "rel" }), "/h/.config/kuota/credentials.json");
  assert.equal(resolveKuotaCredentialsPath("/h", { XDG_CONFIG_HOME: "" }), "/h/.config/kuota/credentials.json");
});

test("first write creates a 0700 directory and a 0600 file; later writes keep other providers", async () => {
  await withHome(async (home) => {
    const path = resolveKuotaCredentialsPath(home, {});
    await writeCredentialEntry(path, "opencode", { type: "api_key", key: SECRET });
    await writeCredentialEntry(path, "codex", { type: "oauth", access: "a", refresh: "r", expires: 1, accountId: "acct" });

    assert.equal((await stat(join(home, ".config", "kuota"))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      opencode: { type: "api_key", key: SECRET },
      codex: { type: "oauth", access: "a", refresh: "r", expires: 1, accountId: "acct" },
    });
    assert.deepEqual(await readCredentialStore(path), {
      opencode: { type: "api_key", key: SECRET },
      codex: { type: "oauth", access: "a", refresh: "r", expires: 1, accountId: "acct" },
    });
  });
});

test("a loosened file mode is reset to 0600 on the next write", async () => {
  await withHome(async (home) => {
    const path = resolveKuotaCredentialsPath(home, {});
    await writeCredentialEntry(path, "opencode", { type: "api_key", key: SECRET });
    await import("node:fs/promises").then((fs) => fs.chmod(path, 0o644));
    await writeCredentialEntry(path, "commandcode", { type: "api_key", key: SECRET });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test("remove deletes only the named provider and is a no-op when absent", async () => {
  await withHome(async (home) => {
    const path = resolveKuotaCredentialsPath(home, {});
    await removeCredentialEntry(path, "codex");
    await writeCredentialEntry(path, "opencode", { type: "api_key", key: SECRET });
    await writeCredentialEntry(path, "codex", { type: "api_key", key: SECRET });
    await removeCredentialEntry(path, "codex");
    assert.deepEqual(await readCredentialStore(path), { opencode: { type: "api_key", key: SECRET } });
  });
});

test("a symlinked kuota directory is refused without writing through it", async () => {
  await withHome(async (home) => {
    const elsewhere = join(home, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    await symlink(elsewhere, join(home, ".config", "kuota"));
    const path = resolveKuotaCredentialsPath(home, {});
    await assert.rejects(writeCredentialEntry(path, "opencode", { type: "api_key", key: SECRET }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(SECRET), false);
      return true;
    });
    await assert.rejects(readFile(join(elsewhere, "credentials.json")));
  });
});

test("a malformed store is never replaced", async () => {
  await withHome(async (home) => {
    const path = resolveKuotaCredentialsPath(home, {});
    await mkdir(join(home, ".config", "kuota"), { mode: 0o700 });
    await writeFile(path, `{"codex":"${SECRET}"`, { mode: 0o600 });
    await assert.rejects(writeCredentialEntry(path, "opencode", { type: "api_key", key: "x" }));
    assert.equal(await readFile(path, "utf8"), `{"codex":"${SECRET}"`);
  });
});

test("a missing store reads as undefined", async () => {
  await withHome(async (home) => {
    assert.equal(await readCredentialStore(resolveKuotaCredentialsPath(home, {})), undefined);
  });
});
