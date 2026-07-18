# Architecture overview

This overview describes the Kuota V1 architecture as shipped through
Milestone 9 (with M10 lifecycle/packaging in progress). The three isolated
layers, the live collector, the executable bridge, and the configuration layer
are all implemented; only KDE Store publication and a final live smoke test
remain before the V1 release candidate.

## Contents

- [System boundary](#system-boundary)
- [Layer ownership](#layer-ownership)
  - [Plasma UI: `plasmoid/`](#plasma-ui-plasmoid)
  - [Collector bridge: isolated QML component](#collector-bridge-isolated-qml-component)
  - [Collector: `collector/src/`](#collector-collectorsrc)
- [Current data flow](#current-data-flow)
- [Bridge replacement boundary](#bridge-replacement-boundary)
- [Normalized contract boundary](#normalized-contract-boundary)
- [Provider interface boundary](#provider-interface-boundary)
- [Filesystem safety boundary](#filesystem-safety-boundary)
- [Configuration boundary](#configuration-boundary)
- [Output and diagnostic boundary](#output-and-diagnostic-boundary)
- [Repository structure](#repository-structure)
- [Verification](#verification)

## System boundary

Kuota is a Linux KDE Plasma 6 package with ID
`io.github.darkokuzmanovic.kuota`. Its metadata declares Plasma API minimum
version 6.0; the development target is Plasma 6.7.2. The collector targets
Node.js >=20 and is compiled from strict TypeScript to runnable JavaScript.
The package is MIT licensed and version `0.1.0` (the product release is
labelled "V1"; the package semver stays pre-1.0).

The product has three isolated layers:

1. Plasma QML presentation.
2. One replaceable QML executable bridge.
3. A short-lived Node collector.

Only normalized, secret-free JSON crosses the bridge boundary. Credentials,
tokens, account identifiers, raw provider responses, and auth-file contents
never enter QML, widget settings, command arguments, stdout, stderr, logs, or
caches.

## Layer ownership

### Plasma UI: `plasmoid/`

The UI owns presentation and user-facing view state and configuration. It does
not own provider calls, credential access, auth-file contents, network
behavior, or collector implementation details. It comprises the compact panel
representation, the full popup/desktop representation (sharing one view), the
configuration dialog, and the isolated collector bridge.

The UI's input is a complete validated collector snapshot. It replaces a
snapshot atomically at the document level rather than mixing old and new
provider records. Countdown and other presentation calculations live in QML
(computed from `resetAt` timestamps); provider normalization does not.

Presentation logic is split into Plasma-independent `.pragma library` JS
modules (`compact-model.js`, `full-model.js`, `config-model.js`) so it is
unit-testable offscreen via the Qt 6 test runner, with the QML files kept as
thin views over them.

### Collector bridge: isolated QML component

The bridge owns the process-launch and response boundary between QML and the
collector. It is implemented as `CollectorBridge.qml` plus supporting modules
(`bridge-lifecycle.qml`, `collector-command.qml`, `collector-validator.js`,
`snapshot-state.js`) and uses the `org.kde.plasma.plasma5support` executable
DataSource as its compatibility launch mechanism. That mechanism is confined to
this one component so it can be replaced without changing the views or the
collector contract — an automated isolation test enforces that no other
production QML imports `org.kde.plasma.plasma5support`.

The bridge prevents overlapping runs, rejects malformed or unsupported
documents as a whole, retains the prior valid snapshot on process failure, and
exposes only normalized data to the UI. It never puts credentials, account
identifiers, auth-file contents, or provider-native responses in QML
properties, widget settings, command-line arguments, logs, or diagnostics. Its
crossing payload is the normalized JSON document only.

### Collector: `collector/src/`

The collector owns the credential and provider-I/O boundary, plus
normalization, orchestration, and safe persistence. It contains the CLI shell,
the live Claude, Umans, and Codex adapters, schema validation, provider
interfaces/registry, filesystem primitives, redaction, the cross-process lock,
and the fallback cache.

The collector's internal ownership is split as follows:

- `contract/` owns schema-v1 types and whole-document/runtime validation.
- `providers/` owns adapter identity, normalized-result construction, registry
  selection, safe provider-error mapping, and the live Claude/Codex/Umans
  fetch + credential + auth-persistence paths. Provider-specific payloads are
  namespaced under their provider record (`details.claude`, `details.umans`,
  `details.codex`).
- `collect/` owns bounded concurrent invocation, cancellation/deadline races,
  independent provider outcomes, timestamps, the whole-collector last-known-good
  cache, and final document validation.
- `io/` owns no-follow JSON reads and atomic filesystem replacement semantics.
- `security/` owns redaction and secret-scan behavior.
- `cli.ts` owns serialization-before-write, stdout purity, and the direct-process
  catastrophic-failure boundary.

## Current data flow

The shipped runtime path is:

```text
QML timer or refresh action
  -> isolated executable bridge (CollectorBridge.qml)
     -> short-lived collector process
        -> cross-process lock + credential access + live provider adapters
           -> normalized schema-v1 document
     <- stdout JSON only
  <- whole-document validation and snapshot replacement (retain on failure)
  -> presentation (compact-model.js / full-model.js)
```

The collector CLI runs the live adapters through bounded concurrent
orchestration, a whole-collector last-known-good cache, and strict
cross-process locking. A normal invocation emits exactly one
newline-terminated schema-v1 JSON document and no stderr diagnostics. The
default configuration enables the canonical providers in Claude, Umans, Codex
order. A provider failure is represented in its own record rather than
preventing other records from being returned; one provider failing never blocks
successful providers from updating.

Refreshes never overlap. Enabled providers are fetched concurrently with
bounded timeouts; the global refresh interval defaults to five minutes (the
Claude-safe TTL). Claude prefers a fresh shared pi-hud cache and keeps its own
last-known-good cache, honoring `Retry-After` and a minimum 429 backoff, and
retains stale data on failure. Codex uses normal HTTP first, falls back to
stdin-configured curl on Cloudflare/TLS rejection, refreshes an expired OAuth
token once, and persists refreshed auth via latest-read atomic
permission-preserving merge. Umans reports rolling-window requests and optional
limits; unlimited plans show counts/timing without invented percentages.

## Bridge replacement boundary

The bridge replacement boundary is specifically the executable-launch API,
not a provider API. `org.kde.plasma.plasma5support` is the current
compatibility dependency for launching the collector, confined to
`CollectorBridge.qml`. Views must not call that API directly, and the collector
must not depend on Plasma APIs. Replacing the launch mechanism (for example,
with a different Plasma 6 executable or dataengine API) touches only
`CollectorBridge.qml` and its supporting bridge modules; the views, the JS
presentation modules, and the collector contract are unchanged.

## Normalized contract boundary

Schema v1 is the only public data shape between collector and bridge. It
contains collection start/end UTC timestamps and one record per selected
enabled provider. Provider IDs are `claude`, `umans`, and `codex`; states are
`ok`, `stale`, `auth-needed`, and `error`.

Optional fields are omitted when unavailable. Usage windows may contain
percentage, used/limit counts, and reset timestamps. Unlimited plans omit
`limit` and `usedPercent` rather than inventing values. Provider-specific data
is namespaced under the matching provider (`details.claude`, `details.umans`,
or `details.codex`). A stale record retains real data and its `lastSuccessAt`
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
selected; selected adapters use canonical Claude, Umans, Codex order.

The native `AbortSignal` is a trusted-adapter rule: adapters receive it without
a proxy or wrapper, and abort-listener callbacks must never throw. If callback
work fails, the adapter must catch that failure and reject its `collect()`
promise so the collector can classify it as a provider failure. A throwing
EventTarget callback is outside that promise contract and is handled only by
the direct CLI process boundary.

## Filesystem safety boundary

The `collector/src/io/` primitives back the fallback cache and the Codex auth
refresh. Their safety invariants are:

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
  concurrent replacement is detected. The Codex auth refresh uses this to
  preserve unrelated `auth.json` entries and the existing file mode.
- New sensitive files use restrictive permissions; permission-preserving
  replacement retains the existing ordinary permission bits.
- A post-rename durability failure throws or returns failure after the
  destination may already be new. Callers must re-read before deciding or
  retrying; they must not blindly retry an operation that may already have
  committed.

The collector reads `~/.pi/agent/auth.json` for credential discovery (Claude,
Codex, Umans). Only the Codex token refresh writes back, via the latest-read
atomic merge above. Credentials never cross the bridge or appear in caches,
fixtures, output, or diagnostics. The whole-collector normalized LKG envelope
lives at `~/.cache/kuota/collector.json` with a kernel advisory lock at
`~/.cache/kuota/collector.lock`; the Claude cache lives at
`~/.cache/kuota/claude.json`.

## Configuration boundary

A flat KConfigXT schema in `plasmoid/contents/config/main.xml` holds the V1
settings: per-provider visibility and order, per-provider compact window
selector, display mode, entry separator, font scale, reset-countdown
visibility, caution/critical thresholds, and refresh interval. The
Plasma-independent `config-model.js` (`sanitize`/`assemble`) is the single
read boundary: it clamps the refresh interval to a ≥5-minute floor, clamps
thresholds to 0–100 with caution < critical, falls back on garbage, and
assembles the `displayConfig` the compact/full models consume. Config-UI
spinbox bounds are a UX nicety, not the guard. V1 config keys are additive-only
(future versions add keys, never rename/remove within the compatibility window),
so no migration logic is needed.

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

Diagnostics and status values are value-free constants or constructed from
fixed safe values, routed through the central `redact()` helper. Rejected raw
values and account identifiers are never echoed.

## Repository structure

```text
plasmoid/                 Plasma metadata and QML sources (compact, full, config, bridge)
collector/src/            Collector TypeScript sources
collector/test/           Collector-focused tests
tests/                    Fixture policy, normalized fixtures, security tests, QML tests
scripts/                  Output cleanup, artifact build, artifact check, QML test runner,
                         install/update/uninstall lifecycle scripts
docs/specs/               Approved design specification
docs/architecture/        Contract and architecture documentation
dist/                     Ignored generated output
```

The package scripts are the supported command surface:

- `npm run typecheck` — strict TypeScript check (`tsconfig.json`).
- `npm test` — clean `dist/tests`, compile, and run Node's built-in tests
  (collector, contract, IO, security, fixture safety, lifecycle blast-radius).
- `npm run test:qml` — run the Qt 6 QML test suite via
  `/usr/lib/qt6/bin/qmltestrunner` (NOT the Qt 5 `/usr/bin/qmltestrunner`).
- `npm run build:collector` — clean and emit `dist/collector`.
- `npm run validate:plasma` — appstream metadata validation plus `qmllint` over
  the widget QML and Plasma-independent JS modules.
- `npm run build:artifact` — rebuild the collector, always create the unpacked
  package, create `dist/artifact/kuota-v0.1.0.plasmoid` only when `zip` is
  available and succeeds, then run the packaged-CLI check.

Generated `dist/` contents are ignored and must be regenerated by these
scripts, not hand-edited. The artifact check exercises both the packaged
normal CLI and its credential-shaped-argument failure path.

## Verification

Each milestone passes an exit gate under a temporary synthetic `HOME` (0700
`.cache`) so no live credentials or network are consulted. Gates G0–G9 are
PASS (M1–M9 complete). The G10 release-candidate gate (M10) adds the live
collector smoke test, the artifact install, and the lifecycle-script
verification; KDE Store publication remains blocked pending separate approval.

Current automated baseline: Node 462 tests (14 suites, including the lifecycle
blast-radius test), Qt 6 QML 266 tests, typecheck, `validate:plasma`, and
`build:artifact` all green. Live provider behavior is exercised by the G10
smoke test, not the synthetic-HOME gates.
