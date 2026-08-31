import assert from "node:assert/strict";
import test from "node:test";

import { parseOpencodeUsageResponse } from "../../../src/providers/opencode/usage.js";

const OBSERVED_AT = "2026-09-01T12:00:00.000Z";

function okBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    usage: {
      rolling: { status: "ok", percent: 5, resetsAt: "2026-09-01T13:00:00+02:00" },
      weekly: { status: "ok", percent: 71.25, resetsAt: "2026-09-08T00:00:00+02:00" },
      monthly: { status: "ok", percent: 12.5, resetsAt: "2026-10-01T00:00:00+02:00" },
      ...overrides,
    },
  };
}

test("parses all three windows and normalizes resetsAt to UTC ISO 8601", () => {
  const parsed = parseOpencodeUsageResponse(okBody(), OBSERVED_AT);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.record.id, "opencode");
  assert.equal(parsed.record.state, "ok");
  assert.equal(parsed.record.lastSuccessAt, OBSERVED_AT);
  assert.deepEqual(parsed.record.windows ?? [], [
    { id: "rolling", label: "5h", usedPercent: 5, resetAt: "2026-09-01T11:00:00.000Z" },
    { id: "weekly", label: "Weekly", usedPercent: 71.25, resetAt: "2026-09-07T22:00:00.000Z" },
    { id: "monthly", label: "Monthly", usedPercent: 12.5, resetAt: "2026-09-30T22:00:00.000Z" },
  ]);
});

test("accepts boundary percent values 0 and 100", () => {
  const body = okBody({
    rolling: { status: "ok", percent: 0, resetsAt: "2026-09-01T13:00:00+02:00" },
    monthly: { status: "ok", percent: 100, resetsAt: "2026-10-01T00:00:00+02:00" },
  });
  const parsed = parseOpencodeUsageResponse(body, OBSERVED_AT);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.record.windows?.[0]?.usedPercent, 0);
  assert.equal(parsed.record.windows?.[2]?.usedPercent, 100);
});

test("ignores unknown extra window keys", () => {
  const body = okBody({ yearly: { status: "ok", percent: 1, resetsAt: "2026-09-01T13:00:00+02:00" } });
  const parsed = parseOpencodeUsageResponse(body, OBSERVED_AT);
  assert.equal(parsed.ok, true);
});

test("rejects a missing, non-record, or non-ok window", () => {
  for (const replacement of [undefined, null, 5, "ok", { status: "error", percent: 5, resetsAt: "2026-09-01T13:00:00+02:00" }, { status: "ok" }]) {
    const missing = okBody({ weekly: replacement });
    assert.equal(parseOpencodeUsageResponse(missing, OBSERVED_AT).ok, false, `weekly = ${JSON.stringify(replacement)}`);
  }
  const missingRolling = okBody();
  delete (missingRolling as { usage: Record<string, unknown> }).usage.rolling;
  assert.equal(parseOpencodeUsageResponse(missingRolling, OBSERVED_AT).ok, false);
});

test("rejects out-of-range, non-finite, or non-numeric percent", () => {
  for (const percent of [-1, 100.01, NaN, Infinity, "high", true, []]) {
    const body = okBody({ weekly: { status: "ok", percent, resetsAt: "2026-09-08T00:00:00+02:00" } });
    assert.equal(parseOpencodeUsageResponse(body, OBSERVED_AT).ok, false, `percent = ${String(percent)}`);
  }
});

test("rejects unresolvable, non-string, or missing resetsAt", () => {
  for (const resetsAt of [undefined, null, "", 42, {}, "next tuesday", "2026-13-99"]) {
    const body = okBody({ weekly: { status: "ok", percent: 1, resetsAt } });
    assert.equal(parseOpencodeUsageResponse(body, OBSERVED_AT).ok, false, `resetsAt = ${String(resetsAt)}`);
  }
});

test("rejects hostile and structurally wrong inputs", () => {
  for (const input of [null, undefined, 42, "text", [], { usage: 5 }, { usage: "x" }, { usage: [] }, { usage: null }]) {
    assert.equal(parseOpencodeUsageResponse(input, OBSERVED_AT).ok, false, `input = ${String(input)}`);
  }
});

test("rejects an unparseable observedAt timestamp", () => {
  assert.equal(parseOpencodeUsageResponse(okBody(), "not-a-timestamp").ok, false);
});
