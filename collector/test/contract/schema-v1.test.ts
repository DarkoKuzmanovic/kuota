import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateCollectorDocument } from "../../src/contract/validate.js";
import type { CollectorDocument, ProviderRecord } from "../../src/contract/schema-v1.js";

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

const minimalDocument = {
  schemaVersion: 1,
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
const typedUmansRecord: ProviderRecord = {
  id: "umans",
  state: "auth-needed",
  details: { umans: { plan: "synthetic-plan" } },
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
const typedMismatchedUmansDetails: ProviderRecord = {
  id: "umans",
  state: "ok",
  // @ts-expect-error provider IDs and namespaced details must match
  details: { codex: { credits: 1.5 } },
};
const typedMismatchedCodexDetails: ProviderRecord = {
  id: "codex",
  state: "ok",
  // @ts-expect-error provider IDs and namespaced details must match
  details: { claude: { model: "synthetic-model" } },
};
// @ts-expect-error stale records require a last-success timestamp and retained data
const typedStaleWithoutRetention: ProviderRecord = {
  id: "umans",
  state: "stale",
};
void [
  typedClaudeRecord,
  typedUmansRecord,
  typedCodexRecord,
  typedStaleWithWindow,
  typedStaleWithDetails,
  typedMismatchedClaudeDetails,
  typedStaleWithoutRetention,
  typedMismatchedUmansDetails,
  typedMismatchedCodexDetails,
  typedStaleWithEmptyDetails,
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
      id: "umans",
      state: "ok",
      windows: [{ id: "requests", label: "Requests", used: 120 }],
    }),
  );

  assert.equal(result.ok, true);
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
});

test("provider details namespaces must match provider IDs", () => {
  const mismatches = [
    { id: "claude", details: { umans: { plan: "synthetic-plan" } } },
    { id: "umans", details: { codex: { credits: 1.5 } } },
    { id: "codex", details: { claude: { model: "synthetic-model" } } },
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
      id: "umans",
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
        { id: "umans", state: "auth-needed" },
        { id: "codex", state: "error" },
      ],
    );
  }

  const unlimited = validateCollectorDocument(loadFixture("valid-unlimited.json"));
  assert.equal(unlimited.ok, true);
  if (unlimited.ok) {
    const provider = unlimited.value.providers[0];
    assert.ok(provider);
    assert.equal(provider.id, "umans");
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

test("accepts UTC timestamps without fractional seconds", () => {
  const result = validateCollectorDocument({
    schemaVersion: 1,
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
    schemaVersion: 1,
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
