# Standalone credentials — approved design amendment

**Approval source:** Owner chat, 2026-10-02.
- Pi session `01a0fba5-6441-721e-b148-1641486f155c`, 08:11Z: "I approve the scope changes fully … Goal in the end is to be able to release Kuota as a standalone app, so others can use it too, and not just to be tied down to Pi."
- Hermes session 2026-10-02, design answers: own 0600 credential file; terminal login now with widget sign-in buttons next; Claude via Claude Code login only; keep read-only fallbacks to other tools' logins and env vars.

This approves the scope change. It does not approve a release, KDE Store publication, or M18 widget sign-in buttons.

**Amends:** design spec §Credential and file safety, §Failure behavior, and §Out of scope ("account login or account management"); M16.2 (Claude Pi fallback); M3 (Codex refresh write-back into Pi `auth.json`).

## Problem

1. **Codex shows "Authentication required".** Pi 0.99.0 (2026-09-29) replaced the `openai-codex` login with "Sign in with ChatGPT" on the `openai` provider. `~/.pi/agent/auth.json` no longer has `openai-codex`, so `readCodexAuth` returns `missing-entry`. The new `openai` entry can't be used: its token audience is `api.openai.com/v1` and it has no ChatGPT account ID, both of which the usage endpoint needs.
2. **Kuota is tied to Pi.** Codex, Grok, Kimi, OpenCode and CommandCode read Pi's `auth.json`, and Claude uses it as a fallback. A public user without Pi gets nothing, and any change to Pi's format breaks Kuota, as (1) just did.

## Decisions

| Area | Decision |
|---|---|
| Pi | Remove every read of `~/.pi/agent/auth.json` and the Codex refresh write-back to it. Kuota never opens Pi's files. No import from Pi: users run `kuota login` once. |
| Credential store | `$XDG_CONFIG_HOME/kuota/credentials.json` (default `~/.config/kuota/credentials.json`). File mode 0600; Kuota creates `kuota/` as 0700. Trusted-parent precondition applies to `kuota/`. Contains secrets only for providers the user signed in to through Kuota. Only the collector reads it; nothing from it reaches QML, argv, stdout, caches or diagnostics. A keyring backend is deferred. |
| Store shape | Flat object keyed by Kuota provider id: `{ "<id>": Entry }`. `Entry` is `{ "type": "oauth", "access", "refresh", "expires", "accountId"? }` or `{ "type": "api_key", "key" }` — the entry shapes the existing readers already validate, so readers changed only path and key. Malformed entries fail closed per reader (auth-needed/error), never guessed. |
| Writes | Reuse `io/atomic-write.ts` + `io/json-file.ts`: latest-read merge with identity token, same-directory exclusive temp, fsync, abort on concurrent change, preserve unrelated providers. Every write uses the `new-cache` policy, so the file is 0600 even if the user loosened it. A store write is either a login/logout (CLI) or a refresh (collector, under the existing collector lock). |
| Refresh | Kuota refreshes **only its own store entries** (Codex, Grok, Kimi OAuth), at most once per collection, under the collector lock. Codex keeps its existing refresh-on-expiry-or-401 policy; Grok and Kimi refresh on expiry only (refresh-on-401 deferred until a provider is seen revoking early). It never refreshes another tool's credential: that would rotate that tool's refresh token and log it out. The bounded `codex/refresh.ts` gains an optional form-encoded client (endpoint + client id) and `codex/persist.ts` an `entryKey`, so Grok/Kimi reuse both. |
| Login entry point | Collector CLI subcommands: `login <provider>`, `logout <provider>`, `status`. Run as `node <plasmoid>/contents/code/collector/cli.js login codex`; the README documents a one-line `kuota` alias, and the widget's auth-needed text says `kuota login <id>` (Claude/Cursor: sign in to their app). No launcher is installed in M17. The one-JSON-document stdout contract stays on the existing collection mode. Login mode is human-facing and never launched by QML in M17. |
| OAuth flows | Device-code flows (RFC 8628), the same public clients Pi uses: Codex `auth.openai.com` deviceauth with `openid profile email offline_access`, account ID taken from the token's `chatgpt_account_id` claim; xAI `auth.x.ai/oauth2/device/code`; Kimi `auth.kimi.com` device flow. The CLI prints the verification URL and user code and polls within the provider's timeout. Ctrl-C or a timeout writes nothing. |
| API keys | Read from a no-echo TTY prompt, or from stdin when it isn't a TTY. Never accepted as argv (visible in `ps`). Validated as non-empty, single-line, within a size bound. |
| `status` | One line per provider: Kuota store entry type and expiry when present, the read-only tool fallback that applies (Claude Code, Codex CLI, Cursor), and which env var is set. It does not probe other tools' files. Never values. |

### Credential source order (first locally valid wins, as M16)

| Provider | 1st | 2nd (read-only, never refreshed) | 3rd |
|---|---|---|---|
| Claude | Claude Code `~/.claude/.credentials.json` | — | — |
| Codex | Kuota store (OAuth) | Codex CLI `~/.codex/auth.json` `tokens.access_token` + `tokens.account_id` | — |
| Grok | Kuota store (OAuth) | — | `GROK_CLI_OAUTH_TOKEN` |
| Kimi | Kuota store (OAuth or API key) | — | `KIMI_API_KEY` |
| OpenCode | Kuota store (API key) | — | `OPENCODE_API_KEY` |
| CommandCode | Kuota store (API key) | — | `COMMANDCODE_API_KEY` |
| Cursor | unchanged: `state.vscdb` | — | `CURSOR_SESSION_TOKEN` |

There is no Kuota Claude login: a public app signing in with Claude Code's OAuth client risks breaking Anthropic's terms. A *malformed* Kuota `codex` entry is reported as `auth-needed` rather than silently falling through to the Codex CLI, so a broken Kuota login is visible and fixed by re-running `login`; only a missing store or entry falls through. An expired Codex CLI token is `auth-needed` (Codex CLI refreshes it the next time it runs), not a refresh. Grok and Kimi vendor-tool logins are deferred until their on-disk formats are verified.

## Shape

- New `collector/src/credentials/store.ts` (path, read, `writeCredentialEntry`/`removeCredentialEntry`, `refreshFields`), `oauth-clients.ts` (public Grok/Kimi client constants), `refresh-store-oauth.ts` (expiry refresh + persist for Grok/Kimi).
- New `collector/src/login/command.ts`: device-code poller, Codex device flow, RFC 8628 flow for Grok/Kimi, no-echo key prompt. Endpoints, client IDs and scopes are re-derived from recon (Pi's public client modules), not imported from Pi.
- `providers/*/auth.ts`: replace the `.pi/agent/auth.json` reader with the source order above. `codex/auth.ts` gains the Codex CLI reader. Grok and Kimi gain refresh; their adapters call it like Codex does.
- `codex/persist.ts` targets the Kuota store. The Pi-specific merge code and its tests are removed.
- `cli.ts` dispatches `login|logout|status` before the existing argv parser. Collection-mode argv validation stays unchanged.
- QML: the auth-needed text gains the `kuota login <provider>` hint as a fixed string. No contract or schema change.
- Docs: the main spec's pointers, AGENTS.md provider table + Security rules, README install/login section, `collector-contract.md` unchanged.

## Failure behavior

- Missing store or missing entry → that provider falls through to its next source, then `auth-needed`. A symlinked or non-regular store → `error` with a value-free diagnostic (no-follow reader). Writes refuse an untrusted or symlinked `kuota/` directory. ponytail: no read-time mode check — every Kuota write forces 0600; add a refuse-if-group/other-readable check if users report loosened files.
- A refresh rejected by the server (`invalid_grant`) → `auth-needed`. The entry is left as-is, to be replaced by the next `login`. A network failure during refresh → `stale`/`error` per the existing rules. A post-commit durability failure is indeterminate: re-read, don't retry blindly.
- Concurrent CLI login and collector refresh: both use latest-read merge, so the loser aborts and the next run sees the newer entry.

## Risks to verify during M17 (stop and report if any fails)

1. **Separate token chains:** after a Kuota Codex/Grok/Kimi login and one refresh, Pi and Codex CLI stay signed in (manual acceptance).
2. **OpenAI device-code availability:** some ChatGPT accounts/workspaces must enable device-code sign-in. If it's blocked, fall back to Pi's browser PKCE flow on `localhost:1455` (spec addendum, not silent).
3. **CommandCode key source:** confirm a `user_…` key can be obtained without the CommandCode CLI (dashboard). If not, document the limitation.
4. **Artifact checks:** the packaged-CLI checker must not inherit `XDG_CONFIG_HOME`/`HOME` (G-P1 already isolates both); add a canary store to prove it.

## Acceptance

- `rg '\.pi/|auth\.json' collector/src` finds only the Codex CLI path (`.codex/auth.json`).
- Test-first, synthetic HOME/XDG: store read/validate/permission rejection; atomic login/logout/refresh merges preserve other providers and file mode 0600; source-order precedence per row above; foreign credentials never written (byte-identical canaries for `~/.claude`, `~/.codex`); expired Codex CLI token → auth-needed; device-code poller handles `authorization_pending`, `slow_down`, expiry, and cancel without writing; API key never accepted from argv; redaction covers every new diagnostic.
- Gate set green: `npm run test:qml`, `rm -rf dist && npm test`, `npm run typecheck`, `npm run validate:plasma`, `npm run build:artifact`.
- Live: owner runs `login codex` and Codex shows usage on the panel; `status` shows no secret values.

## Out of scope

M18 widget sign-in buttons; KWallet/Secret Service backend; Kuota-owned Claude login; importing credentials from Pi; Grok/Kimi vendor-CLI fallbacks; release/publication.
