import assert from "node:assert/strict";
import test from "node:test";

import { commandCodePlanName, parseCommandCodeUsageResponse } from "../../../src/providers/commandcode/usage.js";

const OBSERVED_AT = "2026-09-01T12:00:00.000Z";

function okBody(): unknown {
  return {
    credits: { monthlyCredits: 200, purchasedCredits: 50, freeCredits: 10, belowThreshold: false, creditThreshold: 0.2 },
    windowLimits: {
      limited: false,
      exceeded: false,
      fiveHour: { used: 420, cap: 1000, exceeded: false, resetAt: 1756735200000 },
      weekly: { used: 30, cap: 300, exceeded: false, resetAt: 1759330800000 },
    },
  };
}

test("parses both windows and details with epoch-ms resetAt normalized to UTC ISO", () => {
  const parsed = parseCommandCodeUsageResponse(okBody(), OBSERVED_AT);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.record.id, "commandcode");
  assert.equal(parsed.record.state, "ok");
  assert.equal(parsed.record.lastSuccessAt, OBSERVED_AT);
  assert.deepEqual(parsed.record.windows ?? [], [
    { id: "fiveHour", label: "5h", used: 420, limit: 1000, usedPercent: 42, resetAt: "2025-09-01T14:00:00.000Z" },
    { id: "weekly", label: "Weekly", used: 30, limit: 300, usedPercent: 10, resetAt: "2025-10-01T15:00:00.000Z" },
  ]);
  assert.deepEqual(parsed.record.details, {
    commandcode: { monthlyCredits: 200, purchasedCredits: 50, freeCredits: 10, exceeded: false, weeklyExceeded: false },
  });
});

test("clamps usedPercent to 100 for exceeded windows and keeps used > limit", () => {
  const body = okBody() as { windowLimits: { fiveHour: Record<string, unknown>; weekly: Record<string, unknown> } };
  body.windowLimits.fiveHour.used = 1500;
  body.windowLimits.fiveHour.cap = 1000;
  const parsed = parseCommandCodeUsageResponse(body, OBSERVED_AT);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.record.windows?.[0]?.usedPercent, 100);
  assert.equal(parsed.record.windows?.[0]?.used, 1500);
  assert.equal(parsed.record.windows?.[0]?.limit, 1000);
});

test("rounds fractional wire counts to integer window counts with percent from unrounded values", () => {
  // Live wire lesson (2026-09-01 recon gate): weekly.used arrives fractional
  // (credit consumption is not integer); the contract keeps safe-integer
  // counts, but usedPercent must derive from the unrounded pair.
  const body = okBody() as { windowLimits: { weekly: Record<string, unknown> } };
  body.windowLimits.weekly.used = 12.49;
  body.windowLimits.weekly.cap = 250.4;
  const parsed = parseCommandCodeUsageResponse(body, OBSERVED_AT);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const weekly = parsed.record.windows?.[1];
  assert.equal(weekly?.used, 12);
  assert.equal(weekly?.limit, 250);
  assert.equal(weekly?.usedPercent, Math.min(100, (12.49 / 250.4) * 100));
});

test("rejects window counts beyond the safe-integer range", () => {
  const body = okBody() as { windowLimits: { fiveHour: Record<string, unknown> } };
  body.windowLimits.fiveHour.used = 2 ** 53 + 1;
  const parsed = parseCommandCodeUsageResponse(body, OBSERVED_AT);
  assert.equal(parsed.ok, false);
});

test("drops the weekly window when it is missing or its used/cap are unusable", () => {
  const missingWeekly = okBody() as { windowLimits: { weekly?: unknown } };
  delete missingWeekly.windowLimits.weekly;
  const withoutWeekly = parseCommandCodeUsageResponse(missingWeekly, OBSERVED_AT);
  assert.equal(withoutWeekly.ok, true);
  if (!withoutWeekly.ok) return;
  assert.equal(withoutWeekly.record.windows?.length, 1);

  const garbageWeekly = okBody() as { windowLimits: { weekly: Record<string, unknown> } };
  garbageWeekly.windowLimits.weekly = { used: "oops", cap: 300 };
  const tolerated = parseCommandCodeUsageResponse(garbageWeekly, OBSERVED_AT);
  assert.equal(tolerated.ok, true);
  if (!tolerated.ok) return;
  assert.equal(tolerated.record.windows?.length, 1);
  assert.equal(tolerated.record.details?.commandcode.weeklyExceeded, undefined);
});

test("fails when credits, windowLimits, or the fiveHour row are unusable", () => {
  for (const key of ["credits", "windowLimits"]) {
    const body = okBody() as Record<string, unknown>;
    body[key] = null;
    assert.equal(parseCommandCodeUsageResponse(body, OBSERVED_AT).ok, false, key);
  }
  for (const fiveHour of [undefined, null, 5, "x", { used: "nope", cap: 1000 }, { used: -1, cap: 1000 }, { used: 5, cap: "nope" }, {}]) {
    const body = okBody() as { windowLimits: { fiveHour: unknown } };
    body.windowLimits.fiveHour = fiveHour;
    assert.equal(parseCommandCodeUsageResponse(body, OBSERVED_AT).ok, false, `fiveHour = ${JSON.stringify(fiveHour)}`);
  }
});

test("omits garbage credential counts and flags instead of failing", () => {
  const body = okBody() as { credits: Record<string, unknown>; windowLimits: Record<string, unknown> };
  body.credits.monthlyCredits = "many";
  body.credits.purchasedCredits = NaN;
  body.credits.freeCredits = -5;
  body.windowLimits.exceeded = "yes";
  const fiveHour = body.windowLimits.fiveHour as Record<string, unknown>;
  fiveHour.exceeded = 1;
  const weekly = body.windowLimits.weekly as Record<string, unknown>;
  weekly.exceeded = "nope";
  const parsed = parseCommandCodeUsageResponse(body, OBSERVED_AT);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  // Empty details (every recognized value garbage) are omitted, never
  // emitted as an empty object. The weekly window itself (used/cap finite)
  // is still retained.
  assert.equal(parsed.record.details, undefined);
  assert.equal(parsed.record.windows?.length, 2);
});

test("accepts a closed-map plan name and refuses unknown ones (map enforced at the adapter)", () => {
  const merged = parseCommandCodeUsageResponse(okBody(), OBSERVED_AT, "GOAT");
  assert.equal(merged.ok, true);
  if (!merged.ok) return;
  assert.equal(merged.record.details?.commandcode.planName, "GOAT");

  // The parser merges whatever bounded text the adapter passes; unknown plan
  // ids are refused inside commandCodePlanName (tested below) — empty input
  // yields no planName here.
  for (const value of ["", undefined]) {
    const parsed = parseCommandCodeUsageResponse(okBody(), OBSERVED_AT, value);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.record.details?.commandcode.planName, undefined, `plan = ${String(value)}`);
  }
});

test("maps the closed plan id map exactly", () => {
  assert.equal(commandCodePlanName("individual-go"), "Go");
  assert.equal(commandCodePlanName("individual-goat"), "GOAT");
  assert.equal(commandCodePlanName("individual-pro"), "Pro");
  assert.equal(commandCodePlanName("individual-max10x"), "Max10x");
  assert.equal(commandCodePlanName("individual-enterprise"), undefined);
  assert.equal(commandCodePlanName(42), undefined);
  assert.equal(commandCodePlanName(undefined), undefined);
});

test("a recognized record is never dataless: rejects hostile inputs and empty recognition", () => {
  for (const input of [null, undefined, 42, "text", [], { credits: 5 }, { credits: {} }, { windowLimits: 5 }]) {
    assert.equal(parseCommandCodeUsageResponse(input, OBSERVED_AT).ok, false, `input = ${String(input)}`);
  }
  assert.equal(parseCommandCodeUsageResponse(okBody(), "not-a-timestamp").ok, false);
});
