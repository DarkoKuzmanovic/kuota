# Kuota

**AI account usage in your KDE Plasma panel.**

Kuota shows the usage windows, reset times, and account limits reported by
**Claude, Codex, Grok, Kimi, Cursor, OpenCode Go, and CommandCode**. Keep a
compact summary in your panel and open the detail view when you need the full
picture. The same detail view works as a desktop widget.

No running Pi session, permanent collector service, or runtime npm dependencies.
Kuota reads existing credentials locally; it does not estimate account quota
from your prompts, token logs, or local activity.

[Installation](#installation) · [Providers and credentials](#providers-and-credentials) ·
[Troubleshooting](#troubleshooting) · [Development](#development) ·
[Review and next steps](docs/reviews/2026-09-08-project-review.md)

## What it does

- **Panel summary:** provider icons, labels, usage values, and configurable
  caution/critical colors. “Icons only” hides the label, **not** the usage value.
- **Detail view:** provider tabs, genuine usage windows, progress bars, reset
  countdowns, last-successful update time, and provider-specific facts.
- **Appearance settings:** provider visibility/order, font family/scale,
  separators, spacing, custom icons, accents, text color, and opacity.
- **Independent refresh:** a short-lived Node collector fetches providers
  concurrently. Automatic refresh defaults to five minutes; the settings
  sanitizer enforces a five-minute minimum. Manual refresh is also available.
- **Failure handling:** last-known-good usage survives transient failures and
  is marked stale. Claude honors rate-limit backoff; Codex supports a bounded
  OAuth refresh and a curl fallback.

Missing fields stay missing. An unlimited plan does not get an invented
percentage; a provider without monthly usage does not get a fabricated monthly
bar.

## Project status

The source is public on [GitHub](https://github.com/DarkoKuzmanovic/kuota).
Package metadata currently says **1.2.1**; `main` also contains changes under
**Unreleased** in the [changelog](CHANGELOG.md), including Cursor, OpenCode,
and CommandCode. A source checkout is therefore not equivalent to the historical
1.2.1 feature set.

There are no GitHub release assets or tags as of this documentation review.
Install from source below. KDE Store publication is a separate, uncompleted
release step. See the [roadmap](ROADMAP.md) for candidate work, not promises.

## Requirements

| Requirement | Notes |
|---|---|
| Linux with KDE Plasma 6 | Package declares Plasma API minimum 6.0; not a GNOME, macOS, or Windows widget. |
| Node.js ≥20 | The Plasma bridge invokes **`/usr/bin/node`**. A shell-only nvm/asdf installation is not sufficient. |
| npm and Git | Needed to build from source. TypeScript is a pinned development dependency. |
| `kpackagetool6` | Installs the package as `Plasma/Applet`. |
| `flock` from util-linux | Collector locking uses **`/usr/bin/flock`**. |
| `zip` | Required; a missing tool or failed archive build is an error, not an unpacked-only success. |
| curl | Used when Codex's normal HTTP request needs the fallback transport. |
| `sqlite3` | Needed at **`/usr/bin/sqlite3`** for local Cursor session discovery; not needed when a usable environment fallback is used. |

For development, also install Qt 6's `qmllint`, Qt Quick Test, Kirigami, and the
Plasma QML modules. The current QML runner expects
`/usr/lib/qt6/bin/qmltestrunner`; distro paths may differ.

## Installation

```bash
git clone https://github.com/DarkoKuzmanovic/kuota.git
cd kuota
npm ci --ignore-scripts
```

Install the checked-out source:

```bash
scripts/install.sh
```

Both install and update rebuild from source every time, even when the version
has not changed. They require a freshly produced, nonempty archive before
calling the package tool. To build without installing, run
`npm run build:artifact`.

The artifact checker runs the packaged collector in its own private temporary
HOME/cache with an allowlisted environment. It does not pass your credentials,
XDG paths, provider variables, or Node preload options to the collector. Each
invocation has a two-second deadline and a 64 KiB output bound; temporary
resources are removed on success or failure. These are offline checks, not a
live-account smoke test. See the [approved reliability amendment](docs/specs/2026-09-08-review-p1-fixes-design.md).

The build produces:

```text
dist/artifact/kuota-v1.2.1/           unpacked Plasma package
dist/artifact/kuota-v1.2.1.plasmoid  verified installable archive
```

The installer installs or upgrades the package for your user. Open Plasma's
**Add Widgets** dialog and add **Kuota** to a panel or the desktop. Click the
panel summary to open the detail view.

### Updating

1. Pull the desired source revision: `git pull --ff-only`.
2. Run `npm ci --ignore-scripts`.
3. Run `scripts/update.sh` (always rebuilds before upgrading).
4. Remove/re-add the widget or log out and back in to load the new code.

Build, check, and zip failures stop installation; previous same-version archives
are not reused. New configuration keys require reloading the widget instance.

### Uninstalling

```bash
scripts/uninstall.sh
```

This removes the package `io.github.darkokuzmanovic.kuota` and
`~/.cache/kuota/`. It does not delete Pi credentials or edit Plasma's global
configuration.

## Providers and credentials

In the table below, **`auth` means the root JSON object** in
`~/.pi/agent/auth.json`, not an extra `auth` wrapper. Kuota does not provide a
login UI. Use the appropriate client to sign in; never put tokens in widget
settings, command arguments, issues, or screenshots.

| Provider | Data available when returned by the provider | Credential discovery |
|---|---|---|
| **Claude** | Session/weekly utilization, reset times, model-specific windows and extra-usage facts. | `auth.anthropic`, OAuth. Prefers a fresh compatible pi-hud cache before a live fetch. |
| **Codex** | Primary/secondary usage windows, resets, plan/credit facts. | `auth["openai-codex"]`, OAuth access plus account ID; refresh metadata enables one refresh attempt. |
| **Grok** | Monthly credits and an optional weekly window. | `auth.xai`, `auth["xai-auth"]`, or `auth["grok-cli"]`; `GROK_CLI_OAUTH_TOKEN` fallback. |
| **Kimi** | Weekly and short-window usage, resets, concurrency facts. | `auth["kimi-coding"]`, OAuth or API key; `KIMI_API_KEY` fallback. |
| **Cursor** | Included-plan spend share, billing reset, membership and on-demand usage facts. | Local Cursor `state.vscdb` session first, then `CURSOR_SESSION_TOKEN`. Does **not** use Pi's auth file. |
| **OpenCode Go** | Hosted Go plan: rolling 5-hour, weekly, and monthly percentages with resets. Not arbitrary OpenCode/Zen/API spend. | `auth["opencode-go"]`, then `auth.opencode`; `OPENCODE_API_KEY` fallback. Supports `api`/`api_key` + `key`, or `oauth` + `access`. |
| **CommandCode** | Five-hour and optional weekly windows; monthly/purchased/free credit facts and optional plan name. | `auth.commandcode`: OAuth-shaped `access` or `api_key` + `key`; `COMMANDCODE_API_KEY` fallback. |

**Provider limits matter:** CommandCode exposes monthly credit allowances, not a
monthly-used total; Kuota therefore has no monthly utilization window for it.
Cursor uses an unofficial dashboard endpoint. These are client/account-facing
surfaces, not a guarantee of a stable public API, and account plans can expose
different fields.

**Fallbacks are not overrides.** File/local credentials generally take
precedence. Unsafe files, malformed JSON, or malformed supported credential
entries can fail closed instead of using the environment fallback. A variable
exported in a terminal is not automatically inherited by the already-running
Plasma session; do not put secrets in a launcher command to work around that.

Only **Codex** may write refreshed credentials back to the shared auth file,
using an atomic, permission-preserving merge. Other providers are read-only
credential consumers.

## Configuration

Right-click Kuota and open its configuration dialog:

- **Providers:** display/collection selection, display order, and Claude/Codex
  compact usage-window choices.
- **Appearance:** display mode, font scale, separator, icon/label/value spacing,
  and countdown visibility.
- **Thresholds:** refresh interval and caution/critical utilization levels.
- **Theming:** optional fonts, icons, text colors, accents, and opacity. Native
  Plasma styling remains the default.

In this source revision, **“Show and collect usage”** controls both display and
collection using the existing visibility setting. Disabled providers are excluded
from future collector invocations, including credential discovery and requests.
Disabling all providers leaves the empty view and launches no collector; it does
not create a fresh observation. Re-enabling a provider requests a refresh.
Reordering providers or changing appearance does not trigger collection.

Work already launched while a provider was enabled may finish. Selection changes
clear the old snapshot and discard that in-flight result, then refresh only the
latest selection once the existing run finishes or reaches its deadline. Multiple
widget instances may select different subsets; cached records for other
instances are preserved on disk but excluded from the current response.

## Troubleshooting

| Symptom | Check |
|---|---|
| Widget missing or old code still shown | Confirm installation used `-t Plasma/Applet`, rebuild the archive, then reload the widget or log out/in. |
| `auth-needed` | Check the correct credential source for that provider and sign in again. Do not paste the auth file into a bug report. |
| Cursor login appears stale | Confirm local Cursor login and `/usr/bin/sqlite3`. Kuota reads committed WAL updates; check DB/WAL/SHM access as described below. |
| `stale` | Last successful data is retained. Check its timestamp; Claude may be in rate-limit backoff. Repeated Refresh clicks do not override that backoff. |
| `error` | A provider may be unreachable or have changed its response; also check fixed runtime paths and the trusted local cache directory. Other providers can still update. |
| Settings seem ignored | Reload after adding new config keys. Invalid values are sanitized to safe defaults; “Icons only” intentionally keeps the usage value. |
| Build has no `.plasmoid` file | Install `zip` and resolve any compiler/checker/zip failure, then rebuild. An unpacked directory alone is not a successful build. |
| Shell Node works but widget fails | Check `/usr/bin/node`; the bridge does not resolve your interactive shell's Node version manager. |

### Cursor local database access

Kuota opens `~/.config/Cursor/User/globalStorage/state.vscdb` (then the lowercase
`cursor` candidate) with SQLite's `-readonly` mode, without asserting that the
database is immutable. This includes committed updates in an open WAL. Kuota
does not copy, checkpoint, update, or persist the database or session token.

WAL access can require readable `-wal`/`-shm` sidecars and SQLite read-lock
coordination. SHM lock bookkeeping is not promised to remain byte-identical;
missing sidecars in a non-writable directory or unreadable files may prevent
a safe read. Ordinary missing, busy, unreadable, or malformed local state still
allows `CURSOR_SESSION_TOKEN` fallback. Cancellation, a two-second sqlite child
deadline, or more than 64 KiB on either output stream stops discovery and does
not proceed to another candidate, environment fallback, or provider request.
Failures remain value-free. Do not attach databases, sidecars, or tokens to
bug reports. Synthetic WAL tests cover freshness; a real-account re-login smoke
is a separate, explicitly approved check.

## Development

The project uses strict TypeScript, Node's built-in test runner, and Qt Quick
Test. There are **no runtime npm dependencies**. Cursor's synthetic SQLite
integration tests additionally require `/usr/bin/sqlite3` and `/usr/bin/python3`
(Python 3 with its standard-library `sqlite3` module).

| Command | Purpose |
|---|---|
| `npm run typecheck` | Check TypeScript without emitting files. |
| `npm test` | Compile and run collector, filesystem, lifecycle, and secret-safety tests. |
| `npm run test:qml` | Run the offscreen Qt 6 UI/model/bridge suites. |
| `npm run validate:plasma` | Check package metainfo and lint QML/JS. |
| `npm run build:collector` | Build the runnable collector under `dist/collector/`. |
| `npm run build:artifact` | Build/package the widget and run the artifact checker. |

Run verification sequentially in a dedicated checkout with a disposable
`HOME` and an explicit minimal environment (not just a different HOME). The
artifact checker enforces its own isolation, but that is not a sandbox for
arbitrary test code or npm tooling.
Never run suites that share `dist/` concurrently. Remove generated `dist/`
between gates when investigating stale-output failures. The QML suite is
headless; it is not a substitute for a real panel/desktop smoke test.

The collector accepts no arguments (all providers) or one allowlisted
`--enabled-providers=<csv>` argument. **No credential arguments are accepted.**
For a no-provider serialization check inside an isolated verification home:

```bash
node dist/collector/cli.js --enabled-providers=
```

A normal successful invocation emits exactly one newline-terminated schema-v2
JSON document. Provider failures are records inside that document, not permission
to emit raw responses or secrets.

```text
plasmoid/           QML views, settings, and isolated collector bridge
collector/src/      Provider adapters, normalization, auth/cache I/O, redaction
collector/test/     Node collector tests
tests/              Synthetic fixtures, QML tests, security/lifecycle checks
scripts/            Build and local lifecycle commands
docs/               Architecture, approved specs, and review findings
dist/               Generated output; ignored by Git
```

Read [AGENTS.md](AGENTS.md) and [PLAN.md](PLAN.md) before contributing.
Product-visible changes require an approved design amendment. Add tests before
changing provider behavior or security-sensitive persistence, and use synthetic
fixtures rather than recorded credentials or raw account responses.

## Architecture and security

```text
Plasma views ↔ isolated CollectorBridge ↔ short-lived Node collector ↔ providers
                   normalized, validated JSON only
```

The collector owns all credentials and provider I/O. QML validates the complete
snapshot before replacing its current data. Cross-process locking protects
collection; cache writes use restrictive permissions; shared Codex auth updates
preserve unrelated entries and file mode. Redaction and module-isolation tests
protect these boundaries.

This is a local desktop integration, not a sandbox or an independent security
audit. Keep auth files private. Before sharing diagnostics, remove account
identifiers, tokens, environment values, and raw provider responses.

## Further reading

- [Architecture overview](docs/architecture/overview.md)
- [Collector JSON contract](docs/architecture/collector-contract.md)
- [Approved design and amendments](docs/specs/2026-07-10-kuota-design.md)
- [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md)
- [Project review and prioritized recommendations](docs/reviews/2026-09-08-project-review.md)
- [Synthetic fixture policy](tests/fixtures/README.md)
- [GitHub issues](https://github.com/DarkoKuzmanovic/kuota/issues)

## License

[MIT](LICENSE). Not affiliated with or endorsed by the listed providers.
