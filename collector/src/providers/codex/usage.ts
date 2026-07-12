import { validateProviderRecord } from "../../contract/validate.js";
import type {
  CodexDetails,
  CodexProviderRecord,
  ProviderRecord,
  UsageWindow,
} from "../../contract/schema-v1.js";

export const CODEX_USAGE_STATUS_TEXT = "Provider unavailable" as const;
export const CODEX_USAGE_FAILURE_REASON = "malformed-response" as const;

export type CodexUsageSuccessRecord = CodexProviderRecord & {
  readonly state: "ok";
};

export type CodexUsageParseResult =
  | { readonly ok: true; readonly record: CodexUsageSuccessRecord }
  | {
      readonly ok: false;
      readonly reason: typeof CODEX_USAGE_FAILURE_REASON;
      readonly status: typeof CODEX_USAGE_STATUS_TEXT;
    };

type PlainRecord = Record<string, unknown>;
type ParsedWindow = { readonly window?: UsageWindow };

const MISSING = Symbol("missing");
const INVALID = Symbol("invalid");
const MAX_OBJECT_KEYS = 2_000;
const MAX_ARRAY_LENGTH = 1_000;
const UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const STRICT_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Parses only the approved Codex usage response fields and builds a fresh,
 * schema-validated record. Raw provider objects are never retained.
 */
export function parseCodexUsageResponse(
  input: unknown,
  observedAt: string,
): CodexUsageParseResult {
  try {
    const normalizedObservedAt =
      typeof observedAt === "string" ? normalizeTimestamp(observedAt) : undefined;
    if (
      !isSafeJsonGraph(input) ||
      !hasSafeDataKeys(input) ||
      !isPlainRecord(input) ||
      normalizedObservedAt === undefined
    ) {
      return failure();
    }

    const parsed = parseResponse(input);
    if (parsed === undefined) return failure();

    const record: CodexProviderRecord = {
      id: "codex",
      state: "ok",
      lastSuccessAt: normalizedObservedAt,
      ...(parsed.windows.length === 0 ? {} : { windows: parsed.windows }),
      ...(parsed.details === undefined ? {} : { details: { codex: parsed.details } }),
    };
    const validation = validateProviderRecord(record);
    if (!validation.ok || !isCodexOkRecord(validation.value)) return failure();
    return { ok: true, record: validation.value };
  } catch {
    return failure();
  }
}

function parseResponse(
  input: PlainRecord,
): { readonly windows: readonly UsageWindow[]; readonly details?: CodexDetails } | undefined {
  const windows = parseRateLimit(ownValue(input, "rate_limit"));
  if (windows === undefined) return undefined;

  const details = parseDetails(input);
  if (windows.length === 0 && details === undefined) return undefined;
  return { windows, ...(details === undefined ? {} : { details }) };
}

function parseRateLimit(
  value: unknown | typeof MISSING,
): readonly UsageWindow[] | undefined {
  if (value === MISSING || value === null) return [];
  if (!isPlainRecord(value)) return undefined;

  const windows: UsageWindow[] = [];
  for (const [key, id, label] of [
    ["primary_window", "primary", "Primary"],
    ["secondary_window", "secondary", "Secondary"],
  ] as const) {
    const parsed = parseWindow(ownValue(value, key), id, label);
    if (parsed === undefined) return undefined;
    if (parsed.window !== undefined) windows.push(parsed.window);
  }
  return windows;
}

function parseWindow(
  value: unknown | typeof MISSING,
  id: string,
  label: string,
): ParsedWindow | undefined {
  if (value === MISSING || value === null) return {};
  if (!isPlainRecord(value)) return undefined;

  const usedPercent = parseOptionalPercent(value, "used_percent");
  const resetAt = parseOptionalEpochSeconds(value, "reset_at");
  const limitWindowSeconds = parseOptionalWindowSeconds(value, "limit_window_seconds");
  if (usedPercent === INVALID || resetAt === INVALID || limitWindowSeconds === INVALID) {
    return undefined;
  }
  if (usedPercent === undefined && resetAt === undefined) return {};
  return {
    window: {
      id,
      label,
      ...(typeof usedPercent === "number" ? { usedPercent } : {}),
      ...(typeof resetAt === "string" ? { resetAt } : {}),
    },
  };
}

function parseDetails(input: PlainRecord): CodexDetails | undefined {
  const plan = parsePlan(ownValue(input, "plan_type"));
  const credits = parseCredits(ownValue(input, "credits"));
  const cost = parseCost(ownValue(input, "spend_control"));
  const details: CodexDetails = {
    ...(typeof plan === "string" ? { plan } : {}),
    ...(typeof credits === "number" ? { credits } : {}),
    ...(typeof cost === "number" ? { cost } : {}),
  };
  return Object.keys(details).length === 0 ? undefined : details;
}

function parsePlan(value: unknown | typeof MISSING): string | undefined {
  if (typeof value !== "string" || CONTROL_CHARS.test(value)) return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    normalized.length === 0 ||
    normalized.length > 100 ||
    looksLikeCredentialText(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function parseCredits(value: unknown | typeof MISSING): number | undefined {
  if (!isPlainRecord(value)) return undefined;
  const hasCredits = ownValue(value, "has_credits");
  const unlimited = ownValue(value, "unlimited");
  if (hasCredits !== true || unlimited !== false) return undefined;
  return parseStrictDecimal(ownValue(value, "balance"));
}

function parseCost(value: unknown | typeof MISSING): number | undefined {
  if (!isPlainRecord(value)) return undefined;
  const individualLimit = ownValue(value, "individual_limit");
  if (!isPlainRecord(individualLimit)) return undefined;
  return parseStrictDecimal(ownValue(individualLimit, "used"));
}

function parseStrictDecimal(value: unknown | typeof MISSING): number | undefined {
  if (typeof value !== "string" || !STRICT_DECIMAL.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalPercent(
  input: PlainRecord,
  key: string,
): number | typeof INVALID | undefined {
  if (!hasOwn(input, key)) return undefined;
  const value = ownValue(input, key);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    return INVALID;
  }
  return value;
}

function parseOptionalWindowSeconds(
  input: PlainRecord,
  key: string,
): number | typeof INVALID | undefined {
  if (!hasOwn(input, key)) return undefined;
  const value = ownValue(input, key);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return INVALID;
  }
  return value;
}

function parseOptionalEpochSeconds(
  input: PlainRecord,
  key: string,
): string | typeof INVALID | undefined {
  if (!hasOwn(input, key)) return undefined;
  const value = ownValue(input, key);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) return INVALID;
  try {
    const timestamp = new Date(value * 1_000);
    return Number.isNaN(timestamp.getTime()) ? INVALID : timestamp.toISOString();
  } catch {
    return INVALID;
  }
}

function normalizeTimestamp(value: string): string | undefined {
  const match = UTC_TIMESTAMP.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8];
  const maxDay = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (
    month < 1 || month > 12 || day < 1 || day > maxDay || hour > 23 ||
    minute > 59 || second > 59 || offset === undefined
  ) return undefined;
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  try {
    return new Date(parsed).toISOString();
  } catch {
    return undefined;
  }
}

function looksLikeCredentialText(value: string): boolean {
  return (
    /bearer\s+[a-z0-9._~+/=-]+/i.test(value) ||
    /(?:sk-(?:ant|proj|live)-[a-z0-9_-]{8,}|sk-[a-z0-9]{8,}|AIza[a-z0-9_-]{20,})/i.test(value) ||
    /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/.test(value) ||
    /eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/i.test(value) ||
    /(?:access[_-]?token|refresh[_-]?token|api[_-]?key)\s*[:=]/i.test(value)
  );
}

function hasSafeDataKeys(root: unknown): boolean {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== "object") return true;
    if (seen.has(value)) return false;
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.every((entry) => visit(entry));
      if (!isPlainRecord(value)) return false;
      for (const key of Object.keys(value)) {
        if (isSensitiveKey(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          return false;
        }
        if (!visit(descriptor.value)) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  return visit(root);
}

function isSensitiveKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    compact === "authorization" ||
    compact === "accesstoken" ||
    compact === "refreshtoken" ||
    compact === "apikey" ||
    compact === "password" ||
    compact === "secret"
  );
}

function ownValue(input: PlainRecord, key: string): unknown | typeof MISSING {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor === undefined ? MISSING : descriptor.value;
  } catch {
    return MISSING;
  }
}

function hasOwn(input: PlainRecord, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(input, key);
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is PlainRecord {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isSafeJsonGraph(root: unknown): boolean {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): boolean => {
    if (value === null) return true;
    if (typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Array.prototype) return false;
        const names = Object.getOwnPropertyNames(value);
        if (names.length > MAX_ARRAY_LENGTH + 1) return false;
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (
          lengthDescriptor === undefined ||
          !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value") ||
          typeof lengthDescriptor.value !== "number" ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value > MAX_ARRAY_LENGTH
        ) return false;
        for (const name of names) {
          if (name === "length") continue;
          if (!/^\d+$/.test(name)) return false;
          const index = Number(name);
          if (index >= lengthDescriptor.value || String(index) !== name) return false;
          const descriptor = Object.getOwnPropertyDescriptor(value, name);
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
            !visit(descriptor.value)
          ) return false;
        }
        return names.length === lengthDescriptor.value + 1;
      }
      if (!isPlainRecord(value)) return false;
      const keys = Reflect.ownKeys(value);
      if (keys.length > MAX_OBJECT_KEYS) return false;
      for (const key of keys) {
        if (typeof key !== "string") return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          !visit(descriptor.value)
        ) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  return visit(root);
}

function isCodexOkRecord(record: ProviderRecord): record is CodexUsageSuccessRecord {
  return record.id === "codex" && record.state === "ok";
}

function failure(): CodexUsageParseResult {
  return {
    ok: false,
    reason: CODEX_USAGE_FAILURE_REASON,
    status: CODEX_USAGE_STATUS_TEXT,
  };
}
