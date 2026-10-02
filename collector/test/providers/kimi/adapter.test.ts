import assert from "node:assert/strict";
import test from "node:test";

import { createKimiAdapter } from "../../../src/providers/kimi/adapter.js";
import type { ProviderAdapterContext } from "../../../src/providers/types.js";

function context(): ProviderAdapterContext { return { signal: new AbortController().signal, dependencies: {} }; }

test("composes exactly one auth read and one fetch into a schema-valid Kimi record", async () => {
  let authCalls = 0;
  let fetchCalls = 0;
  const adapter = createKimiAdapter({
    resolveAuthPath: () => "/synthetic/auth.json",
    readAuth: async () => { authCalls += 1; return { state: "available", credential: { kind: "oauth", value: "synthetic-kimi-access-not-real" } }; },
    fetchUsage: async () => { fetchCalls += 1; return { outcome: "ok", value: { usage: { used: "4" } } }; },
    parseUsage: (_payload, observedAt) => ({ ok: true, record: { id: "kimi", state: "ok", lastSuccessAt: observedAt, windows: [{ id: "week", label: "Week", used: 4 }] } }),
    now: () => 1_700_000_000_000,
  });
  const result = await adapter.collect(context());
  assert.equal(result.id, "kimi");
  assert.equal(result.state, "ok");
  assert.equal(authCalls, 1);
  assert.equal(fetchCalls, 1);
});

test("maps unavailable credentials and transport/parse failures to safe records without fetching after auth failure", async () => {
  let fetchCalls = 0;
  const authNeeded = createKimiAdapter({ readAuth: async () => ({ state: "auth-needed", reason: "missing-entry" }), fetchUsage: async () => { fetchCalls += 1; return { outcome: "auth-needed" }; } });
  const failed = await authNeeded.collect(context());
  assert.deepEqual(failed, { id: "kimi", state: "auth-needed", status: "Authentication required" });
  assert.equal(fetchCalls, 0);
});

// Spec 2026-10-02-standalone-credentials-design.md: Kuota-store logins refresh on expiry.
test("refreshes an expired store login before fetching and maps refresh outcomes", async () => {
  const fetched: string[] = [];
  const seen: unknown[] = [];
  const make = (outcome: { readonly state: "ok"; readonly access: string } | { readonly state: "auth-needed" } | { readonly state: "error" }) => createKimiAdapter({
    resolveAuthPath: () => "/synthetic/credentials.json",
    readAuth: async () => ({ state: "available", credential: { kind: "oauth", value: "synthetic-old", refresh: "synthetic-r", expires: 1 } }),
    refreshIfExpired: async (options) => {
      seen.push({ id: options.id, storePath: options.storePath, value: options.credential.value, refresh: options.credential.refresh });
      return outcome;
    },
    fetchUsage: async (options) => { fetched.push(options.credential.value); return { outcome: "auth-needed" }; },
    now: () => 1_700_000_000_000,
  });

  await make({ state: "ok", access: "synthetic-new" }).collect(context());
  assert.deepEqual(fetched, ["synthetic-new"]);
  assert.deepEqual(seen, [{ id: "kimi", storePath: "/synthetic/credentials.json", value: "synthetic-old", refresh: "synthetic-r" }]);

  assert.equal((await make({ state: "auth-needed" }).collect(context())).state, "auth-needed");
  assert.equal((await make({ state: "error" }).collect(context())).state, "error");
  assert.deepEqual(fetched, ["synthetic-new"]);
});
