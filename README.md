# Kuota

A KDE Plasma 6 widget that keeps **Claude**, **Codex**, **Grok**, **Kimi**,
**Cursor**, **OpenCode**, and **CommandCode** account usage visible on the
desktop — without estimating quota from local activity, and without requiring
a running Pi coding-agent session.

Kuota reads the same `~/.pi/agent/auth.json` credentials Pi uses, fetches
authoritative usage from each provider, and shows compact panel metrics plus a
full popup/desktop detail view.

**Version:** 1.2.1 · **License:** MIT · **Package ID:** `io.github.darkokuzmanovic.kuota`

## Features

- Compact panel line for enabled providers (icons, text, or both), with
  caution/critical threshold colors
- Full view with provider switcher, usage windows, progress bars, reset
  countdown, and provider-specific facts
- Configurable visibility, order, fonts/spacing, thresholds, and refresh
  interval
- Short-lived Node collector: concurrent fetches, last-known-good cache,
  Claude rate-limit backoff, Codex OAuth refresh
- Credentials never cross into QML — only normalized, secret-free JSON

## Requirements

- Linux with KDE Plasma 6 (API minimum 6.0)
- Node.js ≥ 20 and npm
- `kpackagetool6` (and `qmllint` if you validate during development)
- Provider credentials in `~/.pi/agent/auth.json` (or the documented env
  fallbacks for Grok/Kimi/OpenCode/CommandCode) — same file Pi uses

Optional: `zip` (creates a `.plasmoid` archive during artifact build).

## Install

From the repository root:

```bash
scripts/install.sh
```

This builds the package if needed, then installs (or upgrades) it with
`kpackagetool6`. Add **Kuota** to a panel or the desktop via Plasma’s
**Add Widgets** dialog.

Update after pulling changes:

```bash
scripts/update.sh
```

Then restart Plasma (`plasmashell --replace &`) or re-add the widget so the
new code loads.

Uninstall:

```bash
scripts/uninstall.sh
```

Uninstall removes the widget package and `~/.cache/kuota/` only. It never
touches `~/.pi/`, `auth.json`, or Plasma global config.

## Credentials

| Provider | Auth discovery |
|---|---|
| Claude | `auth.anthropic` (OAuth) |
| Codex | `auth["openai-codex"]` (OAuth + `accountId`; Kuota may refresh the token once) |
| Grok | `auth.xai` / `auth["xai-auth"]` / `auth["grok-cli"]`, or `GROK_CLI_OAUTH_TOKEN` |
| Kimi | `auth["kimi-coding"]`, or `KIMI_API_KEY` |
| Cursor | Local Cursor `state.vscdb` session (`cursorAuth/accessToken` via `sqlite3`), or `CURSOR_SESSION_TOKEN` |

Kuota does not provide account login UI. Sign in with Pi (or set the env
fallbacks) first. For Cursor, sign into the Cursor desktop app locally, or
export a session cookie value to `CURSOR_SESSION_TOKEN` — never commit it.

## Troubleshooting

- **Widget missing after install** — restart Plasma
  (`plasmashell --replace &`) or remove and re-add the widget.
- **`auth-needed`** — no usable credential for that provider in
  `~/.pi/agent/auth.json` (or the matching env fallback). For Cursor:
  sign into the Cursor app so `state.vscdb` contains a session, install
  `sqlite3`, or set `CURSOR_SESSION_TOKEN`.
- **`error` / stale** — usually transient network or rate limiting. Last
  known-good data is retained and marked stale until the next successful
  refresh. Claude honors `Retry-After` with a minimum backoff.
- **Settings look ignored** — restart Plasma or re-add the widget. Invalid
  values fall back to safe defaults at a single sanitize boundary.
- **Provider API drift** — adapters live under `collector/src/providers/`.
  Cursor uses an **unofficial** dashboard endpoint (`usage-summary`); breakage
  may surface as `auth-needed` or `error` without notice.

## Development

```bash
npm run typecheck
npm test                 # Node collector tests (synthetic HOME recommended)
npm run test:qml         # Qt 6 QML tests
npm run build:collector
npm run validate:plasma
npm run build:artifact   # → dist/artifact/kuota-v1.2.1.plasmoid (if zip is available)
```

Layout:

| Path | Role |
|---|---|
| `plasmoid/` | Plasma package (QML UI, config) |
| `collector/src/` | TypeScript collector, contract, providers |
| `collector/test/` | Collector unit tests |
| `tests/` | Fixtures, security policy, QML tests |
| `scripts/` | Build, install/update/uninstall, QML runner |
| `docs/` | Specs and architecture contracts |
| `dist/` | Generated output (gitignored) |

## Security

- QML is presentation-only. Only `CollectorBridge.qml` may import the Plasma
  executable engine; an automated isolation test enforces that.
- The collector owns credential I/O. Only Codex token refresh writes
  `auth.json`, via an atomic, permission-preserving merge.
- Stdout is exactly one schema-v2 JSON document per run. Diagnostics are
  redacted and never echo secrets, account IDs, or raw responses.
- Caches under `~/.cache/kuota/` hold usage results only, never credentials.

## Documentation

- [`docs/architecture/overview.md`](docs/architecture/overview.md) — layers and data flow
- [`docs/architecture/collector-contract.md`](docs/architecture/collector-contract.md) — schema v2 contract
- [`docs/specs/2026-07-10-kuota-design.md`](docs/specs/2026-07-10-kuota-design.md) — product specification
- [`CHANGELOG.md`](CHANGELOG.md) — release notes
- [`tests/fixtures/README.md`](tests/fixtures/README.md) — fixture / redaction policy

## License

[MIT](LICENSE)
