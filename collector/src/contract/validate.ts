import {
  PROVIDER_IDS,
  PROVIDER_STATES,
  SCHEMA_VERSION,
  type ClaudeDetails,
  type CodexDetails,
  type CollectorDocument,
  type ProviderDetails,
  type ProviderId,
  type ProviderRecord,
  type ProviderState,
  type UmansDetails,
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
const CLAUDE_DETAIL_KEYS = new Set(["model", "tokens"]);
const UMANS_DETAIL_KEYS = new Set(["plan", "requests", "concurrency"]);
const CODEX_DETAIL_KEYS = new Set(["plan", "credits", "cost", "tokens"]);
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const WINDOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateCollectorDocument(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: "$", reason: "expected an object" }] };
  }

  validateObjectKeys(input, "$", DOCUMENT_KEYS, errors);

  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== SCHEMA_VERSION) {
    addIssue(errors, "$.schemaVersion", "unsupported schema version");
  }

  const collectionStartedAt = parseRequiredTimestamp(
    input,
    "collectionStartedAt",
    "$.collectionStartedAt",
    errors,
  );
  const collectionFinishedAt = parseRequiredTimestamp(
    input,
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

  const providersValue = input.providers;
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
  if (id === "umans") {
    const details = parseUmansDetails(input.umans, `${path}.umans`, errors);
    if (errors.length !== initialErrorCount && details === undefined) {
      return undefined;
    }
    return details === undefined ? undefined : { umans: details };
  }
  const details = parseCodexDetails(input.codex, `${path}.codex`, errors);
  if (errors.length !== initialErrorCount && details === undefined) {
    return undefined;
  }
  return details === undefined ? undefined : { codex: details };
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
  if (errors.length !== initialErrorCount) {
    return undefined;
  }
  const details: { model?: string; tokens?: number } = {};
  if (model !== undefined) {
    details.model = model;
  }
  if (tokens !== undefined) {
    details.tokens = tokens;
  }
  return details;
}

function parseUmansDetails(
  input: unknown,
  path: string,
  errors: ValidationIssue[],
): UmansDetails | undefined {
  if (!isRecord(input)) {
    addIssue(errors, path, "expected an object");
    return undefined;
  }
  const initialErrorCount = errors.length;
  validateObjectKeys(input, path, UMANS_DETAIL_KEYS, errors);
  const plan = parseOptionalSafeText(input, "plan", `${path}.plan`, 100, errors);
  const requests = parseOptionalCount(
    input,
    "requests",
    `${path}.requests`,
    errors,
  );
  const concurrency = parseOptionalCount(
    input,
    "concurrency",
    `${path}.concurrency`,
    errors,
  );
  if (errors.length !== initialErrorCount) {
    return undefined;
  }
  const details: { plan?: string; requests?: number; concurrency?: number } = {};
  if (plan !== undefined) {
    details.plan = plan;
  }
  if (requests !== undefined) {
    details.requests = requests;
  }
  if (concurrency !== undefined) {
    details.concurrency = concurrency;
  }
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
  if ("umans" in details) {
    return Object.keys(details.umans).length > 0;
  }
  return Object.keys(details.codex).length > 0;
}

function isMember<const T extends readonly string[]>(
  values: T,
  input: string,
): input is T[number] {
  return values.some((value) => value === input);
}
