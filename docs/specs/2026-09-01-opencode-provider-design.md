# OpenCode Provider — Design

**Date:** 2026-09-01
**Status:** Approved for implementation planning (owner, 2026-09-01)
**Scope:** the hosted **OpenCode Go** subscription (`opencode.ai/go`, $10/mo,
dollar-value limits). Not OpenCode Zen (prepaid balance via dashboard session
cookie — different auth surface, out of scope).

## Problem

Kuota shows Claude, Codex, Grok, Kimi, and Cursor usage. The OpenCode CLI
(`opencode`, open-source agent) has a hosted subscription, OpenCode Go, with
dollar-value usage limits that the CLI enforces via a rolling (~5h), weekly,
and monthly window. The user already holds an `opencode-go` key in
`~/.pi/agent/auth.json`; surfacing those three windows on the desktop is the
same class of value as the other providers.

## Goals

1. Add a sixth provider, `opencode`, showing the three Go usage windows
   (rolling 5h, weekly, monthly) as authoritative percent + reset data.
2. Auth with zero friction: read the existing shared auth.json entry; env
   override for manual setups.
3. Keep the security boundary: secret-free JSON to QML; read-only auth; no
   persistence of the key beyond Kuota's normal usage cache (which never
   stores credentials).

## Non-goals

- OpenCode Zen balance/budget (dashboard-cookie auth — separate product surface)
- Reading OpenCode's own auth storage (`~/.local/share/opencode/auth.json` or
  `opencode.db` SQLite) — the shared auth.json entry is the source
- Token refresh / curl fallback / retries (keyed API, no refresh protocol)
- Provider details beyond window percents (the wire carries nothing else)

## Decisions

| Topic | Choice |
|---|---|
| Provider id / name | `opencode` / "OpenCode" (Go plan) |
| Auth sources | `auth.json` `opencode-go` first, alias `opencode` second, then `OPENCODE_API_KEY` env |
| Accepted entry shapes | `{type:"api", key}` (CLI shape, observed), `{type:"api_key", key}`, `{type:"oauth", access}` — value-free classification |
| Endpoint | `GET https://opencode.ai/zen/go/v1/usage`, `Authorization: Bearer <key>` |
| Windows | `rolling` (label "5h"), `weekly` ("Weekly"), `monthly` ("Monthly") — all required for `ok` |
| Primary (compact) | rolling window `usedPercent` |
| Details namespace | none — `details.opencode` is omitted (nothing usable on the wire) |
| API risk | internal endpoint used by the OpenCode CLI itself — breakage possible but low-velocity; surface `error`/`auth-needed`, never fabricate |

Canonical order after addition: `claude`, `codex`, `grok`, `kimi`, `cursor`,
`opencode`.

## §1 Auth (`collector/src/providers/opencode/auth.ts`)

- Read `~/.pi/agent/auth.json` via the existing safe no-follow JSON reader.
- Precedence: entry `opencode-go` → entry `opencode` → env `OPENCODE_API_KEY`
  (env only when no usable file entry, matching Grok/Kimi).
- Accepted entry shapes (value never echoed in outcomes): type `api` or
  `api_key` with non-empty string `key`; type `oauth` with non-empty string
  `access`.
- Outcomes exactly like Kimi: `available` / `auth-needed` (missing-file,
  missing-entry, unsupported-entry, malformed-entry) / `error` (file read
  classes). Injected path/reader/env for tests; no network in this module.

## §2 Fetch + normalize (`fetch.ts`, `usage.ts`, `adapter.ts`)

- One bounded `GET`; timeout/abort/byte-cap consistent with Grok/Kimi; manual
  redirect handling; body cap.
- HTTP mapping: 401/403 → `auth-needed` (cancel unread body); 3xx manual
  redirect → `auth-needed`; timeout/network/5xx/oversize → `error`; 2xx →
  parse (table in recon doc).
- Parser (`usage.ts`):
  - Root `usage` object with all three windows; each window requires
    `status === "ok"`, `percent` finite in `0..100`, `resetsAt` a valid
    offset-qualified ISO timestamp.
  - `usedPercent = percent`; `resetAt = new Date(resetsAt).toISOString()`
    (UTC); no `used`/`limit` on windows (wire has none).
  - Any missing/malformed window → malformed / `error` (never a dataless `ok`).
- Adapter: auth → fetch → parse → `createNormalizedProviderResult("opencode",
  ...)`; no details object.

## §3 Contract, UI, security

**Contract (schema v2, additive):**
- `PROVIDER_IDS` += `"opencode"` (after `cursor`).
- `OpenCodeProviderRecord` in the discriminated union; runtime validation
  (TS + QML validator mirrors): windows-only records, no details namespace.
- Minimal fixtures + artifact-check provider count updates (6 → 7 total with
  CommandCode).

**Collector wiring:** register adapter; default-enable; CLI `enabledProviders`
accepts `opencode`; LKG cache treats it like any provider.

**Plasma:** `KNOWN_PROVIDERS`, defaults, config schema keys, compact/full
models (opencode windows join the primary-percent rule; full view facts —
only windows, no details), command allowlist, `main.xml`. No new QML files
expected (models/validators/config only — isolation test list unchanged).

## Architecture sketch

```text
auth.json["opencode-go"] / "opencode" / OPENCODE_API_KEY ──┐
                                                           ▼
                            GET https://opencode.ai/zen/go/v1/usage
                                                           │
                                                           ▼
                 normalize → ProviderRecord id=opencode (3 windows)
                                                           │
                                                           ▼
                      validateCollectorDocument (schema v2)
                                                           │
                                                           ▼
                                Plasma compact/full models
```

## Implementation order

1. Recon gate (live, single bounded call with the real key): confirm the three
   windows parse; record outcome privately, no secrets in notes.
2. Contract + dual validators + fixtures (RED→GREEN)
3. Auth module test-first (shapes, precedence, value-free outcomes)
4. Fetch + usage + adapter + registry
5. Plasma config/UI/models/command + QML validator mirror
6. Docs / CHANGELOG / README / AGENTS providers table
7. Full gate under synthetic HOME; user-visible smoke with real key

## Open questions

None for product shape. Recon gate (step 1) must confirm `percent` is already
the used share (not remaining) before locking fixtures — opencode-quota treats
it as used percent (`usagePercent`) and derives remaining as `100 - percent`,
which is the same interpretation Kuota needs.
