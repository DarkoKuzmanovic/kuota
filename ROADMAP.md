# Kuota roadmap

This is a list of product directions, not an execution plan or permission to
implement them. [PLAN.md](PLAN.md) records milestone gates;
[approved specifications](docs/specs/2026-07-10-kuota-design.md) define behavior.

## Implemented in the public source

- KDE Plasma 6 panel and desktop views, appearance settings, and a standalone,
  short-lived Node collector.
- Claude, Codex, Grok, Kimi, Cursor, OpenCode Go, CommandCode, Mistral,
  OpenDesign, and Muse Code adapters (the last three are opt-in).
- The All overview with provider selection and elapsed-time ticks where
  supported ([#9](https://github.com/DarkoKuzmanovic/kuota/issues/9)).
- Offline `kuota doctor` local diagnostics
  ([#8](https://github.com/DarkoKuzmanovic/kuota/issues/8)).
- Concurrent collection, last-known-good data, Claude backoff, Codex OAuth
  refresh, strict snapshot validation, and credential-safety tests.

Package metadata is **2.2.0** (latest release 2026-11-22; see
[CHANGELOG.md](CHANGELOG.md)). Releases are published on GitHub Releases;
`main` may carry unreleased work listed under [Unreleased] in the changelog.

## Recommended next

1. **Make the existing product dependable to build and update.** Isolate
   artifact checks from real accounts, fix same-version artifact reuse, and
   harden Cursor's local credential reader.
2. **Reduce maintenance duplication.** Establish provider/config consistency
   checks, share genuinely identical transport primitives, and remove obsolete
   scaffolding without weakening boundary validation.
3. **Make failures understandable.** Build on local diagnostics and deliberate
   provider selection with clearer freshness and retry information.
4. **Add decision support, not more decoration.** Consider opt-in usage/reset
   notifications based only on real provider windows.

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
