import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { once, getEventListeners } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { readCursorAuth } from '../../../src/providers/cursor/auth.js';
import { createCursorAdapter } from '../../../src/providers/cursor/adapter.js';
import { createKimiAdapter } from '../../../src/providers/kimi/adapter.js';

// Replace only spawn, not the production process owner. Helpers are real processes.
for (const mode of ['pre-abort', 'abort', 'adapter-abort', 'timeout', 'stdout', 'stderr', 'multibyte', 'success', 'spawn-failure', 'close-abort'] as const) {
  test(`Cursor child ownership: ${mode}`, async (t) => {
    const controller = new AbortController();
    let calls = 0;
    let child: ChildProcess | undefined;
    let closed = false;
    let forceCleanup: NodeJS.Timeout | undefined;
    let cleanupUsed = false;
    let envReads = 0;
    let fetchCalls = 0;
    const realSpawn = childProcess.spawn;
    const stdoutBody = mode === 'stdout' ? "process.stdout.write('x'.repeat(65537));" : mode === 'multibyte' ? "process.stdout.write('ü'.repeat(32769));" : mode === 'stderr' ? "process.stderr.write('x'.repeat(65537));" : '';
    const body = mode === 'success' || mode === 'close-abort' ? "process.stdout.write('synthetic-local\\n');" : `process.on('SIGTERM',()=>{});${stdoutBody}setInterval(()=>{},1000);`;
    t.mock.method(childProcess, 'spawn', () => {
      if (forceCleanup !== undefined) clearTimeout(forceCleanup);
      closed = false;
      calls += 1;
      child = mode === 'spawn-failure' ? realSpawn('/synthetic/nonexistent/sqlite', []) : realSpawn(process.execPath, ['-e', body], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', () => {});
      child.on('close', () => { closed = true; if (mode === 'close-abort') controller.abort(); });
      forceCleanup = setTimeout(() => { cleanupUsed = true; child?.kill('SIGKILL'); }, 4000);
      if (mode === 'abort' || mode === 'adapter-abort') setTimeout(() => controller.abort(), 100);
      return child;
    });
    syncBuiltinESMExports();
    if (mode === 'pre-abort') controller.abort();
    try {
      const options = { signal: controller.signal, stateDbCandidates: ['/synthetic/one', '/synthetic/two'], environment: { get CURSOR_SESSION_TOKEN() { envReads += 1; return 'synthetic-env'; } } };
      const adapter = createCursorAdapter({ fetchUsage: async () => { fetchCalls += 1; return { outcome: 'auth-needed' }; } });
      const healthy = createKimiAdapter({
        resolveAuthPath: () => '/synthetic/auth.json',
        readAuth: async () => ({ state: 'available', credential: { kind: 'oauth', value: 'synthetic-kimi' } }),
        fetchUsage: async () => ({ outcome: 'ok', value: {} }),
        parseUsage: (_payload, observedAt) => ({ ok: true, record: { id: 'kimi', state: 'ok', lastSuccessAt: observedAt, windows: [{ id: 'week', label: 'Week', used: 4 }] } }),
      });
      const other = healthy.collect({ signal: new AbortController().signal, dependencies: {} });
      const result = mode === 'adapter-abort'
        ? await adapter.collect({ signal: controller.signal, dependencies: {} })
        : await readCursorAuth(options);
      assert.equal((await other).state, 'ok', 'other provider completes independently');
      assert.equal(cleanupUsed, false, 'production deadline must kill child before test failsafe');
      assert.equal(calls, mode === 'pre-abort' ? 0 : mode === 'spawn-failure' ? 2 : 1, 'no discovery after cancellation or resource limit');
      if (mode !== 'pre-abort') {
        assert.equal(closed, true, 'settlement waits for child close/reaping');
        assert.equal(child?.stdout?.listenerCount('data'), 0, 'stdout listener cleared');
        assert.equal(child?.stderr?.listenerCount('data'), 0, 'stderr listener cleared');
        assert.equal(child?.listenerCount('error'), 1, 'only test error observer remains');
        const pid = child?.pid;
        if (pid !== undefined) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      }
      assert.equal(fetchCalls, 0);
      assert.equal(envReads, mode === 'spawn-failure' ? 1 : 0, 'no env fallback after cancellation');
      if (mode === 'adapter-abort') assert.deepEqual(result, { id: 'cursor', state: 'error', status: 'Provider unavailable' });
      else if (mode === 'success') assert.equal(result.state === 'available' && result.credential.value === 'synthetic-local', true);
      else if (mode === 'spawn-failure') assert.equal(result.state === 'available' && result.credential.value === 'synthetic-env', true);
      else assert.deepEqual(result, { state: 'error', reason: 'sqlite-failed' });
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'abort listener removed');
      if (child !== undefined) {
        assert.equal(child.listenerCount('close'), 1, 'only test observer remains after settlement');
        const settledCalls = calls;
        child.emit('close', 0);
        child.emit('close', 1);
        controller.abort();
        controller.abort();
        await Promise.resolve();
        assert.equal(calls, settledCalls, 'duplicate close/abort does not restart discovery');
        assert.equal(fetchCalls, 0);
      }
    } finally {
      if (forceCleanup !== undefined) clearTimeout(forceCleanup);
      if (child !== undefined && !closed) { const done = once(child, 'close'); child.kill('SIGKILL'); await done; }
      t.mock.restoreAll(); syncBuiltinESMExports();
    }
  });
}

test('Cursor adapter skips auth on pre-abort and fetch on auth-time abort', async () => {
  const controller = new AbortController();
  let authCalls = 0;
  let fetchCalls = 0;
  const adapter = createCursorAdapter({
    readAuth: async () => { authCalls += 1; controller.abort(); return { state: 'available', credential: { kind: 'session', value: 'synthetic' } }; },
    fetchUsage: async () => { fetchCalls += 1; return { outcome: 'auth-needed' }; },
  });
  await adapter.collect({ signal: controller.signal, dependencies: {} });
  await adapter.collect({ signal: controller.signal, dependencies: {} });
  assert.equal(authCalls, 1);
  assert.equal(fetchCalls, 0);
});
