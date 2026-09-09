import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Single owner: run one inspection after readiness, then terminate this disposable
// synthetic writer. No concurrent start/stop API and no live databases.
export async function withWalWriter(root: string, db: string, args: string[], inspect: () => Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  try {
    mkdirSync(join(root, '.cache'), { mode: 0o700 });
    const writer = spawn('/usr/bin/python3', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: root, XDG_CACHE_HOME: join(root, '.cache'), LANG: 'C.UTF-8' },
    });
    let isClosed = false;
    // Unlike events.once(), this lifetime promise never rejects on spawn error.
    const closed = new Promise<void>(resolve => writer.once('close', () => { isClosed = true; resolve(); }));
    const onError = () => {}; // Retain error ownership through teardown.
    writer.on('error', onError);
    writer.stderr.resume();
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const finish = (error?: Error) => {
          clearTimeout(timer);
          writer.stdout.off('data', onData);
          writer.off('error', onStartupError);
          writer.off('close', onClose);
          if (error) reject(error); else resolve();
        };
        const onStartupError = (error: Error) => finish(error);
        const onClose = (code: number | null, signal: string | null) => finish(new Error(`WAL writer closed before ready: ${code ?? signal}`));
        const onData = (chunk: Buffer) => {
          output += chunk.toString();
          if (output === 'ready\n') finish();
          else if (!'ready\n'.startsWith(output)) finish(new Error('WAL writer unexpected readiness output'));
        };
        const timer = setTimeout(() => finish(new Error('WAL writer readiness deadline exceeded')), 2000);
        writer.stdout.on('data', onData);
        writer.once('error', onStartupError);
        writer.once('close', onClose);
      });
      writer.stdout.resume();
      await inspect();
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        if (!isClosed) writer.kill('SIGKILL');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('WAL writer teardown deadline exceeded')), 2000);
          void closed.then(() => { clearTimeout(timer); resolve(); });
        });
      } catch (error) {
        failures.push(error);
      } finally {
        writer.off('error', onError);
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (existsSync(root)) chmodSync(root, 0o700);
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(db + suffix)) chmodSync(db + suffix, 0o600);
      }
    } catch (error) {
      failures.push(error);
    } finally {
      try { rmSync(root, { recursive: true, force: true }); }
      catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'WAL fixture failed (including cleanup)');
}
