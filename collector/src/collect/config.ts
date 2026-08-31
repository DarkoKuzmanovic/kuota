import { types } from "node:util";

import { PROVIDER_IDS, type ProviderId } from "../contract/schema-v1.js";
import type { ConfiguredProvider } from "../providers/registry.js";
import type { CollectorConfig } from "./collect.js";

// Providers that have registered adapters in this release. The contract recognizes more IDs
// (PROVIDER_IDS), but the default collector configuration only enables providers with real adapters.
const DEFAULT_ENABLED_PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex", "grok", "kimi", "cursor", "opencode"];

export const DEFAULT_COLLECTOR_CONFIG: Readonly<CollectorConfig> = Object.freeze({
  providers: Object.freeze(
    PROVIDER_IDS.map((id) =>
      Object.freeze({ id, enabled: DEFAULT_ENABLED_PROVIDER_IDS.includes(id) }),
    ),
  ),
  timeoutMs: 10_000,
});

export class CollectorConfigParseError extends Error {
  constructor() {
    super("Invalid collector configuration");
    this.name = "CollectorConfigParseError";
  }
}

const CONFIG_KEYS = new Set(["enabledProviders"]);

function invalidConfig(): never {
  throw new CollectorConfigParseError();
}

function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === "string" &&
    PROVIDER_IDS.some((providerId) => providerId === value)
  );
}

function dataProperties(value: object): Map<PropertyKey, unknown> {
  try {
    if (types.isProxy(value)) invalidConfig();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== Array.prototype) {
      invalidConfig();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const properties = new Map<PropertyKey, unknown>();
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === "symbol") invalidConfig();
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) invalidConfig();
      properties.set(key, descriptor.value);
    }
    return properties;
  } catch (error: unknown) {
    if (error instanceof CollectorConfigParseError) throw error;
    invalidConfig();
  }
}

function parseEnabledProviders(value: unknown): readonly ProviderId[] {
  if (!Array.isArray(value) || types.isProxy(value)) invalidConfig();
  const properties = dataProperties(value);
  if (properties.get("length") !== value.length) invalidConfig();

  const enabled: ProviderId[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const candidate = properties.get(key);
    if (!properties.has(key)) {
      invalidConfig();
    }
    if (candidate === "umans") {
      continue;
    }
    if (!isProviderId(candidate) || enabled.includes(candidate)) {
      invalidConfig();
    }
    enabled.push(candidate);
  }
  if (properties.size !== value.length + 1) invalidConfig();
  return enabled;
}

/**
 * Parses only the secret-free configuration surface approved for the collector.
 * Transport is deliberately outside this parser until the M6 bridge contract.
 */
export function parseCollectorConfig(input: unknown): CollectorConfig {
  if (input === undefined) return DEFAULT_COLLECTOR_CONFIG;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    invalidConfig();
  }

  const properties = dataProperties(input);
  if (properties.size !== 1 || !properties.has("enabledProviders")) invalidConfig();
  for (const key of properties.keys()) {
    if (typeof key !== "string" || !CONFIG_KEYS.has(key)) invalidConfig();
  }

  const enabled = parseEnabledProviders(properties.get("enabledProviders"));
  const enabledSet = new Set(enabled);
  const providers: ConfiguredProvider[] = PROVIDER_IDS.map((id) =>
    Object.freeze({ id, enabled: enabledSet.has(id) }),
  );
  // Preserve deterministic canonical order while restricting default-enabled providers to those
  // with registered adapters. Explicit config may enable any recognized provider ID.
  return Object.freeze({ providers: Object.freeze(providers), timeoutMs: 10_000 });
}
