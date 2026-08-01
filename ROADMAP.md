# Kuota Roadmap

Status: active

Kuota is a standalone KDE Plasma 6 widget that reports authoritative Claude,
Codex, Grok, and Kimi account usage on the desktop. Releases are discrete; this file
holds one-line version goals only. Tactical execution state lives in `PLAN.md`.
A roadmap entry is a candidate, not authorization — starting a Planned version
still requires the normal spec → grill → scope checkpoint → confirmation flow.

## Released

- **1.0.0** (product label "V1") — shipped locally 2026-07-18 (merged to main;
  not yet published). Approved 3-provider V1 (Claude, Umans, Codex; Umans
  removed 2026-08-02): Plasma 6 widget, bundled short-lived Node collector,
  compact + full representations, configuration layer, local install/update/uninstall
  scripts. KDE Store publication is a separate explicitly approved step, not part
  of this version.

## Current

(none — 1.0.0 shipped; see Released)

## Planned

- **1.1.0** — Add Grok + Kimi providers. Amends owner-approved Decision #2 (which
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

- **1.2.0** — Appearance customization (KVitals-style). Per-provider icons
  (freedesktop name, KDE picker, `isMask` monochrome), font family override
  (Plasma default otherwise, orthogonal to existing V1 `fontScale`), colors
  (opt-in global custom text color + per-provider accent), and opacity (label +
  separator, independently). All new keys default to reproducing 1.0.0 output
  so upgrade is a visual no-op unless the user opts in. Pure Plasma-UI concern —
  no collector, bridge, credential, or provider-data changes. Spec:
  `docs/specs/2026-07-22-theming-customization-design.md`. Planned after 1.1.0 so
  per-provider accent/icon covers all providers present at ship time; provider-list-
  agnostic if sequencing changes.
