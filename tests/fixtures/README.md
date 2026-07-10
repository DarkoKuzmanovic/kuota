# Test Fixture Policy

All test fixtures in the Kuota project must be **synthetic and recognizable as non-secrets**. No real credentials, tokens, account identifiers, or auth files may be used in or referenced by any fixture.

## Rules

1. **No real credentials.** Fixtures must never contain real bearer tokens, access tokens, refresh tokens, API keys, passwords, private keys, or account identifiers. If a fixture needs a credential-shaped value, it must be clearly synthetic (e.g. `test-token`, `synthetic-key`, `00000000-0000-0000-0000-000000000000`).

2. **No real auth files.** Tests must never read `~/.pi/agent/auth.json` or any other real credential file. All auth-shaped data must be inline synthetic fixtures.

3. **Synthetic markers.** Account identifiers in fixtures should contain a synthetic marker (`test`, `synthetic`, `example`, `dummy`, `fake`, `placeholder`, `sample`) or be an all-zeros UUID. The scanner (`scanForSecrets`) treats values containing these markers as safe.

4. **Automated safety scan.** Every fixture must pass `scanForSecrets()` with zero findings. The fixture safety tests in `tests/security/fixture-safety.test.ts` enforce this by seeding credential examples (which must fail) and approving synthetic fixtures (which must pass).

5. **Scanner findings are safe.** `scanForSecrets` findings contain only dot-separated paths and generic reasons — never raw secret values or account identifiers.

6. **Redaction covers all output paths.** The `redact()` helper replaces secret keys, account identifiers, credential-shaped string values, and raw response bodies. It handles nested objects, arrays, and Error custom metadata. Use it for all stderr, logs, and safe status text.

7. **Fail-safe redaction of generic key names.** Fields literally named `key` or `token` are intentionally flagged by the scanner and redacted by `redact()`, even when the value is benign. This is a deliberate fail-safe: over-redacting a harmless field is preferable to leaking a real credential whose key happened to be generic. Safe fixtures must avoid those field names unless the fixture intentionally verifies rejection behavior.

## How to verify

```bash
npm test
```

The test suite includes:
- `collector/test/security/redact.test.ts` — redaction and scanner unit tests
- `tests/security/fixture-safety.test.ts` — fixture safety policy enforcement
