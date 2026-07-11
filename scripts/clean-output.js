import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputName = process.argv[2];

if (
  process.argv.length !== 3 ||
  (outputName !== 'tests' && outputName !== 'collector')
) {
  console.error('Usage: node scripts/clean-output.js <tests|collector>');
  process.exitCode = 1;
} else {
  rmSync(join(root, 'dist', outputName), { force: true, recursive: true });
}
