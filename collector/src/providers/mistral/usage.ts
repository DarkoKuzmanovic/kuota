import { validateProviderRecord } from "../../contract/validate.js";
import type { MistralDetails, MistralProviderRecord, UsageWindow } from "../../contract/schema-v1.js";

export type MistralUsageParseResult =
  | { readonly ok: true; readonly record: MistralProviderRecord & { readonly state: "ok" } }
  | { readonly ok: false; readonly reason: "malformed-response" };

type Budget = { readonly usedPercent: number; readonly budget: number; readonly currency?: string; readonly resetAt?: string; readonly payg: boolean };
const INVALID = Symbol("invalid");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absent budget → undefined (skipped); a present but malformed one fails the whole response. */
function parseBudget(raw: unknown): Budget | typeof INVALID | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) return INVALID;
  const { usage_percentage: pct, initial_budget: budget, currency, reset_at: resetAt, payg_enabled: payg } = raw;
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) return INVALID;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) return INVALID;
  const reset = typeof resetAt === "string" ? Date.parse(resetAt) : Number.NaN;
  return {
    usedPercent: pct,
    budget,
    ...(typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? { currency } : {}),
    ...(Number.isFinite(reset) ? { resetAt: new Date(reset).toISOString() } : {}),
    payg: payg === true,
  };
}

function window(id: string, label: string, budget: Budget): UsageWindow {
  return { id, label, usedPercent: budget.usedPercent, ...(budget.resetAt === undefined ? {} : { resetAt: budget.resetAt }) };
}

/** `GET admin.mistral.ai/api/billing/v2/budget`: Vibe Code (primary) and API monthly budgets. */
export function parseMistralUsageResponse(input: unknown, observedAt: string): MistralUsageParseResult {
  const failure: MistralUsageParseResult = { ok: false, reason: "malformed-response" };
  if (!isRecord(input)) return failure;
  const vibe = parseBudget(input.vibe_budget);
  const api = parseBudget(input.api_budget);
  if (vibe === INVALID || api === INVALID || (vibe === undefined && api === undefined)) return failure;
  const primary = vibe ?? api;
  const windows: UsageWindow[] = [];
  if (vibe !== undefined) windows.push(window("vibe", "Vibe Code", vibe));
  if (api !== undefined) windows.push(window("api", "API", api));
  const details: { -readonly [K in keyof MistralDetails]: MistralDetails[K] } = {};
  if (vibe !== undefined) details.vibeBudget = vibe.budget;
  if (api !== undefined) details.apiBudget = api.budget;
  if (primary?.currency !== undefined) details.currency = primary.currency;
  if (primary !== undefined) details.paygEnabled = primary.payg;
  const record: MistralProviderRecord & { readonly state: "ok" } = {
    id: "mistral",
    state: "ok",
    lastSuccessAt: observedAt,
    windows,
    details: { mistral: details },
  };
  const validation = validateProviderRecord(record);
  return validation.ok ? { ok: true, record } : failure;
}
