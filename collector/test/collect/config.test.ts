import assert from "node:assert/strict";
import test from "node:test";

import {
  CollectorConfigParseError,
  DEFAULT_COLLECTOR_CONFIG,
  parseCollectorConfig,
} from "../../src/collect/config.js";

const SECRET = "synthetic-config-secret-value";

function assertValueFree(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    if (!(error instanceof CollectorConfigParseError)) return false;
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
}

test("defaults to all canonical providers with bounded internal defaults", () => {
  assert.deepEqual(parseCollectorConfig(undefined), DEFAULT_COLLECTOR_CONFIG);
  assertValueFree(() => parseCollectorConfig(null));
});

test("default config enables six registered providers and recognizes seven canonical ids", () => {
  assert.deepEqual(
    DEFAULT_COLLECTOR_CONFIG.providers.map((provider) => [provider.id, provider.enabled]),
    [
      ["claude", true],
      ["codex", true],
      ["grok", true],
      ["kimi", true],
      ["cursor", true],
      ["opencode", true],
      ["commandcode", false],
    ],
  );
});

test("normalizes enabled provider IDs to canonical order", () => {
  assert.deepEqual(parseCollectorConfig({ enabledProviders: ["codex", "claude"] }), {
    providers: [
      { id: "claude", enabled: true },
      { id: "codex", enabled: true },
      { id: "grok", enabled: false },
      { id: "kimi", enabled: false },
      { id: "cursor", enabled: false },
      { id: "opencode", enabled: false },
      { id: "commandcode", enabled: false },
    ],
    timeoutMs: 10_000,
  });
});

test("silently drops umans from enabledProviders", () => {
  const config = parseCollectorConfig({
    enabledProviders: ["claude", "umans", "codex"],
  });
  assert.deepEqual(
    config.providers.filter((provider) => provider.enabled).map((provider) => provider.id),
    ["claude", "codex"],
  );
});

test("umans-only enabledProviders yields all disabled", () => {
  const config = parseCollectorConfig({ enabledProviders: ["umans"] });
  assert.deepEqual(
    config.providers.map((provider) => provider.enabled),
    [false, false, false, false, false, false, false],
  );
});

test("rejects duplicate, unknown, malformed, unsupported, and secret-bearing config", () => {
  const accessor = {} as { enabledProviders?: unknown };
  Object.defineProperty(accessor, "enabledProviders", {
    enumerable: true,
    get: () => ["claude"],
  });
  const cyclic: { enabledProviders?: unknown; self?: unknown } = {
    enabledProviders: ["claude"],
  };
  cyclic.self = cyclic;

  for (const value of [
    { enabledProviders: ["claude", "claude"] },
    { enabledProviders: ["unknown"] },
    { enabledProviders: "claude" },
    { enabledProviders: ["claude"], timeoutMs: 1 },
    { accessToken: SECRET },
    accessor,
    cyclic,
    null,
  ]) {
    assertValueFree(() => parseCollectorConfig(value));
  }
});

test("rejects symbols and hostile proxies without reading secret-shaped values", () => {
  const symbolInput = { enabledProviders: ["claude"] } as Record<PropertyKey, unknown>;
  symbolInput[Symbol("synthetic-symbol")] = SECRET;
  const proxy = new Proxy({}, {
    ownKeys: () => {
      throw new Error(SECRET);
    },
  });

  assertValueFree(() => parseCollectorConfig(symbolInput));
  assertValueFree(() => parseCollectorConfig(proxy));
});
