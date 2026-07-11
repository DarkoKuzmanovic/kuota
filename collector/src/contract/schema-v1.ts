export const SCHEMA_VERSION = 1 as const;

export const PROVIDER_IDS = ["claude", "umans", "codex"] as const;
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

export interface UmansDetails {
  readonly plan?: string;
  readonly requests?: number;
  readonly concurrency?: number;
}

export interface CodexDetails {
  readonly plan?: string;
  readonly credits?: number;
  readonly cost?: number;
  readonly tokens?: number;
}

type ClaudeProviderDetails = { readonly claude: ClaudeDetails };
type UmansProviderDetails = { readonly umans: UmansDetails };
type CodexProviderDetails = { readonly codex: CodexDetails };

export type ProviderDetails =
  | ClaudeProviderDetails
  | UmansProviderDetails
  | CodexProviderDetails;

type NonEmptyClaudeDetails =
  | (ClaudeDetails & { readonly model: string })
  | (ClaudeDetails & { readonly tokens: number })
  | (ClaudeDetails & { readonly extraUsageEnabled: boolean })
  | (ClaudeDetails & { readonly extraUsageUsedCredits: number })
  | (ClaudeDetails & { readonly extraUsageMonthlyLimit: number })
  | (ClaudeDetails & { readonly extraUsageCurrency: string })
  | (ClaudeDetails & { readonly extraUsageDecimalPlaces: number })
  | (ClaudeDetails & { readonly extraUsageDisabledReason: string });
type NonEmptyUmansDetails =
  | { readonly plan: string; readonly requests?: number; readonly concurrency?: number }
  | { readonly plan?: string; readonly requests: number; readonly concurrency?: number }
  | { readonly plan?: string; readonly requests?: number; readonly concurrency: number };
type NonEmptyCodexDetails =
  | { readonly plan: string; readonly credits?: number; readonly cost?: number; readonly tokens?: number }
  | { readonly plan?: string; readonly credits: number; readonly cost?: number; readonly tokens?: number }
  | { readonly plan?: string; readonly credits?: number; readonly cost: number; readonly tokens?: number }
  | { readonly plan?: string; readonly credits?: number; readonly cost?: number; readonly tokens: number };

type NonEmptyProviderDetails =
  | { readonly claude: NonEmptyClaudeDetails }
  | { readonly umans: NonEmptyUmansDetails }
  | { readonly codex: NonEmptyCodexDetails };

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

export type UmansProviderRecord =
  | CurrentProviderRecord<"umans", UmansProviderDetails>
  | StaleProviderRecord<"umans", UmansProviderDetails, { readonly umans: NonEmptyUmansDetails }>;

export type CodexProviderRecord =
  | CurrentProviderRecord<"codex", CodexProviderDetails>
  | StaleProviderRecord<"codex", CodexProviderDetails, { readonly codex: NonEmptyCodexDetails }>;

export type ProviderRecord =
  | ClaudeProviderRecord
  | UmansProviderRecord
  | CodexProviderRecord;

export type ProviderRecordFor<TId extends ProviderId> = Extract<
  ProviderRecord,
  { readonly id: TId }
>;

export interface CollectorDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly collectionStartedAt: string;
  readonly collectionFinishedAt: string;
  readonly providers: readonly ProviderRecord[];
}
