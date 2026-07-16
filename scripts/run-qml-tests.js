import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const QT6_QMLTESTRUNNER = '/usr/lib/qt6/bin/qmltestrunner';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = join(root, 'tests', 'qml');

if (!existsSync(QT6_QMLTESTRUNNER)) {
  console.error(`Qt 6 qmltestrunner is missing at ${QT6_QMLTESTRUNNER}`);
  process.exitCode = 1;
} else {
  const result = spawnSync(QT6_QMLTESTRUNNER, ['-input', testDirectory], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      QT_QPA_PLATFORM: 'offscreen',
      // Only the module-isolation source scan reads local .js files via
      // XMLHttpRequest to assert their contents; production QML/JS never
      // uses XHR against the filesystem.
      QML_XHR_ALLOW_FILE_READ: '1',
    },
    stdio: 'inherit',
  });

  if (result.error !== undefined) {
    console.error(`QML test runner could not be started: ${String(result.error.message)}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
