# Overview tab and popup redesign

**Date:** 2026-11-22  
**Status:** Owner-approved scope, 2026-11-22  
**Amends:** [Kuota Design](2026-07-10-kuota-design.md), full popup and desktop representation; issue #9; G-RL deferred item 3.

## Purpose and boundaries

Give a quick, reset-aware view of each enabled provider's reported usage without inferring future consumption, recommendations, or a global budget. The overview uses only the validated snapshot already supplied by the collector, makes no extra provider requests, and stores no history. Stale values remain visibly stale and are not recommendations. The same UI is used for the popup and desktop; existing configuration, refresh, and detail access remain available.

## Layout

```text
┌─────────────────────────────────────────┐
│ All │ Claude │ Codex │ Grok │ …         │  ← scrollable tabs
├─────────────────────────────────────────┤
│                                    ↻    │
│ Claude    Weekly   79% left  in 2d 4h  ›│
│ Codex     5h       13% left  in 1h 3m  ›│
│ Kimi      Weekly   21 / 100    stale   ›│
│ Cursor             Login needed        ›│
└─────────────────────────────────────────┘

Detail:  [All] [Claude] …             ↻
         Session                 21% · in 3h
         ━━━━━━━━┿━━━━━━━━━━━━━━━━━━━━━━━
                 ↑ elapsed-time tick, if known
         Weekly                  60% · in 2d
         ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Sketch is illustrative; all displayed numbers and times are synthetic. Plasma supplies colors, typography, focus and controls. Rows may reflow or elide subordinate text at narrow widths; remain keyboard-operable and expose complete accessible names. Overview and detail use light borders and compact spacing, while respecting custom accent, text color, opacity and system light/dark themes.

## Overview behavior

- All is the first and default tab. Show one row for each enabled provider, in the user's configured provider order; **do not sort by headroom**. The content-sized tab strip scrolls horizontally, keeps the selected tab visible and supports keyboard navigation, with Refresh in its own space.
- Within each provider, choose the window with the highest *reported* `usedPercent`; ties use the first window in the validated record. Label the selected window, show usage and derived remaining percent (`100 - usedPercent`). Never compare different units or synthesize a percentage from used/limit for this selection. If no percentage exists, display genuine used/limit or used count from the first suitable window; a used/limit pair also supplies the bar fraction just as in detail.
- Show only the selected window's reported reset, with a live countdown where enabled. Do not mix an earlier reset from another window into the row; issue #9 does not require a cross-window earliest reset. Missing resets remain absent.
- Explicit stale, auth-needed, and error badges stay visible alongside any retained data; the existing provider-specific login guidance is available for auth-needed. A row opens its provider tab, which retains all underlying windows and facts. The refresh action is present when at least one provider is enabled.
- No providers enabled is a distinct configuration state, with guidance to enable one and refresh disabled. Enabled providers waiting for a first snapshot are not called disabled.

## Detail and elapsed-time marker

Usage windows remain separate and retain all genuine reported values, timestamps, countdowns, progress, and provider-specific details. Put the value and reset on fewer lines where space allows. A narrow tick on a progress bar denotes elapsed window time, not projected usage: it is computed from the reported reset time, reported duration in seconds and the injected presentation clock, clamped to the bar. It is absent unless both timestamp and duration are valid. A duration is never inferred from a window label or a customary provider period. Update it with the countdown clock; expose usage and elapsed time in the bar's tooltip and accessible description.

Schema v2 gains optional additive `durationSeconds`, a positive safe integer. Both collectors' TypeScript validator and the independent QML validator enforce it; omission preserves older snapshots. An adapter populates it only when the corresponding wire window reports a duration in seconds. The optional field contains no credentials or provider-native payload.

## Verification and gate

Test the strict contract, malformed and omitted duration, adapters with and without real duration, deterministic tightest-window ties, matching window resets, count-based bars, unknown quotas, stale/auth/error, configured order, no-enabled versus waiting, countdown and tick boundaries with injected clocks, row selection, keyboard-accessible scrolling tabs and refresh separation, narrow layouts and light/dark themes. Run the established typecheck, Node, QML, Plasma validation and artifact gates with a fresh `dist` and disposable synthetic HOME for each. Capture isolated headless light and dark screenshots of All, detail and disabled states using synthetic data; do not touch the live Plasma session. Owner live acceptance and independent gate review are separate from synthetic verification.
