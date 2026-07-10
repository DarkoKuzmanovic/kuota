# Kuota Project Plan

**Source of truth:** `docs/specs/2026-07-10-kuota-design.md` (approved for implementation by the project owner on 2026-07-10)  
**Plan status:** G0 passed; Milestone 1 foundation work ready to begin  
**Scope:** Plasma 6 widget, bundled short-lived Node collector, configuration, tests, local lifecycle scripts, documentation, and a package artifact for Claude, Umans, and Codex.

## Approved Decisions

1. Kuota is a standalone KDE Plasma 6 widget that refreshes independently of Pi and reports authoritative provider data rather than estimating quota from local activity.
2. V1 supports exactly Claude, Umans, and Codex; additional providers, cross-machine aggregation, history charts, notifications, account management, a permanent service, and KDE Store publication are out of scope.
3. The compact representation is one configurable horizontal KVitals-style line; the full popup and desktop representation share a responsive, CodexBar-inspired view that remains native to Plasma.
4. Users can configure provider visibility/order, icons/text mode, labels, separators, font sizing, compact metric choices, reset countdown visibility, refresh interval, and caution/critical thresholds and colors.
5. Every genuine provider field may be displayed. Missing fields are omitted, unlimited plans do not receive invented percentages, and visually symmetric cards never justify fabricated data.
6. The package has three isolated layers: Plasma QML UI, one QML executable-bridge component, and a bundled short-lived Node collector.
7. The initial bridge may use `org.kde.plasma.plasma5support` executable DataSource, but that compatibility dependency must remain isolated and replaceable.
8. The collector owns credential access, provider I/O, normalization, caching, backoff, token refresh, and safe persistence. Credentials never cross into QML or command arguments.
9. Refreshes never overlap. Enabled providers are fetched concurrently with bounded timeouts, and one provider failure does not prevent successful provider records from updating.
10. Collector output is one versioned normalized JSON document. QML validates the entire response before replacing its snapshot; malformed output is rejected without mixing old and new state.
11. Last-known-good data survives transient failures and is marked stale. Supported provider states are `ok`, `stale`, `auth-needed`, and `error`.
12. Claude prefers a fresh shared pi-hud cache, keeps its own safe cache, fetches live only when needed, honors `Retry-After` and minimum 429 backoff, and retains stale data on failure.
13. Codex uses normal HTTP first, may fall back to curl through stdin configuration for Cloudflare/TLS rejection, refreshes an expired OAuth token once, and persists refreshed auth via latest-read atomic permission-preserving merge.
14. Umans reports rolling-window requests, optional limits, reset/window data, concurrency, and optional concurrency limits; unlimited request plans show counts and timing only.
15. `~/.pi/agent/auth.json` is sensitive shared state. Caches contain usage only; temporary/cache writes use restrictive permissions; logs, fixtures, status text, stdout, and stderr contain no secrets or account identifiers.
16. Plasma theme colors, sizing, typography, focus behavior, keyboard navigation, accessible labels, and light/dark legibility are release requirements.
17. Local install/update/uninstall scripts, tests and secret-free fixtures, README, architecture notes, and a package artifact are V1 deliverables.
18. KDE Store publication is a separate explicitly approved release step.
19. No implementation may begin until the written specification is reviewed and explicitly approved.

## Conventions

- Treat the design document as normative; record design changes as explicit approvals before altering scope or behavior.
- Use test-first slices for every provider adapter and all security-sensitive auth persistence.
- Keep provider collection and credentials entirely outside QML; only normalized, secret-free JSON crosses the bridge.
- Keep the executable mechanism behind one QML bridge component so the Plasma compatibility API can be replaced without touching views.
- Use Node built-ins where practical; justify and pin any runtime dependency before adding it.
- Use strict TypeScript/JavaScript validation at external boundaries; do not use `any`, unchecked casts, or non-null assertions.
- Represent timestamps as UTC ISO 8601 strings in the collector contract; calculate countdown presentation in QML from reset timestamps.
- Omit unavailable optional keys instead of emitting `null`, placeholders, zeroes, or inferred equivalents unless the schema explicitly requires a nullable value.
- Keep provider-specific payloads namespaced under their provider record; common windows use stable IDs and human-readable labels.
- Never log raw provider responses, authorization headers, tokens, refresh tokens, auth files, curl configuration, or account IDs.
- Keep stdout machine-readable: exactly one JSON result document per collector invocation. Send only redacted diagnostics to stderr.
- Use bounded network/process timeouts, non-overlapping refreshes, and atomic last-known-good cache replacement.
- Write sensitive files with restrictive permissions and preserve existing auth-file mode and unrelated entries.
- Keep fixtures synthetic and recognizable as non-secrets; add automated secret/redaction assertions.
- Follow Plasma 6 package conventions and Kirigami/Plasma components; avoid custom visual behavior when a native accessible component exists.
- Test malformed, missing, optional, stale, auth-needed, error, partial-success, narrow-layout, and light/dark paths—not only happy paths.
- Do not hand-edit generated package artifacts or lockfiles; modify sources and regenerate with the documented command.
- Project layout: Plasma sources live under `plasmoid/`; collector TypeScript under `collector/src/`; tests under `tests/`; generated collector and package artifacts under ignored `dist/`.
- Build the collector with `npm run build:collector`; validate the package with `npm run validate:plasma`; build the distributable with `npm run build:artifact`.
- Each milestone must pass its exit gate before the next begins. Increment milestone counters when reviews, correction rounds, oracle consultations, or direct implementation edits occur.

## Milestone 1 — Written-Spec Gate and Project Foundations

**Outcome:** Obtain approval, establish the package/test skeleton, and freeze a tested normalized contract and security boundary before provider or UI feature work.  
**Counters:** reviews: 2 · fix-cycles: 1 · oracle: 0 · direct-edits: 3

- [x] **M1.1 — Complete and record written-spec approval**
  - **Files:** `docs/specs/2026-07-10-kuota-design.md`, `PLAN.md`
  - **Work:** Have the written design reviewed against product, Plasma, provider, and credential-safety requirements. Resolve review findings in the design first, then record approver/date and open Gate G0 in the Gate Log. Do not create implementation files before this task passes.
  - **Acceptance criteria:** Review findings are resolved or explicitly deferred; the design status is approved for implementation; Gate G0 has approver and date; no unresolved blocker is hidden in notes.
  - **Dependencies:** None; hard prerequisite for M1.2–M1.8 and every later milestone.
  - **Suggested lane:** easy (review coordination and documentation only; escalate security or architecture disputes to hard/oracle review).

- [x] **M1.2 — Establish the standalone project and Plasma package skeleton**
  - **Files:** `package.json`, `tsconfig.json`, `.gitignore`, `plasmoid/metadata.json`, `plasmoid/contents/ui/main.qml`, `collector/src/cli.ts`, `tests/`
  - **Work:** Create the minimal repository layout for a Plasma 6 package and bundled Node collector. Author collector code in strict TypeScript and compile it to deterministic runnable JavaScript for installation. Add scripts for typecheck, unit tests, package validation, and artifact build. Keep the initial QML and CLI loadable but feature-free.
  - **Acceptance criteria:** Dependency installation is reproducible; typecheck and empty test suite pass; Plasma tooling accepts metadata with the intended Plasma 6 minimum; QML and TypeScript collector entry points exist without provider logic; the build emits runnable JavaScript for Node >=20; build output is ignored or generated deterministically.
  - **Evidence (2026-07-10):** `npm run typecheck` exit 0; `npm test` exit 0 (1/1 scaffold test); `npm run validate:plasma` exit 0 with package ID `io.github.darkokuzmanovic.kuota`, API minimum 6.0, and MIT metadata; `npm run build:artifact` exit 0 and emitted `dist/artifact/kuota-v0.1.0.plasmoid`; source and packaged collector smoke runs each emitted one schema-v1 JSON document with an empty provider list.
  - **Dependencies:** M1.1.
  - **Suggested lane:** medium.

- [x] **M1.3 — Install the secret-free test and fixture policy**
  - **Files:** `tests/fixtures/README.md`, `tests/security/fixture-safety.test.ts`, `collector/src/security/redact.ts`, `collector/test/security/redact.test.ts`
  - **Work:** Define synthetic fixture rules and a denylist/pattern scan for authorization headers, bearer tokens, refresh tokens, account identifiers, and credential-shaped values. Implement a central redaction helper test-first for all diagnostics and safe status text.
  - **Acceptance criteria:** Tests fail on seeded credential examples and pass on approved synthetic fixtures; redaction covers nested error metadata without echoing raw response bodies; no real credential is required to run tests.
  - **Evidence (2026-07-10):** Test-first implementation completed; `npm run typecheck` exit 0; `npm test` exit 0 with 107/107 passing across 14 suites. Scrutinize cycle 1 returned SHIP. Deep code review returned APPROVED WITH FIXES; JWT-value detection, boundary-aware synthetic markers, Error-property key scanning, numeric account-ID scanning, duplicate-test removal, and fail-safe policy docs were corrected and independently reverified without re-review.
  - **Dependencies:** M1.2.
  - **Suggested lane:** medium.

- [ ] **M1.4 — Specify and test normalized collector schema v1**
  - **Files:** `collector/src/contract/schema-v1.ts`, `collector/src/contract/validate.ts`, `collector/test/contract/schema-v1.test.ts`, `docs/architecture/collector-contract.md`
  - **Work:** Define collection start/end timestamps, configured-provider records, four provider states, last-success timestamp, common usage windows, optional percentage/used/limit/reset fields, namespaced provider details, and secret-free status text. Define whole-document validation and explicit rejection of unsupported schema versions.
  - **Acceptance criteria:** Valid full, minimal, optional-field, partial-provider-failure, and unlimited-plan documents pass; malformed timestamps, percentages, counts, states, provider IDs, versions, and partial documents fail clearly; missing optional data is omitted; the documented examples validate.
  - **Dependencies:** M1.2 and M1.3.
  - **Suggested lane:** hard (contract choices constrain collector and QML).

- [ ] **M1.5 — Define provider adapter and collector orchestration interfaces**
  - **Files:** `collector/src/providers/types.ts`, `collector/src/providers/registry.ts`, `collector/src/collect/types.ts`, `collector/test/providers/registry.test.ts`
  - **Work:** Define adapters that accept isolated dependencies and return one normalized provider result without throwing secrets across the boundary. Define configured/enabled provider selection, stable IDs/order, timeout/cancellation inputs, and error-to-state mapping contracts; register only Claude, Umans, and Codex placeholders.
  - **Acceptance criteria:** Typecheck prevents provider-native payloads from leaking into common records; registry rejects unknown/duplicate IDs; disabled providers are not selected; adapter errors can be converted to safe states independently; no network or credential read occurs in registry tests.
  - **Dependencies:** M1.4.
  - **Suggested lane:** medium.

- [ ] **M1.6 — Build safe filesystem primitives test-first**
  - **Files:** `collector/src/io/atomic-write.ts`, `collector/src/io/permissions.ts`, `collector/src/io/json-file.ts`, `collector/test/io/atomic-write.test.ts`, `collector/test/io/json-file.test.ts`
  - **Work:** Implement latest-read JSON loading plus atomic replacement helpers for usage caches and future auth persistence. Separate cache-write mode from permission-preserving shared-auth writes; clean temporary files on failure; never truncate the destination on failed serialization or rename.
  - **Acceptance criteria:** Tests prove restrictive new-cache permissions, preserved existing auth mode, preserved unrelated JSON entries through a simulated merge, atomic destination replacement, failure-safe original contents, and cleanup of temporary files. Tests use temporary synthetic files only.
  - **Dependencies:** M1.2 and M1.3; schema-aware cache tests may use M1.4.
  - **Suggested lane:** hard (security-sensitive shared-state boundary).

- [ ] **M1.7 — Create the collector CLI contract shell**
  - **Files:** `collector/src/cli.ts`, `collector/src/collect/collect.ts`, `collector/test/cli.test.ts`
  - **Work:** Wire dependency-injected placeholder adapters through bounded concurrent orchestration, validate the final schema, print exactly one JSON document to stdout, and redact stderr. Add exit behavior for catastrophic collection/validation failure without treating one provider failure as catastrophic.
  - **Acceptance criteria:** CLI tests prove one stdout document, schema validity, independent provider outcomes, bounded timeout behavior, deterministic completion timestamps, redacted diagnostics, no credential arguments, and no overlap within one invocation. No live provider request is made.
  - **Dependencies:** M1.3–M1.6.
  - **Suggested lane:** hard.

- [ ] **M1.8 — Verify and document the foundation gate**
  - **Files:** `README.md`, `docs/architecture/overview.md`, `PLAN.md`
  - **Work:** Document layer ownership, commands, generated artifacts, fixture policy, stdout/stderr rules, and the bridge replacement boundary. Run typecheck, unit tests, secret scan, schema example validation, Plasma metadata validation, and minimal QML load validation; record results under Gate G1.
  - **Acceptance criteria:** Every command passes from a clean checkout; docs match actual scripts/layout; no provider logic or credentials have entered QML; a review confirms the contract and sensitive-write design; Gate G1 is recorded with evidence.
  - **Dependencies:** M1.2–M1.7.
  - **Suggested lane:** medium, plus a separate hard security/architecture review.

**Milestone 1 exit gate:** G0 remains passed, G1 passes, all M1 checkboxes are complete, tests/typecheck/package checks pass, normalized schema v1 is reviewed, and no live credential or provider behavior has been introduced outside the collector boundary.

## Milestone 2 — Claude Adapter and Cache/Backoff Behavior

**Outcome:** Deliver a test-first Claude adapter using Anthropic OAuth usage data, fresh pi-hud cache preference, Kuota last-known-good cache, model-specific windows, bounded live fetch, `Retry-After`, minimum 429 backoff, and stale fallback.  
**Key deliverables:** Claude synthetic fixtures; credential lookup isolated in collector; cache freshness policy; normalized windows; safe auth-needed/error states; no OAuth mutation.  
**Exit gate:** Valid/malformed/optional/model-window responses, cache precedence, stale fallback, 429/backoff, timeout, redaction, and normalized schema tests pass.  
**Depends on:** Milestone 1.  
**Counters:** reviews: 0 · fix-cycles: 0 · oracle: 0 · direct-edits: 0

## Milestone 3 — Codex Adapter and Safe OAuth Persistence

**Outcome:** Deliver a test-first Codex adapter with normal HTTP, stdin-configured curl fallback, primary/secondary windows, plan/credit details, one-time expired-token refresh, and latest-read atomic permission-preserving auth merge.  
**Key deliverables:** Codex synthetic fixtures; Cloudflare fallback classifier; subprocess timeout/redaction; refresh-once logic; conflict-aware auth persistence tests preserving unrelated entries and mode.  
**Exit gate:** HTTP success, fallback, malformed data, timeout, refresh success/failure, concurrent auth-change preservation, atomic failure, process-argument secrecy, redaction, and schema tests pass.  
**Depends on:** Milestone 1; reuse only proven generic cache/I/O contracts from Milestone 2 without coupling adapters.  
**Counters:** reviews: 0 · fix-cycles: 0 · oracle: 0 · direct-edits: 0

## Milestone 4 — Umans Adapter

**Outcome:** Deliver a test-first Umans adapter for OAuth token or API key usage, rolling request windows, optional request/concurrency limits, reset timing, and unlimited plans without invented percentages.  
**Key deliverables:** Limited/unlimited synthetic fixtures; credential precedence policy; normalized request/concurrency details; safe auth-needed/error states.  
**Exit gate:** Valid, malformed, optional-limit, unlimited, reset conversion, timeout, redaction, and normalized schema tests pass.  
**Depends on:** Milestone 1; may proceed independently of Milestones 2 and 3.  
**Counters:** reviews: 0 · fix-cycles: 0 · oracle: 0 · direct-edits: 0

## Milestone 5 — Integrated Collector, Caching, and Failure Isolation

**Outcome:** Integrate all adapters into one short-lived collector that fetches enabled providers concurrently, enforces bounded timeouts/backoffs, atomically caches last-known-good usage, and emits one validated partial-success-capable document.  
**Key deliverables:** Configuration input contract without secrets; provider-order handling; per-provider freshness; crash/timeout cleanup; integration fixtures and CLI tests.  
**Exit gate:** Mixed success/failure, all-failure, stale cache, malformed provider response, non-overlap, timeout, schema rejection, stdout purity, and secret scan pass across all providers.  
**Depends on:** Milestones 2, 3, and 4.  
**Counters:** reviews: 0 · fix-cycles: 0 · oracle: 0 · direct-edits: 0

## Milestone 6 — QML Bridge and Snapshot State Model

**Outcome:** Add one isolated executable DataSource bridge that launches the collector, prevents overlapping runs, validates complete responses, retains the prior snapshot on failure, tracks stale age, and supports timer/manual refresh.  
**Key deliverables:** Replaceable bridge component; response validator; refresh lifecycle model; safe process failure handling; no credentials in QML/settings/arguments.  
**Exit gate:** QML tests or harness scenarios cover success, malformed JSON, unsupported schema, timeout/crash, stale retention, manual refresh, non-overlap, partial provider success, and bridge dependency isolation.  
**Depends on:** Milestones 1 and 5.  
**Counters:** reviews: 0 · fix-cycles: 0 · oracle: 0 · direct-edits: 0

## Milestone 7 — Compact Panel Representation

**Outcome:** Build the one-line panel summary with provider visibility/order, adapter-selected compact metrics, icons/text modes, labels, separators, font sizing, thresholds/colors, and click-to-open behavior.  
**Key deliverables:** Responsive compact QML; provider model; defaults Claude/Umans/Codex; concise stale/auth/error treatment; accessible labels and focus behavior.  
**Exit gate:** Panel sizing, narrow widths, all display modes, ordering/visibility, thresholds, theme legibility, keyboard access, and representation switching pass.  
**Depends on:** Milestone 6; configuration persistence completes in Milestone 9.  
**Counters:** reviews: 0 · fix-cycles: 0 · oracle: 0 · direct-edits: 0

## Milestone 8 — Full Popup and Desktop Representation

**Outcome:** Build the shared responsive full representation with provider switcher, genuine usage windows, progress/count data, used/remaining values, reset countdowns, provider-specific facts, refresh action, and concise state messaging.  
**Key deliverables:** Reusable cards/rows; adaptive popup/desktop layout; omitted unavailable fields; live countdown; last-success/stale age display; partial-success presentation.  
**Exit gate:** Popup/desktop resizing, each provider payload shape, optional fields, unlimited Umans, stale/auth/error/partial states, countdown updates, light/dark themes, and keyboard/accessibility checks pass.  
**Depends on:** Milestones 6 and 7.  
**Counters:** reviews: 0 · fix-cycles: 0 · oracle: 0 · direct-edits: 0

## Milestone 9 — Configuration and End-to-End UX Hardening

**Outcome:** Deliver persistent settings for every approved V1 option and harden native Plasma behavior, accessibility, localization readiness, refresh defaults, and panel/desktop coexistence.  
**Key deliverables:** Configuration pages; safe settings migration/defaults; reorder control; per-provider compact metric choices; threshold/color controls; countdown toggle; UX test matrix.  
**Exit gate:** Every approved setting persists and updates live; defaults are useful and rate-limit-conservative; invalid settings recover safely; focus order, labels, contrast, scaling, and concurrent instances pass.  
**Depends on:** Milestones 7 and 8.  
**Counters:** reviews: 0 · fix-cycles: 0 · oracle: 0 · direct-edits: 0

## Milestone 10 — Packaging, Local Lifecycle, Documentation, and Release Candidate

**Outcome:** Produce install/update/uninstall workflows, complete operator/architecture documentation, a reproducible widget artifact, and a locally smoke-tested V1 release candidate without publishing it.  
**Key deliverables:** Local lifecycle scripts; README setup/troubleshooting; architecture/security notes; artifact build; complete automated suite; live smoke-test record; uninstall/reinstall safety proof.  
**Exit gate:** All tests pass; all three configured accounts refresh with Pi stopped; credentials are absent from arguments/logs/stdout/settings/caches; panel and desktop coexist; refreshes do not overlap; network failure retains readable stale data; reinstall does not damage auth or Pi caches; artifact installs cleanly. KDE Store publication remains blocked pending separate approval.  
**Depends on:** Milestones 1–9.  
**Counters:** reviews: 0 · fix-cycles: 0 · oracle: 0 · direct-edits: 0

## Open Questions

1. **Resolved:** The project owner approved Gate G0 in-session on 2026-07-10; the design document and Gate Log are the evidence.
2. **Resolved:** Declare `X-Plasma-API-Minimum-Version: "6.0"`, `KPackageStructure: "Plasma/Applet"`, category `System Information`, package ID `io.github.darkokuzmanovic.kuota`, and V1 version `0.1.0`; the target machine runs Plasma 6.7.2.
3. **Resolved:** Author the collector and tests in strict TypeScript, compile the collector to runnable JavaScript for installation/distribution, target system Node.js >=20, and require system Node for V1 rather than bundling a runtime; the target machine runs Node 24.12.0 and npm 11.18.0.
4. What are the exact pi-hud shared-cache path, schema, freshness threshold, ownership, and permission expectations for Claude cache reuse?
5. What minimum Claude 429 backoff and default refresh interval are approved, and may provider-specific refresh floors override the global interval?
6. **Resolved from pi-hud provider code:** Claude uses `auth.anthropic = { type: "oauth", access }`; Codex uses `auth["openai-codex"] = { type: "oauth", access, accountId, refresh?, expires? }`; Umans accepts `auth.umans = { type: "oauth", access }` or `{ type: "api_key", key }`, then falls back to `UMANS_API_KEY` only when no supported file entry exists.
7. Which Codex response conditions specifically qualify for curl fallback, and what curl availability/version assumptions are allowed?
8. How should a latest-read Codex auth merge detect that another process refreshed or replaced the same account during Kuota's refresh?
9. Which compact metric is the default for each provider, and which alternatives are user-selectable?
10. What default caution/critical thresholds apply when a metric is a remaining percentage versus a used percentage or count?
11. Should multiple widget instances share Kuota's cache/backoff state only through files, and what lock or single-writer strategy prevents duplicate live requests?
12. **Resolved:** The target machine provides `kpackagetool6`, `plasmawindowed`, `plasmoidviewer`, `qmllint`, `qmlformat`, and `qmltestrunner`; use them where applicable and keep collector tests under Node's test runner.
13. Are provider/account identifiers allowed internally in memory if fully excluded from normalized output, logs, fixtures, settings, and caches, or must they be minimized further?
14. What artifact format/name/versioning convention is required for later KDE Store suitability?

## Gate Log

| Gate | Requirement | Status | Evidence / owner / date |
|---|---|---|---|
| G0 | Written specification reviewed and explicitly approved for implementation | PASS | Project owner approved the written spec on 2026-07-10; status recorded in the design document |
| G1 | Milestone 1 foundation, contract, security boundary, and package skeleton verified | NOT STARTED | Requires G0 and M1 evidence |
| M1.3 | Security-critical fixture safety and redaction task review | PASS | Scrutinize cycle 1: SHIP; deep review: APPROVED WITH FIXES; one mechanical fix cycle applied; post-fix typecheck exit 0 and tests 107/107 on 2026-07-10 |
| G2 | Claude adapter verified | NOT STARTED | Requires Milestone 2 |
| G3 | Codex adapter and auth persistence security-reviewed | NOT STARTED | Requires Milestone 3 |
| G4 | Umans adapter verified | NOT STARTED | Requires Milestone 4 |
| G5 | Integrated collector verified | NOT STARTED | Requires Milestone 5 |
| G6 | QML bridge and snapshot lifecycle verified | NOT STARTED | Requires Milestone 6 |
| G7 | Compact representation verified | NOT STARTED | Requires Milestone 7 |
| G8 | Full representation verified | NOT STARTED | Requires Milestone 8 |
| G9 | Configuration, accessibility, and UX matrix verified | NOT STARTED | Requires Milestone 9 |
| G10 | Release candidate, local smoke test, and artifact verified | NOT STARTED | Requires Milestone 10; does not authorize publication |

## Handoff Block

- **Current gate:** G1 — Milestone 1 foundation, contract, security boundary, and package skeleton.
- **Next action:** Execute M1.2, then follow the Milestone 1 dependency order.
- **First implementation action:** Execute M1.2 only; do not begin provider or QML feature work early.
- **Required inputs before execution:** None. M1.2 may establish the proposed `package/`, `collector/src/`, and `collector/test/fixtures/` paths and record any change in Conventions.
- **Executor rules:** Work milestone-by-milestone; follow task dependencies; write tests first where required; keep secrets out of all artifacts; stop on contract/security ambiguity rather than guessing.
- **Review protocol:** At each exit gate, run the listed checks, record commands/results in the Gate Log, obtain the required independent review, and update only that milestone's counters.
- **Counter protocol:** Increment `reviews` per completed review pass, `fix-cycles` per review-driven correction round, `oracle` per formal high-risk advisory consultation, and `direct-edits` per implementation edit made outside the assigned execution workflow.
- **Stop conditions:** Credential exposure, auth-file truncation/mode change, overlapping refresh, malformed snapshot acceptance, unbounded provider call, or any pressure to publish without separate approval.
- **Completion definition:** G0–G10 pass, all milestone exit gates are satisfied, live smoke tests are recorded, a reproducible artifact is produced, and KDE Store publication remains explicitly unperformed.
