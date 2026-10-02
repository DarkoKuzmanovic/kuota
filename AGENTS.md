# Agent Instructions — Kuota

Kuota is a standalone KDE Plasma 6 widget that keeps Claude, Codex, Grok, Kimi,
Cursor, OpenCode, and CommandCode account usage visible on the desktop without requiring Pi or any other agent harness. It
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

- Kuota never reads or writes `~/.pi/agent/auth.json` (M17). Its own logins
  live in `$XDG_CONFIG_HOME/kuota/credentials.json` (dir 0700, file forced to
  0600 on every write), written only by `kuota login/logout` and by refresh of
  Kuota's own Codex/Grok/Kimi entries — always a latest-read, atomic merge that
  keeps unrelated entries. Other tools' logins (Claude Code, Codex CLI, Cursor)
  are read-only and are never refreshed: refreshing would rotate their tokens.
- API keys are never accepted as argv. `login` reads them hidden from the TTY or
  from piped stdin.
- Collector stdout in collection mode is **exactly one JSON document per
  invocation** — nothing else. (`login|logout|status` are human-facing, never
  launched by the widget, and still never print a secret.)
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

Schema v2 is small and versioned. The UI renders common provider state without
knowing provider-native formats. Full shape: `docs/architecture/collector-contract.md`.

- Provider IDs: `claude`, `codex`, `grok`, `kimi`, `cursor`, `opencode`,
  `commandcode`.
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
  (`details.claude` / `details.codex` / `details.grok` /
  `details.kimi` / `details.cursor` / `details.commandcode`; OpenCode has no
  details namespace). The TS `ProviderRecord`
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
| `npm run build:artifact` | Build collector, then package `dist/artifact/kuota-v<package.json version>.plasmoid`. |

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

## Providers

| Provider | Source | Credential source |
|---|---|---|
| Claude | `api.anthropic.com/api/oauth/usage` | Claude Code `~/.claude/.credentials.json` `claudeAiOauth` only (read-only; never refreshed — refreshing would rotate Claude Code's refresh token). No Kuota Claude login (ToS risk). |
| Codex | `chatgpt.com/backend-api/wham/usage` | store `codex` (oauth, +accountId, refresh, expires; `kuota login codex` device flow), then Codex CLI `~/.codex/auth.json` `tokens.access_token`+`account_id` read-only, no refresh |
| Grok | `cli-chat-proxy.grok.com/v1/billing` | store `grok` (oauth; device flow; refreshed on expiry); `GROK_CLI_OAUTH_TOKEN` fallback |
| Kimi | `api.kimi.com/coding/v1/usages` | store `kimi` (oauth device flow, refreshed on expiry, or api_key); `KIMI_API_KEY` fallback |
| Cursor | `cursor.com/api/usage-summary` (unofficial dashboard) | Local `~/.config/Cursor/User/globalStorage/state.vscdb` (`cursorAuth/accessToken`); `CURSOR_SESSION_TOKEN` fallback. **Not** `auth.json`; session is never persisted by Kuota. Requires system `sqlite3` for local discovery. |
| OpenCode | `opencode.ai/zen/go/v1/usage` (hosted OpenCode Go only, not Zen/other surfaces) | store `opencode` (`api_key` + `key`), `OPENCODE_API_KEY` env fallback |
| CommandCode | `api.commandcode.ai/alpha/billing/credits` + optional `…/subscriptions` (plan name) | store `commandcode` (`api_key` + `key`; the `user_…` key) or `COMMANDCODE_API_KEY` env fallback |

Claude is aggressively rate-limited: keep Kuota's own last-known-good cache
(`~/.cache/kuota/claude.json`; the pi-hud shared cache is never read), honor `Retry-After` and a minimum 429 backoff, retain
stale on failure. Codex uses normal HTTP first, falls back to stdin-configured
curl on Cloudflare/TLS rejection, refreshes an expired OAuth token once, and
persists refreshed auth atomically.

Additional providers, cross-machine aggregation, history charts, notifications,
account login/management, a permanent service, and KDE Store publication are
**out of scope** unless the owner approves a spec and a PLAN.md milestone first.
Deferred candidates (e.g. Meta Muse Code) are listed in PLAN.md *Deferred providers*.

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
- 2026-07-14 (M8 full representation): The shared popup/desktop view is `FullRepresentation.qml` (thin view) over `full-model.js` (`buildFullViewModel(record)`, Plasma-independent, unit-tested). Same M7 split. Key invariants: the live reset countdown is computed IN QML from `resetAt` + an injectable `nowMs` (a `Timer` gated by `autoAdvanceClock` advances it in production; tests set `nowMs` directly and set `autoAdvanceClock:false` for determinism) — `full-model.js` only passes `resetAt` through, never a countdown string. Provider selection is a single source of truth off the `TabBar` `currentIndex` (derive `effectiveProviderId`, do not mirror selection into separate state). Facts are built from a CLOSED per-provider allowlist reading only the namespaced `details.{claude|codex|grok|kimi|cursor}` — never a dynamic key walk and never `status` — so no provider secret can leak into a rendered/Accessible surface. Register every new production QML in `tst_module_isolation.qml` and every new `.pragma library` module's `validate:plasma` qmllint list (`package.json`).
- 2026-07-14 (M8 credit units — resolved): Claude `extraUsageUsedCredits`/`extraUsageMonthlyLimit` are integer counts in MINOR units; `full-model.js` `formatCreditAmount` scales by `10^extraUsageDecimalPlaces` for display (e.g. `1250` + dp `2` → `$12.50`). When `extraUsageDecimalPlaces` is absent the unit scale is unknown, so the raw integer is shown as-is. Do NOT revert to a bare `toFixed(decimals)` — that renders money `10^decimals` too large; `tst_full_model.qml::test_claudeCreditsMinorUnitScaling` guards this.
- 2026-07-16 (M9 configuration layer): Settings are a flat KConfigXT schema in `plasmoid/contents/config/main.xml`; `config-model.js` (`.pragma library`, Plasma-independent, unit-tested) is the D6 read boundary. `main.qml` does `ConfigModel.sanitize(rawConfig)` ONCE (refresh floor ≥5min, thresholds clamped 0..100 with caution<critical, garbage→default) before any value reaches the compact/full models or the timer; config-page spinbox min/max are UX-only, NOT the guard. `main.qml` exposes a `configOverride` test seam because `plasmoid` is null in the offscreen Qt Test harness. Presentation-config keys must have a REAL consumer: `separator`/`fontScale`→compact, `showCountdown`→full countdown gate — a control bound to a key nothing renders is a dead control and fails the gate. `showLabels` was dropped as redundant with `displayMode`.
- 2026-07-16 (M9 config-page i18n convention): config pages use **`qsTr()`**, matching every existing plasmoid UI file (no `i18n(` anywhere in V1). Do not introduce `i18n()`/`i18nc()` piecemeal; choosing a KI18n catalog is a deliberate M10 l10n-system decision, not a per-string call. `config/config.qml` category titles using `i18n` is normal for `org.kde.plasma.configuration` and fine alongside page-level `qsTr`.
- 2026-07-16 (M9 Qt Quick Test gotcha): a `TestCase` root defaults `visible:false`, and `QQuickItem.isVisible()` returns EFFECTIVE (ancestor-combined) visibility — so every instantiated descendant reads `.visible === false` regardless of its own binding. Any test that asserts on a rendered item's `.visible` must set `visible:true` on the `TestCase` root, or it will fail against correct production code (this masked a false RED on the compact separator).
- 2026-07-16 (M9 hotfix — compact panel binding loop, supersedes the M7 sizing-gotcha entry above): the width-based narrow-width auto-degrade (`width > 0 && width < narrowWidthThreshold → "icons"`) created a self-referential QML binding loop — `implicitWidth` ← `contentRow.childrenRect` ← text visibility ← `showText` ← `effectiveDisplayMode` ← `width` ← `implicitWidth` — which Qt breaks unpredictably and freezes in icons-only on a real panel (never reproduced by M7/M8 desktop-widget testing). Fixed by removing the width read entirely: `effectiveDisplayMode` now returns `compactDisplayMode` directly, since M9's explicit `displayMode` config is the intended source of truth and makes the heuristic redundant. `narrowWidthThreshold` was removed. If a chosen `icons+text` mode overflows a very narrow panel, the user now sets `displayMode: "icons"` explicitly rather than relying on auto-degrade.
- 2026-07-16 (M9 hotfix — compact panel width/overlap, supersedes the `childrenRect` guidance in the M7 sizing-gotcha entry above): a compact `compactRepresentation` on a horizontal panel must (1) size from the content positioner's own `contentRow.implicitWidth`/`implicitHeight` + margins, NOT `contentRow.childrenRect` (childrenRect under-reports a `Row`'s width to the panel layout, so content paints past the item and overlaps the neighbor widget once text renders), and (2) expose `Layout.minimumWidth`/`Layout.preferredWidth` (needs `import QtQuick.Layouts`). Bare `implicitWidth` is NOT honored for panel width allocation — per KDE docs `Layout.preferredWidth` is the mechanism a horizontal panel uses for compact-rep width, and it also drives dynamic reflow as values change. Verified live on a real panel 2026-07-16.
- 2026-07-18 (M10 build hygiene): the `dist/` directory is shared by the TS collector build (`npm run build:collector` / `build:artifact`), the Node test runner (`npm test` compiles tests into `dist/tests/`), AND the QML test runner (`npm run test:qml` loads `config-model.js` from source but its `tsc` step also writes `dist/`). Two failure modes bite when suites run back-to-back without cleaning: (1) parallel in-tree workers that both invoke `npm test`/`build` race on the same `dist/` and produce transient, non-reproducible failures; (2) `npm run test:qml` does NOT clean `dist/`, so running it before `npm test` leaves a stale `dist/tests/collector/test/cli.test.js` that causes a spurious Node CLI test failure (`'Kuota collector failed\n\n'` vs `'Kuota collector failed\n'` — an extra blank line from the stale compile) that vanishes on a clean `rm -rf dist && npm test`. Both are false REDs against correct code. Hygiene: clean `dist/` between suites, and prefer sequential `rm -rf dist && <suite>` runs over batched/parallel verification in a shared checkout. The npm scripts already clean their own ignored output before emit, but they do not clean each other's.
- 2026-07-22 (G11 B1 — wire-shape divergence between isolated unit suites): every provider adapter needs one integration test piping a real-shaped fetch fixture through the usage parser. The Grok worker's fetch tests and usage tests each passed against mutually-incompatible fixture shapes (fetch: real `{config:{monthlyLimit:{val},used:{val},billingPeriodEnd}}`; usage: an invented flat `{monthlyLimit,monthlyUsed,monthlyResetAt}`), so 502/502 was green while production Grok would have rendered present-but-empty records. Layer-isolated unit tests cannot catch wire-shape divergence between layers — only a fetch→parser bridge test can. The recon source of truth for a provider's real wire shape is the live-verified pi-hud provider module (`~/.pi/agent/extensions/pi-hud/providers/<id>.ts`); when fetch fixtures and usage fixtures disagree, the pi-hud shape wins. Also: an ok record that recognized nothing must fail (`malformed-response`), never validate as a dataless success.
- 2026-07-22 (M13 compact layout — icons-mode semantic change): the historic "icons" mode hid ALL text (label + value) via a single `showText` flag. Product change: "icons" now means "icon + value, no caption". The monolithic `showText` was split into two independent flags: `showLabel` (text/icons+text) and `showValue` (always true). Tests that asserted `compact.showText === false` for icons mode are now wrong — assert on `showLabel === false` AND `showValue === true` instead. Spacers between icon→label and label→value are explicit `Item { width: ... }` blocks with `objectName:` (not just `id:`) so QML test helpers that walk `Item.children` and match `objectName` can find them — `id:` alone is invisible to that walk. configAppearance SpinBox controls for the two spacing values MUST use plain `cfg_` properties (not `property alias`) with `value:` reading from `cfg_*` and `onValueModified` writing back; the alias + `value:` bind-back pattern is a runtime binding loop that qmllint does NOT catch (only a live plasmoid or the QML test harness will).
- 2026-07-22 (M13 compact layout — icon size binding + custom-icon path): provider and state icons now bind `width`/`height` to `compactRoot.iconSize` (`max(Kirigami.Units.iconSizes.small, round(fontPointSize * 1.3))`) instead of hardcoded `smallMedium`/`small`. This keeps custom PNG/SVG icons from dwarfing surrounding text and scales them with `fontScale`. Adding a new icon to the delegate? Bind its size to `iconSize` for consistency. Also, the `Kirigami.Icon` for custom local image paths (`/home/.../foo.png`) uses `icon.source = "file://" + path` (NOT `icon.name`) — `icon.name` cannot load absolute paths. configTheming.qml's "Change…" preview button mirrors this split via `providerIconName()` + `providerIconSource()`; `isLocalIconPath(value) = value.charAt(0) === "/"` is the shared predicate.
- 2026-07-22 (M13 compact layout — per-gap spacing via explicit Items, not Row.spacing): two independent per-gap values (`iconLabelSpacing`, `labelValueSpacing`) cannot be expressed with a single `Row.spacing` — that property is uniform across all children. Solution used: insert `Item { width: ...; height: 1 }` spacers between the icon/label/value children, with `visible:` bound to the icon AND the next visible heading — `showIcons && (showLabel || (showValue && displayValue.length > 0))` for the iconLabelSpacer, `showLabel && showValue && displayValue.length > 0` for the labelValueSpacer. The iconLabelSpacer visibility rule is critical: in icons-only mode the label is hidden but the value is still rendered after the icon, so the spacer MUST stay visible to use `iconLabelSpacing` as the icon → percentage gap. The earlier draft (`showIcons && showLabel`) collapsed it and left icons-only mode with no gap between icon and value — caught by the user on the live panel. labelValueSpacer stays hidden in icons-only mode (nothing to space from). Defaults (2px, 1px) roughly reproduce the V1 `Kirigami.Units.smallSpacing/2` look; sanitize clamps to 0..64 + garbage fallback, the SpinBox UX clamps to 0..32.
- 2026-09-25 (Claude usage-shape drift): Anthropic added `seven_day_breakdown` (a per-product report object, not a window) to `/api/oauth/usage`. The parser treated every `seven_day_*` key as a model window and rejected the WHOLE payload as `malformed-response`, so Claude silently showed `stale` for days while every fetch returned 200. Dynamic-prefix keys must be shape-gated: skip values with no metric key (`utilization`/`percent`/`resets_at`), stay strict on window-shaped ones. Diagnose stale-with-no-network-error by probing the live body's key/type SHAPE only (never values) through the real parser, then bisect top-level keys.
