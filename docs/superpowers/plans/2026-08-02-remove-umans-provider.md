# Remove Umans Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete Umans end-to-end, bump the collector document contract to `schemaVersion: 2`, and silently strip leftover Umans from old configs/snapshots/caches so upgrades keep working.

**Architecture:** Migrate-then-validate at both validators (TS + QML): a schema-v1 document drops every `id: "umans"` provider, rewrites `schemaVersion` to `2`, then validates as v2. Fresh collection never emits Umans (registry/defaults). Plasma `KNOWN_PROVIDERS` loses Umans so config sanitize drops it. LKG cache envelope stays at its own `COLLECTOR_CACHE_SCHEMA_VERSION` (still `1`) but skips `umans` records on read instead of invalidating the whole envelope.

**Tech Stack:** TypeScript (Node ≥20, built-in test runner), QML/JS `.pragma library` modules, KConfigXT `main.xml`, Plasma 6 plasmoid.

**Spec:** `docs/specs/2026-08-02-remove-umans-provider-design.md`

## Global Constraints

- Only normalized, secret-free JSON crosses the Plasma bridge; never log/emit credentials, account IDs, or raw provider bodies.
- Optional contract fields are omitted when unavailable — never `null` / invented percentages.
- `validateCollectorDocument` / QML `validateCollectorDocument` must validate the whole document before narrowing; migration must not accept malformed non-Umans data.
- Commit only files changed for this work; never `git add -A`. Assume other sessions may have unrelated dirty files — do not stage them.
- Keep filename `collector/src/contract/schema-v1.ts` (historical module path); bump `SCHEMA_VERSION` to `2` inside it.
- Canonical provider order after removal: `claude`, `codex`, `grok`, `kimi`.
- D7 “config keys additive-only” is explicitly amended by the approved design for Umans-only keys (`umansVisible`, `umansAccentColor`, `umansCustomIcon`); document under CHANGELOG **Removed**.
- Run collector/CLI verification under a temporary synthetic `HOME`. Clean `dist/` between Node and QML suites.

## File map

| Path | Responsibility |
|---|---|
| `collector/src/contract/schema-v1.ts` | `SCHEMA_VERSION=2`, `PROVIDER_IDS` without umans, delete Umans types |
| `collector/src/contract/validate.ts` | migrate-then-validate; delete Umans detail parsing |
| `plasmoid/contents/ui/collector-validator.js` | QML mirror of migration + v2 IDs |
| `collector/src/collect/config.ts` | defaults without umans; silent drop of `"umans"` in `enabledProviders` |
| `collector/src/collect/cache.ts` | skip `umans` records when reading/building envelopes |
| `collector/src/collect/collect.ts` | drop umans branches in `collectAny` / `failureToRecord` |
| `collector/src/collect/integrated-collect.ts` | use `SCHEMA_VERSION` (not hardcoded `1`) |
| `collector/src/providers/registry.ts` | unregister Umans; delete import |
| `collector/src/providers/umans/**` | **delete** |
| `collector/test/providers/umans/**` | **delete** |
| Plasma config/UI/models listed in Tasks 6–7 | drop Umans from allowlists, controls, facts |
| Fixtures under `tests/fixtures/normalized/`, QML fixtures | `schemaVersion: 2`, no umans providers |
| Docs / `PLAN.md` / `AGENTS.md` / `CHANGELOG.md` / metadata / `scripts/check-artifact.js` | scope amendment |

---

### Task 1: Contract schema — drop Umans, bump to v2

**Files:**
- Modify: `collector/src/contract/schema-v1.ts`
- Modify: `collector/test/contract/schema-v1.test.ts`
- Modify: every `tests/fixtures/normalized/*.json` that uses `"schemaVersion": 1` and/or `"id": "umans"`

**Interfaces:**
- Produces: `SCHEMA_VERSION = 2`, `PROVIDER_IDS = ["claude","codex","grok","kimi"]`, no `UmansDetails` / `UmansProviderRecord`
- Consumes: nothing new

- [ ] **Step 1: Write the failing assertion for schema version and provider IDs**

In `collector/test/contract/schema-v1.test.ts`, add near the top imports / existing SCHEMA tests (or extend the first schema-identity test):

```typescript
import { PROVIDER_IDS, SCHEMA_VERSION } from "../../src/contract/schema-v1.js";

test("schema v2 identity excludes umans", () => {
  assert.equal(SCHEMA_VERSION, 2);
  assert.deepEqual([...PROVIDER_IDS], ["claude", "codex", "grok", "kimi"]);
  assert.equal((PROVIDER_IDS as readonly string[]).includes("umans"), false);
});
```

Also change every happy-path fixture document in this test file from `schemaVersion: 1` to `schemaVersion: 2`, and replace Umans provider examples with Codex/Grok/Kimi equivalents (keep the same assertion intent: correlation, stale retention, unlimited plans, etc.).

- [ ] **Step 2: Run the new test — expect RED**

Run:

```bash
rm -rf dist && npm test -- --test-name-pattern="schema v2 identity excludes umans"
```

Expected: FAIL — `SCHEMA_VERSION` is still `1` and/or `PROVIDER_IDS` still contains `umans`.

- [ ] **Step 3: Update schema module**

In `collector/src/contract/schema-v1.ts`:

```typescript
export const SCHEMA_VERSION = 2 as const;

export const PROVIDER_IDS = ["claude", "codex", "grok", "kimi"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
```

Delete `UmansDetails`, `UmansProviderDetails`, `NonEmptyUmansDetails`, `UmansProviderRecord`, and every `| { readonly umans: ... }` / `| UmansProviderRecord` arm. Keep Grok/Kimi assertions. Leave the filename as `schema-v1.ts`.

- [ ] **Step 4: Rewrite normalized JSON fixtures**

For each file under `tests/fixtures/normalized/`:
- Set `"schemaVersion": 2`
- Remove any provider object with `"id": "umans"` (or replace with another provider if the fixture’s purpose needs three providers — use `grok`/`kimi` for partial-success/auth-needed slots)
- Ensure no `details.umans` remains

- [ ] **Step 5: Run focused contract tests — expect many REDs in validate until Task 2**

Run:

```bash
rm -rf dist && npm test -- --test-name-pattern="schema v2 identity excludes umans"
```

Expected: PASS for the identity test. Full `schema-v1.test.ts` may still fail on validation until Task 2 — that is OK if failures are solely “unsupported schema version” / umans leftovers. Fix any test that still constructs `id: "umans"` or `schemaVersion: 1` without intending migration coverage (migration tests land in Task 2).

- [ ] **Step 6: Commit**

```bash
git add collector/src/contract/schema-v1.ts collector/test/contract/schema-v1.test.ts tests/fixtures/normalized
git commit -m "$(cat <<'EOF'
feat(contract): bump collector schema to v2 without Umans

Drop Umans from PROVIDER_IDS and types so the document contract matches the approved four-provider set.
EOF
)"
```

---

### Task 2: TypeScript migrate-then-validate

**Files:**
- Modify: `collector/src/contract/validate.ts`
- Modify: `collector/test/contract/schema-v1.test.ts`
- Modify: `collector/src/collect/integrated-collect.ts` (hardcoded `schemaVersion: 1` → `SCHEMA_VERSION`)

**Interfaces:**
- Consumes: `SCHEMA_VERSION`, `PROVIDER_IDS` from Task 1
- Produces: `validateCollectorDocument` accepts schema `1` only via migration (strip umans → rewrite to `2`), then validates as v2; deletes Umans detail parsers

- [ ] **Step 1: Write failing migration tests**

Add to `collector/test/contract/schema-v1.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run migration tests — expect RED**

```bash
rm -rf dist && npm test -- --test-name-pattern="migrates schema v1|rejects schema v2 documents that still include umans|migration does not salvage"
```

Expected: FAIL (v1 unsupported and/or umans still parsed as valid on v2).

- [ ] **Step 3: Implement migration + delete Umans parsers**

At the top of `validateCollectorDocument` in `collector/src/contract/validate.ts`, after the `isRecord` check and before key validation, migrate:

```typescript
export function validateCollectorDocument(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: "$", reason: "expected an object" }] };
  }

  let document: Record<string, unknown> = input;
  if (input.schemaVersion === 1) {
    const providers = Array.isArray(input.providers) ? input.providers : undefined;
    document = {
      ...input,
      schemaVersion: SCHEMA_VERSION,
      providers: providers === undefined
        ? input.providers
        : providers.filter((provider) => !(isRecord(provider) && provider.id === "umans")),
    };
  }

  validateObjectKeys(document, "$", DOCUMENT_KEYS, errors);
  // ... continue using `document` instead of `input` for the rest of this function
```

Remove `parseUmansDetails` and the `if (id === "umans")` branch in details parsing / non-empty checks.

In `collector/src/collect/integrated-collect.ts`:

```typescript
import { SCHEMA_VERSION, type CollectorDocument, type ProviderId, type ProviderRecord } from "../contract/schema-v1.js";
// ...
  const validation = validateCollectorDocument({
    schemaVersion: SCHEMA_VERSION,
    collectionStartedAt: startedAt,
    collectionFinishedAt: finishedAt,
    providers: records,
  });
```

Update remaining schema-v1 tests that expect `schemaVersion: 1` success without migration intent so they use `2`, and keep one explicit unsupported-version case (e.g. `0` or `3`).

- [ ] **Step 4: Run contract suite — expect GREEN**

```bash
rm -rf dist && npm test -- collector/test/contract/schema-v1.test.ts
```

Expected: all tests in that file PASS.

- [ ] **Step 5: Commit**

```bash
git add collector/src/contract/validate.ts collector/test/contract/schema-v1.test.ts collector/src/collect/integrated-collect.ts
git commit -m "$(cat <<'EOF'
feat(contract): migrate schema v1 snapshots by stripping Umans

Accept legacy schemaVersion 1 only as a one-shot rewrite to v2 after dropping umans providers.
EOF
)"
```

---

### Task 3: QML collector-validator mirror

**Files:**
- Modify: `plasmoid/contents/ui/collector-validator.js`
- Modify: `tests/qml/tst_collector_validator.qml`
- Modify: `tests/qml/helpers/collector-fixtures.js`
- Modify: `tests/qml/fixtures/collector/success.js` (and any other QML collector fixtures still on v1/umans)

**Interfaces:**
- Consumes: same migrate-then-validate rules as Task 2
- Produces: QML `SCHEMA_VERSION = 2`, `PROVIDER_IDS` without umans, migration before validate

- [ ] **Step 1: Write failing QML migration test**

In `tests/qml/tst_collector_validator.qml`, add:

```qml
function test_migratesSchemaV1ByStrippingUmans() {
    var raw = JSON.stringify({
        schemaVersion: 1,
        collectionStartedAt: "2026-07-11T10:00:00.000Z",
        collectionFinishedAt: "2026-07-11T10:00:01.000Z",
        providers: [
            Fixtures.validClaudeProvider(),
            Fixtures.validUmansProvider(),
            Fixtures.validCodexProvider()
        ]
    });
    var result = Validator.validateCollectorResponse(raw);
    verify(result.ok);
    compare(result.value.schemaVersion, 2);
    compare(result.value.providers.length, 2);
    compare(result.value.providers[0].id, "claude");
    compare(result.value.providers[1].id, "codex");
}

function test_rejectsSchemaV2WithUmans() {
    var raw = JSON.stringify({
        schemaVersion: 2,
        collectionStartedAt: "2026-07-11T10:00:00.000Z",
        collectionFinishedAt: "2026-07-11T10:00:01.000Z",
        providers: [Fixtures.validUmansProvider()]
    });
    var result = Validator.validateCollectorResponse(raw);
    verify(!result.ok);
}
```

Keep `validUmansProvider` in helpers **only for these migration/negative tests** until Step 3, then either keep it as a deliberately-invalid builder used solely by rejection/migration tests, or inline the object in the test and delete the helper.

- [ ] **Step 2: Run QML validator tests — expect RED**

```bash
rm -rf dist && npm run test:qml -- tests/qml/tst_collector_validator.qml
```

Expected: FAIL on schema version / umans still accepted.

- [ ] **Step 3: Implement QML migration and drop Umans parsing**

In `plasmoid/contents/ui/collector-validator.js`:

```javascript
var SCHEMA_VERSION = 2;
var PROVIDER_IDS = ["claude", "codex", "grok", "kimi"];
```

Delete `UMANS_DETAIL_KEYS` and all `id === "umans"` detail branches.

In `validateCollectorDocument(parsed)`:

```javascript
function validateCollectorDocument(parsed) {
    var state = { invalid: false };
    if (!isRecord(parsed)) {
        return failure(VALIDATION_FAILURE.MALFORMED_DOCUMENT);
    }

    var document = parsed;
    if (parsed.schemaVersion === 1) {
        var providers = Array.isArray(parsed.providers) ? parsed.providers : undefined;
        document = shallowCopy(parsed);
        document.schemaVersion = SCHEMA_VERSION;
        if (providers !== undefined) {
            document.providers = [];
            for (var i = 0; i < providers.length; i++) {
                var provider = providers[i];
                if (isRecord(provider) && provider.id === "umans") {
                    continue;
                }
                document.providers.push(provider);
            }
        }
    }

    // validate `document` for the rest of the function...
}
```

Add a tiny `shallowCopy` helper in the same file if one does not exist (own enumerable keys only; no prototype walk).

Update fixtures: default `minimalDocument` / success fixtures use `schemaVersion: 2` and no umans. Update other QML tests that assumed umans success paths.

- [ ] **Step 4: Re-run QML validator tests — expect GREEN**

```bash
rm -rf dist && npm run test:qml -- tests/qml/tst_collector_validator.qml
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plasmoid/contents/ui/collector-validator.js tests/qml/tst_collector_validator.qml tests/qml/helpers/collector-fixtures.js tests/qml/fixtures/collector
git commit -m "$(cat <<'EOF'
feat(plasmoid): mirror schema v2 Umans migration in QML validator

Keep Plasma snapshot acceptance aligned with the collector contract migrate-then-validate path.
EOF
)"
```

---

### Task 4: Collector config — silent drop + defaults

**Files:**
- Modify: `collector/src/collect/config.ts`
- Modify: `collector/test/collect/config.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_IDS` without umans
- Produces: `parseCollectorConfig` ignores `"umans"` entries; defaults enable `claude|codex|grok|kimi` only

- [ ] **Step 1: Write failing config tests**

```typescript
test("default config enables four providers without umans", () => {
  assert.deepEqual(
    DEFAULT_COLLECTOR_CONFIG.providers.map((provider) => [provider.id, provider.enabled]),
    [
      ["claude", true],
      ["codex", true],
      ["grok", true],
      ["kimi", true],
    ],
  );
});

test("silently drops umans from enabledProviders", () => {
  const config = parseCollectorConfig({
    enabledProviders: ["claude", "umans", "codex"],
  });
  assert.deepEqual(
    config.providers.filter((provider) => provider.enabled).map((provider) => provider.id),
    ["claude", "codex"],
  );
});

test("umans-only enabledProviders yields all disabled", () => {
  const config = parseCollectorConfig({ enabledProviders: ["umans"] });
  assert.deepEqual(
    config.providers.map((provider) => provider.enabled),
    [false, false, false, false],
  );
});
```

Update existing tests that expect an `umans` slot in the providers array.

- [ ] **Step 2: Run — expect RED**

```bash
rm -rf dist && npm test -- collector/test/collect/config.test.ts
```

- [ ] **Step 3: Implement silent drop**

In `collector/src/collect/config.ts`:

```typescript
const DEFAULT_ENABLED_PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex", "grok", "kimi"];
```

In `parseEnabledProviders`, treat the literal `"umans"` as skippable (not a hard invalid), before `isProviderId`:

```typescript
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
```

Unknown IDs other than `"umans"` still throw. Duplicates of real IDs still throw. Duplicate `"umans"` entries are fine (both skipped).

- [ ] **Step 4: Run — expect GREEN**

```bash
rm -rf dist && npm test -- collector/test/collect/config.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add collector/src/collect/config.ts collector/test/collect/config.test.ts
git commit -m "$(cat <<'EOF'
feat(collector): drop Umans from defaults and ignore it in config

Keep upgrades working when old bridges still pass umans in enabledProviders.
EOF
)"
```

---

### Task 5: LKG cache — skip Umans records

**Files:**
- Modify: `collector/src/collect/cache.ts`
- Modify: `collector/test/collect/cache.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_IDS` without umans; `validateProviderRecord` rejects umans
- Produces: envelope validation skips `id === "umans"` records instead of failing the whole cache

- [ ] **Step 1: Write failing cache migration test**

Replace `umansOk()` helpers in `cache.test.ts` with `codexOk()` / `grokOk()` for ordinary cases. Add:

```typescript
test("skips legacy umans records when reading an otherwise valid envelope", async () => {
  const legacy = {
    schemaVersion: COLLECTOR_CACHE_SCHEMA_VERSION,
    savedAt: SAVED_AT,
    records: [
      claudeOk(),
      {
        id: "umans",
        state: "ok",
        lastSuccessAt: SAVED_AT,
        details: { umans: { requests: 3 } },
      },
    ],
  };
  // write legacy JSON via the test’s temp HOME / write helper, then:
  const read = await readCollectorCache({ homeDirectory: home });
  assert.equal(read.state, "available");
  if (read.state !== "available") return;
  assert.deepEqual(read.envelope.records.map((record) => record.id), ["claude"]);
});
```

Use the suite’s existing temp-HOME write pattern (copy from neighboring tests).

- [ ] **Step 2: Run — expect RED**

```bash
rm -rf dist && npm test -- --test-name-pattern="skips legacy umans"
```

Expected: FAIL — whole envelope rejected because umans fails `validateProviderRecord`.

- [ ] **Step 3: Skip umans in `validateEnvelope`**

In `validateEnvelope`’s record loop:

```typescript
    for (const rawRecord of value.records) {
      if (isRecord(rawRecord) && rawRecord.id === "umans") {
        continue;
      }
      const record = validateStorableRecord(rawRecord);
      if (record === undefined || records.has(record.id)) return undefined;
      records.set(record.id, record);
    }
    if (records.size === 0) return undefined;
```

Add a local `isRecord` helper if the file lacks one (`typeof value === "object" && value !== null && !Array.isArray(value)`). Do **not** bump `COLLECTOR_CACHE_SCHEMA_VERSION` (document schema is separate).

Rewrite remaining cache tests that used umans as a second provider to use `codex`/`grok`.

- [ ] **Step 4: Run cache suite — expect GREEN**

```bash
rm -rf dist && npm test -- collector/test/collect/cache.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add collector/src/collect/cache.ts collector/test/collect/cache.test.ts
git commit -m "$(cat <<'EOF'
fix(collector): keep LKG cache when stripping legacy Umans records

Skip umans entries on envelope read so sibling provider last-known-good data survives upgrades.
EOF
)"
```

---

### Task 6: Delete Umans adapter and registry wiring

**Files:**
- Delete: `collector/src/providers/umans/` (all files)
- Delete: `collector/test/providers/umans/` (all files)
- Modify: `collector/src/providers/registry.ts`
- Modify: `collector/test/providers/registry.test.ts`
- Modify: `collector/src/collect/collect.ts` (remove umans-only branches)
- Modify: `collector/test/collect/integrated-collect.test.ts`, `collector/test/cli.test.ts`, and any other collector tests still importing Umans
- Modify: `scripts/check-artifact.js` expected provider ID list

**Interfaces:**
- Produces: `createProviderRegistry()` registrations for claude/codex/grok/kimi only

- [ ] **Step 1: Update registry tests to the four-provider set (RED if adapter still registered)**

In `collector/test/providers/registry.test.ts`, set:

```typescript
const canonicalIds: readonly ProviderId[] = ["claude", "codex", "grok", "kimi"];
```

Remove every `umans` registration/selection/stale case; substitute `codex` or `grok` where a second provider is needed. Assert `registry.adapters.map(a => a.id)` equals `canonicalIds` and that no adapter id is `"umans"`.

- [ ] **Step 2: Run registry tests — observe current green/red mix, then delete adapter**

```bash
rm -rf dist && npm test -- collector/test/providers/registry.test.ts
```

- [ ] **Step 3: Unregister and delete**

In `registry.ts`, remove `createUmansAdapter` import and registration. Delete the umans source and test directories.

In `collect.ts`, simplify the identity switches — both `collectAny` and `failureToRecord` can call through directly without per-id branches:

```typescript
async function collectAny(
  provider: import("../providers/types.js").AnyProviderAdapter,
  options: ResolvedCollectionOptions,
): Promise<ProviderCollectionOutcome> {
  return collectOne(provider, options);
}

function failureToRecord(
  outcome: ProviderCollectionFailure,
): ProviderNormalizedResult<ProviderId> {
  return providerOutcomeToRecord(outcome);
}
```

In `scripts/check-artifact.js`, expect `['claude', 'codex', 'grok', 'kimi']`.

Sweep `rg -n 'umans|Umans|UMANS' collector scripts` and clear remaining references in collector tests.

- [ ] **Step 4: Run collector-focused suites — expect GREEN**

```bash
rm -rf dist && npm test -- collector/test/providers/registry.test.ts collector/test/cli.test.ts collector/test/collect/integrated-collect.test.ts
```

Expected: PASS. Then `rg -n 'umans' collector` should return no source hits (tests may still mention umans only in Task 4/5 migration strings — those are fine).

- [ ] **Step 5: Commit**

```bash
git add -u collector/src/providers/umans collector/test/providers/umans
git add collector/src/providers/registry.ts collector/test/providers/registry.test.ts collector/src/collect/collect.ts collector/test/cli.test.ts collector/test/collect/integrated-collect.test.ts scripts/check-artifact.js
# add any other collector test files you actually edited
git commit -m "$(cat <<'EOF'
feat(collector): remove Umans adapter from the registry

Drop the Umans provider implementation so collection only runs Claude, Codex, Grok, and Kimi.
EOF
)"
```

---

### Task 7: Plasma config + command allowlists

**Files:**
- Modify: `plasmoid/contents/ui/config-model.js`
- Modify: `plasmoid/contents/config/main.xml`
- Modify: `plasmoid/contents/ui/configProviders.qml`
- Modify: `plasmoid/contents/ui/configTheming.qml`
- Modify: `plasmoid/contents/ui/collector-command.js`
- Modify: `tests/qml/tst_config_model.qml`, `tests/qml/tst_config_theming.qml`, `tests/qml/tst_collector_command.qml`, `tests/qml/tst_main_wiring.qml`

**Interfaces:**
- Produces: `KNOWN_PROVIDERS = ["claude","codex","grok","kimi"]`; no `umansVisible` in sanitized settings; command allowlist matches

- [ ] **Step 1: Write failing config-model tests**

```qml
function test_knownProvidersExcludeUmans() {
    compare(ConfigModel.KNOWN_PROVIDERS, ["claude", "codex", "grok", "kimi"]);
}

function test_sanitizeDropsUmansFromOrder() {
    var settings = ConfigModel.sanitize({
        providerOrder: ["claude", "umans", "codex", "grok", "kimi"],
        umansVisible: true
    });
    verify(settings.providerOrder.indexOf("umans") === -1);
    compare(settings.providerOrder, ["claude", "codex", "grok", "kimi"]);
    verify(!("umansVisible" in settings));
}
```

Adapt property access to whatever the module already exports (if `KNOWN_PROVIDERS` is not exported, assert via `sanitize`/`assembleDisplayConfig` outputs only).

Update collector-command tests: allowlist must accept `grok`/`kimi` and reject or strip `umans` per below.

- [ ] **Step 2: Run — expect RED**

```bash
rm -rf dist && npm run test:qml -- tests/qml/tst_config_model.qml
```

- [ ] **Step 3: Implement Plasma config + command**

`config-model.js`:

```javascript
var KNOWN_PROVIDERS = Object.freeze(["claude", "codex", "grok", "kimi"]);
var DEFAULT_PROVIDER_ORDER = Object.freeze(["claude", "codex", "grok", "kimi"]);
```

Remove `umansVisible` from `DEFAULTS`, `createDefaultSettings`, `sanitize`, and `assembleDisplayConfig` visibility map. Remove any Umans-only window comments.

`main.xml`: default `providerOrder` → `claude,codex,grok,kimi`; delete `umansVisible`, `umansAccentColor`, `umansCustomIcon` entries.

`configProviders.qml` / `configTheming.qml`: remove Umans checkboxes/properties/labels; update `providerIds` / `cfg_providerOrder` defaults.

`collector-command.js`:

```javascript
var CANONICAL_PROVIDER_IDS = Object.freeze(["claude", "codex", "grok", "kimi"]);
```

In `buildProviderToken`, skip `"umans"` entries the same way config does (continue) so an old caller cannot break the bridge; still reject unknown non-umans IDs and duplicates.

- [ ] **Step 4: Run config/command QML tests — expect GREEN**

```bash
rm -rf dist && npm run test:qml -- tests/qml/tst_config_model.qml tests/qml/tst_config_theming.qml tests/qml/tst_collector_command.qml tests/qml/tst_main_wiring.qml
```

- [ ] **Step 5: Commit**

```bash
git add plasmoid/contents/ui/config-model.js plasmoid/contents/config/main.xml plasmoid/contents/ui/configProviders.qml plasmoid/contents/ui/configTheming.qml plasmoid/contents/ui/collector-command.js tests/qml/tst_config_model.qml tests/qml/tst_config_theming.qml tests/qml/tst_collector_command.qml tests/qml/tst_main_wiring.qml
git commit -m "$(cat <<'EOF'
feat(plasmoid): remove Umans from config schema and command allowlist

Sanitize leftover umans order entries on read and stop exposing Umans controls.
EOF
)"
```

---

### Task 8: Compact/full models and representations

**Files:**
- Modify: `plasmoid/contents/ui/compact-model.js`
- Modify: `plasmoid/contents/ui/full-model.js`
- Modify: `plasmoid/contents/ui/CompactRepresentation.qml`
- Modify: `plasmoid/contents/ui/FullRepresentation.qml`
- Modify: `tests/qml/tst_compact_model.qml`, `tests/qml/tst_full_model.qml`, `tests/qml/tst_compact_representation.qml`, `tests/qml/tst_full_representation.qml`, `tests/qml/tst_snapshot_state.qml`

**Interfaces:**
- Produces: no Umans labels/facts/icon cases; defaults order without umans

- [ ] **Step 1: Rewrite failing model tests away from Umans**

Replace Umans compact/full cases with Grok or Kimi. Delete assertions that call `umansFacts` behavior. Ensure full-model facts allowlist tests still prove closed namespaces (`details.claude|codex|grok|kimi` only).

- [ ] **Step 2: Run — expect RED where production still references umans**

```bash
rm -rf dist && npm run test:qml -- tests/qml/tst_compact_model.qml tests/qml/tst_full_model.qml
```

- [ ] **Step 3: Delete Umans presentation code**

- `compact-model.js`: `DEFAULT_ORDER` without umans; remove `umans` from display-name map and default visibility.
- `full-model.js`: delete `umansFacts`, `pushUmansPriorityFact`, `pushUmansConcurrencyFact`, and the `id === "umans"` branch.
- `CompactRepresentation.qml` / `FullRepresentation.qml`: delete `case "umans"` label/icon branches; update default `providerOrder` property defaults to the four-provider list.

- [ ] **Step 4: Run representation suites — expect GREEN**

```bash
rm -rf dist && npm run test:qml -- tests/qml/tst_compact_model.qml tests/qml/tst_full_model.qml tests/qml/tst_compact_representation.qml tests/qml/tst_full_representation.qml tests/qml/tst_snapshot_state.qml
```

- [ ] **Step 5: Commit**

```bash
git add plasmoid/contents/ui/compact-model.js plasmoid/contents/ui/full-model.js plasmoid/contents/ui/CompactRepresentation.qml plasmoid/contents/ui/FullRepresentation.qml tests/qml/tst_compact_model.qml tests/qml/tst_full_model.qml tests/qml/tst_compact_representation.qml tests/qml/tst_full_representation.qml tests/qml/tst_snapshot_state.qml
git commit -m "$(cat <<'EOF'
feat(plasmoid): remove Umans from compact and full presentation

Keep provider UI allowlists aligned with the four supported providers.
EOF
)"
```

---

### Task 9: Docs, metadata, CHANGELOG, residual sweep

**Files:**
- Modify: `docs/specs/2026-07-10-kuota-design.md`
- Modify: `docs/architecture/collector-contract.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/specs/2026-07-22-theming-customization-design.md` (Umans mentions only)
- Modify: `PLAN.md` (current scope bullets; historical M4 may note later removal)
- Modify: `AGENTS.md`, `README.md`, `CHANGELOG.md`
- Modify: `plasmoid/metadata.json`
- Modify: `ROADMAP.md` if it lists Umans as current
- Residual: `rg -n 'umans|Umans|UMANS' .` excluding `docs/specs/2026-08-02-remove-umans-provider-design.md`, this plan, and intentional migration test strings

**Interfaces:** none

- [ ] **Step 1: Update CHANGELOG under a new Unreleased / next version section**

```markdown
## [Unreleased]

### Removed

- **Umans provider.** Kuota no longer collects or displays Umans usage.
  Collector documents now use `schemaVersion: 2` with providers
  `claude`, `codex`, `grok`, and `kimi`. Schema v1 snapshots and configs
  that still mention Umans are silently stripped on read. Orphan
  `umansVisible` / accent / icon KConfig keys may remain on disk unread.
  This amends D7 for the Umans-only keys as an explicit scope change
  (see `docs/specs/2026-08-02-remove-umans-provider-design.md`).
```

- [ ] **Step 2: Amend normative docs**

- Design + PLAN + AGENTS + README: supported providers are Claude, Codex, Grok, Kimi.
- `collector-contract.md`: examples at schema v2; document migrate-then-validate; remove Umans details prose; reword Kimi concurrency without “mirrors Umans”.
- `metadata.json` Description: e.g. `Keep Claude, Codex, Grok, and Kimi account usage visible on the Plasma desktop.`

- [ ] **Step 3: Residual grep gate**

```bash
rg -n 'umans|Umans|UMANS' --glob '!docs/specs/2026-08-02-remove-umans-provider-*' --glob '!docs/superpowers/plans/*' .
```

Expected: only migration/negative-test string literals (and possibly historical Gate Log lines in `PLAN.md` that you intentionally keep with a “later removed” note). No production source paths under `collector/src/providers/umans` (directory deleted). No `umansVisible` in `main.xml`.

- [ ] **Step 4: Commit**

```bash
git add docs PLAN.md AGENTS.md README.md CHANGELOG.md plasmoid/metadata.json ROADMAP.md
git commit -m "$(cat <<'EOF'
docs: record Umans removal and schema v2 scope amendment

Update normative design, plan, contract, and changelog to the four-provider set.
EOF
)"
```

---

### Task 10: Full verification gate

**Files:** none (verification only); fix any stragglers discovered here under a follow-up commit if needed.

- [ ] **Step 1: Clean Node suite under synthetic HOME**

```bash
rm -rf dist
HOME="$(mktemp -d)" npm test
```

Expected: exit 0, all tests pass.

- [ ] **Step 2: Typecheck, Plasma validate, artifact**

```bash
rm -rf dist
npm run typecheck
npm run validate:plasma
HOME="$(mktemp -d)" npm run build:artifact
HOME="$(mktemp -d)" node scripts/check-artifact.js
```

Expected: all exit 0; packaged collector smoke emits one JSON document with `"schemaVersion": 2` and provider IDs only from `claude|codex|grok|kimi`.

- [ ] **Step 3: QML suite (after clean dist)**

```bash
rm -rf dist
npm run test:qml
```

Expected: exit 0.

- [ ] **Step 4: Final residual grep + status**

```bash
rg -n 'umans|Umans|UMANS' --glob '!docs/specs/2026-08-02-remove-umans-provider-*' --glob '!docs/superpowers/plans/*' .
git status
```

Expected: only intentional historical/migration mentions; working tree clean for this work’s files.

- [ ] **Step 5: Commit any gate fixes** (only if Step 1–4 required code changes)

Use a focused message describing the fix. If nothing to fix, skip.

---

## Spec coverage self-check

| Spec requirement | Task |
|---|---|
| Full deletion of Umans adapter/UI/schema ID | 1, 6, 7, 8 |
| Schema bump to 2 | 1 |
| Migrate-then-validate (TS + QML) | 2, 3 |
| Silent config / enabledProviders strip | 4, 7 |
| LKG cache survives by stripping umans | 5 |
| Docs / PLAN / AGENTS / CHANGELOG / metadata | 9 |
| Synthetic HOME full gate | 10 |
| No auth-file / KConfig purge | Non-goals (no task) |
| No dual-schema forever | 2, 3 (v1 only as migration input) |

## Placeholder / consistency notes

- Document `schemaVersion` is `2`; cache envelope `COLLECTOR_CACHE_SCHEMA_VERSION` stays `1` with umans-record skipping — intentional, matches “document contract break” without a second envelope version bump.
- `collector-command.js` gains `grok`/`kimi` in the allowlist as part of removing umans (it was previously stuck on the three-provider V1 list).
