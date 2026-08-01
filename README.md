# Kuota

Kuota is a standalone KDE Plasma 6 widget for showing authoritative Claude,
Codex, Grok, and Kimi usage without a running Pi session.

Milestones M1–M9 are complete (gates G0–G9 PASS): the normalized collector
contract and safe filesystem primitives; live Claude, Codex, Grok, and Kimi
adapters
with credential discovery, bounded fetches, backoff, and per-provider
last-known-good caching; an integrated, cross-process-locked collector CLI;
the isolated QML collector bridge with whole-document validation and snapshot
retention; the compact panel representation; the full popup/desktop
representation with a provider switcher, per-window rows, live reset
countdowns, provider-specific facts, and a refresh action; and a native
configuration dialog — Appearance (display mode, entry separator, font
scaling, reset-countdown visibility), Providers (per-provider visibility,
ordering, and per-provider window selection), and Thresholds (caution /
critical percentages and refresh interval) — whose settings persist and update
the views live. Milestone 10 (packaging, local lifecycle, release candidate)
is in progress: install/update/uninstall scripts and this documentation are
landed; the live collector and config-dialog smoke tests passed, and the
release-candidate gate is under final review. KDE Store publication is a
separate explicitly approved step, not part of V1.

## Contents

- [Requirements](#requirements)
- [Repository layout](#repository-layout)
- [Development commands](#development-commands)
- [Installation](#installation)
- [Troubleshooting](#troubleshooting)
- [Current behavior](#current-behavior)
- [Security boundaries](#security-boundaries)
- [Documentation](#documentation)

## Requirements

- Linux with KDE Plasma 6; the package metadata declares Plasma API minimum
  version 6.0 (the development machine is Plasma 6.7.2).
- Node.js >=20 and npm.
- `kpackagetool6` and `qmllint` for Plasma validation. `zip` is optional; when
  available, it also creates the `.plasmoid` archive during artifact build.
- Package ID: `io.github.darkokuzmanovic.kuota`.
- License: MIT.

## Repository layout

- `plasmoid/` — Plasma package metadata and QML presentation sources.
- `collector/src/` — strict TypeScript collector, contract, orchestration,
  provider interfaces/registry, filesystem primitives, and redaction.
- `collector/test/` — collector unit tests.
- `tests/` — fixture policy, normalized schema fixtures, security tests, and Qt 6 QML tests.
- `scripts/` — output cleanup, artifact creation, packaged-CLI checking, QML test
  runner, and `install.sh` / `update.sh` / `uninstall.sh` lifecycle scripts.
- `docs/specs/` — approved product and architecture specification.
- `docs/architecture/` — implementation contracts and architecture overview.
- `dist/` — ignored generated collector, test, unpacked artifact, and
  `*.plasmoid` output.

## Development commands

Run from the repository root:

```bash
npm run typecheck
npm test
npm run build:collector
npm run validate:plasma
npm run build:artifact
```

`npm test` cleans `dist/tests`, compiles the TypeScript tests, and runs Node's
built-in test runner. It includes the normalized schema fixture inventory and
validation plus the synthetic-fixture secret scan and redaction tests.

`npm run build:collector` cleans `dist/collector` and emits runnable Node
JavaScript. `npm run validate:plasma` runs
`kpackagetool6 --appstream-metainfo plasmoid` and
`qmllint` over the widget QML (`main.qml`, `CollectorBridge.qml`, and the
Plasma-independent JS modules); this is a QML load-equivalent check, not a
runtime rendering harness. The Qt 6 QML test suite runs via `npm run test:qml`.

`npm run build:artifact` rebuilds the collector and runs
`scripts/build-artifact.js`. The script always creates the unpacked directory
`dist/artifact/kuota-v0.1.0/`, copies the package and collector, and runs
`scripts/check-artifact.js`. If `zip` is available and succeeds, it also creates
`dist/artifact/kuota-v0.1.0.plasmoid`; archive creation is optional and is not
required for build success. The check executes the packaged CLI, validates its
schema-v2 JSON, and verifies a credential-shaped argument fails with the safe
constant diagnostic.

## Installation

Kuota installs locally via `kpackagetool6`. From the repository root:

```bash
scripts/install.sh
```

This builds the `.plasmoid` artifact (`npm run build:artifact`) if it is
missing, then installs (or upgrades) the widget package. After install, add
"Kuota" to a panel or the desktop via the standard Plasma "Add Widgets"
dialog.

Update to a new version after pulling changes:

```bash
scripts/update.sh
```

`update.sh` replaces only the Plasma package files. It does not stop Pi or
the collector — the new code loads the next time Plasma restarts or you
re-add the widget. The script prints a one-line reminder of this.

Uninstall:

```bash
scripts/uninstall.sh
```

`uninstall.sh` removes the widget package by ID and removes Kuota's own
cache at `~/.cache/kuota/`. It does not touch `~/.pi/agent/auth.json`,
Plasma global config, or any shared state. It is idempotent: a missing
package or cache directory produces a warning, not a failure.

The scripts touch only the Plasma package install path and `~/.cache/kuota/`.
They never read or write credentials, `~/.pi/`, `~/.config/` Plasma state, or
auth files — damage to `auth.json` is impossible by construction because no
script references it.

## Troubleshooting

- **The widget does not appear after install.** Restart Plasma
  (`plasmashell --replace &` or log out/in), or remove and re-add the widget
  via "Add Widgets". `update.sh` loads the new version the same way.
- **A provider shows `auth-needed`.** The collector could not find a usable
  credential in `~/.pi/agent/auth.json` for that provider. Check that the
  matching entry exists (Claude `auth.anthropic`, Codex `auth["openai-codex"]`
  with `accountId`, Grok `auth.xai` / `auth["xai-auth"]` / `auth["grok-cli"]` or the
  `GROK_CLI_OAUTH_TOKEN` environment variable, Kimi `auth["kimi-coding"]` or
  the `KIMI_API_KEY` environment variable). Kuota never writes credentials
  itself except the Codex token refresh.
- **A provider shows `error` or stale data.** This is usually a transient
  network failure or provider rate limit. The widget retains the last
  known-good data (marked stale) and recovers on the next refresh. Claude is
  aggressively rate-limited; a valid `Retry-After` overrides the 5-minute
  timer.
- **Configuration changes do not apply.** Restart Plasma or re-add the widget.
  Settings persist in the Plasma config; the views read them through a single
  sanitized read boundary, so invalid values fall back to safe defaults.
- **The collector shows an unexpected `error` after an API change.** Provider
  APIs drift; adapters in `collector/src/providers/` may need parser updates.
  If a provider regresses, check the adapter and report it.

## Current behavior

The collector CLI runs the live Claude, Codex, Grok, and Kimi adapters through
bounded concurrent orchestration, a whole-collector last-known-good cache, and
strict cross-process locking. A normal invocation emits exactly one
newline-terminated schema-v2 JSON document and no stderr diagnostics.

The widget's compact panel renders one horizontal line of enabled providers
(default order Claude, Codex, Grok, Kimi). Each entry shows its most useful current
metric — a window's used percentage when available, otherwise a used count —
with configurable caution (default ≥75%) and critical (default ≥90%) threshold colors, concise
login-needed / stale / error markers, icon / text / icon+text modes, and
keyboard-accessible click-to-open. Uncapped counts carry no threshold color.
The widget's full representation (shared by the panel popup and the desktop
view) renders the selected provider from a provider switcher: its state and
last-successful-update time, one row per genuine usage window (label, progress
bar where a fraction is derivable, used / limit / remaining values where
present, and threshold coloring), a reset time with a live countdown computed
in QML from the window's reset timestamp, provider-specific facts (model, plan,
token totals, request/concurrency counts, credits/cost/extra-usage — only when
genuinely returned), and a manual refresh action that reflects in-flight state.
Absent fields are omitted rather than shown as zero or placeholder, and no
credentials or raw provider responses ever cross into the view. Thresholds,
refresh interval, per-provider visibility / order / window, and the compact
display options are user-configurable through the widget's configuration
dialog; every setting persists and updates the views live, and invalid values
fall back to safe defaults at a single read boundary before reaching the views.

The normalized contract uses provider states `ok`, `stale`, `auth-needed`, and
`error`. Optional values are omitted, stale records retain real data, and
provider-specific details are namespaced under the matching provider ID. The
full contract and validation rules are in
[`docs/architecture/collector-contract.md`](docs/architecture/collector-contract.md).

## Security boundaries

QML is presentation-only: it contains no provider I/O, credentials, auth
settings, or network behavior. The executable collector bridge is one isolated
QML component (`CollectorBridge.qml`) — the only file permitted to import
`org.kde.plasma.plasma5support`; an automated isolation test enforces that no
other production QML imports it, so the compatibility mechanism stays
replaceable. Only normalized, secret-free JSON crosses into QML, and the
compact model derives display values from that validated snapshot alone.

The collector owns credential access and provider I/O. It reads
`~/.pi/agent/auth.json` for credential discovery (Claude, Codex, Grok, Kimi); only
the Codex token refresh writes back, via a latest-read atomic,
permission-preserving merge that keeps unrelated entries and the existing file
mode. Only normalized, secret-free JSON crosses into QML. Diagnostics and
status values are value-free constants or constructed from fixed safe values,
routed through the central `redact()` helper. Validation, serialization, and
other catastrophic failures before the stdout write produce no stdout. The CLI
performs one pre-serialized write; an arbitrary writer that partially emits
and then throws cannot be rolled back. Direct-process crash hardening emits
only the constant `Kuota collector failed` to stderr and exits nonzero, with no
raw errors, values, or stack traces reported.

Fixtures are synthetic and recognizable as non-secrets. Tests reject seeded
credential-shaped values and ensure scanner findings do not echo rejected
values. Filesystem primitives provide no-follow reads, trusted-parent checks,
same-directory exclusive temporary files, durability synchronization, cleanup
on failure, latest-read identity checks, permission preservation, and
post-rename durability-failure handling: the operation throws or returns
failure after the destination may already be new, so callers must re-read before
deciding or retrying. These primitives back the whole-collector
last-known-good cache (`~/.cache/kuota/collector.json`), the Claude cache
(`~/.cache/kuota/claude.json`), and the Codex auth refresh.

## Documentation

- [`docs/architecture/overview.md`](docs/architecture/overview.md) — layer
  ownership, current data flow, and future boundaries.
- [`docs/architecture/collector-contract.md`](docs/architecture/collector-contract.md)
  — schema-v2 document and validation contract.
- [`docs/specs/2026-07-10-kuota-design.md`](docs/specs/2026-07-10-kuota-design.md)
  — approved product specification.
- [`tests/fixtures/README.md`](tests/fixtures/README.md) — fixture and
  redaction policy.
