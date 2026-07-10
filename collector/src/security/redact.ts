/**
 * Central redaction helper for collector diagnostics and safe status text.
 *
 * Ensures authorization headers, bearer/access/refresh tokens, account
 * identifiers, private-key/credential-shaped values, and raw response bodies
 * never appear in stderr, logs, or fixture output.
 *
 * Conventions (PLAN.md §15, §Conventions):
 * - Credentials never cross into QML/argv/stdout/stderr/logs.
 * - The collector owns redaction.
 * - Fixtures are synthetic and recognizable as non-secrets.
 */

/** Replacement value for redacted secret fields. */
export const REDACTED = '[REDACTED]';

/** Replacement value for raw HTTP response bodies. */
export const REDACTED_BODY = '[REDACTED_BODY]';

/** Maximum length for string values before truncation in diagnostics. */
const MAX_STRING_LENGTH = 500;

/** Replacement for circular references. */
const CIRCULAR = '[CIRCULAR]';

/** A finding produced by {@link scanForSecrets}. */
export interface SecretFinding {
  /** Dot-separated path to the flagged value (e.g. "headers.authorization"). */
  readonly path: string;
  /** Human-readable reason for the finding. Never includes raw secret values. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Key classification
// ---------------------------------------------------------------------------

/**
 * Key names whose values are always credentials or tokens.
 * Covers authorization headers, OAuth access/refresh/id-token fields, API
 * keys, passwords, secrets, private keys, and bearer tokens.
 *
 * Fail-safe policy: benign fields literally named `key` or `token` are
 * intentionally flagged and redacted. Over-redaction of a harmless field is
 * always preferable to leaking a real credential whose key happened to be
 * generic.
 */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /^authorization$/i,
  /^access$/i,
  /^access[_-]?token$/i,
  /^refresh$/i,
  /^refresh[_-]?token$/i,
  /^id[_-]?token$/i,
  /^token$/i,
  /^api[_-]?key$/i,
  /^key$/i,
  /^secret$/i,
  /^client[_-]?secret$/i,
  /^password$/i,
  /^passwd$/i,
  /^credential$/i,
  /^credentials$/i,
  /^private[_-]?key$/i,
  /^bearer$/i,
  /^bearer[_-]?token$/i,
];

/**
 * Key names whose values are account identifiers.
 * These must not appear in output, logs, or fixtures (unless clearly synthetic
 * in fixture context).
 */
const ACCOUNT_ID_KEY_PATTERNS: readonly RegExp[] = [
  /^account[_-]?id$/i,
  /^org[_-]?id$/i,
  /^organization[_-]?id$/i,
  /^workspace[_-]?id$/i,
  /^user[_-]?id$/i,
];

/**
 * Key names whose values are raw HTTP response bodies.
 * String, object, and array values for these keys are replaced entirely to
 * prevent echoing potentially large or secret-bearing response text.
 */
const RAW_BODY_KEY_PATTERNS: readonly RegExp[] = [
  /^body$/i,
  /^raw[_-]?body$/i,
  /^response[_-]?body$/i,
];

/**
 * Key names whose string values are raw HTTP responses.
 * Object values are recursively redacted (they may contain status, headers,
 * and body as separate fields).
 */
const RAW_RESPONSE_KEY_PATTERNS: readonly RegExp[] = [
  /^response$/i,
];

/** Check if a key name indicates a secret field (credential/token). */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

/** Check if a key name indicates an account identifier. */
export function isAccountIdKey(key: string): boolean {
  return ACCOUNT_ID_KEY_PATTERNS.some((re) => re.test(key));
}

/** Check if a key name indicates a raw response body field. */
function isRawBodyKey(key: string): boolean {
  return RAW_BODY_KEY_PATTERNS.some((re) => re.test(key));
}

/** Check if a key name indicates a raw response field. */
function isRawResponseKey(key: string): boolean {
  return RAW_RESPONSE_KEY_PATTERNS.some((re) => re.test(key));
}

// ---------------------------------------------------------------------------
// Value classification
// ---------------------------------------------------------------------------

/**
 * Patterns matching credential-shaped string values.
 * Patterns are not anchored to the start of the string so that embedded
 * credentials (e.g. "Using Bearer xyz in auth") are also detected.
 * Order matters: full private-key blocks are matched before bare BEGIN markers.
 *
 * The JWT pattern is bounded: it requires the first segment to start with `eyJ`
 * (the base64url encoding of `{"`, which every JWT header begins with) and
 * exactly three dot-separated base64url segments. This prevents arbitrary
 * dotted prose from being treated as a token.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN\s+\w+\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+\w+\s+PRIVATE\s+KEY-----/,
  /-----BEGIN\s+\w+\s+PRIVATE\s+KEY-----/,
  /Bearer\s+\S+/i,
  /sk-ant-[A-Za-z0-9_-]+/i,
  /sk-[A-Za-z0-9]{20,}/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
];

/**
 * Markers that identify a string value as clearly synthetic (safe for fixtures).
 * Account identifiers containing these markers are not flagged by the scanner.
 *
 * Markers are word-boundary aware: `test-account` matches, but `greatest` and
 * `latest` do not (the marker must appear as a distinct word, not as a
 * substring embedded in a larger word).
 */
const SYNTHETIC_MARKER_RE = /\b(?:test|synthetic|example|dummy|fake|placeholder|sample|not.?real)\b/i;

/** Matches all-zero UUIDs or numeric strings (obviously fake identifiers). */
const ALL_ZEROS_RE = /^0+(-0+)*$/;

/** Check if a string value matches known credential patterns. */
export function isSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

/** Check if a string value is clearly synthetic (safe for fixtures). */
export function isClearlySynthetic(value: string): boolean {
  if (value.length === 0) return true;
  if (SYNTHETIC_MARKER_RE.test(value)) return true;
  if (ALL_ZEROS_RE.test(value)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isError(value: unknown): value is Error {
  return value instanceof Error;
}

// ---------------------------------------------------------------------------
// scanForSecrets
// ---------------------------------------------------------------------------

/**
 * Scan a value for secrets, returning all findings.
 *
 * Used by fixture safety tests to verify no seeded credentials exist in
 * fixture data. An empty result means the value is safe.
 *
 * Findings never include raw secret or account-identifier values — only
 * safe paths and generic reasons.
 */
export function scanForSecrets(value: unknown): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  scanRecursive(value, '', findings, new WeakSet<object>());
  return findings;
}

/**
 * Check a key-value pair for secret/account-id findings and push to the
 * findings array. Used by both plain-object and Error-property scanning.
 * Findings never include raw values.
 */
function checkKeyForFindings(
  key: string,
  childValue: unknown,
  childPath: string,
  findings: SecretFinding[],
): void {
  if (isSecretKey(key)) {
    findings.push({ path: childPath, reason: 'secret key detected' });
  } else if (
    isAccountIdKey(key) &&
    typeof childValue === 'string' &&
    !isClearlySynthetic(childValue)
  ) {
    findings.push({
      path: childPath,
      reason: 'non-synthetic account identifier detected',
    });
  } else if (
    isAccountIdKey(key) &&
    typeof childValue === 'number' &&
    childValue !== 0
  ) {
    findings.push({
      path: childPath,
      reason: 'non-synthetic numeric account identifier detected',
    });
  }
}
function scanRecursive(
  value: unknown,
  path: string,
  findings: SecretFinding[],
  visited: WeakSet<object>,
): void {
  if (typeof value === 'string') {
    if (isSecretValue(value)) {
      findings.push({
        path: path || '<root>',
        reason: 'secret value pattern detected',
      });
    }
    return;
  }

  if (typeof value !== 'object' || value === null) {
    return;
  }

  if (visited.has(value)) {
    return;
  }
  visited.add(value);

  if (isError(value)) {
    const msgPath = path ? `${path}.message` : 'message';
    scanRecursive(value.message, msgPath, findings, visited);
    for (const [key, childValue] of Object.entries(value)) {
      if (key === 'name' || key === 'message' || key === 'stack') continue;
      const childPath = path ? `${path}.${key}` : key;

      checkKeyForFindings(key, childValue, childPath, findings);

      scanRecursive(childValue, childPath, findings, visited);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const childPath = path ? `${path}[${i}]` : `[${i}]`;
      scanRecursive(item, childPath, findings, visited);
    }
    return;
  }

  // Plain object
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const childValue = value[key];

      checkKeyForFindings(key, childValue, childPath, findings);

      scanRecursive(childValue, childPath, findings, visited);
    }
  }
}

// ---------------------------------------------------------------------------
// redact
// ---------------------------------------------------------------------------

/**
 * Redact secret patterns within a string value.
 *
 * - If `isRawBody` is true, the entire string is replaced with {@link REDACTED_BODY}.
 * - Otherwise, known credential patterns (Bearer tokens, private key blocks,
 *   API key prefixes, bare JWT tokens) are replaced with {@link REDACTED} inline.
 * - Long strings are truncated to prevent echoing large response text.
 */
function redactStringInternal(value: string, isRawBody: boolean): string {
  if (isRawBody) {
    return REDACTED_BODY;
  }

  let result = value;

  // Replace full private key blocks first (greedy across newlines)
  result = result.replace(
    /-----BEGIN\s+\w+\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+\w+\s+PRIVATE\s+KEY-----/g,
    REDACTED,
  );
  // Then replace any remaining BEGIN markers (truncated keys without END)
  result = result.replace(/-----BEGIN\s+\w+\s+PRIVATE\s+KEY-----/g, REDACTED);
  // Replace Bearer tokens
  result = result.replace(/Bearer\s+\S+/gi, REDACTED);
  // Replace Anthropic API key prefixes
  result = result.replace(/sk-ant-[A-Za-z0-9_-]+/gi, REDACTED);
  // Replace OpenAI API key prefixes (sk- followed by 20+ alphanumeric chars)
  result = result.replace(/sk-[A-Za-z0-9]{20,}/gi, REDACTED);

  // Replace bare JWT tokens (three base64url segments starting with eyJ)
  result = result.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED);

  // Truncate long strings to prevent echoing large response bodies
  if (result.length > MAX_STRING_LENGTH) {
    result = result.slice(0, MAX_STRING_LENGTH) + '...[TRUNCATED]';
  }

  return result;
}

/** Keys to skip when walking Error objects (already handled separately). */
const ERROR_SKIP_KEYS = new Set(['name', 'message', 'stack']);

/**
 * Redact a child value, considering its key name.
 *
 * - Secret keys → value replaced with {@link REDACTED}.
 * - Account ID keys → value replaced with {@link REDACTED}.
 * - Raw body keys (body, rawBody, responseBody) → value replaced with {@link REDACTED_BODY}.
 * - Raw response keys (response) with string values → replaced with {@link REDACTED_BODY}.
 * - Everything else → recursively redacted.
 */
function redactValueWithKey(
  value: unknown,
  key: string,
  visited: WeakSet<object>,
): unknown {
  if (isSecretKey(key) || isAccountIdKey(key)) {
    return REDACTED;
  }
  if (isRawBodyKey(key) && value !== null && value !== undefined) {
    return REDACTED_BODY;
  }
  if (isRawResponseKey(key) && typeof value === 'string') {
    return REDACTED_BODY;
  }
  return redactRecursive(value, visited);
}

/**
 * Recursively redact secrets from any value.
 *
 * Walks objects, arrays, and Error objects. Handles circular references.
 * Primitives pass through unchanged (except strings with secret patterns).
 */
function redactRecursive(value: unknown, visited: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return redactStringInternal(value, false);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'function') {
    return '[Function]';
  }

  if (typeof value === 'symbol') {
    return '[Symbol]';
  }

  if (typeof value === 'bigint') {
    return `[BigInt: ${value.toString()}]`;
  }

  // At this point value is an object
  if (visited.has(value)) {
    return CIRCULAR;
  }
  visited.add(value);

  // Error: preserve name + redacted message, walk custom properties, skip stack
  if (isError(value)) {
    const result: Record<string, unknown> = {
      name: value.name,
      message: redactStringInternal(value.message, false),
    };
    for (const [key, childValue] of Object.entries(value)) {
      if (ERROR_SKIP_KEYS.has(key)) continue;
      result[key] = redactValueWithKey(childValue, key, visited);
    }
    return result;
  }

  // Array: redact each element
  if (Array.isArray(value)) {
    return value.map((item) => redactRecursive(item, visited));
  }

  // Plain object: redact each property
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      result[key] = redactValueWithKey(value[key], key, visited);
    }
    return result;
  }

  // Other objects (Map, Set, Date, etc.) — safe string representation
  return '[Object]';
}

/**
 * Recursively redact secrets from any value.
 *
 * Use for all diagnostics (stderr), safe status text, and any output that
 * must not contain credentials, tokens, account identifiers, or raw response
 * bodies. Handles nested objects, arrays, errors, and circular references.
 */
export function redact(value: unknown): unknown {
  return redactRecursive(value, new WeakSet<object>());
}
