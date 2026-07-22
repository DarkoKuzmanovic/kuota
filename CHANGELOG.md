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
