import assert from "node:assert/strict";
import test from "node:test";

import { createOpenDesignAdapter } from "../../../src/providers/opendesign/adapter.js";
import { parseOpenDesignUsageResponse } from "../../../src/providers/opendesign/usage.js";
import type { SessionFetchOptions, SessionFetchResult } from "../../../src/providers/session-fetch.js";

// Real wire shapes (2026-11-06 recon; synthetic values and IDs).
const WORKSPACE = "syntheticws000000000000a";
const CURRENT = { userId: "synthetic-user", workspaceId: WORKSPACE, activeWorkspaceId: WORKSPACE, planId: "go" };
const USAGE = {
  workspaceId: WORKSPACE, generatedAt: "2026-11-06T09:59:00.000Z", eligible: true, tier: "go",
  windows: [
    { policyId: "synthetic-weekly", durationSeconds: 604800, resetMode: "anchored_recurring", usedCredits: "250", limitCredits: "10000", remainingCredits: "9750", windowStart: "2026-11-03T00:00:00.000Z", resetsAt: "2026-11-10T00:00:00.000Z" },
    { policyId: "synthetic-5h", durationSeconds: 18000, resetMode: "anchored_recurring", usedCredits: "120", limitCredits: "2000", remainingCredits: "1880", windowStart: "2026-11-06T08:00:00.000Z", resetsAt: "2026-11-06T13:00:00.000Z" },
    { policyId: "synthetic-daily", durationSeconds: 86400, resetMode: "anchored_recurring", usedCredits: "1", limitCredits: "2", remainingCredits: "1", windowStart: "2026-11-06T00:00:00.000Z", resetsAt: "2026-11-07T00:00:00.000Z" },
  ],
};
const WALLET = { balanceUsd: "12.345", expiresAt: "2027-01-01T00:00:00.000Z", updatedAt: "2026-11-06T09:00:00.000Z", billingScopeVersion: 2, workspaceId: WORKSPACE, workspaceMemberId: "synthetic-member" };
const NOW = Date.parse("2026-11-06T10:00:00.000Z");
const context = { signal: new AbortController().signal, dependencies: {} };

function adapter(routes: Record<string, SessionFetchResult>, seen: SessionFetchOptions[] = []) {
  return createOpenDesignAdapter({
    now: () => NOW,
    readCookie: async () => ({ state: "available", cookie: "synthetic-session=not-real" }),
    fetchJson: async (options) => {
      seen.push(options);
      const key = Object.keys(routes).find((suffix) => options.url.endsWith(suffix));
      return key === undefined ? { outcome: "error", reason: "http-status" } : routes[key] ?? { outcome: "error", reason: "http-status" };
    },
  });
}

const ok = (value: unknown): SessionFetchResult => ({ outcome: "ok", value });

test("bridge: workspace → coding-plan usage + wallet becomes 5h (primary) + weekly windows and facts", async () => {
  const seen: SessionFetchOptions[] = [];
  const record = await adapter({ "/workspaces/current": ok(CURRENT), "/billing/coding-plan-usage": ok(USAGE), "/wallet/balance": ok(WALLET) }, seen).collect(context);
  assert.deepEqual({ ...record }, {
    id: "opendesign",
    state: "ok",
    lastSuccessAt: "2026-11-06T10:00:00.000Z",
    windows: [
      { id: "5h", label: "5h", used: 120, limit: 2000, usedPercent: 6, resetAt: "2026-11-06T13:00:00.000Z" },
      { id: "weekly", label: "Weekly", used: 250, limit: 10000, usedPercent: 2.5, resetAt: "2026-11-10T00:00:00.000Z" },
    ],
    details: { opendesign: { tier: "go", walletBalanceUsd: 12.345 } },
  });
  assert.equal(seen.length, 3);
  assert.ok(seen.slice(1).every((s) => s.headers["x-vela-workspace-id"] === WORKSPACE && s.url.includes(`/workspaces/${WORKSPACE}/`)));
  assert.equal(JSON.stringify(record).includes(WORKSPACE), false, "workspace ID never reaches the record");
  assert.equal(JSON.stringify(record).includes("not-real"), false);
});

test("a failed wallet read keeps the usage windows; a failed usage read does not", async () => {
  const noWallet = await adapter({ "/workspaces/current": ok(CURRENT), "/billing/coding-plan-usage": ok(USAGE) }).collect(context);
  assert.equal(noWallet.state, "ok");
  assert.deepEqual(noWallet.details, { opendesign: { tier: "go" } });
  assert.equal((await adapter({ "/workspaces/current": ok(CURRENT), "/wallet/balance": ok(WALLET) }).collect(context)).state, "error");
  assert.equal((await adapter({ "/workspaces/current": { outcome: "auth-needed" } }).collect(context)).state, "auth-needed");
  assert.equal((await adapter({ "/workspaces/current": ok({ activeWorkspaceId: "../escape" }) }).collect(context)).state, "error");
  assert.equal((await adapter({ "/workspaces/current": ok(CURRENT), "/billing/coding-plan-usage": { outcome: "auth-needed" } }).collect(context)).state, "auth-needed");
});

test("parser: overdrawn windows cap at the limit; garbage and empty recognition are malformed", () => {
  const at = "2026-11-06T10:00:00.000Z";
  const over = parseOpenDesignUsageResponse({ windows: [{ durationSeconds: 18000, usedCredits: "2100", limitCredits: "2000" }] }, undefined, at);
  assert.ok(over.ok);
  if (over.ok) assert.deepEqual(over.record.windows, [{ id: "5h", label: "5h", used: 2000, limit: 2000, usedPercent: 100 }]);
  assert.equal(parseOpenDesignUsageResponse({ windows: [{ durationSeconds: 18000, usedCredits: "x", limitCredits: "2000" }] }, undefined, at).ok, false);
  assert.equal(parseOpenDesignUsageResponse({ windows: "nope" }, undefined, at).ok, false);
  assert.equal(parseOpenDesignUsageResponse({ eligible: false, windows: [] }, undefined, at).ok, false);
  const walletOnly = parseOpenDesignUsageResponse({ eligible: false, windows: [] }, WALLET, at);
  assert.ok(walletOnly.ok, "no active plan still shows a real wallet balance");
});
