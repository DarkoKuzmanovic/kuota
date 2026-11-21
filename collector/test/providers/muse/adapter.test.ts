import assert from "node:assert/strict";
import test from "node:test";
import { createMuseAdapter, MUSE_COOKIE_SPEC } from "../../../src/providers/muse/adapter.js";
import { parseMuseUsageResponse } from "../../../src/providers/muse/usage.js";
import type { SessionFetchOptions, SessionFetchResult } from "../../../src/providers/session-fetch.js";

import { fetchSessionJson, type SessionFetchSeam } from "../../../src/providers/session-fetch.js";
const context = { signal: new AbortController().signal, dependencies: {} };
const now = Date.parse("2026-11-22T00:00:00.000Z");
const quota = { subscription_quota: { tier: "Pro", window_weighted_used: "12.5", window_weighted_limit: "50", window_duration_secs: 18000, window_resets_at: 1795341600, weekly_weighted_used: 8, weekly_weighted_limit: 100, weekly_resets_at: 1795860000 } };
const ok = (value: unknown): SessionFetchResult => ({ outcome: "ok", value });
const error: SessionFetchResult = { outcome: "error", reason: "http-status" };
function adapter(teams: SessionFetchResult, quotas: Record<string, SessionFetchResult>, calls: SessionFetchOptions[] = []) {
  return createMuseAdapter({ now: () => now, readCookie: async () => ({ state: "available", cookie: "llama_dev_sess=synthetic-not-real" }), fetchJson: async (request) => {
    calls.push(request);
    if (request.url.endsWith("/teams")) return teams;
    const id = request.url.split("/").at(-2) ?? "";
    return quotas[id] ?? error;
  } });
}

test("fetch to parser bridge normalizes real-shaped synthetic quota without exposing team or cookie", async () => {
  const calls: SessionFetchOptions[] = [];
  const record = await adapter(ok({ teams: [{ team_id: 12345 }] }), { "12345": ok(quota) }, calls).collect(context);
  assert.deepEqual(record, { id: "muse", state: "ok", lastSuccessAt: new Date(now).toISOString(), windows: [
    { id: "current", label: "5-hour", usedPercent: 25, resetAt: new Date(1795341600 * 1000).toISOString(), durationSeconds: 18000 },
    { id: "weekly", label: "Weekly", usedPercent: 8, resetAt: new Date(1795860000 * 1000).toISOString() },
  ], details: { muse: { tier: "Pro" } } });
  assert.equal(calls.length, 2);
  assert.ok(calls[1]?.url.endsWith("/teams/12345/subscription-quota"));
  assert.equal(JSON.stringify(record).includes("12345"), false);
  assert.equal(JSON.stringify(record).includes("not-real"), false);
  assert.equal(MUSE_COOKIE_SPEC.namePattern, "llama_dev_sess");
  assert.equal(MUSE_COOKIE_SPEC.envKey, "MUSE_SESSION_COOKIE");
});

test("parser omits missing and invalid optional values and caps over-limit percentage", () => {
  const parsed = parseMuseUsageResponse({ subscription_quota: { window_weighted_used: "22", window_weighted_limit: "10", window_duration_secs: 3599, weekly_weighted_used: "invalid", weekly_weighted_limit: 0 } }, new Date(now).toISOString());
  assert.ok(parsed.ok);
  if (parsed.ok) assert.deepEqual(parsed.record.windows, [{ id: "current", label: "Current window", usedPercent: 100, durationSeconds: 3599 }]);
  assert.equal(parseMuseUsageResponse({ subscription_quota: {} }, new Date(now).toISOString()).ok, false);

  assert.equal(parseMuseUsageResponse({ subscription_quota: null }, new Date(now).toISOString()).ok, false);
});
test("real session fetch decodes the synthetic wire response into the real parser", async () => {
  const requests: string[] = [];
  const transport: SessionFetchSeam = async (url, init) => {
    requests.push(url);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.Cookie, "llama_dev_sess=synthetic-not-real");
    const body = JSON.stringify(url.endsWith("/teams") ? { teams: [{ team_id: 12345 }] } : quota);
    let sent = false;
    return { status: 200, headers: { get: () => null }, body: { getReader: () => ({
      read: async () => {
        if (sent) return { done: true };
        sent = true;
        return { done: false, value: new TextEncoder().encode(body) };
      },
    }) } };
  };
  const realFetch = createMuseAdapter({
    now: () => now,
    readCookie: async () => ({ state: "available", cookie: "llama_dev_sess=synthetic-not-real" }),
    fetchJson: (options) => fetchSessionJson({ ...options, fetch: transport }),
  });
  const record = await realFetch.collect(context);
  assert.equal(record.state, "ok");
  assert.equal(record.windows?.[0]?.usedPercent, 25);
  assert.equal(record.windows?.[1]?.usedPercent, 8);
  assert.equal(record.windows?.[0]?.durationSeconds, 18000);
  assert.equal(record.windows?.[1]?.durationSeconds, undefined);
  assert.equal(requests.length, 2);
});

test("multiple teams require exactly one quota and bounded complete probes", async () => {
  const teams = ok({ teams: [{ team_id: 1 }, { team_id: "2" }] });
  assert.equal((await adapter(teams, { "1": ok({ subscription_quota: null }), "2": ok(quota) }).collect(context)).state, "ok");
  assert.equal((await adapter(teams, { "1": ok(quota), "2": ok(quota) }).collect(context)).state, "error");
  assert.equal((await adapter(teams, { "1": ok(quota), "2": error }).collect(context)).state, "error");
  assert.equal((await adapter(teams, { "1": ok(quota), "2": { outcome: "auth-needed" } }).collect(context)).state, "auth-needed");
  const calls: SessionFetchOptions[] = [];
  assert.equal((await adapter(ok({ teams: Array.from({ length: 6 }, (_, i) => ({ team_id: i + 1 })) }), {}, calls).collect(context)).state, "error");
  assert.equal(calls.length, 1);
});

test("no teams, invalid IDs and network errors are errors; rejected auth is auth-needed", async () => {
  assert.equal((await adapter(ok({ teams: [] }), {}).collect(context)).state, "error");
  assert.equal((await adapter(ok({ teams: [{ team_id: "../escape" }] }), {}).collect(context)).state, "error");
  assert.equal((await adapter(error, {}).collect(context)).state, "error");
  assert.equal((await adapter({ outcome: "auth-needed" }, {}).collect(context)).state, "auth-needed");
  const noCookie = createMuseAdapter({ readCookie: async () => ({ state: "auth-needed" }) });
  assert.equal((await noCookie.collect(context)).state, "auth-needed");
});
