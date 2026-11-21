# Meta Muse Code provider — design

Status: **approved by the owner on 2026-11-22**. Milestone: PLAN.md *Milestone 19*.
This amendment supersedes the 2026-09-25 Muse deferral; it does not approve a release,
installation, or a live-account test.

## Scope and credential boundary

Add the `muse` provider for Meta Muse Code subscription quota, opt-in and off by
default in both widget configuration and the collector's no-flag defaults. Disabled
means no credential discovery or network request. Use the existing Firefox session
reader to find the `llama_dev_sess` cookie for `dev.meta.ai` in the newest Firefox
profile; use `MUSE_SESSION_COOKIE` (full Cookie header) only as the fallback. The
reader uses a private temporary copy of the cookie database and WAL and deletes it
in `finally`. Never persist or refresh the session, read another application's
credential store, or place credentials in arguments, QML, logs, output or cache.
No cookie and no fallback means `auth-needed`; local discovery failures follow the
existing shared reader's error policy.

## Data source and team selection

The only network operations are bounded, read-only, authenticated GET requests to
`https://dev.meta.ai/api/portal/teams` and then
`https://dev.meta.ai/api/portal/teams/{team_id}/subscription-quota`. Never call
`POST /muse-code/key`: it mints a key. Team IDs are sensitive, used only in the
request path after safe path-segment validation/encoding, and never included in
normalized records, diagnostics, caches, widget settings, stdout or stderr.

- Zero teams is an error. Exactly one team goes directly to its quota endpoint.
- For multiple teams, probe no more than five teams; if there are more than five,
  fail instead of selecting an arbitrary subset. Select only when exactly one team
  has an applicable subscription quota. No applicable quota, multiple applicable
  quotas, a malformed response, or any probe failure is an error; never silently
  choose the first or ignore a failed probe.
- An authentication HTTP rejection (401/403, or authentication redirect) is
  `auth-needed` and is not hidden by cache. Other failures, including team
  selection, timeout, network, malformed response, and non-auth HTTP failure,
  are `error`; the common collector cache may present a prior valid record as
  `stale`. There are no retries or provider-specific cache/backoff.

## Normalized contract

The subscription response has a `subscription_quota` object with `tier`,
`window_weighted_used`, `window_weighted_limit`, `weekly_weighted_used`,
`weekly_weighted_limit`, `window_duration_secs`, `window_resets_at`, and
`weekly_resets_at`. Weighted values are decimal strings; reset timestamps are
epoch seconds. Normalize only genuine fields:

- Windows are ordered `current` (primary) then `weekly`. `current` is labeled
  `N-hour` when its duration is a positive whole number of hours, otherwise
  `Current window`; `weekly` is labeled `Weekly`.
- Compute each `usedPercent` from finite, non-negative weighted used and positive
  weighted limit (`used / limit * 100`), subject to the schema's 0–100 range.
  Convert valid epoch-second reset times to UTC ISO 8601 `resetAt`.
- The common `used` and `limit` fields only accept non-negative integer counts.
  Weighted amounts are not integer counts and must be omitted, even when their
  decimal representation happens to be integral; do not round them.
- Only the bounded provider-supplied tier may appear under `details.muse.tier`;
  no team identifier or other provider-native data is exposed. Omit unavailable
  optional fields, and reject malformed recognized data rather than inventing it.

Both TypeScript and QML validators must agree on the `muse` provider, its
namespaced details, window IDs and contract. UI catalog, configuration and
selectors must use the same IDs; the default compact window is `current`.

## Acceptance

Use synthetic fixtures only for development and gate checks. Cover Firefox-cookie
precedence/fallback and cleanup; disabled-provider no-I/O; one, zero, multiple,
over-five and ambiguous teams; per-probe errors and auth rejection; bounded GETs
and request-path/credential secrecy; decimal percentage calculation, durations,
epoch resets, malformed/optional fields and omitted weighted amounts; schema and
QML validation; current/weekly selection; and stale versus auth-needed behavior.
Include a real-shaped fetch-to-parser integration fixture and secret-safety tests.
Run the standard synthetic-HOME gate and independent review before G-19 is passed;
a live session/panel check requires separate owner approval.
