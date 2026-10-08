# Provider selection governs collection — issue #7

**Status:** implementation approved by the owner's chat directive on 2026-09-09:
“Let's do in that order #7 -> #5 -> #6. then we check and do the 8 and 9 later”.
This records the recommended #7 semantics presented immediately before approval.
**Base:** public main `9b4cfa2f535b3b8eeca1c5040aa9fa270fc07385`.
**Gate:** G-R7. #5 starts after G-R7 verification/review; #6 follows #5.
Publication, merge, installation, live provider/credential access, and #8/#9 are
not authorized by this amendment. The unrelated local M15 selector feature is
not part of this branch.

## Problem and evidence

`main.qml::refresh()` invokes `CollectorBridge.refresh()` without its existing
subset argument. The `<provider>Visible` KConfig keys currently remove entries
from the two views but do not prevent collector auth discovery or requests.
The command builder, CLI/config, registry, and integrated lock/cache boundary
already support explicit canonical subsets, including an empty subset.

## Decisions

| Decision | Behavior |
| --- | --- |
| D-R7.1 — One setting | Retain every existing `<provider>Visible` key and default. Explain the checkbox as enabling both display and collection; do not add a separate near-duplicate collection preference. |
| D-R7.2 — Explicit subset | Derive collection membership from sanitized visibility settings. All seven current providers are allowlisted in canonical order: claude, codex, grok, kimi, cursor, opencode, commandcode. Display reordering is independent of collection membership and must not cause extra requests. |
| D-R7.3 — Empty | All disabled means no new collector process, credential discovery, or provider request. Render the existing empty configuration state, not a fabricated fresh observation. Empty never becomes the CLI default-all case. Direct CLI empty-subset compatibility remains intact. |
| D-R7.4 — Selection transitions | A membership change invalidates the prior selection's UI snapshot and pending result. Idle nonempty selections refresh; if a request is already active, coalesce changes to one latest selection and wait for that request to settle or reach its existing deadline before launching again. Returning A→B→A still rejects the older A result. |
| D-R7.5 — Ownership | Retain the exact source-token guard, one-active-request rule, fixed Node path, quoting/allowlist rules, and existing deadline. Do not assume DataSource disconnect kills/reaps descendants. Disabling prevents future collections; work already launched while enabled may finish, but its obsolete result cannot be accepted. Do not introduce a new process manager or change collector cancellation policy. |
| D-R7.6 — Cache and instances | Preserve whole-collector lock ownership and cache merge policy. Concurrent instances may select different subsets; both successful and lock-fallback documents must contain only each invocation's selected providers. Hidden cached records may be retained on disk for other instances, never reintroduced into the current response. |

## Shape and boundaries

- `plasmoid/contents/ui/main.qml`: bind or pass the sanitized selection for
  startup, manual, automatic, and configuration-change paths. Provide only a
  narrowly bounded nonpersistent fixture seam if a root-wiring test needs one.
- `CollectorBridge.qml`, with `bridge-lifecycle.js`/`collector-command.js` only
  where necessary: own selection/result invalidation and coalescing at the
  process boundary. Prefer small explicit state over another framework. Preserve
  default/subset argument compatibility for existing bridge callers where
  compatible with the no-spawn-empty policy.
- `config-model.js`: derive a canonical enabled-provider array from sanitized
  settings; no raw settings text crosses the command boundary.
- `configProviders.qml`, README and directly affected architecture prose: explain
  display-plus-collection, re-enable refresh, and the in-flight limitation. Keep
  existing stable FormLayout delegates and config keys.
- Existing QML config/root/process/lifecycle tests and collector integration
  tests: extend the real seams. Collector production changes are not expected;
  do not alter provider parsing, credential access, schema, lock or cache safety
  solely to implement UI selection.

## Failure and fallback behavior

Malformed configuration keeps the existing sanitizer defaults, not unchecked
command text. Nonempty same-selection process/validation/timeout failures retain
the existing last-known-good policy. Selection changes clear incompatible UI
state; a discarded old result or timeout must not restore it. No-provider state
has no invented collection timestamp. No new retry timer or provider refresh
policy is added. Rapid setting changes are coalesced rather than overlapped.

## Acceptance / exit gate

- [x] Two providers, including a reordered UI selection, reach the actual
  bridge/CLI as exactly their canonical allowlisted subset.
- [x] Real collector integration with synthetic adapter/auth/fetch spies proves
  disabled providers have zero discovery and fetch calls (also empty subset).
- [x] Empty root and bridge selections launch no new process and cannot fall
  back to default-all; both views expose the empty configuration state.
- [x] Root startup, manual and automatic refresh all use current settings;
  appearance/order-only changes do not recollect.
- [x] Re-enable refreshes safely. Changes during success, process failure,
  invalid output and timeout coalesce; A→B→A, empty→enabled, and stale source
  callbacks cannot publish a pre-change result or clear a newer request.
- [x] Different widget selections and integrated lock/cache fallback preserve
  response membership, no hidden-provider work, and lock/token invariants.
- [x] Focused tests are observed RED before implementation; full Node/QML,
  typecheck, Plasma validation and artifact gates are GREEN under a private
  synthetic HOME and allowlisted environment. Parent rerun and independent
  fail-closed review precede G-R7 closure.

Worker evidence: `../evidence/issue7-worker/` beside the checkout; final gates
are mirrored in `final/` (original runner output: `../evidence/issue7-worker-final/`).
Core process/root/coalescing regressions were observed behaviorally RED before
implementation; final expanded tests were replayed against the public base.
Worker gates: Node 630/0, QML 354/0, typecheck/Plasma/artifact all exit 0.
Checked items mean synthetic automated acceptance only, not live widget or
provider verification. The automatic handler was exercised via its Timer signal,
not a five-minute wall-clock wait. Parent rerun confirmed Node 630/0, QML 354/0
and the other four gates exit 0. Independent review passed implementation tree
`eac6dbf33b655b6e74be62a5000288c0d5a185ff` with no findings; it independently ran
123 QML entries and 3 collector integration tests. G-R7 is closed for the
synthetic-tested code slice, not live acceptance, publication or deployment.
See the parent closure in PLAN.md and `../evidence/issue7-review/`.

> **2026-10-08 landing note** — Merged onto 2.0.0 (M15–M17) with these
> decisions unchanged. `../evidence/` paths above now live under
> `.worktrees/feat-review-7-5-6-evidence/evidence/` (local, untracked).
> Landing gates and review: PLAN.md "G-RL".
