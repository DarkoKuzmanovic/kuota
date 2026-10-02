import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function repoRoot(): string {
  let path = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(path, 'scripts/check-artifact.js'))) {
    const parent = dirname(path);
    if (parent === path) throw new Error('Repository missing');
    path = parent;
  }
  return path;
}

// Approved contract: docs/specs/2026-09-08-review-p1-fixes-design.md, G-P1 #1.
for (const behavior of ['normal', 'hang', 'overflow', 'stderr-overflow', 'failed'] as const) {
  test(`artifact checker isolates and cleans ${behavior} packaged children`, () => {
    const root = mkdtempSync(join(tmpdir(), 'kuota-artifact-test-'));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'dist/collector'), { recursive: true });
      const repo = repoRoot();
      // npm test compiles the production collector alongside tests.
      cpSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../collector/src'), join(root, 'dist/collector'), { recursive: true });
      cpSync(join(repo, 'scripts/check-artifact.js'), join(root, 'scripts/check-artifact.js'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: 'synthetic' }));
      const packaged = join(root, 'dist/artifact/kuota-vsynthetic/contents/code/collector');
      cpSync(join(root, 'dist/collector'), packaged, { recursive: true });
      const parentHome = join(root, 'parent-home');
      mkdirSync(join(parentHome, '.pi/agent'), { recursive: true });
      mkdirSync(join(parentHome, '.cache'), { mode: 0o700 });
      const auth = join(parentHome, '.pi/agent/auth.json');
      const authCanary = JSON.stringify({ anthropic: { type: 'oauth', access: 'synthetic-anthropic' }, 'openai-codex': { type: 'oauth', access: 'synthetic-codex', refresh: 'synthetic-refresh', expires: 0, accountId: 'synthetic-account' } });
      writeFileSync(auth, authCanary);
      // Spec 2026-10-02-standalone-credentials-design.md risk 4: Kuota store + Codex CLI canaries.
      const ownCanaries = [join(parentHome, 'kuota/credentials.json'), join(parentHome, '.config/kuota/credentials.json'), join(parentHome, '.codex/auth.json')];
      const ownCanary = JSON.stringify({ codex: { type: 'oauth', access: 'synthetic-own-codex', refresh: 'synthetic-own-refresh', expires: 0, accountId: 'synthetic-account' }, tokens: { access_token: 'synthetic-cli', account_id: 'synthetic-account' } });
      for (const path of ownCanaries) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, ownCanary, { mode: 0o600 });
      }
      const cache = join(parentHome, '.cache/canary');
      writeFileSync(cache, 'unchanged');
      const trace = join(root, 'trace');
      const transport = join(root, 'transport');
      const preload = join(root, 'preload.cjs');
      writeFileSync(preload, `if(process.argv[1]?.includes('/artifact/')) require('node:fs').writeFileSync(${JSON.stringify(join(root, 'preloaded'))}, 'bad');`);
      const instrumentation = `import {appendFileSync as record, statSync as stat} from 'node:fs';\nrecord(${JSON.stringify(trace)}, JSON.stringify({pid:process.pid, env:process.env, mode:stat(process.env.HOME).mode & 511, cacheMode:stat(process.env.HOME+'/.cache').mode & 511})+'\\n');\nglobalThis.fetch=async()=>{record(${JSON.stringify(transport)},'called');throw new Error('transport forbidden');};\n`;
      const cli = join(packaged, 'cli.js');
      const original = readFileSync(cli, 'utf8');
      const body = behavior === 'normal' ? original : behavior === 'failed' ? 'process.exit(1);' : `setTimeout(()=>process.exit(99),7000);process.on('SIGTERM',()=>{});${behavior === 'hang' ? '' : `process.${behavior === 'stderr-overflow' ? 'stderr' : 'stdout'}.write('ü'.repeat(35000));`}setInterval(()=>{},1000);`;
      writeFileSync(cli, instrumentation + body);
      const start = Date.now();
      const result = spawnSync(process.execPath, [join(root, 'scripts/check-artifact.js')], {
        env: { PATH: '/usr/bin:/bin', TMPDIR: root, HOME: parentHome, XDG_CACHE_HOME: join(parentHome, '.cache'), XDG_CONFIG_HOME: parentHome, CURSOR_SESSION_TOKEN: 'synthetic-env-canary', ARBITRARY_CANARY: 'synthetic', NODE_OPTIONS: `--require=${preload}` },
        encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
      });
      assert.equal(result.status === 0, behavior === 'normal', 'checker outcome');
      assert.ok(Date.now() - start < 7000, 'checker must own a shorter deadline than harness');
      assert.equal(existsSync(join(root, 'preloaded')), false, 'no parent preload in packaged child');
      assert.equal(existsSync(transport), false, 'no provider transport');
      const records: unknown[] = readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(records.length, behavior === 'normal' ? 4 : 1);
      for (const record of records) {
        assert.ok(typeof record === 'object' && record !== null && 'env' in record && 'mode' in record && 'cacheMode' in record && 'pid' in record && typeof record.pid === 'number');
        const pid = record.pid;
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'packaged child reaped');
        assert.equal(record.mode, 0o700);
        assert.equal(record.cacheMode, 0o700);
        const env = record.env;
        assert.ok(typeof env === 'object' && env !== null && 'HOME' in env && typeof env.HOME === 'string');
        assert.notEqual(env.HOME, parentHome);
        assert.equal(existsSync(env.HOME), false, 'private home cleaned');
        for (const key of ['CURSOR_SESSION_TOKEN', 'ARBITRARY_CANARY', 'NODE_OPTIONS', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME']) assert.equal(key in env, false, 'ambient env stripped');
      }
      assert.equal(readFileSync(auth, 'utf8') === authCanary, true, 'parent auth unchanged');
      assert.equal(readFileSync(cache, 'utf8'), 'unchanged');
      for (const path of ownCanaries) assert.equal(readFileSync(path, 'utf8'), ownCanary, 'parent Kuota/Codex CLI credentials unchanged');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
