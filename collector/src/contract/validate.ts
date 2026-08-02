import {
  PROVIDER_IDS,
  PROVIDER_STATES,
  SCHEMA_VERSION,
  type ClaudeDetails,
  type CodexDetails,
  type CollectorDocument,
  type CursorDetails,
  type GrokDetails,
  type KimiDetails,
  type ProviderDetails,
  type ProviderId,
  type ProviderRecord,
  type ProviderState,
  type UsageWindow,
} from "./schema-v1.js";

export interface ValidationIssue {
  readonly path: string;
  readonly reason: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly value: CollectorDocument }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

export type ProviderRecordValidationResult =
  | { readonly ok: true; readonly value: ProviderRecord }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

const DOCUMENT_KEYS = new Set([
  "schemaVersion",
  "collectionStartedAt",
  "collectionFinishedAt",
  "providers",
]);
const PROVIDER_KEYS = new Set([
  "id",
  "state",
  "status",
  "lastSuccessAt",
  "windows",
  "details",
]);
const WINDOW_KEYS = new Set([
  "id",
  "label",
  "usedPercent",
  "used",
  "limit",
  "resetAt",
]);
const CLAUDE_DETAIL_KEYS = new Set([
  "model",
  "tokens",
  "extraUsageEnabled",
  "extraUsageUsedCredits",
  "extraUsageMonthlyLimit",
  "extraUsageCurrency",
  "extraUsageDecimalPlaces",
  "extraUsageDisabledReason",
]);
const CODEX_DETAIL_KEYS = new Set(["plan", "credits", "cost", "tokens"]);
const GROK_DETAIL_KEYS = new Set(["monthlyUsed", "monthlyLimit", "monthlyResetAt"]);
const KIMI_DETAIL_KEYS = new Set(["concurrency", "concurrencyLimit"]);
const CURSOR_DETAIL_KEYS = new Set([
  "membershipType",
  "onDemandUsed",
  "onDemandLimit",
  "autoPercentUsed",
  "apiPercentUsed",
  "totalPercentUsed",
]);
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const WINDOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateCollectorDocument(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: "$", reason: "expected an object" }] };
  }

  let document: Record<string, unknown> = input;
  if (input.schemaVersion === 1) {
    const providers = Array.isArray(input.providers) ? input.providers : undefined;
    document = {
      ...input,
      schemaVersion: SCHEMA_VERSION,
      providers: providers === undefined
        ? input.providers
        : providers.filter((provider) => !(isRecord(provider) && provider.id === "umans")),
    };
  }

  validateObjectKeys(document, "$", DOCUMENT_KEYS, errors);

  const schemaVersion = document.schemaVersion;
  if (schemaVersion !== SCHEMA_VERSION) {
    addIssue(errors, "$.schemaVersion", "unsupported schema version");
  }

  const collectionStartedAt = parseRequiredTimestamp(
    document,
    "collectionStartedAt",
    "$.collectionStartedAt",
    errors,
  );
  const collectionFinishedAt = parseRequiredTimestamp(
    document,
    "collectionFinishedAt",
    "$.collectionFinishedAt",
    errors,
  );
  if (
    collectionStartedAt !== undefined &&
    collectionFinishedAt !== undefined &&
    Date.parse(collectionStartedAt) > Date.parse(collectionFinishedAt)
  ) {
    addIssue(
      errors,
      "$.collectionStartedAt",
      "must not be after collection end",
    );
  }

  const providersValue = document.providers;
  const providers: ProviderRecord[] = [];
  const providerIds = new Set<ProviderId>();
  if (!Array.isArray(providersValue)) {
    addIssue(errors, "$.providers", "expected an array");
  } else {
    for (const [index, providerValue] of providersValue.entries()) {
      const path = `$.providers[${index}]`;
      const provider = parseProvider(providerValue, path, errors);
      if (provider === undefined) {
        continue;
      }
      if (providerIds.has(provider.id)) {
        addIssue(errors, `${path}.id`, "duplicate provider");
        continue;
      }
      providerIds.add(provider.id);
      providers.push(provider);
    }
  }

  if (
    errors.length > 0 ||
    collectionStartedAt === undefined ||
    collectionFinishedAt === undefined
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      collectionStartedAt,
      collectionFinishedAt,
      providers,
    },
  };
}

export function isCollectorDocument(input: unknown): input is CollectorDocument {
  return validateCollectorDocument(input).ok;
}

export function validateProviderRecord(input: unknown): ProviderRecordValidationResult {
  const errors: ValidationIssue[] = [];
  const value = parseProvider(input, "$", errors);
  if (value === undefined || errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value };
}

function parseProvider(
  input: unknown,
  path: string,
  errors: ValidationIssue[],
): ProviderRecord | undefined {
  if (!isRecord(input)) {
    addIssue(errors, path, "expected an object");
    return undefined;
  }

  const initialErrorCount = errors.length;
  validateObjectKeys(input, path, PROVIDER_KEYS, errors);

  const id = parseProviderId(input.id, `${path}.id`, errors);
  const state = parseProviderState(input.state, `${path}.state`, errors);
  const status = parseOptionalSafeText(
    input,
    "status",
    `${path}.status`,
    200,
    errors,
  );
  const lastSuccessAt = parseOptionalTimestamp(
    input,
    "lastSuccessAt",
    `${path}.lastSuccessAt`,
    errors,
  );

  let windows: readonly UsageWindow[] | undefined;
  if (hasOwn(input, "windows") && input.windows !== undefined) {
    if (!Array.isArray(input.windows)) {
      addIssue(errors, `${path}.windows`, "expected an array");
    } else {
      const parsedWindows: UsageWindow[] = [];
      for (const [index, windowValue] of input.windows.entries()) {
        const window = parseWindow(
          windowValue,
          `${path}.windows[${index}]`,
          errors,
        );
        if (window !== undefined) {
          parsedWindows.push(window);
        }
      }
      windows = parsedWindows;
    }
  }

  let details: ProviderDetails | undefined;
  if (
    id !== undefined &&
    hasOwn(input, "details") &&
    input.details !== undefined
  ) {
    details = parseProviderDetails(input.details, id, `${path}.details`, errors);
  }

  if (state === "stale") {
    if (lastSuccessAt === undefined) {
      addIssue(errors, `${path}.lastSuccessAt`, "stale provider requires lastSuccessAt");
    }
    if (!hasRetainedData(windows, details)) {
      addIssue(errors, path, "stale provider requires retained usage data");
    }
  }

  if (errors.length !== initialErrorCount) {
    return undefined;
  }
  if (id === undefined || state === undefined) {
    return undefined;
  }

  const provider: {
    id: ProviderId;
    state: ProviderState;
    status?: string;
    lastSuccessAt?: string;
    windows?: readonly UsageWindow[];
    details?: ProviderDetails;
  } = { id, state };
  if (status !== undefined) {
    provider.status = status;
  }
  if (lastSuccessAt !== undefined) {
    provider.lastSuccessAt = lastSuccessAt;
  }
  if (windows !== undefined) {
    provider.windows = windows;
  }
  if (details !== undefined) {
    provider.details = details;
  }
  // Provider ID/details correlation and stale retention checks justify this typed record.
  return provider as ProviderRecord;
}

function parseWindow(
  input: unknown,
  path: string,
  errors: ValidationIssue[],
): UsageWindow | undefined {
  if (!isRecord(input)) {
    addIssue(errors, path, "expected an object");
    return undefined;
  }

  const initialErrorCount = errors.length;
  validateObjectKeys(input, path, WINDOW_KEYS, errors);
  const id = parseRequiredSafeText(input, "id", `${path}.id`, 80, errors);
  if (id !== undefined && !WINDOW_ID.test(id)) {
    addIssue(errors, `${path}.id`, "invalid window identifier");
  }
  const label = parseRequiredSafeText(
    input,
    "label",
    `${path}.label`,
    100,
    errors,
  );
  const usedPercent = parseOptionalPercent(
    input,
    "usedPercent",
    `${path}.usedPercent`,
    errors,
  );
  const used = parseOptionalCount(input, "used", `${path}.used`, errors);
  const limit = parseOptionalCount(input, "limit", `${path}.limit`, errors);
  const resetAt = parseOptionalTimestamp(
    input,
    "resetAt",
    `${path}.resetAt`,
    errors,
  );

  if (used !== undefined && limit !== undefined && used > limit) {
    addIssue(errors, `${path}.used`, "cannot exceed limit");
  }
  if (limit === 0 && usedPercent !== undefined && usedPercent !== 0) {
    addIssue(errors, `${path}.usedPercent`, "impossible for a zero limit");
  }

  if (errors.length !== initialErrorCount) {
    return undefined;
  }
  if (id === undefined || label === undefined) {
    return undefined;
  }

  const window: {
    id: string;
    label: string;
    usedPercent?: number;
    used?: number;
    limit?: number;
    resetAt?: string;
  } = { id, label };
  if (usedPercent !== undefined) {
    window.usedPercent = usedPercent;
  }
  if (used !== undefined) {
    window.used = used;
  }
  if (limit !== undefined) {
    window.limit = limit;
  }
  if (resetAt !== undefined) {
    window.resetAt = resetAt;
  }
  return window;
}

function parseProviderDetails(
  input: unknown,
  id: ProviderId,
  path: string,
  errors: ValidationIssue[],
): ProviderDetails | undefined {
  if (!isRecord(input)) {
    addIssue(errors, path, "expected a namespaced object");
    return undefined;
  }

  const initialErrorCount = errors.length;
  const namespace = new Set([id]);
  validateObjectKeys(input, path, namespace, errors);
  if (!hasOwn(input, id)) {
    addIssue(errors, `${path}.${id}`, "required provider namespace");
    return undefined;
  }

  if (id === "claude") {
    const details = parseClaudeDetails(input.claude, `${path}.claude`, errors);
    if (errors.length !== initialErrorCount && details === undefined) {
      return undefined;
    }
    return details === undefined ? undefined : { claude: details };
  }
  if (id === "codex") {
    const details = parseCodexDetails(input.codex, `${path}.codex`, errors);
    if (errors.length !== initialErrorCount && details === undefined) {
      return undefined;
    }
    return details === undefined ? undefined : { codex: details };
  }
  if (id === "grok") {
    const details = parseGrokDetails(input.grok, `${path}.grok`, errors);
    if (errors.length !== initialErrorCount && details === undefined) {
      return undefined;
    }
    return details === undefined ? undefined : { grok: details };
  }
  if (id === "kimi") {
    const details = parseKimiDetails(input.kimi, `${path}.kimi`, errors);
    if (errors.length !== initialErrorCount && details === undefined) {
      return undefined;
    }
    return details === undefined ? undefined : { kimi: details };
  }
  const details = parseCursorDetails(input.cursor, `${path}.cursor`, errors);
  if (errors.length !== initialErrorCount && details === undefined) {
    return undefined;
  }
  return details === undefined ? undefined : { cursor: details };
}

function parseClaudeDetails(
  input: unknown,
  path: string,
  errors: ValidationIssue[],
): ClaudeDetails | undefined {
  if (!isRecord(input)) {
    addIssue(errors, path, "expected an object");
    return undefined;
  }
  const initialErrorCount = errors.length;
  validateObjectKeys(input, path, CLAUDE_DETAIL_KEYS, errors);
  const model = parseOptionalSafeText(input, "model", `${path}.model`, 100, errors);
  const tokens = parseOptionalCount(input, "tokens", `${path}.tokens`, errors);
  const extraUsageEnabled = parseOptionalBoolean(
    input,
    "extraUsageEnabled",
    `${path}.extraUsageEnabled`,
    errors,
  );
  const extraUsageUsedCredits = parseOptionalCount(
    input,
    "extraUsageUsedCredits",
    `${path}.extraUsageUsedCredits`,
    errors,
  );
  const extraUsageMonthlyLimit = parseOptionalCount(
    input,
    "extraUsageMonthlyLimit",
    `${path}.extraUsageMonthlyLimit`,
    errors,
  );
  const extraUsageCurrency = parseOptionalSafeText(
    input,
    "extraUsageCurrency",
    `${path}.extraUsageCurrency`,
    16,
    errors,
  );
  const extraUsageDecimalPlaces = parseOptionalCount(
    input,
    "extraUsageDecimalPlaces",
    `${path}.extraUsageDecimalPlaces`,
    errors,
  );
  const extraUsageDisabledReason = parseOptionalSafeText(
    input,
    "extraUsageDisabledReason",
    `${path}.extraUsageDisabledReason`,
    100,
    errors,
  );
  if (errors.length !== initialErrorCount) {
    return undefined;
  }
  const details: {
    model?: string;
    tokens?: number;
    extraUsageEnabled?: boolean;
    extraUsageUsedCredits?: number;
    extraUsageMonthlyLimit?: number;
    extraUsageCurrency?: string;
    extraUsageDecimalPlaces?: number;
    extraUsageDisabledReason?: string;
  } = {};
  if (model !== undefined) details.model = model;
  if (tokens !== undefined) details.tokens = tokens;
  if (extraUsageEnabled !== undefined) details.extraUsageEnabled = extraUsageEnabled;
  if (extraUsageUsedCredits !== undefined) details.extraUsageUsedCredits = extraUsageUsedCredits;
  if (extraUsageMonthlyLimit !== undefined) details.extraUsageMonthlyLimit = extraUsageMonthlyLimit;
  if (extraUsageCurrency !== undefined) details.extraUsageCurrency = extraUsageCurrency;
  if (extraUsageDecimalPlaces !== undefined) details.extraUsageDecimalPlaces = extraUsageDecimalPlaces;
  if (extraUsageDisabledReason !== undefined) details.extraUsageDisabledReason = extraUsageDisabledReason;
  return details;
}

function parseCodexDetails(
  input: unknown,
  path: string,
  errors: ValidationIssue[],
): CodexDetails | undefined {
  if (!isRecord(input)) {
    addIssue(errors, path, "expected an object");
    return undefined;
  }
  const initialErrorCount = errors.length;
  validateObjectKeys(input, path, CODEX_DETAIL_KEYS, errors);
  const plan = parseOptionalSafeText(input, "plan", `${path}.plan`, 100, errors);
  const credits = parseOptionalNonNegativeNumber(
    input,
    "credits",
    `${path}.credits`,
    errors,
  );
  const cost = parseOptionalNonNegativeNumber(
    input,
    "cost",
    `${path}.cost`,
    errors,
  );
  const tokens = parseOptionalCount(input, "tokens", `${path}.tokens`, errors);
  if (errors.length !== initialErrorCount) {
    return undefined;
  }
  const details: {
    plan?: string;
    credits?: number;
    cost?: number;
    tokens?: number;
  } = {};
  if (plan !== undefined) {
    details.plan = plan;
  }
  if (credits !== undefined) {
    details.credits = credits;
  }
  if (cost !== undefined) {
    details.cost = cost;
  }
  if (tokens !== undefined) {
    details.tokens = tokens;
  }
  return details;
}

function parseGrokDetails(
  input: unknown,
  path: string,
  errors: ValidationIssue[],
): GrokDetails | undefined {
  if (!isRecord(input)) {
    addIssue(errors, path, "expected an object");
    return undefined;
  }
  const initialErrorCount = errors.length;
  validateObjectKeys(input, path, GROK_DETAIL_KEYS, errors);
  const monthlyUsed = parseOptionalNonNegativeNumber(input, "monthlyUsed", `${path}.monthlyUsed`, errors);
  const monthlyLimit = parseOptionalNonNegativeNumber(input, "monthlyLimit", `${path}.monthlyLimit`, errors);
  const monthlyResetAt = parseOptionalTimestamp(input, "monthlyResetAt", `${path}.monthlyResetAt`, errors);
  if (errors.length !== initialErrorCount) {
    return undefined;
  }
  const details: {
    monthlyUsed?: number;
    monthlyLimit?: number;
    monthlyResetAt?: string;
  } = {};
  if (monthlyUsed !== undefined) details.monthlyUsed = monthlyUsed;
  if (monthlyLimit !== undefined) details.monthlyLimit = monthlyLimit;
  if (monthlyResetAt !== undefined) details.monthlyResetAt = monthlyResetAt;
  return details;
}

function parseKimiDetails(
  input: unknown,
  path: string,
  errors: ValidationIssue[],
): KimiDetails | undefined {
  if (!isRecord(input)) {
    addIssue(errors, path, "expected an object");
    return undefined;
  }
  const initialErrorCount = errors.length;
  validateObjectKeys(input, path, KIMI_DETAIL_KEYS, errors);
  const concurrency = parseOptionalCount(input, "concurrency", `${path}.concurrency`, errors);
  const concurrencyLimit = parseOptionalCount(input, "concurrencyLimit", `${path}.concurrencyLimit`, errors);
  if (errors.length !== initialErrorCount) {
    return undefined;
  }
  const details: {
    concurrency?: number;
    concurrencyLimit?: number;
  } = {};
  if (concurrency !== undefined) details.concurrency = concurrency;
  if (concurrencyLimit !== undefined) details.concurrencyLimit = concurrencyLimit;
  return details;
}

function parseCursorDetails(
  input: unknown,
  path: string,
  errors: ValidationIssue[],
): CursorDetails | undefined {
  if (!isRecord(input)) {
    addIssue(errors, path, "expected an object");
    return undefined;
  }
  const initialErrorCount = errors.length;
  validateObjectKeys(input, path, CURSOR_DETAIL_KEYS, errors);
  const membershipType = parseOptionalSafeText(input, "membershipType", `${path}.membershipType`, 100, errors);
  const onDemandUsed = parseOptionalCount(input, "onDemandUsed", `${path}.onDemandUsed`, errors);
  const onDemandLimit = parseOptionalCount(input, "onDemandLimit", `${path}.onDemandLimit`, errors);
  const autoPercentUsed = parseOptionalPercent(input, "autoPercentUsed", `${path}.autoPercentUsed`, errors);
  const apiPercentUsed = parseOptionalPercent(input, "apiPercentUsed", `${path}.apiPercentUsed`, errors);
  const totalPercentUsed = parseOptionalPercent(input, "totalPercentUsed", `${path}.totalPercentUsed`, errors);
  if (errors.length !== initialErrorCount) {
    return undefined;
  }
  const details: {
    membershipType?: string;
    onDemandUsed?: number;
    onDemandLimit?: number;
    autoPercentUsed?: number;
    apiPercentUsed?: number;
    totalPercentUsed?: number;
  } = {};
  if (membershipType !== undefined) details.membershipType = membershipType;
  if (onDemandUsed !== undefined) details.onDemandUsed = onDemandUsed;
  if (onDemandLimit !== undefined) details.onDemandLimit = onDemandLimit;
  if (autoPercentUsed !== undefined) details.autoPercentUsed = autoPercentUsed;
  if (apiPercentUsed !== undefined) details.apiPercentUsed = apiPercentUsed;
  if (totalPercentUsed !== undefined) details.totalPercentUsed = totalPercentUsed;
  return details;
}

function parseProviderId(
  input: unknown,
  path: string,
  errors: ValidationIssue[],
): ProviderId | undefined {
  if (typeof input !== "string" || !isMember(PROVIDER_IDS, input)) {
    addIssue(errors, path, "unknown provider");
    return undefined;
  }
  return input;
}

function parseProviderState(
  input: unknown,
  path: string,
  errors: ValidationIssue[],
): ProviderState | undefined {
  if (typeof input !== "string" || !isMember(PROVIDER_STATES, input)) {
    addIssue(errors, path, "unknown provider state");
    return undefined;
  }
  return input;
}

function parseRequiredTimestamp(
  input: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationIssue[],
): string | undefined {
  if (!hasOwn(input, key)) {
    addIssue(errors, path, "required field");
    return undefined;
  }
  return parseTimestamp(input[key], path, errors);
}

function parseOptionalTimestamp(
  input: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationIssue[],
): string | undefined {
  if (!hasOwn(input, key) || input[key] === undefined) {
    return undefined;
  }
  return parseTimestamp(input[key], path, errors);
}

function parseTimestamp(
  input: unknown,
  path: string,
  errors: ValidationIssue[],
): string | undefined {
  if (typeof input !== "string" || !UTC_TIMESTAMP.test(input)) {
    addIssue(errors, path, "invalid UTC timestamp format");
    return undefined;
  }
  const parsed = new Date(input);
  const fractional = /\.(\d{3})Z$/.exec(input)?.[1];
  const canonical =
    fractional === undefined
      ? `${input.slice(0, -1)}.000Z`
      : `${input.slice(0, -(fractional.length + 2))}.${fractional.padEnd(3, "0")}Z`;
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== canonical) {
    addIssue(errors, path, "impossible UTC timestamp");
    return undefined;
  }
  return input;
}

function parseRequiredSafeText(
  input: Record<string, unknown>,
  key: string,
  path: string,
  maxLength: number,
  errors: ValidationIssue[],
): string | undefined {
  if (!hasOwn(input, key)) {
    addIssue(errors, path, "required field");
    return undefined;
  }
  return parseSafeText(input[key], path, maxLength, errors);
}

function parseOptionalSafeText(
  input: Record<string, unknown>,
  key: string,
  path: string,
  maxLength: number,
  errors: ValidationIssue[],
): string | undefined {
  if (!hasOwn(input, key) || input[key] === undefined) {
    return undefined;
  }
  return parseSafeText(input[key], path, maxLength, errors);
}

function parseSafeText(
  input: unknown,
  path: string,
  maxLength: number,
  errors: ValidationIssue[],
): string | undefined {
  if (typeof input !== "string") {
    addIssue(errors, path, "expected a string");
    return undefined;
  }
  if (input.length === 0 || input.length > maxLength) {
    addIssue(errors, path, "invalid text length");
    return undefined;
  }
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    addIssue(errors, path, "unsafe status text");
    return undefined;
  }
  if (looksLikeCredential(input)) {
    addIssue(errors, path, "credential-shaped text");
    return undefined;
  }
  return input;
}

function parseOptionalPercent(
  input: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationIssue[],
): number | undefined {
  if (!hasOwn(input, key) || input[key] === undefined) {
    return undefined;
  }
  const value = input[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    addIssue(errors, path, "percentage must be between 0 and 100");
    return undefined;
  }
  return value;
}

function parseOptionalCount(
  input: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationIssue[],
): number | undefined {
  if (!hasOwn(input, key) || input[key] === undefined) {
    return undefined;
  }
  const value = input[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    addIssue(errors, path, "count must be a non-negative safe integer");
    return undefined;
  }
  return value;
}

function parseOptionalBoolean(
  input: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationIssue[],
): boolean | undefined {
  if (!hasOwn(input, key) || input[key] === undefined) {
    return undefined;
  }
  const value = input[key];
  if (typeof value !== "boolean") {
    addIssue(errors, path, "expected a boolean");
    return undefined;
  }
  return value;
}

function parseOptionalNonNegativeNumber(
  input: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationIssue[],
): number | undefined {
  if (!hasOwn(input, key) || input[key] === undefined) {
    return undefined;
  }
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    addIssue(errors, path, "number must be non-negative and finite");
    return undefined;
  }
  return value;
}

function validateObjectKeys(
  input: Record<string, unknown>,
  path: string,
  allowed: ReadonlySet<string>,
  errors: ValidationIssue[],
): void {
  for (const key of Object.getOwnPropertyNames(input)) {
    if (allowed.has(key)) {
      continue;
    }
    const reason = isCredentialKey(key)
      ? "credential-shaped field"
      : "unknown field";
    addIssue(errors, `${path}.${key}`, reason);
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    addIssue(errors, path, "unknown field");
  }
}

function addIssue(
  errors: ValidationIssue[],
  path: string,
  reason: string,
): void {
  errors.push({ path, reason });
}

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "key" ||
    normalized === "account" ||
    normalized === "accountid" ||
    normalized === "orgid" ||
    normalized === "userid" ||
    normalized === "authorization" ||
    normalized === "apikey" ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential")
  );
}

function looksLikeCredential(input: string): boolean {
  return (
    /bearer\s+[a-z0-9._~+/=-]+/i.test(input) ||
    /(?:sk-(?:ant|proj|live)-[a-z0-9_-]{8,}|sk-[a-z0-9]{8,}|AIza[a-z0-9_-]{20,})/i.test(input) ||
    /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/.test(input) ||
    /eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/i.test(input) ||
    /(?:access[_-]?token|refresh[_-]?token|api[_-]?key)\s*[:=]/i.test(input)
  );
}

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function hasRetainedData(
  windows: readonly UsageWindow[] | undefined,
  details: ProviderDetails | undefined,
): boolean {
  if (windows !== undefined && windows.length > 0) {
    return true;
  }
  if (details === undefined) {
    return false;
  }
  if ("claude" in details) {
    return Object.keys(details.claude).length > 0;
  }
  if ("codex" in details) {
    return Object.keys(details.codex).length > 0;
  }
  if ("grok" in details) {
    return Object.keys(details.grok).length > 0;
  }
  if ("kimi" in details) {
    return Object.keys(details.kimi).length > 0;
  }
  return Object.keys(details.cursor).length > 0;
}

function isMember<const T extends readonly string[]>(
  values: T,
  input: string,
): input is T[number] {
  return values.some((value) => value === input);
}
