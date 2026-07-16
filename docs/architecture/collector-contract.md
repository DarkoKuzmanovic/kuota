# Collector contract

The collector emits one normalized JSON document. Schema version 1 is deliberately small: the UI can render common provider state without knowing provider-native response formats.

## Document shape

```json
{
  "schemaVersion": 1,
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
      "id": "umans",
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

`collectionStartedAt` and `collectionFinishedAt` are UTC ISO 8601 timestamps, and the start cannot be after the finish. `providers` contains one record for each configured provider; it may be empty and may contain a partial result when another provider fails. Provider IDs are `claude`, `umans`, and `codex`. States are `ok`, `stale`, `auth-needed`, and `error`.

A `stale` provider is a last-known-good record, not an empty failure marker. It must include `lastSuccessAt` and retained real data: either at least one usage window or a non-empty details object in the namespace matching its provider ID. It does not need both kinds of data, nor every optional field. Other states may omit `lastSuccessAt`, windows, and details when those values are unavailable.

Optional values are omitted when the provider does not supply them. A usage window has a stable `id`, a human-readable `label`, and may contain `usedPercent`, non-negative integer `used` and `limit` counts, and a UTC `resetAt`. Counts cannot exceed a supplied limit. For an unlimited plan, leave `limit` and `usedPercent` out rather than inventing either value.

Provider details are namespaced and typed under the provider record. Claude details may contain `model`, integer `tokens`, and the following optional extra-usage fields: boolean `extraUsageEnabled`; non-negative integer `extraUsageUsedCredits` and `extraUsageMonthlyLimit`, expressed as integer credit amounts in the currency's minor units (each independent, so overage where used exceeds the limit is retained rather than clamped); a bounded (≤16 character) `extraUsageCurrency` code; non-negative integer `extraUsageDecimalPlaces`, the number of decimal places used to render those minor-unit amounts in `extraUsageCurrency`; and a bounded (≤100 character) `extraUsageDisabledReason`. Each extra-usage field is omitted when unavailable, and malformed extra-usage is dropped in isolation so valid base and model windows still surface. Umans details may contain `plan`, non-negative integer rolling-window `requests`, current non-negative integer `concurrency`, and optional non-negative integer `concurrencyLimit`; `concurrencyLimit` is omitted when the provider does not return it. Codex details may contain `plan`, non-negative `credits` and `cost`, and integer `tokens`. A details object must use only the namespace matching its provider ID. No provider detail is inferred from a missing native field, and no credential, account identifier, authorization field, raw response, or token-shaped value belongs in this document.

The TypeScript `ProviderRecord` is a discriminated union: a `claude` record can only contain `details.claude`, a `umans` record only `details.umans`, and a `codex` record only `details.codex`. Runtime validation enforces the same correlation and the stale retention rule before narrowing unknown input.

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
  "schemaVersion": 2,
  "collectionStartedAt": "2026-07-11T10:00:00.000Z",
  "collectionFinishedAt": "2026-07-11T10:00:01.000Z",
  "providers": []
}
```

```json
{
  "schemaVersion": 1,
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
