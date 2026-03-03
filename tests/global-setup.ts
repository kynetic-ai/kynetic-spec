import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export default function setup() {
  const root = join(import.meta.dirname, '..');
  const distCli = join(root, 'dist', 'cli', 'index.js');

  if (!existsSync(distCli)) {
    console.log('[global-setup] dist/cli/index.js not found — building...');
    execSync('npm run build', { cwd: root, stdio: 'inherit' });
  }
}
