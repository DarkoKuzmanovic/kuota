import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function repoRoot(): string {
  let path = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(path, 'scripts/install.sh'))) {
    const parent = dirname(path);
    if (parent === path) throw new Error('Repository missing');
    path = parent;
  }
  return path;
}
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kuota source space-'));
  cpSync(join(repoRoot(), 'scripts'), join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'home'), { mode: 0o700 });
  mkdirSync(join(root, 'dist/artifact'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '9.8.7' }));
  writeFileSync(join(root, 'dist/artifact/kuota-v9.8.7.plasmoid'), 'stale');
  mkdirSync(join(root, 'plasmoid/contents/ui'), { recursive: true });
  mkdirSync(join(root, 'collector/src'), { recursive: true });
  writeFileSync(join(root, 'plasmoid/contents/ui/main.qml'), 'synthetic changed QML');
  writeFileSync(join(root, 'collector/src/cli.ts'), 'synthetic changed collector');
  return root;
}
function tool(root: string, name: string, body: string): void {
  writeFileSync(join(root, 'bin', name), '#!/bin/sh\nset -e\n' + body + '\n', { mode: 0o700 });
}
const freshBuild = `node -e 'const fs=require("node:fs"); fs.writeFileSync("dist/artifact/kuota-v9.8.7.plasmoid", ["plasmoid/contents/ui/main.qml","collector/src/cli.ts"].map(p=>fs.readFileSync(p,"utf8")).join("|"));'`;
const freshContent = 'synthetic changed QML|synthetic changed collector';
function run(root: string, script: string) {
  return spawnSync('/bin/sh', ['scripts/' + script], { cwd: root,
    env: { PATH: join(root, 'bin') + ':/usr/bin:/bin', HOME: join(root, 'home'), CDPATH: '/synthetic:.' },
    encoding: 'utf8', timeout: 10000 });
}
for (const behavior of ['zip-missing', 'zip-failed', 'zip-empty', 'check-failed', 'collector-missing', 'compiler-failed', 'success']) {
  test(`packager fails closed: ${behavior}`, () => {
    const root = fixture();
    try {
      mkdirSync(join(root, 'plasmoid'), { recursive: true });
      mkdirSync(join(root, 'dist/collector'), { recursive: true });
      if (behavior !== 'collector-missing') writeFileSync(join(root, 'dist/collector/cli.js'), '// synthetic');
      writeFileSync(join(root, 'scripts/check-artifact.js'), behavior === 'check-failed' ? 'process.exit(1);' : 'process.exit(0);');
      tool(root, 'npm', behavior === 'compiler-failed' ? 'exit 1' : "printf '%s\\n' \"$*\" > compiler-call");
      tool(root, 'kpackagetool6', 'exit 99');
      tool(root, 'which', behavior === 'zip-missing' ? 'exit 1' : 'exit 0');
      if (behavior !== 'zip-missing') tool(root, 'zip', behavior === 'zip-failed' ? 'exit 1' : behavior === 'zip-empty' ? ': > "$2"' : 'printf fresh > "$2"');
      const result = spawnSync(process.execPath, [join(root, 'scripts/build-artifact.js')], {
        cwd: root, env: { HOME: join(root, 'home'), PATH: join(root, 'bin') }, encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.status === 0, behavior === 'success', 'packaging exit status');
      const archive = join(root, 'dist/artifact/kuota-v9.8.7.plasmoid');
      if (behavior === 'success') {
        assert.equal(readFileSync(archive, 'utf8'), 'fresh');
        assert.equal(existsSync(join(root, 'compiler-call')), true, 'packager owns compiler lifecycle');
        assert.equal(readFileSync(join(root, 'compiler-call'), 'utf8'), 'run build:collector\n');
      }
      else assert.equal(existsSync(archive), false, 'no stale or unchecked archive');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const indent of [0, 4, '\t']) {
  test(`install fallback preserves package type and JSON formatting: ${JSON.stringify(indent)}`, () => {
    const root = fixture();
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '9.8.7' }, null, indent));
      tool(root, 'npm', "printf 'build\\n' >> calls\n" + freshBuild);
      tool(root, 'zip', 'exit 99');
      tool(root, 'kpackagetool6', `printf '%s\\n' "$*" >> calls\nif [ "$3" = '-i' ]; then exit 1; fi\ncp "$4" installed`);
      assert.equal(run(root, 'install.sh').status, 0);
      assert.deepEqual(readFileSync(join(root, 'calls'), 'utf8').trim().split('\n'), ['build', '-t Plasma/Applet -i dist/artifact/kuota-v9.8.7.plasmoid', '-t Plasma/Applet -u dist/artifact/kuota-v9.8.7.plasmoid']);
      assert.equal(readFileSync(join(root, 'installed'), 'utf8'), freshContent);
      assert.equal(run(root, 'update.sh').status, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const script of ['install.sh', 'update.sh']) {
  for (const behavior of ['fresh', 'failed-build', 'missing', 'empty']) {
    test(`${script} requires fresh nonempty artifact: ${behavior}`, () => {
      const root = fixture();
      try {
        tool(root, 'npm', `printf 'build\\n' >> calls\n${behavior === 'failed-build' ? 'exit 1' : behavior === 'fresh' ? freshBuild : behavior === 'empty' ? ': > dist/artifact/kuota-v9.8.7.plasmoid' : ':'}`);
        tool(root, 'zip', 'exit 99');
        tool(root, 'kpackagetool6', `printf '%s\\n' "$*" >> calls\ncp "$4" installed`);
        const result = run(root, script);
        assert.equal(result.status === 0, behavior === 'fresh');
        const calls = existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8').trim().split('\n') : [];
        assert.equal(calls[0], 'build', 'build before package tool, even same version');
        if (behavior === 'fresh') {
          assert.deepEqual(calls, ['build', `-t Plasma/Applet -${script === 'install.sh' ? 'i' : 'u'} dist/artifact/kuota-v9.8.7.plasmoid`]);
          assert.equal(readFileSync(join(root, 'installed'), 'utf8'), freshContent);
        } else assert.deepEqual(calls, ['build']);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}
