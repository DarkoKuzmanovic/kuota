# Kuota project review — 2026-09-08

## Verdict

**Keep the architecture. Reduce duplicated facts and plumbing, and fix the
lifecycle/package defects before adding more UI.** This is not a rewrite
candidate: the short-lived collector, separate provider parsers, atomic auth
persistence, and presentation-only QML are useful boundaries with substantial
test coverage. The maintenance problem is repeated metadata, copied helpers,
obsolete scaffolding, and documentation that has not kept up with the code.

## Scope and evidence

- Reviewed local `3c123bd` and public `main` at
  [`26e1b38`](https://github.com/DarkoKuzmanovic/kuota/tree/26e1b38b78e53c8c5f2fc2d01acaa81684f61df5).
  Local `main` was one commit ahead: the additional per-provider window
  selectors. This documentation branch starts from the public revision and
  **does not publish that feature commit**.
- Parent review plus two independent, read-only reviews covered collector,
  QML, configuration, tests, packaging, and design/history. Findings below
  distinguish executed probes from source inspection and unmeasured ideas.
- All gates ran sequentially in separate worktrees with private synthetic
  homes and an explicit environment without provider credentials. No live
  provider call, real Cursor database access, or desktop installation was
  performed. Synthetic process probes were explicitly cleaned up.

| Gate | Local reviewed code `3c123bd` | Public-code documentation branch |
|---|---|---|
| Node suite | 579 passed, 0 failed | 579 passed, 0 failed |
| Qt 6 QML suite | 345 passed, 0 failed | 331 passed, 0 failed |
| TypeScript | Exit 0 | Exit 0 |
| Plasma metainfo + QML lint | Exit 0 | Exit 0 |
| Artifact build/check | Exit 0 | Exit 0 |

The different QML totals reflect the unpublished selector commit, not a
regression. Both artifact builds produced `kuota-v1.2.1.plasmoid`. `npm audit`
reported zero known dependency vulnerabilities at review time; that is not a
security certification. No GitHub Actions workflow is configured; these are
local results, not hosted CI results.

Repository measurements at local HEAD: 196 tracked files, 12,498 raw collector
source lines, 3,749 raw UI source lines, and 18,642 raw test/fixture lines.
These include comments and blanks and are not a complexity score. The code is
substantial for a quota widget, but deleting tests or safety checks to lower
that count would be the wrong optimization.

## Prioritized issues

Each issue contains evidence, a bounded proposal, acceptance criteria, risk,
and the requirement for an approved spec before behavior changes.

| Priority | Issue | Why it matters |
|---|---|---|
| P1 | [#1 — Hermetic artifact verification](https://github.com/DarkoKuzmanovic/kuota/issues/1) | A normal build can discover real credentials and reach live provider/cache/auth-refresh paths. |
| P1 | [#2 — Cursor WAL-aware session reads](https://github.com/DarkoKuzmanovic/kuota/issues/2) | Immutable SQLite reads can miss a newly refreshed token in the WAL. |
| P1 | [#3 — Bound and cancel Cursor subprocesses](https://github.com/DarkoKuzmanovic/kuota/issues/3) | Outer deadlines do not kill the credential-discovery child or cap its output. |
| P1 | [#4 — Reliable source updates/artifacts](https://github.com/DarkoKuzmanovic/kuota/issues/4) | An update can silently reuse old code; artifact naming also depends on JSON indentation. |
| P2 | [#5 — Provider/config consistency](https://github.com/DarkoKuzmanovic/kuota/issues/5) | Hand-maintained catalogs already disagree; new providers multiply edit locations. |
| P2 | [#6 — One descriptor-safe JSON guard](https://github.com/DarkoKuzmanovic/kuota/issues/6) | Two near-identical graph validators independently protect read/write boundaries. |
| P2 | [#7 — Deliberate collection selection](https://github.com/DarkoKuzmanovic/kuota/issues/7) | Hidden providers are still collected even though subset transport already exists. |
| P2 | [#8 — Offline doctor and safe freshness diagnostics](https://github.com/DarkoKuzmanovic/kuota/issues/8) | Troubleshooting should not require sharing auth files or opaque raw logs. |
| P3 | [#9 — Reset-aware headroom overview](https://github.com/DarkoKuzmanovic/kuota/issues/9) | Turn existing windows into useful decision support without a daemon or history database. |

### Confirmed reliability defects

**Artifact checks are not independently isolated.**
[`check-artifact.js:28–42`](https://github.com/DarkoKuzmanovic/kuota/blob/26e1b38b78e53c8c5f2fc2d01acaa81684f61df5/scripts/check-artifact.js#L28-L42)
spawns the packaged CLI with inherited environment and no provider selection.
This is a source-traced side-effect path, not a live-account experiment. Make
the checker own its temporary HOME/environment rather than trusting every
caller to remember a wrapper. The updated README supplies a safe wrapper in
the meantime.

**Cursor can read the previous credential.** A real synthetic WAL database,
with its writer connection left open, returned `synthetic-new` for `mode=ro`
and `synthetic-old` for `mode=ro&immutable=1`. Kuota currently uses the latter
in [`cursor/auth.ts:82`](https://github.com/DarkoKuzmanovic/kuota/blob/26e1b38b78e53c8c5f2fc2d01acaa81684f61df5/collector/src/providers/cursor/auth.ts#L82).
Use WAL-aware read-only access and test sidecar/read-lock requirements. The
frequency of this problem in a real Cursor session was not measured.

**Cursor cancellation stops the wait, not the resource.** The production auth
reader's spawn path has no timeout, signal, output cap, or termination logic.
A probe using that compiled reader with a controlled hanging child still had
a pending adapter and running child after abort; explicit cleanup terminated
it. Do not rely on unspecified Plasma disconnect behavior to clean up Node's
children. Tests must exercise actual child exit, not just promise settlement.

**The updater can lie about source freshness.** A synthetic copy of the real
script, with npm/kpackagetool replaced by no-op recording stubs, skipped the
build when an old same-version archive existed. Reformatting package.json to
compact JSON made it pass `dist/artifact/kuota-v.plasmoid` to the package tool.
Prefer unconditional fresh builds for source updates over an elaborate cache
invalidation layer. Fix archive failure reporting in the same lifecycle slice.

## Deslopifying and simplification

### 1. Consolidate facts before introducing abstractions

Provider IDs/order and configuration defaults are copied across TS, QML/JS,
KConfig XML, metadata, and prose. Drift includes the five-provider standalone
full-view default and metadata description despite seven supported providers.
The README credential table and an incorrect `details.opencode` contract
sentence are repaired by this documentation change.

Start with consistency tests and small static descriptors. Derive same-runtime
tables where practical. A tiny build-time generated data file is an option,
not a reason to add a runtime plugin registry or a generic dynamic settings
framework. Keep independent validation at the collector/QML boundaries.

### 2. Share the JSON graph guard at its owning layer

[`atomic-write.ts:507–628`](https://github.com/DarkoKuzmanovic/kuota/blob/26e1b38b78e53c8c5f2fc2d01acaa81684f61df5/collector/src/io/atomic-write.ts#L507-L628)
and [`json-file.ts:68–199`](https://github.com/DarkoKuzmanovic/kuota/blob/26e1b38b78e53c8c5f2fc2d01acaa81684f61df5/collector/src/io/json-file.ts#L68-L199)
implement the same descriptor-safe traversal. A 12-case differential probe
agreed for current read/write outcomes and invoked no getters. Extract one
pure module, then prove parity with a stronger adversarial corpus. This is
security-sensitive extraction, not permission to replace it with
`JSON.stringify`, which can execute accessors.

### 3. Share small HTTP mechanisms, not provider policy

The simple Grok/Kimi/Cursor/OpenCode/CommandCode fetchers repeat bounded-body
JSON reads, cancellation helpers, and option checks. Safe timestamp/status
builders are also copied. A focused follow-up can share the byte-limited body
reader and cancellation mechanism after characterizing each caller's behavior.

Do **not** build an all-provider adapter factory. Auth precedence, native wire
shapes, Claude backoff/cache policy, and Codex refresh/persistence are different.
Keep fetch-to-parser integration fixtures for every adapter: isolated unit
suites previously passed against incompatible fixture shapes.

This is a maintenance recommendation, not a measured speedup, and was kept out
of the first issue set to avoid a broad refactor before reliability fixes.

### 4. Remove proven scaffolding and narrative noise

Small follow-ups, not standalone priority issues:

- `registry.ts` contains the unreferenced private `placeholderFor` function.
  Remove it after a reference check; treat exported `PLACEHOLDER_*` names
  separately because tests/library callers may use them.
- `ConfigModel.resolveWindow` has test callers but no production caller; the
  actual compact selection path is `resolveDisplayWindow`. Move regression
  assertions to that live path before deleting the duplicate helper.
- `full-model.js` has a redundant branch in `formatNumber` that returns
  `String(value)` either way.
- Normalize appearance once outside the compact provider loop rather than
  rebuilding the same wrapper/closures for each entry.
- Replace long comments replaying old debugging sessions with short invariant
  comments and links to the relevant spec/test. Do not erase the reason for
  fixed FormLayout delegates, atomic writes, or bridge quoting.
- Keep current docs concise and point to the historical gate log instead of
  copying milestone status into multiple documents. Do not rewrite historical
  approvals or move normative planning state without agreement.

### What stays

Keep atomic-write identity/ownership/fsync protections, redaction, whole-document
validation, `flock -F`, the isolated executable bridge, and pure QML model
modules. Preserve documented schema-v1 migration/Umans compatibility until a
separate compatibility decision retires it. A path unused by today's internal
caller is not proof that a documented accepted input can be removed safely.

Likewise, do not add a Percent/Count selector to every provider just because a
model branch exists: several providers do not expose meaningful counts. The
existing `metric` path is not a license to invent data or add dead controls.

## Optimization priorities

1. **Do less provider work** ([#7](https://github.com/DarkoKuzmanovic/kuota/issues/7)).
   `main.qml` currently calls `_bridge.refresh()` with no subset. Decide whether
   hidden should also mean uncollected; the command/CLI/registry already support
   subsets. Test in-flight selection changes, empty selection, and multiple
   widget instances. Request reduction is verifiable; no CPU percentage is
   claimed.
2. **Bound subprocesses** before micro-optimizing arrays or object allocation.
   A hung local helper costs more than iterating seven provider records.
3. **Measure hidden-view clocks before changing them.** FullRepresentation has
   a one-second timer gated only by `autoAdvanceClock`. If the popup remains
   instantiated while closed, it may keep ticking. That lifetime and battery
   impact were not measured here. Verify actual popup visibility, then pause
   unnecessary countdown updates and refresh the clock on reopen.
4. **Keep local verification cheap.** The existing suites run quickly and need
   no hosted CI bill. A hermetic one-command local check and reproducible release
   artifact are more useful now than a larger CI matrix.

## Useful and novel features

### Build next: offline doctor and safe status explanations

[#8](https://github.com/DarkoKuzmanovic/kuota/issues/8) should begin with an
offline report of runtime/tool availability, version agreement, safe source
classifications, and actionable failure reasons. A later UI can expose
last-success freshness and the next policy-allowed retry. Keep a closed output
schema; never use “diagnostics” as a reason to dump auth objects or environment
values. This addresses real setup/support friction.

### Novel direction: a reset-aware headroom view

[#9](https://github.com/DarkoKuzmanovic/kuota/issues/9) compares the reported
windows users currently inspect tab by tab. Show each provider's tightest
comparable percentage window, its label, remaining share, reset time, and
freshness. A hover view can be the smallest useful first surface.

Never sum unrelated credits/tokens/requests into a global budget, call stale
usage “available,” or claim a provider is the best model for a task. No new
network request, permanent service, forecast, or history database is required.

### Keep as later candidates

- **Opt-in threshold/reset notifications:** useful when the panel is not in
  view. Deduplicate per provider/window/reset cycle, honor quiet hours, and
  suppress misleading stale-data alerts. Notifications explicitly extend V1
  scope and require owner approval before implementation.
- **Supported native-client credential discovery:** reduce the Pi-shaped setup
  dependency after a source/format recon. Prefer bounded read-only discovery;
  do not turn this into account management or new token writers by default.
- **Per-window thresholds:** potentially more meaningful than a global 75/90
  for short versus weekly quotas, but avoid fourteen new provider controls
  until a concrete use case justifies that settings burden.

## Suggested implementation order

Fix **#1–#4** first. Extract the narrowly scoped shared guard **#6**, then make
catalog drift fail tests **#5**. Approve collection semantics **#7**, build the
offline diagnostic slice **#8**, and design the headroom view **#9**.

Only after the reliability gates and a separately approved real desktop smoke
should a versioned GitHub artifact be released. This review creates proposals,
not product approval. No production code, existing local feature commit,
release tag, or desktop installation is changed by the documentation PR.
