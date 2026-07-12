import assert from "node:assert/strict";
import test from "node:test";

import { validateProviderRecord } from "../../../src/contract/validate.js";
import { scanForSecrets } from "../../../src/security/redact.js";
import {
  parseCodexUsageResponse,
  type CodexUsageParseResult,
} from "../../../src/providers/codex/usage.js";

const OBSERVED_AT = "2026-07-12T10:00:00.000Z";

function parse(input: unknown, observedAt = OBSERVED_AT): CodexUsageParseResult {
  return parseCodexUsageResponse(input, observedAt);
}


function assertFailure(input: unknown, observedAt = OBSERVED_AT): void {
  assert.deepEqual(parse(input, observedAt), {
    ok: false,
    reason: "malformed-response",
    status: "Provider unavailable",
  });
}

test("normalizes primary and secondary Codex windows with approved detail facts", () => {
  const result = parse({
    user_id: "synthetic-user-id",
    account_id: "synthetic-account-id",
    email: "synthetic@example.invalid",
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        used_percent: 25,
        limit_window_seconds: 18_000,
        reset_at: 1_760_000_000,
      },
      secondary_window: {
        used_percent: 40.5,
        limit_window_seconds: 604_800,
        reset_at: 1_760_050_000,
      },
      future_window: { used_percent: 99 },
    },
    credits: { has_credits: true, unlimited: false, balance: "12.50" },
    spend_control: { individual_limit: { used: "3.25" } },
    future_field: { ignored: true },
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected successful Codex usage parse");

  assert.deepEqual(result.record, {
    id: "codex",
    state: "ok",
    lastSuccessAt: OBSERVED_AT,
    windows: [
      {
        id: "primary",
        label: "Primary",
        usedPercent: 25,
        resetAt: "2025-10-09T08:53:20.000Z",
      },
      {
        id: "secondary",
        label: "Secondary",
        usedPercent: 40.5,
        resetAt: "2025-10-09T22:46:40.000Z",
      },
    ],
    details: { codex: { plan: "pro", credits: 12.5, cost: 3.25 } },
  });
  assert.equal(validateProviderRecord(result.record).ok, true);
});


test("omits unsafe optional provider detail facts while retaining valid windows", () => {
  const result = parse({
    plan_type: "pro\tunsafe",
    rate_limit: { primary_window: { used_percent: 10 } },
    credits: { has_credits: true, unlimited: false, balance: "not-a-number" },
    spend_control: { individual_limit: { used: "-1" } },
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected successful Codex usage parse");
  assert.deepEqual(result.record, {
    id: "codex",
    state: "ok",
    lastSuccessAt: OBSERVED_AT,
    windows: [{ id: "primary", label: "Primary", usedPercent: 10 }],
  });
});


test("rejects malformed recognized Codex window fields", () => {
  const malformed: readonly unknown[] = [
    { rate_limit: "not-an-object" },
    { rate_limit: { primary_window: [] } },
    { rate_limit: { primary_window: { used_percent: -1 } } },
    { rate_limit: { primary_window: { used_percent: 101 } } },
    { rate_limit: { primary_window: { used_percent: "10" } } },
    { rate_limit: { primary_window: { reset_at: -1 } } },
    { rate_limit: { primary_window: { reset_at: "1760000000" } } },
    { rate_limit: { primary_window: { reset_at: 1.5 } } },
    { rate_limit: { primary_window: { limit_window_seconds: -1 } } },
    { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 0 } } },
    { rate_limit: { primary_window: { limit_window_seconds: 1.5 } } },
  ];

  for (const input of malformed) assertFailure(input);
  assertFailure({ rate_limit: { primary_window: { used_percent: 10 } } }, "not-a-timestamp");
});

test("omits unavailable detail facts and never infers credits, cost, or tokens", () => {
  const result = parse({
    plan_type: "  Team  ",
    rate_limit: {
      primary_window: null,
      secondary_window: { reset_at: 1_760_000_000 },
      additional_window: { used_percent: "ignored" },
    },
    credits: { has_credits: false, unlimited: false, balance: "99.99", tokens: 99 },
    spend_control: { individual_limit: { used: "invalid", tokens: 10 } },
    tokens: 999,
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected successful Codex usage parse");
  assert.deepEqual(result.record, {
    id: "codex",
    state: "ok",
    lastSuccessAt: OBSERVED_AT,
    windows: [{ id: "secondary", label: "Secondary", resetAt: "2025-10-09T08:53:20.000Z" }],
    details: { codex: { plan: "Team" } },
  });
  assert.equal(JSON.stringify(result.record).includes("tokens"), false);
  assert.deepEqual(scanForSecrets(result.record), []);
});

test("retains only enabled finite credit and cost balances", () => {
  const result = parse({
    rate_limit: { primary_window: { used_percent: 0 } },
    credits: { has_credits: true, unlimited: false, balance: "0" },
    spend_control: { individual_limit: { used: "0.01" } },
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected successful Codex usage parse");
  assert.deepEqual(result.record.details, { codex: { credits: 0, cost: 0.01 } });

  for (const credits of [
    { has_credits: true, unlimited: true, balance: "2" },
    { has_credits: false, unlimited: false, balance: "2" },
    { has_credits: true, unlimited: false, balance: "Infinity" },
    { has_credits: true, unlimited: false, balance: "-2" },
  ]) {
    const omitted = parse({ rate_limit: { primary_window: { used_percent: 1 } }, credits });
    assert.equal(omitted.ok, true);
    if (omitted.ok) assert.equal(omitted.record.details, undefined);
  }
});

test("rejects hostile response graphs with a value-free failure", () => {
  const getter: Record<string, unknown> = {};
  Object.defineProperty(getter, "rate_limit", {
    enumerable: true,
    get() {
      throw new Error("synthetic-hostile-response-value");
    },
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const symbolRoot = { rate_limit: { primary_window: { used_percent: 1 } }, [Symbol("synthetic")]: true };
  const native = { rate_limit: new Date(0) };
  const proxy = new Proxy({ rate_limit: { primary_window: { used_percent: 1 } } }, {
    ownKeys() {
      throw new Error("synthetic-proxy-value");
    },
  });

  for (const hostile of [getter, cyclic, symbolRoot, native, proxy]) {
    assert.doesNotThrow(() => assertFailure(hostile));
    const serialized = JSON.stringify(parse(hostile));
    assert.equal(serialized.includes("synthetic-hostile"), false);
    assert.equal(serialized.includes("synthetic-proxy"), false);
  }
});

test("rejects empty and sensitive response data without retaining it", () => {
  assertFailure({});
  assertFailure({ future_only: { value: true } });
  assertFailure({ authorization: "synthetic-secret" });
});