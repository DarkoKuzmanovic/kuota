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
QML timer / manual Refresh
  -> CollectorBridge.qml
     -> allowlisted collector command
        -> whole-collection lock
        -> concurrent provider adapters
        -> normalized, validated results + last-known-good merge
        -> usage-only cache
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
- `io/` owns bounded JSON reads, trusted-parent checks, restrictive cache
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
failure. `bridge-lifecycle.js` tracks attempt tokens so a late response cannot
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

The automatic refresh interval defaults to five minutes and has a five-minute
minimum. Current “Show in widget” settings filter presentation only:
`main.qml` calls `refresh()` without a provider subset, even though the bridge
and collector support one. Changing this is a product decision, not a silent
refactor.

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

The collector normally emits one newline-terminated JSON document. Catastrophic
failure uses a constant diagnostic; provider failures become safe record
states. Redaction is not permission to log raw credential or provider objects.

## Verification and limits

Node tests cover contracts, providers, file safety, cache/lock behavior, and
process failure. Qt Quick Test covers validators, presentation, configuration,
bridge lifecycle, and module isolation. `validate:plasma` checks metadata and
QML; the artifact check exercises the packaged CLI.

Run gates sequentially in a separate checkout with a synthetic `HOME` and no
provider environment variables. The current artifact checker inherits its
caller's environment; **it is not independently isolated yet**. The README's
build wrapper avoids real credential/network access.

The [project review](../reviews/2026-09-08-project-review.md) records the current
Cursor WAL/cancellation risks, packaging defects, and consistency work. Passing
offscreen tests is not proof of every real panel layout, provider API, or
subprocess-lifecycle property. No live account smoke test is implied by the
synthetic verification results.
