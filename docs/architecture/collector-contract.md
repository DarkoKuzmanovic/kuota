# Collector contract

The collector emits one normalized JSON document. Schema version 2 is deliberately small: the UI can render common provider state without knowing provider-native response formats.

## Document shape

```json
{
  "schemaVersion": 2,
  "collectionStartedAt": "2026-07-11T10:00:00.000Z",
  "collectionFinishedAt": "2026-07-11T10:00:01.000Z",
  "providers": [
    {
      "id": "claude",
      "state": "ok",
      "status": "Usage is current",
      "lastSuccessAt": "2026-07-11T10:00:01.000Z",
      "windows": [
        {
          "id": "weekly",
          "label": "Weekly",
          "usedPercent": 42,
          "used": 42,
          "limit": 100,
          "resetAt": "2026-07-14T10:00:00.000Z"
        }
      ],
      "details": {
        "claude": {
          "model": "synthetic-model",
          "tokens": 1200
        }
      }
    },
    {
      "id": "grok",
      "state": "auth-needed",
      "status": "Login required"
    },
    {
      "id": "codex",
      "state": "error",
      "status": "Provider unavailable"
    }
  ]
}
```

`collectionStartedAt` and `collectionFinishedAt` are UTC ISO 8601 timestamps, and the start cannot be after the finish. `providers` contains one record for each configured provider; it may be empty and may contain a partial result when another provider fails. Provider IDs are `claude`, `codex`, `grok`, `kimi`, `cursor`, `opencode`, and `commandcode` (canonical order). States are `ok`, `stale`, `auth-needed`, and `error`.

A `stale` provider is a last-known-good record, not an empty failure marker. It must include `lastSuccessAt` and retained real data: either at least one usage window or a non-empty details object in the namespace matching its provider ID. It does not need both kinds of data, nor every optional field. Other states may omit `lastSuccessAt`, windows, and details when those values are unavailable.

Optional values are omitted when the provider does not supply them. A usage window has a stable `id`, a human-readable `label`, and may contain `usedPercent`, non-negative integer `used` and `limit` counts, and a UTC `resetAt`. Counts cannot exceed a supplied limit; the single exception is a `commandcode` record, whose windows may legally carry `used > limit` when the exceeded flag applies. For an unlimited plan, leave `limit` and `usedPercent` out rather than inventing either value.

Provider details are namespaced and typed under the provider record. Claude details may contain `model`, integer `tokens`, and the following optional extra-usage fields: boolean `extraUsageEnabled`; non-negative integer `extraUsageUsedCredits` and `extraUsageMonthlyLimit`, expressed as integer credit amounts in the currency's minor units (each independent, so overage where used exceeds the limit is retained rather than clamped); a bounded (≤16 character) `extraUsageCurrency` code; non-negative integer `extraUsageDecimalPlaces`, the number of decimal places used to render those minor-unit amounts in `extraUsageCurrency`; and a bounded (≤100 character) `extraUsageDisabledReason`. Each extra-usage field is omitted when unavailable, and malformed extra-usage is dropped in isolation so valid base and model windows still surface. Codex details may contain `plan`, non-negative `credits` and `cost`, and integer `tokens`. A details object must use only the namespace matching its provider ID. No provider detail is inferred from a missing native field, and no credential, account identifier, authorization field, raw response, or token-shaped value belongs in this document.

The TypeScript `ProviderRecord` is a discriminated union: a `claude` record can only contain `details.claude`, a `codex` record only `details.codex`, a `grok` record only `details.grok`, a `kimi` record only `details.kimi`, a `cursor` record only `details.cursor`, and a `commandcode` record only `details.commandcode`. An `opencode` record carries no `details` object; its provider data consists only of usage windows. Runtime validation enforces the same correlation and the stale retention rule before narrowing unknown input.

Grok details (`details.grok`) may contain non-negative `monthlyUsed` and `monthlyLimit` counts and a UTC `monthlyResetAt` timestamp. Usage windows are ordered week (`id: "week"`, label `"7d"`) then month (`id: "month"`, label `"30d"`) so compact primary defaults to the tighter credit window; the weekly window is optional and omitted when the credits endpoint does not return a weekly period.

Kimi details (`details.kimi`) may contain non-negative integer `concurrency` and `concurrencyLimit` counts. Weekly and short usage windows are represented as `UsageWindow` entries on the provider record; numeric fields are normalized to numbers by the adapter before entering the contract.

Cursor details (`details.cursor`) may contain bounded `membershipType` text; non-negative integer `onDemandUsed` and `onDemandLimit` (cents when present); and optional `autoPercentUsed`, `apiPercentUsed`, and `totalPercentUsed` in `0..100`. The primary usage window is `plan` with `usedPercent` taken from `totalPercentUsed` (dashboard spend share) — not from request-count `used`/`limit`. Cursor auth is local-session or env only — never `auth.json` and never persisted by Kuota.

OpenCode records carry no details bag (there is nothing provider-native beyond the windows). They expose three usage windows in fixed order: `rolling` (label `5h`), `weekly` (label `Weekly`), and `monthly` (label `Monthly`), each required with `usedPercent` in `0..100` derived from the wire `percent` and `resetAt` derived from the wire `resetsAt` (offset ISO 8601 accepted, emitted as UTC). The compact primary defaults to `rolling`.

CommandCode details (`details.commandcode`) may contain a bounded `planName` drawn from a closed map (unknown plan ids are omitted, never passed through); non-negative `monthlyCredits`, `purchasedCredits`, and `freeCredits` allowance counts; and optional boolean `exceeded` (5-hour window) and `weeklyExceeded` flags. Windows are `fiveHour` (label `5h`, required) and `weekly` (label `Weekly`, optional — included only when both `used` and `limit` are finite). `usedPercent` is `min(100, used / limit * 100)` derived from the unrounded wire counts (the wire may emit fractional credit consumption; the contract keeps safe-integer `used`/`limit` by rounding); `resetAt` is a UTC-normalized epoch-millisecond timestamp. The compact primary defaults to `fiveHour`. A `used > limit` window is valid for this provider (see above); the exceeded flags come from the credits endpoint, not from comparing counts.

## Migrate-then-validate

Both TypeScript `validateCollectorDocument` and QML `collector-validator.js` accept legacy `schemaVersion: 1` input only as a one-shot migration path:

1. Clone a working copy, remove every provider whose `id` is `"umans"`, rewrite `schemaVersion` to `2`.
2. Validate the result as a v2 document (unknown IDs including `umans` fail on v2 input).
3. Any other schema version → unsupported.

Migration never invents data. If the remainder is still invalid, validation fails normally.

## Runtime validation

`validateCollectorDocument(input: unknown)` in `collector/src/contract/validate.ts` validates the whole input and returns either a narrowed `CollectorDocument` or a list of issues. Validation rejects unsupported schema versions, unknown fields, unknown provider IDs or states, duplicate provider records, malformed timestamps, unsafe status text, malformed details, percentages outside `0..100`, negative or non-safe counts, and counts that exceed limits.

Errors contain only:

```json
{ "path": "$.providers[0].windows[0].used", "reason": "cannot exceed limit" }
```

They never include the rejected raw value. The validator does not fetch providers, read credentials, or mutate caches.

## Collector fallback cache contract

The collector cache is a private versioned envelope at `~/.cache/kuota/collector.json`. It may contain only validated `ok` provider records with a real `lastSuccessAt` and retained usage data; credentials, account identifiers, raw responses, headers, diagnostics, configuration, and non-success records are rejected. The cache is fallback-only: every enabled adapter is still collected live. A matching transient `error` may render the matching cached record as `stale`; `auth-needed` remains visible and never becomes stale. Successful providers replace only their own cached entry, preserving other validated provider entries independently. Cache reads/writes use the shared no-follow and atomic primitives with a trusted private `~/.cache/kuota` directory, but collector/CLI composition and cross-process locking remain separate boundaries.

## Provider cancellation and CLI failure boundary

Provider adapters are trusted internal code. The collector passes each adapter the native, fetch-compatible `AbortSignal`; it does not proxy or wrap the signal. Adapters MUST keep abort-listener callbacks non-throwing. If callback work fails, the adapter catches that failure and rejects its `collect()` promise so the collector can classify it as a provider failure. A throwing `EventTarget` callback is outside the adapter promise contract and is handled only by the direct CLI process boundary.

The CLI validates and serializes the complete document before making its single stdout write. An injected writer must therefore use all-or-throw-before-write semantics. An arbitrary writer that partially writes and then throws cannot provide rollback, so the CLI cannot restore stdout purity after such a failure. Direct invocation installs a process-local catastrophic boundary that emits only the constant safe diagnostic and exits nonzero for uncaught exceptions or unhandled rejections; importing the CLI as a library installs no process handlers.

## Filesystem primitive guarantees

The collector's JSON read opens the destination with no-follow semantics, checks the opened handle as a regular file, and reads from that same handle. Missing files are safe; handles are closed on every path. Permission-preserving replacement retains only ordinary `0o777` permission bits.

Before creating a temporary file or replacing the destination, the immediate parent is `lstat`-checked as a real, non-symlink directory that is not group/other writable and, when the platform exposes the effective user ID, is owned by that user. Caller-supplied destination paths must live under trusted ancestors; this precondition does not protect against malicious replacement of an ancestor directory.

A latest-read replacement carries the identity token (`dev`, `ino`, `size`, and nanosecond mtime) from that opened read through the final pre-rename check. A detected identity change aborts without overwriting. The residual `lstat`-to-`rename` race remains: this detects cooperative/conventional concurrent replacement but cannot make uncooperative external writers honor a lock. A directory-sync failure after rename is post-commit; callers must report it without a blind retry that could overwrite the committed result.

## Invalid examples

These documents fail validation:

```json
{
  "schemaVersion": 3,
  "collectionStartedAt": "2026-07-11T10:00:00.000Z",
  "collectionFinishedAt": "2026-07-11T10:00:01.000Z",
  "providers": []
}
```

```json
{
  "schemaVersion": 2,
  "collectionStartedAt": "2026-07-11T10:00:00.000Z",
  "collectionFinishedAt": "2026-07-11T10:00:01.000Z",
  "providers": [
    {
      "id": "claude",
      "state": "ok",
      "windows": [
        { "id": "weekly", "label": "Weekly", "usedPercent": 101 }
      ],
      "details": { "claude": { "tokens": "not-a-count" } }
    }
  ]
}
```
