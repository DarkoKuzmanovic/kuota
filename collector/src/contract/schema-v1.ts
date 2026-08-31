export const SCHEMA_VERSION = 2 as const;

export const PROVIDER_IDS = ["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_STATES = ["ok", "stale", "auth-needed", "error"] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];

export interface UsageWindow {
  readonly id: string;
  readonly label: string;
  readonly usedPercent?: number;
  readonly used?: number;
  readonly limit?: number;
  readonly resetAt?: string;
}

export interface ClaudeDetails {
  readonly model?: string;
  readonly tokens?: number;
  readonly extraUsageEnabled?: boolean;
  readonly extraUsageUsedCredits?: number;
  readonly extraUsageMonthlyLimit?: number;
  readonly extraUsageCurrency?: string;
  readonly extraUsageDecimalPlaces?: number;
  readonly extraUsageDisabledReason?: string;
}

export interface CodexDetails {
  readonly plan?: string;
  readonly credits?: number;
  readonly cost?: number;
  readonly tokens?: number;
}

export interface GrokDetails {
  readonly monthlyUsed?: number;
  readonly monthlyLimit?: number;
  readonly monthlyResetAt?: string;
}

export interface KimiDetails {
  readonly concurrency?: number;
  readonly concurrencyLimit?: number;
}

export interface CursorDetails {
  readonly membershipType?: string;
  readonly onDemandUsed?: number;
  readonly onDemandLimit?: number;
  readonly autoPercentUsed?: number;
  readonly apiPercentUsed?: number;
  readonly totalPercentUsed?: number;
}

export interface CommandCodeDetails {
  readonly monthlyCredits?: number;
  readonly purchasedCredits?: number;
  readonly freeCredits?: number;
  readonly planName?: string;
  readonly exceeded?: boolean;
  readonly weeklyExceeded?: boolean;
}

type ClaudeProviderDetails = { readonly claude: ClaudeDetails };
type CodexProviderDetails = { readonly codex: CodexDetails };
type GrokProviderDetails = { readonly grok: GrokDetails };
type KimiProviderDetails = { readonly kimi: KimiDetails };
type CursorProviderDetails = { readonly cursor: CursorDetails };
type CommandCodeProviderDetails = { readonly commandcode: CommandCodeDetails };

export type ProviderDetails =
  | ClaudeProviderDetails
  | CodexProviderDetails
  | GrokProviderDetails
  | KimiProviderDetails
  | CursorProviderDetails
  | CommandCodeProviderDetails;

type NonEmptyClaudeDetails =
  | (ClaudeDetails & { readonly model: string })
  | (ClaudeDetails & { readonly tokens: number })
  | (ClaudeDetails & { readonly extraUsageEnabled: boolean })
  | (ClaudeDetails & { readonly extraUsageUsedCredits: number })
  | (ClaudeDetails & { readonly extraUsageMonthlyLimit: number })
  | (ClaudeDetails & { readonly extraUsageCurrency: string })
  | (ClaudeDetails & { readonly extraUsageDecimalPlaces: number })
  | (ClaudeDetails & { readonly extraUsageDisabledReason: string });
type NonEmptyCodexDetails =
  | { readonly plan: string; readonly credits?: number; readonly cost?: number; readonly tokens?: number }
  | { readonly plan?: string; readonly credits: number; readonly cost?: number; readonly tokens?: number }
  | { readonly plan?: string; readonly credits?: number; readonly cost: number; readonly tokens?: number }
  | { readonly plan?: string; readonly credits?: number; readonly cost?: number; readonly tokens: number };
type NonEmptyGrokDetails = { readonly monthlyUsed?: number; readonly monthlyLimit?: number; readonly monthlyResetAt?: string } & (
  | { readonly monthlyUsed: number }
  | { readonly monthlyLimit: number }
  | { readonly monthlyResetAt: string }
);
type NonEmptyKimiDetails = { readonly concurrency?: number; readonly concurrencyLimit?: number } & (
  | { readonly concurrency: number }
  | { readonly concurrencyLimit: number }
);
type NonEmptyCursorDetails = {
  readonly membershipType?: string;
  readonly onDemandUsed?: number;
  readonly onDemandLimit?: number;
  readonly autoPercentUsed?: number;
  readonly apiPercentUsed?: number;
  readonly totalPercentUsed?: number;
} & (
  | { readonly membershipType: string }
  | { readonly onDemandUsed: number }
  | { readonly onDemandLimit: number }
  | { readonly autoPercentUsed: number }
  | { readonly apiPercentUsed: number }
  | { readonly totalPercentUsed: number }
);
type NonEmptyCommandCodeDetails = {
  readonly monthlyCredits?: number;
  readonly purchasedCredits?: number;
  readonly freeCredits?: number;
  readonly planName?: string;
  readonly exceeded?: boolean;
  readonly weeklyExceeded?: boolean;
} & (
  | { readonly monthlyCredits: number }
  | { readonly purchasedCredits: number }
  | { readonly freeCredits: number }
  | { readonly planName: string }
  | { readonly exceeded: boolean }
  | { readonly weeklyExceeded: boolean }
);

type NonEmptyProviderDetails =
  | { readonly claude: NonEmptyClaudeDetails }
  | { readonly codex: NonEmptyCodexDetails }
  | { readonly grok: NonEmptyGrokDetails }
  | { readonly kimi: NonEmptyKimiDetails }
  | { readonly cursor: NonEmptyCursorDetails }
  | { readonly commandcode: NonEmptyCommandCodeDetails };

interface ProviderRecordFields {
  readonly status?: string;
  readonly lastSuccessAt?: string;
  readonly windows?: readonly UsageWindow[];
}

type CurrentProviderRecord<
  TId extends ProviderId,
  TDetails extends ProviderDetails,
> = ProviderRecordFields & {
  readonly id: TId;
  readonly state: Exclude<ProviderState, "stale">;
  readonly details?: TDetails;
};

type StaleProviderRecord<
  TId extends ProviderId,
  TDetails extends ProviderDetails,
  TNonEmptyDetails extends NonEmptyProviderDetails,
> = ProviderRecordFields & {
  readonly id: TId;
  readonly state: "stale";
  readonly lastSuccessAt: string;
} & (
    | {
        readonly windows: readonly [UsageWindow, ...UsageWindow[]];
        readonly details?: TDetails;
      }
    | {
        readonly windows?: readonly [];
        readonly details: TNonEmptyDetails;
      }
  );

export type ClaudeProviderRecord =
  | CurrentProviderRecord<"claude", ClaudeProviderDetails>
  | StaleProviderRecord<"claude", ClaudeProviderDetails, { readonly claude: NonEmptyClaudeDetails }>;

export type CodexProviderRecord =
  | CurrentProviderRecord<"codex", CodexProviderDetails>
  | StaleProviderRecord<"codex", CodexProviderDetails, { readonly codex: NonEmptyCodexDetails }>;

export type GrokProviderRecord =
  | CurrentProviderRecord<"grok", GrokProviderDetails>
  | StaleProviderRecord<"grok", GrokProviderDetails, { readonly grok: NonEmptyGrokDetails }>;

export type KimiProviderRecord =
  | CurrentProviderRecord<"kimi", KimiProviderDetails>
  | StaleProviderRecord<"kimi", KimiProviderDetails, { readonly kimi: NonEmptyKimiDetails }>;

export type CursorProviderRecord =
  | CurrentProviderRecord<"cursor", CursorProviderDetails>
  | StaleProviderRecord<"cursor", CursorProviderDetails, { readonly cursor: NonEmptyCursorDetails }>;

/**
 * OpenCode records carry windows only — the wire exposes no detail facts, so
 * the provider deliberately has NO details namespace (the runtime validator
 * rejects any details object on an opencode record).
 */
export type OpenCodeProviderRecord =
  | CurrentProviderRecord<"opencode", never>
  | StaleProviderRecord<"opencode", never, never>;

export type CommandCodeProviderRecord =
  | CurrentProviderRecord<"commandcode", CommandCodeProviderDetails>
  | StaleProviderRecord<"commandcode", CommandCodeProviderDetails, { readonly commandcode: NonEmptyCommandCodeDetails }>;

export type ProviderRecord =
  | ClaudeProviderRecord
  | CodexProviderRecord
  | GrokProviderRecord
  | KimiProviderRecord
  | CursorProviderRecord
  | OpenCodeProviderRecord
  | CommandCodeProviderRecord;

export type ProviderRecordFor<TId extends ProviderId> = Extract<
  ProviderRecord,
  { readonly id: TId }
>;

// Static assertions: ensure each ProviderId maps to a ProviderRecord with matching details namespace.
// These are compile-time checks that the union stays consistent as providers are added.
type _AssertProviderRecordFor<TId extends ProviderId> = ProviderRecordFor<TId> extends { readonly id: TId } ? true : never;
type _AssertClaude = _AssertProviderRecordFor<"claude">;
type _AssertCodex = _AssertProviderRecordFor<"codex">;
type _AssertGrok = _AssertProviderRecordFor<"grok">;
type _AssertKimi = _AssertProviderRecordFor<"kimi">;
type _AssertCursor = _AssertProviderRecordFor<"cursor">;
type _AssertOpencode = _AssertProviderRecordFor<"opencode">;
type _AssertCommandcode = _AssertProviderRecordFor<"commandcode">;

export interface CollectorDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly collectionStartedAt: string;
  readonly collectionFinishedAt: string;
  readonly providers: readonly ProviderRecord[];
}
