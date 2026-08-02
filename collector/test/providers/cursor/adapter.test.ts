import assert from "node:assert/strict";
import test from "node:test";

import { createCursorAdapter } from "../../../src/providers/cursor/adapter.js";
import type { ProviderAdapterContext } from "../../../src/providers/types.js";

function context(): ProviderAdapterContext { return { signal: new AbortController().signal, dependencies: {} }; }

test("cursor adapter returns auth-needed without credentials", async () => {
  const adapter = createCursorAdapter({
    readAuth: async () => ({ state: "auth-needed", reason: "missing-env" }),
  });
  const result = await adapter.collect(context());
  assert.equal(result.state, "auth-needed");
});

test("composes exactly one auth read and one fetch into a schema-valid Cursor record", async () => {
  let authCalls = 0;
  let fetchCalls = 0;
  const adapter = createCursorAdapter({
    readAuth: async () => {
      authCalls += 1;
      return { state: "available", credential: { kind: "session", value: "synthetic-cursor-session-not-real" } };
    },
    fetchUsage: async () => {
      fetchCalls += 1;
      return {
        outcome: "ok",
        value: {
          billingCycleEnd: "2026-09-01T00:00:00.000Z",
          membershipType: "pro",
          individualUsage: { plan: { used: 10, limit: 100, totalPercentUsed: 4.2 } },
        },
      };
    },
    now: () => 1_700_000_000_000,
  });
  const result = await adapter.collect(context());
  assert.equal(result.id, "cursor");
  assert.equal(result.state, "ok");
  assert.equal(authCalls, 1);
  assert.equal(fetchCalls, 1);
});

test("maps unavailable credentials and transport failures to safe records without fetching after auth failure", async () => {
  let fetchCalls = 0;
  const authNeeded = createCursorAdapter({
    readAuth: async () => ({ state: "auth-needed", reason: "missing-local" }),
    fetchUsage: async () => { fetchCalls += 1; return { outcome: "auth-needed" }; },
  });
  const failed = await authNeeded.collect(context());
  assert.deepEqual(failed, { id: "cursor", state: "auth-needed", status: "Authentication required" });
  assert.equal(fetchCalls, 0);
});
