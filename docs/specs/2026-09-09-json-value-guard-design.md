# One pure JSON-value guard — issue #6

**Status:** implementation approved by the owner's 2026-09-09 chat directive:
“Let's do in that order #7 -> #5 -> #6. then we check and do the 8 and 9 later”.
**Gate:** G-R6, after G-R7 and G-R5 parent verification and independent PASS.
**Scope:** behavior-preserving extraction only. No schema, provider, settings,
filesystem policy, live account access, publication or deployment change.
#8/#9 remain deferred until the owner checks this completed batch.

## Problem / verified baseline

`collector/src/io/json-file.ts` and `atomic-write.ts` export separate
`isJsonValue` implementations with the same intended descriptor-aware iterative
graph validation. Both trace by blame to `f19ca90b`; they are not text-identical
and equivalence must be tested before one copy is removed. Existing JSON types
are owned by json-file. Imports through both legacy paths must keep working.

The #5 reviewed tree is `8b118022fe77b83f2635efbd57465616a00f7c89`.
Parent full gates passed on Node 24.15.0 and minimum 20.0.0: 651 Node / 380 QML,
zero failures; independent review passed. #7 selection behavior and #5 metadata
must remain unchanged. Their source changes are uncommitted in this worktree;
HEAD alone is not the #6 baseline. The unrelated local M15 commit is excluded.

## Decisions

| Decision | Required shape |
| --- | --- |
| D-R6.1 — Pure owner | Move the JSON types and one equivalent existing iterative guard into `collector/src/io/json-value.ts`. No filesystem, provider, Node runtime or QML imports; no dependency or registry framework. |
| D-R6.2 — Compatibility | Both legacy modules import/re-export the same function object; keep legacy type exports and the json-file narrowing predicate. Preserve callable compatibility at atomic-write; a typed alias is acceptable if needed, not a wrapper or second guard. |
| D-R6.3 — Algorithm | Preserve primitive/finite-number rules, same-realm ordinary/null-prototype records, ordinary arrays, active-path cycle detection, descriptor/own-key checks, accessor avoidance and defensive catches. Preserve sparse-array acceptance and repeated noncyclic subtrees. Do not replace the guard with JSON.stringify/parse or recursion. |
| D-R6.4 — Proxy limits | Reflective operations can execute proxy traps; revoked/throwing/invariant-violating traps retain the existing failure behavior. Do not claim all user code is avoided, ban proxies, invoke getters, or expand acceptance as part of extraction. |
| D-R6.5 — I/O boundaries | Keep read/update/atomic-write/cache error mapping, serialization timing and all ownership, trusted-parent, no-follow, CAS identity, permission, temp, fsync, rename and cleanup code unchanged outside necessary imports/exports/extraction. A valid graph can still fail serialization; it must fail before filesystem work exactly as before. |
| D-R6.6 — Tests, not duplicate oracles | Use one permanent synthetic factory corpus with independent expected outcomes. Capture old-old and old-new parity using external baseline artifacts; do not retain an old production guard copy in the permanent tests or add a generic test framework. |

## Per-file shape

- New `collector/src/io/json-value.ts`: types, optional tiny index-key helper,
  and the shared predicate only. Extract rather than re-design the algorithm.
- `json-file.ts` and `atomic-write.ts`: import/export the shared binding, remove
  duplicate guard/type definitions. Preserve the remainder byte-for-byte where
  practical; unrelated indentation cleanup is out of scope. No circular runtime
  dependency from the new pure leaf back to either I/O module.
- Focused tests under `collector/test/io/`: a small shared corpus/factory helper
  if justified, compatibility-export identity and type-use checks, pure guard
  behavior with a deep graph, accessors, symbols, sparse arrays, cycles/shared
  subtrees, invalid prototypes and adversarial proxies. Every guard invocation
  gets a fresh fixture so proxy counters/mutations cannot contaminate comparison.
- Existing I/O/cache tests: add only any missing real-call-path regression for
  malformed JSON/update input, guard failure before I/O, and JSON.stringify
  failure after guard acceptance. Preserve existing permission/CAS/durability
  tests and secret-safe errors; do not widen auth fixtures or read real files.
- Architecture overview and PLAN.md: record the actual pure ownership and gate
  evidence. Whole-document TS/QML validators and native parsers remain separate;
  sharing the JSON-value guard is not a schema-validator consolidation.

## Worker evidence

Exact starting tree: `2a5d245e212157223ffbe34ab38c2b8055922c22`. External
`../evidence/issue6-worker/` retains the original git blobs, blame, separately
compiled pinned oracle, fresh-factory differential records and raw gate logs.
Old-old characterization: 73/0 (70 corpus cases plus three boundary/type tests).
Existing-export identity RED: 73/1; shared-binding GREEN: 74/0. Each Node
24.15.0 and minimum 20.0.0 differential executes five guards on 70 fresh cases
(350 executions, 70 old-old and 210 old-new comparisons), zero mismatches in
values, throws or recorded trap/getter counters. Both six-gate runs pass:
726 Node / 380 QML, zero failures. Node totals include the corpus module smoke
test discovered by the existing runner. Fixed QML bridge runtime remains
`/usr/bin/node` 26.8.1. Parent verification and the subsequent independent
#6/combined-range review passed; see the final G-R6 closure in PLAN.md.
Reviewed tree: `a3bac205dbced636947298d2ee210dfcc6d10ecb`. Post-review changes
are acceptance/status documentation and removal of one redundant final LF from
the helper. Recompiled JavaScript is byte-identical; tests/artifact unchanged.
See G-R6 and `../evidence/final-format-verification.json` for that proof.

## Acceptance / exit gate

- [x] Test-first characterization observes old-old parity over named semantic
  cases, with outcomes and side-effect counters captured before extraction.
- [x] The existing legacy exports fail a same-function identity assertion
  before extraction, then pass afterward. Missing import/module/compile failures
  are not accepted as behavioral RED. Already-preserved behavior starts GREEN.
- [x] Both legacy paths and the new helper retain expected behavior on the
  corpus. Pinned old/new differential execution has zero unexplained mismatches.
- [x] Deep acyclic data/shared subtrees and sparse arrays retain behavior;
  cycles, invalid values/descriptors/prototypes and bad proxy operations fail
  as before. No property getter invocation is introduced.
- [x] Public exports/narrowing compile, the helper has no runtime dependencies,
  and there is one production graph-validator implementation with no new cycle.
- [x] Real read/update/atomic-write/cache paths retain their rejection and
  value-free errors, including serialize failure before any filesystem call.
- [x] Sequential isolated full Node/QML, typecheck, Plasma and artifact gates
  pass on Node 24.15.0 and minimum 20.0.0. Parent verifies exact source identity,
  independence of #7/#5 behavior, and unchanged filesystem protections.
- [x] Independent review covers #6 plus the combined public-base→batch range;
  no blocking findings remain. Record bounded counters and stop for the owner's
  check without committing, publishing, installing or starting #8/#9.

> **2026-10-08 landing note** — Merged onto 2.0.0 (M15–M17) with these
> decisions unchanged. M17 did not touch `collector/src/io/`, and this guard is
> still the only JSON-graph validator in `collector/src`. `../evidence/` paths
> above now live under `.worktrees/feat-review-7-5-6-evidence/evidence/`
> (local, untracked). Landing gates and review: PLAN.md "G-RL".
