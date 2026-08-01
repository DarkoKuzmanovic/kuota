import { validateProviderRecord } from "../../contract/validate.js";
import type { GrokDetails, GrokProviderRecord, UsageWindow } from "../../contract/schema-v1.js";

export type GrokUsageParseResult =
  | { readonly ok: true; readonly record: GrokProviderRecord & { readonly state: "ok" } }
  | { readonly ok: false; readonly reason: "malformed-response"; readonly status: "Provider unavailable" };

type PlainRecord = Record<string, unknown>;
const MISSING = Symbol("missing");
const INVALID = Symbol("invalid");

function isPlainRecord(value: unknown): value is PlainRecord {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value");
    });
  } catch {
    return false;
  }
}

function ownValue(record: PlainRecord, key: string): unknown | typeof MISSING {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor === undefined ? MISSING : descriptor.value;
}

function finiteCount(value: unknown): number | typeof INVALID | undefined {
  if (value === MISSING || value === null) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : INVALID;
}

function finitePercent(value: unknown): number | typeof INVALID | undefined {
  if (value === MISSING || value === null) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : INVALID;
}

function parseResetTimestamp(value: unknown): string | typeof INVALID | undefined {
  if (value === MISSING || value === null) return undefined;
  if (typeof value !== "string") return INVALID;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : INVALID;
}

function normalizeObservedAt(value: string): string | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function failure(): GrokUsageParseResult {
  return { ok: false, reason: "malformed-response", status: "Provider unavailable" };
}

function unwrapCount(value: unknown): number | typeof INVALID | undefined {
  if (value === MISSING || value === null) return undefined;
  if (!isPlainRecord(value)) return INVALID;
  return finiteCount(ownValue(value, "val"));
}


// Real wire shape (live-verified 2026-07-17, mirrors pi-hud providers/grok.ts):
// monthly { config: { monthlyLimit: {val}, used: {val}, billingPeriodEnd } };
// weekly  { config: { currentPeriod: {type}, creditUsagePercent, billingPeriodEnd } }.
function parseMonthlyUsage(input: PlainRecord): {
  readonly used: number | typeof INVALID | undefined;
  readonly limit: number | typeof INVALID | undefined;
  readonly resetAt: string | typeof INVALID | undefined;
} {
  const config = ownValue(input, "config");
  if (!isPlainRecord(config)) return { used: INVALID, limit: INVALID, resetAt: INVALID };

  const limit = unwrapCount(ownValue(config, "monthlyLimit"));
  const used = unwrapCount(ownValue(config, "used"));
  const resetAt = parseResetTimestamp(ownValue(config, "billingPeriodEnd"));
  return { used, limit, resetAt };
}

function parseWeeklyUsage(input: PlainRecord): {
  readonly applicable: boolean;
  readonly usedPercent: number | typeof INVALID | undefined;
  readonly resetAt: string | typeof INVALID | undefined;
} {
  const config = ownValue(input, "config");
  // Endpoint may omit the credit window entirely — not an error.
  if (!isPlainRecord(config)) return { applicable: false, usedPercent: undefined, resetAt: undefined };

  const currentPeriod = ownValue(config, "currentPeriod");
  const periodType = isPlainRecord(currentPeriod) ? ownValue(currentPeriod, "type") : MISSING;
  if (periodType !== "USAGE_PERIOD_TYPE_WEEKLY") {
    return { applicable: false, usedPercent: undefined, resetAt: undefined };
  }

  // creditUsagePercent is a raw number in config (unlike the val-wrapped monthly counters).
  const usedPercent = finitePercent(ownValue(config, "creditUsagePercent"));
  const resetAt = parseResetTimestamp(ownValue(config, "billingPeriodEnd"));
  return { applicable: true, usedPercent, resetAt };
}

/** Parses only approved Grok usage fields and builds a fresh validated record. */
export function parseGrokUsageResponse(input: unknown, observedAt: string): GrokUsageParseResult {
  try {
    if (!isPlainRecord(input)) return failure();
    const normalizedObservedAt = normalizeObservedAt(observedAt);
    if (normalizedObservedAt === undefined) return failure();

    const monthlyValue = ownValue(input, "monthly");
    const weeklyValue = ownValue(input, "weekly");
    if (
      (monthlyValue !== MISSING && monthlyValue !== null && !isPlainRecord(monthlyValue)) ||
      (weeklyValue !== MISSING && weeklyValue !== null && !isPlainRecord(weeklyValue))
    ) {
      return failure();
    }

    if (!isPlainRecord(monthlyValue)) return failure();
    const monthly = parseMonthlyUsage(monthlyValue);
    if (monthly.used === INVALID || monthly.limit === INVALID || monthly.resetAt === INVALID) {
      return failure();
    }
    // An ok record must carry real data; a recognized-nothing monthly payload is a
    // bad shape (matches pi-hud's "bad shape" error), not a dataless ok record.
    if (monthly.used === undefined && monthly.limit === undefined) return failure();

    const weekly = weeklyValue !== MISSING && weeklyValue !== null && isPlainRecord(weeklyValue)
      ? parseWeeklyUsage(weeklyValue)
      : undefined;

    if (
      weekly !== undefined &&
      weekly.applicable &&
      (weekly.usedPercent === INVALID || weekly.resetAt === INVALID)
    ) {
      return failure();
    }

    const details: GrokDetails = {
      ...(monthly.used !== undefined ? { monthlyUsed: monthly.used } : {}),
      ...(monthly.limit !== undefined ? { monthlyLimit: monthly.limit } : {}),
      ...(monthly.resetAt !== undefined ? { monthlyResetAt: monthly.resetAt } : {}),
    };
    const windows: UsageWindow[] = [];

    // Week first so compact's windows[0] primary shows the tighter 7d
    // credit window; month (30d) follows. Order is intentional product UX.
    if (weekly !== undefined && weekly.applicable && weekly.usedPercent !== undefined && weekly.usedPercent !== INVALID) {
      const weeklyWindow: UsageWindow = {
        id: "week",
        label: "7d",
        usedPercent: weekly.usedPercent,
        ...(weekly.resetAt !== undefined && weekly.resetAt !== INVALID
          ? { resetAt: weekly.resetAt }
          : {}),
      };
      windows.push(weeklyWindow);
    }

    const monthlyWindow: UsageWindow = {
      id: "month",
      label: "30d",
      ...(monthly.used !== undefined ? { used: monthly.used } : {}),
      ...(monthly.limit !== undefined ? { limit: monthly.limit } : {}),
      ...(monthly.used !== undefined && monthly.limit !== undefined && monthly.limit > 0
        ? { usedPercent: (monthly.used / monthly.limit) * 100 }
        : {}),
      ...(monthly.resetAt !== undefined ? { resetAt: monthly.resetAt } : {}),
    };
    windows.push(monthlyWindow);

    const record: GrokProviderRecord & { readonly state: "ok" } = {
      id: "grok",
      state: "ok",
      lastSuccessAt: normalizedObservedAt,
      windows,
      ...(Object.keys(details).length === 0 ? {} : { details: { grok: details } }),
    };

    const validation = validateProviderRecord(record);
    if (!validation.ok || validation.value.id !== "grok" || validation.value.state !== "ok") return failure();
    return { ok: true, record };
  } catch {
    return failure();
  }
}
