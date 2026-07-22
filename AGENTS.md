# Agent Instructions — Kuota

Kuota is a standalone KDE Plasma 6 widget that keeps Claude, Umans, Codex,
Grok, and Kimi
account usage visible on the desktop without requiring a running Pi session. It
reports authoritative provider data — it does **not** estimate quota from local
activity.

## Orient first

Two documents are normative and override any instinct that conflicts with them:

- **`docs/specs/2026-07-10-kuota-design.md`** — the approved design specification.
  Product decisions, UX, architecture, provider behavior, and failure modes.
- **`PLAN.md`** — the milestone/gate plan. Source of truth for scope, task order,
  conventions, counters, and the Gate Log. Work milestone-by-milestone; each
  gate must pass before the next begins.

When the design and the plan disagree, the design wins on behavior; the plan
wins on sequencing. Record any scope change as an explicit approval before
altering code (see *Workflow*).

## Architecture — respect the layer boundary

The package has three isolated layers. The boundary between them is the most
important invariant in this project:

1. **Plasma UI** (`plasmoid/`) — QML compact view, full view, controls, config.
   Knows nothing about providers, credentials, or HTTP.
2. **Collector bridge** — one isolated QML component that launches the collector
   and parses its JSON. The only thing allowed to touch the executable API
   (`org.kde.plasma.plasma5support`), and that dependency must stay replaceable.
3. **Collector** (`collector/`) — a short-lived Node process that owns credential
   access, provider I/O, normalization, caching, backoff, and token refresh.

**Only normalized, secret-free JSON crosses the bridge.** Credentials, tokens,
account IDs, raw responses, and auth-file contents never enter QML, widget
settings, command arguments, stdout, stderr, logs, or caches.

## Security — non-negotiable rules

These are hard rules. Violating any of them is a stop condition, not a fix.

- `~/.pi/agent/auth.json` is sensitive shared state. Reads are local and never
  copied into the project. Only Codex token refresh writes back, and it must be
  a latest-read, atomic, permission-preserving merge that keeps unrelated
  entries and the existing file mode.
- Collector stdout is **exactly one JSON document per invocation** — nothing else.
  Stderr carries only redacted diagnostics. Diagnostics never include the
  rejected raw value, authorization headers, tokens, refresh tokens, account
  IDs, or curl configuration.
- Cache files contain usage results only — never credentials. Cache and temp
  writes use restrictive permissions.
- Atomic writes use same-directory exclusive temp files, `fsync` durability, and
  clean up temp files on failure. Never truncate the destination on a failed
  serialize or rename. Latest-read replacements carry the identity token
  (`dev`/`ino`/`size`/mtime) and abort on detected change.
- Trusted-parent precondition: the immediate parent of any atomic destination
  must be a real, non-symlink, current-user-owned directory without group/other
  write. Treat post-commit durability failure as indeterminate — re-read, don't
  blindly retry.
- Test fixtures are synthetic and recognizable as non-secrets. All diagnostics and
  safe status text must pass through the central redaction helper
  (`collector/src/security/redact.ts`), which scrubs secret keys, account
  identifiers, raw response bodies, and credential-shaped string values,
  including nested Error metadata and circular references. Secret/redaction
  assertions are automated.

## Collector contract

Schema v1 is small and versioned. The UI renders common provider state without
knowing provider-native formats. Full shape: `docs/architecture/collector-contract.md`.

- Provider IDs: `claude`, `umans`, `codex`, `grok`, `kimi`.
- States: `ok`, `stale`, `auth-needed`, `error`. `stale` is last-known-good with
  retained real data (≥1 window or a non-empty details object) — not an empty
  failure marker.
- Optional values are **omitted** when unavailable. Never emit `null`,
  placeholders, zeroes, or inferred equivalents. Unlimited plans leave out
  `limit` and `usedPercent` rather than inventing them.
- `validateCollectorDocument` validates the whole document before narrowing.
  QML validates the complete response before replacing its snapshot; malformed
  output is rejected without mixing old and new state.
- One provider failure never prevents successful providers from updating.

## Conventions

- Strict TypeScript at external boundaries. No `any`, no unchecked casts, no `!`
  non-null assertions. Use `unknown` + narrowing.
- Use Node built-ins where practical; justify and pin any runtime dependency
  before adding it. `devDependencies` only (`@types/node`, `typescript`) — no
  runtime deps in V1.
- Timestamps are UTC ISO 8601 strings in the collector contract. Countdowns are
  computed in QML from reset timestamps.
- Provider-specific payloads are namespaced under their provider record
  (`details.claude` / `details.umans` / `details.codex` / `details.grok` /
  `details.kimi`). The TS `ProviderRecord`
  is a discriminated union enforcing that correlation; runtime validation
  enforces the same.
- Test-first slices for every provider adapter and all security-sensitive auth
  persistence. Test malformed, missing, optional, stale, auth-needed, error,
  partial-success, narrow-layout, and light/dark paths — not only happy paths.
- Do not hand-edit generated artifacts or lockfiles. Modify sources and
  regenerate with the documented command.
- Collector tests run under Node's built-in test runner.

## Build & test commands

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over the project. |
| `npm test` | Clean test output, compile tests, run Node test runner. |
| `npm run build:collector` | Clean collector output, emit runnable JS to `dist/`. |
| `npm run validate:plasma` | `kpackagetool6 --appstream-metainfo` + `qmllint`. |
| `npm run build:artifact` | Build collector, then package `dist/artifact/kuota-v0.1.0.plasmoid`. |

Test and collector builds clean only their own ignored output directory before
emit, so stale compiled files can't survive source deletion and create
false-green evidence.

## Layout

```
plasmoid/              Plasma 6 widget sources (metadata.json, contents/ui/)
collector/src/         Collector TypeScript (cli, collect/, contract/, io/, providers/, security/)
collector/test/        Collector unit tests
tests/                 Top-level tests, fixtures, secret-safety policy
scripts/               clean-output, build-artifact, check-artifact
docs/specs/            Approved design specification
docs/architecture/     Collector contract and (pending) overview
dist/                  Generated output (gitignored)
PLAN.md                Milestone/gate plan — normative for scope and sequencing
```

## Providers (V1 scope)

| Provider | Source | Auth in `~/.pi/agent/auth.json` |
|---|---|---|
| Claude | `api.anthropic.com/api/oauth/usage` | `auth.anthropic` (oauth) |
| Codex | `chatgpt.com/backend-api/codex/usage` | `auth["openai-codex"]` (oauth, +accountId, refresh, expires) |
| Umans | `api.code.umans.ai/v1/usage` | `auth.umans` (oauth or api_key); `UMANS_API_KEY` fallback |
| Grok | `cli-chat-proxy.grok.com/v1/billing` | `auth.xai` / `auth["xai-auth"]` / `auth["grok-cli"]` (oauth); `GROK_CLI_OAUTH_TOKEN` fallback |
| Kimi | `api.kimi.com/coding/v1/usages` | `auth["kimi-coding"]` (oauth or api_key); `KIMI_API_KEY` fallback |

Claude is aggressively rate-limited: prefer a fresh shared pi-hud cache, keep a
last-known-good cache, honor `Retry-After` and a minimum 429 backoff, retain
stale on failure. Codex uses normal HTTP first, falls back to stdin-configured
curl on Cloudflare/TLS rejection, refreshes an expired OAuth token once, and
persists refreshed auth atomically. Umans shows rolling-window requests and
optional limits; unlimited plans show counts/timing without invented percentages.

Additional providers, cross-machine aggregation, history charts, notifications,
account login/management, a permanent service, and KDE Store publication are
**out of scope for V1**.

## Workflow

- One durable plan file (`PLAN.md`). Increment milestone counters when reviews,
  correction rounds, oracle consultations, or direct implementation edits occur.
- No implementation begins until the written spec is reviewed and approved
  (Gate G0 — passed 2026-07-10).
- At each exit gate: run the listed checks, record commands/results in the Gate
  Log, obtain the required independent review, update only that milestone's
  counters.
- **Stop conditions:** credential exposure, auth-file truncation or mode
  change, overlapping refresh, malformed snapshot acceptance, unbounded provider
  call, or any pressure to publish without separate approval. When you hit one,
  stop and surface it — don't patch around it.

## Git in this checkout

Assume other sessions may be working here right now.

- Commit only files you changed this session. Stage explicit paths — never
  `git add -A` / `git add .`.
- `git status` before every commit. Never `git reset --hard`,
  `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`. A guard
  blocks these; documented recovery is run by the user.
- Conflict in a file you didn't modify → abort and ask.
- Push, PR, publish: explicit approval in this session.

## Think, then act

1. State premises. Separate facts from inferences.
2. Trace, don't summarize — follow actual paths, calls to definitions.
3. Conclude from evidence. Can't cite it? Flag the gap.

Fix bugs at the layer that owns the invariant. If a caller can bypass your fix
and the bug returns, you patched the wrong layer. Ask when ambiguous; a
10-second question beats 10 minutes down the wrong path. But verify environment
questions (`which`, `--version`, `--help`) instead of asking.

### Lessons

- 2026-07-14: Child-process tests that exercise the whole-collector lock need a unique synthetic `HOME` with a trusted 0700 `.cache`; otherwise shared lock contention or a missing parent can bypass the provider path and falsely test only the lock-fallback response.
- 2026-07-14: Invoke util-linux `flock` with `-F`/`--no-fork` when Kuota must track and terminate the actual lock holder. Without it, killing the tracked wrapper can leave a grandchild and kernel lock alive.
- 2026-07-14: Plasma's `org.kde.plasma.plasma5support` executable engine accepts a shell command string rather than argv or stdin. Keep command construction isolated, allowlist every dynamic token, and test POSIX quoting; use Qt 6 `/usr/lib/qt6/bin/qmltestrunner`, not the Qt 5 `/usr/bin/qmltestrunner`.
- 2026-07-14 (M7 compact panel): Presentation logic lives in the Plasma-independent `compact-model.js` (`.pragma library`, no Plasma/IO) so it is unit-testable via the Qt 6 runner; `CompactRepresentation.qml` is thin view. Metric rule: primary window `usedPercent`, else `used` count (a capped window with `used`+`limit` but no `usedPercent` shows a computed percent). Thresholds run on RAW utilization (caution ≥75, critical ≥90); percent display is floored so a floored `"74%"` still maps to `none`. Keep threshold math independent of the display string.
- 2026-07-14 (M7 sizing gotcha): a compact `compactRepresentation` must set `implicitWidth`/`implicitHeight` from its content (`contentRow.childrenRect` + margins); without it the panel can collapse the item below the narrow-width threshold and it always degrades to icons, so `icons+text` never renders. Do not anchor the content row with `fill` — that collapses implicit size.
- 2026-07-14 (M7 isolation discipline): when adding a production QML file, add it to `tests/qml/tst_module_isolation.qml` `productionQmlFiles` so a stray `org.kde.plasma.plasma5support` import fails the test. Only `CollectorBridge.qml` may import it.
- 2026-07-14 (M8 full representation): The shared popup/desktop view is `FullRepresentation.qml` (thin view) over `full-model.js` (`buildFullViewModel(record)`, Plasma-independent, unit-tested). Same M7 split. Key invariants: the live reset countdown is computed IN QML from `resetAt` + an injectable `nowMs` (a `Timer` gated by `autoAdvanceClock` advances it in production; tests set `nowMs` directly and set `autoAdvanceClock:false` for determinism) — `full-model.js` only passes `resetAt` through, never a countdown string. Provider selection is a single source of truth off the `TabBar` `currentIndex` (derive `effectiveProviderId`, do not mirror selection into separate state). Facts are built from a CLOSED per-provider allowlist reading only the namespaced `details.{claude|umans|codex}` — never a dynamic key walk and never `status` — so no provider secret can leak into a rendered/Accessible surface. Register every new production QML in `tst_module_isolation.qml` and every new `.pragma library` module's `validate:plasma` qmllint list (`package.json`).
- 2026-07-14 (M8 credit units — resolved): Claude `extraUsageUsedCredits`/`extraUsageMonthlyLimit` are integer counts in MINOR units; `full-model.js` `formatCreditAmount` scales by `10^extraUsageDecimalPlaces` for display (e.g. `1250` + dp `2` → `$12.50`). When `extraUsageDecimalPlaces` is absent the unit scale is unknown, so the raw integer is shown as-is. Do NOT revert to a bare `toFixed(decimals)` — that renders money `10^decimals` too large; `tst_full_model.qml::test_claudeCreditsMinorUnitScaling` guards this.
- 2026-07-16 (M9 configuration layer): Settings are a flat KConfigXT schema in `plasmoid/contents/config/main.xml`; `config-model.js` (`.pragma library`, Plasma-independent, unit-tested) is the D6 read boundary. `main.qml` does `ConfigModel.sanitize(rawConfig)` ONCE (refresh floor ≥5min, thresholds clamped 0..100 with caution<critical, garbage→default) before any value reaches the compact/full models or the timer; config-page spinbox min/max are UX-only, NOT the guard. `main.qml` exposes a `configOverride` test seam because `plasmoid` is null in the offscreen Qt Test harness. Presentation-config keys must have a REAL consumer: `separator`/`fontScale`→compact, `showCountdown`→full countdown gate — a control bound to a key nothing renders is a dead control and fails the gate. `showLabels` was dropped as redundant with `displayMode`.
- 2026-07-16 (M9 config-page i18n convention): config pages use **`qsTr()`**, matching every existing plasmoid UI file (no `i18n(` anywhere in V1). Do not introduce `i18n()`/`i18nc()` piecemeal; choosing a KI18n catalog is a deliberate M10 l10n-system decision, not a per-string call. `config/config.qml` category titles using `i18n` is normal for `org.kde.plasma.configuration` and fine alongside page-level `qsTr`.
- 2026-07-16 (M9 Qt Quick Test gotcha): a `TestCase` root defaults `visible:false`, and `QQuickItem.isVisible()` returns EFFECTIVE (ancestor-combined) visibility — so every instantiated descendant reads `.visible === false` regardless of its own binding. Any test that asserts on a rendered item's `.visible` must set `visible:true` on the `TestCase` root, or it will fail against correct production code (this masked a false RED on the compact separator).
- 2026-07-16 (M9 hotfix — compact panel binding loop, supersedes the M7 sizing-gotcha entry above): the width-based narrow-width auto-degrade (`width > 0 && width < narrowWidthThreshold → "icons"`) created a self-referential QML binding loop — `implicitWidth` ← `contentRow.childrenRect` ← text visibility ← `showText` ← `effectiveDisplayMode` ← `width` ← `implicitWidth` — which Qt breaks unpredictably and freezes in icons-only on a real panel (never reproduced by M7/M8 desktop-widget testing). Fixed by removing the width read entirely: `effectiveDisplayMode` now returns `compactDisplayMode` directly, since M9's explicit `displayMode` config is the intended source of truth and makes the heuristic redundant. `narrowWidthThreshold` was removed. If a chosen `icons+text` mode overflows a very narrow panel, the user now sets `displayMode: "icons"` explicitly rather than relying on auto-degrade.
- 2026-07-16 (M9 hotfix — compact panel width/overlap, supersedes the `childrenRect` guidance in the M7 sizing-gotcha entry above): a compact `compactRepresentation` on a horizontal panel must (1) size from the content positioner's own `contentRow.implicitWidth`/`implicitHeight` + margins, NOT `contentRow.childrenRect` (childrenRect under-reports a `Row`'s width to the panel layout, so content paints past the item and overlaps the neighbor widget once text renders), and (2) expose `Layout.minimumWidth`/`Layout.preferredWidth` (needs `import QtQuick.Layouts`). Bare `implicitWidth` is NOT honored for panel width allocation — per KDE docs `Layout.preferredWidth` is the mechanism a horizontal panel uses for compact-rep width, and it also drives dynamic reflow as values change. Verified live on a real panel 2026-07-16.
- 2026-07-18 (M10 build hygiene): the `dist/` directory is shared by the TS collector build (`npm run build:collector` / `build:artifact`), the Node test runner (`npm test` compiles tests into `dist/tests/`), AND the QML test runner (`npm run test:qml` loads `config-model.js` from source but its `tsc` step also writes `dist/`). Two failure modes bite when suites run back-to-back without cleaning: (1) parallel in-tree workers that both invoke `npm test`/`build` race on the same `dist/` and produce transient, non-reproducible failures; (2) `npm run test:qml` does NOT clean `dist/`, so running it before `npm test` leaves a stale `dist/tests/collector/test/cli.test.js` that causes a spurious Node CLI test failure (`'Kuota collector failed\n\n'` vs `'Kuota collector failed\n'` — an extra blank line from the stale compile) that vanishes on a clean `rm -rf dist && npm test`. Both are false REDs against correct code. Hygiene: clean `dist/` between suites, and prefer sequential `rm -rf dist && <suite>` runs over batched/parallel verification in a shared checkout. The npm scripts already clean their own ignored output before emit, but they do not clean each other's.