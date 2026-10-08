import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCliArgv } from "../../src/cli.js";
import { parseCollectorConfig } from "../../src/collect/config.js";
import { collectIntegrated } from "../../src/collect/integrated-collect.js";
import { acquireCollectorLock } from "../../src/collect/lock.js";
import { readCollectorCache } from "../../src/collect/cache.js";
import { PROVIDER_IDS, type ProviderId } from "../../src/contract/schema-v1.js";
import { createProviderRegistration, createProviderRegistry } from "../../src/providers/registry.js";
import { createClaudeAdapter } from "../../src/providers/claude/adapter.js";
import { createCodexAdapter } from "../../src/providers/codex/adapter.js";
import { createGrokAdapter } from "../../src/providers/grok/adapter.js";
import { createKimiAdapter } from "../../src/providers/kimi/adapter.js";
import { createCursorAdapter } from "../../src/providers/cursor/adapter.js";
import { createOpencodeAdapter } from "../../src/providers/opencode/adapter.js";
import { createCommandCodeAdapter } from "../../src/providers/commandcode/adapter.js";

const NOW = "2026-09-09T00:00:00.000Z";
function success<TId extends ProviderId>(id: TId) {
  return { id, state: "ok" as const, lastSuccessAt: NOW,
    windows: [{ id: "synthetic-usage", label: "Synthetic usage", used: 1 }] };
}

// Real policy adapters and real CLI/config/registry/collector/lock/cache paths.
// Every auth/HTTP/provider-cache mechanism is replaced by an inert synthetic
// seam. Counters contain provider IDs and operation names, never credentials.
function spiedRegistry() {
  const calls = new Map<string, number>();
  let failFetch = false;
  function spy<const T>(id: ProviderId, operation: string, value: T) {
    return async () => {
      const key = `${id}:${operation}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      if (operation === "fetch" && failFetch) throw new Error("Synthetic fetch unavailable");
      return value;
    };
  }
  const now = () => Date.parse(NOW);
  const resolveAuthPath = () => "/synthetic-issue7-unused/auth.json";
  let unexpected = 0;
  const never = async (): Promise<never> => {
    unexpected += 1;
    throw new Error("Unexpected synthetic mechanism call");
  };
  const registry = createProviderRegistry([
    createProviderRegistration(createClaudeAdapter({
      now,
      readBackoff: spy("claude", "backoff", { state: "missing" }),
      readCache: spy("claude", "cache", { state: "missing", status: "No cached usage" }),
      readAuth: spy("claude", "auth", { state: "available", status: "Credential available", credential: { access: "synthetic-issue7-not-real" } }),
      fetchUsage: spy("claude", "fetch", { outcome: "ok", status: "Usage updated", record: success("claude") }),
      writeCache: spy("claude", "write-cache", { state: "written", status: "Cached usage stored" }),
      clearBackoff: spy("claude", "clear-backoff", { state: "cleared" }),
      writeBackoff: never,
    })),
    createProviderRegistration(createCodexAdapter({
      now, resolveAuthPath,
      readAuth: spy("codex", "auth", { state: "available", status: "Credential available", credential: { access: "synthetic-issue7-not-real", accountId: "synthetic-issue7-account" } }),
      fetchUsage: spy("codex", "fetch", { outcome: "ok", value: {} }),
      parseUsage: () => ({ ok: true, record: success("codex") }),
      curlUsage: never, refresh: never, persist: never,
    })),
    createProviderRegistration(createGrokAdapter({
      now, resolveAuthPath,
      readAuth: spy("grok", "auth", { state: "available", credential: { kind: "oauth", value: "synthetic-issue7-not-real" } }),
      fetchUsage: spy("grok", "fetch", { outcome: "ok", value: { monthly: {} } }),
      parseUsage: () => ({ ok: true, record: success("grok") }),
    })),
    createProviderRegistration(createKimiAdapter({
      now, resolveAuthPath,
      readAuth: spy("kimi", "auth", { state: "available", credential: { kind: "oauth", value: "synthetic-issue7-not-real" } }),
      fetchUsage: spy("kimi", "fetch", { outcome: "ok", value: {} }),
      parseUsage: () => ({ ok: true, record: success("kimi") }),
    })),
    createProviderRegistration(createCursorAdapter({
      now,
      readAuth: spy("cursor", "auth", { state: "available", credential: { kind: "session", value: "synthetic-issue7-not-real" } }),
      fetchUsage: spy("cursor", "fetch", { outcome: "ok", value: {} }),
      parseUsage: () => ({ ok: true, record: success("cursor") }),
    })),
    createProviderRegistration(createOpencodeAdapter({
      now, resolveAuthPath,
      readAuth: spy("opencode", "auth", { state: "available", credential: { kind: "api-key", value: "synthetic-issue7-not-real" } }),
      fetchUsage: spy("opencode", "fetch", { outcome: "ok", value: {} }),
      parseUsage: () => ({ ok: true, record: success("opencode") }),
    })),
    createProviderRegistration(createCommandCodeAdapter({
      now, resolveAuthPath,
      readAuth: spy("commandcode", "auth", { state: "available", credential: { kind: "oauth", value: "synthetic-issue7-not-real" } }),
      fetchUsage: spy("commandcode", "fetch", { outcome: "ok", value: {} }),
      fetchSubscription: spy("commandcode", "subscription", { outcome: "ok", value: {} }),
      parseUsage: () => ({ ok: true, record: success("commandcode") }),
    })),
  ]);
  return {
    registry,
    reset() { calls.clear(); },
    setFetchFailure(value: boolean) { failFetch = value; },
    assertWork(selected: readonly ProviderId[]) {
      assert.equal(unexpected, 0);
      for (const id of PROVIDER_IDS) {
        const expected = selected.includes(id) ? 1 : 0;
        assert.equal(calls.get(`${id}:auth`) ?? 0, expected, `${id} auth discovery`);
        assert.equal(calls.get(`${id}:fetch`) ?? 0, expected, `${id} fetch`);
        if (expected === 0) {
          assert.equal([...calls.keys()].some((key) => key.startsWith(`${id}:`)), false, `${id} any work`);
        }
      }
      assert.equal(calls.get("commandcode:subscription") ?? 0, selected.includes("commandcode") && !failFetch ? 1 : 0);
    },
  };
}

const selections: readonly (readonly ProviderId[])[] = [["commandcode", "claude"], ["cursor", "codex"], []];
for (const selected of selections) {
  test(`explicit CLI subset ${selected.join(",") || "empty"} scopes real integrated auth/fetch and shared cache/lock fallback`, async () => {
    const home = await mkdtemp(join(tmpdir(), "kuota-issue7-synthetic-"));
    await mkdir(join(home, ".cache"), { mode: 0o700 });
    const spies = spiedRegistry();
    const canonical = PROVIDER_IDS.filter((id) => selected.includes(id));
    const config = parseCollectorConfig(parseCliArgv([`--enabled-providers=${selected.join(",")}`]));
    try {
      // Positive control exercises every synthetic mechanism and seeds hidden
      // LKG records exactly as a different widget instance could have done.
      const all = await collectIntegrated({ homeDirectory: home, registry: spies.registry });
      assert.deepEqual(all.providers.map((p) => p.id), PROVIDER_IDS);
      assert.ok(all.providers.every((p) => p.state === "ok"));
      spies.assertWork(PROVIDER_IDS);
      spies.reset();

      const live = await collectIntegrated({ homeDirectory: home, registry: spies.registry, config });
      assert.deepEqual(live.providers.map((p) => p.id), canonical);
      assert.ok(live.providers.every((p) => p.state === "ok"));
      spies.assertWork(selected);
      const cache = await readCollectorCache({ homeDirectory: home });
      assert.equal(cache.state, "available");
      if (cache.state === "available") {
        assert.deepEqual(cache.envelope.records.map((p) => p.id), PROVIDER_IDS);
      }
      spies.reset();

      spies.setFetchFailure(true);
      const retained = await collectIntegrated({ homeDirectory: home, registry: spies.registry, config });
      assert.deepEqual(retained.providers.map((p) => p.id), canonical);
      assert.ok(retained.providers.every((p) => p.state === "stale"));
      spies.assertWork(selected);
      spies.setFetchFailure(false);
      spies.reset();

      const lock = await acquireCollectorLock({ homeDirectory: home });
      assert.equal(lock.state, "acquired");
      if (lock.state !== "acquired") return;
      try {
        const fallback = await collectIntegrated({ homeDirectory: home, registry: spies.registry, config });
        assert.deepEqual(fallback.providers.map((p) => p.id), canonical);
        assert.ok(fallback.providers.every((p) => p.state === "stale"));
        spies.assertWork([]);
      } finally {
        await lock.release();
      }
      // Completion actually released the shared lock; this invocation can do
      // work again and still cannot reintroduce hidden cached providers.
      const after = await collectIntegrated({ homeDirectory: home, registry: spies.registry, config });
      assert.deepEqual(after.providers.map((p) => p.id), canonical);
      spies.assertWork(selected);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}
