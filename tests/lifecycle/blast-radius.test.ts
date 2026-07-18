import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = findRepoRoot();
const SCRIPTS = ['install.sh', 'update.sh', 'uninstall.sh'] as const;

const FORBIDDEN_SUBSTRINGS = [
  '~/.pi',
  '$HOME/.pi',
  '.pi/',
  '.pi/agent',
  'auth.json',
  'XDG_CONFIG_HOME',
  'kdeglobals',
  'plasma-localerc',
  '~/.config',
  '$HOME/.config',
  '.config/',
  'bearer',
  'token',
  'refresh',
  'accountId',
  'account_id',
  'secret',
  'password',
  'Authorization',
] as const;

const ALLOWED_CACHE_PATH_RE = /\.cache\/kuota|kuota\/\.cache/;

function scriptPath(name: string): string {
  return resolve(root, 'scripts', name);
}

function readScript(name: string): string {
  return readFileSync(scriptPath(name), 'utf8');
}

function lineIsPermitted(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  if (trimmed.startsWith('#')) return true;
  if (trimmed.includes('kpackagetool6')) return true;
  if (trimmed.includes('npm')) return true;
  if (trimmed.includes('printf')) return true;
  if (trimmed.includes('cd ')) return true;
  if (trimmed.includes('root_dir=')) return true;
  if (trimmed === 'rm -rf "$cache_dir"') return true;
  if (ALLOWED_CACHE_PATH_RE.test(trimmed) && trimmed.includes('rm -rf')) return true;
  if (/^set (\+|-)?e$/.test(trimmed)) return true;
  return false;
}

function findRepoRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = resolve(directory, 'scripts', 'install.sh');
    if (existsSync(candidate)) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('Could not locate scripts/ from compiled test');
    }
    directory = parent;
  }
}

describe('lifecycle script blast radius', () => {
  for (const script of SCRIPTS) {
    test(`${script} is POSIX sh and passes sh -n`, () => {
      const content = readScript(script);
      assert.ok(content.startsWith('#!/bin/sh'), `${script} must declare #!/bin/sh`);
      const syntaxResult = spawnSync('sh', ['-n', scriptPath(script)]);
      assert.strictEqual(syntaxResult.status, 0, `${script} must pass POSIX sh syntax check`);
    });

    test(`${script} never references protected paths or credentials`, () => {
      const content = readScript(script).toLowerCase();
      for (const pattern of FORBIDDEN_SUBSTRINGS) {
        assert.ok(
          !content.includes(pattern.toLowerCase()),
          `${script} must not contain forbidden reference: ${pattern}`,
        );
      }
    });

    test(`${script} calls kpackagetool6`, () => {
      const content = readScript(script);
      assert.ok(content.includes('kpackagetool6'), `${script} must invoke kpackagetool6`);
    });

    test(`${script} does not use set -x or verbose flags`, () => {
      const content = readScript(script);
      assert.ok(!content.includes('set -x'), `${script} must not enable shell tracing`);
      assert.ok(!content.includes('set -v'), `${script} must not enable verbose mode`);
    });
  }

  test('no script mutates the filesystem outside ~/.cache/kuota except kpackagetool6', () => {
    for (const script of SCRIPTS) {
      const content = readScript(script);
      const lines = content.split('\n');
      for (const line of lines) {
        if (lineIsPermitted(line)) continue;
        assert.ok(
          !/\b(rm|cp|mv|touch|mkdir|install)\b/.test(line),
          `${script} contains unapproved filesystem mutation command: ${line.trim()}`,
        );
      }
    }
  });

  test('uninstall.sh targets only the package id and the Kuota cache', () => {
    const content = readScript('uninstall.sh');
    assert.ok(
      content.includes('kpackagetool6 -r "$package_id"'),
      'uninstall.sh must remove by package id',
    );
    assert.ok(
      content.includes('rm -rf "$cache_dir"'),
      'uninstall.sh must remove the cache dir via a variable',
    );
    assert.ok(
      !content.includes('rm -rf /') && !content.includes('rm -rf "$HOME"'),
      'uninstall.sh must not contain a broad rm -rf',
    );
  });
});
