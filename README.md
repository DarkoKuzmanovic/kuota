# Kuota

Kuota is a standalone KDE Plasma 6 widget for showing authoritative Claude,
Umans, and Codex usage without a running Pi session.

Implemented through Milestone 8: the normalized collector contract and safe
filesystem primitives; live Claude, Umans, and Codex adapters with credential
discovery, bounded fetches, backoff, and per-provider last-known-good caching;
an integrated, cross-process-locked collector CLI; the isolated QML collector
bridge with whole-document validation and snapshot retention; the compact
panel representation; and the full popup/desktop representation with a provider
switcher, per-window rows, live reset countdowns, provider-specific facts, and a
refresh action. Not yet implemented: configuration UI and UX hardening (M9) and
packaging/release (M10).

## Contents

- [Requirements](#requirements)
- [Repository layout](#repository-layout)
- [Development commands](#development-commands)
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
- `tests/` — fixture policy, normalized schema fixtures, and security tests.
- `scripts/` — output cleanup, artifact creation, and packaged-CLI checking.
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
schema-v1 JSON, and verifies a credential-shaped argument fails with the safe
constant diagnostic.

## Current behavior

The collector CLI runs the live Claude, Umans, and Codex adapters through
bounded concurrent orchestration, a whole-collector last-known-good cache, and
strict cross-process locking. A normal invocation emits exactly one
newline-terminated schema-v1 JSON document and no stderr diagnostics.

The widget's compact panel renders one horizontal line of enabled providers
(default order Claude, Umans, Codex). Each entry shows its most useful current
metric — a window's used percentage when available, otherwise a used count —
with caution (≥75%) and critical (≥90%) threshold colors, concise
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
credentials or raw provider responses ever cross into the view. Threshold
colors and per-provider metric choices become user-configurable in Milestone 9.

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

The collector is the future owner of credential access and provider I/O. Only
normalized, secret-free JSON may cross into QML. Current diagnostics and status
values are value-free constants or constructed from fixed safe values. The
central `redact()` helper and secret scanner provide defense and tooling for
broader output paths, but the current CLI does not pass raw errors through
`redact()`. Validation, serialization, and other catastrophic failures before
the stdout write produce no stdout. The CLI performs one pre-serialized write;
an arbitrary writer that partially emits and then throws cannot be rolled back.
Direct-process crash hardening emits only the constant `Kuota collector failed`
to stderr and exits nonzero, with no raw errors, values, or stack traces reported.

Fixtures are synthetic and recognizable as non-secrets. Tests reject seeded
credential-shaped values and ensure scanner findings do not echo rejected
values. Filesystem primitives provide no-follow reads, trusted-parent checks,
same-directory exclusive temporary files, durability synchronization, cleanup
on failure, latest-read identity checks, permission preservation, and
post-rename durability-failure handling: the operation throws or returns
failure after the destination may already be new, so callers must re-read before
deciding or retrying. They are ready for future cache/auth integration, which is
outside this foundation slice.

## Documentation

- [`docs/architecture/overview.md`](docs/architecture/overview.md) — layer
  ownership, current data flow, and future boundaries.
- [`docs/architecture/collector-contract.md`](docs/architecture/collector-contract.md)
  — schema-v1 document and validation contract.
- [`docs/specs/2026-07-10-kuota-design.md`](docs/specs/2026-07-10-kuota-design.md)
  — approved product specification.
- [`tests/fixtures/README.md`](tests/fixtures/README.md) — fixture and
  redaction policy.
