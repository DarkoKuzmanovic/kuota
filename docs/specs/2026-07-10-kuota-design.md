# Kuota Design

**Date:** 2026-07-10<br>
**Status:** Approved for implementation<br>
**Approved by:** Project owner, 2026-07-10

## Purpose

Kuota is a KDE Plasma 6 widget that keeps Claude, Codex, Grok, and Kimi account usage visible without requiring a running Pi session.

It combines two interaction patterns:

- a compact, configurable panel line similar to KVitals;
- a detailed popup and desktop view inspired by CodexBar's provider switcher, usage bars, reset countdowns, and provider-specific details.

Kuota reports authoritative provider data already used by Pi-Pixoo and pi-hud. It does not estimate account quota from local activity.

## Product decisions

The requirements grill resolved these decisions:

1. Kuota reuses the proven provider sources and behavior from Pi-Pixoo/pi-hud.
2. Kuota refreshes independently and remains useful when Pi is not running.
3. The panel uses a KVitals-style horizontal summary.
4. The popup and desktop placement use a richer CodexBar-inspired view.
5. Kuota displays every genuine field available from a provider source.
6. Missing fields are omitted rather than estimated or filled with `N/A`.
7. The first release supported Claude, Umans, and Codex (Umans removed 2026-08-02; current scope is Claude, Codex, Grok, and Kimi — see [`2026-08-02-remove-umans-provider-design.md`](2026-08-02-remove-umans-provider-design.md)).
8. The implementation is a QML plasmoid plus a short-lived collector program, not a permanent service or compiled C++ plugin.

## User experience

### Compact panel representation

The panel representation is one horizontal line containing enabled provider entries.

Users can:

- show or hide each provider;
- reorder providers;
- choose icons, text, or icons plus text;
- control labels, separators, and font sizing;
- configure caution and critical colors.

The default order is Claude, Codex, Grok, Kimi. Each entry shows the provider's most useful current limit in a compact form. The exact compact value is adapter-defined because the providers expose different quota shapes.

Clicking the compact representation opens the full representation.

### Full popup and desktop representation

The same full representation is used for the panel popup and desktop placement. It adapts to available width and height.

The top area contains a provider switcher for Claude, Codex, Grok, and Kimi. The selected provider view contains:

- provider name and state;
- last-successful update time;
- one row per genuine usage window;
- a progress bar where a percentage or count limit exists;
- used and remaining values where derivable from authoritative data;
- reset time and live countdown where supplied;
- provider-specific facts such as request counts, concurrency, plan data, credits, cost, or token totals when the source genuinely returns them;
- a manual Refresh action;
- a concise login-needed, stale-data, or error state when applicable.

Unavailable provider-specific fields are omitted. Kuota never manufactures equivalent-looking data merely to keep cards symmetrical.

### Visual direction

Kuota follows Plasma theme colors, spacing, typography, focus behavior, and accessibility conventions. Provider identity colors may be used as accents, but text and progress states must remain legible in light and dark themes.

The CodexBar image is inspiration for information hierarchy, not a pixel-for-pixel copy. Kuota should feel native to Plasma.

## Architecture

### Package structure

Kuota is one Plasma 6 widget package with three internal layers:

1. **Plasma UI** — QML compact view, full view, reusable controls, and configuration pages.
2. **Collector bridge** — a small isolated QML boundary that invokes the collector and parses its JSON response.
3. **Collector** — a bundled Node-based command that reads provider credentials, fetches usage, maintains safe caches, and emits one normalized JSON document.

Plasma 6's `Plasmoid.compactRepresentation` and `Plasmoid.fullRepresentation` provide the two widget faces. The initial collector bridge may use Plasma's executable data source through `org.kde.plasma.plasma5support`; that dependency must be isolated because DataEngine APIs are compatibility surface in Plasma 6 and may need replacement later.

### Refresh lifecycle

1. A QML timer determines that data is due for refresh, or the user presses Refresh.
2. The bridge starts one collector process if no collection is already in flight.
3. The collector reads credentials internally and fetches enabled providers concurrently with bounded timeouts.
4. Each provider adapter returns normalized common fields plus optional provider-specific fields.
5. The collector atomically writes a last-known-good cache and prints JSON to standard output.
6. QML validates the response shape and updates the display.
7. On collection failure, QML retains the last successful snapshot and marks it stale.

No credential or token is passed through command-line arguments, QML properties, widget settings, stdout, stderr, or logs.

### Normalized collector contract

The collector output contains:

- schema version;
- collection start/end timestamps;
- one record per configured provider;
- provider identity and state (`ok`, `stale`, `auth-needed`, or `error`);
- last-successful update timestamp;
- common usage windows with optional percentage, used count, limit count, and reset timestamp;
- optional provider-specific details;
- safe, user-facing status text with no secrets.

The contract is versioned so UI and collector changes can fail clearly rather than silently misrendering data.

## Provider behavior

### Claude

Source: `https://api.anthropic.com/api/oauth/usage`. Credentials come from Claude Code's `~/.claude/.credentials.json` `claudeAiOauth` entry first, then the Anthropic OAuth entry in `~/.pi/agent/auth.json`. Both are read-only and never refreshed. The first locally valid credential wins; a server rejection of it does not retry with the other source. This source order was updated with owner approval on 2026-09-25 (PLAN M16); previously only the Pi entry was read.

Known data includes short and weekly utilization windows and their reset timestamps, plus any model-specific windows genuinely returned by the current response.

Claude's endpoint is aggressively rate-limited. Kuota therefore:

- maintains its own last-known-good cache (the earlier plan to read pi-hud's private cache was dropped in PLAN M2.2);
- performs an independent live fetch when no fresh cache exists;
- honors `Retry-After` and a minimum backoff after HTTP 429;
- retains stale values during temporary failures.

This preserves independent operation without needlessly hammering the endpoint.

### Codex

Source: `https://chatgpt.com/backend-api/wham/usage` using the existing `openai-codex` OAuth entry and account ID in `~/.pi/agent/auth.json`. This path was updated with owner approval on 2026-07-12 after current OpenAI Codex backend-client source superseded the earlier `/backend-api/codex/usage` design assumption.

Known data includes primary and secondary quota windows, percentages, reset timestamps, and any genuine plan or credit fields returned by the endpoint.

Kuota preserves the proven fallback behavior:

- use normal HTTP first;
- use curl through stdin configuration when Cloudflare rejects Node's TLS fingerprint;
- never place tokens in process arguments;
- refresh an expired OAuth token once;
- update auth state with a latest-read, atomic, permission-preserving write rather than a blind overwrite.

### Umans (removed 2026-08-02)

Umans was a V1 provider (rolling-window requests, optional limits, concurrency). It was removed end-to-end per [`2026-08-02-remove-umans-provider-design.md`](2026-08-02-remove-umans-provider-design.md). Historical source: `https://api.code.umans.ai/v1/usage` using the Umans OAuth token or API key in `~/.pi/agent/auth.json`.

### Grok

Source: `https://cli-chat-proxy.grok.com/v1/billing` using the existing xAI OAuth entry in `~/.pi/agent/auth.json` (`auth.xai`, `auth["xai-auth"]`, `auth["grok-cli"]`, or `GROK_CLI_OAUTH_TOKEN` fallback). The request carries a Bearer token and the `x-xai-token-auth: xai-grok-cli` header.

Known data includes monthly credits required for use and an optional weekly window.

Kuota routes Grok through its own hardened `collector/src/io/` fetch and `security/redact.ts` paths. Recon facts are reused from pi-hud (live-verified 2026-07-17); Kuota does not copy pi-hud's looser `Record<string, any>` / direct-readwrite access patterns. No credential persistence is performed for Grok in 1.1.0.

### Kimi

Source: `https://api.kimi.com/coding/v1/usages` using the existing Kimi coding OAuth entry in `~/.pi/agent/auth.json` (`auth["kimi-coding"]`, or `KIMI_API_KEY` fallback). The request carries a Bearer token.

Known data includes weekly and short usage windows plus concurrency; numeric fields arrive as strings and are normalized to numbers.

Kuota routes Kimi through the same hardened collector fetch and redaction paths as Grok. No credential persistence is performed for Kimi in 1.1.0.

### Cursor

Source: `https://cursor.com/api/usage-summary` (unofficial dashboard endpoint, not a published individual API). Auth reads the local Cursor `state.vscdb` (`cursorAuth/accessToken`) via system `sqlite3`, or `CURSOR_SESSION_TOKEN` when local discovery fails. Kuota never writes `auth.json` and never persists the session token.

Known data includes included-plan usage (`individualUsage.plan`), billing-cycle reset, membership type, optional on-demand spend (cents), and optional auto/API/total percent fields. The compact primary window is `plan` percent.

Breakage of the unofficial endpoint surfaces as `auth-needed` or `error`; Kuota does not fabricate quotas. See `docs/specs/2026-08-02-cursor-provider-design.md` and `docs/specs/2026-08-02-cursor-provider-recon.md`.

### 1.1.0 provider amendment

Grok and Kimi are added in 1.1.0, amending owner-approved Decision #2 (which froze V1 at Claude/Umans/Codex). This re-opens the design spec provider table, the collector contract `ProviderId` union and `details.{grok,kimi}` namespaces, the registry canonical order, the QML compact/full model allowlists, the config UI, and the docs. Recon is complete (pi-hud, live-verified 2026-07-17); implementation follows the normal spec → grill → scope checkpoint → confirmation flow. Both adapters follow the existing adapter patterns (auth discovery → one bounded fetch → normalization → registry), with no curl fallback or token refresh in 1.1.0 unless recon reveals it is required.

## Credential and file safety

Kuota treats `~/.pi/agent/auth.json` as sensitive shared state.

- Reads are local and never copied into project or widget caches.
- Cache files contain usage results only, never credentials.
- Cache and temporary writes use restrictive permissions.
- Codex token persistence preserves unrelated auth entries and existing file permissions.
- Writes are atomic and designed to avoid truncating the shared file.
- Logs and test fixtures redact authorization headers, tokens, refresh tokens, and account identifiers.
- The widget does not provide login or account-management controls in v1.

## Configuration

The first release exposes:

- refresh interval;
- enabled providers and their order;
- compact display mode: icons, text, or icons plus text;
- per-provider compact metric choice where more than one meaningful value exists;
- labels and separator;
- font sizing;
- caution and critical thresholds/colors;
- optional reset countdown visibility.

Defaults should be useful without configuration and conservative about provider rate limits.

> **1.2.0 amendment** — appearance customization (per-provider icons, font family, colors, opacity) is specified in [`docs/specs/2026-07-22-theming-customization-design.md`](2026-07-22-theming-customization-design.md). It adds an opt-in appearance layer on top of the V1 configuration set; V1 keys and the native-Plasma default behavior are unchanged.

## Failure behavior

- **No credentials:** show a login-needed state without prompting for or exposing a token.
- **Expired credentials:** refresh Codex once where supported; otherwise show login-needed.
- **Rate limit:** retain cached values, mark them stale, and wait for backoff.
- **Network/provider failure:** retain last-known-good values and show stale age.
- **Bad response:** reject it, keep previous data, and show a safe error.
- **Collector timeout/crash:** clear the in-flight state, retain previous data, and allow a later retry.
- **Malformed collector JSON:** reject the whole new snapshot rather than partially mixing old and new provider state.
- **One provider fails:** preserve and update the other providers independently.

## Verification strategy

### Collector tests

Use secret-free fixtures to cover:

- valid and malformed responses for all supported providers;
- optional and missing fields;
- reset-time conversion;
- Claude cache preference, stale fallback, 429 backoff, and `Retry-After`;
- Codex HTTP success, curl fallback, one-time token refresh, and safe auth persistence;
- partial provider failure;
- normalized schema validation;
- log and output secret redaction.

### QML and package tests

Verify:

- Plasma package metadata and Plasma 6 API minimum;
- QML loading without runtime errors;
- compact/full representation switching;
- panel sizing and narrow-width behavior;
- desktop resizing;
- provider ordering and visibility configuration;
- icons/text display modes;
- light and dark theme legibility;
- keyboard navigation and accessible labels;
- stale, auth-needed, error, and partial-success states.

### Live smoke test

On this machine, install the widget locally and verify:

- all three configured accounts refresh without Pi running;
- no credentials appear in process arguments, logs, stdout, widget configuration, or caches;
- panel and desktop instances can coexist;
- refreshes do not overlap;
- temporary network failure leaves readable stale values;
- removing and reinstalling the widget does not damage shared auth or Pi caches.

## Delivery

The project lives at `~/code/kuota` as a standalone git repository.

The first release includes:

- the Plasma 6 widget package;
- the collector program;
- configuration pages;
- local install, update, and uninstall scripts;
- tests and fixtures;
- README and architecture notes;
- a package artifact suitable for later KDE Store submission.

Publishing to the KDE Store is a separate, explicitly approved release step.

## Out of scope for v1

- providers beyond Claude, Codex, Grok, and Kimi (further providers remain out of scope);
- cross-machine aggregation;
- long-term historical charts;
- notifications;
- account login or account management;
- a permanent background service;
- KDE Store publication.

## Planning constraints

Crew must preserve these decisions while producing `PLAN.md`:

- one durable project plan file only;
- test-first slices for provider adapters and security-sensitive auth persistence;
- provider collection isolated from QML;
- executable bridge isolated behind one QML component;
- no credentials in fixtures or output;
- no implementation begins until this written specification is reviewed and approved.
