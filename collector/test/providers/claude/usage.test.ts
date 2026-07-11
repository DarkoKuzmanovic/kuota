import assert from "node:assert/strict";
import test from "node:test";

import { validateProviderRecord } from "../../../src/contract/validate.js";
import { scanForSecrets } from "../../../src/security/redact.js";
import {
  parseClaudeUsageResponse,
  type ClaudeUsageParseResult,
} from "../../../src/providers/claude/usage.js";

const OBSERVED_AT = "2026-07-11T10:00:00.000Z";
const SESSION_RESET = "2026-07-11T15:00:00.000Z";
const WEEKLY_RESET = "2026-07-18T10:00:00.000Z";

function parse(input: unknown, observedAt = OBSERVED_AT): ClaudeUsageParseResult {
  return parseClaudeUsageResponse(input, observedAt);
}

function assertFailure(input: unknown): void {
  const result = parse(input);
  assert.deepEqual(result, {
    ok: false,
    reason: "malformed-response",
    status: "Provider unavailable",
  });
}

function assertSuccess(input: unknown, observedAt = OBSERVED_AT) {
  const result = parse(input, observedAt);
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected a successful Claude usage parse");
  }
  return result.record;
}

test("normalizes legacy windows and extra usage without copying provider fields", () => {
  const record = assertSuccess({
    five_hour: { utilization: 25.5, resets_at: SESSION_RESET },
    seven_day: { utilization: 40, resets_at: WEEKLY_RESET },
    seven_day_oauth_apps: { utilization: 10 },
    seven_day_opus: { utilization: 60, resets_at: WEEKLY_RESET },
    seven_day_sonnet: { utilization: 30, resets_at: WEEKLY_RESET },
    seven_day_haiku: { utilization: 5, resets_at: WEEKLY_RESET },
    extra_usage: {
      is_enabled: true,
      monthly_limit: 25,
      used_credits: 4,
      utilization: 16.666,
    },
    forward_compatible: { ignored: true },
  });

  assert.deepEqual(record, {
    id: "claude",
    state: "ok",
    lastSuccessAt: OBSERVED_AT,
    windows: [
      { id: "session", label: "Session (5-hour)", usedPercent: 25.5, resetAt: SESSION_RESET },
      { id: "weekly-all", label: "Weekly (all)", usedPercent: 40, resetAt: WEEKLY_RESET },
      { id: "weekly-oauth-apps", label: "OAuth apps", usedPercent: 10 },
      { id: "weekly-haiku", label: "Weekly Haiku", usedPercent: 5, resetAt: WEEKLY_RESET },
      { id: "weekly-opus", label: "Weekly Opus", usedPercent: 60, resetAt: WEEKLY_RESET },
      { id: "weekly-sonnet", label: "Weekly Sonnet", usedPercent: 30, resetAt: WEEKLY_RESET },
    ],
    details: {
      claude: {
        extraUsageEnabled: true,
        extraUsageUsedCredits: 4,
        extraUsageMonthlyLimit: 25,
      },
    },
  });
  assert.equal(JSON.stringify(record).includes("forward_compatible"), false);
  assert.deepEqual(scanForSecrets(record), []);
  assert.equal(validateProviderRecord(record).ok, true);
});

test("accepts limits-only responses with base and scoped model windows", () => {
  const record = assertSuccess({
    limits: [
      { kind: "weekly_scoped", utilization: 12, resets_at: WEEKLY_RESET, scope: { model: { id: "synthetic-sonnet-id", display_name: "Synthetic Sonnet" } } },
      { kind: "session", utilization: 2, resets_at: SESSION_RESET },
      { kind: "weekly_all", utilization: 22, resets_at: WEEKLY_RESET },
      { kind: "weekly_scoped", utilization: 8, scope: { model: { id: "synthetic-opus-id", display_name: "Synthetic Opus" } } },
    ],
  });

  assert.deepEqual(record.windows, [
    { id: "session", label: "Session (5-hour)", usedPercent: 2, resetAt: SESSION_RESET },
    { id: "weekly-all", label: "Weekly (all)", usedPercent: 22, resetAt: WEEKLY_RESET },
    { id: "weekly-synthetic-opus", label: "Weekly Synthetic Opus", usedPercent: 8 },
    { id: "weekly-synthetic-sonnet", label: "Weekly Synthetic Sonnet", usedPercent: 12, resetAt: WEEKLY_RESET },
  ]);
});

test("gives valid legacy windows precedence and uses limits for missing base windows", () => {
  const record = assertSuccess({
    five_hour: { utilization: 50, resets_at: SESSION_RESET },
    seven_day: { utilization: 60, resets_at: WEEKLY_RESET },
    seven_day_sonnet: { utilization: 70, resets_at: WEEKLY_RESET },
    limits: [
      { kind: "session", utilization: 99, resets_at: "2026-07-11T16:00:00.000Z" },
      { kind: "weekly_all", utilization: 98, resets_at: "2026-07-19T10:00:00.000Z" },
      { kind: "weekly_scoped", utilization: 7, scope: { model: { id: "synthetic-haiku-id", display_name: "Synthetic Haiku" } } },
      { kind: "weekly_scoped", utilization: 97, scope: { model: { id: "synthetic-sonnet-id", display_name: "Synthetic Sonnet" } } },
    ],
  });

  assert.deepEqual(record.windows, [
    { id: "session", label: "Session (5-hour)", usedPercent: 50, resetAt: SESSION_RESET },
    { id: "weekly-all", label: "Weekly (all)", usedPercent: 60, resetAt: WEEKLY_RESET },
    { id: "weekly-sonnet", label: "Weekly Sonnet", usedPercent: 70, resetAt: WEEKLY_RESET },
    { id: "weekly-synthetic-haiku", label: "Weekly Synthetic Haiku", usedPercent: 7 },
    { id: "weekly-synthetic-sonnet", label: "Weekly Synthetic Sonnet", usedPercent: 97 },
  ]);
});

test("omits null windows and null extra-usage metrics without inventing values", () => {
  const record = assertSuccess({
    five_hour: null,
    seven_day: { utilization: 0 },
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: {
      is_enabled: false,
      monthly_limit: null,
      used_credits: null,
      utilization: null,
    },
  });

  assert.deepEqual(record, {
    id: "claude",
    state: "ok",
    lastSuccessAt: OBSERVED_AT,
    windows: [{ id: "weekly-all", label: "Weekly (all)", usedPercent: 0 }],
    details: { claude: { extraUsageEnabled: false } },
  });
});

test("accepts enabled, disabled, and partial extra usage details", () => {
  for (const [extraUsage, expectedDetails, expectedWindow] of [
    [{ is_enabled: true }, { extraUsageEnabled: true }, undefined],
    [{ is_enabled: false }, { extraUsageEnabled: false }, undefined],
    [
      { is_enabled: true, monthly_limit: 10, used_credits: 2 },
      { extraUsageEnabled: true, extraUsageUsedCredits: 2, extraUsageMonthlyLimit: 10 },
      undefined,
    ],
    [
      { is_enabled: true, utilization: 20 },
      { extraUsageEnabled: true },
      undefined,
    ],
  ] as const) {
    const record = assertSuccess({ extra_usage: extraUsage });
    assert.deepEqual(record.details, { claude: expectedDetails });
    assert.deepEqual(record.windows, expectedWindow === undefined ? undefined : [expectedWindow]);
  }
});

test("rejects malformed percentages, timestamps, extra usage, limits, scopes, and duplicates", () => {
  const malformed: readonly unknown[] = [
    { five_hour: { utilization: -1 } },
    { five_hour: { utilization: 101 } },
    { five_hour: { utilization: Number.NaN } },
    { five_hour: { utilization: 1, resets_at: "synthetic-not-a-timestamp" } },
    { extra_usage: { is_enabled: "synthetic" } },
    { extra_usage: { is_enabled: true, used_credits: -1 } },
    { limits: { kind: "session" } },
    { limits: [{ kind: "session", utilization: 1 }, { kind: "session", utilization: 2 }] },
    { limits: [{ kind: "weekly_scoped", utilization: 1 }] },
    { limits: [{ kind: "weekly_scoped", utilization: 1, scope: { model: { id: "synthetic-id" } } }] },
    { limits: [{ kind: "weekly_scoped", utilization: 1, scope: { model: { id: "synthetic-id", display_name: "Synthetic" } } }, { kind: "weekly_scoped", utilization: 2, scope: { model: { id: "synthetic-id", display_name: "Synthetic" } } }] },
    { limits: [{ kind: "session", utilization: null }] },
  ];

  for (const input of malformed) assertFailure(input);
});

test("requires a window or genuine extra-usage detail and accepts unknown kinds only as non-data", () => {
  assertFailure({});
  assertFailure({ forward_only: { value: "synthetic" } });
  assertFailure({ limits: [{ kind: "future_kind", utilization: 1 }] });
  assertSuccess({ limits: [{ kind: "future_kind", utilization: 1 }], extra_usage: { is_enabled: false } });
});

test("rejects hostile object graphs without throwing or leaking values", () => {
  const getter: Record<string, unknown> = {};
  Object.defineProperty(getter, "five_hour", {
    enumerable: true,
    get() {
      throw new Error("synthetic-hostile-response-value");
    },
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const symbolRoot = { five_hour: { utilization: 1 }, [Symbol("synthetic")]: true };
  const native = { five_hour: new Date(0) };
  const proxy = new Proxy({ five_hour: { utilization: 1 } }, {
    ownKeys() {
      throw new Error("synthetic-proxy-value");
    },
  });

  for (const hostile of [getter, cyclic, symbolRoot, native, proxy]) {
    assert.doesNotThrow(() => {
      const result = parse(hostile);
      assert.deepEqual(result, {
        ok: false,
        reason: "malformed-response",
        status: "Provider unavailable",
      });
      assert.equal(JSON.stringify(result).includes("synthetic-hostile"), false);
      assert.equal(JSON.stringify(result).includes("synthetic-proxy"), false);
    });
  }
});

test("uses deterministic safe model IDs and keeps observed time exact", () => {
  const input = {
    limits: [
      { kind: "weekly_scoped", utilization: 1, scope: { model: { id: "synthetic-z", display_name: "Model Z" } } },
      { kind: "weekly_scoped", utilization: 2, scope: { model: { id: "synthetic-a", display_name: "Model A" } } },
    ],
  };
  const first = assertSuccess(input);
  const second = assertSuccess({ ...input, limits: [...(input.limits ?? [])].reverse() });
  assert.deepEqual(first, second);
  assert.equal(first.lastSuccessAt, OBSERVED_AT);
  assert.match(first.windows?.[0]?.id ?? "", /^weekly-model-[a-z0-9-]+$/);
  assert.ok((first.windows?.[0]?.id.length ?? 0) <= 80);

  assert.ok((first.windows?.[1]?.label.length ?? 0) <= 100);
});

test("accepts the current Claude payload shape and normalizes ISO timestamps", () => {
  const record = assertSuccess({
    five_hour: {
      utilization: 25,
      resets_at: "2026-07-11T15:00:00.123456+02:00",
      limit: null,
      used: null,
    },
    seven_day: {
      percent: 40,
      resets_at: null,
      dollar_limit: null,
      dollar_used: null,
    },
    limits: [
      {
        kind: "five_hour",
        group: "default",
        percent: 99,
        severity: "ok",
        resets_at: "2026-07-11T16:00:00.000000Z",
        scope: null,
        is_active: true,
      },
      {
        kind: "seven_day",
        group: "default",
        percent: 98,
        severity: "ok",
        resets_at: "2026-07-18T10:00:00.000000Z",
        scope: null,
        is_active: true,
      },
      {
        kind: "seven_day",
        group: "default",
        percent: 4,
        severity: "ok",
        resets_at: "2026-07-18T10:00:00.000000Z",
        scope: {
          model: { id: null, display_name: null, future_name: "ignored" },
          surface: null,
        },
        is_active: true,
      },
    ],
    extra_usage: {
      is_enabled: true,
      monthly_limit: 25,
      used_credits: 4,
      currency: "USD",
      decimal_places: 2,
      disabled_reason: null,
      daily: { percent: 10 },
      weekly: { percent: 20 },
    },
    spend: { total: 100, currency: "USD" },
    member_dashboard: { enabled: true },
  }, "2026-07-11T12:00:00.654321+02:00");

  assert.equal(record.lastSuccessAt, "2026-07-11T10:00:00.654Z");
  assert.deepEqual(record.windows, [
    {
      id: "session",
      label: "Session (5-hour)",
      usedPercent: 25,
      resetAt: "2026-07-11T13:00:00.123Z",
    },
    {
      id: "weekly-all",
      label: "Weekly (all)",
      usedPercent: 40,
    },
  ]);
  assert.deepEqual(record.details, {
    claude: {
      extraUsageEnabled: true,
      extraUsageUsedCredits: 4,
      extraUsageMonthlyLimit: 25,
      extraUsageCurrency: "USD",
      extraUsageDecimalPlaces: 2,
    },
  });
});

test("accepts utilization or percent but rejects conflicting aliases", () => {
  assert.deepEqual(
    assertSuccess({ five_hour: { utilization: 25, percent: 25 } }).windows,
    [{ id: "session", label: "Session (5-hour)", usedPercent: 25 }],
  );
  assertFailure({ five_hour: { utilization: 25, percent: 26 } });
});

test("deduplicates identical dynamic models and rejects conflicting collisions", () => {
  const duplicate = assertSuccess({
    limits: [
      {
        kind: "weekly_scoped",
        percent: 10,
        scope: { model: { id: "synthetic-model-id", display_name: "Synthetic model" } },
      },
      {
        kind: "weekly_scoped",
        percent: 10,
        scope: { model: { id: "synthetic-model-id", display_name: "Synthetic model" } },
      },
    ],
  });
  assert.equal(duplicate.windows?.length, 1);

  assertFailure({
    limits: [
      {
        kind: "weekly_scoped",
        percent: 10,
        scope: { model: { id: "synthetic-model-id", display_name: "Synthetic model" } },
      },
      {
        kind: "weekly_scoped",
        percent: 11,
        scope: { model: { id: "synthetic-model-id", display_name: "Synthetic model" } },
      },
    ],
  });
});

test("does not collapse model IDs merely because they contain known model names", () => {
  const record = assertSuccess({
    limits: [
      {
        kind: "weekly_scoped",
        percent: 10,
        scope: { model: { id: "opus", display_name: "First model" } },
      },
      {
        kind: "weekly_scoped",
        percent: 20,
        scope: { model: { id: "synthetic-opus", display_name: "Second model" } },
      },
    ],
  });
  assert.equal(record.windows?.length, 2);
});

test("rejects sensitive model IDs in camel, snake, and kebab forms", () => {
  for (const id of ["accountId12345678", "account_id_12345678", "account-id-12345678"]) {
    assertFailure({
      limits: [
        {
          kind: "weekly_scoped",
          percent: 10,
          scope: { model: { id, display_name: "Synthetic model" } },
        },
      ],
    });
  }
});

test("rejects malformed supported extra-usage details while ignoring unknown data", () => {
  for (const extraUsage of [
    { is_enabled: true, used_credits: 1.5 },
    { is_enabled: true, monthly_limit: "10" },
    { is_enabled: true, currency: 2 },
    { is_enabled: true, decimal_places: -1 },
    { is_enabled: true, disabled_reason: 2 },
  ]) {
    assertFailure({ extra_usage: extraUsage });
  }

  const nullFields = assertSuccess({
    extra_usage: {
      is_enabled: true,
      used_credits: null,
      monthly_limit: null,
      currency: null,
      decimal_places: null,
      disabled_reason: null,
    },
  });
  assert.deepEqual(nullFields.details, { claude: { extraUsageEnabled: true } });

  const record = assertSuccess({
    extra_usage: {
      is_enabled: false,
      currency: "USD",
      decimal_places: 2,
      disabled_reason: "not_enabled",
      provider_future_field: { arbitrary: true },
    },
  });
  assert.deepEqual(record.details, {
    claude: {
      extraUsageEnabled: false,
      extraUsageCurrency: "USD",
      extraUsageDecimalPlaces: 2,
      extraUsageDisabledReason: "not_enabled",
    },
  });
});

test("keeps valid base windows when scoped entries have unusable identity or scope", () => {
  const record = assertSuccess({
    limits: [
      { kind: "session", utilization: 10, resets_at: SESSION_RESET },
      { kind: "weekly_all", utilization: 20, resets_at: WEEKLY_RESET },
      { kind: "weekly_scoped", utilization: 5, scope: null },
      { kind: "weekly_scoped", utilization: 6 },
      { kind: "weekly_scoped", utilization: 7, scope: { model: null } },
      { kind: "weekly_scoped", utilization: 8, scope: { model: { id: null, display_name: null } } },
      {
        kind: "weekly_scoped",
        utilization: 9,
        scope: { model: { id: `synthetic-${"x".repeat(210)}`, display_name: "Synthetic Valid" } },
      },
    ],
  });

  assert.deepEqual(record.windows, [
    { id: "session", label: "Session (5-hour)", usedPercent: 10, resetAt: SESSION_RESET },
    { id: "weekly-all", label: "Weekly (all)", usedPercent: 20, resetAt: WEEKLY_RESET },
  ]);
});

test("drops sensitive scoped model IDs without leaking them while valid peers survive", () => {
  const record = assertSuccess({
    limits: [
      { kind: "session", utilization: 10, resets_at: SESSION_RESET },
      {
        kind: "weekly_scoped",
        utilization: 5,
        scope: { model: { id: "account-id-99887766", display_name: "Synthetic Frontier" } },
      },
    ],
  });

  assert.deepEqual(record.windows, [
    { id: "session", label: "Session (5-hour)", usedPercent: 10, resetAt: SESSION_RESET },
  ]);
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("account-id"), false);
  assert.equal(serialized.includes("99887766"), false);
  assert.deepEqual(scanForSecrets(record), []);
});

test("skips inactive limit entries before parsing their malformed metrics", () => {
  const record = assertSuccess({
    limits: [
      { kind: "session", utilization: 10, resets_at: SESSION_RESET },
      {
        kind: "weekly_scoped",
        is_active: false,
        utilization: 999,
        scope: { model: { id: "synthetic-inactive", display_name: "Synthetic Inactive" } },
      },
    ],
  });

  assert.deepEqual(record.windows, [
    { id: "session", label: "Session (5-hour)", usedPercent: 10, resetAt: SESSION_RESET },
  ]);
});

test("rejects limit entries whose is_active flag is present but not a boolean", () => {
  assertFailure({ limits: [{ kind: "session", utilization: 10, is_active: "synthetic" }] });
  assertFailure({ limits: [{ kind: "session", utilization: 10, is_active: 1 }] });
});

test("emits the current null-id Fable window when the display name is safe", () => {
  const record = assertSuccess({
    limits: [
      {
        kind: "weekly_scoped",
        utilization: 5,
        resets_at: WEEKLY_RESET,
        scope: { model: { id: null, display_name: "Fable" } },
      },
    ],
  });

  assert.deepEqual(record.windows, [
    { id: "weekly-fable", label: "Weekly Fable", usedPercent: 5, resetAt: WEEKLY_RESET },
  ]);
  assert.deepEqual(scanForSecrets(record), []);
});

test("deduplicates matching null-id models and rejects conflicting ones", () => {
  const record = assertSuccess({
    limits: [
      { kind: "weekly_scoped", utilization: 5, scope: { model: { id: null, display_name: "Fable" } } },
      { kind: "weekly_scoped", utilization: 5, scope: { model: { id: null, display_name: "Fable" } } },
    ],
  });
  assert.equal(record.windows?.length, 1);

  assertFailure({
    limits: [
      { kind: "weekly_scoped", utilization: 5, scope: { model: { id: null, display_name: "Fable" } } },
      { kind: "weekly_scoped", utilization: 6, scope: { model: { id: null, display_name: "Fable" } } },
    ],
  });
});

test("keeps distinct raw model IDs distinct and leak-free when slugs and displays collide", () => {
  const record = assertSuccess({
    limits: [
      {
        kind: "weekly_scoped",
        utilization: 5,
        scope: { model: { id: "synthetic-alpha-1", display_name: "Synthetic Shared" } },
      },
      {
        kind: "weekly_scoped",
        utilization: 6,
        scope: { model: { id: "synthetic_alpha_1", display_name: "Synthetic Shared" } },
      },
    ],
  });

  const ids = (record.windows ?? []).map((window) => window.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.includes("weekly-synthetic-shared"));
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("synthetic-alpha-1"), false);
  assert.equal(serialized.includes("synthetic_alpha_1"), false);
  assert.deepEqual(scanForSecrets(record), []);
});

test("suppresses a generic model window that collides with a legacy model window", () => {
  const record = assertSuccess({
    five_hour: { utilization: 10, resets_at: SESSION_RESET },
    seven_day_opus: { utilization: 60, resets_at: WEEKLY_RESET },
    limits: [
      {
        kind: "weekly_scoped",
        utilization: 99,
        scope: { model: { id: "synthetic-opus-id", display_name: "Opus" } },
      },
    ],
  });

  assert.deepEqual(record.windows, [
    { id: "session", label: "Session (5-hour)", usedPercent: 10, resetAt: SESSION_RESET },
    { id: "weekly-opus", label: "Weekly Opus", usedPercent: 60, resetAt: WEEKLY_RESET },
  ]);
});

test("gives a model window a hash suffix when it collides with a base window id", () => {
  const record = assertSuccess({
    seven_day_oauth_apps: { utilization: 10 },
    limits: [
      {
        kind: "weekly_scoped",
        utilization: 20,
        scope: { model: { id: "synthetic-oauth-model", display_name: "OAuth apps" } },
      },
    ],
  });

  const windows = record.windows ?? [];
  assert.equal(windows.length, 2);
  assert.deepEqual(
    windows.find((window) => window.id === "weekly-oauth-apps"),
    { id: "weekly-oauth-apps", label: "OAuth apps", usedPercent: 10 },
  );
  const model = windows.find((window) => window.id.startsWith("weekly-oauth-apps-"));
  assert.equal(model?.label, "Weekly OAuth apps");
  assert.equal(model?.usedPercent, 20);
  assert.notEqual(model?.id, "weekly-oauth-apps");
});

test("produces an identical record regardless of limit order under id collisions", () => {
  const limits = [
    {
      kind: "weekly_scoped",
      utilization: 5,
      scope: { model: { id: "synthetic-alpha-1", display_name: "Synthetic Shared" } },
    },
    {
      kind: "weekly_scoped",
      utilization: 6,
      scope: { model: { id: "synthetic_alpha_1", display_name: "Synthetic Shared" } },
    },
    {
      kind: "weekly_scoped",
      utilization: 20,
      scope: { model: { id: "synthetic-oauth-model", display_name: "OAuth apps" } },
    },
  ];
  const input = { seven_day_oauth_apps: { utilization: 10 }, limits };
  const first = assertSuccess(input);
  const second = assertSuccess({ ...input, limits: [...limits].reverse() });
  assert.deepEqual(first, second);
  assert.deepEqual(scanForSecrets(first), []);
});

test("treats extra-usage overage as genuine data with independent credit values", () => {
  const record = assertSuccess({
    extra_usage: { is_enabled: true, monthly_limit: 1, used_credits: 2 },
  });
  assert.deepEqual(record.details, {
    claude: {
      extraUsageEnabled: true,
      extraUsageUsedCredits: 2,
      extraUsageMonthlyLimit: 1,
    },
  });
  assert.equal(validateProviderRecord(record).ok, true);

  // Both values remain independent non-negative safe integers; those bounds still reject.
  assertFailure({ extra_usage: { is_enabled: true, monthly_limit: 1, used_credits: -1 } });
  assertFailure({ extra_usage: { is_enabled: true, monthly_limit: -1, used_credits: 2 } });
  assertFailure({ extra_usage: { is_enabled: true, monthly_limit: 1, used_credits: 2.5 } });
});

test("isolates malformed extra-usage while surfacing valid windows, else fails alone", () => {
  const record = assertSuccess({
    five_hour: { utilization: 30, resets_at: SESSION_RESET },
    seven_day: { utilization: 40, resets_at: WEEKLY_RESET },
    extra_usage: { is_enabled: true, used_credits: -1 },
  });
  assert.deepEqual(record.windows, [
    { id: "session", label: "Session (5-hour)", usedPercent: 30, resetAt: SESSION_RESET },
    { id: "weekly-all", label: "Weekly (all)", usedPercent: 40, resetAt: WEEKLY_RESET },
  ]);
  assert.equal(record.details, undefined);
  assert.equal(validateProviderRecord(record).ok, true);

  // With no other usable data, malformed extra-usage still fails the whole response.
  assertFailure({ extra_usage: { is_enabled: true, used_credits: -1 } });
});

test("keeps valid legacy windows when dynamic seven-day identities are unsafe or unusable", () => {
  const record = assertSuccess({
    five_hour: { utilization: 10, resets_at: SESSION_RESET },
    seven_day: { utilization: 20, resets_at: WEEKLY_RESET },
    seven_day_account_id_12345678: { utilization: 30 },
    seven_day_: { utilization: 40 },
    seven_day_sonnet: { utilization: 50, resets_at: WEEKLY_RESET },
  });
  assert.deepEqual(record.windows, [
    { id: "session", label: "Session (5-hour)", usedPercent: 10, resetAt: SESSION_RESET },
    { id: "weekly-all", label: "Weekly (all)", usedPercent: 20, resetAt: WEEKLY_RESET },
    { id: "weekly-sonnet", label: "Weekly Sonnet", usedPercent: 50, resetAt: WEEKLY_RESET },
  ]);
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("account_id"), false);
  assert.equal(serialized.includes("12345678"), false);
  assert.deepEqual(scanForSecrets(record), []);

  // A malformed recognized metric on a dynamic legacy window still rejects despite valid peers.
  assertFailure({ five_hour: { utilization: 10 }, seven_day_sonnet: { utilization: 101 } });
});

test("widens disabled_reason to safe provider text while rejecting secret-shaped content", () => {
  const record = assertSuccess({
    extra_usage: {
      is_enabled: false,
      disabled_reason: "You've reached your spending limit, contact your admin.",
    },
  });
  assert.deepEqual(record.details, {
    claude: {
      extraUsageEnabled: false,
      extraUsageDisabledReason: "You've reached your spending limit, contact your admin.",
    },
  });
  assert.equal(validateProviderRecord(record).ok, true);

  // Secret/account-shaped, credential-shaped, or control-laden reasons are isolated as malformed.
  for (const disabledReason of [
    "Bearer sk-ant-api03-abcdefgh12345678",
    "account_id_12345678",
    "authorization: Bearer abcdefgh",
    "eyJhbGciOi.JzdWIiOiIx.aWF0IjoxNj",
    "control\u0007char",
  ]) {
    assertFailure({ extra_usage: { is_enabled: false, disabled_reason: disabledReason } });
  }
});

test("keeps currency a strict bounded code and rejects arbitrary symbols", () => {
  const record = assertSuccess({
    extra_usage: { is_enabled: true, currency: "USD" },
  });
  assert.deepEqual(record.details, {
    claude: { extraUsageEnabled: true, extraUsageCurrency: "USD" },
  });

  for (const currency of ["$", "US$ Dollars!", "\u20ac"]) {
    assertFailure({ extra_usage: { is_enabled: true, currency } });
  }
});

test("isolates credential-shaped extra-usage currency while preserving base windows", () => {
  // A short credential-shaped currency passes the bounded code shape but must not emit a value the
  // final validator would reject. It isolates the extra-usage entry (no details block) rather than
  // failing the whole record, so the valid base window still surfaces.
  const record = assertSuccess({
    five_hour: { utilization: 25.5, resets_at: SESSION_RESET },
    extra_usage: { is_enabled: true, used_credits: 4, currency: "sk-ant-abc12345" },
  });

  assert.deepEqual(record.windows, [
    { id: "session", label: "Session (5-hour)", usedPercent: 25.5, resetAt: SESSION_RESET },
  ]);
  assert.equal("details" in record, false);

  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("sk-ant"), false);
  assert.deepEqual(scanForSecrets(record), []);
  assert.equal(validateProviderRecord(record).ok, true);
});

test("drops a credential-shaped scoped model label while preserving base windows", () => {
  // A credential-shaped model display name is unusable identity: the scoped entry is dropped so the
  // valid base window still surfaces, and no secret-shaped label reaches the normalized output.
  const record = assertSuccess({
    five_hour: { utilization: 10, resets_at: SESSION_RESET },
    limits: [
      {
        kind: "weekly_scoped",
        utilization: 5,
        resets_at: WEEKLY_RESET,
        scope: { model: { id: null, display_name: "sk-ant-abc12345" } },
      },
    ],
  });

  assert.deepEqual(record.windows, [
    { id: "session", label: "Session (5-hour)", usedPercent: 10, resetAt: SESSION_RESET },
  ]);

  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("sk-ant"), false);
  assert.deepEqual(scanForSecrets(record), []);
  assert.equal(validateProviderRecord(record).ok, true);
});