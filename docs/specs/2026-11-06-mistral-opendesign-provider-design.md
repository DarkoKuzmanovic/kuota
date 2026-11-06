# Mistral + OpenDesign providers (browser-session) — design

Status: **approved** 2026-11-06 by the owner in a Hermes TUI session (clarify form; every
recommended option chosen). Milestone: PLAN.md *Milestone 18*. Release: 2.1.0 after the
owner's live panel check.

## Problem

Neither provider exposes usage to an API key. Both serve it to the signed-in web session:

| Provider | Endpoint(s) (GET, JSON) | Session cookie |
|---|---|---|
| Mistral | `https://admin.mistral.ai/api/billing/v2/budget` | `ory_session_*` on `.mistral.ai` (and `admin.`/`console.`/`chat.mistral.ai`) |
| OpenDesign | `https://amr-api.open-design.ai/api/v1/workspaces/current` → `activeWorkspaceId`; then `/api/v1/workspaces/{id}/billing/coding-plan-usage` and `/api/v1/workspaces/{id}/wallet/balance` (header `x-vela-workspace-id`) | `__Secure-better-auth.session_token` on `amr-api.open-design.ai` |

Shape recon 2026-11-06 (key/type only, live 200s on the owner's account):

- Mistral: `{vibe_budget:{usage_percentage:float, initial_budget:float, currency:str, reset_at:ISO, payg_enabled:bool}, api_budget:{same}, …}`. Source: pi-hud `providers/mistral.ts` (live-verified 2026-11-04).
- OpenDesign usage: `{workspaceId, generatedAt, eligible:bool, tier:str, windows:[{policyId, durationSeconds:int, resetMode, usedCredits:"int", limitCredits:"int", remainingCredits:"int", windowStart, resetsAt}]}`; observed durations 18000 (5h) and 604800 (week). Wallet: `{balanceUsd:"decimal", expiresAt, updatedAt, billingScopeVersion, workspaceId, workspaceMemberId}`. Source: `dsh-cost-meter` docs (endpoint discovery) + this probe. This replaces the 2026-10-11 deferral (no desktop app or control key needed).

## Decisions

| # | Decision |
|---|---|
| D1 | Credential: read the session cookie from Firefox automatically. Pick the profile whose `cookies.sqlite` is newest under `~/.mozilla/firefox/*/`; copy it (+ `-wal`) into a fresh `mkdtemp` dir (0700), query only that provider's cookie names with the existing bounded `/usr/bin/sqlite3` runner, delete the copy in `finally`. Firefox holds an exclusive lock, so the live DB cannot be read in place. Fallback env: `MISTRAL_SESSION_COOKIE` / `OPENDESIGN_COOKIE` (full `Cookie` header value). Never persisted, never refreshed. |
| D2 | Mistral windows: `vibe` ("Vibe Code", primary) and `api` ("API"), each `usedPercent` + `resetAt`. Window selector catalog `["vibe","api"]`. `details.mistral`: `vibeBudget`, `apiBudget`, `currency`, `paygEnabled`. |
| D3 | OpenDesign windows: `5h` (primary) and `weekly`, keyed by `durationSeconds` (other durations skipped), `used`/`limit` credits + `usedPercent` + `resetAt`. Selector catalog `["5h","weekly"]`. `details.opendesign`: `tier`, `walletBalanceUsd`. Wallet failure does not fail the record. |
| D4 | Both providers are **off by default**: `<id>Visible` defaults `false`, and the collector's no-flag default excludes them. |
| D5 | No cache/backoff beyond the common collector path; one bounded request per endpoint, no retries. 401/403/3xx (Mistral redirects to `auth.mistral.ai`) → `auth-needed`. |

## Shape

- Contract: `PROVIDER_IDS` appends `mistral`, `opendesign` (TS + QML catalog + validators).
- Collector: shared `providers/firefox-cookies.ts` (copy + query + cleanup) and
  `providers/session-fetch.ts` (one bounded cookie GET, the Cursor fetch body made generic);
  per provider `mistral/{auth,usage,adapter}.ts`, `opendesign/{auth,usage,adapter}.ts`.
- Plasma: catalog labels/windows, visibility/window/accent/icon keys in `main.xml`,
  config-model defaults (visible false), settings rows, full-view facts.

## Failure behavior

No Firefox profile / no cookie and no env → `auth-needed`. `sqlite3` missing → `error`.
Expired session → `auth-needed`. Body without any recognized window → `error`
(`malformed-response`), never an empty ok record.

## Acceptance

Unit + bridge tests per provider (real-shaped fixtures), cookie reader test against a
synthetic Firefox-shaped DB that proves cleanup, default-off tests for widget and collector,
full gate set, and a real-session smoke with `--enabled-providers=mistral,opendesign`.
