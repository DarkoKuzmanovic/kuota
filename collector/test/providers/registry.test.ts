import assert from "node:assert/strict";
import test from "node:test";

import {
  createNormalizedProviderResult,
  ProviderAdapterError,
  ProviderResultValidationError,
  type AnyProviderAdapter,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderErrorOutcomeFor,
  type ProviderNormalizedResult,
  type ProviderStaleRecordFor,
  mapAdapterErrorToOutcome,
  providerOutcomeToRecord,
} from "../../src/providers/types.js";
import { createCodexAdapter } from "../../src/providers/codex/adapter.js";
import {
  CLAUDE_ADAPTER,
  CODEX_ADAPTER,
  createProviderRegistration,
  createProviderRegistry,
  type ProviderRegistration,
} from "../../src/providers/registry.js";
import type {
  ProviderId,
  ProviderRecordFor,
} from "../../src/contract/schema-v1.js";
import {
  validateCollectorDocument,
  validateProviderRecord,
} from "../../src/contract/validate.js";
import type { ProviderCollectionSuccess } from "../../src/collect/types.js";

const canonicalIds: readonly ProviderId[] = ["claude", "umans", "codex"];

function adapterFor<TId extends ProviderId>(id: TId): ProviderAdapter<TId> {
  return {
    id,
    async collect(): Promise<ProviderNormalizedResult<TId>> {
      return createNormalizedProviderResult(id, { id, state: "ok" });
    },
  };
}

function registrationFor(id: ProviderId): ProviderRegistration {
  switch (id) {
    case "claude":
      return createProviderRegistration(adapterFor("claude"));
    case "umans":
      return createProviderRegistration(adapterFor("umans"));
    case "codex":
      return createProviderRegistration(adapterFor("codex"));
  }
}

const typedClaudeResult = createNormalizedProviderResult("claude", {
  id: "claude",
  state: "ok",
  details: { claude: { model: "synthetic-model" } },
});
const typedCodexResult = createNormalizedProviderResult("codex", {
  id: "codex",
  state: "ok",
  details: { codex: { credits: 1.5 } },
});

const typedAdapter: ProviderAdapter<"claude"> = {
  id: "claude",
  async collect(): Promise<ProviderNormalizedResult<"claude">> {
    return typedClaudeResult;
  },
};

// Provider adapters require an explicit provider ID type argument.
// @ts-expect-error bare ProviderAdapter must not default to all provider IDs
const bareProviderAdapter: ProviderAdapter = typedAdapter;

const heterogeneousAdapters: readonly AnyProviderAdapter[] = [
  typedAdapter,
  adapterFor("umans"),
  adapterFor("codex"),
];
const heterogeneousRegistrations = [
  createProviderRegistration(typedAdapter),
  createProviderRegistration(adapterFor("umans")),
  createProviderRegistration(adapterFor("codex")),
] as const satisfies readonly ProviderRegistration[];

// AnyProviderAdapter preserves the ID/result correlation for heterogeneous storage.
// @ts-expect-error a Claude adapter cannot return a Codex result
const mismatchedAnyAdapter: AnyProviderAdapter = {
  id: "claude",
  async collect(): Promise<ProviderNormalizedResult<"codex">> {
    return typedCodexResult;
  },
};

// Provider registrations preserve the adapter/registration ID correlation.
// @ts-expect-error a Claude registration cannot contain a Codex adapter
const mismatchedRegistration: ProviderRegistration = {
  id: "claude",
  adapter: adapterFor("codex"),
};

// A stale error outcome cannot store an OK normalized record.
const staleOutcomeWithOkRecord: ProviderErrorOutcomeFor<"claude"> = {
  id: "claude",
  state: "stale",
  status: "Using last known data",
  // @ts-expect-error stale outcomes require a normalized stale record
  record: typedClaudeResult,
};

// A provider adapter cannot return a normalized result for another provider.
const mismatchedAdapter: ProviderAdapter<"claude"> = {
  id: "claude",
  async collect(): Promise<ProviderNormalizedResult<"claude">> {
    // @ts-expect-error Claude adapters cannot return Codex results
    return typedCodexResult;
  },
};

// Structural typing cannot smuggle native response data through the branded
// adapter result boundary, even when all normalized fields are present.
const nativePayload = {
  id: "claude" as const,
  state: "ok" as const,
  response: { headers: { Authorization: "synthetic" } },
  credentials: { access: "synthetic" },
  rawPayload: { usage: 1 },
};
const nativePayloadAdapter: ProviderAdapter<"claude"> = {
  id: "claude",
  async collect(): Promise<ProviderNormalizedResult<"claude">> {
    // @ts-expect-error native payloads must be validated and branded first
    return nativePayload;
  },
};

const typedSuccess: ProviderCollectionSuccess = {
  id: "claude",
  outcome: "success",
  record: typedClaudeResult,
};

// The collection success discriminant is correlated with its record identity.
// @ts-expect-error Claude collection successes cannot contain Codex records
const mismatchedSuccess: ProviderCollectionSuccess = {
  id: "claude",
  outcome: "success",
  record: typedCodexResult,
};

void [
  typedAdapter,
  mismatchedAdapter,
  nativePayloadAdapter,
  typedSuccess,
  mismatchedSuccess,
  bareProviderAdapter,
  heterogeneousAdapters,
  heterogeneousRegistrations,
  mismatchedAnyAdapter,
  mismatchedRegistration,
  staleOutcomeWithOkRecord,
];

const incompleteStaleCandidate = {
  id: "claude",
  state: "stale",
} as const;
mapAdapterErrorToOutcome(
  "claude",
  new ProviderAdapterError("stale"),
  // @ts-expect-error stale mapping requires lastSuccessAt and retained data
  incompleteStaleCandidate,
);

test("normalized result construction rejects native extras and invalid values", () => {
  const nativeVariable: Record<string, unknown> = {
    id: "claude",
    state: "ok",
    response: { headers: { Authorization: "synthetic" } },
    credentials: { access: "synthetic" },
    rawPayload: { usage: 1 },
  };
  const nonEnumerableNativeVariable: Record<string, unknown> = {
    id: "claude",
    state: "ok",
  };
  Object.defineProperty(nonEnumerableNativeVariable, "response", {
    value: { headers: { Authorization: "synthetic" } },
    enumerable: false,
  });

  for (const candidate of [nativeVariable, nonEnumerableNativeVariable]) {
    assert.throws(
      () => createNormalizedProviderResult("claude", candidate),
      (error: unknown) => {
        assert.ok(error instanceof ProviderResultValidationError);
        assert.equal(error.message, "Invalid normalized provider result");
        assert.equal(error.message.includes("synthetic"), false);
        return true;
      },
    );
  }

  assert.throws(() =>
    createNormalizedProviderResult("claude", {
      id: "claude",
      state: "ok",
      status: 42,
    }),
  );
});

test("registry exposes real Claude and Codex adapters without collecting auth at registration", async () => {
  const registry = createProviderRegistry();

  assert.deepEqual(
    registry.adapters.map((adapter) => adapter.id),
    canonicalIds,
  );
  assert.equal(registry.adapters[0], CLAUDE_ADAPTER);
  assert.equal(registry.adapters[2], CODEX_ADAPTER);

  const context: ProviderAdapterContext = {
    signal: new AbortController().signal,
    timeoutMs: 25,
    deadlineAt: "2026-07-11T12:00:00.000Z",
    dependencies: {},
  };
  const umans = registry.adapters[1];
  if (umans === undefined) assert.fail("expected Umans placeholder");
  assert.deepEqual(await umans.collect(context), {
    id: "umans",
    state: "error",
    status: "Provider adapter unavailable",
  });
});

test("registry selects an injected Codex adapter without consulting live auth", async () => {
  const syntheticAuthPath = "/synthetic-home/.pi/agent/auth.json";
  let pathCalls = 0;
  let authCalls = 0;
  const codex = createCodexAdapter({
    resolveAuthPath: () => { pathCalls += 1; return syntheticAuthPath; },
    readAuth: async ({ authPath }) => {
      authCalls += 1;
      assert.equal(authPath, syntheticAuthPath);
      return { state: "auth-needed", reason: "missing-entry", status: "Authentication required" };
    },
  });
  const registry = createProviderRegistry([
    createProviderRegistration(adapterFor("claude")),
    createProviderRegistration(adapterFor("umans")),
    createProviderRegistration(codex),
  ]);
  assert.equal(pathCalls, 0);
  assert.equal(authCalls, 0);

  const selected = registry.selectEnabled([{ id: "codex", enabled: true }]);
  assert.equal(pathCalls, 0);
  assert.equal(authCalls, 0);
  const selectedCodex = selected[0];
  if (selectedCodex === undefined) assert.fail("expected Codex adapter");
  assert.deepEqual(await selectedCodex.collect({
    signal: new AbortController().signal,
    dependencies: {},
  }), {
    id: "codex",
    state: "auth-needed",
    status: "Authentication required",
  });
  assert.equal(pathCalls, 1);
  assert.equal(authCalls, 1);
});

test("selection rejects unknown configured provider IDs without echoing values", () => {
  const registry = createProviderRegistry();
  const secretLikeId = "unknown-account-secret-123";

  assert.throws(
    () => registry.selectEnabled([{ id: secretLikeId, enabled: true }]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Unknown provider identifier");
      assert.equal(error.message.includes(secretLikeId), false);
      return true;
    },
  );
});

test("selection rejects duplicate configuration IDs without echoing values", () => {
  const registry = createProviderRegistry();

  assert.throws(
    () =>
      registry.selectEnabled([
        { id: "claude", enabled: true },
        { id: "claude", enabled: false },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Duplicate provider configuration");
      return true;
    },
  );
});

test("registry rejects unknown and duplicate registration IDs", () => {
  assert.throws(
    () =>
      createProviderRegistry([
        { id: "provider-secret", adapter: adapterFor("claude") } as unknown as ProviderRegistration,
      ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Unknown provider registration");
      assert.equal(error.message.includes("provider-secret"), false);
      return true;
    },
  );

  assert.throws(
    () =>
      createProviderRegistry([
        registrationFor("claude"),
        registrationFor("claude"),
      ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Duplicate provider registration");
      return true;
    },
  );
});

test("selection excludes disabled providers and uses canonical order", () => {
  const registry = createProviderRegistry([
    registrationFor("codex"),
    registrationFor("claude"),
    registrationFor("umans"),
  ]);

  const selected = registry.selectEnabled([
    { id: "codex", enabled: true },
    { id: "claude", enabled: false },
    { id: "umans", enabled: true },
  ]);

  assert.deepEqual(
    selected.map((adapter) => adapter.id),
    ["umans", "codex"],
  );

  assert.equal(Object.isFrozen(selected), true);
  const firstSelected = selected[0];
  if (firstSelected === undefined) {
    assert.fail("expected a selected adapter");
  }
  assert.throws(() => {
    (selected as unknown as Array<(typeof selected)[number]>).push(firstSelected);
  }, TypeError);
  assert.deepEqual(
    selected.map((adapter) => adapter.id),
    ["umans", "codex"],
  );
});

test("adapter context forwards cancellation and per-provider timeout/deadline", async () => {
  let received: ProviderAdapterContext | undefined;
  const adapter: ProviderAdapter<"claude"> = {
    id: "claude",
    async collect(context): Promise<ProviderNormalizedResult<"claude">> {
      received = context;
      return createNormalizedProviderResult("claude", {
        id: "claude",
        state: "ok",
      });
    },
  };
  const context: ProviderAdapterContext = {
    signal: new AbortController().signal,
    timeoutMs: 500,
    deadlineAt: "2026-07-11T12:00:05.000Z",
    dependencies: { clock: "synthetic" },
  };

  await adapter.collect(context);

  assert.equal(received, context);
  assert.ok(received);
  assert.equal(received.signal, context.signal);
  assert.equal(received.timeoutMs, 500);
  assert.equal(received.deadlineAt, context.deadlineAt);
  assert.deepEqual(received.dependencies, { clock: "synthetic" });
});

test("adapter failures map independently to safe provider outcomes", () => {
  const auth = mapAdapterErrorToOutcome(
    "claude",
    new ProviderAdapterError("auth-needed"),
  );
  const stale = mapAdapterErrorToOutcome(
    "umans",
    new ProviderAdapterError("stale"),
  );
  const thrownSecret = "raw-token-account-secret";
  const error = mapAdapterErrorToOutcome("codex", new Error(thrownSecret));

  assert.deepEqual(auth, {
    id: "claude",
    state: "auth-needed",
    status: "Authentication required",
  });
  assert.deepEqual(stale, {
    id: "umans",
    state: "error",
    status: "Provider unavailable",
  });
  assert.deepEqual(error, {
    id: "codex",
    state: "error",
    status: "Provider unavailable",
  });
  assert.equal(JSON.stringify(error).includes(thrownSecret), false);
  const mappedRecords = [
    providerOutcomeToRecord(auth),
    providerOutcomeToRecord(stale),
    providerOutcomeToRecord(error),
  ];
  assert.equal(
    validateCollectorDocument({
      schemaVersion: 1 as const,
      collectionStartedAt: "2026-07-11T10:00:00.000Z",
      collectionFinishedAt: "2026-07-11T10:00:01.000Z",
      providers: mappedRecords,
    }).ok,
    true,
  );
});

test("stale outcomes retain only a valid same-provider last-known-good record", () => {
  const staleCandidate = createNormalizedProviderResult("umans", {
    id: "umans",
    state: "stale",
    lastSuccessAt: "2026-07-10T10:00:00.000Z",
    windows: [{ id: "requests", label: "Requests", used: 3 }],
  });
  if (staleCandidate.state !== "stale") {
    assert.fail("expected a stale synthetic record");
  }
  const lastKnownGood = staleCandidate;
  const outcome = mapAdapterErrorToOutcome(
    "umans",
    new ProviderAdapterError("stale"),
    lastKnownGood,
  );
  const record = providerOutcomeToRecord(outcome);
  const document = {
    schemaVersion: 1 as const,
    collectionStartedAt: "2026-07-11T10:00:00.000Z",
    collectionFinishedAt: "2026-07-11T10:00:01.000Z",
    providers: [record],
  };

  assert.equal(outcome.state, "stale");
  assert.equal(record.status, "Using last known data");
  assert.equal(validateCollectorDocument(document).ok, true);

  const mismatched = {
    id: "claude",
    state: "stale",
    lastSuccessAt: "2026-07-10T10:00:00.000Z",
    windows: [{ id: "weekly", label: "Weekly" }],
  };
  const invalidOutcome = mapAdapterErrorToOutcome(
    "umans",
    new ProviderAdapterError("stale"),
    mismatched as unknown as ProviderStaleRecordFor<"umans">,
  );
  assert.deepEqual(invalidOutcome, {
    id: "umans",
    state: "error",
    status: "Provider unavailable",
  });
});

test("forged stale outcomes degrade to canonical error records", () => {
  const forgedOutcomes = [
    {
      id: "claude",
      state: "stale",
      status: "Forged status",
      record: { id: "claude", state: "ok" },
    },
    {
      id: "claude",
      state: "stale",
      status: "Forged status",
      record: {
        id: "claude",
        state: "stale",
        lastSuccessAt: "not-a-timestamp",
        windows: [{ id: "weekly", label: "Weekly" }],
      },
    },
    {
      id: "claude",
      state: "stale",
      status: "Forged status",
      record: {
        id: "codex",
        state: "stale",
        lastSuccessAt: "2026-07-10T10:00:00.000Z",
        windows: [{ id: "primary", label: "Primary" }],
      },
    },
  ] as const;

  for (const forgedOutcome of forgedOutcomes) {
    const record = providerOutcomeToRecord(
      forgedOutcome as unknown as ProviderErrorOutcomeFor<"claude">,
    );
    assert.deepEqual(record, {
      id: "claude",
      state: "error",
      status: "Provider unavailable",
    });
    assert.equal(validateProviderRecord(record).ok, true);
  }

  const validStaleOutcome = providerOutcomeToRecord(
    {
      id: "claude",
      state: "stale",
      status: "Forged status",
      record: {
        id: "claude",
        state: "stale",
        lastSuccessAt: "2026-07-10T10:00:00.000Z",
        windows: [{ id: "weekly", label: "Weekly" }],
      },
    } as unknown as ProviderErrorOutcomeFor<"claude">,
  );
  assert.deepEqual(validStaleOutcome, {
    id: "claude",
    state: "stale",
    status: "Using last known data",
    lastSuccessAt: "2026-07-10T10:00:00.000Z",
    windows: [{ id: "weekly", label: "Weekly" }],
  });
  assert.equal(validateProviderRecord(validStaleOutcome).ok, true);

  const authOutcome = providerOutcomeToRecord(
    {
      id: "claude",
      state: "auth-needed",
      status: "Forged status",
    } as unknown as ProviderErrorOutcomeFor<"claude">,
  );
  assert.deepEqual(authOutcome, {
    id: "claude",
    state: "auth-needed",
    status: "Authentication required",
  });

  const errorOutcome = providerOutcomeToRecord(
    {
      id: "claude",
      state: "error",
      status: "Forged status",
    } as unknown as ProviderErrorOutcomeFor<"claude">,
  );
  assert.deepEqual(errorOutcome, {
    id: "claude",
    state: "error",
    status: "Provider unavailable",
  });
});

test("forged unknown provider IDs throw a constant validation error", () => {
  assert.throws(
    () =>
      providerOutcomeToRecord(
        {
          id: "unknown-provider-secret",
          state: "stale",
          status: "Forged status",
          record: {},
        } as unknown as ProviderErrorOutcomeFor<ProviderId>,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderResultValidationError);
      assert.equal(error.message, "Invalid normalized provider result");
      assert.equal(error.message.includes("unknown-provider-secret"), false);
      return true;
    },
  );
});

test("registry rejects a registration whose adapter identity differs", () => {
  assert.throws(
    () =>
      createProviderRegistry([
        {
          id: "codex",
          adapter: adapterFor("claude"),
        } as unknown as ProviderRegistration,
      ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Mismatched provider registration");
      return true;
    },
  );
});
