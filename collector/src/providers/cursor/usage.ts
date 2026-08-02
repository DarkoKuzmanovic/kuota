import { validateProviderRecord } from "../../contract/validate.js";
import type { CursorDetails, CursorProviderRecord, UsageWindow } from "../../contract/schema-v1.js";

export type CursorUsageParseResult =
  | { readonly ok: true; readonly record: CursorProviderRecord & { readonly state: "ok" } }
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
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return INVALID;
  const truncated = Math.trunc(value);
  return Number.isSafeInteger(truncated) ? truncated : INVALID;
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

function parseMembershipType(value: unknown): string | typeof INVALID | undefined {
  if (value === MISSING || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 100) return INVALID;
  if (/[\u0000-\u001f\u007f]/.test(value)) return INVALID;
  return value;
}

function normalizeObservedAt(value: string): string | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function failure(): CursorUsageParseResult {
  return { ok: false, reason: "malformed-response", status: "Provider unavailable" };
}

function usageWindow(
  used: number | typeof INVALID | undefined,
  limit: number | typeof INVALID | undefined,
  resetAt: string | typeof INVALID | undefined,
): UsageWindow | typeof INVALID | undefined {
  if (used === INVALID || limit === INVALID || resetAt === INVALID) return INVALID;
  if (used === undefined && limit === undefined) return undefined;
  if (used !== undefined && limit !== undefined && used > limit) return INVALID;
  const usedPercent = used !== undefined && limit !== undefined && limit > 0 ? (used / limit) * 100 : undefined;
  return {
    id: "plan",
    label: "Plan",
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

/** Parses only approved Cursor usage-summary fields and builds a fresh validated record. */
export function parseCursorUsageResponse(input: unknown, observedAt: string): CursorUsageParseResult {
  try {
    if (!isPlainRecord(input)) return failure();
    const normalizedObservedAt = normalizeObservedAt(observedAt);
    if (normalizedObservedAt === undefined) return failure();

    const individualUsageValue = ownValue(input, "individualUsage");
    if (individualUsageValue !== MISSING && individualUsageValue !== null && !isPlainRecord(individualUsageValue)) {
      return failure();
    }
    const individualUsage = isPlainRecord(individualUsageValue) ? individualUsageValue : undefined;
    const planValue = individualUsage === undefined ? MISSING : ownValue(individualUsage, "plan");
    const onDemandValue = individualUsage === undefined ? MISSING : ownValue(individualUsage, "onDemand");
    if ((planValue !== MISSING && planValue !== null && !isPlainRecord(planValue)) ||
      (onDemandValue !== MISSING && onDemandValue !== null && !isPlainRecord(onDemandValue))) {
      return failure();
    }

    const plan = isPlainRecord(planValue) ? planValue : undefined;
    const onDemand = isPlainRecord(onDemandValue) ? onDemandValue : undefined;

    const used = finiteCount(plan === undefined ? undefined : ownValue(plan, "used"));
    const limit = finiteCount(plan === undefined ? undefined : ownValue(plan, "limit"));
    const resetAt = parseResetTimestamp(ownValue(input, "billingCycleEnd"));
    const membershipType = parseMembershipType(ownValue(input, "membershipType"));
    const autoPercentUsed = finitePercent(plan === undefined ? undefined : ownValue(plan, "autoPercentUsed"));
    const apiPercentUsed = finitePercent(plan === undefined ? undefined : ownValue(plan, "apiPercentUsed"));
    const totalPercentUsed = finitePercent(plan === undefined ? undefined : ownValue(plan, "totalPercentUsed"));

    const onDemandEnabled = onDemand === undefined ? false : ownValue(onDemand, "enabled") === true;
    const onDemandUsed = onDemandEnabled
      ? finiteCount(ownValue(onDemand ?? {}, "used"))
      : undefined;
    const onDemandLimitValue = onDemandEnabled ? ownValue(onDemand ?? {}, "limit") : MISSING;
    const onDemandLimit = onDemandLimitValue === null || onDemandLimitValue === MISSING
      ? undefined
      : finiteCount(onDemandLimitValue);

    if (used === INVALID || limit === INVALID || resetAt === INVALID || membershipType === INVALID ||
      autoPercentUsed === INVALID || apiPercentUsed === INVALID || totalPercentUsed === INVALID ||
      onDemandUsed === INVALID || onDemandLimit === INVALID) {
      return failure();
    }

    const planWindow = usageWindow(used, limit, resetAt);
    if (planWindow === INVALID) return failure();

    const details: CursorDetails = {
      ...(membershipType === undefined ? {} : { membershipType }),
      ...(onDemandUsed === undefined ? {} : { onDemandUsed }),
      ...(onDemandLimit === undefined ? {} : { onDemandLimit }),
      ...(autoPercentUsed === undefined ? {} : { autoPercentUsed }),
      ...(apiPercentUsed === undefined ? {} : { apiPercentUsed }),
      ...(totalPercentUsed === undefined ? {} : { totalPercentUsed }),
    };

    const windows: UsageWindow[] = [];
    if (planWindow !== undefined) windows.push(planWindow);

    if (windows.length === 0 && Object.keys(details).length === 0) return failure();

    const record: CursorProviderRecord & { readonly state: "ok" } = {
      id: "cursor",
      state: "ok",
      lastSuccessAt: normalizedObservedAt,
      ...(windows.length === 0 ? {} : { windows }),
      ...(Object.keys(details).length === 0 ? {} : { details: { cursor: details } }),
    };

    const validation = validateProviderRecord(record);
    if (!validation.ok || validation.value.id !== "cursor" || validation.value.state !== "ok") return failure();
    return { ok: true, record };
  } catch {
    return failure();
  }
}
