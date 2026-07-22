# Changelog

All notable changes to Kuota are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Config keys are a stable, additive-only contract (D7): later versions add keys
but never rename or remove them within the compatibility window, so settings
survive updates.

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

## [1.2.1] - 2026-07-22

### Fixed

- **Compact representation: full-view tab labels for Grok and Kimi were
  lowercase.** The full-view tab bar read `providerDisplayName()` to set
  each tab's text, but the switch only had cases for Claude, Umans, and
  Codex — Grok and Kimi fell through to the raw `providerId` and rendered
  as `grok` / `kimi` next to their capitalized peers. Added the missing
  cases so all five V1 providers display capitalized tab labels.
  `compact-model.js` already had the correct labels for the compact
  view, so this regression was full-view-only.
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
