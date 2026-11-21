import { validateProviderRecord } from "../../contract/validate.js";
import type { MuseProviderRecord, UsageWindow } from "../../contract/schema-v1.js";

export type MuseUsageParseResult =
  | { readonly ok: true; readonly record: MuseProviderRecord & { readonly state: "ok" } }
  | { readonly ok: false; readonly reason: "malformed-response" };


function amount(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function window(id: string, label: string, used: unknown, limit: unknown, reset: unknown): UsageWindow | undefined {
  const usedNumber = amount(used);
  const limitNumber = amount(limit);
  const seconds = amount(reset);
  const usedPercent = usedNumber !== undefined && limitNumber !== undefined && limitNumber > 0
    ? usedNumber >= limitNumber ? 100 : usedNumber / limitNumber * 100
    : undefined;
  const resetAt = seconds !== undefined && seconds > 0 && seconds <= 253402300799
    ? new Date(seconds * 1000).toISOString() : undefined;
  if (usedPercent === undefined && resetAt === undefined) return undefined;
  return { id, label, ...(usedPercent === undefined ? {} : { usedPercent }), ...(resetAt === undefined ? {} : { resetAt }) };
}

/** Normalize the browser's subscription-quota response, omitting unavailable fields. */
export function parseMuseUsageResponse(input: unknown, observedAt: string): MuseUsageParseResult {
  const failure: MuseUsageParseResult = { ok: false, reason: "malformed-response" };
  if (typeof input !== "object" || input === null || !("subscription_quota" in input) ||
      typeof input.subscription_quota !== "object" || input.subscription_quota === null ||
      Array.isArray(input.subscription_quota)) return failure;
  const quota = input.subscription_quota;
  const duration = amount("window_duration_secs" in quota ? quota.window_duration_secs : undefined);
  const label = duration !== undefined && duration > 0 && Number.isSafeInteger(duration) && duration % 3600 === 0
    ? `${duration / 3600}-hour` : "Current window";
  const current = window("current", label, "window_weighted_used" in quota ? quota.window_weighted_used : undefined,
    "window_weighted_limit" in quota ? quota.window_weighted_limit : undefined, "window_resets_at" in quota ? quota.window_resets_at : undefined);
  const weekly = window("weekly", "Weekly", "weekly_weighted_used" in quota ? quota.weekly_weighted_used : undefined,
    "weekly_weighted_limit" in quota ? quota.weekly_weighted_limit : undefined, "weekly_resets_at" in quota ? quota.weekly_resets_at : undefined);
  const windows = [current, weekly].filter((item): item is UsageWindow => item !== undefined);
  const tier = "tier" in quota && typeof quota.tier === "string" && /^[A-Za-z0-9 _-]{1,50}$/.test(quota.tier) ? quota.tier : undefined;
  if (windows.length === 0 && tier === undefined) return failure;
  const record: MuseProviderRecord & { readonly state: "ok" } = {
    id: "muse", state: "ok", lastSuccessAt: observedAt, windows,
    ...(tier === undefined ? {} : { details: { muse: { tier } } }),
  };
  return validateProviderRecord(record).ok ? { ok: true, record } : failure;
}
