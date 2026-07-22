import { validateProviderRecord } from "../../contract/validate.js";
import type { KimiDetails, KimiProviderRecord, UsageWindow } from "../../contract/schema-v1.js";

export type KimiUsageParseResult =
  | { readonly ok: true; readonly record: KimiProviderRecord & { readonly state: "ok" } }
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
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : INVALID;
}

function parseResetTimestamp(value: unknown): string | typeof INVALID | undefined {
  if (value === MISSING || value === null || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return INVALID;
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : INVALID;
  }
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : INVALID;
  }
  return INVALID;
}

function normalizeObservedAt(value: string): string | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function windowMinutes(window: PlainRecord | undefined): number | null | typeof INVALID {
  if (window === undefined) return null;
  const duration = ownValue(window, "duration");
  if (duration === MISSING) return null;
  const durationValue = finiteCount(duration);
  if (durationValue === INVALID) return INVALID;
  if (durationValue === undefined) return null;
  const unit = String(ownValue(window, "timeUnit") ?? "").toUpperCase();
  if (unit.includes("HOUR")) return durationValue * 60;
  if (unit.includes("MINUTE")) return durationValue;
  if (unit.includes("DAY")) return durationValue * 1440;
  return null;
}

function windowLabelFromMinutes(minutes: number | null): string {
  if (minutes === null) return "5h";
  if (minutes >= 43_200) return "month";
  if (minutes >= 10_080) return "week";
  if (minutes >= 1_440) return "daily";
  return "5h";
}

function failure(): KimiUsageParseResult {
  return { ok: false, reason: "malformed-response", status: "Provider unavailable" };
}

function parseRow(row: PlainRecord | undefined): {
  used: number | typeof INVALID | undefined;
  limit: number | typeof INVALID | undefined;
  resetAt: string | typeof INVALID | undefined;
} {
  if (row === undefined) return { used: undefined, limit: undefined, resetAt: undefined };
  const used = finiteCount(ownValue(row, "used"));
  const limit = finiteCount(ownValue(row, "limit"));
  const remaining = finiteCount(ownValue(row, "remaining"));
  const usedValue = used ?? (limit !== undefined && limit !== INVALID && remaining !== undefined && remaining !== INVALID ? limit - remaining : undefined);
  const resetAt = parseResetTimestamp(ownValue(row, "resetTime"));
  return { used: usedValue, limit, resetAt };
}

function usageWindow(
  id: string,
  label: string,
  row: { used: number | typeof INVALID | undefined; limit: number | typeof INVALID | undefined; resetAt: string | typeof INVALID | undefined },
): UsageWindow | typeof INVALID | undefined {
  if (row.used === INVALID || row.limit === INVALID || row.resetAt === INVALID) return INVALID;
  if (row.used === undefined && row.limit === undefined) return undefined;
  const used = row.used;
  const limit = row.limit;
  if (used !== undefined && limit !== undefined && used > limit) return INVALID;
  const usedPercent = used !== undefined && limit !== undefined && limit > 0 ? (used / limit) * 100 : undefined;
  const resetAt = row.resetAt;
  if (used === undefined && limit === undefined) return undefined;
  return {
    id,
    label,
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

function extractShortRow(limitsEntry: unknown): { row: PlainRecord | undefined; window: PlainRecord | undefined } {
  if (!isPlainRecord(limitsEntry)) return { row: undefined, window: undefined };
  const detailValue = ownValue(limitsEntry, "detail");
  const detail = isPlainRecord(detailValue) ? detailValue : undefined;
  const windowValue = ownValue(limitsEntry, "window");
  const window = isPlainRecord(windowValue) ? windowValue : undefined;
  return { row: detail, window };
}

/** Parses only approved Kimi usage fields and builds a fresh validated record. */
export function parseKimiUsageResponse(input: unknown, observedAt: string): KimiUsageParseResult {
  try {
    if (!isPlainRecord(input)) return failure();
    const normalizedObservedAt = normalizeObservedAt(observedAt);
    if (normalizedObservedAt === undefined) return failure();

    const usageValue = ownValue(input, "usage");
    const limitsValue = ownValue(input, "limits");
    const parallelValue = ownValue(input, "parallel");

    if ((usageValue !== MISSING && usageValue !== null && !isPlainRecord(usageValue)) ||
      (limitsValue !== MISSING && limitsValue !== null && !Array.isArray(limitsValue)) ||
      (parallelValue !== MISSING && parallelValue !== null && !isPlainRecord(parallelValue))) return failure();

    const usage = isPlainRecord(usageValue) ? usageValue : undefined;
    const limits = Array.isArray(limitsValue) ? limitsValue : undefined;
    const parallel = isPlainRecord(parallelValue) ? parallelValue : undefined;

    if (usage === undefined && parallel === undefined) return failure();

    const week = parseRow(usage);
    const shortEntry = limits?.[0];
    const { row: shortRow, window: shortWindowRecord } = extractShortRow(shortEntry);
    const short = parseRow(shortRow);
    const shortMinutes = windowMinutes(shortWindowRecord);
    if (shortMinutes === INVALID) return failure();
    const shortLabel = windowLabelFromMinutes(shortMinutes);

    const concurrencyLimit = finiteCount(ownValue(parallel ?? {}, "limit"));
    const detailsValue = ownValue(parallel ?? {}, "details");
    // concurrency is a real measurement only when `details` is an array; absent
    // details means unknown, not zero (contract: never infer zeroes).
    const concurrencyUsed = Array.isArray(detailsValue) ? detailsValue.length : undefined;

    if (week.used === INVALID || week.limit === INVALID || week.resetAt === INVALID ||
      short.used === INVALID || short.limit === INVALID || short.resetAt === INVALID ||
      concurrencyLimit === INVALID) return failure();

    const weekWindow = usageWindow("week", "Week", week);
    const shortUsageWindow = usageWindow(shortLabel, shortLabel, short);
    if (weekWindow === INVALID || shortUsageWindow === INVALID) return failure();

    const windows: UsageWindow[] = [];
    if (weekWindow !== undefined) windows.push(weekWindow);
    if (shortUsageWindow !== undefined) windows.push(shortUsageWindow);

    const details: KimiDetails = {
      ...(concurrencyLimit === undefined ? {} : { concurrencyLimit }),
      ...(concurrencyUsed === undefined ? {} : { concurrency: concurrencyUsed }),
    };

    if (windows.length === 0 && Object.keys(details).length === 0) return failure();

    const record: KimiProviderRecord & { readonly state: "ok" } = {
      id: "kimi",
      state: "ok",
      lastSuccessAt: normalizedObservedAt,
      ...(windows.length === 0 ? {} : { windows }),
      ...(Object.keys(details).length === 0 ? {} : { details: { kimi: details } }),
    };

    const validation = validateProviderRecord(record);
    if (!validation.ok || validation.value.id !== "kimi" || validation.value.state !== "ok") return failure();
    return { ok: true, record };
  } catch {
    return failure();
  }
}
