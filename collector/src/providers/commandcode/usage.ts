import { validateProviderRecord } from "../../contract/validate.js";
import type { CommandCodeDetails, CommandCodeProviderRecord, UsageWindow } from "../../contract/schema-v1.js";

export type CommandCodeUsageParseResult =
  | { readonly ok: true; readonly record: CommandCodeProviderRecord & { readonly state: "ok" } }
  | { readonly ok: false; readonly reason: "malformed-response"; readonly status: "Provider unavailable" };

/** Closed plan-id map (live-verified 2026-08-12); unknown plans yield no name. */
const PLAN_NAMES: Readonly<Record<string, string>> = {
  "individual-go": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-max10x": "Max10x",
};

export function commandCodePlanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return PLAN_NAMES[value];
}

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
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor === undefined ? MISSING : descriptor.value;
  } catch {
    return MISSING;
  }
}

function finiteCount(value: unknown): number | typeof INVALID | undefined {
  if (value === MISSING || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) return INVALID;
  return parsed;
}

/** Epoch-millisecond reset timestamps normalize to UTC ISO 8601. */
function parseResetAt(value: unknown): string | typeof INVALID | undefined {
  if (value === MISSING || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) return INVALID;
  const date = new Date(parsed);
  if (Number.isNaN(date.getTime())) return INVALID;
  return date.toISOString();
}

function truthyBoolean(value: unknown): boolean | typeof INVALID | undefined {
  if (value === MISSING || value === null) return undefined;
  if (typeof value !== "boolean") return INVALID;
  return value;
}

function normalizeObservedAt(value: string): string | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

type CommandCodeRow = {
  used: number | typeof INVALID | undefined;
  limit: number | typeof INVALID | undefined;
  resetAt: string | typeof INVALID | undefined;
};

function parseRow(record: PlainRecord | undefined): CommandCodeRow {
  if (record === undefined) return { used: undefined, limit: undefined, resetAt: undefined };
  return {
    used: finiteCount(ownValue(record, "used")),
    limit: finiteCount(ownValue(record, "cap")),
    resetAt: parseResetAt(ownValue(record, "resetAt")),
  };
}

function failure(): CommandCodeUsageParseResult {
  return { ok: false, reason: "malformed-response", status: "Provider unavailable" };
}

/** Builds a window whose percent is clamped to 100; used > limit is allowed (exceeded windows). */
function usageWindow(
  id: string,
  label: string,
  row: { used: number | typeof INVALID | undefined; limit: number | typeof INVALID | undefined; resetAt: string | typeof INVALID | undefined },
): UsageWindow | typeof INVALID {
  if (row.used === INVALID || row.limit === INVALID || row.resetAt === INVALID) return INVALID;
  const used = row.used;
  const limit = row.limit;
  if (used === undefined || limit === undefined) return INVALID;
  const usedPercent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const resetAt = row.resetAt;
  return {
    id,
    label,
    used,
    limit,
    usedPercent,
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

/**
 * Parses only approved CommandCode credits fields and builds a fresh validated
 * record. `planName` (from the optional subscriptions call) is merged when
 * non-empty; it can never fail the record.
 */
export function parseCommandCodeUsageResponse(input: unknown, observedAt: string, planName?: string): CommandCodeUsageParseResult {
  try {
    if (!isPlainRecord(input)) return failure();
    const normalizedObservedAt = normalizeObservedAt(observedAt);
    if (normalizedObservedAt === undefined) return failure();

    const creditsValue = ownValue(input, "credits");
    const windowLimitsValue = ownValue(input, "windowLimits");
    if (!isPlainRecord(creditsValue) || !isPlainRecord(windowLimitsValue)) return failure();

    const fiveHourValue = ownValue(windowLimitsValue, "fiveHour");
    const weeklyValue = ownValue(windowLimitsValue, "weekly");
    if (!isPlainRecord(fiveHourValue)) return failure();
    const weekly = isPlainRecord(weeklyValue) ? weeklyValue : undefined;

    const fiveHourRow = parseRow(fiveHourValue);
    const weeklyRow = parseRow(weekly);
    // Design: the five-hour window is required (used+cap finite); anything
    // else in the row (e.g. resetAt garbage) is dropped, never fatal.
    if (fiveHourRow.used === INVALID || fiveHourRow.limit === INVALID) return failure();
    if (fiveHourRow.resetAt === INVALID) fiveHourRow.resetAt = undefined;

    // Design: the weekly window participates only when both used and cap are
    // finite; malformed weekly data is ignored, not fatal.
    const weekUsable = weekly !== undefined && weeklyRow.used !== INVALID && weeklyRow.limit !== INVALID;
    if (weekUsable && weeklyRow.resetAt === INVALID) weeklyRow.resetAt = undefined;

    const monthlyCredits = finiteCount(ownValue(creditsValue, "monthlyCredits"));
    const purchasedCredits = finiteCount(ownValue(creditsValue, "purchasedCredits"));
    const freeCredits = finiteCount(ownValue(creditsValue, "freeCredits"));
    const exceeded = truthyBoolean(ownValue(windowLimitsValue, "exceeded")) ?? truthyBoolean(ownValue(fiveHourValue, "exceeded"));
    const weeklyExceeded = weekUsable ? truthyBoolean(ownValue(weekly ?? {}, "exceeded")) : undefined;

    const windows: UsageWindow[] = [];
    const fiveHourWindow = usageWindow("fiveHour", "5h", fiveHourRow);
    if (fiveHourWindow === INVALID) return failure();
    windows.push(fiveHourWindow);
    if (weekUsable) {
      const weeklyWindow = usageWindow("weekly", "Weekly", weeklyRow);
      if (weeklyWindow === INVALID) return failure();
      windows.push(weeklyWindow);
    }

    // Garbage credential counts and flags are omitted, never fatal (design):
    const details: CommandCodeDetails = {
      ...(monthlyCredits === INVALID ? {} : { monthlyCredits: monthlyCredits === undefined ? undefined : monthlyCredits }),
      ...(purchasedCredits === INVALID ? {} : { purchasedCredits: purchasedCredits === undefined ? undefined : purchasedCredits }),
      ...(freeCredits === INVALID ? {} : { freeCredits: freeCredits === undefined ? undefined : freeCredits }),
      ...(planName !== undefined && planName.length > 0 ? { planName } : {}),
      ...(exceeded === INVALID ? {} : { exceeded: exceeded === undefined ? undefined : exceeded }),
      ...(weeklyExceeded === INVALID ? {} : { weeklyExceeded: weeklyExceeded === undefined ? undefined : weeklyExceeded }),
    };

    const record: CommandCodeProviderRecord & { readonly state: "ok" } = {
      id: "commandcode",
      state: "ok",
      lastSuccessAt: normalizedObservedAt,
      windows,
      ...(Object.keys(details).length === 0 ? {} : { details: { commandcode: details } }),
    };

    const validation = validateProviderRecord(record);
    if (!validation.ok || validation.value.id !== "commandcode" || validation.value.state !== "ok") return failure();
    return { ok: true, record };
  } catch {
    return failure();
  }
}
