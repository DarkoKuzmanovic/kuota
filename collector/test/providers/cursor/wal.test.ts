import assert from 'node:assert/strict';
import { withWalWriter } from './wal-writer.js';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readCursorAuth } from '../../../src/providers/cursor/auth.js';

for (const filename of ['state.vscdb', 'state ?#%ü.vscdb']) {
  test(`production Cursor reader sees open WAL at ${filename}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kuota-wal-'));
    const db = join(root, filename);
    await withWalWriter(root, db, ['-u', '-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('PRAGMA journal_mode=WAL')
c.execute('PRAGMA wal_autocheckpoint=0')
c.execute('CREATE TABLE ItemTable (key TEXT, value TEXT)')
c.execute("INSERT INTO ItemTable VALUES ('cursorAuth/accessToken','synthetic-old')")
c.commit()
c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
c.execute("UPDATE ItemTable SET value='synthetic-new'")
c.commit()
print('ready',flush=True)
sys.stdin.read()
c.close()
`, db], async () => {
      const beforeDb = readFileSync(db);
      const beforeWal = readFileSync(db + '-wal');
      assert.ok(beforeWal.length > 0);
      const result = await readCursorAuth({ stateDbCandidates: [db], environment: { CURSOR_SESSION_TOKEN: 'synthetic-env' } });
      assert.equal(result.state === 'available' && result.credential.value === 'synthetic-new', true, 'committed WAL token wins over checkpoint and env');
      assert.equal(readFileSync(db).equals(beforeDb), true, 'database unchanged');
      assert.equal(readFileSync(db + '-wal').equals(beforeWal), true, 'WAL unchanged');
    });
  });
}

for (const access of ['busy', 'db-unreadable', 'wal-unreadable', 'shm-missing-readonly', 'readonly-sidecars'] as const) {
  test(`production SQLite read-lock/sidecar behavior: ${access}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kuota-sqlite-access-'));
    const db = join(root, 'state.vscdb');
    const wal = access !== 'busy' && access !== 'db-unreadable';
    await withWalWriter(root, db, ['-u', '-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
if sys.argv[2]=='wal': c.execute('PRAGMA journal_mode=WAL')
c.execute('CREATE TABLE ItemTable (key TEXT, value TEXT)')
c.execute("INSERT INTO ItemTable VALUES ('cursorAuth/accessToken','synthetic-local')")
c.commit()
if sys.argv[2]=='busy': c.execute('BEGIN EXCLUSIVE')
print('ready',flush=True)
sys.stdin.read()
c.close()
`, db, wal ? 'wal' : access === 'busy' ? 'busy' : 'plain'], async () => {
      const beforeDb = readFileSync(db);
      const beforeWal = wal ? readFileSync(db + '-wal') : undefined;
      if (access === 'db-unreadable') chmodSync(db, 0);
      if (access === 'wal-unreadable') chmodSync(db + '-wal', 0);
      if (access === 'shm-missing-readonly') rmSync(db + '-shm');
      if (access === 'readonly-sidecars') {
        chmodSync(db, 0o400); chmodSync(db + '-wal', 0o400); chmodSync(db + '-shm', 0o400);
      }
      if (access === 'readonly-sidecars' || access === 'shm-missing-readonly') chmodSync(root, 0o500);
      const result = await readCursorAuth({ stateDbCandidates: [db], environment: { CURSOR_SESSION_TOKEN: 'synthetic-env' } });
      assert.equal(result.state === 'available' && result.credential.value === (access === 'readonly-sidecars' ? 'synthetic-local' : 'synthetic-env'), true, 'safe read or ordinary env fallback');
      chmodSync(db, 0o600);
      if (wal) chmodSync(db + '-wal', 0o600);
      assert.equal(readFileSync(db).equals(beforeDb), true);
      if (beforeWal !== undefined) assert.equal(readFileSync(db + '-wal').equals(beforeWal), true);
      if (access === 'shm-missing-readonly') assert.equal(existsSync(db + '-shm'), false, 'reader did not create sidecar in read-only directory');
    });
  });
}

test('production read-only Cursor failures preserve files and allow env fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kuota-db-failures-'));
  try {
    const malformed = join(root, 'malformed');
    writeFileSync(malformed, 'synthetic malformed database');
    const directory = join(root, 'directory');
    mkdirSync(directory);
    for (const db of [join(root, 'missing'), malformed, directory]) {
      const result = await readCursorAuth({ stateDbCandidates: [db], environment: { CURSOR_SESSION_TOKEN: 'synthetic-env' } });
      assert.equal(result.state === 'available' && result.credential.value === 'synthetic-env', true, 'ordinary error keeps env fallback');
      const absent = await readCursorAuth({ stateDbCandidates: [db], environment: {} });
      assert.deepEqual(absent, { state: 'auth-needed', reason: 'missing-local' });
    }
    assert.equal(existsSync(join(root, 'missing')), false);
    assert.equal(readFileSync(malformed, 'utf8'), 'synthetic malformed database');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
