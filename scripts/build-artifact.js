import { readFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = String(pkg.version);
const artifactName = `kuota-v${version}`;
const artifactRoot = join(root, 'dist', 'artifact');
const artifactDir = join(artifactRoot, artifactName);
const collectorSource = join(root, 'dist', 'collector');
const collectorDestination = join(artifactDir, 'contents', 'code', 'collector');

if (!existsSync(join(collectorSource, 'cli.js'))) {
  console.error('Collector build output is missing. Run: npm run build:collector');
  process.exit(1);
}

rmSync(artifactDir, { recursive: true, force: true });
mkdirSync(join(artifactDir, 'contents', 'code'), { recursive: true });

cpSync(join(root, 'plasmoid'), artifactDir, { recursive: true });
cpSync(collectorSource, collectorDestination, { recursive: true });

let zipped = false;
try {
  execFileSync('which', ['zip']);
  const zipPath = join(artifactRoot, `${artifactName}.plasmoid`);
  rmSync(zipPath, { force: true });
  execFileSync('zip', ['-rq', zipPath, artifactName], { cwd: artifactRoot, stdio: 'inherit' });
  zipped = true;
} catch {
  console.warn('zip is not available; artifact remains as an unpacked directory');
}

execFileSync(process.execPath, [join(root, 'scripts', 'check-artifact.js')], {
  stdio: 'inherit',
});

console.log(`Artifact ${artifactName} created at ${artifactDir}`);
if (zipped) {
  console.log(`Packaged as ${artifactName}.plasmoid`);
}
