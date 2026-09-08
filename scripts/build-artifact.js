import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const artifactName = `kuota-v${String(pkg.version)}`;
const artifactRoot = join(root, 'dist', 'artifact');
const artifactDir = join(artifactRoot, artifactName);
const zipPath = join(artifactRoot, `${artifactName}.plasmoid`);
const collectorSource = join(root, 'dist', 'collector');
const collectorDestination = join(artifactDir, 'contents', 'code', 'collector');

// Remove prior output before any failure can leave it looking freshly verified.
rmSync(zipPath, { force: true });
try {
  execFileSync('npm', ['run', 'build:collector'], { cwd: root, stdio: 'inherit' });
  if (!existsSync(join(collectorSource, 'cli.js'))) {
    throw new Error('Collector build output is missing');
  }
  rmSync(artifactDir, { recursive: true, force: true });
  mkdirSync(join(artifactDir, 'contents', 'code'), { recursive: true });
  cpSync(join(root, 'plasmoid'), artifactDir, { recursive: true });
  cpSync(collectorSource, collectorDestination, { recursive: true });
  execFileSync(process.execPath, [join(root, 'scripts', 'check-artifact.js')], { stdio: 'inherit' });
  execFileSync('zip', ['-rq', zipPath, artifactName], { cwd: artifactRoot, stdio: 'inherit' });
  if (!statSync(zipPath).isFile() || statSync(zipPath).size === 0) {
    throw new Error('Archive missing or empty');
  }
  console.log(`Artifact ${artifactName} created at ${artifactDir}`);
  console.log(`Packaged as ${artifactName}.plasmoid`);
} catch {
  rmSync(zipPath, { force: true });
  console.error('Artifact build failed; a verified nonempty zip archive is required.');
  process.exitCode = 1;
}
