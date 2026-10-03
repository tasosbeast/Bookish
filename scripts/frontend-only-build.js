import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Render's bookish-web service builds with rootDir=frontend, so this copies
// only that directory and builds it outside the repo. An import of ../src fails.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = join(repoRoot, 'frontend');
const modules = join(frontendRoot, 'node_modules');

if (!existsSync(modules)) {
  console.error('frontend/node_modules is missing. Run npm ci --prefix frontend first.');
  process.exit(1);
}
if (!process.env.VITE_API_BASE_URL) {
  console.error('VITE_API_BASE_URL is required');
  process.exit(1);
}

const dest = mkdtempSync(join(tmpdir(), 'bookish-frontend-only-'));
let status = 1;
try {
  cpSync(frontendRoot, dest, {
    recursive: true,
    filter: source => {
      const rel = relative(frontendRoot, source);
      if (rel === 'node_modules' || rel.startsWith(`node_modules${sep}`)) return false;
      if (rel === 'dist' || rel.startsWith(`dist${sep}`)) return false;
      return true;
    },
  });
  symlinkSync(modules, join(dest, 'node_modules'), 'dir');
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: dest,
    stdio: 'inherit',
    env: process.env,
  });
  status = result.status === null ? 1 : result.status;
} finally {
  rmSync(dest, { recursive: true, force: true });
}
process.exit(status);
