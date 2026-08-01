import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateCollectorDocument } from "../../src/contract/validate.js";
import { PROVIDER_IDS, SCHEMA_VERSION, type CollectorDocument, type ProviderRecord } from "../../src/contract/schema-v1.js";

const FIXTURE_DIRECTORY = findFixtureDirectory();
const REQUIRED_VALID_FIXTURE_NAMES = [
  "valid-auth-needed.json",
  "valid-error.json",
  "valid-limited.json",
  "valid-partial-success.json",
  "valid-window-boundaries.json",
  "valid-stale.json",
  "valid-unlimited.json",
] as const;
const REQUIRED_INVALID_FIXTURE_NAMES = [
  "invalid-credential-shaped-field.json",
  "invalid-credential-shaped-text.json",
  "invalid-details-namespace.json",
  "invalid-details-shape.json",
  "invalid-duplicate-providers.json",
  "invalid-impossible-counts.json",
  "invalid-malformed-percent.json",
  "invalid-stale-without-retention.json",
  "invalid-missing-required-top-level-fields.json",
  "invalid-partial-document.json",
  "invalid-timestamp.json",
  "invalid-unknown-field.json",
  "invalid-unknown-provider.json",
  "invalid-unknown-state.json",
  "invalid-unsupported-schema-version.json",
  "invalid-value-free-errors.json",
] as const;
const VALID_FIXTURE_NAMES = REQUIRED_VALID_FIXTURE_NAMES;
const INVALID_FIXTURE_NAMES = REQUIRED_INVALID_FIXTURE_NAMES;

test("normalized fixture inventory is explicit", () => {
  const expected = [...REQUIRED_VALID_FIXTURE_NAMES, ...REQUIRED_INVALID_FIXTURE_NAMES].sort();
  assert.deepEqual(fixtureNames(), expected);
});

test("schema v2 identity excludes umans", () => {
  assert.equal(SCHEMA_VERSION, 2);
  assert.deepEqual([...PROVIDER_IDS], ["claude", "codex", "grok", "kimi"]);
  assert.equal((PROVIDER_IDS as readonly string[]).includes("umans"), false);
});

const minimalDocument = {
  schemaVersion: 2,
  collectionStartedAt: "2026-07-11T10:00:00.000Z",
  collectionFinishedAt: "2026-07-11T10:00:01.000Z",
  providers: [],
};

const typedClaudeRecord: ProviderRecord = {
  id: "claude",
  state: "ok",
  status: "Current",
  lastSuccessAt: "2026-07-11T10:00:00.000Z",
  windows: [{ id: "weekly", label: "Weekly" }],
  details: { claude: { model: "synthetic-model" } },
};
const typedKimiRecord: ProviderRecord = {
  id: "kimi",
  state: "auth-needed",
  details: { kimi: { concurrency: 2 } },
};
const typedCodexRecord: ProviderRecord = {
  id: "codex",
  state: "error",
  details: { codex: { credits: 1.5 } },
};
const typedStaleWithWindow: ProviderRecord = {
  id: "claude",
  state: "stale",
  lastSuccessAt: "2026-07-10T10:00:00.000Z",
  windows: [{ id: "weekly", label: "Weekly" }],
};
const typedStaleWithDetails: ProviderRecord = {
  id: "codex",
  state: "stale",
  lastSuccessAt: "2026-07-10T10:00:00.000Z",
  details: { codex: { credits: 1.5 } },
};
// @ts-expect-error stale details must retain at least one detail field
const typedStaleWithEmptyDetails: ProviderRecord = {
  id: "claude",
  state: "stale",
  lastSuccessAt: "2026-07-10T10:00:00.000Z",
  details: { claude: {} },
};
const typedMismatchedClaudeDetails: ProviderRecord = {
  id: "claude",
  state: "ok",
  // @ts-expect-error provider IDs and namespaced details must match
  details: { umans: { plan: "synthetic-plan" } },
};
const typedMismatchedCodexDetails: ProviderRecord = {
  id: "codex",
  state: "ok",
  // @ts-expect-error provider IDs and namespaced details must match
  details: { claude: { model: "synthetic-model" } },
};
const typedMismatchedKimiDetails: ProviderRecord = {
  id: "kimi",
  state: "ok",
  // @ts-expect-error provider IDs and namespaced details must match
  details: { codex: { credits: 1.5 } },
};
const typedMismatchedGrokDetails: ProviderRecord = {
  id: "grok",
  state: "ok",
  // @ts-expect-error provider IDs and namespaced details must match
  details: { kimi: { concurrency: 2 } },
};
const typedMismatchedKimiNamespaceDetails: ProviderRecord = {
  id: "kimi",
  state: "ok",
  // @ts-expect-error provider IDs and namespaced details must match
  details: { grok: { monthlyUsed: 100 } },
};
const typedGrokRecord: ProviderRecord = {
  id: "grok",
  state: "ok",
  details: { grok: { monthlyUsed: 100, monthlyLimit: 1000, monthlyResetAt: "2026-07-11T10:00:00.000Z" } },
};
const typedKimiOkRecord: ProviderRecord = {
  id: "kimi",
  state: "ok",
  details: { kimi: { concurrency: 2, concurrencyLimit: 4 } },
};
const typedGrokStaleWithDetails: ProviderRecord = {
  id: "grok",
  state: "stale",
  lastSuccessAt: "2026-07-10T10:00:00.000Z",
  details: { grok: { monthlyUsed: 100 } },
};
// @ts-expect-error stale details must retain at least one detail field
const typedGrokStaleWithEmptyDetails: ProviderRecord = {
  id: "grok",
  state: "stale",
  lastSuccessAt: "2026-07-10T10:00:00.000Z",
  details: { grok: {} },
};
// @ts-expect-error stale records require a last-success timestamp and retained data
const typedStaleWithoutRetention: ProviderRecord = {
  id: "kimi",
  state: "stale",
};
void [
  typedClaudeRecord,
  typedKimiRecord,
  typedCodexRecord,
  typedGrokRecord,
  typedKimiOkRecord,
  typedStaleWithWindow,
  typedStaleWithDetails,
  typedGrokStaleWithDetails,
  typedMismatchedClaudeDetails,
  typedMismatchedKimiDetails,
  typedMismatchedCodexDetails,
  typedMismatchedGrokDetails,
  typedMismatchedKimiNamespaceDetails,
  typedStaleWithoutRetention,
  typedGrokStaleWithEmptyDetails,
];

test("normalized schema v1 accepts every valid JSON fixture", () => {
  assert.ok(VALID_FIXTURE_NAMES.length > 0, "expected valid normalized fixtures");

  for (const fixtureName of VALID_FIXTURE_NAMES) {
    const result = validateCollectorDocument(loadFixture(fixtureName));

    assert.equal(result.ok, true, fixtureName);
  }
});

test("normalized schema v1 rejects every invalid JSON fixture", () => {
  assert.ok(INVALID_FIXTURE_NAMES.length > 0, "expected invalid normalized fixtures");

  for (const fixtureName of INVALID_FIXTURE_NAMES) {
    const result = validateCollectorDocument(loadFixture(fixtureName));

    assert.equal(result.ok, false, fixtureName);
    if (result.ok) {
      continue;
    }
    assert.ok(result.errors.length > 0, fixtureName);
    for (const issue of result.errors) {
      assert.deepEqual(Object.keys(issue).sort(), ["path", "reason"]);
      assert.equal(typeof issue.path, "string");
      assert.equal(typeof issue.reason, "string");
    }
  }
});

test("normalized schema v1 narrows unknown input to the contract", () => {
  const result = validateCollectorDocument(minimalDocument);

  if (!result.ok) {
    assert.fail("expected a valid collector document");
  }
  const document: CollectorDocument = result.value;
  assert.deepEqual(document.providers, []);
});

test("unlimited windows omit invented limits and percentages", () => {
  const result = validateCollectorDocument(
    documentWith({
      id: "kimi",
      state: "ok",
      windows: [{ id: "requests", label: "Requests", used: 120 }],
    }),
  );

  assert.equal(result.ok, true);
});


test("Kimi concurrencyLimit is optional, namespaced, and a non-negative integer", () => {
  const valid = validateCollectorDocument(documentWith({
    id: "kimi",
    state: "ok",
    details: { kimi: { concurrency: 2, concurrencyLimit: 3 } },
  }));
  const malformed = validateCollectorDocument(documentWith({
    id: "kimi",
    state: "ok",
    details: { kimi: { concurrencyLimit: -1 } },
  }));
  assert.equal(valid.ok, true);
  assert.equal(malformed.ok, false);
});

test("optional fields may be omitted", () => {
  const result = validateCollectorDocument(
    documentWith({ id: "codex", state: "ok" }),
  );

  assert.equal(result.ok, true);
});

test("Claude extra-usage details and integer credit windows remain schema-valid", () => {
  const valid = validateCollectorDocument(
    documentWith({
      id: "claude",
      state: "ok",
      windows: [{ id: "extra-usage", label: "Extra usage", used: 2, limit: 10 }],
      details: {
        claude: {
          extraUsageEnabled: false,
          extraUsageUsedCredits: 2,
          extraUsageMonthlyLimit: 10,
          extraUsageCurrency: "USD",
          extraUsageDecimalPlaces: 2,
          extraUsageDisabledReason: "not_enabled",
        },
      },
    }),
  );
  assert.equal(valid.ok, true);

  const invalid = validateCollectorDocument(
    documentWith({
      id: "claude",
      state: "ok",
      details: { claude: { extraUsageEnabled: "synthetic" } },
    }),
  );
  assert.equal(invalid.ok, false);

  const fractionalWindow = validateCollectorDocument(
    documentWith({
      id: "claude",
      state: "ok",
      windows: [{ id: "session", label: "Session", used: 2.5 }],
    }),
  );
  assert.equal(fractionalWindow.ok, false);


test("Grok details are optional, namespaced, and valid as non-negative numbers + timestamp", () => {
  const valid = validateCollectorDocument(
    documentWith({
      id: "grok",
      state: "ok",
      details: { grok: { monthlyUsed: 100, monthlyLimit: 1000, monthlyResetAt: "2026-07-11T10:00:00.000Z" } },
    }),
  );
  const minimal = validateCollectorDocument(documentWith({ id: "grok", state: "ok", details: { grok: {} } }));
  const malformedMonthlyUsed = validateCollectorDocument(
    documentWith({ id: "grok", state: "ok", details: { grok: { monthlyUsed: -1 } } }),
  );
  const malformedTimestamp = validateCollectorDocument(
    documentWith({ id: "grok", state: "ok", details: { grok: { monthlyResetAt: "tomorrow" } } }),
  );
  const unknownField = validateCollectorDocument(
    documentWith({ id: "grok", state: "ok", details: { grok: { unknownFlag: true } } }),
  );
  assert.equal(valid.ok, true);
  assert.equal(minimal.ok, true);
  assert.equal(malformedMonthlyUsed.ok, false);
  assert.equal(malformedTimestamp.ok, false);
  assert.equal(unknownField.ok, false);
});

test("Kimi details are optional, namespaced, and valid as non-negative integers", () => {
  const valid = validateCollectorDocument(
    documentWith({
      id: "kimi",
      state: "ok",
      details: { kimi: { concurrency: 2, concurrencyLimit: 4 } },
    }),
  );
  const minimal = validateCollectorDocument(documentWith({ id: "kimi", state: "ok", details: { kimi: {} } }));
  const malformedConcurrency = validateCollectorDocument(
    documentWith({ id: "kimi", state: "ok", details: { kimi: { concurrency: -1 } } }),
  );
  const malformedConcurrencyLimit = validateCollectorDocument(
    documentWith({ id: "kimi", state: "ok", details: { kimi: { concurrencyLimit: 1.5 } } }),
  );
  assert.equal(valid.ok, true);
  assert.equal(minimal.ok, true);
  assert.equal(malformedConcurrency.ok, false);
  assert.equal(malformedConcurrencyLimit.ok, false);
});

test("Grok and Kimi namespaces correlate with their provider IDs", () => {
  const grokWithKimi = validateCollectorDocument(
    documentWith({ id: "grok", state: "ok", details: { kimi: { concurrency: 2 } } }),
  );
  const kimiWithGrok = validateCollectorDocument(
    documentWith({ id: "kimi", state: "ok", details: { grok: { monthlyUsed: 100 } } }),
  );
  assert.equal(grokWithKimi.ok, false);
  assert.equal(kimiWithGrok.ok, false);
});

test("Grok and Kimi stale records require retained data", () => {
  const grokStaleWithDetails = validateCollectorDocument(
    documentWith({
      id: "grok",
      state: "stale",
      lastSuccessAt: "2026-07-10T10:00:00.000Z",
      details: { grok: { monthlyUsed: 100 } },
    }),
  );
  const grokStaleEmpty = validateCollectorDocument(
    documentWith({
      id: "grok",
      state: "stale",
      lastSuccessAt: "2026-07-10T10:00:00.000Z",
      details: { grok: {} },
    }),
  );
  const kimiStaleWithDetails = validateCollectorDocument(
    documentWith({
      id: "kimi",
      state: "stale",
      lastSuccessAt: "2026-07-10T10:00:00.000Z",
      details: { kimi: { concurrency: 2 } },
    }),
  );
  assert.equal(grokStaleWithDetails.ok, true);
  assert.equal(grokStaleEmpty.ok, false);
  assert.equal(kimiStaleWithDetails.ok, true);
});
});

test("provider details namespaces must match provider IDs", () => {
  const mismatches = [
    { id: "claude", details: { umans: { plan: "synthetic-plan" } } },
    { id: "kimi", details: { codex: { credits: 1.5 } } },
    { id: "codex", details: { claude: { model: "synthetic-model" } } },
    { id: "grok", details: { kimi: { concurrency: 2 } } },
    { id: "kimi", details: { grok: { monthlyUsed: 100 } } },
  ];

  for (const provider of mismatches) {
    const result = validateCollectorDocument(documentWith({ ...provider, state: "ok" }));
    assert.equal(result.ok, false);
  }
});

test("stale records require a timestamp and retained data", () => {
  const staleWithWindow = validateCollectorDocument(
    documentWith({
      id: "claude",
      state: "stale",
      lastSuccessAt: "2026-07-10T10:00:00.000Z",
      windows: [{ id: "weekly", label: "Weekly" }],
    }),
  );
  assert.equal(staleWithWindow.ok, true);

  const staleWithDetails = validateCollectorDocument(
    documentWith({
      id: "codex",
      state: "stale",
      lastSuccessAt: "2026-07-10T10:00:00.000Z",
      details: { codex: { credits: 1.5 } },
    }),
  );
  assert.equal(staleWithDetails.ok, true);

  const missingTimestamp = validateCollectorDocument(
    documentWith({
      id: "claude",
      state: "stale",
      windows: [{ id: "weekly", label: "Weekly" }],
    }),
  );
  assert.equal(missingTimestamp.ok, false);
  if (!missingTimestamp.ok) {
    assert.ok(
      missingTimestamp.errors.some(
        (issue) => issue.path === "$.providers[0].lastSuccessAt",
      ),
    );
  }

  const missingRetention = validateCollectorDocument(
    documentWith({
      id: "kimi",
      state: "stale",
      lastSuccessAt: "2026-07-10T10:00:00.000Z",
    }),
  );
  assert.equal(missingRetention.ok, false);

  const emptyDetails = validateCollectorDocument(
    documentWith({
      id: "codex",
      state: "stale",
      lastSuccessAt: "2026-07-10T10:00:00.000Z",
      details: { codex: {} },
    }),
  );
  assert.equal(emptyDetails.ok, false);
});

test("document state fixtures describe partial and unlimited semantics", () => {
  const partial = validateCollectorDocument(loadFixture("valid-partial-success.json"));
  assert.equal(partial.ok, true);
  if (partial.ok) {
    assert.deepEqual(
      partial.value.providers.map(({ id, state }) => ({ id, state })),
      [
        { id: "claude", state: "ok" },
        { id: "kimi", state: "auth-needed" },
        { id: "codex", state: "error" },
      ],
    );
  }

  const unlimited = validateCollectorDocument(loadFixture("valid-unlimited.json"));
  assert.equal(unlimited.ok, true);
  if (unlimited.ok) {
    const provider = unlimited.value.providers[0];
    assert.ok(provider);
    assert.equal(provider.id, "kimi");
    assert.equal(provider.windows?.[0]?.limit, undefined);
    assert.equal(provider.windows?.[0]?.usedPercent, undefined);
  }

  const stale = validateCollectorDocument(loadFixture("valid-stale.json"));
  assert.equal(stale.ok, true);
  if (stale.ok) {
    const provider = stale.value.providers[0];
    assert.ok(provider);
    assert.equal(provider.state, "stale");
    assert.equal(typeof provider.lastSuccessAt, "string");
    assert.ok((provider.windows?.length ?? 0) > 0 || provider.details !== undefined);
  }
});

test("accepts usage window boundary values", () => {
  const result = validateCollectorDocument(loadFixture("valid-window-boundaries.json"));

  assert.equal(result.ok, true);
  if (result.ok) {
    const provider = result.value.providers[0];
    assert.ok(provider);
    assert.deepEqual(
      provider.windows?.map(({ id, used, limit, usedPercent }) => ({
        id,
        used,
        limit,
        usedPercent,
      })),
      [
        { id: "at-limit", used: 100, limit: 100, usedPercent: 100 },
        { id: "empty", used: 0, limit: 100, usedPercent: 0 },
        { id: "zero-limit", used: 0, limit: 0, usedPercent: 0 },
      ],
    );
  }
});

test("focused invalid fixtures report their contract failures", () => {
  const unsupported = validateCollectorDocument(loadFixture("invalid-unsupported-schema-version.json"));
  assertHasIssue(unsupported, "$.schemaVersion", "unsupported schema version");

  const missingTopLevel = validateCollectorDocument(
    loadFixture("invalid-missing-required-top-level-fields.json"),
  );
  assertHasIssue(missingTopLevel, "$.collectionStartedAt", "required field");
  assertHasIssue(missingTopLevel, "$.collectionFinishedAt", "required field");

  const partial = validateCollectorDocument(loadFixture("invalid-partial-document.json"));
  assertHasIssue(partial, "$.providers", "expected an array");

  const duplicate = validateCollectorDocument(loadFixture("invalid-duplicate-providers.json"));
  assertHasIssue(duplicate, "$.providers[1].id", "duplicate provider");

  const valueFree = validateCollectorDocument(loadFixture("invalid-value-free-errors.json"));
  assert.equal(valueFree.ok, false);
  if (!valueFree.ok) {
    for (const issue of valueFree.errors) {
      assert.deepEqual(Object.keys(issue).sort(), ["path", "reason"]);
      assert.equal("value" in issue, false);
    }
  }

  const staleWithoutRetention = validateCollectorDocument(
    loadFixture("invalid-stale-without-retention.json"),
  );
  assertHasIssue(
    staleWithoutRetention,
    "$.providers[0]",
    "stale provider requires retained usage data",
  );
});

test("rejects stale records with unknown provider IDs without retaining issue values", () => {
  const result = validateCollectorDocument(
    documentWith({
      id: "synthetic-provider",
      state: "stale",
      lastSuccessAt: "2026-07-10T10:00:00.000Z",
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.length > 0);
    for (const issue of result.errors) {
      assert.deepEqual(Object.keys(issue).sort(), ["path", "reason"]);
      assert.equal(typeof issue.path, "string");
      assert.equal(typeof issue.reason, "string");
      assert.equal("value" in issue, false);
    }
    assert.ok(
      result.errors.some(
        (issue) => issue.path === "$.providers[0].id" && issue.reason === "unknown provider",
      ),
    );
    assert.ok(
      result.errors.some(
        (issue) =>
          issue.path === "$.providers[0]" &&
          issue.reason === "stale provider requires retained usage data",
      ),
    );
  }
});

test("migrates schema v1 documents by stripping umans then validating as v2", () => {
  const result = validateCollectorDocument({
    schemaVersion: 1,
    collectionStartedAt: "2026-07-11T10:00:00.000Z",
    collectionFinishedAt: "2026-07-11T10:00:01.000Z",
    providers: [
      {
        id: "claude",
        state: "ok",
        status: "Usage is current",
        windows: [{ id: "weekly", label: "Weekly", usedPercent: 10, used: 10, limit: 100 }],
        details: { claude: { model: "synthetic-model" } },
      },
      { id: "umans", state: "auth-needed", status: "Login required" },
      { id: "codex", state: "error", status: "Provider unavailable" },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.schemaVersion, 2);
  assert.deepEqual(
    result.value.providers.map((provider) => provider.id),
    ["claude", "codex"],
  );
});

test("rejects schema v2 documents that still include umans", () => {
  const result = validateCollectorDocument({
    schemaVersion: 2,
    collectionStartedAt: "2026-07-11T10:00:00.000Z",
    collectionFinishedAt: "2026-07-11T10:00:01.000Z",
    providers: [{ id: "umans", state: "auth-needed", status: "Login required" }],
  });
  assert.equal(result.ok, false);
});

test("migration does not salvage malformed non-umans fields", () => {
  const result = validateCollectorDocument({
    schemaVersion: 1,
    collectionStartedAt: "2026-07-11T10:00:00.000Z",
    collectionFinishedAt: "2026-07-11T10:00:01.000Z",
    providers: [
      { id: "claude", state: "ok", windows: [{ id: "weekly", label: "Weekly", usedPercent: 101 }] },
      { id: "umans", state: "auth-needed", status: "Login required" },
    ],
  });
  assert.equal(result.ok, false);
});

test("accepts UTC timestamps without fractional seconds", () => {
  const result = validateCollectorDocument({
    schemaVersion: 2,
    collectionStartedAt: "2026-07-11T10:00:00Z",
    collectionFinishedAt: "2026-07-11T10:00:01Z",
    providers: [],
  });

  assert.equal(result.ok, true);
});

function assertHasIssue(
  result: ReturnType<typeof validateCollectorDocument>,
  path: string,
  reason: string,
): void {
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((issue) => issue.path === path && issue.reason === reason));
  }
}

function documentWith(provider: unknown): unknown {
  return {
    schemaVersion: 2,
    collectionStartedAt: minimalDocument.collectionStartedAt,
    collectionFinishedAt: minimalDocument.collectionFinishedAt,
    providers: [provider],
  };
}

function loadFixture(name: string): unknown {
  const contents = readFileSync(resolve(FIXTURE_DIRECTORY, name), "utf8");
  return JSON.parse(contents) as unknown;
}

function fixtureNames(): readonly string[] {
  return readdirSync(FIXTURE_DIRECTORY)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function findFixtureDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const candidate = resolve(directory, "tests/fixtures/normalized");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Could not locate tests/fixtures/normalized from the compiled test");
    }
    directory = parent;
  }
}
