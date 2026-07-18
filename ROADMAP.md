# Kuota Roadmap

Status: active

Kuota is a standalone KDE Plasma 6 widget that reports authoritative Claude,
Umans, and Codex account usage on the desktop. Releases are discrete; this file
holds one-line version goals only. Tactical execution state lives in `PLAN.md`.
A roadmap entry is a candidate, not authorization — starting a Planned version
still requires the normal spec → grill → scope checkpoint → confirmation flow.

## Released

(none yet)

## Current

- **v1.0.0** — Approved 3-provider V1 (Claude, Umans, Codex): Plasma 6 widget,
  bundled short-lived Node collector, compact + full representations,
  configuration layer. Milestones M1–M9 PASS (G0–G9). M10 (packaging, local
  lifecycle, release candidate) pending. KDE Store publication is a separate
  explicitly approved step, not part of this version.

## Planned

- **v1.1** — Add Grok + Kimi providers. Amends owner-approved Decision #2 (which
  froze V1 at Claude/Umans/Codex); re-opens the design spec provider table, the
  collector contract `ProviderId` union and `details.{grok,kimi}` namespaces,
  registry canonical order, QML compact/full model allowlists, config UI, and
  docs. Recon complete (pi-hud, live-verified 2026-07-17): Kimi via
  `auth["kimi-coding"]` / `KIMI_API_KEY` → `api.kimi.com/coding/v1/usages`
  (Bearer token, weekly + short windows + concurrency; numeric fields arrive as
  strings); Grok via `auth.xai`/`xai-auth`/`grok-cli` / `GROK_CLI_OAUTH_TOKEN`
  → `cli-chat-proxy.grok.com/v1/billing` (Bearer + `x-xai-token-auth:
  xai-grok-cli` header; monthly credits required, optional weekly window).
  Reuse endpoint/credential-discovery facts only — route through Kuota's own
  hardened `collector/src/io/` + `security/redact.ts`; do not copy pi-hud's
  looser `Record<string, any>` / direct-readwrite access patterns.
