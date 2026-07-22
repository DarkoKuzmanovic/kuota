# Kuota 1.2.0 — Appearance Customization

**Date:** 2026-07-22<br>
**Status:** Approved for planning<br>
**Approved by:** Project owner, 2026-07-22<br>
**Amends:** `docs/specs/2026-07-10-kuota-design.md` (V1) — adds an appearance-customization layer on top of the V1 configuration set.

## Purpose

Give users KVitals-style control over the widget's appearance: per-provider icons, font family, colors, and opacity. The compact line and full representation remain native to Plasma by default; every override is opt-in.

This closes the gap between Kuota 1.0.0 (which exposes display mode, font *scaling*, separator on/off, and threshold colors only) and the customization depth KVitals ships.

## Design philosophy

**Native by default; opt-in override.** All new appearance keys default to reproducing the 1.0.0 visual output. An upgrading user who changes nothing sees no visual change. This honors the V1 spec's visual-direction requirement — "follow Plasma theme colors… remain legible in light and dark themes" — as the baseline behavior, while unlocking customization when the user explicitly opts in.

The V1 "Out of scope" list did not single out theming; it was simply not part of V1 scope. This amendment introduces appearance customization as approved 1.2.0 scope.

## Scope

In scope for 1.2.0:

- per-provider **custom icon** (freedesktop icon name, KDE icon picker);
- **font family** override (Plasma default otherwise), alongside the existing V1 `fontScale`;
- **colors**: a global custom text color (opt-in) and a per-provider accent color;
- **opacity**: label opacity and separator opacity, independently controllable.

Out of scope for 1.2.0:

- KVitals's three-way font/label/icon color split (global custom text color covers the practical need for 3–5 providers; a per-element chain is over-granular);
- widget background transparency / translucency (matches KVitals, which exposes label + separator opacity only); the background continues to follow the Plasma theme;
- per-element px font size (the existing V1 `fontScale` already scales text; a redundant px-size knob adds schema noise);
- layout direction (horizontal is the only compact layout Kuota supports);
- any collector, bridge, credential, or provider-data changes — appearance is a pure Plasma-UI concern.

## Relationship to 1.1.0

1.2.0 is planned **after** 1.1.0 (Grok + Kimi). The per-provider accent and icon naturally cover all providers present at 1.2.0 ship time. If sequencing changes and 1.2.0 ships first, the theming layer covers the providers then present and 1.1.0 extends it — the design is provider-list-agnostic.

## Configuration

New keys added to the flat KConfigXT schema in `plasmoid/contents/config/main.xml`, under a new **Appearance** config page (distinct from the V1 Appearance page, which keeps display mode / separator / font scale / countdown visibility). Existing V1 keys are unchanged.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `fontFamily` | string | `""` | `""` = Plasma system default; otherwise a system font family name applied to all widget text. |
| `customTextColorEnabled` | bool | `false` | Opt-in global text-color override. |
| `customTextColor` | color | Plasma theme text color | Used only when `customTextColorEnabled` is true. |
| `labelOpacity` | real `0.0`–`1.0` | `1.0` | Opacity applied to provider labels. `1.0` reproduces V1. |
| `separatorOpacity` | real `0.0`–`1.0` | `1.0` | Opacity applied to `\|` dividers. Only meaningful when the V1 `separator` bool is on. `1.0` reproduces V1. |
| per-provider `accentColor` | color | provider identity color | Per Claude / Umans / Codex (and Grok / Kimi once 1.1.0 lands). |
| per-provider `customIcon` | string | `""` | Freedesktop icon name; `""` = provider default icon. |

Existing V1 keys (`separator` bool, `fontScale`, `compactDisplayMode`, threshold colors, etc.) are unchanged. `separatorOpacity` is only meaningful when `separator` is on; when `separator` is off, dividers are absent and `separatorOpacity` has no effect.

### Defaults reproduce 1.0.0

Every new key defaults to the value that reproduces V1 appearance: opacity `1.0`, custom color disabled, accent = provider identity, custom icon = default. This makes the upgrade visually a no-op unless the user opts in, removing a class of "upgrade changed my widget" regressions and keeping the default legible in light/dark per the V1 spec.

### Sanitization

`config-model.js` extends `sanitize()` to the new keys (it remains the single D6 read boundary, per the V1 configuration-layer decision):

- opacities clamped to `[0.0, 1.0]`, garbage → default `1.0`;
- `customTextColor` validated as a color string, garbage → theme text color;
- `customIcon` validated as a non-empty freedesktop icon name or `""`, else → `""`;
- `accentColor` validated as a color string, garbage → provider identity color;
- `fontFamily` left as a free string (the system font resolver handles an unknown family by falling back to the Plasma default); no allowlist of installed fonts is maintained.

As in V1, the config-page spinbox/slider min/max are UX-only, not the guard — `config-model.sanitize()` is the boundary that protects the models.

## Color and opacity precedence

Color precedence, high to low:

1. **Threshold color** (caution / critical) when active — always wins, even over a custom text color. This preserves the at-a-glance alert semantics from V1.
2. **Per-provider accent color** — tints that provider's progress-bar fill and compact chip, only when no threshold is active for that provider.
3. **Global custom text color** (if `customTextColorEnabled`) — overrides Plasma theme text for labels, values, and icons otherwise.
4. **Plasma theme color** — default.

Opacity is independent of color and applies to alpha:

- `labelOpacity` affects label text alpha (and the label portion of icon+text);
- `separatorOpacity` affects divider alpha.

Both clamp to `[0.0, 1.0]`. There is no floor beyond 0.0 — a user can fully hide labels or separators by setting opacity to 0, which is recoverable through the config page. This matches KVitals behavior.

## Icons and font

### Icons

Each provider gains a "Change…" control on the Appearance page that opens KDE's native icon picker; the selection is stored as a freedesktop icon name in `customIcon`. Rendering uses `isMask: true` (monochrome — the icon adopts the panel text color), identical to KVitals, so icons remain legible on both light and dark panels and under the custom-text-color override. A `""` / unset value falls back to the provider's default icon.

The exact picker component (Kirigami `IconDialog` or an equivalent Plasma 6 / Qt 6 mechanism) is confirmed at implementation time. The contract the collector and models rely on is: "store an icon name, render monochrome." No icon bytes or asset files enter the package.

### Font

`fontFamily` is applied to all widget text when non-empty; `""` falls through to the Plasma theme font. It is kept orthogonal to the existing V1 `fontScale` — family and scale compose, rather than one replacing the other. A redundant per-element px font size is not added (over-granular given `fontScale` already exists).

## Layer boundary and testing

Appearance customization is a **pure Plasma-UI concern**. It touches no collector code, no bridge code, and no credential or provider-data path. The security boundary from the V1 spec is unchanged: no secrets, tokens, account IDs, or raw responses enter appearance config, QML properties, or logs.

Testing follows the established V1 split:

- **`config-model.js`** (`sanitize`) — unit-tested via the Qt 6 runner as a Plasma-independent `.pragma library` module. New tests cover opacity clamping, color validation, icon-name validation, and defaults-reproduce-V1.
- **`compact-model.js` / `full-model.js`** — consume the sanitized appearance config to produce view models; the color/opacity precedence logic is unit-testable here, Plasma-independent. New tests cover precedence (threshold > accent > custom > theme), opacity application, per-provider accent on progress bar and chip, and icon-name fallback to default.
- **`main.qml`** — applies `fontFamily` to widget text and exposes appearance config to the models via the existing `configOverride` test seam (the `plasmoid`-null offscreen-harness pattern from V1).
- **New QML files** are registered in `tests/qml/tst_module_isolation.qml` so a stray `org.kde.plasma.plasma5support` import fails the test (only `CollectorBridge.qml` may import it).
- **qmllint** list in `package.json` extended for any new `.pragma library` module.

Test paths (not only happy paths): precedence ordering with all combinations active; opacity clamping at boundaries; defaults reproduce 1.0.0 output exactly; per-provider accent applies to progress bar / chip and yields to threshold; custom text color does not override an active threshold; icon name `""` falls back to default; unknown `fontFamily` falls back to Plasma default; light and dark themes with defaults, and with overrides applied.

## Failure behavior

Appearance misconfiguration is non-fatal and degrades to V1 behavior:

- an invalid color string → the theme / provider-identity default;
- an out-of-range opacity → clamped;
- an unknown icon name → the provider default icon (QML's icon loader falls back gracefully);
- an unknown font family → the Plasma default font.

No appearance misconfiguration may cause the widget to fail to render, throw at load, or enter an error state. The collector and data path are never involved.

## Delivery

1.2.0 ships as an update to the existing Plasma 6 widget package — no new package, no new collector artifact, no new install scripts. The local install/update/uninstall scripts from V1 continue to apply. KDE Store publication remains a separate explicitly approved step, unchanged from V1.

## Planning constraints

Crew must preserve these while producing the 1.2.0 plan:

- one durable project plan file (`PLAN.md`); this amendment does not create a second plan;
- the three-layer isolation (Plasma UI / bridge / collector) is untouched — appearance changes live entirely in the Plasma UI layer;
- `config-model.sanitize()` remains the single D6 read boundary; config-page controls are UX-only, not guards;
- defaults reproduce 1.0.0 exactly so upgrade is a visual no-op;
- threshold color precedence always wins over custom text color and accent;
- every new production QML file registered in `tst_module_isolation.qml` and the qmllint list;
- test-first slices for `config-model.sanitize` additions and for the model precedence logic;
- no collector, bridge, credential, or provider-data changes.
