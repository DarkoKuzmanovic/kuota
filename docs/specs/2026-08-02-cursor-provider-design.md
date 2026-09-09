# Cursor Provider — Design

**Date:** 2026-08-02  
**Status:** Approved for implementation planning  
**Owner decisions:** Individual Pro/Ultra dashboard usage (A); local Cursor session first with `CURSOR_SESSION_TOKEN` override (C); compact primary = included plan percent (A); no token persistence / no `auth.json` (A); approach = thin unofficial adapter on `GET /api/usage-summary` (1).

## Problem

Kuota shows Claude, Codex, Grok, and Kimi usage from authoritative provider APIs. Cursor’s spending/usage UI at `https://cursor.com/dashboard/spending` is useful on the same desktop, but Cursor does not publish a stable individual usage API. Enterprise Admin API covers teams only. Community tools reach the same numbers via undocumented dashboard endpoints authenticated with the Cursor web/app session.

## Goals

1. Add a fifth provider, `cursor`, that surfaces **included plan usage** as the compact primary metric.
2. Discover credentials without user friction when Cursor is signed in locally, with an env override for manual sessions.
3. Keep Kuota’s security boundary: secret-free JSON to QML; never persist the Cursor session token; never write `~/.pi/agent/auth.json` for Cursor.
4. Record an explicit scope amendment: a new provider that depends on an **unofficial** dashboard API.

## Non-goals

- Cursor Enterprise Admin API / team spend dashboards
- Paginated usage-event history or CSV export
- On-demand spend as the compact primary metric
- Persisting session tokens under `~/.config/kuota/` or `auth.json`
- Account login UI inside the plasmoid
- Adding npm **runtime** dependencies for SQLite

## Decisions

| Topic | Choice |
|---|---|
| Audience | Individual dashboard usage (not Enterprise Admin API) |
| Auth sources | Local Cursor state first, then `CURSOR_SESSION_TOKEN` |
| Compact primary | Included plan `totalPercentUsed` (dashboard spend share) |
| Token storage | Never persist; env is override-only; local read is in-process |
| Approach | One bounded `GET /api/usage-summary` adapter |

Canonical order after addition: `claude`, `codex`, `grok`, `kimi`, `cursor`.

## §1 Auth discovery

**Supersession:** The approved [2026-09-08 review P1 amendment](2026-09-08-review-p1-fixes-design.md)
replaces the immutable-reader choice below with WAL-aware `-readonly` SQLite
access and bounded, cancellable child ownership (2 seconds, 64 KiB per stream).
DB/WAL contents remain read-only; SQLite sidecar/read-lock coordination is
allowed. Ordinary local failures retain env fallback; cancellation/resource
limits stop further discovery and fetch. The original wording below is historical.

**Module:** `collector/src/providers/cursor/auth.ts`

**Precedence (first usable wins):**

1. **Local Cursor state (Linux primary):** read-only open of  
   `~/.config/Cursor/User/globalStorage/state.vscdb`  
   Query `ItemTable` for key `cursorAuth/accessToken`. Also try `~/.config/cursor/...` as a candidate. Optional keyring probing only if live recon proves it holds the same session shape; not required for V1 of this provider.
2. **Environment:** non-empty `CURSOR_SESSION_TOKEN`.

**SQLite access:** prefer the system `sqlite3` CLI with a read-only/immutable URI so Kuota stays free of runtime npm deps. If `sqlite3` is missing or the DB cannot be read, local discovery fails closed and the env override remains available. Missing/locked/malformed local state without a usable env token → `auth-needed`.

**Rules:**

- Injected paths/readers/env in tests; no network in the auth module.
- Never write the token (no Kuota cache, no auth.json, no settings, no command args).
- Classifications are value-free: `ok` | `auth-needed` | `error`. Diagnostics go through `redact()`.
- **Recon gate before implementation GREEN:** confirm live whether `accessToken` alone works as `Cookie: WorkosCursorSessionToken=…`, or must be shaped as `sub::jwt` / URL-encoded form. Document the accepted env shapes in the adapter and README troubleshooting.

## §2 Fetch + normalize

**Modules:** `collector/src/providers/cursor/fetch.ts`, `usage.ts`, `adapter.ts`

**Transport:** one bounded request:

- `GET https://cursor.com/api/usage-summary`
- Header `Cookie: WorkosCursorSessionToken=<token>` (exact shaping from recon)
- Timeout/abort consistent with Grok/Kimi; no curl fallback; no token refresh

**HTTP mapping:**

| Outcome | Provider state |
|---|---|
| 401 / 403 | `auth-needed` |
| timeout / network / 5xx / oversize / invalid JSON | `error` |
| 2xx | parse |

**Normalization:**

- Primary window: `id: "plan"`, label `"Plan"`, from `individualUsage.plan`:
  - `usedPercent` = `totalPercentUsed` when a finite number in `0..100` (dashboard spend share — same family as the Spending page bars)
  - `resetAt` = `billingCycleEnd` when a valid UTC ISO timestamp
  - Do **not** put request-count `used`/`limit` on this window (those are a different unit and disagree with the dashboard percent)
- If `totalPercentUsed` is absent: omit the plan window; do not invent a percent from request counts
- If a 2xx body recognizes nothing usable → fail as malformed / `error` (never a dataless `ok`)

**Optional `details.cursor` (omit when unavailable):**

- `membershipType` (bounded safe text)
- `onDemandUsed` / `onDemandLimit` in a single documented unit (prefer integer **cents**; recon confirms wire units)
- `autoPercentUsed` / `apiPercentUsed` / `totalPercentUsed` when finite numbers in `0..100` (or scaled consistently after recon)

## §3 Contract, UI, security

**Contract (schema v2, additive — no version bump):**

- Extend `PROVIDER_IDS` with `"cursor"`
- Add `CursorDetails` / `CursorProviderRecord` and correlated runtime validation (TS + QML)
- Update fixtures, artifact check, and docs

**Collector wiring:**

- Register the adapter; default-enable `cursor` like other providers
- CLI/`enabledProviders` accept `cursor`
- LKG cache treats `cursor` like any other provider (usage only; never credentials)

**Plasma:**

- Add to `KNOWN_PROVIDERS`, defaults, visibility, theming, compact/full models, command allowlist, `main.xml`
- Compact primary = plan window `usedPercent` from `totalPercentUsed`
- Full view: closed allowlist facts from `details.cursor` only; countdown from `resetAt` in QML

**Security / product risk:**

- Unofficial dashboard API: breakage is expected risk; surface `error` / `auth-needed`, never fabricate quotas
- Session token treated as a credential-class secret end-to-end
- Explicit owner-approved scope change: fifth provider + unofficial Cursor surface (amends prior “no further providers” freeze for this addition only)

## Architecture sketch

```text
CURSOR_SESSION_TOKEN? ──┐
                        ├─→ session token (memory only)
state.vscdb accessToken─┘
                        │
                        ▼
              GET /api/usage-summary
                        │
                        ▼
         normalize → ProviderRecord id=cursor
                        │
                        ▼
              validateCollectorDocument (v2)
                        │
                        ▼
                   Plasma models
```

## Implementation order (planning hint)

1. Live recon: cookie shape + `usage-summary` field units against a real signed-in session (synthetic HOME still used for automated tests)
2. Contract + dual validators + fixtures (RED→GREEN)
3. Auth module (local sqlite3 + env) test-first
4. Fetch + usage + adapter + registry
5. Plasma config/UI/models/command
6. Docs / CHANGELOG / README troubleshooting / AGENTS providers table
7. Full gate under synthetic HOME

## Open questions

None for product shape. Implementation still requires the **recon gate** on cookie shaping and on-demand unit (cents vs dollars) before locking parser fixtures.
