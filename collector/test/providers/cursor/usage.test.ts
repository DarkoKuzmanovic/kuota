import assert from "node:assert/strict";
import test from "node:test";

import { validateProviderRecord } from "../../../src/contract/validate.js";
import { fetchCursorUsage, type CursorUsageFetchSeam } from "../../../src/providers/cursor/fetch.js";
import { parseCursorUsageResponse } from "../../../src/providers/cursor/usage.js";

const OBSERVED_AT = "2026-08-02T12:00:00.000Z";
const RAW_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzeW50aGV0aWMtdXNlci0xMjMifQ.signature";

function parse(input: unknown) {
  return parseCursorUsageResponse(input, OBSERVED_AT);
}

test("normalizes plan window and optional cursor details", () => {
  const parsed = parse({
    billingCycleEnd: "2026-09-01T00:00:00.000Z",
    membershipType: "pro",
    individualUsage: {
      plan: { enabled: true, used: 40, limit: 100, remaining: 60 },
      onDemand: { enabled: true, used: 250, limit: null, remaining: null },
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.record.id, "cursor");
  assert.equal(parsed.record.windows?.[0]?.id, "plan");
  assert.equal(parsed.record.windows?.[0]?.used, 40);
  assert.equal(parsed.record.windows?.[0]?.limit, 100);
  assert.equal(parsed.record.windows?.[0]?.usedPercent, 40);
  assert.equal(parsed.record.windows?.[0]?.resetAt, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(parsed.record.details, {
    cursor: {
      membershipType: "pro",
      onDemandUsed: 250,
    },
  });
  assert.equal(validateProviderRecord(parsed.record).ok, true);
});

test("omits invented percent when limit missing", () => {
  const parsed = parse({
    billingCycleEnd: "2026-09-01T00:00:00.000Z",
    individualUsage: {
      plan: { enabled: true, used: 40 },
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.record.windows?.[0]?.used, 40);
  assert.equal(parsed.record.windows?.[0]?.limit, undefined);
  assert.equal(parsed.record.windows?.[0]?.usedPercent, undefined);
});

test("rejects empty recognition as not ok", () => {
  const malformed = [
    {},
    { individualUsage: {} },
    { individualUsage: { plan: { enabled: false } } },
    { billingCycleEnd: "2026-09-01T00:00:00.000Z", individualUsage: { plan: { enabled: true } } },
  ];
  for (const input of malformed) {
    assert.deepEqual(parse(input), {
      ok: false,
      reason: "malformed-response",
      status: "Provider unavailable",
    });
  }
});

test("fetch output pipes through the parser to a fully populated record (integration)", async () => {
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
  const fetch: CursorUsageFetchSeam = async () => body({
    billingCycleEnd: "2026-09-01T00:00:00.000Z",
    membershipType: "pro",
    individualUsage: {
      plan: {
        enabled: true,
        used: 918,
        limit: 2000,
        remaining: 1082,
        autoPercentUsed: 45.9,
        apiPercentUsed: 10,
        totalPercentUsed: 45.9,
      },
      onDemand: { enabled: false, used: 0, limit: null, remaining: null },
    },
  });

  const fetched = await fetchCursorUsage({
    credential: { kind: "session", value: RAW_JWT },
    signal: new AbortController().signal,
    fetch,
  });
  assert.equal(fetched.outcome, "ok");
  if (fetched.outcome !== "ok") throw new Error("expected fetch success");

  const parsed = parse(fetched.value);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("expected parse success on real-shaped fetch output");

  assert.equal(parsed.record.windows?.[0]?.id, "plan");
  assert.equal(parsed.record.windows?.[0]?.usedPercent, 45.9);
  assert.deepEqual(parsed.record.details, {
    cursor: {
      membershipType: "pro",
      autoPercentUsed: 45.9,
      apiPercentUsed: 10,
      totalPercentUsed: 45.9,
    },
  });
  assert.equal(validateProviderRecord(parsed.record).ok, true);
});
