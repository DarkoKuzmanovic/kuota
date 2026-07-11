import assert from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { scanForSecrets } from '../../collector/src/security/redact.js';


const NORMALIZED_FIXTURE_DIRECTORY = findNormalizedFixtureDirectory();

/**
 * Fixture safety policy tests.
 *
 * Enforces that all test fixtures are secret-free. Seeded credential
 * examples must be rejected; approved clearly synthetic usage fixtures
 * must pass. No real credentials are required or used.
 */

function assertUnsafe(fixture: unknown, label: string): void {
  const findings = scanForSecrets(fixture);
  assert.ok(
    findings.length > 0,
    `Fixture "${label}" should be rejected but scanForSecrets found nothing`,
  );
}

function assertSafe(fixture: unknown, label: string): void {
  const findings = scanForSecrets(fixture);
  assert.strictEqual(
    findings.length,
    0,
    `Fixture "${label}" should be safe but had findings: ${JSON.stringify(findings)}`,
  );
}

test('automatically scans every normalized JSON fixture for secrets', () => {
  const fixturePaths = normalizedJsonFiles(NORMALIZED_FIXTURE_DIRECTORY);
  assert.ok(fixturePaths.length > 0, 'normalized fixture directory must contain JSON files');

  for (const fixturePath of fixturePaths) {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
    assertSafe(fixture, relative(NORMALIZED_FIXTURE_DIRECTORY, fixturePath));
  }
});

// ---------------------------------------------------------------------------
// Rejects seeded credentials
// ---------------------------------------------------------------------------

describe('fixture safety — rejects seeded credentials', () => {
  test('rejects authorization header', () => {
    assertUnsafe(
      { headers: { Authorization: 'Bearer test-token-abc' } },
      'authorization header',
    );
  });

  test('rejects bearer token value', () => {
    assertUnsafe(
      { config: { bearer: 'Bearer abc123def456ghi789' } },
      'bearer token',
    );
  });

  test('rejects access token', () => {
    assertUnsafe(
      { auth: { type: 'oauth', access: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig' } },
      'access token',
    );
  });

  test('rejects refresh token', () => {
    assertUnsafe(
      { auth: { type: 'oauth', refresh: 'rt_abc123def456ghi789jkl012' } },
      'refresh token',
    );
  });

  test('rejects account identifier (non-synthetic)', () => {
    assertUnsafe(
      { provider: 'codex', accountId: 'org-abc123def456' },
      'non-synthetic account id',
    );
  });

  test('rejects private key value', () => {
    assertUnsafe(
      {
        cert: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
      },
      'private key',
    );
  });

  test('rejects credential-shaped value (API key prefix)', () => {
    assertUnsafe(
      { note: 'Using key sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      'API key prefix',
    );
  });

  test('rejects nested secret metadata', () => {
    assertUnsafe(
      {
        provider: 'claude',
        metadata: {
          headers: { Authorization: 'Bearer nested-secret-token' },
          auth: { access: 'nested-access-token-value', refresh: 'nested-refresh-token-value' },
        },
      },
      'nested secret metadata',
    );
  });

  test('rejects secrets in arrays', () => {
    assertUnsafe(
      [{ id: 'claude', token: 'secret-token' }],
      'secret in array element',
    );
  });

  test('rejects api_key key field', () => {
    assertUnsafe(
      { auth: { type: 'api_key', key: 'some-api-key-value' } },
      'api key field',
    );
  });

  test('rejects password field', () => {
    assertUnsafe(
      { config: { password: 'supersecret123' } },
      'password field',
    );
  });

  test('rejects OpenAI-style API key prefix', () => {
    assertUnsafe(
      { note: 'Key is sk-1234567890abcdef1234567890abcdef' },
      'OpenAI API key prefix',
    );
  });

  test('rejects bare JWT in fixture value', () => {
    assertUnsafe(
      {
        note: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      },
      'bare JWT value',
    );
  });

  test('rejects non-synthetic numeric account identifier', () => {
    assertUnsafe(
      { provider: 'codex', accountId: 123456789 },
      'numeric account id',
    );
  });

  test('rejects secret key in Error custom property', () => {
    class CustomError extends Error {
      readonly token: string;
      constructor(token: string) {
        super('Custom error');
        this.name = 'CustomError';
        this.token = token;
      }
    }
    const error = new CustomError('some-token-value');
    assertUnsafe(error, 'error with secret custom property');
  });
});

// ---------------------------------------------------------------------------
// Approves synthetic fixtures
// ---------------------------------------------------------------------------

describe('fixture safety — approves synthetic fixtures', () => {
  test('passes clean multi-provider usage fixture', () => {
    assertSafe(
      {
        schemaVersion: 1,
        collectedAt: '2026-07-11T00:00:00.000Z',
        providers: [
          {
            id: 'claude',
            state: 'ok',
            lastSuccessAt: '2026-07-11T00:00:00.000Z',
            windows: [
              {
                id: 'short-term',
                label: '5-hour window',
                percentUsed: 42.5,
                resetAt: '2026-07-11T05:00:00.000Z',
              },
            ],
          },
          {
            id: 'codex',
            state: 'ok',
            lastSuccessAt: '2026-07-11T00:00:00.000Z',
            windows: [
              {
                id: 'primary',
                label: 'Primary quota',
                percentUsed: 30.0,
                used: 300,
                limit: 1000,
                resetAt: '2026-07-12T00:00:00.000Z',
              },
            ],
          },
          {
            id: 'umans',
            state: 'ok',
            lastSuccessAt: '2026-07-11T00:00:00.000Z',
            windows: [
              {
                id: 'rolling',
                label: 'Rolling window',
                used: 150,
                limit: 1000,
                resetAt: '2026-07-11T12:00:00.000Z',
              },
            ],
          },
        ],
      },
      'clean usage fixture',
    );
  });

  test('passes fixture with synthetic account identifier', () => {
    assertSafe(
      {
        provider: 'codex',
        accountId: 'test-account-0001',
        windows: [{ label: 'Primary', used: 100, limit: 1000 }],
      },
      'synthetic account id fixture',
    );
  });

  test('passes fixture with all-zeros UUID account id', () => {
    assertSafe(
      {
        provider: 'codex',
        accountId: '00000000-0000-0000-0000-000000000000',
        windows: [],
      },
      'all-zeros account id fixture',
    );
  });

  test('passes error and auth-needed state fixture', () => {
    assertSafe(
      {
        schemaVersion: 1,
        providers: [
          { id: 'claude', state: 'error', statusText: 'Network timeout' },
          { id: 'codex', state: 'auth-needed', statusText: 'Authentication required' },
        ],
      },
      'error state fixture',
    );
  });

  test('passes unlimited plan fixture', () => {
    assertSafe(
      {
        provider: 'umans',
        state: 'ok',
        windows: [
          {
            id: 'rolling',
            label: 'Rolling window',
            used: 150,
            resetAt: '2026-07-11T12:00:00.000Z',
          },
        ],
      },
      'unlimited plan fixture',
    );
  });

  test('passes stale state fixture', () => {
    assertSafe(
      {
        provider: 'claude',
        state: 'stale',
        lastSuccessAt: '2026-07-10T00:00:00.000Z',
        windows: [{ id: 'short-term', label: '5-hour window', percentUsed: 42.5 }],
      },
      'stale state fixture',
    );
  });

  test('passes fixture with zero numeric account identifier', () => {
    assertSafe(
      { provider: 'codex', accountId: 0, windows: [] },
      'zero numeric account id fixture',
    );
  });
});

function normalizedJsonFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return normalizedJsonFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith('.json') ? [entryPath] : [];
    })
    .sort();
}

function findNormalizedFixtureDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = resolve(directory, 'tests/fixtures/normalized');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('Could not locate tests/fixtures/normalized from the compiled test');
    }
    directory = parent;
  }
}
