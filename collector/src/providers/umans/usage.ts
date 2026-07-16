import { validateProviderRecord } from "../../contract/validate.js";
import type { UmansDetails, UmansProviderRecord, UsageWindow } from "../../contract/schema-v1.js";

export type UmansUsageParseResult =
  | { readonly ok: true; readonly record: UmansProviderRecord & { readonly state: "ok" } }
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
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : INVALID;
}

function timestampFromEpoch(value: unknown): string | typeof INVALID | undefined {
  if (value === MISSING || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return INVALID;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : INVALID;
}

function normalizeObservedAt(value: string): string | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function failure(): UmansUsageParseResult {
  return { ok: false, reason: "malformed-response", status: "Provider unavailable" };
}

/** Parses only approved Umans usage fields and builds a fresh validated record. */
export function parseUmansUsageResponse(input: unknown, observedAt: string): UmansUsageParseResult {
  try {
    if (!isPlainRecord(input)) return failure();
    const normalizedObservedAt = normalizeObservedAt(observedAt);
    if (normalizedObservedAt === undefined) return failure();

    const limitsValue = ownValue(input, "limits");
    const windowValue = ownValue(input, "window");
    const usageValue = ownValue(input, "usage");
    if ((limitsValue !== MISSING && limitsValue !== null && !isPlainRecord(limitsValue)) ||
      (windowValue !== MISSING && windowValue !== null && !isPlainRecord(windowValue)) ||
      (usageValue !== MISSING && usageValue !== null && !isPlainRecord(usageValue))) return failure();
    const limits = isPlainRecord(limitsValue) ? limitsValue : undefined;
    const window = isPlainRecord(windowValue) ? windowValue : undefined;
    const usage = isPlainRecord(usageValue) ? usageValue : undefined;

    const requestsLimitObject = limits === undefined ? undefined : ownValue(limits, "requests");
    const concurrencyLimitObject = limits === undefined ? undefined : ownValue(limits, "concurrency");
    if ((requestsLimitObject !== MISSING && requestsLimitObject !== null && !isPlainRecord(requestsLimitObject)) ||
      (concurrencyLimitObject !== MISSING && concurrencyLimitObject !== null && !isPlainRecord(concurrencyLimitObject))) return failure();
    const requestLimit = isPlainRecord(requestsLimitObject) ? finiteCount(ownValue(requestsLimitObject, "limit")) : undefined;
    const windowSeconds = isPlainRecord(requestsLimitObject) ? finiteCount(ownValue(requestsLimitObject, "window_seconds")) : undefined;
    const concurrencyLimit = isPlainRecord(concurrencyLimitObject) ? finiteCount(ownValue(concurrencyLimitObject, "limit")) : undefined;
    const requests = usage === undefined ? undefined : finiteCount(ownValue(usage, "requests_in_window"));
    const concurrency = usage === undefined ? undefined : finiteCount(ownValue(usage, "concurrent_sessions"));
    const resetAt = window === undefined ? undefined : timestampFromEpoch(ownValue(window, "resets_at"));
    const remainingMinutes = window === undefined ? undefined : finiteCount(ownValue(window, "remaining_minutes"));
    if (
      requestLimit === INVALID ||
      windowSeconds === INVALID ||
      concurrencyLimit === INVALID ||
      requests === INVALID ||
      concurrency === INVALID ||
      resetAt === INVALID ||
      remainingMinutes === INVALID
    ) return failure();
    if (windowSeconds === 0) return failure();
    if (requestLimit !== undefined && requests !== undefined && requests > requestLimit) return failure();

    let requestResetAt = resetAt;
    if (requestResetAt === undefined && remainingMinutes !== undefined) {
      requestResetAt = new Date(Date.parse(normalizedObservedAt) + remainingMinutes * 60_000).toISOString();
    }
    const details: UmansDetails = {
      ...(requests === undefined ? {} : { requests }),
      ...(concurrency === undefined ? {} : { concurrency }),
      ...(concurrencyLimit === undefined ? {} : { concurrencyLimit }),
    };
    const requestWindow: UsageWindow | undefined = requests === undefined ? undefined : {
      id: "requests",
      label: "Requests",
      used: requests,
      ...(requestLimit === undefined ? {} : { limit: requestLimit, usedPercent: (requests / requestLimit) * 100 }),
      ...(requestResetAt === undefined ? {} : { resetAt: requestResetAt }),
    };
    if (requestWindow === undefined && Object.keys(details).length === 0) return failure();
    const record: UmansProviderRecord & { readonly state: "ok" } = {
      id: "umans",
      state: "ok",
      lastSuccessAt: normalizedObservedAt,
      ...(requestWindow === undefined ? {} : { windows: [requestWindow] }),
      ...(Object.keys(details).length === 0 ? {} : { details: { umans: details } }),
    };
    const validation = validateProviderRecord(record);
    if (!validation.ok || validation.value.id !== "umans" || validation.value.state !== "ok") return failure();
    return { ok: true, record };
  } catch {
    return failure();
  }
}
