import {
  PROVIDER_IDS,
  type ProviderId,
} from "../contract/schema-v1.js";
import {
  createNormalizedProviderResult,
  type AnyProviderAdapter,
  type ProviderAdapter,
  type ProviderAdapterContext,
} from "./types.js";
import { createClaudeAdapter } from "./claude/adapter.js";
import { createCodexAdapter } from "./codex/adapter.js";

export interface ConfiguredProvider {
  readonly id: string;
  readonly enabled: boolean;
}

export type RegisteredProviderAdapter = AnyProviderAdapter;

export type ProviderRegistrationFor<TId extends ProviderId> = {
  readonly id: TId;
  readonly adapter: ProviderAdapter<TId>;
};

export type ProviderRegistration = {
  [TId in ProviderId]: ProviderRegistrationFor<TId>;
}[ProviderId];

export function createProviderRegistration<TId extends ProviderId>(
  adapter: ProviderAdapter<TId>,
): ProviderRegistrationFor<TId> {
  return { id: adapter.id, adapter };
}

export type ProviderRegistryErrorCode =
  | "unknown-provider"
  | "unknown-registration"
  | "duplicate-configuration"
  | "duplicate-registration"
  | "mismatched-registration"
  | "unregistered-provider";

const REGISTRY_ERROR_MESSAGES: Readonly<
  Record<ProviderRegistryErrorCode, string>
> = {
  "unknown-provider": "Unknown provider identifier",
  "unknown-registration": "Unknown provider registration",
  "duplicate-configuration": "Duplicate provider configuration",
  "duplicate-registration": "Duplicate provider registration",
  "mismatched-registration": "Mismatched provider registration",
  "unregistered-provider": "Provider is not registered",
};

/** Registry failures contain a category only; no supplied ID is echoed. */
export class ProviderRegistryError extends Error {
  readonly code: ProviderRegistryErrorCode;

  constructor(code: ProviderRegistryErrorCode) {
    super(REGISTRY_ERROR_MESSAGES[code]);
    this.name = "ProviderRegistryError";
    this.code = code;
  }
}

function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === "string" &&
    PROVIDER_IDS.some((providerId) => providerId === value)
  );
}

function placeholderFor<TId extends ProviderId>(
  id: TId,
): ProviderAdapter<TId> {
  return {
    id,
    async collect(
      _context: ProviderAdapterContext,
    ) {
      return createNormalizedProviderResult(id, {
        id,
        state: "error",
        status: "Provider adapter unavailable",
      });
    },
  };
}

/** Claude and Codex are real; Umans remains an isolated placeholder until M4. */
export const CLAUDE_ADAPTER = createClaudeAdapter();
const UMANS_PLACEHOLDER_ADAPTER = placeholderFor("umans");
export const CODEX_ADAPTER = createCodexAdapter();

/** Legacy name retained for collector test seams; only its peer entries are placeholders. */
export const PLACEHOLDER_ADAPTERS = [
  CLAUDE_ADAPTER,
  UMANS_PLACEHOLDER_ADAPTER,
  CODEX_ADAPTER,
] as const satisfies readonly RegisteredProviderAdapter[];

const CLAUDE_REGISTRATION = createProviderRegistration(CLAUDE_ADAPTER);
const UMANS_PLACEHOLDER_REGISTRATION = createProviderRegistration(
  UMANS_PLACEHOLDER_ADAPTER,
);
const CODEX_REGISTRATION = createProviderRegistration(CODEX_ADAPTER);

export const PLACEHOLDER_PROVIDER_REGISTRATIONS = [
  CLAUDE_REGISTRATION,
  UMANS_PLACEHOLDER_REGISTRATION,
  CODEX_REGISTRATION,
] as const satisfies readonly ProviderRegistration[];

export class ProviderRegistry {
  readonly adapters: readonly RegisteredProviderAdapter[];
  private readonly adaptersById: ReadonlyMap<ProviderId, AnyProviderAdapter>;

  constructor(registrations: readonly ProviderRegistration[]) {
    const adaptersById = new Map<ProviderId, AnyProviderAdapter>();
    for (const registration of registrations) {
      if (!isProviderId(registration.id)) {
        throw new ProviderRegistryError("unknown-registration");
      }
      if (adaptersById.has(registration.id)) {
        throw new ProviderRegistryError("duplicate-registration");
      }
      if (registration.adapter.id !== registration.id) {
        throw new ProviderRegistryError("mismatched-registration");
      }
      adaptersById.set(registration.id, registration.adapter);
    }

    const canonicalAdapters: RegisteredProviderAdapter[] = [];
    for (const id of PROVIDER_IDS) {
      const adapter = adaptersById.get(id);
      if (adapter !== undefined) {
        canonicalAdapters.push(adapter);
      }
    }

    this.adapters = canonicalAdapters;
    this.adaptersById = adaptersById;
  }

  /**
   * Validates every configured entry, then returns enabled adapters in
   * canonical Claude, Umans, Codex order.
   */
  selectEnabled(
    configuredProviders: readonly ConfiguredProvider[],
  ): readonly RegisteredProviderAdapter[] {
    const configuredById = new Map<ProviderId, boolean>();
    for (const configuredProvider of configuredProviders) {
      if (!isProviderId(configuredProvider.id)) {
        throw new ProviderRegistryError("unknown-provider");
      }
      if (configuredById.has(configuredProvider.id)) {
        throw new ProviderRegistryError("duplicate-configuration");
      }
      if (!this.adaptersById.has(configuredProvider.id)) {
        throw new ProviderRegistryError("unregistered-provider");
      }
      configuredById.set(configuredProvider.id, configuredProvider.enabled);
    }

    const selected: RegisteredProviderAdapter[] = [];
    for (const id of PROVIDER_IDS) {
      if (configuredById.get(id) !== true) {
        continue;
      }
      const adapter = this.adaptersById.get(id);
      if (adapter !== undefined) {
        selected.push(adapter);
      }
    }
    return Object.freeze(selected);
  }
}

export function createProviderRegistry(
  registrations: readonly ProviderRegistration[] =
    PLACEHOLDER_PROVIDER_REGISTRATIONS,
): ProviderRegistry {
  return new ProviderRegistry(registrations);
}
