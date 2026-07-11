import type {
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderAdapterDependencies,
  ProviderErrorOutcomeFor,
  ProviderNormalizedResult,
} from "../providers/types.js";
import type { ProviderId } from "../contract/schema-v1.js";

/** Collection-level timestamps carried by the eventual normalized document. */
export interface CollectionTimestamps {
  readonly collectionStartedAt: string;
  readonly collectionFinishedAt: string;
}

/** Shared cancellation and collection deadline inputs. */
export interface CollectionContext {
  readonly signal: AbortSignal;
  readonly collectionStartedAt: string;
  readonly timeoutMs?: number;
  readonly deadlineAt?: string;
}

/** One isolated invocation request; each provider owns its context and budget. */
export interface ProviderCollectionRequest<
  TId extends ProviderId,
  TDependencies = ProviderAdapterDependencies,
> {
  readonly provider: ProviderAdapter<TId, TDependencies>;
  readonly context: ProviderAdapterContext<TDependencies>;
}

export type AnyProviderCollectionRequest = {
  [TId in ProviderId]: ProviderCollectionRequest<TId>;
}[ProviderId];

export type ProviderCollectionSuccessFor<TId extends ProviderId> = {
  readonly id: TId;
  readonly outcome: "success";
  readonly record: ProviderNormalizedResult<TId>;
};

export type ProviderCollectionSuccess = {
  [TId in ProviderId]: ProviderCollectionSuccessFor<TId>;
}[ProviderId];

export type ProviderCollectionFailureFor<TId extends ProviderId> =
  ProviderErrorOutcomeFor<TId> & {
    readonly outcome: "failure";
  };

export type ProviderCollectionFailure = {
  [TId in ProviderId]: ProviderCollectionFailureFor<TId>;
}[ProviderId];

/** A provider failure is data for that provider, not a collection-wide throw. */
export type ProviderCollectionOutcome =
  | ProviderCollectionSuccess
  | ProviderCollectionFailure;

export interface CollectionOutcome {
  readonly timestamps: CollectionTimestamps;
  readonly providers: readonly ProviderCollectionOutcome[];
}
