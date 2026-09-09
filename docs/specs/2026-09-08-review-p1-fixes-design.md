# Review P1 fixes — approved design amendment

**Approval source:** Owner chat, 2026-09-08: “Do as you suggest. Merge the docs and tackle 1 - 4 with gpt-6-astra with low thinking effort subagent.” This approves the four bounded fixes proposed in issues #1–#4 and their regression tests. It does not authorize a live-account smoke, desktop installation, new feature, or merge of the implementation PR.

**Base:** Public `main` after documentation PR #10, `3ce14f210e226b34a0ebb27422abdbd2af0c08b2`. The unrelated local selector commit `3c123bd` remains excluded.

## Problem and scope

1. Artifact verification inherits the user's credentials/environment.
2. Cursor's immutable SQLite connection misses live WAL updates.
3. Cursor credential discovery has no cancellation/deadline/output bound.
4. Source install/update can reuse a stale same-version archive, and the updater parses JSON using indentation-sensitive text matching.

This amends Cursor §1's immutable-reader choice and the source-build lifecycle. No provider payload, endpoint, auth precedence, schema, QML, setting, token writer, or runtime dependency is added or changed.

## Decisions

| Area | Decision |
|---|---|
| Artifact checks | The checker owns a private temporary HOME/cache and an explicit minimal environment for every packaged CLI invocation. Do not inherit HOME/XDG/provider env/preload variables or ambient arbitrary env. Use a bounded child deadline/output and force termination on timeout. Clean up on success and failure. |
| Coverage | Preserve real packaged-CLI checks for canonical provider order, subsets, empty selection, and credential-argv rejection. Tests must prove environment isolation and that synthetic parent auth/cache canaries are unchanged; no provider request is expected without credentials. |
| Cursor database | Open the actual requested path read-only with WAL support; remove the false immutability assertion. Encode URI path characters or use a correct non-URI read-only CLI form. Never copy, modify, checkpoint, or persist the user's token/database as a freshness workaround. |
| SQLite sidecars | Normal read-only SQLite WAL access may need existing readable WAL/SHM files and SQLite read-lock coordination. Do not promise byte-identical SHM internals. Preserve DB/WAL contents and credentials; if safe read-only access fails, use existing value-free fallback/error behavior. |
| Cursor bounds | Pass the collection AbortSignal through auth discovery and the real child owner. Default per-child deadline 2 seconds, stdout and stderr each at most 64 KiB (bytes, not characters); any injected limits are validated and bounded. Pre-abort spawns nothing. |
| Cancellation | Abort/deadline/overflow terminates and reaps the exact sqlite child, clears listeners/timers, settles once, discards partial credential output, and stops further candidate discovery/fetch. A promise race alone is insufficient. Prefer immediate SIGKILL on the short-lived read-only helper over a complex escalation state machine. |
| Auth fallback | Ordinary missing/unreadable/busy/failed local source still allows the existing env fallback, with local-before-env precedence. An aborted collection must not restart through another candidate or env/network fallback. No raw stderr, error payload, or credential content enters the contract or diagnostics. |
| Source lifecycle | Both source install and update build afresh before installing. Reuse one small JSON-derived version/path helper where it simplifies both scripts. Verify a nonempty freshly produced archive before kpackagetool. Preserve quoting, CDPATH isolation, Plasma/Applet type, install-then-upgrade behavior, and uninstall blast radius. |
| Packaging failure | Missing zip, zip failure, build/check failure, or missing/empty archive is a nonzero error, not an “unpacked success.” Do not leave a stale prior archive looking like this build's successful output. No elaborate freshness manifest/cache layer. |
| Documentation | Replace the README's caller-isolation workaround with the verified safe default workflow after the fix passes. Clarify fresh rebuild behavior and record Cursor WAL/sidecar requirements. Keep historical review findings historical; link this amendment rather than rewriting original review evidence. |

## Per-file shape

- `scripts/check-artifact.js`: private checker environment and resource bounds; a small directly used helper/test seam is allowed, not a generic subprocess framework.
- `scripts/build-artifact.js`, `scripts/install.sh`, `scripts/update.sh`: fail-closed fresh artifact production and shared version/path logic where useful.
- `collector/src/providers/cursor/auth.ts` and `adapter.ts`: WAL read path, signal plumbing, bounded child lifecycle. Extract a provider-local runner only if it improves readability/testing.
- Existing/new `tests/lifecycle/`, Cursor auth/adapter tests and synthetic fixtures: test production behavior, real SQLite WAL, and real subprocess exit. No real package installation or auth file read.
- `README.md`, `CHANGELOG.md`, Cursor design supersession note, and a new G-P1 checkpoint in `PLAN.md`: actual behavior and final gate evidence only.

## Acceptance gate G-P1

- Reproduce each bug with failing tests before its minimal implementation; save RED and GREEN evidence outside the source tree. Tests should fail for the defect, not an unrelated import/type error.
- #1: synthetic parent env/auth/cache/preload canaries cannot cross the packaged CLI boundary; actual canonical/subset/empty/invalid-argv checks remain; private directories cleaned after success/failure; hung/overflowing child bounded; no provider transport called.
- #2: the production reader observes a token committed to an open, uncheckpointed WAL; DB and WAL contents unchanged by the read; special-character paths target the right file; ordinary missing/unreadable/busy/malformed cases remain value-free with env fallback. A real Cursor re-login smoke remains a separately approved follow-up, not an automated-test claim.
- #3: pre-abort, mid-child abort, timeout, stdout/stderr byte overflow (including multibyte input), spawn failure, close-vs-abort races, and ordinary success settle safely. Real subprocess tests prove termination and reaping; other providers still finish; no post-abort discovery/fetch or raw stderr leakage.
- #4: stubbed lifecycle tests prove stale same-version archives cannot hide source changes; compact/reindented JSON works; failed build/zip/missing archive stops before package-tool invocation. No test invokes the real installer. Preserve package type and quoting/CDPATH/uninstall protections.
- Sequential private-HOME/minimal-env gates: Node tests, QML tests, typecheck, Plasma validation, artifact build/check. Keep full evidence and final counts; independent cross-cutting review before publication.
- No source change outside these four issues without recording and approving the scope separately. No paid/hosted CI, tag, release, or desktop deployment.
