# Architecture overview

This overview describes the M1 foundation as it exists in the committed
M1.1–M1.7 implementation. It distinguishes the current placeholder path from
future provider and UI work; no live adapter, credential, cache, or bridge
behavior is implied.

## Contents

- [System boundary](#system-boundary)
- [Layer ownership](#layer-ownership)
  - [Plasma UI: `plasmoid/`](#plasma-ui-plasmoid)
  - [Collector bridge: future isolated QML component](#collector-bridge-future-isolated-qml-component)
  - [Collector: `collector/src/`](#collector-collectorsrc)
- [Current data flow](#current-data-flow)
- [Future bridge boundary](#future-bridge-boundary)
- [Normalized contract boundary](#normalized-contract-boundary)
- [Provider interface boundary](#provider-interface-boundary)
- [Filesystem safety boundary](#filesystem-safety-boundary)
- [Output and diagnostic boundary](#output-and-diagnostic-boundary)
- [Repository structure](#repository-structure)
- [Foundation verification](#foundation-verification)

## System boundary

Kuota is a Linux KDE Plasma 6 package with ID
`io.github.darkokuzmanovic.kuota`. Its metadata declares Plasma API minimum
version 6.0; the development target is Plasma 6.7.2. The collector targets
Node.js >=20 and is compiled from strict TypeScript to runnable JavaScript.
The package is MIT licensed and version `0.1.0`.

The intended product has three isolated layers:

1. Plasma QML presentation.
2. One replaceable QML executable bridge.
3. A short-lived Node collector.

Only normalized, secret-free JSON crosses the bridge boundary. The current
foundation implements the package skeleton and collector contracts, but the
bridge and live provider behavior are deliberately deferred.

## Layer ownership

### Plasma UI: `plasmoid/`

The UI owns presentation and, in later milestones, user-facing view state and
configuration. It must not own provider calls, credential access, auth-file
contents, network behavior, or collector implementation details. The current
`plasmoid/contents/ui/main.qml` is only a loadable compact icon and full-view
placeholder. It does not read credentials or contact providers.

The UI's future input is a complete validated collector snapshot. It must
replace a snapshot atomically at the document level rather than mixing old and
new provider records. Countdown and other presentation calculations belong in
QML; provider normalization does not.

### Collector bridge: future isolated QML component

The bridge will own the process-launch and response boundary between QML and the
collector. It is not present in M1. The initial compatibility implementation
may use the `org.kde.plasma.plasma5support` executable DataSource, but that
mechanism must be confined to this one component so it can later be replaced
without changing the views or collector contract.

The bridge must never put credentials, account identifiers, auth-file contents,
or provider-native responses in QML properties, widget settings, command-line
arguments, logs, or diagnostics. Its crossing payload is the normalized JSON
document only.

### Collector: `collector/src/`

The collector owns the future credential and provider-I/O boundary, plus
normalization, orchestration, and safe persistence. In the current foundation
it contains only the CLI shell, placeholder adapters, schema validation,
provider interfaces, filesystem primitives, and redaction. No credential read,
network request, auth refresh, or live provider adapter has been implemented.

The collector's internal ownership is split as follows:

- `contract/` owns schema-v1 types and whole-document/runtime validation.
- `providers/` owns adapter identity, normalized-result construction, registry
  selection, and safe provider-error mapping.
- `collect/` owns bounded concurrent invocation, cancellation/deadline races,
  independent provider outcomes, timestamps, and final document validation.
- `io/` owns no-follow JSON reads and atomic filesystem replacement semantics.
- `security/` owns redaction and secret-scan behavior.
- `cli.ts` owns serialization-before-write, stdout purity, and the direct-process
  catastrophic-failure boundary.

## Current data flow

The implemented M1 path is:

```text
CLI entry point
  -> collect()
     -> canonical registry selects enabled placeholder adapters
        -> adapters receive isolated bounded contexts
           -> placeholder normalized error records
     -> whole document is validated as schema v1
  -> one JSON serialization and one stdout write
```

The default configuration enables the canonical providers in Claude, Umans,
Codex order. The placeholders do not perform I/O; they return the safe
`Provider adapter unavailable` error status. A provider failure is represented
in its own record rather than preventing other records from being returned.

The future runtime path adds the missing pieces without changing these
boundaries:

```text
QML timer or refresh action
  -> isolated executable bridge (future)
     -> short-lived collector process
        -> credential access and provider adapters (future, collector only)
           -> normalized schema-v1 document
     <- stdout JSON only
  <- whole-document validation and snapshot replacement
  -> presentation
```

The future bridge must prevent overlapping runs, reject malformed or
unsupported documents as a whole, retain the prior valid snapshot on process
failure, and expose only normalized data to the UI. Those lifecycle behaviors
are not yet implemented in M1.

## Future bridge boundary

The initial bridge replacement boundary is specifically the executable-launch
API, not a provider API. `org.kde.plasma.plasma5support` is an allowed initial
compatibility dependency for launching the collector, but it must remain behind
one QML component. Views must not call that API directly, and the collector
must not depend on Plasma APIs. There is currently no bridge source file and no
claim of a working QML-to-collector data path.

## Normalized contract boundary

Schema v1 is the only public data shape between collector and future bridge.
It contains collection start/end UTC timestamps and one record per
selected enabled provider. Provider IDs are `claude`, `umans`, and `codex`; states are
`ok`, `stale`, `auth-needed`, and `error`.

Optional fields are omitted when unavailable. Usage windows may contain
percentage, used/limit counts, and reset timestamps. Unlimited plans omit
`limit` and `usedPercent` rather than inventing values. Provider-specific data
is namespaced under the matching provider (`details.claude`, `details.umans`,
or `details.codex`). A stale record retains real data and its last-success
timestamp; it is not an empty failure marker.

`validateCollectorDocument(input: unknown)` validates the complete document,
including timestamps, IDs, states, unknown fields, optional values, details
namespace, stale retention, and safe status text. It returns a narrowed
contract or value-free issues. The validator performs no provider, credential,
or filesystem work. Examples and the complete field rules are in
[`collector-contract.md`](collector-contract.md).

## Provider interface boundary

An adapter is selected by a typed provider ID and receives a
`ProviderAdapterContext` containing:

- the native fetch-compatible `AbortSignal`;
- an optional timeout and UTC deadline; and
- opaque dependency injection data.

It returns a promise of one provider-ID-correlated normalized result. Native
provider payloads must not enter common records. The registry rejects unknown,
duplicate, mismatched, and unregistered entries; disabled providers are not
selected; selected adapters use canonical Claude, Umans, Codex order. M1
registers only placeholders for those three IDs.

The native `AbortSignal` is a trusted-adapter rule: adapters receive it without
a proxy or wrapper, and abort-listener callbacks must never throw. If callback
work fails, the adapter must catch that failure and reject its `collect()`
promise so the collector can classify it as a provider failure. A throwing
EventTarget callback is outside that promise contract and is handled only by
the direct CLI process boundary.

## Filesystem safety boundary

The `collector/src/io/` primitives are generic foundations for future usage
cache and auth persistence; M1 does not connect them to provider behavior.
Their safety invariants are:

- JSON reads open with no-follow semantics, require a regular file, read from
  that same handle, and close the handle on every path.
- Before temporary-file creation or replacement, the immediate parent must be
  a real non-symlink directory owned by the current user when the platform
  exposes an effective UID, with no group/other write permission. Destination
  paths must also be under trusted ancestors; the parent check cannot defend
  against malicious replacement of an ancestor.
- Atomic replacement serializes before filesystem mutation, creates an
  exclusive temporary file in the destination directory, writes and fsyncs the
  file, renames it, and syncs the directory. Failure cleans up the temporary
  file and does not truncate the old destination.
- Latest-read replacement carries the opened file identity (`dev`, `ino`,
  `size`, and nanosecond mtime) through the pre-rename check and aborts when a
  concurrent replacement is detected.
- New sensitive files use restrictive permissions; permission-preserving
  replacement retains the existing ordinary permission bits. Unrelated JSON
  entries are preserved by latest-read updates.
- A post-rename durability failure throws or returns failure after the
  destination may already be new. Callers must re-read before deciding or
  retrying; they must not blindly retry an operation that may already have
  committed.

These primitives do not authorize reading `~/.pi/agent/auth.json` today. When
future auth persistence is added, only the collector may perform it, and
credentials must never cross the bridge or appear in caches, fixtures, output,
or diagnostics.

## Output and diagnostic boundary

A normal direct CLI invocation validates and serializes the complete document
before its single stdout write. Its stdout is exactly one newline-terminated
JSON document and its stderr is empty. The CLI does not print progress,
provider-native payloads, or raw errors.

Validation, serialization, and other catastrophic failures before the stdout
write produce no stdout. The CLI performs one write of the pre-serialized
document; an arbitrary writer that partially emits and then throws cannot be
rolled back, so this guarantee does not claim rollback of partial external
writes. Direct-process crash hardening still emits only this constant stderr
diagnostic and no raw error or stack:

```text
Kuota collector failed
```

Current diagnostics and status values are value-free constants or constructed
from fixed safe values. The central `redact()` helper and secret scanner exist
as defense and tooling for broader output paths, but the CLI does not pass raw
errors through `redact()`. Rejected raw values and account identifiers are never
echoed.

## Repository structure

```text
plasmoid/                 Plasma metadata and current placeholder QML
collector/src/            Collector TypeScript sources
collector/test/           Collector-focused tests
tests/                    Fixture policy, normalized fixtures, security tests
scripts/                  Output cleanup, artifact build, artifact CLI check
docs/specs/               Approved design specification
docs/architecture/        Contract and architecture documentation
dist/                     Ignored generated output
```

The package scripts are the supported command surface:

- `npm run typecheck` — strict TypeScript check (`tsconfig.json`).
- `npm test` — clean `dist/tests`, compile, and run Node's built-in tests.
- `npm run build:collector` — clean and emit `dist/collector`.
- `npm run validate:plasma` — appstream metadata validation plus
  `qmllint plasmoid/contents/ui/main.qml`.
- `npm run build:artifact` — rebuild the collector, always create the unpacked
  package, create `dist/artifact/kuota-v0.1.0.plasmoid` only when `zip` is
  available and succeeds, then run the packaged-CLI check.

Generated `dist/` contents are ignored and must be regenerated by these
scripts, not hand-edited. The artifact check exercises both the packaged
normal CLI and its credential-shaped-argument failure path.

## Foundation verification

The M1.8 verification was run on 2026-07-11 both in the working tree and in a
detached clean worktree at committed M1.7 revision `bb60a2e`. The clean run
installed only the trusted lockfile with `npm ci --ignore-scripts`, then passed
every foundation command below:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` | Pass — 177 tests, 14 suites; schema fixtures, fixture secret scan, and redaction included |
| `npm run build:collector` | Pass — runnable output in `dist/collector` |
| `npm run validate:plasma` | Pass — `kpackagetool6` metadata check and `qmllint` |
| `npm run build:artifact` | Pass — unpacked artifact and packaged CLI contract check passed; `.plasmoid` archive also created because `zip` was available |

The fixture scan and schema-fixture validation are existing tests run through
`npm test`; there is no separate scan command in `package.json`. The Plasma
script's `qmllint` invocation is the only QML load-equivalent currently wired
into the scripts. A runtime QML harness, live provider smoke test, credential
integration, network behavior, and cache integration are intentionally gate
limitations for this foundation milestone and belong to later milestones.
