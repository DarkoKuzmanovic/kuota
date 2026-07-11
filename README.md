# Kuota

Kuota is a standalone KDE Plasma 6 widget for showing authoritative Claude,
Umans, and Codex usage without a running Pi session. The repository is currently
at the M1 foundation gate: the package skeleton, normalized collector contract,
provider boundaries, safety primitives, and placeholder CLI are implemented.
Live provider adapters, credentials, caching, and the QML collector bridge are
not implemented yet.

## Contents

- [Requirements](#requirements)
- [Repository layout](#repository-layout)
- [Development commands](#development-commands)
- [Current foundation behavior](#current-foundation-behavior)
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
`qmllint plasmoid/contents/ui/main.qml`; this is the current minimal QML
load-equivalent check, not a runtime rendering harness.

`npm run build:artifact` rebuilds the collector and runs
`scripts/build-artifact.js`. The script always creates the unpacked directory
`dist/artifact/kuota-v0.1.0/`, copies the package and collector, and runs
`scripts/check-artifact.js`. If `zip` is available and succeeds, it also creates
`dist/artifact/kuota-v0.1.0.plasmoid`; archive creation is optional and is not
required for build success. The check executes the packaged CLI, validates its
schema-v1 JSON, and verifies a credential-shaped argument fails with the safe
constant diagnostic.

## Current foundation behavior

The CLI currently wires three canonical placeholder adapters (`claude`,
`umans`, and `codex`) through bounded concurrent orchestration. No network
request, credential read, auth refresh, or live provider behavior occurs. A
normal invocation emits exactly one newline-terminated schema-v1 JSON document
and no stderr diagnostics; its provider records report the exact
`Provider adapter unavailable` placeholder status.

The normalized contract uses provider states `ok`, `stale`, `auth-needed`, and
`error`. Optional values are omitted, stale records retain real data, and
provider-specific details are namespaced under the matching provider ID. The
full contract and validation rules are in
[`docs/architecture/collector-contract.md`](docs/architecture/collector-contract.md).

## Security boundaries

QML is presentation-only: it contains no provider I/O, credentials, auth
settings, or network behavior. The future executable bridge will be one
isolated QML boundary; its initial compatibility mechanism may use the
`org.kde.plasma.plasma5support` executable DataSource, but that boundary is not
yet implemented and must remain replaceable.

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
