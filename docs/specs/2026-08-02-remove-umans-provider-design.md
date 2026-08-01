# Remove Umans Provider — Design

**Date:** 2026-08-02  
**Status:** Approved for implementation planning  
**Owner decision:** Full end-to-end removal; silent upgrade strip; collector schema bump to v2 with migrate-then-validate.

## Problem

Umans is a first-class V1 provider across the collector contract, adapters, Plasma config/UI, fixtures, tests, and normative docs. The product decision is to drop Umans entirely so Kuota only knows Claude, Codex, Grok, and Kimi.

## Goals

1. Delete Umans from runtime, schema, UI, tests, and docs — no dormant adapter or hidden ID.
2. Keep existing installs working without user action: silently strip Umans from configs and old snapshots.
3. Make the contract break explicit via `schemaVersion: 2`.
4. Record an owner-approved scope amendment to the design and plan.

## Non-goals

- Rewriting `~/.pi/agent/auth.json` to delete `auth.umans`
- Rewriting on-disk KConfig to purge orphan `umans*` keys
- Behavior changes to Claude / Codex / Grok / Kimi adapters beyond shared ID/order lists
- KDE Store publication or marketing work beyond CHANGELOG + plasmoid metadata description
- Long-term dual-schema support (v1 accepted only as a one-shot migration input)

## Decisions

| Decision | Choice |
|---|---|
| Removal depth | A — delete end-to-end (code, schema ID, UI, tests, docs) |
| Upgrade behavior | A — silently drop/ignore `umans` on read |
| Schema | B — bump to schema v2 with explicit migration that strips `umans` |
| Approach | 1 — migrate-then-validate; no dual-schema forever; no hard-cut empty flash |

Canonical provider order after removal: `claude`, `codex`, `grok`, `kimi`.

## §1 Contract (schema v2)

### Shape

- `SCHEMA_VERSION` becomes `2`. Fresh collector output always emits `schemaVersion: 2`.
- `PROVIDER_IDS` becomes `["claude", "codex", "grok", "kimi"]`.
- Delete all Umans contract types (`UmansDetails`, `UmansProviderRecord`, related non-empty details, discriminated-union arms).
- Runtime validation no longer accepts `id: "umans"` or `details.umans` on a v2 document.

### Migrate-then-validate

Both TypeScript `validateCollectorDocument` and QML `collector-validator.js` apply the same rule before narrowing:

1. If input is a record with `schemaVersion === 1`: clone a working copy, remove every provider whose `id === "umans"`, set `schemaVersion` to `2`, then validate as v2.
2. If input is already `schemaVersion === 2`: validate as today (unknown IDs including `umans` fail).
3. Any other version → unsupported schema version (unchanged).

Migration never invents data. It only strips Umans records and rewrites the version. If the remainder is still invalid, validation fails normally.

Cache envelopes and fixtures move to v2. There is no permanent dual-schema accept path.

### Docs

`docs/architecture/collector-contract.md` examples and prose move to v2 and document the one-shot v1→v2 strip. Kimi concurrency is described on its own terms (no “mirrors Umans”).

## §2 Collector

### Delete

- `collector/src/providers/umans/` (`auth.ts`, `fetch.ts`, `usage.ts`, `adapter.ts`)
- `collector/test/providers/umans/` and any Umans-only fixtures

### Wire-up

- Registry: drop Umans registration; canonical order Claude → Codex → Grok → Kimi.
- Default enabled providers: the same four IDs.
- CLI / `parseCollectorConfig`: if `enabledProviders` lists `"umans"`, silently drop it (then dedupe). Remaining unknown non-umans IDs still fail. An empty list after strip is allowed.
- Collect / LKG cache: no Umans-specific branches. Cache reads go through migrate-then-validate so a stored v1 envelope with Umans is stripped before use or rewrite.
- Auth: stop reading `auth.umans` and `UMANS_API_KEY`. No auth-file writes for Umans (none existed). General redaction stays; no Umans-only redaction path is required.

### Tests

Rewrite integrated/CLI/contract/registry/config/cache tests that assumed Umans. Add focused coverage for:

- v1 document with Umans → valid v2 without Umans
- `enabledProviders` containing `umans` → ignored
- Registry/default config never select Umans

## §3 Plasma UI and config

### Known-provider set

Everywhere becomes `["claude", "codex", "grok", "kimi"]`:

- `config-model.js` (`KNOWN_PROVIDERS`, defaults, visibility, accent/icon loops)
- `compact-model.js`, `full-model.js` (delete `umansFacts` and related helpers)
- `collector-validator.js` (schema v2 + migrate-then-validate; drop Umans detail keys)
- `collector-command.js` allowlist
- `configProviders.qml`, `configTheming.qml` — remove Umans controls
- Compact/full QML label/icon switches — drop `umans` cases
- `main.xml` — remove `umansVisible`, `umansAccentColor`, `umansCustomIcon`; default `providerOrder` → `claude,codex,grok,kimi`
- Plasmoid `metadata.json` description — four-provider set without Umans

### Silent config upgrade

- Once Umans leaves `KNOWN_PROVIDERS`, `sanitizeProviderOrder` already drops unknown IDs and appends missing known ones.
- Do not keep `umansVisible` / accent / icon on the sanitized settings object.
- Orphan KConfig keys may remain on disk unread; no write-back purge is required.

### QML tests

Rewrite Umans cases. Add a validator test: a v1 document containing Umans migrates to a valid v2 snapshot without Umans. Update config sanitize, compact/full, theming, and wiring tests accordingly.

## §4 Docs, scope, verification

### Normative scope amendment

Amend supported providers to **Claude, Codex, Grok, Kimi** (no Umans) in:

- `docs/specs/2026-07-10-kuota-design.md`
- `PLAN.md` (scope bullets and historical Umans milestone text may note the later removal; current scope must not list Umans as supported)
- `AGENTS.md`, `README.md`, architecture overview/contract, theming design mentions
- `CHANGELOG.md` entry for the removal + schema v2

Record this document’s owner decisions as the explicit scope-change approval.

### Verification gates

- `npm run typecheck`
- `npm test` under temporary synthetic `HOME`
- `npm run test:qml` (after clean `dist/` hygiene per project lessons)
- `npm run validate:plasma`
- `npm run build:artifact` / package check — packaged collector emits one schema-v2 document with no Umans ID
- Fixture/secret-safety scan still passes

### Stop conditions (unchanged)

Credential exposure, auth-file truncation/mode change, malformed snapshot acceptance, or unbounded provider calls remain stop conditions. Migration must not accept malformed non-Umans data while stripping Umans.

## Architecture sketch

```text
v1 snapshot / old config
        │
        ▼
 migrate: drop umans, rewrite schemaVersion→2
        │
        ▼
 validate as schema v2 (claude|codex|grok|kimi only)
        │
        ▼
 Plasma models / collector cache / UI
```

Fresh collection never produces Umans: registry and defaults exclude it.

## Implementation order (planning hint)

1. Contract + dual validators (TS/QML) + migration tests (RED→GREEN)
2. Delete Umans adapter; update registry/config/CLI
3. Plasma config/UI/models/command allowlists
4. Fixtures and full test rewrites
5. Docs / PLAN / AGENTS / CHANGELOG / metadata
6. Full gate under synthetic `HOME`

## Open questions

None remaining after owner approval of §§1–4.
