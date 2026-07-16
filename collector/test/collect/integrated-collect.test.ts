import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCollectorCacheEnvelope, writeCollectorCache } from "../../src/collect/cache.js";
import { collectIntegrated } from "../../src/collect/integrated-collect.js";
import { acquireCollectorLock } from "../../src/collect/lock.js";
import { createProviderRegistration, createProviderRegistry } from "../../src/providers/registry.js";
import { createNormalizedProviderResult, type ProviderAdapter } from "../../src/providers/types.js";
import type { ProviderId } from "../../src/contract/schema-v1.js";

const NOW = "2026-07-13T12:00:00.000Z";

async function syntheticHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "kuota-integrated-"));
  await mkdir(join(home, ".cache"), { mode: 0o700 });
  return home;
}

function adapter<TId extends ProviderId>(id: TId, fail = false): ProviderAdapter<TId> {
  return {
    id,
    async collect() {
      if (fail) throw new Error("synthetic provider failure");
      return createNormalizedProviderResult(id, {
        id,
        state: "ok",
        lastSuccessAt: NOW,
        windows: [{ id: "usage", label: "Usage", used: 1 }],
      });
    },
  };
}

function registry(failClaude = false) {
  return createProviderRegistry([
    createProviderRegistration(adapter("claude", failClaude)),
    createProviderRegistration(adapter("umans")),
    createProviderRegistration(adapter("codex")),
  ]);
}

const config = {
  providers: [
    { id: "claude", enabled: true },
    { id: "umans", enabled: true },
    { id: "codex", enabled: true },
  ],
  timeoutMs: 100,
} as const;

test("collects every enabled adapter, validates canonical records, and persists LKG only after a valid merge", async () => {
  const home = await syntheticHome();
  try {
    const document = await collectIntegrated({ homeDirectory: home, registry: registry(), config });
    assert.deepEqual(document.providers.map((provider) => provider.id), ["claude", "umans", "codex"]);
    assert.deepEqual(document.providers.map((provider) => provider.state), ["ok", "ok", "ok"]);
    const fallback = await collectIntegrated({ homeDirectory: home, registry: registry(true), config });
    assert.equal(fallback.providers[0]?.state, "stale");
    assert.equal(fallback.providers[1]?.state, "ok");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("does not call adapters during active lock contention and serves LKG as stale", async () => {
  const home = await syntheticHome();
  let calls = 0;
  try {
    const cached = createCollectorCacheEnvelope(NOW, [
      createNormalizedProviderResult("claude", {
        id: "claude", state: "ok", lastSuccessAt: NOW,
        windows: [{ id: "usage", label: "Usage", used: 1 }],
      }),
    ]);
    assert.ok(cached !== undefined);
    await writeCollectorCache(cached, { homeDirectory: home });
    const lock = await acquireCollectorLock({ homeDirectory: home });
    assert.equal(lock.state, "acquired");
    const denied = await collectIntegrated({
      homeDirectory: home,
      config,
      registry: createProviderRegistry([
        createProviderRegistration({
          id: "claude",
          async collect() {
            calls += 1;
            return createNormalizedProviderResult("claude", {
              id: "claude",
              state: "ok",
              lastSuccessAt: NOW,
              windows: [{ id: "usage", label: "Usage", used: 1 }],
            });
          },
        }),
        createProviderRegistration(adapter("umans")),
        createProviderRegistration(adapter("codex")),
      ]),
    });
    assert.equal(calls, 0);
    assert.deepEqual(denied.providers.map((provider) => provider.state), ["stale", "error", "error"]);
    if (lock.state === "acquired") await lock.release();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
