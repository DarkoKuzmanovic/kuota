# Cursor Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth Kuota provider (`cursor`) that shows individual Cursor included-plan usage percent from the unofficial `GET /api/usage-summary` dashboard endpoint, with local-session-first auth and `CURSOR_SESSION_TOKEN` override.

**Architecture:** Mirror the Grok/Kimi adapter slice (auth → one bounded fetch → normalize → register). Auth reads Cursor’s `state.vscdb` via system `sqlite3` (no npm runtime dep), else env. Fetch sends a session cookie to `cursor.com`. Normalize to schema-v2 `ProviderRecord` with `details.cursor`. Plasma allowlists gain `cursor` like any other provider. Token never persists and never enters QML.

**Tech Stack:** TypeScript (Node ≥20, built-in `fetch` + test runner), system `sqlite3` CLI, QML/JS `.pragma library` modules, KConfigXT.

**Spec:** `docs/specs/2026-08-02-cursor-provider-design.md`

## Global Constraints

- Only normalized, secret-free JSON crosses the Plasma bridge; never log/echo session tokens, cookies, JWTs, or raw dashboard bodies.
- Optional contract fields omitted when unavailable — never `null` / invented percentages.
- No npm **runtime** dependencies (SQLite via system `sqlite3` only).
- Unofficial API: breakage → `auth-needed` / `error`, never fabricated quotas.
- Never write `~/.pi/agent/auth.json` for Cursor; never persist the token under `~/.cache/kuota/` or settings.
- Canonical order: `claude`, `codex`, `grok`, `kimi`, `cursor`.
- Schema stays at **v2** (additive provider ID only).
- Commit only files changed for this work; never `git add -A`. Run collector verification under temporary synthetic `HOME`. Clean `dist/` between Node and QML suites.
- Work on a feature branch (not bare `main`) unless the owner explicitly says otherwise. Prefer `systemctl --user restart plasma-plasmashell.service` for live reload — never `kquitapp6` + orphan `plasmashell`.

## File map

| Path | Responsibility |
|---|---|
| `docs/specs/2026-08-02-cursor-provider-recon.md` | Live recon notes (cookie shape, field units) — **no secrets** |
| `collector/src/contract/schema-v1.ts` | Add `cursor` to `PROVIDER_IDS` + `CursorDetails` types |
| `collector/src/contract/validate.ts` | Parse/correlate `details.cursor` |
| `plasmoid/contents/ui/collector-validator.js` | QML mirror |
| `collector/src/providers/cursor/auth.ts` | Local DB + env discovery |
| `collector/src/providers/cursor/fetch.ts` | Bounded `usage-summary` GET |
| `collector/src/providers/cursor/usage.ts` | Normalize to provider record |
| `collector/src/providers/cursor/adapter.ts` | Compose auth→fetch→parse |
| `collector/src/providers/registry.ts` | Register adapter |
| `collector/src/collect/config.ts` | Default-enable `cursor` |
| Plasma config/UI/models listed in Task 6 | Visibility, order, facts, icons |
| Docs / CHANGELOG / AGENTS / README | Scope + troubleshooting |

---

### Task 0: Live recon (cookie shape + wire units)

**Files:**
- Create: `docs/specs/2026-08-02-cursor-provider-recon.md`

**Interfaces:**
- Produces: documented cookie header format + confirmed JSON field units for fixtures in later tasks
- Consumes: local Cursor login / optional `CURSOR_SESSION_TOKEN`

- [ ] **Step 1: Extract token without printing it**

```bash
# Read-only; do NOT echo the token to the terminal or commit it.
TOKEN=$(sqlite3 "file:${HOME}/.config/Cursor/User/globalStorage/state.vscdb?mode=ro" \
  "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken' LIMIT 1;")
# Write length + jwt-ish shape only:
node -e 'const t=process.env.T||""; console.log({len:t.length, hasDot:t.includes("."), hasColon:t.includes(":")});' 
```

Pass `T` via env in the same shell without `echo "$TOKEN"`.

- [ ] **Step 2: Probe cookie shapes against usage-summary**

Try, in order, recording only HTTP status (never response body to logs if it might embed account email — redact or keep local):

1. `Cookie: WorkosCursorSessionToken=<accessToken as-is>`
2. If JWT has `sub`, also try `WorkosCursorSessionToken=<sub>%3A%3A<jwt>` and `WorkosCursorSessionToken=<sub>::<jwt>`

```bash
curl -sS -o /tmp/kuota-cursor-usage.json -w "%{http_code}\n" \
  'https://cursor.com/api/usage-summary' \
  -H "Cookie: WorkosCursorSessionToken=${TOKEN}"
```

Expected: one shape returns **200**. Others 401. Keep `/tmp/kuota-cursor-usage.json` local only; do not commit.

- [ ] **Step 3: Record recon (secret-free)**

Write `docs/specs/2026-08-02-cursor-provider-recon.md` with:

- Winning cookie format (describe, don’t paste token)
- Whether `individualUsage.plan.used`/`limit` are request counts or cents
- Whether `onDemand.used` is cents
- Sample **redacted** field tree (replace emails/ids with `synthetic-…`)
- Date + Node/sqlite3 versions

- [ ] **Step 4: Commit recon notes**

```bash
git add docs/specs/2026-08-02-cursor-provider-recon.md
git commit -m "$(cat <<'EOF'
docs: record Cursor usage-summary recon for provider adapter

Capture cookie shaping and field units without committing session secrets.
EOF
)"
```

**Stop if no cookie shape returns 200** — ask the owner before inventing auth.

---

### Task 1: Contract — add `cursor` provider ID + details

**Files:**
- Modify: `collector/src/contract/schema-v1.ts`
- Modify: `collector/src/contract/validate.ts`
- Modify: `plasmoid/contents/ui/collector-validator.js`
- Modify: `collector/test/contract/schema-v1.test.ts`
- Modify: `tests/qml/tst_collector_validator.qml` (+ fixtures helpers if needed)
- Modify: `scripts/check-artifact.js` expected ID list

**Interfaces:**
- Produces: `PROVIDER_IDS` includes `"cursor"`; `CursorDetails`; correlated validation
- Consumes: recon field names (units used only in later usage tests)

- [ ] **Step 1: Write failing identity / correlation tests**

In `collector/test/contract/schema-v1.test.ts`:

```typescript
test("schema v2 identity includes cursor after kimi", () => {
  assert.deepEqual([...PROVIDER_IDS], ["claude", "codex", "grok", "kimi", "cursor"]);
});

test("Cursor details are optional, namespaced, and correlated", () => {
  const valid = validateCollectorDocument(documentWith({
    id: "cursor",
    state: "ok",
    windows: [{ id: "plan", label: "Plan", used: 40, limit: 100, usedPercent: 40 }],
    details: { cursor: { membershipType: "pro", onDemandUsed: 120 } },
  }));
  const mismatched = validateCollectorDocument(documentWith({
    id: "cursor",
    state: "ok",
    details: { kimi: { concurrency: 1 } },
  }));
  assert.equal(valid.ok, true);
  assert.equal(mismatched.ok, false);
});
```

(`documentWith` must already emit `schemaVersion: 2`.)

- [ ] **Step 2: Run — expect RED**

```bash
rm -rf dist && npm test -- --test-name-pattern="includes cursor|Cursor details"
```

- [ ] **Step 3: Extend schema + validators**

In `schema-v1.ts`:

```typescript
export const PROVIDER_IDS = ["claude", "codex", "grok", "kimi", "cursor"] as const;

export interface CursorDetails {
  readonly membershipType?: string;
  readonly onDemandUsed?: number;
  readonly onDemandLimit?: number;
  readonly autoPercentUsed?: number;
  readonly apiPercentUsed?: number;
  readonly totalPercentUsed?: number;
}
```

Add `CursorProviderRecord`, union arms, non-empty details arms, static assert `_AssertCursor`.

In `validate.ts` / QML validator: allowlist keys, parse optional safe text + non-negative counts + percents `0..100`, correlate `id === "cursor"` ↔ `details.cursor`.

Update `scripts/check-artifact.js` to expect five IDs ending in `cursor`.

- [ ] **Step 4: Run contract + QML validator tests — expect GREEN**

```bash
rm -rf dist && npm test -- collector/test/contract/schema-v1.test.js
rm -rf dist && npm run test:qml -- tests/qml/tst_collector_validator.qml
```

- [ ] **Step 5: Commit**

```bash
git add collector/src/contract/schema-v1.ts collector/src/contract/validate.ts \
  plasmoid/contents/ui/collector-validator.js collector/test/contract/schema-v1.test.ts \
  tests/qml/tst_collector_validator.qml scripts/check-artifact.js
git commit -m "$(cat <<'EOF'
feat(contract): add cursor provider id and details namespace

Extend schema v2 with correlated details.cursor for the upcoming adapter.
EOF
)"
```

---

### Task 2: Auth discovery (sqlite3 + env)

**Files:**
- Create: `collector/src/providers/cursor/auth.ts`
- Create: `collector/test/providers/cursor/auth.test.ts`

**Interfaces:**
- Produces:

```typescript
export type CursorAuthResult =
  | { readonly state: "available"; readonly credential: { readonly kind: "session"; readonly value: string } }
  | { readonly state: "auth-needed"; readonly reason: "missing-local" | "missing-env" | "empty-token" }
  | { readonly state: "error"; readonly reason: "sqlite-unavailable" | "sqlite-failed" | "db-unreadable" };

export function readCursorAuth(options: {
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runSqlite?: (args: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
  readonly stateDbCandidates?: readonly string[];
}): Promise<CursorAuthResult>;
```

- Consumes: recon cookie **value** is the credential string; shaping into the Cookie header happens in fetch (or a tiny `formatSessionCookieValue` helper shared with fetch — prefer one place).

- [ ] **Step 1: Write failing auth tests**

```typescript
test("prefers local state.vscdb token over env", async () => {
  const result = await readCursorAuth({
    homeDirectory: "/tmp/synthetic-home",
    environment: { CURSOR_SESSION_TOKEN: "env-token-synthetic" },
    stateDbCandidates: ["/tmp/synthetic-home/.config/Cursor/User/globalStorage/state.vscdb"],
    runSqlite: async () => ({ code: 0, stdout: "local-token-synthetic\n", stderr: "" }),
  });
  assert.equal(result.state, "available");
  if (result.state === "available") assert.equal(result.credential.value, "local-token-synthetic");
});

test("falls back to CURSOR_SESSION_TOKEN when local missing", async () => {
  const result = await readCursorAuth({
    environment: { CURSOR_SESSION_TOKEN: "env-token-synthetic" },
    stateDbCandidates: ["/tmp/missing/state.vscdb"],
    runSqlite: async () => ({ code: 1, stdout: "", stderr: "unable to open" }),
  });
  assert.equal(result.state, "available");
});

test("auth-needed when local and env both unusable", async () => {
  const result = await readCursorAuth({
    environment: {},
    stateDbCandidates: ["/tmp/missing/state.vscdb"],
    runSqlite: async () => ({ code: 1, stdout: "", stderr: "" }),
  });
  assert.equal(result.state, "auth-needed");
});
```

Assert stringified results never contain the raw token beyond the credential object under test (no accidental logging helpers).

- [ ] **Step 2: Run — expect RED**

```bash
rm -rf dist && npm test -- collector/test/providers/cursor/auth.test.js
```

- [ ] **Step 3: Implement auth**

- Default candidates under `homeDirectory`:  
  `.config/Cursor/User/globalStorage/state.vscdb`,  
  `.config/cursor/User/globalStorage/state.vscdb`
- Default `runSqlite`: spawn `/usr/bin/sqlite3` with args  
  `["file:${dbPath}?mode=ro&immutable=1", "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken' LIMIT 1;"]`  
  (adjust immutable flag if recon shows lock issues — prefer `mode=ro` alone if needed)
- Trim stdout; reject empty
- Env key: `CURSOR_SESSION_TOKEN` only when local fails
- Never write files

- [ ] **Step 4: Run — expect GREEN**

```bash
rm -rf dist && npm test -- collector/test/providers/cursor/auth.test.js
```

- [ ] **Step 5: Commit**

```bash
git add collector/src/providers/cursor/auth.ts collector/test/providers/cursor/auth.test.ts
git commit -m "$(cat <<'EOF'
feat(collector): discover Cursor session from state DB or env

Read accessToken via sqlite3 without persisting credentials; fall back to CURSOR_SESSION_TOKEN.
EOF
)"
```

---

### Task 3: Fetch + usage normalize

**Files:**
- Create: `collector/src/providers/cursor/fetch.ts`
- Create: `collector/src/providers/cursor/usage.ts`
- Create: `collector/test/providers/cursor/fetch.test.ts`
- Create: `collector/test/providers/cursor/usage.test.ts`
- Create: `collector/test/providers/cursor/fetch-usage.integration.test.ts` (fetch fixture → parser)

**Interfaces:**
- Produces: `fetchCursorUsage`, `parseCursorUsageResponse`, constants for endpoint
- Consumes: recon cookie formatting + wire shape

- [ ] **Step 1: Write failing usage tests from recon shape**

Build a **synthetic** fixture matching recon field names (no live secrets):

```typescript
test("normalizes plan window and optional cursor details", () => {
  const parsed = parseCursorUsageResponse({
    billingCycleEnd: "2026-09-01T00:00:00.000Z",
    membershipType: "pro",
    individualUsage: {
      plan: { enabled: true, used: 40, limit: 100, remaining: 60 },
      onDemand: { enabled: true, used: 250, limit: null, remaining: null },
    },
  }, "2026-08-02T12:00:00.000Z");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.record.id, "cursor");
  assert.equal(parsed.record.windows?.[0]?.id, "plan");
  assert.equal(parsed.record.windows?.[0]?.usedPercent, 40);
  assert.equal(parsed.record.windows?.[0]?.resetAt, "2026-09-01T00:00:00.000Z");
});

test("omits invented percent when limit missing", () => { /* ... */ });
test("rejects empty recognition as not ok", () => { /* ... */ });
```

Adjust numeric expectations to recon units (if `used`/`limit` are cents, fixtures use cents; compact still gets a percent).

- [ ] **Step 2: Write failing fetch classification tests**

Mirror Kimi/Grok: 401→auth-needed, timeout, oversize, invalid JSON, cookie header uses recon format, **token never appears in thrown messages**.

- [ ] **Step 3: Run — expect RED**

```bash
rm -rf dist && npm test -- collector/test/providers/cursor/usage.test.js collector/test/providers/cursor/fetch.test.js
```

- [ ] **Step 4: Implement fetch + usage**

```typescript
export const CURSOR_USAGE_SUMMARY_ENDPOINT = "https://cursor.com/api/usage-summary" as const;
```

- Cookie header only; `Origin: https://cursor.com` not required for GET per community docs (skip unless recon shows otherwise)
- Body read bounds like Kimi (`256 KiB` default)
- `formatSessionCookieValue(token)` applies recon shaping in **one** function

- [ ] **Step 5: Add fetch→parser bridge test**

One test: realistic fetch JSON fixture → `parseCursorUsageResponse` → schema-valid `ok` record with plan window (guards wire-shape divergence per G11 B1 lesson).

- [ ] **Step 6: Run — expect GREEN**

```bash
rm -rf dist && npm test -- collector/test/providers/cursor/
```

- [ ] **Step 7: Commit**

```bash
git add collector/src/providers/cursor/fetch.ts collector/src/providers/cursor/usage.ts \
  collector/test/providers/cursor/
git commit -m "$(cat <<'EOF'
feat(collector): fetch and normalize Cursor usage-summary

Map unofficial dashboard plan usage into a schema-valid cursor provider record.
EOF
)"
```

---

### Task 4: Adapter + registry + defaults

**Files:**
- Create: `collector/src/providers/cursor/adapter.ts`
- Create: `collector/test/providers/cursor/adapter.test.ts`
- Modify: `collector/src/providers/registry.ts`
- Modify: `collector/test/providers/registry.test.ts`
- Modify: `collector/src/collect/config.ts`
- Modify: `collector/test/collect/config.test.ts`
- Modify: `collector/test/cli.test.ts` / integrated tests as needed for five providers

**Interfaces:**
- Produces: `createCursorAdapter()` registered as `"cursor"`

- [ ] **Step 1: Write failing adapter + registry tests**

```typescript
test("cursor adapter returns auth-needed without credentials", async () => {
  const adapter = createCursorAdapter({
    readAuth: async () => ({ state: "auth-needed", reason: "missing-env" }),
  });
  const result = await adapter.collect({ signal: AbortSignal.timeout(1000), dependencies: {} });
  assert.equal(result.state, "auth-needed");
});

test("registry canonical order ends with cursor", () => {
  assert.deepEqual(canonicalIds, ["claude", "codex", "grok", "kimi", "cursor"]);
});
```

- [ ] **Step 2: Run — expect RED**

- [ ] **Step 3: Implement adapter (Grok pattern) + register + default-enable**

```typescript
export function createCursorAdapter(dependencies: CursorAdapterDependencies = {}): ProviderAdapter<"cursor", CursorAdapterDependencies> {
  // auth → fetch → parse; catch → error; never throw secrets
}
```

Update `DEFAULT_ENABLED_PROVIDER_IDS` to include `"cursor"`.

- [ ] **Step 4: Run registry/config/adapter/cli focused tests — expect GREEN**

```bash
rm -rf dist && HOME="$(mktemp -d)" npm test -- \
  collector/test/providers/cursor/adapter.test.js \
  collector/test/providers/registry.test.js \
  collector/test/collect/config.test.js
```

- [ ] **Step 5: Commit**

```bash
git add collector/src/providers/cursor/adapter.ts collector/test/providers/cursor/adapter.test.ts \
  collector/src/providers/registry.ts collector/test/providers/registry.test.ts \
  collector/src/collect/config.ts collector/test/collect/config.test.ts \
  collector/test/cli.test.ts collector/test/collect/integrated-collect.test.ts
git commit -m "$(cat <<'EOF'
feat(collector): register Cursor adapter in canonical provider order

Enable cursor by default beside Claude, Codex, Grok, and Kimi.
EOF
)"
```

---

### Task 5: Plasma config, command, models, UI

**Files:**
- Modify: `plasmoid/contents/ui/config-model.js`
- Modify: `plasmoid/contents/config/main.xml`
- Modify: `plasmoid/contents/ui/configProviders.qml`
- Modify: `plasmoid/contents/ui/configTheming.qml`
- Modify: `plasmoid/contents/ui/collector-command.js`
- Modify: `plasmoid/contents/ui/compact-model.js`
- Modify: `plasmoid/contents/ui/full-model.js`
- Modify: `plasmoid/contents/ui/CompactRepresentation.qml`
- Modify: `plasmoid/contents/ui/FullRepresentation.qml`
- Modify: QML tests that list providers / order / facts

**Interfaces:**
- Produces: `cursor` in `KNOWN_PROVIDERS`; `cursorFacts()` closed allowlist; labels `"Cursor"`

- [ ] **Step 1: Write / update failing QML tests**

- `KNOWN_PROVIDERS` ends with `cursor`
- sanitize keeps `cursor` in order
- `collector-command` allowlists `cursor`
- full-model facts: membership / on-demand only from `details.cursor`
- compact label `"Cursor"`

- [ ] **Step 2: Run — expect RED**

```bash
rm -rf dist && npm run test:qml -- tests/qml/tst_config_model.qml tests/qml/tst_full_model.qml tests/qml/tst_collector_command.qml
```

- [ ] **Step 3: Wire Plasma**

Defaults: `cursorVisible: true`; `providerOrder` includes `cursor`; accent/icon entries; icon case (reuse a generic icon name if no custom asset — e.g. `input-keyboard` or existing pattern).

`full-model.js`:

```javascript
function cursorFacts(d) {
    var facts = [];
    pushStringFact(facts, "Plan", d.membershipType); // or "Membership"
    // on-demand as dollars if cents: format carefully; omit if absent
    return facts;
}
```

- [ ] **Step 4: Run QML suites — expect GREEN**

```bash
rm -rf dist && npm run test:qml
npm run validate:plasma
```

- [ ] **Step 5: Commit**

```bash
git add plasmoid/contents/ui plasmoid/contents/config/main.xml tests/qml
git commit -m "$(cat <<'EOF'
feat(plasmoid): add Cursor to config, compact, and full views

Surface plan usage percent and closed-allowlist cursor details in the widget.
EOF
)"
```

---

### Task 6: Docs + CHANGELOG + scope amendment

**Files:**
- Modify: `CHANGELOG.md` (Unreleased — Added)
- Modify: `AGENTS.md` providers table + IDs
- Modify: `README.md` credentials/troubleshooting
- Modify: `docs/architecture/collector-contract.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/specs/2026-07-10-kuota-design.md` (short amendment note)
- Modify: `PLAN.md` top-level scope only
- Modify: `plasmoid/metadata.json` Description to mention Cursor

- [ ] **Step 1: Update CHANGELOG**

```markdown
### Added

- **Cursor provider (unofficial).** Shows included plan usage from Cursor’s
  dashboard `usage-summary` endpoint. Auth: local Cursor `state.vscdb` session
  first, else `CURSOR_SESSION_TOKEN`. Not an official individual API — may break
  without notice (see design + recon docs).
```

- [ ] **Step 2: README troubleshooting**

Document: install `sqlite3`, sign into Cursor app, or export session cookie to `CURSOR_SESSION_TOKEN`; never commit the token.

- [ ] **Step 3: Residual grep**

```bash
rg -n 'PROVIDER_IDS|KNOWN_PROVIDERS|claude", "codex", "grok", "kimi"' collector plasmoid scripts \
  | rg -v cursor | head
```

Expected: no stale four-provider allowlists in production paths.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md AGENTS.md README.md docs PLAN.md plasmoid/metadata.json
git commit -m "$(cat <<'EOF'
docs: document Cursor provider and unofficial API risk

Amend scope, contract, and troubleshooting for the fifth provider.
EOF
)"
```

---

### Task 7: Full verification gate (+ optional live smoke)

**Files:** none unless fixes

- [ ] **Step 1: Synthetic HOME full Node suite**

```bash
rm -rf dist
HOME="$(mktemp -d)" npm test
npx tsc --noEmit -p tsconfig.json
```

Expected: all pass.

- [ ] **Step 2: QML + Plasma + artifact**

```bash
rm -rf dist && npm run test:qml
npm run validate:plasma
HOME="$(mktemp -d)" npm run build:artifact
HOME="$(mktemp -d)" node scripts/check-artifact.js
```

Expected: packaged CLI document includes `"id":"cursor"` among providers (likely `auth-needed` under synthetic HOME).

- [ ] **Step 3: Optional live smoke (owner machine only)**

```bash
HOME="$HOME" node dist/collector/cli.js --enabled-providers=cursor
```

Inspect: one JSON doc, `cursor` state `ok` with plan window when signed in; **do not paste token-bearing logs into commits/chat**.

- [ ] **Step 4: Install/reload widget**

```bash
scripts/update.sh
systemctl --user restart plasma-plasmashell.service
```

- [ ] **Step 5: Commit gate fixes if any**

---

## Spec coverage self-check

| Spec requirement | Task |
|---|---|
| Recon cookie shape + units | 0 |
| Schema `cursor` + details | 1 |
| Local DB then env auth; no persistence | 2 |
| `usage-summary` fetch + plan primary window | 3 |
| Adapter/registry/defaults | 4 |
| Plasma UI/config | 5 |
| Docs / scope / unofficial risk | 6 |
| Full gate | 7 |
| No Admin API / no event pagination / no auth.json | Non-goals |

## Placeholder / consistency notes

- Cookie formatting lives in one helper used by fetch (and tests); auth returns the raw discovered string only.
- If recon shows plan `used`/`limit` are already percent-like, still compute `usedPercent` only when both counts exist and `limit > 0`.
- Do not bump schema version for this additive ID.
