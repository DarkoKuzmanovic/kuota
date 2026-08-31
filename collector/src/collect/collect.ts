import {
  PROVIDER_IDS,
  SCHEMA_VERSION,
  type CollectorDocument,
  type ProviderId,
} from "../contract/schema-v1.js";
import { validateCollectorDocument } from "../contract/validate.js";
import {
  createProviderRegistry,
  type ConfiguredProvider,
  type ProviderRegistry,
} from "../providers/registry.js";
import {
  createNormalizedProviderResult,
  mapAdapterErrorToOutcome,
  mapAdapterErrorToState,
  ProviderAdapterError,
  providerOutcomeToRecord,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderAdapterDependencies,
  type ProviderAdapterErrorCategory,
  type ProviderNormalizedResult,
  type ProviderStaleRecordFor,
} from "../providers/types.js";
import type {
  CollectionOutcome,
  CollectionTimestamps,
  ProviderCollectionFailure,
  ProviderCollectionFailureFor,
  ProviderCollectionOutcome,
  ProviderCollectionSuccessFor,
} from "./types.js";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export interface CollectionClock {
  now(): number;
}

export interface CollectionTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type RetainedStaleRecords = {
  readonly [TId in ProviderId]?: ProviderStaleRecordFor<TId>;
};

export interface CollectorConfig {
  readonly providers: readonly ConfiguredProvider[];
  readonly timeoutMs?: number;
  readonly deadlineAt?: string;
  readonly dependencies?: ProviderAdapterDependencies;
  readonly retainedStaleRecords?: RetainedStaleRecords;
}

export interface CollectOptions {
  readonly registry?: ProviderRegistry;
  readonly config?: CollectorConfig;
  readonly signal?: AbortSignal;
  readonly clock?: CollectionClock;
  readonly timers?: CollectionTimers;
}

export class CollectorConfigurationError extends Error {
  constructor() {
    super("Invalid collector configuration");
    this.name = "CollectorConfigurationError";
  }
}

export class CollectorValidationError extends Error {
  constructor() {
    super("Invalid collector document");
    this.name = "CollectorValidationError";
  }
}

const DEFAULT_CONFIG: CollectorConfig = {
  providers: PROVIDER_IDS.map((id) => ({ id, enabled: true })),
  timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
  dependencies: {},
};

const SYSTEM_CLOCK: CollectionClock = {
  now: () => Date.now(),
};

const SYSTEM_TIMERS: CollectionTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    if (typeof handle === "object" && handle !== null) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  },
};

interface ResolvedCollectionOptions {
  readonly parentSignal: AbortSignal;
  readonly timers: CollectionTimers;
  readonly dependencies: ProviderAdapterDependencies;
  readonly timeoutMs: number;
  readonly deadlineAt: string;
  readonly retainedStaleRecords?: RetainedStaleRecords;
}

type ProviderRaceResult =
  | { readonly kind: "result"; readonly value: unknown }
  | {
      readonly kind: "failure";
      readonly category: ProviderAdapterErrorCategory;
    }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

type ProviderCollectionOutcomeFor<TId extends ProviderId> =
  | ProviderCollectionSuccessFor<TId>
  | ProviderCollectionFailureFor<TId>;

function isValidUtcTimestamp(value: string): boolean {
  return UTC_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function timestampFor(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) {
    throw new CollectorConfigurationError();
  }
  try {
    const timestamp = new Date(milliseconds).toISOString();
    if (!isValidUtcTimestamp(timestamp)) {
      throw new CollectorConfigurationError();
    }
    return timestamp;
  } catch {
    throw new CollectorConfigurationError();
  }
}

function resolveConfig(config: CollectorConfig | undefined): {
  readonly config: CollectorConfig;
  readonly timeoutMs: number;
} {
  const resolved = config ?? DEFAULT_CONFIG;
  const timeoutMs = resolved.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CollectorConfigurationError();
  }
  if (
    resolved.deadlineAt !== undefined &&
    !isValidUtcTimestamp(resolved.deadlineAt)
  ) {
    throw new CollectorConfigurationError();
  }
  return { config: resolved, timeoutMs };
}

function resolveCollectionOptions(
  options: CollectOptions,
  startedAtMs: number,
): ResolvedCollectionOptions {
  const { config, timeoutMs } = resolveConfig(options.config);
  const timers = options.timers ?? SYSTEM_TIMERS;
  const parentController = new AbortController();
  const parentSignal = options.signal ?? parentController.signal;
  const configuredDeadlineMs =
    config.deadlineAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(config.deadlineAt);
  const deadlineMs = Math.min(startedAtMs + timeoutMs, configuredDeadlineMs);
  const deadlineAt = timestampFor(deadlineMs);
  return {
    parentSignal,
    timers,
    dependencies: config.dependencies ?? {},
    timeoutMs: Math.max(0, deadlineMs - startedAtMs),
    deadlineAt,
    retainedStaleRecords: config.retainedStaleRecords,
  };
}

function failureOutcome<TId extends ProviderId>(
  provider: ProviderAdapter<TId>,
  category: ProviderAdapterErrorCategory,
  retainedStaleRecord: ProviderStaleRecordFor<TId> | undefined,
): ProviderCollectionFailureFor<TId> {
  const outcome = mapAdapterErrorToOutcome(
    provider.id,
    new ProviderAdapterError(category),
    retainedStaleRecord,
  );
  return { ...outcome, outcome: "failure" };
}

function abortSafely(controller: AbortController): void {
  try {
    controller.abort();
  } catch (error: unknown) {
    void error;
  }
}

async function collectOne<TId extends ProviderId>(
  provider: ProviderAdapter<TId>,
  options: ResolvedCollectionOptions,
): Promise<ProviderCollectionOutcomeFor<TId>> {
  const controller = new AbortController();
  let resolveControl: ((result: ProviderRaceResult) => void) | undefined;
  let timerHandle: unknown;

  const onParentAbort = (): void => {
    abortSafely(controller);
    resolveControl?.({ kind: "aborted" });
  };

  const context: ProviderAdapterContext = {
    signal: controller.signal,
    timeoutMs: options.timeoutMs,
    deadlineAt: options.deadlineAt,
    dependencies: options.dependencies,
  };


  const retainedStaleRecord = options.retainedStaleRecords?.[provider.id];
  if (options.parentSignal.aborted || options.timeoutMs <= 0) {
    abortSafely(controller);
    return failureOutcome(provider, "error", retainedStaleRecord);
  }

  const invocation: Promise<ProviderRaceResult> = Promise.resolve()
    .then(() => {
      if (controller.signal.aborted) {
        throw new ProviderAdapterError("error");
      }
      return provider.collect(context);
    })
    .then(
      (value) => ({ kind: "result", value }),
      (thrown: unknown) => ({
        kind: "failure",
        category: mapAdapterErrorToState(thrown),
      }),
    );

  const control = new Promise<ProviderRaceResult>((resolve) => {
    resolveControl = resolve;
    timerHandle = options.timers.setTimeout(() => {
      abortSafely(controller);
      resolve({ kind: "timeout" });
    }, options.timeoutMs);
    if (options.parentSignal.aborted) {
      onParentAbort();
    } else {
      options.parentSignal.addEventListener("abort", onParentAbort, {
        once: true,
      });
    }
  });

  let result: ProviderRaceResult;
  try {
    result = await Promise.race([invocation, control]);
  } finally {
    options.timers.clearTimeout(timerHandle);
    options.parentSignal.removeEventListener("abort", onParentAbort);
  }

  if (result.kind === "result") {
    try {
      const record = createNormalizedProviderResult(provider.id, result.value);
      return { id: provider.id, outcome: "success", record };
    } catch {
      return failureOutcome(provider, "error", retainedStaleRecord);
    }
  }

  const category: ProviderAdapterErrorCategory =
    result.kind === "failure" ? result.category : "error";
  return failureOutcome(provider, category, retainedStaleRecord);
}

async function collectAny(
  provider: import("../providers/types.js").AnyProviderAdapter,
  options: ResolvedCollectionOptions,
): Promise<ProviderCollectionOutcome> {
  switch (provider.id) {
    case "claude":
      return collectOne(provider, options);
    case "codex":
      return collectOne(provider, options);
    case "grok":
      return collectOne(provider, options);
    case "kimi":
      return collectOne(provider, options);
    case "cursor":
      return collectOne(provider, options);
    case "opencode":
      return collectOne(provider, options);
    case "commandcode":
      return collectOne(provider, options);
  }
}

async function runCollection(options: CollectOptions): Promise<CollectionOutcome> {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const startedAtMs = clock.now();
  const collectionStartedAt = timestampFor(startedAtMs);
  const { config } = resolveConfig(options.config);
  const registry = options.registry ?? createProviderRegistry();
  const resolvedOptions = resolveCollectionOptions(
    { ...options, config },
    startedAtMs,
  );
  const selected = registry.selectEnabled(config.providers);
  const providers = await Promise.all(
    selected.map((provider) => collectAny(provider, resolvedOptions)),
  );
  const finishedAtMs = Math.max(startedAtMs, clock.now());
  const timestamps: CollectionTimestamps = {
    collectionStartedAt,
    collectionFinishedAt: timestampFor(finishedAtMs),
  };
  return { timestamps, providers };
}

function failureToRecord(
  outcome: ProviderCollectionFailure,
): ProviderNormalizedResult<ProviderId> {
  return providerOutcomeToRecord(outcome);
}

function documentFromOutcome(outcome: CollectionOutcome): unknown {
  return {
    schemaVersion: SCHEMA_VERSION,
    collectionStartedAt: outcome.timestamps.collectionStartedAt,
    collectionFinishedAt: outcome.timestamps.collectionFinishedAt,
    providers: outcome.providers.map((provider) =>
      provider.outcome === "success"
        ? provider.record
        : failureToRecord(provider),
    ),
  };
}

export async function collectProviders(
  options: CollectOptions = {},
): Promise<CollectionOutcome> {
  return runCollection(options);
}

export async function collect(
  options: CollectOptions = {},
): Promise<CollectorDocument> {
  const outcome = await runCollection(options);
  const validation = validateCollectorDocument(documentFromOutcome(outcome));
  if (!validation.ok) {
    throw new CollectorValidationError();
  }
  return validation.value;
}

export const collectDocument = collect;
