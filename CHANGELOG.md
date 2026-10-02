# Changelog

All notable changes to Kuota are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Config keys are a stable, additive-only contract (D7): later versions add keys
but never rename or remove them within the compatibility window, so settings
survive updates. Umans-only config keys (`umansVisible`, `umansAccentColor`,
`umansCustomIcon`) are an approved exception — removed from the schema and
left unread on disk (see **Removed** under [1.3.0]).

## [Unreleased]

## [2.0.0] - 2026-10-02

Kuota no longer depends on Pi. **Breaking:** credentials in Pi's
`~/.pi/agent/auth.json` are no longer read; run `kuota login <provider>` once
(see README → Providers and credentials).

### Added

- **Own credential store and login commands.** `login`, `logout`, and `status`
  subcommands of the bundled collector keep Kuota's logins in
  `$XDG_CONFIG_HOME/kuota/credentials.json` (0700 directory, 0600 file).
  Codex, Grok, and Kimi sign in with a device code; OpenCode, CommandCode, and
  Kimi accept an API key typed hidden or piped on stdin, never as an argument.
- **Codex CLI fallback.** With no Kuota Codex login, Kuota reads the Codex CLI's
  `~/.codex/auth.json` read-only and never refreshes it.
- **Grok and Kimi token renewal** for Kuota's own logins.
- The widget's "Login needed" message now names the fix for each provider.

### Changed

- **Claude** reads only Claude Code's login (read-only); the Pi fallback is gone.
- Kuota refreshes and writes only its own logins, never Pi's or any other tool's.

### Fixed

- **Codex showed "Authentication required"** after Pi 0.99.0 replaced its
  `openai-codex` login, whose token Kuota needed.

### Fixed (since 1.3.0, previously unreleased)

- **Claude stuck on stale data.** Anthropic's usage response now includes a
  `seven_day_breakdown` report that Kuota misread as a malformed model window,
  rejecting every live response. Non-window `seven_day_*` entries are now
  skipped; malformed real windows still reject.

### Changed (since 1.3.0, previously unreleased)

- **Claude credentials.** Kuota reads Claude Code's
  `~/.claude/.credentials.json` (the interim Pi fallback was removed in 2.0.0).

## [1.3.0] - 2026-09-01

### Added

- **OpenCode provider.** Shows usage from hosted OpenCode Go’s
  `opencode.ai/zen/go/v1/usage` endpoint — three windows (5h rolling, weekly,
  monthly) with reset countdowns. Auth: `auth["opencode-go"]` first, the
  `opencode` alias second, then `OPENCODE_API_KEY`. No refresh/refresh-token
  handling — read-only by design.
- **CommandCode provider.** Shows credits and exceeded flags from
  `api.commandcode.ai/alpha/billing/credits`, plus plan name from the optional
  subscriptions call (non-fatal when it fails). Five-hour window is primary;
  weekly window added when present. Auth: `auth.commandcode` (oauth-shaped
  entry, `access` is the session key) or `COMMANDCODE_API_KEY`. Read-only.
- **Cursor provider (unofficial).** Shows included plan usage from Cursor’s
  dashboard `usage-summary` endpoint. Auth: local Cursor `state.vscdb` session
  first, else `CURSOR_SESSION_TOKEN`. Not an official individual API — may break
  without notice (see design + recon docs).
- **Per-provider window selectors for all providers.** Settings → Providers →
  "Usage window" now offers a selector for Grok (7d/30d), Kimi (Week/5h/Daily/
  Month), OpenCode (5h/Weekly/Monthly), and CommandCode (5h/Weekly), matching
  the existing Claude and Codex controls. Each defaults to "Default" (the
  primary window), and a selection absent from the live account falls back to
  it. Cursor shows a single window, so it has no selector. Additive config keys
  `grokWindow`, `kimiWindow`, `opencodeWindow`, `commandcodeWindow`
  (spec: `docs/specs/2026-09-05-window-selector-all-providers-design.md`).

### Fixed

- **Offline artifact verification (#1).** Packaged CLI checks use private
  HOME/cache directories, an allowlisted environment, and bounded subprocesses.
- **Cursor local authentication (#2–#3).** Read-only SQLite discovery sees live
  committed WAL updates, passes collection cancellation to the child owner,
  and terminates/reaps children on abort, a two-second deadline, or per-stream
  output above 64 KiB. Ordinary local failures retain environment fallback;
  cancellation/resource limits do not restart discovery or fetch.
- **Fresh source installation/update (#4).** Always rebuild; derive paths from
  JSON regardless of formatting. Compiler, checker, zip, missing/empty archive
  failures stop before installation and remove stale archive output.
- **Cursor plan percent.** Primary `Plan` window now uses `totalPercentUsed`
  (dashboard spend share) instead of request-count `used`/`limit`, which
  disagreed with the Spending page (e.g. ~55% vs ~4%).

### Removed

- **Umans provider.** Kuota no longer collects or displays Umans usage.
  Collector documents now use `schemaVersion: 2` with providers
  `claude`, `codex`, `grok`, `kimi`, `cursor`, `opencode`, and `commandcode`.
  Schema v1 snapshots and configs
  that still mention Umans are silently stripped on read. Orphan
  `umansVisible` / accent / icon KConfig keys may remain on disk unread.
  This amends D7 for the Umans-only keys as an explicit scope change
  (see `docs/specs/2026-08-02-remove-umans-provider-design.md`).

## [1.2.1] - 2026-07-22

### Fixed

- **Full view: Grok and Kimi tab labels were lowercase.** The full-view
  tab bar read `providerDisplayName()` to set each tab's text, but the
  switch only had cases for Claude, Umans, and Codex — Grok and Kimi
  fell through to the raw `providerId` and rendered as `grok` / `kimi`
  next to their capitalized peers. Added the missing cases so all five
  V1 providers display capitalized tab labels. `compact-model.js` already
  had the correct labels for the compact view, so this regression was
  full-view-only.
- **Compact representation: icons-only mode rendered the icon butted
  against the percentage.** The `iconLabelSpacer` visibility was bound
  to `showIcons && showLabel`, which collapsed the spacer whenever the
  label was hidden — but in icons-only mode the value (percentage) is
  still rendered after the icon and needs to be spaced from it. The
  visibility rule now also covers the icon → value transition
  (`showIcons && (showLabel || (showValue && displayValue.length > 0))`),
  so the user-controlled `Icon → label spacing` value applies in every
  mode where an icon is followed by something visible.
- **Compact representation: custom PNG/SVG icons dwarfed the surrounding
  text.** Provider and state icons now size from the computed
  `iconSize` (`max(Kirigami.Units.iconSizes.small, round(fontPointSize * 1.3))`)
  instead of the hardcoded `smallMedium` / `small`, and scale with
  `fontScale`.
- **Compact representation: per-gap spacing did not honor the configured
  value.** The `iconLabelSpacing` / `labelValueSpacing` tunables were
  direct children of the entryRow (Row spacing `smallSpacing/2`), so the
  rendered icon→label and label→value gaps were
  `smallSpacing/2 + spacerWidth + smallSpacing/2`. A configured `0`
  floored at `smallSpacing` instead of collapsing; a configured `7`
  rendered as roughly 11px. Wrapped the icon, both spacers, label, and
  value in a nested `Row { spacing: 0 }` so the configured spacers are
  the only gaps in that group. **User-visible on upgrade: the panel's
  default gaps tighten from the prior ~6/5px to the documented 2/1px
  defaults; configured `0` now collapses as expected.** The outer
  `entryRow.spacing` is retained for the separator / valueDot / state
  siblings that still need the V1 `small/2` look.
- **Compact representation: no way to tune icon→label and label→value
  spacing.** Two new sanitized config keys (`iconLabelSpacing`,
  `labelValueSpacing`, defaults 2px / 1px, clamp 0..64) implemented as
  explicit Item spacers with `objectName` so the QML test harness can
  find them. Visible-tracking keeps a hidden icon or label from leaving
  a phantom gap. SpinBox controls (`0..32`) added to the Appearance
  config page next to the font scale.
- **Compact representation: local-image-path custom icons failed to load
  when set via the icon picker.** Absolute image paths must use
  `icon.source` (not `icon.name` — the latter only loads freedesktop
  names); the `Change…` preview button in the Theming config page now
  mirrors the split (`providerIconName()` for theme names,
  `providerIconSource()` for absolute paths). Sanitizer accepts absolute
  `.png` / `.svg` / `.svgz` / `.jpg` / `.jpeg` / `.webp` / `.xpm` /
  `.ico` / `.gif` paths and rejects traversal / relative / non-image
  extensions.
- **Custom icon path sanitization accepted percent-encoded URL-significant
  characters.** `pathHasDotDot()` matched only literal `..` segments, so
  `/tmp/icons/%2e%2e/private/logo.png` (which Qt percent-decodes to
  `/private/logo.png` at `file://` load time) slipped past the traversal
  check. Similarly `%`, `#`, `?` break URL parsing even for literal
  filenames. The sanitizer now rejects `/[%#?]/` in the post-`file://`-strip
  path before the regex pattern test. **Not a security boundary** (the cfg
  value is the user's own KConfig and any absolute path is already
  accepted by design); this is hygiene against percent-decoded traversal
  and broken filenames.
- **Theming preview assigned a `file://` URL to `icon.name`.** `IconDialog`
  returns a freedesktop icon name for theme picks and a `file://` URL for
  "Other icons" Browse picks; the page wrote the raw dialog value to
  `cfg_<provider>CustomIcon`, and the preview's `isLocalIconPath()` only
  recognized `/`-prefixed strings — so a raw URL went to `icon.name` and
  left `icon.source` empty until the widget-side sanitizer stripped it
  at render time. The `IconDialog.onIconNameChanged` handler now mirrors
  the sanitizer's `file://` strip at write time, so the preview swatch
  is consistent with what the widget renders. Marked explicitly as a
  UX-only duplicate (per M9 D6 discipline, the canonical `sanitize()`
  is the single read boundary at the widget side and wins on conflict).

## [1.2.0] - 2026-07-22

### Added

- **Theming configuration page** — a new *Theming* tab in the widget settings
  for appearance customisation, on top of the strict additive-only V1 config
  contract (existing configurations are untouched).
- **Font family override** applied to all widget text in both the compact and
  full representations.
- **Custom text colour** — a global text-colour override with a live-validated
  colour swatch (invalid input shows no swatch and is ignored).
- **Per-provider accent colour** — recolours the compact value text and the
  full-view progress bar for each provider.
- **Per-provider custom icon** — pick any system icon via the native KDE icon
  picker, with reset-to-default.
- **Opacity sliders** for metric labels and separators.

### Changed

- Text/colour resolution follows an explicit precedence: threshold state >
  per-provider accent > custom text colour > Plasma theme. Threshold colours
  always win so at-risk usage stays legible under any custom theme.

## [1.1.0] - 2026-07-22

### Added

- **Grok provider** — monthly usage window (`monthlyUsed` / `monthlyLimit` /
  `monthlyResetAt`), shown in the compact and full representations with
  per-provider visibility, ordering, accent colour, and custom-icon support.
- **Kimi provider** — concurrency usage (`concurrency` / `concurrencyLimit`),
  shown in the compact and full representations with the same per-provider
  configuration surface.

### Fixed

- **Critical: widget showed "No provider data yet" for every user.** The QML
  collector-validator (the in-widget mirror of the collector's schema-v1
  contract) still allowlisted only `claude`, `umans`, and `codex`. Because the
  collector always emits all five providers, the validator rejected every real
  payload as `schema-invalid` and the widget never displayed data. The mirror
  now recognises `grok` and `kimi` and validates their namespaced details,
  matching the collector contract exactly. A regression test drives a full
  five-provider document through the QML validator so this cannot silently
  recur.
