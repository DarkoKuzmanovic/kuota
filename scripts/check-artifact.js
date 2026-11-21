import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCollectorDocument } from '../dist/collector/contract/validate.js';
import { CLI_FAILURE_DIAGNOSTIC } from '../dist/collector/cli.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDirectory, '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const artifactName = `kuota-v${String(packageJson.version)}`;
const artifactCli = join(
  root,
  'dist',
  'artifact',
  artifactName,
  'contents',
  'code',
  'collector',
  'cli.js',
);

// Expectations come from the packaged QML provider catalog — the single
// source of truth for what the artifact declares to the widget — rather
// than the adjacent build output. A provider added on only one side of
// the catalog/collector pair fails the build instead of passing silently.
function readCatalogIds(source, variable) {
  const match = source.match(new RegExp(`var ${variable} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`));
  if (!match) {
    fail(`packaged provider catalog has no ${variable}`);
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

const catalogPath = join(root, 'dist', 'artifact', artifactName, 'contents', 'ui', 'provider-catalog.js');
if (!existsSync(catalogPath)) {
  fail('packaged provider catalog is missing');
}
const catalogSource = readFileSync(catalogPath, 'utf8');
const PROVIDER_IDS = readCatalogIds(catalogSource, 'PROVIDER_IDS');
const OPT_IN_PROVIDER_IDS = readCatalogIds(catalogSource, 'OPT_IN_PROVIDER_IDS');

function fail(message) {
  throw new Error(`Artifact check failed: ${message}`);
}

function runCli(args) {
  if (!existsSync(artifactCli)) {
    fail('packaged CLI is missing');
  }
  const home = mkdtempSync(join(tmpdir(), 'kuota-artifact-check-'));
  try {
    mkdirSync(join(home, '.cache'), { mode: 0o700 });
    const result = spawnSync(process.execPath, [artifactCli, ...args], {
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      timeout: 2000,
      maxBuffer: 64 * 1024,
      killSignal: 'SIGKILL',
    });
    if (result.error !== undefined) {
      fail('packaged CLI could not complete within resource limits');
    }
    return result;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function checkNormalInvocation() {
  const result = runCli([]);
  if (result.status !== 0) {
    fail('normal invocation did not succeed');
  }
  if (result.stderr !== '') {
    fail('normal invocation wrote stderr');
  }
  if (!result.stdout.endsWith('\n') || result.stdout.indexOf('\n') !== result.stdout.length - 1) {
    fail('normal invocation did not write exactly one newline-terminated JSON document');
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail('normal invocation wrote invalid JSON');
  }
  const validation = validateCollectorDocument(parsed);
  if (!validation.ok) {
    fail('normal invocation violated the collector schema');
  }
  const providerIds = validation.value.providers.map((provider) => provider.id);
  if (JSON.stringify(providerIds) !== JSON.stringify(PROVIDER_IDS.filter((id) => !OPT_IN_PROVIDER_IDS.includes(id)))) {
    fail('normal invocation did not use canonical provider IDs');
  }
  if (!PROVIDER_IDS.includes('muse') || !OPT_IN_PROVIDER_IDS.includes('muse') || providerIds.includes('muse')) {
    fail('Muse Code must be available but omitted by default');
  }
}

function checkCredentialArgv() {
  const credential = 'synthetic-token';
  const result = runCli([`--access-token=${credential}`]);
  if (result.status !== 1) {
    fail('credential argv did not fail safely');
  }
  if (result.stdout !== '') {
    fail('credential argv wrote stdout');
  }
  if (result.stderr !== `${CLI_FAILURE_DIAGNOSTIC}\n`) {
    fail('credential argv did not write the constant diagnostic');
  }
  if (result.stderr.includes(credential)) {
    fail('credential argv leaked its value');
  }
}

function checkEnabledProvidersSubset(id) {
  const result = runCli([`--enabled-providers=${id}`]);
  if (result.status !== 0) {
    fail('enabled-providers subset invocation did not succeed');
  }
  if (result.stderr !== '') {
    fail('enabled-providers subset invocation wrote stderr');
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail('enabled-providers subset invocation wrote invalid JSON');
  }
  const validation = validateCollectorDocument(parsed);
  if (!validation.ok) {
    fail('enabled-providers subset invocation violated the collector schema');
  }
  const providerIds = validation.value.providers.map((provider) => provider.id);
  if (JSON.stringify(providerIds) !== JSON.stringify([id])) {
    fail('enabled-providers subset invocation did not select only the requested provider');
  }
}

function checkEmptyEnabledProviders() {
  const result = runCli(['--enabled-providers=']);
  if (result.status !== 0) {
    fail('empty enabled-providers invocation did not succeed');
  }
  if (result.stderr !== '') {
    fail('empty enabled-providers invocation wrote stderr');
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail('empty enabled-providers invocation wrote invalid JSON');
  }
  const validation = validateCollectorDocument(parsed);
  if (!validation.ok) {
    fail('empty enabled-providers invocation violated the collector schema');
  }
  if (validation.value.providers.length !== 0) {
    fail('empty enabled-providers invocation collected a provider');
  }
}

checkNormalInvocation();
checkCredentialArgv();
checkEnabledProvidersSubset('claude');
checkEnabledProvidersSubset('muse');
checkEmptyEnabledProviders();
