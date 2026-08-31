# OpenCode + CommandCode recon

**Date:** 2026-09-01
**Sources:** pi-hud `commandcode.ts` (live-verified 2026-08-12, GOAT-plan account); opencode-quota plugin source (`slkiser/opencode-quota`, shipped tool, `opencode-go.ts` / `lib/opencode-go.ts` / `lib/opencode-go-auth.ts`); local `~/.pi/agent/auth.json` entry shapes (field names/types only).

## CommandCode (`commandcode`)

**Auth (shared `~/.pi/agent/auth.json`):** entry `auth.commandcode` — pi writes
`{ type: "oauth", access, refresh?, expires? }` where `access` is the API key
(`user_...`). Env fallback (pi-hud): `COMMANDCODE_API_KEY`.

**Provider id:** `commandcode` (display "CommandCode").

**Endpoints (verified live 2026-08-12 against a GOAT-plan account):**

| Endpoint | Purpose |
|---|---|
| `GET https://api.commandcode.ai/alpha/billing/credits` | Usage (required) |
| `GET https://api.commandcode.ai/alpha/billing/subscriptions` | Plan name (optional nicety) |

Auth header: `Authorization: Bearer <access>`, `Accept: application/json`.

**Credits body (field types, not a live dump):**
```jsonc
{
  "credits": { "monthlyCredits": number, "purchasedCredits": number,
               "freeCredits": number, "belowThreshold": bool,
               "creditThreshold": number },
  "windowLimits": { "limited": bool, "exceeded": bool,
                    "fiveHour": { "used": number, "cap": number,
                                  "exceeded": bool, "resetAt": epochMs },
                    "weekly":   { "used": number, "cap": number,
                                  "exceeded": bool, "resetAt": epochMs } }
}
```

- `fiveHour` is **required** by pi-hud (both `used` and `cap` must be finite numbers).
- `weekly` is **optional** (pi-hud includes it only when both halves are present).
- `resetAt` values are **epoch milliseconds** → normalize to UTC ISO 8601.
- `credits.monthlyCredits` etc. are **caps, not spend** — the API exposes no
  monthly *used* figure, so no monthly usage window is possible. Counts are
  non-negative; units are credit counts, not currency amounts.
- Plan name comes from `subscriptions` → `data.planId` mapped through a closed
  map: `individual-go` → Go, `individual-goat` → GOAT, `individual-pro` → Pro,
  `individual-max10x` → Max10x. Unknown plan ids are dropped, never echoed.

## OpenCode Go (`opencode`)

**Auth (shared `~/.pi/agent/auth.json`):** entry `auth["opencode-go"]` — the
OpenCode CLI shape `{ type: "api", key }` (observed locally; opencode-quota
also accepts it). Alias `opencode` accepted for manual setups. Env fallback
(opencode-quota): `OPENCODE_API_KEY`. OpenCode's own local auth may live in
`~/.local/share/opencode/auth.json` or its SQLite DB — **out of scope**: the
shared auth.json entry is the Kuota source (same pattern as Grok/Kimi).

**Provider id:** `opencode` (display "OpenCode"; scope = the hosted **OpenCode
Go** subscription, `opencode.ai/go`).

**Endpoint (from opencode-quota source; used by the OpenCode CLI itself):**
`GET https://opencode.ai/zen/go/v1/usage` with
`Authorization: Bearer <key>`, `Accept: application/json`.

**Body (contract enforced by opencode-quota's parser):**
```jsonc
{
  "usage": {
    "rolling": { "status": "ok", "percent": 0..100, "resetsAt": "ISO-8601 w/ offset" },
    "weekly":  { "status": "ok", "percent": 0..100, "resetsAt": "ISO-8601 w/ offset" },
    "monthly": { "status": "ok", "percent": 0..100, "resetsAt": "ISO-8601 w/ offset" }
  }
}
```

- All three windows are required and must carry `status: "ok"`, `percent` a
  finite number in `0..100` (the used share — Kuota's `usedPercent` directly),
  and `resetsAt` a valid offset-qualified ISO timestamp (Z or ±hh:mm; convert
  to UTC ISO 8601 for the contract).
- **No used/limit counts on the wire** — windows carry percent + reset only.
- Nothing else usable on the wire → no `details.opencode` namespace is
  defined; the record has windows only.
- The rolling window is the ~5-hour rate-limit window (label "5h", matching
  CommandCode's five-hour window family). Go limits are dollar-value based.

## HTTP mapping (both providers)

| Outcome | Provider state |
|---|---|
| 401 / 403 | `auth-needed` |
| timeout / network / 5xx / oversize / invalid JSON / unrecognized shape | `error` |
| 2xx recognized | parse → `ok` |

Echo-style behavior: never retry, never refresh, never fall back to curl —
these are keyed API providers, not session flows.

## Provider table rows (for AGENTS.md / README)

| Provider | Source | Auth |
|---|---|---|
| OpenCode | `opencode.ai/zen/go/v1/usage` (internal; used by the OpenCode CLI) | `auth["opencode-go"]` (type `api`/`key`, alias `opencode`) or `OPENCODE_API_KEY` |
| CommandCode | `api.commandcode.ai/alpha/billing/credits` (+ optional `subscriptions`) | `auth.commandcode` (oauth `access` = API key) or `COMMANDCODE_API_KEY` |
