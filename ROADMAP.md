# Kuota roadmap

This is a list of product directions, not an execution plan or permission to
implement them. [PLAN.md](PLAN.md) records milestone gates;
[approved specifications](docs/specs/2026-07-10-kuota-design.md) define behavior.

## Implemented in the public source

- KDE Plasma 6 panel and desktop views, appearance settings, and a standalone,
  short-lived Node collector.
- Claude, Codex, Grok, Kimi, Cursor, OpenCode Go, and CommandCode adapters.
- Concurrent collection, last-known-good data, Claude backoff, Codex OAuth
  refresh, strict snapshot validation, and credential-safety tests.

Package metadata remains **1.2.1**. Newer functionality is recorded under
**Unreleased** in [CHANGELOG.md](CHANGELOG.md). Public source availability does
not mean that a corresponding tagged/package release has been published.

## Recommended next

1. **Make the existing product dependable to build and update.** Isolate
   artifact checks from real accounts, fix same-version artifact reuse, and
   harden Cursor's local credential reader.
2. **Reduce maintenance duplication.** Establish provider/config consistency
   checks, share genuinely identical transport primitives, and remove obsolete
   scaffolding without weakening boundary validation.
3. **Make failures understandable.** Add safe local diagnostics, freshness and
   retry information, and deliberate control over which providers are polled.
4. **Add decision support, not more decoration.** Consider a headroom overview
   and opt-in usage/reset notifications based only on real provider windows.

The [project review](docs/reviews/2026-09-08-project-review.md) ranks these
suggestions, links the scoped issues, and distinguishes measured defects from
feature candidates. Creating an issue does not approve a product change.

## Release readiness

Before publishing a versioned GitHub artifact: reconcile package metadata and
the changelog, run isolated Node/QML/type/package gates, and perform an
owner-approved real panel/desktop smoke test. Do not represent source-only or
offscreen validation as a live release check.

KDE Store publication remains a separate owner-approved step.

## Deliberately deferred

Cross-machine aggregation, long-term usage history, account login/management,
a permanent service, and additional providers need separate design approval.
Do not add a daemon or database merely to support a small panel widget. History
or forecasts, if ever approved, must be explicitly distinguished from
provider-reported quota.
