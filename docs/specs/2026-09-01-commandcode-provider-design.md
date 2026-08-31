# CommandCode Provider — Design

**Date:** 2026-09-01
**Status:** Approved for implementation planning (owner, 2026-09-01)

## Problem

Kuota shows Claude, Codex, Grok, Kimi, Cursor (and, per sibling design,
OpenCode) usage. CommandCode (`commandcode.ai`) is a hosted coding-agent
service with plan quotas enforced through rolling five-hour and weekly
windows plus monthly credit allowances. The user already holds a
`commandcode` credential in `~/.pi/agent/auth.json` (pi stores the API key as
an oauth-shaped `access`). Surfacing the live windows on the desktop is the
same class of value as the other providers.

## Goals

1. Add a seventh provider, `commandcode`, showing the five-hour and weekly
   usage windows as authoritative percent/used/limit/reset data, plus
   monthly credit allowance facts.
2. Auth with zero friction: existing shared auth.json entry; env override.
3. Keep the security boundary: secret-free JSON to QML; read-only auth; no
   refresh writes (no refresh protocol available — the entry's `refresh`/
   `expires` fields are ignored).

## Non-goals

- Monthly *spend* window (the API exposes no monthly used figure — caps only)
- Credit *purchase* history, invoices, or below-threshold notifications
- Token refresh / curl fallback (keyed API; 401/403 → auth-needed, done)
- Account login UI inside the plasmoid

## Decisions

| Topic | Choice |
|---|---|
| Provider id / name | `commandcode` / "CommandCode" |
| Auth sources | `auth.json` `commandcode` first, then `COMMANDCODE_API_KEY` env |
| Accepted entry shapes | `{type:"oauth", access}` (pi-written, observed) and `{type:"api_key", key}` → both yield the key; `refresh`/`expires` ignored |
| Endpoint (required) | `GET https://api.commandcode.ai/alpha/billing/credits`, `Authorization: Bearer <key>` |
| Endpoint (optional) | `GET https://api.commandcode.ai/alpha/billing/subscriptions` — plan name; failure never fails the provider |
| Windows | `fiveHour` (label "5h", required), `weekly` ("Weekly", optional — only when used+cap both present) |
| Percent source | `used/cap * 100`, **clamped to 100** (contract rejects >100); true `used`/`limit` counts are kept on the window |
| Primary (compact) | five-hour window `usedPercent` |
| Details (`details.commandcode`) | `monthlyCredits`, `purchasedCredits`, `freeCredits` (non-negative finite numbers; caps, not spend), `planName` (bounded text via closed map only), `exceeded`, `weeklyExceeded` (optional booleans from `windowLimits`) |
| API risk | `/alpha/*` surface the Studio web app uses — unofficial, may change; surface `error`/`auth-needed`, never fabricate |

Canonical order after addition: `claude`, `codex`, `grok`, `kimi`, `cursor`,
`opencode`, `commandcode`.

## §1 Auth (`collector/src/providers/commandcode/auth.ts`)

- Read `~/.pi/agent/auth.json` via the existing safe no-follow JSON reader.
- Precedence: entry `commandcode` → env `COMMANDCODE_API_KEY` (env only when
  no usable file entry, matching Grok/Kimi).
- Accepted shapes (value never echoed): type `oauth` with non-empty string
  `access`; type `api_key` with non-empty string `key`. Anything else →
  unsupported/malformed → `auth-needed`.
- Outcomes like Kimi: `available` / `auth-needed` / `error` (file read
  classes). Injected path/reader/env for tests; no network.

## §2 Fetch + normalize (`fetch.ts`, `usage.ts`, `adapter.ts`)

- **Credits** (required): one bounded `GET`; timeout/abort/byte-cap consistent
  with Grok/Kimi; manual redirect handling.
- HTTP mapping: 401/403 → `auth-needed` (cancel unread body); 3xx manual
  redirect → `auth-needed`; timeout/network/5xx/oversize → `error`; 2xx →
  parse (table in recon doc).
- Parser (`usage.ts`):
  - Requires `credits` object and `windowLimits.fiveHour` with finite
    `used` + `cap` (≥ 0; cap > 0 for percent). `resetAt` epoch-ms → UTC ISO.
  - Weekly window: include only when both `used` and `cap` are finite; ignore
    otherwise.
  - `usedPercent = min(100, used / cap * 100)`; `used` and `limit = cap` stay
    on the window (non-negative counts; `used > limit` allowed when exceeded).
  - `details.commandcode`: credits counts when finite ≥ 0 (omit otherwise);
    `exceeded` from `windowLimits.exceeded` / `fiveHour.exceeded`; `weeklyExceeded`
    from `windowLimits.weekly.exceeded` when weekly is present; `planName` only
    from the closed map (see recon).
  - No recognized data → malformed / `error` (never a dataless `ok`).
- **Subscriptions** (optional, after a successful credits parse): one bounded
  `GET`, parse `data.planId`, map through closed plan-name map; any failure
  (network, parse, unknown plan) is ignored — keep the credits record.
- Adapter: auth → credits fetch → optional subscriptions fetch → normalized
  result with id `commandcode`.

## §3 Contract, UI, security

**Contract (schema v2, additive):**
- `PROVIDER_IDS` += `"commandcode"` (after `opencode`).
- `CommandCodeDetails` / `CommandCodeProviderRecord` in the discriminated
  union; runtime validation (TS + QML validator mirror) with the field rules
  above; correlated namespace enforcement.
- Minimal fixtures + artifact-check provider count updates (7 total).

**Collector wiring:** register adapter; default-enable; CLI `enabledProviders`
accepts `commandcode`; LKG cache treats it like any provider.

**Plasma:** `KNOWN_PROVIDERS`, defaults, config schema keys, compact/full
models (windows → primary-percent rule; full view facts from the closed
`details.commandcode` allowlist — plan name, credits, exceeded flags),
command allowlist, `main.xml`. No new QML files expected.

## Architecture sketch

```text
auth.json["commandcode"] / COMMANDCODE_API_KEY ──┐
                                                 ▼
                  GET /alpha/billing/credits ──► normalize (windows + details)
                                                 │
                   GET /alpha/billing/subscriptions (optional, planName only)
                                                 │
                                                 ▼
                      validateCollectorDocument (schema v2)
                                                 │
                                                 ▼
                            Plasma compact/full models
```

## Implementation order

1. Recon gate (live, single bounded call with the real key): confirm credits
   shape + plan mapping; record outcome privately, no secrets in notes.
2. Contract + dual validators + fixtures (RED→GREEN)
3. Auth module test-first (shapes, precedence, value-free outcomes)
4. Fetch + usage (+ optional subscriptions) + adapter + registry
5. Plasma config/UI/models/command + QML validator mirror
6. Docs / CHANGELOG / README / AGENTS providers table
7. Full gate under synthetic HOME; user-visible smoke with real key

## Open questions

None for product shape. Recon gate (step 1) must confirm whether the credits
counts are integers (they appeared so on the GOAT account) — the contract
accepts non-negative finite numbers either way, so this only affects fixture
detail.
