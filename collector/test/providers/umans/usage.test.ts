import assert from "node:assert/strict";
import test from "node:test";

import { validateProviderRecord } from "../../../src/contract/validate.js";
import { parseUmansUsageResponse } from "../../../src/providers/umans/usage.js";

const OBSERVED_AT = "2026-07-13T20:00:00.000Z";

function parse(input: unknown) {
  return parseUmansUsageResponse(input, OBSERVED_AT);
}

test("normalizes genuine limited Umans request and concurrency facts", () => {
  const result = parse({
    limits: { requests: { limit: 100, window_seconds: 3600 }, concurrency: { limit: 3 } },
    window: { resets_at: 1_760_000_000, remaining_minutes: 30 },
    usage: { requests_in_window: 25, concurrent_sessions: 2 },
    future: { ignored: true },
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected normalized Umans result");
  assert.deepEqual(result.record, {
    id: "umans",
    state: "ok",
    lastSuccessAt: OBSERVED_AT,
    windows: [{ id: "requests", label: "Requests", used: 25, limit: 100, usedPercent: 25, resetAt: "2025-10-09T08:53:20.000Z" }],
    details: { umans: { requests: 25, concurrency: 2, concurrencyLimit: 3 } },
  });
  assert.equal(validateProviderRecord(result.record).ok, true);
});

test("preserves unlimited request count and reset while omitting invented limit and percentage", () => {
  const result = parse({
    limits: { requests: { window_seconds: 3600 }, concurrency: {} },
    window: { remaining_minutes: 15 },
    usage: { requests_in_window: 12 },
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected unlimited Umans result");
  assert.deepEqual(result.record, {
    id: "umans",
    state: "ok",
    lastSuccessAt: OBSERVED_AT,
    windows: [{ id: "requests", label: "Requests", used: 12, resetAt: "2026-07-13T20:15:00.000Z" }],
    details: { umans: { requests: 12 } },
  });
});

test("rejects malformed recognized fields and never copies hostile input", () => {
  const malformed = [
    { limits: { requests: { limit: -1 } }, usage: { requests_in_window: 1 } },
    { limits: { requests: { limit: 1 } }, usage: { requests_in_window: 2 } },
    { limits: { concurrency: { limit: "3" } }, usage: { concurrent_sessions: 1 } },
    { limits: { requests: { window_seconds: "3600" } }, usage: { requests_in_window: 1 } },
    { window: { resets_at: "bad" }, usage: { requests_in_window: 1 } },
    { usage: { requests_in_window: "1" } },
  ];
  for (const input of malformed) assert.deepEqual(parse(input), { ok: false, reason: "malformed-response", status: "Provider unavailable" });
});
