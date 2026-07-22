import assert from "node:assert/strict";
import test from "node:test";

import { validateProviderRecord } from "../../../src/contract/validate.js";
import { parseKimiUsageResponse } from "../../../src/providers/kimi/usage.js";

const OBSERVED_AT = "2026-07-13T20:00:00.000Z";

function parse(input: unknown) {
  return parseKimiUsageResponse(input, OBSERVED_AT);
}

test("normalizes genuine weekly, short, and concurrency facts", () => {
  const result = parse({
    usage: { limit: "100", used: "25", remaining: "75", resetTime: "2026-07-20T20:00:00.000Z" },
    limits: [{
      window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "50", used: "10", resetTime: "2026-07-13T20:05:00.000Z" },
    }],
    parallel: { limit: "4", details: [{}, {}, {}] },
    future: { ignored: true },
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected normalized Kimi result");
  assert.deepEqual(result.record, {
    id: "kimi",
    state: "ok",
    lastSuccessAt: OBSERVED_AT,
    windows: [
      { id: "week", label: "Week", used: 25, limit: 100, usedPercent: 25, resetAt: "2026-07-20T20:00:00.000Z" },
      { id: "5h", label: "5h", used: 10, limit: 50, usedPercent: 20, resetAt: "2026-07-13T20:05:00.000Z" },
    ],
    details: { kimi: { concurrency: 3, concurrencyLimit: 4 } },
  });
  assert.equal(validateProviderRecord(result.record).ok, true);
});

test("omits concurrency when parallel details are absent but keeps the limit", () => {
  const result = parse({
    usage: { limit: "100", used: "25", resetTime: "2026-07-20T20:00:00.000Z" },
    parallel: { limit: "4" },
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected normalized Kimi result");
  // Absent details means unknown concurrency — never an inferred zero (G11 nit).
  assert.deepEqual(result.record.details, { kimi: { concurrencyLimit: 4 } });
  assert.equal(validateProviderRecord(result.record).ok, true);
});

test("records an observed zero concurrency when details is an empty array", () => {
  const result = parse({
    usage: { limit: "100", used: "25", resetTime: "2026-07-20T20:00:00.000Z" },
    parallel: { limit: "4", details: [] },
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected normalized Kimi result");
  assert.deepEqual(result.record.details, { kimi: { concurrency: 0, concurrencyLimit: 4 } });
  assert.equal(validateProviderRecord(result.record).ok, true);
});

test("derives used from remaining when used is absent", () => {
  const result = parse({
    usage: { limit: "100", remaining: "80" },
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected normalized Kimi result");
  assert.equal(result.record.windows?.[0]?.used, 20);
  assert.equal(result.record.windows?.[0]?.limit, 100);
  assert.equal(result.record.windows?.[0]?.usedPercent, 20);
});

test("labels short windows by duration", () => {
  const daily = parse({ usage: { used: "1" }, limits: [{ window: { duration: "1", timeUnit: "TIME_UNIT_DAY" }, detail: { used: "2" } }] });
  const weekly = parse({ usage: { used: "1" }, limits: [{ window: { duration: "7", timeUnit: "TIME_UNIT_DAY" }, detail: { used: "2" } }] });
  const hourly = parse({ usage: { used: "1" }, limits: [{ window: { duration: "1", timeUnit: "TIME_UNIT_HOUR" }, detail: { used: "2" } }] });
  assert.equal(daily.ok, true);
  assert.equal(weekly.ok, true);
  assert.equal(hourly.ok, true);
  if (daily.ok && weekly.ok && hourly.ok) {
    assert.equal(daily.record.windows?.[1]?.id, "daily");
    assert.equal(weekly.record.windows?.[1]?.id, "week");
    assert.equal(hourly.record.windows?.[1]?.id, "5h");
  }
});

test("omits invented percentages and limits for unlimited or partial data", () => {
  const result = parse({
    usage: { used: "12", resetTime: "2026-07-13T21:00:00.000Z" },
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected normalized Kimi result");
  assert.deepEqual(result.record, {
    id: "kimi",
    state: "ok",
    lastSuccessAt: OBSERVED_AT,
    windows: [{ id: "week", label: "Week", used: 12, resetAt: "2026-07-13T21:00:00.000Z" }],
  });
  assert.equal(validateProviderRecord(result.record).ok, true);
});

test("rejects malformed recognized fields and never copies hostile input", () => {
  const malformed = [
    { usage: { limit: "-1" } },
    { usage: { used: "bad" } },
    { usage: { limit: "100", used: "101" } },
    { usage: { used: "1" }, limits: [{ window: { duration: "bad" }, detail: { used: "1" } }] },
    { usage: { used: "1" }, parallel: { limit: "bad" } },
    { usage: { used: "1" }, limits: "not-array" },
    "not-an-object",
  ];
  for (const input of malformed) assert.deepEqual(parse(input), { ok: false, reason: "malformed-response", status: "Provider unavailable" });
});
