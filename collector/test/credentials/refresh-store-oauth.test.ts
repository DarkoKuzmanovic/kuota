import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GROK_OAUTH } from "../../src/credentials/oauth-clients.js";
import { refreshStoreOAuthIfExpired } from "../../src/credentials/refresh-store-oauth.js";
import { writeCredentialEntry } from "../../src/credentials/store.js";

// Spec: docs/specs/2026-10-02-standalone-credentials-design.md (Refresh row).
const NOW = 1_700_000_000_000;
const ACCESS = "synthetic-grok-access-old";
const REFRESH = "synthetic-grok-refresh-old";
const NEW_ACCESS = "synthetic-grok-access-new";
const signal = new AbortController().signal;

test("an unexpired or non-refreshable credential is used as-is without any refresh call", async () => {
  let calls = 0;
  const refresh = async () => { calls += 1; return { outcome: "error" as const }; };
  for (const credential of [
    { value: ACCESS, refresh: REFRESH, expires: NOW + 1 },
    { value: ACCESS },
    { value: ACCESS, expires: NOW - 1 },
  ]) {
    const result = await refreshStoreOAuthIfExpired({
      id: "grok", client: GROK_OAUTH, storePath: "/unused", credential, now: () => NOW, signal, refresh,
    });
    assert.deepEqual(result, { state: "ok", access: ACCESS });
  }
  assert.equal(calls, 0);
});

test("an expired store credential refreshes once against its own client and persists into its own entry", async () => {
  const home = await mkdtemp(join(tmpdir(), "kuota-refresh-synthetic-"));
  try {
    await mkdir(join(home, "config"), { mode: 0o700 });
    const storePath = join(home, "config", "kuota", "credentials.json");
    await writeCredentialEntry(storePath, "grok", { type: "oauth", access: ACCESS, refresh: REFRESH, expires: NOW - 1 });
    await writeCredentialEntry(storePath, "opencode", { type: "api_key", key: "synthetic-untouched" });

    const seen: unknown[] = [];
    const result = await refreshStoreOAuthIfExpired({
      id: "grok",
      client: GROK_OAUTH,
      storePath,
      credential: { value: ACCESS, refresh: REFRESH, expires: NOW - 1 },
      now: () => NOW,
      signal,
      refresh: async (options) => {
        seen.push({ token: options.refreshToken, endpoint: options.client?.tokenEndpoint, clientId: options.client?.clientId });
        return { outcome: "ok", credential: { access: NEW_ACCESS, expires: NOW + 3_600_000 } };
      },
    });

    assert.deepEqual(result, { state: "ok", access: NEW_ACCESS });
    assert.deepEqual(seen, [{ token: REFRESH, endpoint: GROK_OAUTH.tokenEndpoint, clientId: GROK_OAUTH.clientId }]);
    assert.deepEqual(JSON.parse(await readFile(storePath, "utf8")), {
      grok: { type: "oauth", access: NEW_ACCESS, refresh: REFRESH, expires: NOW + 3_600_000 },
      opencode: { type: "api_key", key: "synthetic-untouched" },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a rejected refresh is auth-needed; a transport failure or lost persist race is an error", async () => {
  const base = {
    id: "kimi" as const,
    client: GROK_OAUTH,
    storePath: "/synthetic/credentials.json",
    credential: { value: ACCESS, refresh: REFRESH, expires: NOW - 1 },
    now: () => NOW,
    signal,
  };
  assert.deepEqual(
    await refreshStoreOAuthIfExpired({ ...base, refresh: async () => ({ outcome: "auth-needed" }) }),
    { state: "auth-needed" },
  );
  assert.deepEqual(
    await refreshStoreOAuthIfExpired({ ...base, refresh: async () => ({ outcome: "error" }) }),
    { state: "error" },
  );
  assert.deepEqual(
    await refreshStoreOAuthIfExpired({
      ...base,
      refresh: async () => ({ outcome: "ok", credential: { access: NEW_ACCESS } }),
      persist: async () => "conflict",
    }),
    { state: "error" },
  );
  const thrown = await refreshStoreOAuthIfExpired({
    ...base,
    refresh: async () => { throw new Error(REFRESH); },
  });
  assert.deepEqual(thrown, { state: "error" });
});
