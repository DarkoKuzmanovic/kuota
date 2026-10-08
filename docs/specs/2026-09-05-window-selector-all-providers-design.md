# Design — Per-provider window selectors for all multi-window providers

Date: 2026-09-05
Status: approved by owner in session (scope: settings/UI layer only)
Amends: D4 of `2026-07-10-kuota-design.md` (static per-provider window
selector catalog), which shipped with controls only for Claude and Codex.

## Problem

`compact-model.js` honors `displayConfig.window[providerId]` generically, but
the config layer exposes selectors only for Claude and Codex. Providers added
later (Grok, Kimi, Cursor, OpenCode, CommandCode) always display their primary
window (`windows[0]`) with no way to change it.

## Decision

Add a "Usage window" selector for every provider that has more than one
genuinely meaningful window. Cursor exposes exactly one percentage window
(`plan`), so per the D4 single-window precedent (the Umans no-op) it gets no
selector and no config key — a control that cannot change anything is a dead
control and fails the M9 presentation-config gate.

### Window catalogs (static known IDs, D4 style)

| Provider | Key | Catalog (window IDs) | Combobox labels |
|---|---|---|---|
| grok | `grokWindow` | `week`, `month` | Default, 7d, 30d |
| kimi | `kimiWindow` | `week`, `5h`, `daily`, `month` | Default, Week, 5h, Daily, Month |
| opencode | `opencodeWindow` | `rolling`, `weekly`, `monthly` | Default, 5h, Weekly, Monthly |
| commandcode | `commandcodeWindow` | `fiveHour`, `weekly` | Default, 5h, Weekly |

Kimi's short window id is duration-derived (`5h`/`daily`/`month`, and `week`
for week-sized short windows — `windowLabelFromMinutes`), so the catalog lists
all four stable ids the adapter can emit. `resolveDisplayWindow` already falls
back to the primary window when the selected id is not present in the live
record, so selections that do not match the account's actual windows degrade to
today's behavior instead of blanking the entry.

CommandCode has no monthly **usage** window: the credits API exposes only
`monthlyCredits`/`purchasedCredits`/`freeCredits` allowance caps with no monthly
used figure, so a monthly percent cannot exist (see
`2026-09-01-commandcode-provider-design.md`). OpenCode is the provider with a
real monthly window. This stays unchanged.

## Shape

- **Config schema (`main.xml`)**: four additive `String` entries
  (`grokWindow`, `kimiWindow`, `opencodeWindow`, `commandcodeWindow`), default
  `""` = primary-window default. Additive-only per D7; no renames/removals.
- **`config-model.js`**: extend `KNOWN_WINDOWS`; sanitize each key with the
  existing catalog-restricted `sanitizeWindowSelection`; generalize
  `assembleDisplayConfig`'s window map and `resolveWindow`'s settings lookup
  from the claude/codex special cases to `providerId + "Window"` over
  `KNOWN_PROVIDERS` (the key naming already matches for claude/codex).
- **`configProviders.qml`**: one `Controls.ComboBox` per provider in the
  existing "Usage window" section, each with a stable `objectName`
  (`<id>WindowCombo`) and the established `textRole`/`valueRole` model shape
  with `Default` (`value: ""`) first.
- **No collector, contract, cache, or credential changes.** `main.qml` and
  `compact-model.js` already flow `window` generically; the compact threshold
  coloring follows the selected window for free.

## Failure behavior

- Unknown/garbage value → sanitized to `""` (primary default), same as Claude
  and Codex today.
- Selected id not in the live snapshot → compact falls back to the primary
  window (existing M9.3 rule, unchanged).

## Acceptance

- QML model tests: new keys default `""`; garbage/wrong-type → `""`; catalog
  membership enforced; `assembleDisplayConfig.window` carries each selected
  provider; `resolveWindow` honors present ids for the new providers.
- Config-page test: each new combo exists by `objectName`, offers Default plus
  its catalog ids, and round-trips its `cfg_` alias.
- Compact regression: selecting a non-primary window on Grok/CommandCode
  changes the displayed value and threshold level.
- `npm run test:qml`, `npm test`, `npm run typecheck`,
  `npm run validate:plasma` all green.
