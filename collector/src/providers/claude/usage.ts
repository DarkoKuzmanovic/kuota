import { validateProviderRecord } from "../../contract/validate.js";
import type {
  ClaudeDetails,
  ClaudeProviderRecord,
  ProviderRecord,
  UsageWindow,
} from "../../contract/schema-v1.js";

export const CLAUDE_USAGE_STATUS_TEXT = "Provider unavailable" as const;
export const CLAUDE_USAGE_FAILURE_REASON = "malformed-response" as const;

export type ClaudeUsageSuccessRecord = ClaudeProviderRecord & {
  readonly state: "ok";
};

export type ClaudeUsageParseResult =
  | {
      readonly ok: true;
      readonly record: ClaudeUsageSuccessRecord;
    }
  | {
      readonly ok: false;
      readonly reason: typeof CLAUDE_USAGE_FAILURE_REASON;
      readonly status: typeof CLAUDE_USAGE_STATUS_TEXT;
    };

type PlainRecord = Record<string, unknown>;
type MetricWindow = {
  readonly utilization?: number;
  readonly resetAt?: string;
};
type WindowCandidate = {
  readonly identity: string;
  readonly window: UsageWindow;
};
type ExtraUsage = {
  readonly details: ClaudeDetails;
};
type ParseOutcome = {
  readonly windows: readonly WindowCandidate[];
  readonly extraUsage?: ExtraUsage;
};

const MISSING = Symbol("missing");
const MAX_OBJECT_KEYS = 2_000;
const MAX_ARRAY_LENGTH = 1_000;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_MODEL_LABEL_LENGTH = 80;
const UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const SAFE_MODEL_TEXT = /^[\p{L}\p{N}][\p{L}\p{N} ._+():/-]*$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SESSION_KINDS = new Set(["session", "five_hour"]);
const WEEKLY_ALL_KINDS = new Set(["weekly_all"]);
const WEEKLY_SCOPED_KINDS = new Set(["weekly_scoped", "seven_day_scoped"]);
const LEGACY_BASE_WINDOWS = new Map([
  ["five_hour", { identity: "session", id: "session", label: "Session (5-hour)" }],
  ["seven_day", { identity: "weekly-all", id: "weekly-all", label: "Weekly (all)" }],
  [
    "seven_day_oauth_apps",
    { identity: "oauth-apps", id: "weekly-oauth-apps", label: "OAuth apps" },
  ],
]);

/**
 * Parses only the data shape returned by Claude's OAuth usage endpoint. The
 * parser deliberately constructs a new normalized record and never retains a
 * reference to the provider response.
 */
export function parseClaudeUsageResponse(
  input: unknown,
  observedAt: string,
): ClaudeUsageParseResult {
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

    const windows = parsed.windows.map(({ window }) => window);
    const record: ClaudeProviderRecord = {
      id: "claude",
      state: "ok",
      lastSuccessAt: normalizedObservedAt,
      ...(windows.length > 0 ? { windows } : {}),
      ...(parsed.extraUsage === undefined
        ? {}
        : { details: { claude: parsed.extraUsage.details } }),
    };

    const validation = validateProviderRecord(record);
    if (!validation.ok || !isClaudeOkRecord(validation.value)) return failure();
    return { ok: true, record: validation.value };
  } catch {
    return failure();
  }
}


function parseResponse(input: PlainRecord): ParseOutcome | undefined {
  const legacy = new Map<string, WindowCandidate>();
  const modelLegacy: WindowCandidate[] = [];

  for (const key of Object.keys(input)) {
    const value = ownValue(input, key);
    if (value === MISSING) continue;

    const base = LEGACY_BASE_WINDOWS.get(key);
    if (base !== undefined) {
      if (value === null) continue;
      const metrics = parseMetricWindow(value);
      if (metrics === undefined) return undefined;
      if (!hasMetric(metrics)) continue;
      legacy.set(base.identity, {
        identity: base.identity,
        window: windowFromMetrics(base.id, base.label, metrics),
      });
      continue;
    }

    if (key.startsWith("seven_day_")) {
      if (value === null) continue;
      // Non-window siblings (e.g. `seven_day_breakdown`, a per-product report) share the
      // prefix but carry no metric keys; skip them. Window-shaped values stay strict below.
      if (!isMetricShaped(value)) continue;
      const suffix = key.slice("seven_day_".length);
      // Unsafe or unusable dynamic identities drop this single entry so valid peers survive,
      // mirroring generic weekly-scoped handling. A malformed recognized metric still rejects.
      if (suffix.length === 0 || looksLikeSensitiveIdentifier(suffix)) continue;
      const model = modelFromText(
        suffix
          .replaceAll("_", " ")
          .replace(/(?:^|\s)\p{L}/gu, (letter) => letter.toUpperCase()),
      );
      if (model === undefined) continue;
      const metrics = parseMetricWindow(value);
      if (metrics === undefined) return undefined;
      if (!hasMetric(metrics)) continue;
      modelLegacy.push({
        identity: modelIdentity(suffix),
        window: windowFromMetrics(`weekly-${slug(model)}`, `Weekly ${model}`, metrics),
      });
      continue;
    }

    if (key === "limits" && value !== MISSING && !Array.isArray(value)) return undefined;
  }

  const extraUsageValue = ownValue(input, "extra_usage");
  let extraUsage: ExtraUsage | undefined;
  if (extraUsageValue !== MISSING && extraUsageValue !== null) {
    // Malformed extra-usage is isolated: it is dropped rather than rejecting the whole payload so
    // valid base/model windows still surface. When no other usable data exists, the emptiness
    // check below returns the malformed-response failure.
    extraUsage = parseExtraUsage(extraUsageValue);
  }

  const generic = parseLimits(ownValue(input, "limits"));
  if (generic === undefined) return undefined;
  const dedupedGeneric = dedupeCandidates(generic);
  if (dedupedGeneric === undefined) return undefined;

  // Legacy model windows win over generic model collisions by canonical output id: suppress
  // the colliding generic candidate (do not reject) so the legacy window keeps its stable id
  // and label.
  const legacyOutputIds = new Set(modelLegacy.map(({ window }) => window.id));
  const modelCandidates = dedupeCandidates([
    ...modelLegacy,
    ...dedupedGeneric.filter(
      ({ identity, window }) => identity.startsWith("model:") && !legacyOutputIds.has(window.id),
    ),
  ]);
  if (modelCandidates === undefined) return undefined;

  const genericSession = dedupedGeneric.find(({ identity }) => identity === "session");
  const genericWeeklyAll = dedupedGeneric.find(({ identity }) => identity === "weekly-all");
  if (!legacy.has("session") && genericSession !== undefined) legacy.set("session", genericSession);
  if (!legacy.has("weekly-all") && genericWeeklyAll !== undefined) {
    legacy.set("weekly-all", genericWeeklyAll);
  }

  const ordered: WindowCandidate[] = [];
  for (const identity of ["session", "weekly-all", "oauth-apps"] as const) {
    const candidate = legacy.get(identity);
    if (candidate !== undefined) ordered.push(candidate);
  }
  // Reserve base window ids so a model window that slugs to the same id receives a
  // deterministic hash suffix while base windows retain their canonical ids.
  const reservedIds = new Set(ordered.map(({ window }) => window.id));
  ordered.push(...orderModelWindows(modelCandidates, reservedIds));

  if (ordered.length === 0 && extraUsage === undefined) return undefined;
  return { windows: ordered, ...(extraUsage === undefined ? {} : { extraUsage }) };
}

function parseLimits(value: unknown | typeof MISSING): readonly WindowCandidate[] | undefined {
  if (value === MISSING) return [];
  if (!Array.isArray(value)) return undefined;

  const candidates: WindowCandidate[] = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) return undefined;
    const kindValue = ownValue(entry, "kind");
    if (typeof kindValue !== "string") return undefined;

    const recognized =
      SESSION_KINDS.has(kindValue) ||
      WEEKLY_ALL_KINDS.has(kindValue) ||
      kindValue === "seven_day" ||
      WEEKLY_SCOPED_KINDS.has(kindValue);
    // Unknown kinds are forward-compatible non-data: drop the entry without inspecting it.
    if (!recognized) continue;

    // Skip inactive entries before validating their metric or base-window scope. Claude's
    // current Fable row is the exception: it is inactive in `limits[]` but still displayed
    // by the Claude app, so inspect only that model-scoped row's safe display name.
    const active = parseActiveFlag(entry);
    if (active === INVALID) return undefined;

    const scope = ownValue(entry, "scope");
    const inactiveFable =
      active === false &&
      (kindValue === "weekly_scoped" || kindValue === "seven_day") &&
      isFableModelScope(scope);
    if (active === false && !inactiveFable) continue;

    let kind: "session" | "weekly-all" | "weekly-scoped";
    if (SESSION_KINDS.has(kindValue)) {
      if (scope !== MISSING && scope !== null) return undefined;
      kind = "session";
    } else if (WEEKLY_ALL_KINDS.has(kindValue)) {
      if (scope !== MISSING && scope !== null) return undefined;
      kind = "weekly-all";
    } else if (kindValue === "seven_day") {
      kind = scope === MISSING || scope === null ? "weekly-all" : "weekly-scoped";
    } else {
      kind = "weekly-scoped";
    }

    // A recognized active entry with a malformed metric value still rejects the payload.
    // The explicitly retained inactive Fable row remains isolated if its metrics are bad.
    const metrics = parseMetricWindow(entry);
    if (metrics === undefined) {
      if (active === false) continue;
      return undefined;
    }
    if (!hasMetric(metrics)) continue;
    if (kind === "session") {
      candidates.push({
        identity: "session",
        window: windowFromMetrics("session", "Session (5-hour)", metrics),
      });
      continue;
    }
    if (kind === "weekly-all") {
      candidates.push({
        identity: "weekly-all",
        window: windowFromMetrics("weekly-all", "Weekly (all)", metrics),
      });
      continue;
    }

    // Weekly-scoped identity/scope gaps drop this single entry so valid peers survive; the
    // raw model id feeds only the internal identity and is never emitted.
    const model = parseScopedModel(scope);
    if (model === undefined) continue;
    candidates.push({
      identity: scopedIdentity(model),
      window: windowFromMetrics(
        `weekly-${slug(model.displayName)}`,
        `Weekly ${model.displayName}`,
        metrics,
      ),
    });
  }
  return candidates;
}

function parseScopedModel(
  value: unknown | typeof MISSING,
): { readonly id: string | null; readonly displayName: string } | undefined {
  if (value === MISSING || !isPlainRecord(value)) return undefined;
  const modelValue = ownValue(value, "model");
  if (!isPlainRecord(modelValue)) return undefined;
  const id = ownValue(modelValue, "id");
  const displayNameValue = ownValue(modelValue, "display_name");
  const displayName =
    typeof displayNameValue === "string" ? modelFromText(displayNameValue) : undefined;
  // A safe display name is required whether or not a raw id is present. The current Fable
  // payload sends model.id:null with a genuine display name and must still be shown, so a
  // null id with a safe name is emitted rather than dropped.
  if (displayName === undefined) return undefined;
  if (id === null) return { id: null, displayName };
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_MODEL_ID_LENGTH) {
    return undefined;
  }
  if (looksLikeSensitiveIdentifier(id)) return undefined;
  return { id, displayName };
}

function isFableModelScope(value: unknown | typeof MISSING): boolean {
  const model = parseScopedModel(value);
  return model !== undefined && model.displayName === "Fable";
}

function parseActiveFlag(entry: PlainRecord): boolean | typeof INVALID {
  // A missing flag means active; a present non-boolean flag is malformed and rejects rather
  // than being silently treated as active.
  if (!hasOwn(entry, "is_active")) return true;
  const value = ownValue(entry, "is_active");
  if (typeof value !== "boolean") return INVALID;
  return value;
}

function parseExtraUsage(value: unknown): ExtraUsage | undefined {
  if (!isPlainRecord(value)) return undefined;
  const enabled = ownValue(value, "is_enabled");
  if (typeof enabled !== "boolean") return undefined;

  const monthlyLimit = parseNullableCount(value, "monthly_limit");
  const usedCredits = parseNullableCount(value, "used_credits");
  if (monthlyLimit === INVALID || usedCredits === INVALID) return undefined;
  // Overage (used_credits > monthly_limit) is genuine provider data, not malformed: both values
  // are retained as independent non-negative safe integers without clamping or rejection.

  const currency = parseOptionalNullableSafeText(value, "currency", 16);
  const decimalPlaces = parseNullableCount(value, "decimal_places");
  const disabledReason = parseOptionalNullableProviderText(value, "disabled_reason", 100);
  if (currency === INVALID || decimalPlaces === INVALID || disabledReason === INVALID) {
    return undefined;
  }

  const details: ClaudeDetails = {
    extraUsageEnabled: enabled,
    ...(typeof usedCredits === "number" ? { extraUsageUsedCredits: usedCredits } : {}),
    ...(typeof monthlyLimit === "number" ? { extraUsageMonthlyLimit: monthlyLimit } : {}),
    ...(typeof currency === "string" ? { extraUsageCurrency: currency } : {}),
    ...(typeof decimalPlaces === "number" ? { extraUsageDecimalPlaces: decimalPlaces } : {}),
    ...(typeof disabledReason === "string"
      ? { extraUsageDisabledReason: disabledReason }
      : {}),
  };
  return { details };
}

function isMetricShaped(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    (hasOwn(value, "utilization") || hasOwn(value, "percent") || hasOwn(value, "resets_at"))
  );
}

function parseMetricWindow(value: unknown): MetricWindow | undefined {
  if (!isPlainRecord(value) || !isMetricShaped(value)) return undefined;

  const utilization = parsePresentPercent(value, "utilization");
  const percent = parsePresentPercent(value, "percent");
  const resetAt = parsePresentTimestamp(value, "resets_at");
  if (utilization === INVALID || percent === INVALID || resetAt === INVALID) return undefined;
  if (
    typeof utilization === "number" &&
    typeof percent === "number" &&
    utilization !== percent
  ) {
    return undefined;
  }
  return {
    ...(typeof utilization === "number"
      ? { utilization }
      : typeof percent === "number"
        ? { utilization: percent }
        : {}),
    ...(typeof resetAt === "string" ? { resetAt } : {}),
  };
}

const INVALID = Symbol("invalid");

function parsePresentPercent(
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


function parseNullableCount(
  input: PlainRecord,
  key: string,
): number | null | typeof INVALID | undefined {
  if (!hasOwn(input, key)) return undefined;
  const value = ownValue(input, key);
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return INVALID;
  return value;
}

function parseOptionalNullableSafeText(
  input: PlainRecord,
  key: string,
  maxLength: number,
): string | null | typeof INVALID | undefined {
  if (!hasOwn(input, key)) return undefined;
  const value = ownValue(input, key);
  if (value === null) return null;
  if (typeof value !== "string") return INVALID;
  return safeText(value, maxLength) ?? INVALID;
}

function parseOptionalNullableProviderText(
  input: PlainRecord,
  key: string,
  maxLength: number,
): string | null | typeof INVALID | undefined {
  if (!hasOwn(input, key)) return undefined;
  const value = ownValue(input, key);
  if (value === null) return null;
  if (typeof value !== "string") return INVALID;
  return safeProviderText(value, maxLength) ?? INVALID;
}

function parsePresentTimestamp(
  input: PlainRecord,
  key: string,
): string | typeof INVALID | undefined {
  if (!hasOwn(input, key)) return undefined;
  const value = ownValue(input, key);
  if (value === null) return undefined;
  return typeof value === "string" ? normalizeTimestamp(value) ?? INVALID : INVALID;
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

function safeText(value: string, maxLength: number): string | undefined {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    !SAFE_MODEL_TEXT.test(normalized) ||
    looksLikeSensitiveIdentifier(normalized) ||
    looksLikeCredentialText(normalized)
  ) return undefined;
  return normalized;
}

function safeProviderText(value: string, maxLength: number): string | undefined {
  // Widened, provider-friendly text (punctuation allowed) that stays compatible with the runtime
  // validator: bounded length, control-free, and free of secret/account-shaped content.
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    CONTROL_CHARS.test(normalized) ||
    looksLikeSensitiveIdentifier(normalized) ||
    looksLikeCredentialText(normalized)
  ) return undefined;
  return normalized;
}

function looksLikeCredentialText(value: string): boolean {
  // Mirrors the runtime validator's credential gate so widened provider text never emits a value
  // the validator would later reject.
  return (
    /bearer\s+[a-z0-9._~+/=-]+/i.test(value) ||
    /(?:sk-(?:ant|proj|live)-[a-z0-9_-]{8,}|sk-[a-z0-9]{8,}|AIza[a-z0-9_-]{20,})/i.test(value) ||
    /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/.test(value) ||
    /eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/i.test(value) ||
    /(?:access[_-]?token|refresh[_-]?token|api[_-]?key)\s*[:=]/i.test(value)
  );
}

function hasMetric(metrics: MetricWindow): boolean {
  return metrics.utilization !== undefined || metrics.resetAt !== undefined;
}

function windowFromMetrics(id: string, label: string, metrics: MetricWindow): UsageWindow {
  return {
    id,
    label,
    ...(metrics.utilization === undefined ? {} : { usedPercent: metrics.utilization }),
    ...(metrics.resetAt === undefined ? {} : { resetAt: metrics.resetAt }),
  };
}

function dedupeCandidates(
  candidates: readonly WindowCandidate[],
): readonly WindowCandidate[] | undefined {
  const byIdentity = new Map<string, WindowCandidate>();
  for (const candidate of candidates) {
    const previous = byIdentity.get(candidate.identity);
    if (previous === undefined) {
      byIdentity.set(candidate.identity, candidate);
      continue;
    }
    if (!sameWindow(previous.window, candidate.window)) return undefined;
  }
  return [...byIdentity.values()];
}

function sameWindow(left: UsageWindow, right: UsageWindow): boolean {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.usedPercent === right.usedPercent &&
    left.used === right.used &&
    left.limit === right.limit &&
    left.resetAt === right.resetAt
  );
}

function orderModelWindows(
  candidates: readonly WindowCandidate[],
  reserved: ReadonlySet<string>,
): WindowCandidate[] {
  const sorted = [...candidates].sort((left, right) => {
    if (left.window.id !== right.window.id) {
      return left.window.id < right.window.id ? -1 : 1;
    }
    if (left.identity !== right.identity) {
      return left.identity < right.identity ? -1 : 1;
    }
    return 0;
  });
  const usedIds = new Set<string>(reserved);
  return sorted.map((candidate) => {
    const baseId = candidate.window.id;
    let id = baseId;
    // Output-id collisions (against base windows or other models) get a non-reversible short
    // hash of the internal identity; the raw model id never appears because only its hash
    // contributes to the emitted id.
    if (usedIds.has(id)) id = `${baseId}-${shortHash(candidate.identity)}`;
    usedIds.add(id);
    return id === baseId
      ? candidate
      : { ...candidate, window: { ...candidate.window, id } };
  });
}

function modelIdentity(value: string): string {
  return `model:${slug(value)}`;
}

function scopedIdentity(model: {
  readonly id: string | null;
  readonly displayName: string;
}): string {
  // Internal identity only, never emitted. The exact raw id keeps genuinely distinct models
  // distinct even when their old slugs or display names collide; a null id falls back to the
  // normalized display name so current null-id payloads still deduplicate correctly.
  return model.id === null ? `model:display:${model.displayName}` : `model:id:${model.id}`;
}

function modelFromText(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    normalized.length === 0 ||
    normalized.length > MAX_MODEL_LABEL_LENGTH ||
    !SAFE_MODEL_TEXT.test(normalized) ||
    looksLikeSensitiveIdentifier(normalized) ||
    looksLikeCredentialText(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized.slice(0, 48) || "model";
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function looksLikeSensitiveIdentifier(value: string): boolean {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    /^(?:org|account|user)(?:id)?[a-z0-9]{8,}$/.test(compact) ||
    /^\d{9,}$/.test(compact) ||
    /bearer\s+/i.test(value) ||
    /(?:access|refresh)[-_ ]?token/i.test(value) ||
    /(?:api[-_ ]?key|secret|password)/i.test(value)
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
        if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return false;
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
    compact === "secret" ||
    /^(?:org|account|user)(?:id|identifier)?$/.test(compact)
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
        ) {
          return false;
        }
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
          ) {
            return false;
          }
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
        ) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  };
  return visit(root);
}


function isClaudeOkRecord(
  record: ProviderRecord,
): record is ClaudeUsageSuccessRecord {
  return record.id === "claude" && record.state === "ok";
}

function failure(): ClaudeUsageParseResult {
  return {
    ok: false,
    reason: CLAUDE_USAGE_FAILURE_REASON,
    status: CLAUDE_USAGE_STATUS_TEXT,
  };
}
