# Provider metadata and cross-layer consistency — issue #5

**Status:** implementation approved by the owner's 2026-09-09 chat directive:
“Let's do in that order #7 -> #5 -> #6. then we check and do the 8 and 9 later”.
**Gate:** G-R5, following G-R7's parent verification and independent PASS.
**Scope:** existing supported providers/settings only; no new selector feature,
contract behavior, runtime dependency, account access, publication or deployment.
The unrelated local M15 selector commit remains excluded. #6 starts after G-R5;
#8/#9 stay deferred until the owner checks the completed batch.

## Problem / verified baseline

Seven-provider order and labels are repeated in QML command, validator,
configuration, presentation and theming code. TypeScript collector defaults
repeat the contract's literal IDs. FullRepresentation's standalone default omits
OpenCode and CommandCode, although production injection masks this. Add Widgets
metadata also omits them. Configuration defaults are repeated in DEFAULTS,
createDefaultSettings(), sanitize(), and the persisted KConfig schema.
Production lint/isolation lists omit `contents/config/config.qml`.

The parent baseline after #7 is Node 630/0 and QML 354/0 with all other gates
passing. A direct isolated `qmllint plasmoid/contents/config/config.qml` passes;
there is no established reason to exclude that production entry.

## Decisions

| Decision | Required shape |
| --- | --- |
| D-R5.1 — Minimal static ownership | Reuse the existing TS contract PROVIDER_IDS as the Node-side ID authority. Introduce one small inert QML provider catalog for shared order, display labels and existing selectable-window facts. Derive same-runtime tables instead of hand-maintaining copies. Do not add an unused second TS label catalog, code generator, registry framework or runtime file-loading mechanism. |
| D-R5.2 — Cross-runtime boundary | Enforce TS/QML ID/order and relevant catalog parity in tests. Retain independent whole-document validators and provider-native parsers; shared facts do not collapse independent trust boundaries. Schema-v1 and ignored legacy Umans input behavior stay intact. |
| D-R5.3 — Current provider set | Preserve canonical order claude, codex, grok, kimi, cursor, opencode, commandcode, all current labels, default visibility, unknown-value behavior and the #7 collection-selection semantics. Standalone full view and package description must include all supported providers. |
| D-R5.4 — Current selector set | Only Claude and Codex have selectable compact-window settings in this public-source line. Share their current catalogs between sanitizer and controls. Do not introduce Grok/Kimi/OpenCode/CommandCode window controls from unpublished M15, or invent provider windows/metrics. |
| D-R5.5 — Settings | Keep every persisted KConfig key, type and default unchanged. Make the sanitizer's default factory and per-provider default/visibility handling derive from one same-runtime definition. Keep specialized constraints (floors, clamp/order, color/icon validation) explicit and preserve defensive array copies. No generic dynamic settings UI. |
| D-R5.6 — Stable views | Keep stable FormLayout delegates, aliases/properties and rendered consumers. Reordering must not recreate controls. Preserve existing translation and display/collection wording; consolidation is not an i18n redesign. |
| D-R5.7 — Coverage inventory | Ensure all production QML/JS entries, including config/config.qml and the new catalog, belong to the appropriate lint/isolation policy. Add a completeness test against discovered production files so a future omitted file fails. Existing explicit lists may remain if their completeness is enforced; no new framework is needed. |

## Per-file shape

- New `plasmoid/contents/ui/provider-catalog.js`: pure `.pragma library` static
  facts and only tiny derivations/copy helpers. No privileged imports or I/O.
- QML command/validator/config/compact/full/theming/provider-page consumers:
  import the catalog for facts they actually share. Preserve old exported
  constants/functions where they are test/library seams. Do not modify a model
  with no duplicated provider metadata merely to add an unused import.
- `collector/src/collect/config.ts` and Node artifact checks: use the existing
  `PROVIDER_IDS` source for enabled-default/order expectations. Registry adapter
  and registration tables may be derived from an existing typed source where
  this removes real duplication without losing provider/result correlation or
  changing compatibility exports. Leave unrelated dispatch/security code alone.
- `config-model.js`: remove redundant default-copy and per-provider lists,
  retaining explicit validation boundaries. `main.xml` remains the persisted
  ABI, with tests enforcing complete key/type/default parity and fallbacks.
- `FullRepresentation.qml`, `plasmoid/metadata.json`: correct missing providers;
  settings remain static controls with shared catalogs where applicable.
- `package.json`, `tests/qml/tst_module_isolation.qml`, and focused new/existing
  tests: include every production entry and fail on drift. Existing Node 20.0.0
  support is mandatory; no newer filesystem/VM/test API without compatibility.
- README/architecture and PLAN.md: document only the actual consolidation and
  tested gates, not unpublished features. Do not rewrite unrelated prose.

## Failure / compatibility behavior

Catalog data is trusted bundled code, not a new configurable provider registry.
Malformed raw settings still use the same schema defaults; unknown/additive raw
keys are not echoed or passed to the command builder. Mutable consumer arrays
must not corrupt defaults or affect another widget instance. Window choices
remain constrained to the current provider's catalog and missing-live-window
fallback remains unchanged. Native payloads and credentials never enter QML.

## Acceptance / exit gate

- [x] Observe genuine RED for the current standalone-full/metadata/coverage
  drift before fixing production, then GREEN. Baseline characterization tests
  that already pass are labeled honestly, not forced into artificial RED.
- [x] A missing/reordered provider in a default/catalog/metadata surface fails a
  targeted test. Same-runtime duplicate metadata is derived from its owner.
- [x] Complete KConfig schema/default/factory/sanitizer key and default parity
  is tested, including malformed/missing inputs, unknown additive raw keys,
  specialized fallback behavior, and defensive copying.
- [x] Current window options agree between controls and sanitization; no new
  provider setting or M15 selector has entered the branch.
- [x] Every production QML/JS entry is covered by its lint/isolation policy;
  a missing entry is a reproducible failing test, not a manually claimed count.
- [x] Mutation probes prove drift gates fail (provider/default/window/settings/
  metadata/inventory changes) instead of only comparing two derived references.
- [x] Stable controls, #7 selection/current-settings wiring, standalone defaults,
  theming/display modes and existing rendering tests remain GREEN.
- [x] Shared synthetic valid/invalid fixtures exercise TS and QML contract
  acceptance parity, including v1/legacy-Umans and fail-closed malformed inputs;
  both independent validators remain production boundaries.
- [x] Sequential isolated full Node/QML, typecheck, Plasma and artifact gates
  pass. Parent rerun and independent fail-closed review close G-R5. No commit,
  source publication, installation or live account test is implied.

Parent closure: all six gates passed on Node 24.15.0 and minimum 20.0.0
(651 Node / 380 QML, zero failures). Independent review passed tree
`8b118022fe77b83f2635efbd57465616a00f7c89`, with its own focused Node20/26,
full QML, compatibility and private mutation checks. See PLAN.md G-R5 closure
and `../evidence/issue5-review/verdict.json`. Live/i18n acceptance is not implied.
