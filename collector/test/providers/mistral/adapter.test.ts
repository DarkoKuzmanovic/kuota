import assert from "node:assert/strict";
import test from "node:test";

import { createMistralAdapter, MISTRAL_BUDGET_ENDPOINT } from "../../../src/providers/mistral/adapter.js";
import { parseMistralUsageResponse } from "../../../src/providers/mistral/usage.js";
import type { SessionFetchOptions, SessionFetchResult } from "../../../src/providers/session-fetch.js";

// Real wire shape of GET admin.mistral.ai/api/billing/v2/budget (2026-11-06 recon; synthetic values).
const WIRE = {
  vibe_budget: { usage_percentage: 0.2441, initial_budget: 300.0, currency: "USD", reset_at: "2026-12-01T00:00:00Z", payg_enabled: false },
  api_budget: { usage_percentage: 0.0, initial_budget: 30.0, currency: "USD", reset_at: "2026-12-01T00:00:00Z", payg_enabled: false },
  usage_percentage: 0.0, initial_budget: 30.0, currency: "USD", reset_at: "2026-12-01T00:00:00Z",
};
const NOW = Date.parse("2026-11-06T10:00:00.000Z");
const context = { signal: new AbortController().signal, dependencies: {} };

function adapter(fetched: SessionFetchResult, seen: SessionFetchOptions[] = []) {
  return createMistralAdapter({
    now: () => NOW,
    readCookie: async () => ({ state: "available", cookie: "ory_session_synthetic=not-real" }),
    fetchJson: async (options) => { seen.push(options); return fetched; },
  });
}

test("bridge: the real budget wire shape becomes Vibe Code (primary) + API windows with budget facts", async () => {
  const seen: SessionFetchOptions[] = [];
  const record = await adapter({ outcome: "ok", value: WIRE }, seen).collect(context);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, MISTRAL_BUDGET_ENDPOINT);
  assert.equal(seen[0]?.headers.Cookie, "ory_session_synthetic=not-real");
  assert.deepEqual({ ...record }, {
    id: "mistral",
    state: "ok",
    lastSuccessAt: "2026-11-06T10:00:00.000Z",
    windows: [
      { id: "vibe", label: "Vibe Code", usedPercent: 0.2441, resetAt: "2026-12-01T00:00:00.000Z" },
      { id: "api", label: "API", usedPercent: 0, resetAt: "2026-12-01T00:00:00.000Z" },
    ],
    details: { mistral: { vibeBudget: 300, apiBudget: 30, currency: "USD", paygEnabled: false } },
  });
  assert.equal(JSON.stringify(record).includes("not-real"), false, "cookie never reaches the record");
});

test("an account with only the API budget falls back to it; nothing recognized is malformed", () => {
  const apiOnly = parseMistralUsageResponse({ api_budget: WIRE.api_budget }, "2026-11-06T10:00:00.000Z");
  assert.ok(apiOnly.ok);
  if (apiOnly.ok) assert.deepEqual(apiOnly.record.windows?.map((w) => w.id), ["api"]);
  assert.equal(parseMistralUsageResponse({ usage_percentage: 1 }, "2026-11-06T10:00:00.000Z").ok, false);
  assert.equal(parseMistralUsageResponse({ vibe_budget: { usage_percentage: "1", initial_budget: 300 } }, "2026-11-06T10:00:00.000Z").ok, false);
  assert.equal(parseMistralUsageResponse({ vibe_budget: { usage_percentage: 101, initial_budget: 300 } }, "2026-11-06T10:00:00.000Z").ok, false);
  assert.equal(parseMistralUsageResponse([], "2026-11-06T10:00:00.000Z").ok, false);
});

test("auth-needed and failures map to safe states", async () => {
  assert.equal((await adapter({ outcome: "auth-needed" }).collect(context)).state, "auth-needed");
  assert.equal((await adapter({ outcome: "error", reason: "timeout" }).collect(context)).state, "error");
  assert.equal((await adapter({ outcome: "ok", value: { nope: true } }).collect(context)).state, "error");
  const noCookie = createMistralAdapter({ readCookie: async () => ({ state: "auth-needed" }), fetchJson: async () => { throw new Error("must not fetch"); } });
  assert.equal((await noCookie.collect(context)).state, "auth-needed");
  const noSqlite = createMistralAdapter({ readCookie: async () => ({ state: "error", reason: "sqlite-unavailable" }) });
  assert.equal((await noSqlite.collect(context)).state, "error");
});
