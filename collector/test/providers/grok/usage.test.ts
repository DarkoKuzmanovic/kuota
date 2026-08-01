import assert from "node:assert/strict";
import test from "node:test";

import { validateProviderRecord } from "../../../src/contract/validate.js";
import { fetchGrokUsage, type GrokUsageFetchSeam } from "../../../src/providers/grok/fetch.js";
import { parseGrokUsageResponse } from "../../../src/providers/grok/usage.js";

const OBSERVED_AT = "2026-07-22T20:00:00.000Z";

function parse(input: unknown) {
  return parseGrokUsageResponse(input, OBSERVED_AT);
}

// Real wire shapes (live-verified 2026-07-17; mirror collector/test/providers/grok/fetch.test.ts
// fixtures and pi-hud providers/grok.ts): monthly counters are {val}-wrapped under config;
// creditUsagePercent is a raw number gated on currentPeriod.type.
function monthlyPayload(overrides: Record<string, unknown> = {}) {
  return {
    monthly: {
      config: {
        monthlyLimit: { val: 1000 },
        used: { val: 250 },
        billingPeriodEnd: "2026-08-01T00:00:00.000Z",
        ...overrides,
      },
    },
  };
}

function weeklyPayload(overrides: Record<string, unknown> = {}) {
  return {
    weekly: {
      config: {
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
        creditUsagePercent: 45,
        billingPeriodEnd: "2026-07-29T00:00:00.000Z",
        ...overrides,
      },
    },
  };
}

test("normalizes monthly Grok credits and optional weekly window", () => {
  const result = parse({ ...monthlyPayload(), ...weeklyPayload() });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected normalized Grok result");

  assert.deepEqual(result.record, {
    id: "grok",
    state: "ok",
    lastSuccessAt: OBSERVED_AT,
    windows: [
      {
        id: "week",
        label: "7d",
        usedPercent: 45,
        resetAt: "2026-07-29T00:00:00.000Z",
      },
      {
        id: "month",
        label: "30d",
        used: 250,
        limit: 1000,
        usedPercent: 25,
        resetAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    details: {
      grok: {
        monthlyUsed: 250,
        monthlyLimit: 1000,
        monthlyResetAt: "2026-08-01T00:00:00.000Z",
      },
    },
  });
  assert.equal(validateProviderRecord(result.record).ok, true);
});

test("omits weekly window when unavailable", () => {
  const result = parse(monthlyPayload());

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected normalized Grok result");

  assert.deepEqual(result.record.windows, [
    {
      id: "month",
      label: "30d",
      used: 250,
      limit: 1000,
      usedPercent: 25,
      resetAt: "2026-08-01T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(result.record.details, {
    grok: {
      monthlyUsed: 250,
      monthlyLimit: 1000,
      monthlyResetAt: "2026-08-01T00:00:00.000Z",
    },
  });
  assert.equal(validateProviderRecord(result.record).ok, true);
});

test("omits weekly window when the period is not weekly or the credit config is absent", () => {
  const nonWeeklyPeriod = parse({
    ...monthlyPayload(),
    ...weeklyPayload({ currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" } }),
  });
  assert.equal(nonWeeklyPeriod.ok, true);
  if (!nonWeeklyPeriod.ok) throw new Error("expected normalized Grok result");
  assert.equal(nonWeeklyPeriod.record.windows?.length, 1);

  const noWeeklyConfig = parse({ ...monthlyPayload(), weekly: {} });
  assert.equal(noWeeklyConfig.ok, true);
  if (!noWeeklyConfig.ok) throw new Error("expected normalized Grok result");
  assert.equal(noWeeklyConfig.record.windows?.length, 1);
});

test("omits percentage when monthly limit is missing or zero", () => {
  const missingLimit = parse({
    monthly: {
      config: {
        used: { val: 250 },
        billingPeriodEnd: "2026-08-01T00:00:00.000Z",
      },
    },
  });

  assert.equal(missingLimit.ok, true);
  if (!missingLimit.ok) throw new Error("expected normalized Grok result");

  assert.deepEqual(missingLimit.record.windows, [
    {
      id: "month",
      label: "30d",
      used: 250,
      resetAt: "2026-08-01T00:00:00.000Z",
    },
  ]);
  const [missingLimitWindow] = missingLimit.record.windows ?? [];
  if (missingLimitWindow === undefined) throw new Error("expected at least one window");
  assert.equal("usedPercent" in missingLimitWindow, false);

  const zeroLimit = parse({
    monthly: {
      config: {
        monthlyLimit: { val: 0 },
        used: { val: 0 },
        billingPeriodEnd: "2026-08-01T00:00:00.000Z",
      },
    },
  });

  assert.equal(zeroLimit.ok, true);
  if (!zeroLimit.ok) throw new Error("expected normalized Grok result");
  const [zeroLimitWindow] = zeroLimit.record.windows ?? [];
  if (zeroLimitWindow === undefined) throw new Error("expected at least one window");
  assert.equal("usedPercent" in zeroLimitWindow, false);
});

test("rejects malformed recognized fields and never copies hostile input", () => {
  const malformed = [
    // Stringy val-wrapped limit.
    monthlyPayload({ monthlyLimit: { val: "1000" } }),
    // Negative val-wrapped used.
    monthlyPayload({ used: { val: -1 } }),
    // Unparseable reset timestamp.
    monthlyPayload({ billingPeriodEnd: "bad" }),
    // Limit not val-wrapped (bare number where the wire sends {val}).
    monthlyPayload({ monthlyLimit: 1000 }),
    // Weekly present but monthly missing entirely.
    weeklyPayload(),
    // Stringy weekly percent (weekly is applicable, so malformed fails).
    { ...monthlyPayload(), ...weeklyPayload({ creditUsagePercent: "45" }) },
    // Weekly percent out of range.
    { ...monthlyPayload(), ...weeklyPayload({ creditUsagePercent: 140 }) },
    // Monthly present but not a record.
    { monthly: "nope" },
    // Monthly without a config record (real API always nests under config).
    { monthly: { monthlyLimit: { val: 1000 } } },
    // Dataless monthly: config recognized nothing (would render present-but-empty).
    { monthly: { config: {} } },
  ];

  for (const input of malformed) {
    assert.deepEqual(parse(input), { ok: false, reason: "malformed-response", status: "Provider unavailable" });
  }
});

test("fetch output pipes through the parser to a fully populated record (integration)", async () => {
  // Bridges the fetch→usage boundary with the real wire shape on both ends so the
  // two layers cannot silently diverge on fixture shapes again (G11 B1).
  const body = (payload: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let read = false;
    return {
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => read ? { done: true } : (read = true, { done: false, value: bytes }),
          cancel: async () => {},
        }),
      },
    };
  };
  const fetch: GrokUsageFetchSeam = async (url) => {
    if (url.includes("format=credits")) {
      return body({
        config: {
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
          creditUsagePercent: 45,
          billingPeriodEnd: "2026-07-29T00:00:00.000Z",
        },
      });
    }
    return body({
      config: {
        monthlyLimit: { val: 1000 },
        used: { val: 250 },
        billingPeriodEnd: "2026-08-01T00:00:00.000Z",
      },
    });
  };

  const fetched = await fetchGrokUsage({
    credential: { kind: "oauth", value: "synthetic-grok-access-not-real" },
    signal: new AbortController().signal,
    fetch,
  });
  assert.equal(fetched.outcome, "ok");
  if (fetched.outcome !== "ok") throw new Error("expected fetch success");

  const parsed = parse(fetched.value);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("expected parse success on real-shaped fetch output");

  assert.equal(parsed.record.windows?.length, 2);
  assert.equal(parsed.record.windows?.[0]?.id, "week");
  assert.equal(parsed.record.windows?.[0]?.label, "7d");
  assert.equal(parsed.record.windows?.[1]?.id, "month");
  assert.equal(parsed.record.windows?.[1]?.label, "30d");
  assert.deepEqual(parsed.record.details, {
    grok: {
      monthlyUsed: 250,
      monthlyLimit: 1000,
      monthlyResetAt: "2026-08-01T00:00:00.000Z",
    },
  });
  assert.equal(validateProviderRecord(parsed.record).ok, true);
});
