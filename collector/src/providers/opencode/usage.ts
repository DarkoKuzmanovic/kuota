import { validateProviderRecord } from "../../contract/validate.js";
import type { OpenCodeProviderRecord, UsageWindow } from "../../contract/schema-v1.js";

export type OpencodeUsageParseResult =
  | { readonly ok: true; readonly record: OpenCodeProviderRecord & { readonly state: "ok" } }
  | { readonly ok: false; readonly reason: "malformed-response"; readonly status: "Provider unavailable" };

type PlainRecord = Record<string, unknown>;
const MISSING = Symbol("missing");
const INVALID = Symbol("invalid");

// OpenCode Go reports three windows on every response; all are required for an
// ok record (same contract as the CLI's own parser).
const WINDOW_KEYS = ["rolling", "weekly", "monthly"] as const;
const WINDOW_LABELS: Readonly<Record<(typeof WINDOW_KEYS)[number], string>> = {
  rolling: "5h",
  weekly: "Weekly",
  monthly: "Monthly",
};

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

function parsePercent(value: unknown): number | typeof INVALID | undefined {
  if (value === MISSING || value === null) return undefined;
  if (typeof value !== "number" && typeof value !== "string") return INVALID;
  if (typeof value === "string" && value.length === 0) return INVALID;
  const parsed = typeof value === "number" ? value : Number(value);
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0 || parsed > 100) return INVALID;
  return parsed;
}

/** Accepts offset-qualified ISO timestamps (Z or ±hh:mm) and normalizes to UTC ISO 8601. */
function parseResetTimestamp(value: unknown): string | typeof INVALID | undefined {
  if (value === MISSING || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) return INVALID;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return INVALID;
  if (Number.isNaN(new Date(time).getTime())) return INVALID;
  return new Date(time).toISOString();
}

function normalizeObservedAt(value: string): string | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function windowFrom(
  key: (typeof WINDOW_KEYS)[number],
  window: PlainRecord,
): UsageWindow | typeof INVALID {
  const status = ownValue(window, "status");
  if (status !== "ok") return INVALID;
  const percent = parsePercent(ownValue(window, "percent"));
  const resetAt = parseResetTimestamp(ownValue(window, "resetsAt"));
  if (percent === INVALID || resetAt === INVALID) return INVALID;
  // The OpenCode Go wire always carries resetsAt (it drives the reset countdown).
  if (percent === undefined || resetAt === undefined) return INVALID;
  const usageWindow: UsageWindow = {
    id: key,
    label: WINDOW_LABELS[key],
    usedPercent: percent,
    ...(resetAt === undefined ? {} : { resetAt }),
  };
  return usageWindow;
}

function failure(): OpencodeUsageParseResult {
  return { ok: false, reason: "malformed-response", status: "Provider unavailable" };
}

/** Parses only approved OpenCode Go usage fields and builds a fresh validated windows-only record. */
export function parseOpencodeUsageResponse(input: unknown, observedAt: string): OpencodeUsageParseResult {
  try {
    if (!isPlainRecord(input)) return failure();
    const normalizedObservedAt = normalizeObservedAt(observedAt);
    if (normalizedObservedAt === undefined) return failure();

    const usageValue = ownValue(input, "usage");
    if (!isPlainRecord(usageValue)) return failure();

    const windows: UsageWindow[] = [];
    for (const key of WINDOW_KEYS) {
      const windowValue = ownValue(usageValue, key);
      if (!isPlainRecord(windowValue)) return failure();
      const parsed = windowFrom(key, windowValue);
      if (parsed === INVALID) return failure();
      windows.push(parsed);
    }

    const record: OpenCodeProviderRecord & { readonly state: "ok" } = {
      id: "opencode",
      state: "ok",
      lastSuccessAt: normalizedObservedAt,
      windows,
    };

    const validation = validateProviderRecord(record);
    if (!validation.ok || validation.value.id !== "opencode" || validation.value.state !== "ok") return failure();
    return { ok: true, record };
  } catch {
    return failure();
  }
}
