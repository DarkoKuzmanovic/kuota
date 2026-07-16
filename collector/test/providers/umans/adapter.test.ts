import assert from "node:assert/strict";
import test from "node:test";

import { createUmansAdapter } from "../../../src/providers/umans/adapter.js";
import type { ProviderAdapterContext } from "../../../src/providers/types.js";

function context(): ProviderAdapterContext { return { signal: new AbortController().signal, dependencies: {} }; }

test("composes exactly one auth read and one fetch into a schema-valid Umans record", async () => {
  let authCalls = 0;
  let fetchCalls = 0;
  const adapter = createUmansAdapter({
    resolveAuthPath: () => "/synthetic/auth.json",
    readAuth: async () => { authCalls += 1; return { state: "available", credential: { kind: "oauth", value: "synthetic-umans-access-not-real" } }; },
    fetchUsage: async () => { fetchCalls += 1; return { outcome: "ok", value: { usage: { requests_in_window: 4 } } }; },
    parseUsage: (_payload, observedAt) => ({ ok: true, record: { id: "umans", state: "ok", lastSuccessAt: observedAt, windows: [{ id: "requests", label: "Requests", used: 4 }] } }),
    now: () => 1_700_000_000_000,
  });
  const result = await adapter.collect(context());
  assert.equal(result.id, "umans");
  assert.equal(result.state, "ok");
  assert.equal(authCalls, 1);
  assert.equal(fetchCalls, 1);
});

test("maps unavailable credentials and transport/parse failures to safe records without fetching after auth failure", async () => {
  let fetchCalls = 0;
  const authNeeded = createUmansAdapter({ readAuth: async () => ({ state: "auth-needed", reason: "missing-entry" }), fetchUsage: async () => { fetchCalls += 1; return { outcome: "auth-needed" }; } });
  const failed = await authNeeded.collect(context());
  assert.deepEqual(failed, { id: "umans", state: "auth-needed", status: "Authentication required" });
  assert.equal(fetchCalls, 0);
});
