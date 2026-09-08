import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Exercise the actual fixture loops in an isolated process, replacing only spawn.
// Each probe owns an independent failsafe and cleans scratch even against RED.
for (const mode of ['missing', 'early-exit', 'never-ready', 'inspection-error']) {
  test(`WAL fixture bounds and cleans ${mode}`, async t => {
    const home = mkdtempSync(join(tmpdir(), 'kuota-wal-probe-'));
    mkdirSync(join(home, '.cache'), { mode: 0o700 });
    const script = `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { chmodSync, existsSync, rmSync } from 'node:fs';
      import { dirname } from 'node:path';
      const original = cp.spawn;
      const children = [], roots = [], unhandled = [];
      const mode = ${JSON.stringify(mode)};
      cp.spawn = (command, args, options) => {
        if (!command.startsWith('/usr/bin/python')) return original(command, args, options);
        roots.push(dirname(args[3]));
        const code = mode === 'early-exit' ? 'process.exit(7)' :
          mode === 'inspection-error' ? 'console.log("ready");setInterval(()=>{},1000)' :
          'setInterval(()=>{},1000)';
        const child = original(mode === 'missing' ? '/nonexistent/kuota-python3' : process.execPath,
          ['-e', code], options);
        const record = { child, closed: false };
        child.once('close', () => { record.closed = true; });
        children.push(record);
        return child;
      };
      syncBuiltinESMExports();
      process.on('unhandledRejection', e => unhandled.push(String(e)));
      async function report(failsafe) {
        console.log('PROBE:' + JSON.stringify({ failsafe, unhandled,
          closed: children.every(r => r.closed), count: children.length,
          removed: roots.every(root => !existsSync(root)) }));
        await Promise.all(children.filter(r => !r.closed).map(({child}) => new Promise(resolve => {
          child.once('close', resolve);
          child.kill('SIGKILL');
        })));
        for (const root of roots) {
          if (existsSync(root)) chmodSync(root, 0o700);
          rmSync(root, {recursive:true, force:true});
        }
      }
      const timer = setTimeout(async () => { await report(true); process.exit(91); }, 25000);
      await import(${JSON.stringify(new URL('./wal.test.js', import.meta.url).href)});
      // A queued final test works on Node 20.0.0 too; root after hooks there do
      // not provide completion while a referenced failsafe keeps the loop alive.
      const { test } = await import('node:test');
      test('probe completion', async () => { clearTimeout(timer); await report(false); });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { PATH: '/usr/bin:/bin', HOME: home, XDG_CACHE_HOME: join(home, '.cache'), TMPDIR: home, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const failsafe = setTimeout(() => child.kill('SIGKILL'), 30000);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', () => resolve());
      });
      const line = output.split('\n').find(line => line.startsWith('PROBE:'));
      assert.ok(line, output);
      const report: unknown = JSON.parse(line.slice(6));
      t.diagnostic(line);
      assert.deepEqual(report, { failsafe: false, unhandled: [], closed: true, count: 7, removed: true });
      assert.match(output, mode === 'missing' ? /ENOENT/ : mode === 'early-exit' ? /before ready.*7/ : mode === 'never-ready' ? /readiness deadline/ : /ENOENT/);
    } finally {
      clearTimeout(failsafe);
      rmSync(home, { recursive: true, force: true });
    }
  });
}
