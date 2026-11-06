import { validateProviderRecord } from "../../contract/validate.js";
import type { OpenDesignDetails, OpenDesignProviderRecord, UsageWindow } from "../../contract/schema-v1.js";

export type OpenDesignUsageParseResult =
  | { readonly ok: true; readonly record: OpenDesignProviderRecord & { readonly state: "ok" } }
  | { readonly ok: false; readonly reason: "malformed-response" };

// Coding-plan windows are identified only by their duration; unknown durations are skipped.
const WINDOWS: Readonly<Record<number, { readonly id: string; readonly label: string }>> = {
  18000: { id: "5h", label: "5h" },
  604800: { id: "weekly", label: "Weekly" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Credits arrive as integer strings ("123"); numbers are accepted too. */
function credits(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseWindow(raw: unknown): UsageWindow | undefined | null {
  if (!isRecord(raw) || typeof raw.durationSeconds !== "number") return null;
  const known = WINDOWS[raw.durationSeconds];
  if (known === undefined) return undefined;
  const used = credits(raw.usedCredits);
  const limit = credits(raw.limitCredits);
  if (used === undefined || limit === undefined) return null;
  // An overdrawn window is shown as exhausted: the contract caps used at limit.
  const capped = Math.min(used, limit);
  const reset = typeof raw.resetsAt === "string" ? Date.parse(raw.resetsAt) : Number.NaN;
  return {
    ...known,
    used: capped,
    limit,
    ...(limit > 0 ? { usedPercent: (capped / limit) * 100 } : {}),
    ...(Number.isFinite(reset) ? { resetAt: new Date(reset).toISOString() } : {}),
  };
}

/**
 * `billing/coding-plan-usage` (required) plus `wallet/balance` (optional; undefined when that
 * request failed). A record that recognized nothing is malformed, never an empty success.
 */
export function parseOpenDesignUsageResponse(usage: unknown, wallet: unknown, observedAt: string): OpenDesignUsageParseResult {
  const failure: OpenDesignUsageParseResult = { ok: false, reason: "malformed-response" };
  if (!isRecord(usage)) return failure;
  const windows: UsageWindow[] = [];
  if (usage.windows !== undefined) {
    if (!Array.isArray(usage.windows)) return failure;
    for (const raw of usage.windows) {
      const parsed = parseWindow(raw);
      if (parsed === null) return failure;
      if (parsed !== undefined && !windows.some((w) => w.id === parsed.id)) windows.push(parsed);
    }
  }
  windows.sort((a, b) => (a.id === "5h" ? -1 : b.id === "5h" ? 1 : 0));
  const details: { -readonly [K in keyof OpenDesignDetails]: OpenDesignDetails[K] } = {};
  if (typeof usage.tier === "string" && /^[A-Za-z0-9 _-]{1,50}$/.test(usage.tier)) details.tier = usage.tier;
  if (isRecord(wallet) && typeof wallet.balanceUsd === "string" && /^\d+(\.\d+)?$/.test(wallet.balanceUsd)) {
    details.walletBalanceUsd = Number(wallet.balanceUsd);
  }
  if (windows.length === 0 && Object.keys(details).length === 0) return failure;
  const record: OpenDesignProviderRecord & { readonly state: "ok" } = {
    id: "opendesign",
    state: "ok",
    lastSuccessAt: observedAt,
    windows,
    ...(Object.keys(details).length > 0 ? { details: { opendesign: details } } : {}),
  };
  const validation = validateProviderRecord(record);
  return validation.ok ? { ok: true, record } : failure;
}
