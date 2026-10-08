# Architecture overview

Kuota is a KDE Plasma 6 widget backed by a short-lived Node collector. The
package ID is `io.github.darkokuzmanovic.kuota`; supported provider behavior is
specified in the [design and amendments](../specs/2026-07-10-kuota-design.md).
See [README](../../README.md) for setup and [CHANGELOG](../../CHANGELOG.md) for
release state rather than inferring a release from milestone numbers.

## Three layers

| Layer | Responsibility | Must not do |
|---|---|---|
| Plasma UI | Compact/full views, settings, formatting, countdowns, accessible labels. | Read credentials, make provider HTTP requests, interpret native provider responses. |
| Collector bridge | Launch a bounded collection attempt, track its source token, validate a complete JSON response, retain a previous snapshot on failure. | Accept arbitrary executable/settings strings or expose raw process diagnostics. |
| Node collector | Credential access, provider requests, normalization, caching, backoff, Codex refresh, safe persistence. | Depend on Plasma APIs or send credentials/account identifiers across the bridge. |

`CollectorBridge.qml` is the only production component importing
`org.kde.plasma.plasma5support`. It currently launches the executable DataSource
through an allowlisted, quoted command. The launch mechanism is replaceable
without moving provider or credential logic into QML.

```text
QML startup / timer / manual Refresh / collection-selection change
  -> CollectorBridge.qml
     -> allowlisted collector command
        -> whole-collection lock
        -> concurrent provider adapters
        -> normalized, validated results + last-known-good merge
        -> usage + retry-state cache
     <- one schema-v2 JSON document on stdout
  <- validate entire document, then replace snapshot
  -> compact/full presentation models
```

## Collector

Entry point: `collector/src/cli.ts`.

- `collect/` owns provider deadlines, cancellation signaling, independent
  outcomes, the whole-collection lock, cache merge, and final validation.
- `providers/` owns Claude, Codex, Grok, Kimi, Cursor, OpenCode, and CommandCode
  auth discovery, fetches, parsing, and provider-specific policy.
- `contract/` owns the versioned shape and runtime validation. The historical
  filename `schema-v1.ts` now defines **schema v2**; the filename is not the
  wire version.
- `io/` owns JSON file reads, trusted-parent checks, restrictive cache
  directories, and atomic filesystem replacement.
- `security/redact.ts` owns redaction of diagnostic and credential-shaped data.

CLI forms are either no arguments (all default providers) or exactly one
`--enabled-providers=<csv>` argument. An empty CSV selects no providers. Tokens
and account IDs are never valid command arguments.

The registry's constructors are inert: registration itself must not perform
credential or network I/O. Provider-specific adapters keep separate policy;
Claude's shared-cache/backoff behavior and Codex's curl/refresh/persistence flow
are not interchangeable with the simpler read-only adapters.

## Snapshot and presentation

[Collector contract](collector-contract.md) is the authoritative wire reference.
The document carries UTC collection timestamps, `schemaVersion: 2`, and ordered
provider records. States are `ok`, `stale`, `auth-needed`, and `error`.

Optional fields are omitted. No invented zeroes, unknown-value placeholders,
or equal-looking quota windows are added for symmetry. A stale record retains
real windows or details plus its last-successful timestamp. Details are
namespaced and field-allowlisted for the matching provider; OpenCode has only
windows and no details namespace.

`collector-validator.js` validates the QML-side response as a whole.
`snapshot-state.js` retains valid previous data on malformed output or process
failure for the same collection selection. Membership changes clear the previous
snapshot and permanently invalidate an active result, even when the selection
returns to its original membership. `bridge-lifecycle.js` tracks attempt tokens so a late response cannot
satisfy a later request. `collector-command.js` owns the command allowlist and
quoting. These are JavaScript modules, not QML components.

`compact-model.js` and `full-model.js` turn validated records into renderable
models without Plasma or I/O. The QML views own clocks, layout, keyboard
interaction, and accessible names. Full-view selection is derived from the tab
bar rather than duplicated in a second selection state.

## Settings

`plasmoid/contents/config/main.xml` is the KConfigXT schema.
`config-model.js` is the read-boundary sanitizer; `main.qml` passes sanitized
settings to the views. UI control min/max values are convenience, not the
validation boundary. New settings must have a schema default, sanitizer,
config-page binding, real rendered consumer, and wiring tests.

The bundled `provider-catalog.js` owns shared QML provider order, plain display
labels, and the selectable-window IDs for every provider except Cursor (one
window only). Command and
validator allowlists, model defaults, and config-page order derive from it;
TypeScript uses its existing contract `PROVIDER_IDS`. The two whole-document
validators and native parsers remain independent. Literal `qsTr` labels stay in
their original QML files to preserve extraction and translation contexts, with
English-label parity tests rather than a translation-system rewrite. The typed
registry tuples also remain explicit to preserve their correlated compatibility
exports; tests enforce their provider coverage and adapter identity.

`config-model.js` owns one complete settings-default definition and returns
fresh array copies. Tests pin all KConfig keys, types and defaults against the
approved public settings ABI, exercise fallback and non-default values, and
check every config-page binding. Claude, Codex, Grok, Kimi, OpenCode and
CommandCode have window selectors (M15); Cursor has a single window and none.
This consolidation introduces no new persisted setting.

The automatic refresh interval defaults to five minutes and has a five-minute
minimum. Under the approved [issue #7 amendment](../specs/2026-09-09-provider-selection-collection-design.md),
the existing visibility keys now enable both display and collection. The root
derives canonical allowlisted membership from sanitized settings for startup,
manual, timer, and selection-change refreshes. Display order and appearance
changes do not recollect. Empty membership launches no process and creates no
collection timestamp; re-enabling requests a refresh.

The bridge retains active source ownership and its deadline during selection
changes, coalescing to at most one latest-selection refresh after settlement.
Already-started work may finish; disconnect is not assumed to reap children.
Ordinary same-selection refreshes still cannot overlap. Standalone bridge callers
retain default-all compatibility when no subset is supplied. Independent widgets
may use different selections: the collector preserves hidden LKG records on disk
for other instances, while successful and lock-fallback responses contain only
the invocation’s selected providers.

## Credential and filesystem safety

Codex, Grok, Kimi, OpenCode and CommandCode read Kuota's own
`$XDG_CONFIG_HOME/kuota/credentials.json` (written by `kuota login`); Claude
reads Claude Code's login, Codex falls back to the Codex CLI login, and Cursor
reads its local SQLite session, all read-only,
with env fallbacks where listed in the README. Only Kuota's own Codex/Grok/Kimi
refresh writes, and only to Kuota's store, through a latest-read,
identity-checked atomic merge that preserves unrelated entries and forces 0600.

Cache paths under `~/.cache/kuota/` hold normalized usage and Kuota-owned
secret-free retry state (`claude-backoff.json`), never credentials.
Atomic writes use same-directory exclusive temporary files, trusted-parent
checks, fsync, and cleanup. A post-commit durability failure is indeterminate;
read back rather than blindly retrying the write. Keep these guarantees when
extracting shared helpers.

`io/json-value.ts` is the import-free owner of the JSON value types and
descriptor-aware iterative graph guard. Both legacy I/O exports bind to that
same function; json-file retains its type exports/predicate and atomic-write
retains its boolean callable signature. Sparse arrays and shared acyclic
subtrees remain accepted. Property getters are not read, but reflective proxy
traps can execute. Guard acceptance does not guarantee serialization succeeds:
a deep accepted graph still fails with the constant serialize error before
filesystem work. This is neither a redactor nor a whole-document schema
validator; the independent TS/QML validators and native parsers remain separate.

The collector normally emits one newline-terminated JSON document. Catastrophic
failure uses a constant diagnostic; provider failures become safe record
states. Redaction is not permission to log raw credential or provider objects.

## Verification and limits

Node tests cover contracts, providers, file safety, cache/lock behavior, and
process failure. Qt Quick Test covers validators, presentation, configuration,
bridge lifecycle, and module isolation. `validate:plasma` checks metadata and
QML; the artifact check exercises the packaged CLI. A discovered production-file
inventory enforces complete lint/isolation lists, including the configuration
entry point. Shared synthetic fixtures test both validators against the same
valid/invalid contract documents, including schema-v1/legacy-Umans migration.

Run gates sequentially in a separate checkout with a synthetic `HOME` and no
provider environment variables. The artifact checker additionally gives each
packaged-CLI child a fresh private home/cache and a minimal environment, with
time/output bounds and cleanup. That child isolation does not sandbox the
parent's dependency installation or test tooling; keep the outer gates isolated
too.

The dated [project review](../reviews/2026-09-08-project-review.md) records the
original findings; [PLAN](../../PLAN.md) tracks subsequent fixes and gate
evidence. Passing offscreen tests is not proof of every real panel layout,
provider API, or subprocess-lifecycle property. No live account smoke test is
implied by the synthetic verification results.
