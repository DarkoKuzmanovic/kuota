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
- Test and collector builds must clean only their own ignored output directory before TypeScript emit; stale compiled files can otherwise survive source deletion and create false-green test/build evidence.
- Atomic JSON/auth/cache paths must live under trusted ancestors; the immediate parent is required to be a real, current-user-owned directory without group/other write permission. Treat `post-commit` durability failure as indeterminate success and re-read instead of blindly retrying.
- Provider adapters are trusted in-process code and receive native fetch-compatible `AbortSignal`s. Abort listeners must never throw; callback failures must become adapter promise rejections. Direct CLI execution converts otherwise-uncaught failures to one constant diagnostic and immediate nonzero exit.
- Each milestone must pass its exit gate before the next begins. Increment milestone counters when reviews, correction rounds, oracle consultations, or direct implementation edits occur.

## Milestone 1 — Written-Spec Gate and Project Foundations

**Outcome:** Obtain approval, establish the package/test skeleton, and freeze a tested normalized contract and security boundary before provider or UI feature work.  
**Counters:** reviews: 18 · fix-cycles: 10 · oracle: 1 (second failed M1.5 fix attempt) · direct-edits: 4

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

- [x] **M1.4 — Specify and test normalized collector schema v1**
  - **Files:** `collector/src/contract/schema-v1.ts`, `collector/src/contract/validate.ts`, `collector/test/contract/schema-v1.test.ts`, `docs/architecture/collector-contract.md`
  - **Work:** Define collection start/end timestamps, configured-provider records, four provider states, last-success timestamp, common usage windows, optional percentage/used/limit/reset fields, namespaced provider details, and secret-free status text. Define whole-document validation and explicit rejection of unsupported schema versions.
  - **Acceptance criteria:** Valid full, minimal, optional-field, partial-provider-failure, and unlimited-plan documents pass; malformed timestamps, percentages, counts, states, provider IDs, versions, and partial documents fail clearly; missing optional data is omitted; the documented examples validate.
  - **Evidence (2026-07-10):** Test-first schema/runtime validator, contract documentation, and 23 explicit normalized fixtures completed. Final independent verification: `npm run typecheck` exit 0; `npm test` exit 0 with 121/121 across 14 suites; collector build exit 0; CLI output validates as schema v1; all 23 fixtures pass automatic and standalone secret scans. Scrutinize cycle 1 returned FIX-FIRST for type/runtime discrimination, stale retention, and fixture regression coverage; cycle 2 returned SHIP. Non-Anthropic deep code review returned APPROVED WITH FIXES; boundary and mixed-invalid-state tests plus timestamp clarity fixes were applied and self-verified without re-review.
  - **Dependencies:** M1.2 and M1.3.
  - **Suggested lane:** hard (contract choices constrain collector and QML).

- [x] **M1.5 — Define provider adapter and collector orchestration interfaces**
  - **Files:** `collector/src/providers/types.ts`, `collector/src/providers/registry.ts`, `collector/src/collect/types.ts`, `collector/test/providers/registry.test.ts`
  - **Work:** Define adapters that accept isolated dependencies and return one normalized provider result without throwing secrets across the boundary. Define configured/enabled provider selection, stable IDs/order, timeout/cancellation inputs, and error-to-state mapping contracts; register only Claude, Umans, and Codex placeholders.
  - **Acceptance criteria:** Typecheck prevents provider-native payloads from leaking into common records; registry rejects unknown/duplicate IDs; disabled providers are not selected; adapter errors can be converted to safe states independently; no network or credential read occurs in registry tests.
  - **Evidence (2026-07-10):** Explicit-ID adapters, mapped heterogeneous unions, correlated registrations/collection outcomes, nominal runtime-validated provider results, safe stale/error mapping, canonical placeholders, and clean output scripts completed test-first. Final verification: typecheck exit 0; tests 133/133 across 14 suites; collector/artifact builds and source+packaged CLI schema validation pass. Scrutinize cycles 1 and 2 both returned FIX-FIRST; the second-failed-fix oracle trigger was logged and a non-Anthropic Terra oracle prescribed the final contract shape. Oracle-guided fixes were independently verified, DeepSeek final review returned APPROVED, and its single mechanical frozen-selection fix was self-verified without re-review.
  - **Dependencies:** M1.4.
  - **Suggested lane:** medium.

- [x] **M1.6 — Build safe filesystem primitives test-first**
  - **Files:** `collector/src/io/atomic-write.ts`, `collector/src/io/permissions.ts`, `collector/src/io/json-file.ts`, `collector/test/io/atomic-write.test.ts`, `collector/test/io/json-file.test.ts`
  - **Work:** Implement latest-read JSON loading plus atomic replacement helpers for usage caches and future auth persistence. Separate cache-write mode from permission-preserving shared-auth writes; clean temporary files on failure; never truncate the destination on failed serialization or rename.
  - **Acceptance criteria:** Tests prove restrictive new-cache permissions, preserved existing auth mode, preserved unrelated JSON entries through a simulated merge, atomic destination replacement, failure-safe original contents, and cleanup of temporary files. Tests use temporary synthetic files only.
  - **Evidence (2026-07-10):** Handle-based no-follow JSON reads, plain/cycle/getter-safe validation, same-directory exclusive temp writes, file+directory durability sync, ordinary-mode preservation, bounded collision retry, latest-read identity conflict detection, trusted-parent checks, fatal UTF-8 handling, and value-free failures completed test-first. Final verification: typecheck exit 0; tests 162/162 across 14 suites; collector/artifact builds pass. Scrutinize cycle 1 returned FIX-FIRST; cycle 2 returned SHIP. Terra review returned FIX-FIRST for fatal UTF-8/trusted-parent/real-CAS coverage; semantic fixes were independently verified and Terra re-review returned APPROVED.
  - **Dependencies:** M1.2 and M1.3; schema-aware cache tests may use M1.4.
  - **Suggested lane:** hard (security-sensitive shared-state boundary).

- [x] **M1.7 — Create the collector CLI contract shell**
  - **Files:** `collector/src/cli.ts`, `collector/src/collect/collect.ts`, `collector/test/cli.test.ts`
  - **Work:** Wire dependency-injected placeholder adapters through bounded concurrent orchestration, validate the final schema, print exactly one JSON document to stdout, and redact stderr. Add exit behavior for catastrophic collection/validation failure without treating one provider failure as catastrophic.
  - **Acceptance criteria:** CLI tests prove one stdout document, schema validity, independent provider outcomes, bounded timeout behavior, deterministic completion timestamps, redacted diagnostics, no credential arguments, and no overlap within one invocation. No live provider request is made.
  - **Evidence (2026-07-11):** Canonical concurrent orchestration, independent native cancellation budgets, abort-ignoring timeout races, correlated runtime result validation, deterministic timestamps, one-document CLI output, constant catastrophic diagnostics, direct-process crash hardening, and mandatory packaged-CLI contract validation completed test-first. Final standard-shell verification: typecheck exit 0; tests 177/177 across 14 suites; collector/artifact builds and Plasma validation pass; source and packaged CLIs each emit one newline-terminated schema-v1 document with byte-empty stderr. Scrutinize cycle 1 returned FIX-FIRST for abort-listener crash leakage and evidence gaps; cycle 2 returned SHIP after hardening. Terra final review returned APPROVED with no findings.
  - **Dependencies:** M1.3–M1.6.
  - **Suggested lane:** hard.

- [x] **M1.8 — Verify and document the foundation gate**
  - **Files:** `README.md`, `docs/architecture/overview.md`, `PLAN.md`
  - **Work:** Document layer ownership, commands, generated artifacts, fixture policy, stdout/stderr rules, and the bridge replacement boundary. Run typecheck, unit tests, secret scan, schema example validation, Plasma metadata validation, and minimal QML load validation; record results under Gate G1.
  - **Acceptance criteria:** Every command passes from a clean checkout; docs match actual scripts/layout; no provider logic or credentials have entered QML; a review confirms the contract and sensitive-write design; Gate G1 is recorded with evidence.
  - **Evidence (2026-07-11):** Added and mechanically anchor-checked `README.md` and `docs/architecture/overview.md`, documenting present-vs-future boundaries, exact scripts/artifacts, schema/provider ownership, fixture policy, CLI purity/crash rules, atomic-IO caveats, and the replaceable unimplemented bridge. Standard working-tree gate passed typecheck, tests 177/177 across 14 suites, collector build, Plasma/QML validation, and artifact/packaged-CLI validation. A detached clean worktree at committed M1.7 revision `bb60a2e` reproduced the same gate after `npm ci --ignore-scripts` (3 packages, 0 vulnerabilities). Scrutinize cycle 1 returned FIX-FIRST for five factual overclaims; cycle 2 returned SHIP after corrections. Terra final security/architecture review returned APPROVED with no blocker, should-fix, or nit.
  - **Dependencies:** M1.2–M1.7.
  - **Suggested lane:** medium, plus a separate hard security/architecture review.

**Milestone 1 exit gate:** G0 remains passed, G1 passes, all M1 checkboxes are complete, tests/typecheck/package checks pass, normalized schema v1 is reviewed, and no live credential or provider behavior has been introduced outside the collector boundary.

## Milestone 2 — Claude Adapter and Cache/Backoff Behavior

**Outcome:** Deliver a test-first Claude adapter using Anthropic OAuth usage data, a Kuota-owned last-known-good cache, model-specific windows, bounded live fetch, `Retry-After`, minimum 429 backoff, and stale fallback.
**Key deliverables:** Claude synthetic fixtures; credential lookup isolated in collector; cache freshness policy; normalized windows; safe auth-needed/error states; no OAuth mutation.  
**Exit gate:** Valid/malformed/optional/model-window responses, cache precedence, stale fallback, 429/backoff, timeout, redaction, and normalized schema tests pass.  
**Depends on:** Milestone 1.  
**Counters:** reviews: 22 · fix-cycles: 11 · oracle: 2 (M2.2 parser escalation; M2.5 high-risk composition critique) · direct-edits: 4

- [x] **M2.1 — Implement Claude credential discovery and auth-state classification test-first**
  - Reads only the injected/default `anthropic` entry in `~/.pi/agent/auth.json`; no env or Claude Code fallback, mutation, cache, or network behavior.
  - **Evidence (2026-07-11):** Safe no-follow auth discovery, realistic forward-compatible Pi OAuth parsing, expiry classification, total value-free reader-error mapping, injected path/clock seams, and synthetic-only tests completed. Final verification: typecheck exit 0; tests 190/190 across 14 suites; collector/artifact builds pass. Scrutinize cycle 1 returned FIX-FIRST for unknown-field rejection and hostile thrown-value escape; cycle 2 returned SHIP. Terra final security/API review returned APPROVED with no findings.

- [x] **M2.2 — Validate and normalize Claude usage responses test-first**
  - Supports proven legacy windows plus current generic `limits[]`, null-id scoped model limits, offset timestamps, deterministic collision-safe IDs, typed extra-usage minor-unit details, and safe omission of unsupported spend/dashboard data.
  - **Decision (2026-07-11):** Kuota owns its last-known-good cache; it will not read or write pi-hud's private cache format.
  - **Evidence (2026-07-11):** Pure hostile-input-safe response normalization and schema-v1/runtime-validator parity completed. Final verification: typecheck exit 0; tests 223/223 across 14 suites; collector/artifact builds and Plasma validation pass. Scrutinize cycles 1 and 2 returned FIX-FIRST for live-shape drift, timestamp/scope/identity/precedence issues; Oracle resolved the second failed fix attempt, with a deliberate override to retain current null-id Fable limits using safe display identity; cycle 3 returned SHIP. Final code review returned APPROVED WITH FIXES for overage/drift isolation; two focused re-reviews found and closed credential-shaped currency/model-label isolation gaps; final sign-off returned APPROVED.

- [x] **M2.3 — Implement Kuota-owned Claude last-known-good cache test-first**
  - Uses exact versioned normalized-record envelopes at injected/default `~/.cache/kuota/claude.json`; safe reads never create directories, while writes prepare only a trusted private `kuota` child and atomically store 0600 data.
  - **Evidence (2026-07-11):** Exact envelope/runtime-record validation, fresh stale-record reconstruction, no-follow reads, corrupted-owned-cache replacement, trusted-parent/0700 directory creation, parent fsync, concurrency conflict handling, restrictive atomic writes, post-commit re-read semantics, and credential/raw-response exclusion completed. Final verification: typecheck exit 0; tests 246/246 across 14 suites; collector/artifact builds and Plasma validation pass. Scrutinize cycle 1 returned SHIP; final Opus security/API review returned APPROVED with no blockers or should-fixes.


- [x] **M2.4 — Implement bounded Claude OAuth usage fetch and backoff classification test-first**
  - Uses an injected native-fetch seam with the exact Claude usage endpoint and OAuth headers, token-only authorization, manual redirects, strict status/auth/rate-limit classification, clamped `Retry-After`, a streamed response-byte cap, orchestration-owned cancellation, and value-free failure outcomes; no cache or registry wiring yet.
  - **Evidence (2026-07-12):** Exact request compatibility, pre/post-read abort handling, hostile chunk totality, zero-progress rejection, exact-cap acceptance, reader cancellation, strict status/header parsing, body-size bounds, token non-leakage, and safe outcome classification completed test-first. Scrutinize cycle 1 returned FIX-FIRST and cycle 2 SHIP; final deep security/API review returned APPROVED WITH FIXES for a resolving-reader cancellation/no-progress gap; focused sign-off correction cycles hardened mutation-sensitive coverage and removed a redundant non-owning cap guard; final focused review APPROVED. Fresh final verification: `npm run typecheck` exit 0; `npm test` exit 0 with 302/302 across 14 suites; `npm run build:collector` exit 0; `npm run validate:plasma` exit 0; `npm run build:artifact` exit 0.


- [x] **M2.5 — Compose and register the Claude adapter with freshness, persisted backoff, and stale fallback test-first**
  - Owns policy across the proven M2.1–M2.4 mechanisms: active bounded backoff, 5-minute Kuota-cache freshness, auth classification, bounded live fetch, recoverable cache self-healing, atomic LKG/backoff persistence, and normalized stale/auth/error fallback. Registers the real Claude adapter while Umans and Codex remain placeholders.
  - **Decision (2026-07-12):** Backoff is a separate versioned, secret-free sidecar under Kuota cache ownership; the M2.3 successful-usage envelope remains unchanged. Valid persisted backoff is honored only through the fetch layer's 24-hour maximum. Benign cache corruption fetches through and self-heals; unsafe cache files fail closed.
  - **Evidence (2026-07-12):** High-risk design critique completed before implementation. Test-first composition covers cache ages 0/<5m/=5m/future, backoff active/expired/corrupt/exact-max/over-max, direct atomic sidecar write/read/clear and trusted-parent failure semantics, live success, 429 retention, auth-needed, recoverable cache self-healing, unsafe-cache fail-closed behavior, stale fallback, hostile seam totality, persistence failures, registry wiring, and secret scans. Scrutinize cycle 1 FIX-FIRST for missing real sidecar persistence coverage; cycle 2 SHIP after correction. Final deep review APPROVED WITH FIXES for benign corrupt-cache recovery; focused post-fix sign-off APPROVED. Task-level verification: `npm run typecheck` exit 0; `npm test` exit 0 with 325/325 across 14 suites; `npm run build:collector` exit 0; `git diff --check` exit 0. G2 intentionally not run until M2.5 was complete.

## Milestone 3 — Codex Adapter and Safe OAuth Persistence

**Outcome:** Deliver a test-first Codex adapter with normal HTTP, stdin-configured curl fallback, primary/secondary windows, genuine plan/credit details, one-time expired-token refresh, and latest-read atomic permission-preserving auth merge.
**Scope decision:** Standard tier with critical protected risk at the shared credential-persistence boundary. One repository and one provider outcome; architecture is resolved; verification is deterministic with synthetic seams. Allowed ceremony is task-local checks, one diagnostic midpoint review with no re-review, and one final G3 review with no repeated whole-milestone pass.
**Review budget:** Exactly two planned review passes: (1) midpoint review after M3.4 and M3.6, focused on subprocess secrecy and auth persistence; (2) final whole-milestone G3 review after M3.1–M3.7. Findings from either pass are fixed and verified with focused checks plus the full required suite, not sent through another review. Any unresolved Blocker stops the milestone for owner decision.
**Depends on:** Milestone 1; reuse only proven generic cache/I/O contracts from Milestone 2 without coupling adapters. No Codex cache policy is added before Milestone 5.
**Counters:** reviews: 2/2 · fix-cycles: 1/2 · oracle: 0 · direct-edits: 7

- [x] **M3.1 — Implement Codex credential discovery and classification test-first**
  - Reads only `auth["openai-codex"]`; accepts OAuth `access` and `accountId` with optional non-empty `refresh` and optional finite `expires`; classifies missing, malformed, expired-with-refresh, expired-without-refresh, unsafe/read-failure, invalid-clock, and hostile values without exposing rejected data. No network or writes.
  - **Evidence (2026-07-12):** RED first failed with missing Codex auth module; focused tests then passed 8/8. Independent verification found and corrected a requirement drift that had made `expires` mandatory: a new RED assertion proved absent expiry must remain available, then GREEN passed. Final current-tree evidence: focused tests 8/8; `npm run typecheck` exit 0; full suite 333/333 across 14 suites. Alternative path traced: absent expiry bypasses the injected clock and returns an available credential without an invented expiry.

- [x] **M3.2 — Implement hostile-input-safe Codex usage normalization test-first**
  - Normalize primary/secondary windows and only genuine provider-native plan, credit, cost, and token facts. Omit unavailable optional values; reject malformed recognized fields; tolerate unknown fields; enforce runtime schema and provider/detail correlation.
  - **Field map frozen (2026-07-12):** OpenAI Codex backend-client source confirms `plan_type`, `rate_limit.primary_window` / `secondary_window` (`used_percent`, `limit_window_seconds`, `reset_at`), `credits` (`has_credits`, `unlimited`, string `balance`), and optional `spend_control.individual_limit` (string `used`). Kuota maps non-empty `plan_type` → `details.codex.plan`, a strict finite non-negative numeric credit balance when credits exist and are not unlimited → `credits`, and strict finite non-negative individual-limit `used` → `cost`; it omits `tokens` because this response does not supply a token total. Third-party captured payloads corroborate the wire names; unknown/additional limits remain out of this slice.
  - **Evidence (2026-07-12):** Initial RED covered missing implementation and malformed fractional `reset_at`; worker GREEN passed 7/7. Independent verification added two mutation-sensitive RED→GREEN corrections: real payload identity metadata (`user_id`, `account_id`, `email`) must be ignored rather than causing whole-response rejection, and present `limit_window_seconds: 0` is malformed even beside a valid percentage. Final current-tree evidence: focused 7/7; `npm run typecheck` exit 0; full suite 340/340 across 14 suites; normalized records pass runtime schema and secret scans.

- [x] **M3.3 — Implement bounded native Codex HTTP transport test-first**
  - GET the approved usage endpoint with token/account data only in headers, manual redirects, native abort, streamed byte limit, strict status/body handling, and value-free outcomes.
  - Curl eligibility is deliberately narrow: native HTTP `401` or `403` only. Redirects classify as auth-needed without curl; abort, network, timeout, 429, 5xx, and malformed responses terminate safely without curl.
  - **Evidence (2026-07-12):** RED first failed because the transport module was absent; worker GREEN passed 12/12. Independent verification added a RED→GREEN resource-lifecycle correction proving every unconsumed response body is cancelled for curl-eligible, redirect, terminal HTTP, malformed-status, and declared-oversize paths. Final current-tree evidence: focused 12/12; `npm run typecheck` exit 0; full suite 352/352 across 14 suites.

- [x] **M3.4 — Implement stdin-configured curl fallback (explicit non-TDD waiver)**
  - Invoke only `curl --config -`; send credentials through child stdin, never argv or environment; bound stdout, stderr, and wall time; parse framed status strictly; terminate the child exactly once; expose no raw stderr, body, token, or account identifier.
  - **Evidence (2026-07-12):** Tests were authored before production code, but the initial missing-module RED command was blocked by the session command guard and was not observed. The owner explicitly accepted a non-TDD waiver; this is not claimed as strict TDD. Independent verification covered exact argv/stdin secrecy, control-character rejection, framing/JSON/status classification, output bounds, timeout/abort/error races, one termination, post-close listener cleanup, and value-free outcomes. Final current-tree evidence: focused 7/7; `npm run typecheck` exit 0; full suite 359/359 across 14 suites; a real installed-curl check emitted the expected final marker from the production escaping form.

- [x] **M3.5 — Implement one-request OAuth refresh transport and lock finite retry policy test-first**
  - Refresh a locally expired credential before usage when possible; otherwise refresh only after the eligible native-plus-curl path remains auth-needed. Accept a strict refresh response with optional rotated refresh token and finite expiry; bound request and response handling.
  - Per collection: at most one refresh and two usage pipelines; each pipeline performs one native request plus at most one eligible curl request; never retry after the post-refresh pipeline.
  - **Evidence (2026-07-12):** Observed RED failed on the missing refresh module; worker GREEN passed 6/6. Independent RED→GREEN verification added the current public Codex OAuth client identity header and hard maximum byte ceilings for both native usage and refresh transports, closing caller-configured unbounded-response bypasses. The transport proves at most one refresh request per invocation; M3.7 remains responsible for table-driven enforcement of the locked one-refresh/two-usage-pipeline composition policy. Final current-tree evidence: refresh focused 6/6; native fetch focused 12/12; `npm run typecheck` exit 0; full suite 365/365 across 14 suites.

- [x] **M3.6 — Implement latest-read atomic permission-preserving auth merge (explicit non-TDD waiver)**
  - Re-read the latest auth document and require the initiating Codex type, account ID, access token, and refresh token to match before merging refreshed fields. Preserve unrelated root entries, unknown Codex fields, and existing mode; treat an already-equivalent refreshed entry as idempotent success.
  - Use identity-bound same-directory atomic replacement with restrictive temp permissions, fsync durability, cleanup, trusted-parent enforcement, concurrent-change refusal, and post-commit re-read semantics. Persistence failure/conflict prevents use of unpersisted refreshed credentials.
  - **Evidence (2026-07-12):** The worker did not produce an observed RED despite the explicit requirement; the owner accepted a second explicit non-TDD waiver because current-tree verification is strong and the planned midpoint review independently attacks this critical boundary. This is not claimed as strict TDD. Focused persistence tests pass 15/15, covering actual mode/unrelated/unknown-field preservation, omitted refresh/expiry preservation, zero-write idempotency, rotated-refresh conflict, missing/malformed/mismatched entries, metadata and external-writer races, open/write/fsync/chmod/close/rename/serialize failures, temp cleanup, and one post-commit read-back with indeterminate outcome. `npm run typecheck` exit 0; full suite 380/380 across 14 suites.

- [x] **M3 midpoint review — diagnostic protected-boundary review, not a gate**
  - **Verdict (2026-07-12):** No Blocker; one Important integration-coverage gap; two Minors. The reviewer verified curl argv/stdin secrecy, injection rejection, framing, bounds, race settlement, latest-read identity CAS, true post-image idempotency, mode/unrelated/unknown-field preservation, conflict cleanup, and post-commit indeterminate behavior. The Important finding was fixed without re-review by adding a production `defaultSpawn` round-trip test through an executable curl stub; focused curl tests now pass 8/8, typecheck exits 0, and the full suite passes 381/381.
  - **Minor dispositions:** Do not add `curl -q` because the owner-approved contract currently requires exact argv `curl --config -`; the same-user `~/.curlrc` robustness risk remains documented. SIGKILL escalation/unref remains deferred as low-likelihood defense-in-depth because curl has both its own `max-time` and Kuota's wall timer. Per owner protocol, no re-review was dispatched.

- [x] **M3.7 — Compose and register the finite Codex adapter (partial-TDD waiver)**
  - Compose credential classification, normalization, native/curl transport, refresh-once logic, and persistence into one total adapter. Replace only the Codex registry placeholder; Claude remains unchanged and Umans remains a placeholder.
  - Run adapter, registry, CLI, artifact, and mutation-sensitive tests under an injected synthetic `HOME`; no test or gate may read or write the real `~/.pi/agent/auth.json` or require a live account/network.
  - **Evidence (2026-07-12):** The registry slice produced an observed RED for missing `CODEX_ADAPTER`; the adapter-specific RED command was superseded by the command guard, so the owner accepted an explicit partial-TDD waiver and no stronger TDD claim is made. Adapter tests pass 16/16, including hard maxima of one refresh, two native requests, and two curl requests; no post-refresh retry; persistence updated/already-current gating; conflict/error/indeterminate refusal; local-expiry and 401→curl paths; thrown seams; malformed parsing; and credential identity. Registry+CLI tests pass 28/28; typecheck and full suite pass 398/398 across 14 suites under synthetic `HOME`. Collector build, Plasma validation, and artifact build pass. Real `~/.pi/agent/auth.json` dev/ino/size/mtime/mode/SHA-256 remained unchanged across verification.

- [x] **G3 — Run the single final whole-milestone gate review**
  - **G3 PASS (2026-07-12):** Isolated synthetic-`HOME` gate: `npm run typecheck`, 398/398 tests across 14 suites, collector build, Plasma validation, artifact build, packaged-artifact check, and `git diff --check` all exit 0; real auth dev/ino/size/mtime/mode/SHA-256 remained unchanged.
  - **Single final review:** Fresh deep whole-M3 review traced auth discovery, field normalization, native/curl/refresh bounds, process lifecycle, one-refresh/two-pipeline call caps, persistence gating, latest-read CAS, registry/CLI/artifact isolation, and design/PLAN consistency. Verdict **G3 SHIP** with no Blocker and no Important findings. Notes only reiterated the owner-waived same-user curlrc risk, public OAuth client-id provenance, and deliberate fail-closed bounds.
  - No G3 findings required fixes, so no re-review or post-review correction cycle was dispatched.

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
4. **Resolved:** Kuota owns Claude cache state at `~/.cache/kuota/claude.json`; it does not read or write pi-hud's private cache. The cache uses a versioned normalized-record envelope, private 0700 directory, 0600 atomic file writes, and no credential/raw-response fields.
5. What minimum Claude 429 backoff and default refresh interval are approved, and may provider-specific refresh floors override the global interval?
6. **Resolved from pi-hud provider code:** Claude uses `auth.anthropic = { type: "oauth", access }`; Codex uses `auth["openai-codex"] = { type: "oauth", access, accountId, refresh?, expires? }`; Umans accepts `auth.umans = { type: "oauth", access }` or `{ type: "api_key", key }`, then falls back to `UMANS_API_KEY` only when no supported file entry exists.
7. **Resolved (2026-07-12):** Codex curl fallback is eligible only after native HTTP returns 401 or 403. Redirects classify as auth-needed without curl; abort, network, timeout, 429, 5xx, and malformed responses terminate without curl. Curl is invoked only as `curl --config -` with bounded execution and credentials supplied through stdin.
8. **Resolved (2026-07-12):** A latest-read Codex auth merge requires the current Codex type, account ID, access token, and initiating refresh token to match before replacement; it preserves unrelated entries, unknown Codex fields, and mode, refuses identity/concurrency changes, and treats an already-equivalent refreshed entry as idempotent success.
9. **Resolved (2026-07-12, owner-approved scope correction):** Replace the stale `https://chatgpt.com/backend-api/codex/usage` assumption with `https://chatgpt.com/backend-api/wham/usage`. Current OpenAI Codex backend-client source uses the `/wham/usage` ChatGPT path, corroborated by current captured payloads; the design spec was updated before M3.3.
10. Which compact metric is the default for each provider, and which alternatives are user-selectable?
11. What default caution/critical thresholds apply when a metric is a remaining percentage versus a used percentage or count?
12. Should multiple widget instances share Kuota's cache/backoff state only through files, and what lock or single-writer strategy prevents duplicate live requests?
13. **Resolved:** The target machine provides `kpackagetool6`, `plasmawindowed`, `plasmoidviewer`, `qmllint`, `qmlformat`, and `qmltestrunner`; use them where applicable and keep collector tests under Node's test runner.
14. Are provider/account identifiers allowed internally in memory if fully excluded from normalized output, logs, fixtures, settings, and caches, or must they be minimized further?
15. What artifact format/name/versioning convention is required for later KDE Store suitability?

## Gate Log

| Gate | Requirement | Status | Evidence / owner / date |
|---|---|---|---|
| G0 | Written specification reviewed and explicitly approved for implementation | PASS | Project owner approved the written spec on 2026-07-10; status recorded in the design document |
| G1 | Milestone 1 foundation, contract, security boundary, and package skeleton verified | PASS | M1.1–M1.8 complete. Working-tree and detached-clean-worktree gates passed on 2026-07-11: typecheck, tests 177/177, collector build, Plasma/QML validation, artifact and packaged-CLI validation; documentation anchor checks pass; scrutinize SHIP and final security/architecture review APPROVED |
| M1.3 | Security-critical fixture safety and redaction task review | PASS | Scrutinize cycle 1: SHIP; deep review: APPROVED WITH FIXES; one mechanical fix cycle applied; post-fix typecheck exit 0 and tests 107/107 on 2026-07-10 |
| M1.4 | Public normalized collector contract task review | PASS | Scrutinize cycle 1: FIX-FIRST; cycle 2: SHIP; DeepSeek code review: APPROVED WITH FIXES; two fix cycles total; final typecheck/build/CLI pass, tests 121/121, fixtures 23/23 secret-safe on 2026-07-10 |
| M1.5 | Provider adapter/registry public interface task review | PASS | Scrutinize cycles 1–2: FIX-FIRST; oracle: 1 (second failed fix attempt, Terra due Anthropic quota restriction); oracle-guided contract fix verified; DeepSeek final review: APPROVED; final typecheck/build/artifact/CLI pass and tests 133/133 on 2026-07-10 |
| M1.6 | Security-sensitive atomic filesystem/JSON task review | PASS | Scrutinize cycle 1: FIX-FIRST; cycle 2: SHIP; Terra review: FIX-FIRST then APPROVED after semantic re-review; final typecheck/build/artifact pass and tests 162/162 on 2026-07-10 |
| M1.7 | Collector orchestration and CLI contract task review | PASS | Scrutinize cycle 1: FIX-FIRST; cycle 2: SHIP; Terra final review: APPROVED; final typecheck/build/artifact/Plasma pass and tests 177/177 on 2026-07-11 |
| M1.8 / G1 | Foundation documentation, reproducibility, security, and architecture review | PASS | Scrutinize cycle 1: FIX-FIRST; cycle 2: SHIP; Terra final security/architecture review: APPROVED; detached clean-worktree reproduction at `bb60a2e` passed all foundation gates on 2026-07-11 |
| M2.2 | Claude response normalization and schema review | PASS | Scrutinize cycles 1–2: FIX-FIRST; Opus Oracle escalation; cycle 3: SHIP; final code review APPROVED WITH FIXES; focused final sign-off APPROVED; typecheck/build/artifact/Plasma pass and tests 223/223 on 2026-07-11 |
| M2.3 | Kuota-owned Claude cache security/API review | PASS | Scrutinize cycle 1: SHIP; final Opus review: APPROVED; typecheck/build/artifact/Plasma pass and tests 246/246 on 2026-07-11 |
| M2.4 | Bounded Claude OAuth usage fetch and backoff security/API review | PASS | Scrutinize cycle 1 FIX-FIRST, cycle 2 SHIP; deep final review APPROVED WITH FIXES; three focused correction/sign-off cycles ending APPROVED; final typecheck/build/artifact/Plasma pass and tests 302/302 on 2026-07-12 |
| M2.5 | Claude adapter composition, persisted backoff, cache recovery, and registry review | PASS | Scrutinize cycle 1 FIX-FIRST, cycle 2 SHIP; deep final review APPROVED WITH FIXES; focused post-fix sign-off APPROVED; task checks typecheck/build pass and tests 325/325 on 2026-07-12; G2 deferred until all M2 tasks completed |
| G2 | Claude adapter verified | PASS | M2.1–M2.5 complete. Fresh exit gate on 2026-07-12: typecheck exit 0; tests 325/325 across 14 suites; collector build exit 0; Plasma/QML validation exit 0; artifact build exit 0; diff check clean. Independent whole-milestone security/architecture review traced success and major fallback paths with no Blocker/Important findings and returned G2 PASS. |
| G3 | Codex adapter and auth persistence security-reviewed | PASS | M3.1–M3.7 complete. Isolated gate on 2026-07-12: typecheck exit 0; tests 398/398 across 14 suites; collector build, Plasma validation, artifact build/check, and diff check exit 0; real auth fingerprint/mode/identity unchanged. Midpoint review found one Important defaultSpawn integration-coverage gap, fixed without re-review; final fresh deep whole-milestone review returned G3 SHIP with no Blocker/Important findings. |
| G4 | Umans adapter verified | NOT STARTED | Requires Milestone 4 |
| G5 | Integrated collector verified | NOT STARTED | Requires Milestone 5 |
| G6 | QML bridge and snapshot lifecycle verified | NOT STARTED | Requires Milestone 6 |
| G7 | Compact representation verified | NOT STARTED | Requires Milestone 7 |
| G8 | Full representation verified | NOT STARTED | Requires Milestone 8 |
| G9 | Configuration, accessibility, and UX matrix verified | NOT STARTED | Requires Milestone 9 |
| G10 | Release candidate, local smoke test, and artifact verified | NOT STARTED | Requires Milestone 10; does not authorize publication |

## Handoff Block

- **Current gate:** G4 — Umans adapter verified.
- **Next action:** Decompose Milestone 4 into bounded Umans credential, normalization, transport, and adapter-integration slices before implementation; run G4 only once at milestone end.
- **Resolved blocker (2026-07-12):** The failures were model/provider stream failures that the watchdog correctly contained, but the fallback classifier did not treat watchdog aborts or MiniMax's missing-usage `input_tokens` TypeError as retryable. `pi-subagents` now classifies those two narrow failures for configured model fallback; recon falls back to Luna and worker falls back to Terra. Typecheck, 380 extension tests, Biome, and a fresh-process foreground no-op delegation pass.
- **First implementation action:** Lock Umans credential precedence and unlimited-plan normalization from the approved design, then add the first failing synthetic auth test.
- **Required inputs before execution:** Use only synthetic auth/cache/fetch seams; never log or echo tokens, headers, bodies, account identifiers, native errors, or credential-file contents.
- **Executor rules:** Work milestone-by-milestone; follow task dependencies; write tests first where required; keep secrets out of all artifacts; stop on contract/security ambiguity rather than guessing.
- **Review protocol:** Milestone 3 has exactly two planned review passes: one diagnostic midpoint protected-boundary review after M3.4/M3.6 and one final whole-milestone G3 review after M3.1–M3.7. Findings are fixed and verified deterministically without re-review; unresolved Blockers stop for owner decision.
- **Counter protocol:** Increment `reviews` per completed review pass, `fix-cycles` per review-driven correction round, `oracle` per formal high-risk advisory consultation, and `direct-edits` per implementation edit made outside the assigned execution workflow.
- **Stop conditions:** Credential exposure, auth-file truncation/mode change, overlapping refresh, malformed snapshot acceptance, unbounded provider call, or any pressure to publish without separate approval.
- **Completion definition:** G0–G10 pass, all milestone exit gates are satisfied, live smoke tests are recorded, a reproducible artifact is produced, and KDE Store publication remains explicitly unperformed.
