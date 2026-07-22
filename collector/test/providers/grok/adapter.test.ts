import assert from "node:assert/strict";
import test from "node:test";

import { createGrokAdapter } from "../../../src/providers/grok/adapter.js";
import type { ProviderAdapterContext } from "../../../src/providers/types.js";

function context(): ProviderAdapterContext { return { signal: new AbortController().signal, dependencies: {} }; }

test("composes exactly one auth read and one fetch into a schema-valid Grok record", async () => {
  let authCalls = 0;
  let fetchCalls = 0;
  const adapter = createGrokAdapter({
    resolveAuthPath: () => "/synthetic/auth.json",
    readAuth: async () => { authCalls += 1; return { state: "available", credential: { kind: "oauth", value: "synthetic-grok-access-not-real" } }; },
    fetchUsage: async () => { fetchCalls += 1; return { outcome: "ok", value: { monthly: { config: {} } } }; },
    parseUsage: (_payload, observedAt) => ({ ok: true, record: { id: "grok", state: "ok", lastSuccessAt: observedAt, windows: [{ id: "month", label: "Month", used: 250, limit: 1000 }] } }),
    now: () => 1_700_000_000_000,
  });
  const result = await adapter.collect(context());
  assert.equal(result.id, "grok");
  assert.equal(result.state, "ok");
  assert.equal(authCalls, 1);
  assert.equal(fetchCalls, 1);
});

test("maps unavailable credentials and transport/parse failures to safe records without fetching after auth failure", async () => {
  let fetchCalls = 0;
  const authNeeded = createGrokAdapter({ readAuth: async () => ({ state: "auth-needed", reason: "missing-entry" }), fetchUsage: async () => { fetchCalls += 1; return { outcome: "auth-needed" }; } });
  const failed = await authNeeded.collect(context());
  assert.deepEqual(failed, { id: "grok", state: "auth-needed", status: "Authentication required" });
  assert.equal(fetchCalls, 0);
});
