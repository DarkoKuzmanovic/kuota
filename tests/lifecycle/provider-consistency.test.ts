import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { PROVIDER_IDS } from '../../collector/src/contract/schema-v1.js';
import { validateCollectorDocument } from '../../collector/src/contract/validate.js';
import { scanForSecrets } from '../../collector/src/security/redact.js';
import { DEFAULT_COLLECTOR_CONFIG } from '../../collector/src/collect/config.js';
import { PLACEHOLDER_ADAPTERS, PLACEHOLDER_PROVIDER_REGISTRATIONS } from '../../collector/src/providers/registry.js';

let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(resolve(root, 'plasmoid/metadata.json'))) {
  const parent = dirname(root);
  assert.notEqual(parent, root, 'repository root');
  root = parent;
}
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
const labels = ['Claude', 'Codex', 'Grok', 'Kimi', 'Cursor', 'OpenCode', 'CommandCode'];

function productionFiles(directory = 'plasmoid/contents'): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? productionFiles(path) : /\.(qml|js)$/.test(path) ? [path] : [];
  }).sort();
}

function isolationPaths(property: string): string[] {
  const block = read('tests/qml/tst_module_isolation.qml').match(new RegExp(`property var ${property}: \\[([\\s\\S]*?)\\]`));
  assert.ok(block, property);
  return Array.from((block[1] ?? '').matchAll(/"\.\.\/\.\.\/(plasmoid\/[^"]+)"/g), match => { assert.ok(match[1]); return match[1]; }).sort();
}

test('Add Widgets description names every supported provider in canonical order', () => {
  const description = read('plasmoid/metadata.json').match(/"Description": "([^"]+)"/)?.[1];
  assert.ok(description);
  let previous = -1;
  for (const label of labels) {
    const index = description.indexOf(label);
    assert.ok(index > previous, `description missing or reordering ${label}`);
    previous = index;
  }
});

test('discovered production QML and JS inventory equals the lint policy', () => {
  const manifest: unknown = JSON.parse(read('package.json'));
  assert.ok(isRecord(manifest) && isRecord(manifest.scripts));
  const command = manifest.scripts['validate:plasma'];
  assert.ok(typeof command === 'string' && command.includes('&& qmllint '));
  const lintPaths = command.split('&& qmllint ')[1]?.trim().split(/\s+/).sort();
  assert.deepEqual(lintPaths, productionFiles());
});

test('discovered production inventory equals both isolation policies', () => {
  assert.deepEqual(isolationPaths('productionQmlFiles'), productionFiles().filter(p => p.endsWith('.qml')));
  assert.deepEqual(isolationPaths('modulesUnderTest'), productionFiles().filter(p => p.endsWith('.js')));
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const corpus: unknown = JSON.parse(read('tests/fixtures/contract-parity.json'));
assert.ok(Array.isArray(corpus));
const rows: readonly unknown[] = corpus;
test('shared contract and settings fixtures are secret-free', () => {
  assert.deepEqual(scanForSecrets(corpus), []);
  const settings: unknown = JSON.parse(read('tests/fixtures/settings-defaults.json'));
  assert.deepEqual(scanForSecrets(settings), []);
});
for (const row of rows) {
  assert.ok(isRecord(row) && typeof row.tag === 'string' && typeof row.valid === 'boolean');
  test(`shared TS/QML contract corpus: ${row.tag}`, () => {
    const result = validateCollectorDocument(row.document);
    assert.equal(result.ok, row.valid);
    if (result.ok) {
      assert.equal(result.value.schemaVersion, 2);
      assert.ok(isRecord(row.document) && Array.isArray(row.document.providers));
      const ids = row.document.providers.map((p: unknown) => { assert.ok(isRecord(p)); return p.id; }).filter(id => id !== 'umans');
      assert.deepEqual(result.value.providers.map(p => p.id), ids);
    }
  });
}

test('every persisted setting has exactly one config-page binding', () => {
  const schema: unknown = JSON.parse(read('tests/fixtures/settings-defaults.json'));
  assert.ok(isRecord(schema));
  const pages = productionFiles().filter(path => /\/ui\/config\w+\.qml$/.test(path));
  const bindings = pages.flatMap(path => Array.from(read(path).matchAll(/property\s+(?:alias|var|string|bool|int|real)\s+cfg_(\w+)\s*:/g), m => m[1])).sort();
  assert.deepEqual(bindings, Object.keys(schema).sort());
});

test('QML catalog, collector defaults and inert registrations cover the TS contract', () => {
  const catalog = read('plasmoid/contents/ui/provider-catalog.js').replace(/^\.pragma library\s*/, '');
  const facts: unknown = JSON.parse(String(runInNewContext(catalog + '\nJSON.stringify([PROVIDER_IDS, PROVIDER_IDS.map(function(id) { return PROVIDER_LABELS[id]; })])')));
  assert.deepEqual(facts, [PROVIDER_IDS, labels]);
  assert.deepEqual(DEFAULT_COLLECTOR_CONFIG.providers, PROVIDER_IDS.map(id => ({ id, enabled: true })));
  assert.deepEqual(PLACEHOLDER_ADAPTERS.map(p => p.id), PROVIDER_IDS);
  assert.deepEqual(PLACEHOLDER_PROVIDER_REGISTRATIONS.map(p => p.id), PROVIDER_IDS);
  for (const registration of PLACEHOLDER_PROVIDER_REGISTRATIONS) {
    assert.equal(registration.adapter, PLACEHOLDER_ADAPTERS.find(p => p.id === registration.id));
  }
});
