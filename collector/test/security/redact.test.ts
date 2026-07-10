import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  redact,
  scanForSecrets,
  isSecretKey,
  isAccountIdKey,
  isSecretValue,
  isClearlySynthetic,
  REDACTED,
  REDACTED_BODY,
} from '../../src/security/redact.js';

// ---------------------------------------------------------------------------
// redact — secret key redaction
// ---------------------------------------------------------------------------

describe('redact — secret keys', () => {
  test('redacts authorization header', () => {
    const result = redact({ headers: { Authorization: 'Bearer abc123' } });
    assert.deepStrictEqual(result, { headers: { Authorization: REDACTED } });
  });

  test('redacts access token', () => {
    const result = redact({ access: 'eyJhbGciOiJIUzI1' });
    assert.deepStrictEqual(result, { access: REDACTED });
  });

  test('redacts refresh token', () => {
    const result = redact({ refresh: 'rt_abc123def456' });
    assert.deepStrictEqual(result, { refresh: REDACTED });
  });

  test('redacts api key', () => {
    const result = redact({ apiKey: 'sk-test123' });
    assert.deepStrictEqual(result, { apiKey: REDACTED });
  });

  test('redacts key field', () => {
    const result = redact({ key: 'some-api-key-value' });
    assert.deepStrictEqual(result, { key: REDACTED });
  });

  test('redacts password', () => {
    const result = redact({ password: 'hunter2' });
    assert.deepStrictEqual(result, { password: REDACTED });
  });

  test('redacts private key field', () => {
    const result = redact({ privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIB...' });
    assert.deepStrictEqual(result, { privateKey: REDACTED });
  });

  test('redacts secret', () => {
    const result = redact({ secret: 'client-secret-value' });
    assert.deepStrictEqual(result, { secret: REDACTED });
  });

  test('redacts credentials', () => {
    const result = redact({ credentials: { access: 'tok', refresh: 'rtok' } });
    assert.deepStrictEqual(result, { credentials: REDACTED });
  });

  test('redacts id_token', () => {
    const result = redact({ id_token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' });
    assert.deepStrictEqual(result, { id_token: REDACTED });
  });

  test('redacts idToken', () => {
    const result = redact({ idToken: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' });
    assert.deepStrictEqual(result, { idToken: REDACTED });
  });
});

// ---------------------------------------------------------------------------
// redact — nested structures
// ---------------------------------------------------------------------------

describe('redact — nested structures', () => {
  test('redacts secrets in deeply nested objects', () => {
    const input = { level1: { level2: { level3: { token: 'secret-value' } } } };
    const result = redact(input);
    assert.deepStrictEqual(result, {
      level1: { level2: { level3: { token: REDACTED } } },
    });
  });

  test('redacts secrets in arrays', () => {
    const input = [{ access: 'token1' }, { name: 'ok' }, { refresh: 'token2' }];
    const result = redact(input);
    assert.deepStrictEqual(result, [
      { access: REDACTED },
      { name: 'ok' },
      { refresh: REDACTED },
    ]);
  });

  test('redacts secrets in nested arrays within objects', () => {
    const input = { providers: [{ id: 'claude', auth: { access: 'secret' } }] };
    const result = redact(input);
    assert.deepStrictEqual(result, {
      providers: [{ id: 'claude', auth: { access: REDACTED } }],
    });
  });

  test('redacts secrets alongside non-secret data', () => {
    const input = {
      provider: 'claude',
      state: 'ok',
      percentUsed: 42.5,
      windows: [{ id: 'short-term', token: 'should-be-redacted' }],
    };
    const result = redact(input);
    assert.deepStrictEqual(result, {
      provider: 'claude',
      state: 'ok',
      percentUsed: 42.5,
      windows: [{ id: 'short-term', token: REDACTED }],
    });
  });
});

// ---------------------------------------------------------------------------
// redact — error handling
// ---------------------------------------------------------------------------

describe('redact — error handling', () => {
  test('preserves error name and message without stack', () => {
    const error = new Error('Something went wrong');
    const result = redact(error);
    const json = JSON.stringify(result);
    assert.ok(!json.includes('stack'), 'stack must not appear in output');
    assert.ok(json.includes('Error'), 'error name must appear');
    assert.ok(json.includes('Something went wrong'), 'message must appear');
  });

  test('redacts secret patterns in error message', () => {
    const error = new Error('Failed with Bearer sk-ant-realtoken123');
    const result = redact(error);
    const json = JSON.stringify(result);
    assert.ok(!json.includes('sk-ant-realtoken123'), 'token must not appear');
    assert.ok(!json.includes('Bearer'), 'Bearer must not appear');
  });

  test('redacts custom error properties', () => {
    class ApiError extends Error {
      readonly statusCode: number;
      readonly headers: Record<string, string>;
      constructor(message: string, statusCode: number, headers: Record<string, string>) {
        super(message);
        this.name = 'ApiError';
        this.statusCode = statusCode;
        this.headers = headers;
      }
    }
    const error = new ApiError('Unauthorized', 401, {
      Authorization: 'Bearer secret-token',
    });
    const result = redact(error);
    const json = JSON.stringify(result);
    assert.ok(!json.includes('secret-token'), 'token must not appear');
    assert.ok(json.includes('401'), 'status code should be preserved');
    assert.ok(json.includes('ApiError'), 'error name should be preserved');
  });

  test('redacts nested arrays in error custom metadata', () => {
    class CustomError extends Error {
      readonly items: Array<{ token: string; name: string }>;
      constructor(items: Array<{ token: string; name: string }>) {
        super('Custom error');
        this.name = 'CustomError';
        this.items = items;
      }
    }
    const error = new CustomError([
      { token: 'secret1', name: 'first' },
      { token: 'secret2', name: 'second' },
    ]);
    const result = redact(error);
    const json = JSON.stringify(result);
    assert.ok(!json.includes('secret1'), 'token must not appear');
    assert.ok(!json.includes('secret2'), 'token must not appear');
    assert.ok(json.includes('first'), 'non-secret data should be preserved');
    assert.ok(json.includes('second'), 'non-secret data should be preserved');
  });

  test('redacts body field in nested error metadata', () => {
    class HttpError extends Error {
      readonly response: { readonly body: string; readonly status: number };
      constructor(message: string, body: string, status: number) {
        super(message);
        this.name = 'HttpError';
        this.response = { body, status };
      }
    }
    const error = new HttpError(
      'Request failed',
      '{"access_token":"secret-jwt","account_id":"org-real123"}',
      401,
    );
    const result = redact(error);
    const json = JSON.stringify(result);
    assert.ok(!json.includes('secret-jwt'), 'token must not appear');
    assert.ok(!json.includes('org-real123'), 'account id must not appear');
    assert.ok(!json.includes('access_token'), 'raw body content must not appear');
    assert.ok(json.includes(REDACTED_BODY), 'body should be replaced');
    assert.ok(json.includes('401'), 'status should be preserved');
  });
});

// ---------------------------------------------------------------------------
// redact — raw response bodies
// ---------------------------------------------------------------------------

describe('redact — raw response bodies', () => {
  test('does not echo raw response body string', () => {
    const input = { response: 'raw HTTP response body with sensitive data' };
    const result = redact(input);
    const json = JSON.stringify(result);
    assert.ok(!json.includes('raw HTTP response body'), 'raw body must not appear');
    assert.ok(json.includes(REDACTED_BODY), 'should contain redacted body marker');
  });


  test('preserves non-body fields in response objects', () => {
    const input = {
      response: {
        status: 200,
        body: 'should-be-redacted',
        headers: { 'Content-Type': 'application/json' },
      },
    };
    const result = redact(input);
    const json = JSON.stringify(result);
    assert.ok(json.includes('200'), 'status should be preserved');
    assert.ok(json.includes('application/json'), 'content-type should be preserved');
    assert.ok(!json.includes('should-be-redacted'), 'body should be redacted');
  });

  test('redacts rawBody field', () => {
    const input = { rawBody: 'raw response text' };
    const result = redact(input);
    const json = JSON.stringify(result);
    assert.ok(json.includes(REDACTED_BODY), 'rawBody should be redacted');
    assert.ok(!json.includes('raw response text'), 'raw text must not appear');
  });

  test('replaces object body entirely without preserving content', () => {
    const input = { body: { access: 'secret-token', data: 'sensitive-info' } };
    const result = redact(input);
    const json = JSON.stringify(result);
    assert.ok(json.includes(REDACTED_BODY), 'body should be replaced');
    assert.ok(!json.includes('secret-token'), 'body content must not appear');
    assert.ok(!json.includes('sensitive-info'), 'body content must not appear');
  });
});

// ---------------------------------------------------------------------------
// redact — value patterns in strings
// ---------------------------------------------------------------------------

describe('redact — value patterns', () => {
  test('redacts Bearer token in string values', () => {
    const result = redact({ description: 'Using Bearer abc123def456 for auth' });
    const json = JSON.stringify(result);
    assert.ok(!json.includes('abc123def456'), 'token must not appear');
  });

  test('redacts private key block in string values', () => {
    const pemKey =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    const result = redact({ description: `Key: ${pemKey}` });
    const json = JSON.stringify(result);
    assert.ok(!json.includes('MIIEpAIBAAKCAQEA'), 'key content must not appear');
    assert.ok(!json.includes('BEGIN RSA PRIVATE KEY'), 'key header must not appear');
  });

  test('redacts Anthropic API key prefix in string values', () => {
    const result = redact({ note: 'Key: sk-ant-api03-xxxxxxxxxxxxxxxxxxxx' });
    const json = JSON.stringify(result);
    assert.ok(!json.includes('sk-ant-api03'), 'API key must not appear');
  });

  test('redacts OpenAI API key prefix in string values', () => {
    const result = redact({ note: 'Using sk-1234567890abcdef1234567890 for calls' });
    const json = JSON.stringify(result);
    assert.ok(!json.includes('sk-1234567890abcdef1234567890'), 'API key must not appear');
  });

  test('redacts bare JWT in string values', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = redact({ description: `Token: ${jwt}` });
    const json = JSON.stringify(result);
    assert.ok(!json.includes(jwt), 'JWT must not appear in output');
  });
});

// ---------------------------------------------------------------------------
// redact — safe values
// ---------------------------------------------------------------------------

describe('redact — safe values', () => {
  test('preserves non-secret values', () => {
    const input = { name: 'claude', state: 'ok', percentUsed: 45.2, enabled: true };
    const result = redact(input);
    assert.deepStrictEqual(result, input);
  });

  test('preserves null and undefined', () => {
    assert.strictEqual(redact(null), null);
    assert.strictEqual(redact(undefined), undefined);
  });

  test('preserves numbers and booleans', () => {
    assert.strictEqual(redact(42), 42);
    assert.strictEqual(redact(true), true);
  });

  test('preserves non-secret strings', () => {
    assert.strictEqual(redact('hello world'), 'hello world');
  });

  test('handles circular references', () => {
    const obj: Record<string, unknown> = { name: 'test' };
    obj.self = obj;
    const result = redact(obj);
    const json = JSON.stringify(result);
    assert.ok(json.includes('[CIRCULAR]'), 'circular reference should be replaced');
  });
});

// ---------------------------------------------------------------------------
// redact — account identifiers
// ---------------------------------------------------------------------------

describe('redact — account identifiers', () => {
  test('redacts accountId', () => {
    const result = redact({ accountId: 'org-abc123' });
    assert.deepStrictEqual(result, { accountId: REDACTED });
  });

  test('redacts orgId', () => {
    const result = redact({ orgId: 'org-xyz789' });
    assert.deepStrictEqual(result, { orgId: REDACTED });
  });

  test('redacts nested account identifier', () => {
    const input = { provider: { accountId: 'org-deep456' } };
    const result = redact(input);
    assert.deepStrictEqual(result, { provider: { accountId: REDACTED } });
  });
});

// ---------------------------------------------------------------------------
// scanForSecrets
// ---------------------------------------------------------------------------

describe('scanForSecrets', () => {
  test('finds secret key in flat object', () => {
    const findings = scanForSecrets({ authorization: 'Bearer test' });
    assert.ok(findings.length > 0);
    assert.ok(findings.some((f) => f.path === 'authorization'));
  });

  test('finds secret value pattern', () => {
    const findings = scanForSecrets({ note: 'Bearer abc123def456' });
    assert.ok(findings.length > 0);
  });

  test('finds secrets in nested objects', () => {
    const findings = scanForSecrets({ level1: { level2: { token: 'secret' } } });
    assert.ok(findings.some((f) => f.path.includes('token')));
  });

  test('finds non-synthetic account identifier', () => {
    const findings = scanForSecrets({ accountId: 'org-abc123def456' });
    assert.ok(findings.length > 0);
    assert.ok(findings.some((f) => f.path === 'accountId'));
  });

  test('does not flag clearly synthetic account identifier', () => {
    const findings = scanForSecrets({ accountId: 'test-account-001' });
    assert.strictEqual(findings.length, 0);
  });

  test('returns empty for clean fixture', () => {
    const findings = scanForSecrets({
      schemaVersion: 1,
      providers: [{ id: 'claude', state: 'ok', percentUsed: 42.5 }],
    });
    assert.strictEqual(findings.length, 0);
  });

  test('finds secrets in arrays', () => {
    const findings = scanForSecrets([{ token: 'secret1' }, { apiKey: 'secret2' }]);
    assert.ok(findings.length >= 2);
  });

  test('finds private key value', () => {
    const findings = scanForSecrets({
      note: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    });
    assert.ok(findings.length > 0);
  });

  test('finds Anthropic API key prefix', () => {
    const findings = scanForSecrets({
      note: 'Using sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    });
    assert.ok(findings.length > 0);
  });

  test('finds embedded Bearer token not at position 0', () => {
    const findings = scanForSecrets({ note: 'Using Bearer abc123def456 for auth' });
    assert.ok(findings.length > 0, 'embedded Bearer must be detected');
  });

  test('finds embedded OpenAI API key prefix', () => {
    const findings = scanForSecrets({ note: 'Key is sk-1234567890abcdef1234567890abcdef' });
    assert.ok(findings.length > 0, 'embedded API key must be detected');
  });

  test('finds embedded private key block', () => {
    const findings = scanForSecrets({
      note: 'Config: -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    });
    assert.ok(findings.length > 0, 'embedded private key must be detected');
  });

  test('findings never echo raw secret values', () => {
    const secret = 'Bearer super-secret-token-1234567890';
    const findings = scanForSecrets({ note: secret });
    const json = JSON.stringify(findings);
    assert.ok(findings.length > 0, 'should detect the secret');
    assert.ok(
      !json.includes('super-secret-token-1234567890'),
      'findings must not echo raw secret value',
    );
  });

  test('findings never echo raw account identifiers', () => {
    const accountId = 'org-real-identifier-123456';
    const findings = scanForSecrets({ accountId });
    const json = JSON.stringify(findings);
    assert.ok(findings.length > 0, 'should detect the account id');
    assert.ok(
      !json.includes(accountId),
      'findings must not echo raw account identifier',
    );
  });

  test('finds bare JWT value', () => {
    const findings = scanForSecrets({
      note: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    });
    assert.ok(findings.length > 0, 'bare JWT should be detected');
  });

  test('does not flag arbitrary dotted prose as JWT', () => {
    const findings = scanForSecrets({ note: 'hello.world.foo bar.baz' });
    assert.strictEqual(findings.length, 0);
  });

  test('flags secret key in Error custom property', () => {
    class CustomError extends Error {
      readonly token: string;
      constructor(token: string) {
        super('Custom error');
        this.name = 'CustomError';
        this.token = token;
      }
    }
    const error = new CustomError('some-token-value');
    const findings = scanForSecrets(error);
    assert.ok(findings.some((f) => f.path === 'token'), 'secret key in error should be flagged');
  });

  test('flags account ID in Error custom property', () => {
    class CustomError extends Error {
      readonly accountId: string;
      constructor(accountId: string) {
        super('Custom error');
        this.name = 'CustomError';
        this.accountId = accountId;
      }
    }
    const error = new CustomError('org-real-identifier-123456');
    const findings = scanForSecrets(error);
    assert.ok(findings.some((f) => f.path === 'accountId'), 'account id in error should be flagged');
  });

  test('Error custom property findings remain value-free', () => {
    class CustomError extends Error {
      readonly token: string;
      constructor(token: string) {
        super('Custom error');
        this.name = 'CustomError';
        this.token = token;
      }
    }
    const error = new CustomError('super-secret-value-123');
    const findings = scanForSecrets(error);
    const json = JSON.stringify(findings);
    assert.ok(findings.length > 0, 'should detect the secret key');
    assert.ok(!json.includes('super-secret-value-123'), 'findings must not echo raw value');
  });

  test('flags non-synthetic numeric account identifier', () => {
    const findings = scanForSecrets({ accountId: 123456 });
    assert.ok(findings.length > 0, 'numeric account id should be flagged');
    assert.ok(findings.some((f) => f.path === 'accountId'));
  });

  test('does not flag zero numeric account identifier', () => {
    const findings = scanForSecrets({ accountId: 0 });
    assert.strictEqual(findings.length, 0, 'zero account id should not be flagged');
  });
});

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

describe('isSecretKey', () => {
  test('identifies authorization', () => {
    assert.ok(isSecretKey('authorization'));
    assert.ok(isSecretKey('Authorization'));
  });

  test('identifies access token variants', () => {
    assert.ok(isSecretKey('access'));
    assert.ok(isSecretKey('accessToken'));
    assert.ok(isSecretKey('access_token'));
  });

  test('identifies refresh token variants', () => {
    assert.ok(isSecretKey('refresh'));
    assert.ok(isSecretKey('refreshToken'));
    assert.ok(isSecretKey('refresh_token'));
  });

  test('identifies api key variants', () => {
    assert.ok(isSecretKey('apiKey'));
    assert.ok(isSecretKey('api_key'));
  });

  test('identifies password and secret', () => {
    assert.ok(isSecretKey('password'));
    assert.ok(isSecretKey('secret'));
    assert.ok(isSecretKey('privateKey'));
    assert.ok(isSecretKey('private_key'));
  });

  test('does not flag non-secret keys', () => {
    assert.ok(!isSecretKey('name'));
    assert.ok(!isSecretKey('state'));
    assert.ok(!isSecretKey('percentUsed'));
    assert.ok(!isSecretKey('provider'));
    assert.ok(!isSecretKey('windows'));
  });

  test('identifies id_token variants', () => {
    assert.ok(isSecretKey('id_token'));
    assert.ok(isSecretKey('idToken'));
    assert.ok(isSecretKey('id-token'));
  });
});

describe('isAccountIdKey', () => {
  test('identifies accountId variants', () => {
    assert.ok(isAccountIdKey('accountId'));
    assert.ok(isAccountIdKey('account_id'));
  });

  test('identifies orgId variants', () => {
    assert.ok(isAccountIdKey('orgId'));
    assert.ok(isAccountIdKey('org_id'));
  });

  test('identifies userId variants', () => {
    assert.ok(isAccountIdKey('userId'));
    assert.ok(isAccountIdKey('user_id'));
  });

  test('does not flag non-id keys', () => {
    assert.ok(!isAccountIdKey('id'));
    assert.ok(!isAccountIdKey('name'));
    assert.ok(!isAccountIdKey('provider'));
  });
});

describe('isSecretValue', () => {
  test('detects Bearer token', () => {
    assert.ok(isSecretValue('Bearer abc123def456'));
  });

  test('detects private key block', () => {
    assert.ok(isSecretValue('-----BEGIN RSA PRIVATE KEY-----\nMIIB...'));
    assert.ok(isSecretValue('-----BEGIN EC PRIVATE KEY-----\nMHc...'));
  });

  test('detects Anthropic API key prefix', () => {
    assert.ok(isSecretValue('sk-ant-api03-xxxxxxxxxxxxxxxxxxxx'));
  });

  test('detects OpenAI API key prefix', () => {
    assert.ok(isSecretValue('sk-1234567890abcdef1234567890'));
  });

  test('does not flag normal strings', () => {
    assert.ok(!isSecretValue('hello world'));
    assert.ok(!isSecretValue('claude'));
    assert.ok(!isSecretValue('2026-07-11T00:00:00.000Z'));
  });

  test('detects bare JWT-shaped string', () => {
    assert.ok(isSecretValue(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ));
  });

  test('does not flag arbitrary dotted prose as JWT', () => {
    assert.ok(!isSecretValue('hello.world.foo'));
    assert.ok(!isSecretValue('some.description.text'));
    assert.ok(!isSecretValue('foo.bar.baz'));
  });
});

describe('isClearlySynthetic', () => {
  test('recognizes test marker', () => {
    assert.ok(isClearlySynthetic('test-account-001'));
  });

  test('recognizes synthetic marker', () => {
    assert.ok(isClearlySynthetic('synthetic-org-id'));
  });

  test('recognizes example marker', () => {
    assert.ok(isClearlySynthetic('example-account'));
  });

  test('recognizes dummy marker', () => {
    assert.ok(isClearlySynthetic('dummy-account'));
  });

  test('recognizes all-zeros UUID', () => {
    assert.ok(isClearlySynthetic('00000000-0000-0000-0000-000000000000'));
  });

  test('recognizes empty string as synthetic', () => {
    assert.ok(isClearlySynthetic(''));
  });

  test('does not treat real-looking values as synthetic', () => {
    assert.ok(!isClearlySynthetic('org-abc123def456'));
    assert.ok(!isClearlySynthetic('550e8400-e29b-41d4-a716-446655440000'));
    assert.ok(!isClearlySynthetic('org-production-123'));
  });

  test('does not treat words containing marker substrings as synthetic', () => {
    assert.ok(!isClearlySynthetic('greatest'));
    assert.ok(!isClearlySynthetic('latest'));
    assert.ok(!isClearlySynthetic('sampling'));
  });

  test('still recognizes marker at word boundary', () => {
    assert.ok(isClearlySynthetic('test-account'));
    assert.ok(isClearlySynthetic('my-test-value'));
  });
});
