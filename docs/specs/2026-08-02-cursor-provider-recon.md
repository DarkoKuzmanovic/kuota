# Cursor usage-summary recon

**Date:** 2026-08-02  
**Machine:** Linux, Node v26.5.1, sqlite3 3.53.4  
**Source DB:** `~/.config/Cursor/User/globalStorage/state.vscdb` key `cursorAuth/accessToken`  
**Endpoint:** `GET https://cursor.com/api/usage-summary`

## Cookie shaping (no secrets recorded)

| Cookie value shape | HTTP |
|---|---|
| Raw `accessToken` JWT alone | **401** `not_authenticated` |
| `{jwt.sub}::{accessToken}` | **200** |
| `encodeURIComponent("{jwt.sub}::{accessToken}")` | **200** |

**Kuota must send:**  
`Cookie: WorkosCursorSessionToken=<sub>::<jwt>`  
where `<jwt>` is the `cursorAuth/accessToken` value and `<sub>` is the JWT payload `sub` claim.

`CURSOR_SESSION_TOKEN` may be either:

1. Already-shaped `sub::jwt` (or URL-encoded equivalent — decode before use), or  
2. Raw JWT — adapter derives `sub` from the payload and shapes `sub::jwt`.

Never log or commit the token.

## Wire field units (200 body, redacted)

Top-level keys observed: `billingCycleStart`, `billingCycleEnd`, `membershipType`, `limitType`, `isUnlimited`, `autoModelSelectedDisplayMessage`, `namedModelSelectedDisplayMessage`, `individualUsage`, `teamUsage`.

Observed (values illustrative of **types/units**, not a live dump to retain):

- `membershipType`: string (e.g. `"pro"`)
- `billingCycleStart` / `billingCycleEnd`: UTC ISO 8601 with millis
- `individualUsage.plan.enabled`: boolean
- `individualUsage.plan.used` / `.limit` / `.remaining`: **non-negative numbers (request/allowance counts, not cents)** — e.g. used 918, limit 2000 → compact percent ≈ 45.9%
- `individualUsage.plan.autoPercentUsed` / `apiPercentUsed` / `totalPercentUsed`: floats (already percent-like)
- `individualUsage.plan.breakdown.included|bonus|total`: numbers (same unit as used)
- `individualUsage.onDemand.enabled`: boolean
- `individualUsage.onDemand.used`: number (**treat as cents** when enabled; observed `0` when disabled)
- `individualUsage.onDemand.limit` / `.remaining`: number or `null`

## Parser implications

- Primary window: `used`/`limit` from `plan`; `usedPercent = (used/limit)*100` when `limit > 0`
- `resetAt` = `billingCycleEnd`
- `details.cursor.onDemandUsed` / `onDemandLimit`: integer cents when present/enabled
- Display messages are provider marketing strings — **do not** put in contract details (avoid leaking free-form status into facts); membershipType is enough
