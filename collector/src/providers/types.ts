import {
  validateProviderRecord,
  type ProviderRecordValidationResult,
} from "../contract/validate.js";
import {
  PROVIDER_IDS,
  type ProviderId,
  type ProviderRecord,
  type ProviderRecordFor,
  type ProviderState,
} from "../contract/schema-v1.js";

/** Categories that an adapter may report without exposing the thrown error. */
export const PROVIDER_ADAPTER_ERROR_CATEGORIES = [
  "auth-needed",
  "stale",
  "error",
] as const;

export type ProviderAdapterErrorCategory =
  (typeof PROVIDER_ADAPTER_ERROR_CATEGORIES)[number];

export type ProviderFailureState = Exclude<ProviderState, "ok">;

/**
 * Dependencies are supplied by the collector and remain opaque to common
 * contract types. Provider-specific adapters may narrow their own dependency
 * type without adding native data to normalized records.
 */
export type ProviderAdapterDependencies = Readonly<Record<string, unknown>>;

/**
 * Inputs shared by every provider invocation.
 *
 * `signal` is the native, fetch-compatible AbortSignal. Adapters are trusted
 * internal code: abort listeners MUST NOT throw. An adapter that performs
 * callback work from an abort listener must catch callback errors and reject
 * its `collect()` promise; the collector cannot turn a throwing EventTarget
 * callback into an adapter promise rejection without proxying the signal.
 */
export interface ProviderAdapterContext<
  TDependencies = ProviderAdapterDependencies,
> {
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly deadlineAt?: string;
  readonly dependencies: TDependencies;
}

declare const NORMALIZED_PROVIDER_RESULT: unique symbol;
type NormalizedProviderResultBrand = {
  readonly [NORMALIZED_PROVIDER_RESULT]: true;
};
/** A validated, provider-identity-correlated result accepted at the boundary. */
export type ProviderNormalizedResult<TId extends ProviderId> =
  ProviderRecordFor<TId> & NormalizedProviderResultBrand;

export type ProviderStaleRecordFor<TId extends ProviderId> = Extract<
  ProviderRecordFor<TId>,
  { readonly state: "stale" }
>;

export type ProviderNormalizedStaleRecordFor<TId extends ProviderId> =
  ProviderStaleRecordFor<TId> & NormalizedProviderResultBrand;

/** Invalid normalized results fail with a constant, value-free error. */
export class ProviderResultValidationError extends Error {
  constructor() {
    super("Invalid normalized provider result");
    this.name = "ProviderResultValidationError";
  }
}

function hasProviderId<TId extends ProviderId>(
  record: ProviderRecord,
  id: TId,
): record is ProviderRecordFor<TId> {
  return record.id === id;
}

function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === "string" &&
    PROVIDER_IDS.some((providerId) => providerId === value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function brandProviderRecord<TId extends ProviderId>(
  record: ProviderRecordFor<TId>,
): ProviderNormalizedResult<TId> {
  const branded = { ...record } as ProviderNormalizedResult<TId>;
  Object.freeze(branded);
  return branded;
}

function tryCreateNormalizedProviderResult<TId extends ProviderId>(
  id: TId,
  input: unknown,
): ProviderNormalizedResult<TId> | undefined {
  let validation: ProviderRecordValidationResult;
  try {
    validation = validateProviderRecord(input);
  } catch (error: unknown) {
    void error;
    return undefined;
  }
  if (!validation.ok || !hasProviderId(validation.value, id)) {
    return undefined;
  }
  return brandProviderRecord(validation.value);
}


function tryNormalizeStaleRecord<TId extends ProviderId>(
  id: TId,
  input: unknown,
): ProviderNormalizedStaleRecordFor<TId> | undefined {
  const staleRecord = tryCreateNormalizedProviderResult(id, input);
  if (staleRecord?.state !== "stale") {
    return undefined;
  }

  const canonicalRecord = tryCreateNormalizedProviderResult(id, {
    ...staleRecord,
    status: "Using last known data",
  });
  if (canonicalRecord?.state !== "stale") {
    return undefined;
  }
  return canonicalRecord as ProviderNormalizedStaleRecordFor<TId>;
}

/**
 * The sole construction path for adapter results. Runtime validation rejects
 * unknown fields and invalid values without echoing the rejected input.
 */
export function createNormalizedProviderResult<TId extends ProviderId>(
  id: TId,
  input: unknown,
): ProviderNormalizedResult<TId> {
  const result = tryCreateNormalizedProviderResult(id, input);
  if (result === undefined) {
    throw new ProviderResultValidationError();
  }
  return result;
}

/**
 * The adapter result is correlated with the adapter's provider ID. Adapters
 * must keep abort-listener callbacks non-throwing and convert callback
 * failures into this promise's rejection path.
 */
export interface ProviderAdapter<
  TId extends ProviderId,
  TDependencies = ProviderAdapterDependencies,
> {
  readonly id: TId;
  collect(
    context: ProviderAdapterContext<TDependencies>,
  ): Promise<ProviderNormalizedResult<TId>>;
}

export type AnyProviderAdapter = {
  [TId in ProviderId]: ProviderAdapter<TId>;
}[ProviderId];

/** A safe, classified adapter failure with a constant base message. */
export class ProviderAdapterError extends Error {
  readonly category: ProviderAdapterErrorCategory;

  constructor(category: ProviderAdapterErrorCategory) {
    super("Provider adapter failure");
    this.name = "ProviderAdapterError";
    this.category = category;
  }
}

export type SafeProviderStatus =
  | "Authentication required"
  | "Using last known data"
  | "Provider unavailable";

export type ProviderErrorOutcomeFor<TId extends ProviderId> =
  | {
      readonly id: TId;
      readonly state: "auth-needed";
      readonly status: "Authentication required";
    }
  | {
      readonly id: TId;
      readonly state: "stale";
      readonly status: "Using last known data";
      readonly record: ProviderNormalizedStaleRecordFor<TId>;
    }
  | {
      readonly id: TId;
      readonly state: "error";
      readonly status: "Provider unavailable";
    };

export type ProviderErrorOutcome = {
  [TId in ProviderId]: ProviderErrorOutcomeFor<TId>;
}[ProviderId];

/**
 * Converts any thrown value to a safe provider state. Unknown errors always
 * become `error`; thrown values and messages are never inspected or returned.
 */
export function mapAdapterErrorToState(
  thrown: unknown,
): ProviderAdapterErrorCategory {
  if (
    thrown instanceof ProviderAdapterError &&
    PROVIDER_ADAPTER_ERROR_CATEGORIES.includes(thrown.category)
  ) {
    return thrown.category;
  }
  return "error";
}

/**
 * Preserves provider identity while converting an adapter failure safely.
 * Stale is emitted only when a same-provider, schema-valid stale record with
 * retained data is supplied; otherwise the outcome safely degrades to error.
 */
export function mapAdapterErrorToOutcome<TId extends ProviderId>(
  id: TId,
  thrown: unknown,
  staleLastKnownGood?: ProviderStaleRecordFor<TId>,
): ProviderErrorOutcomeFor<TId> {
  const state = mapAdapterErrorToState(thrown);
  if (state === "stale") {
    const staleRecord = tryNormalizeStaleRecord(id, staleLastKnownGood);
    if (staleRecord !== undefined) {
      return {
        id,
        state: "stale",
        status: "Using last known data",
        record: staleRecord,
      };
    }
  }

  if (state === "auth-needed") {
    return { id, state, status: "Authentication required" };
  }
  return { id, state: "error", status: "Provider unavailable" };
}

/** Converts every mapped outcome into a schema-valid normalized record. */
export function providerOutcomeToRecord<TId extends ProviderId>(
  outcome: ProviderErrorOutcomeFor<TId>,
): ProviderNormalizedResult<TId> {
  if (!isRecord(outcome)) {
    throw new ProviderResultValidationError();
  }
  const candidate = outcome as unknown as {
    readonly id?: unknown;
    readonly record?: unknown;
  };
  if (!isProviderId(candidate.id)) {
    throw new ProviderResultValidationError();
  }

  const id = outcome.id;
  if (outcome.state === "stale") {
    const staleRecord = tryNormalizeStaleRecord(id, candidate.record);
    if (staleRecord !== undefined) {
      return staleRecord;
    }
    return createNormalizedProviderResult(id, {
      id,
      state: "error",
      status: "Provider unavailable",
    });
  }
  if (outcome.state === "auth-needed") {
    return createNormalizedProviderResult(id, {
      id,
      state: "auth-needed",
      status: "Authentication required",
    });
  }
  return createNormalizedProviderResult(id, {
    id,
    state: "error",
    status: "Provider unavailable",
  });
}
