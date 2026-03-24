#!/usr/bin/env node

/**
 * ensemble CLI — bin wrapper
 * Runs the TypeScript CLI entrypoint via tsx.
 */

const { execFileSync } = require('child_process');
const { join, resolve } = require('path');
const { existsSync } = require('fs');

// Resolve the actual package root (not the .bin symlink target)
function findPackageRoot() {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = require(pkgPath);
        if (pkg.name === '@ensemble-ai/cli') return dir;
      } catch {}
    }
    dir = resolve(dir, '..');
  }
  // Fallback: assume bin/ is inside package root
  return resolve(__dirname, '..');
}

const root = findPackageRoot();
const cli = join(root, 'cli', 'ensemble.ts');

// Find tsx: own node_modules, hoisted, or PATH
function findTsx() {
  const candidates = [
    join(root, 'node_modules', '.bin', 'tsx'),
    join(root, '..', '.bin', 'tsx'),
    join(root, '..', '..', '.bin', 'tsx'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return 'tsx';
}

try {
  execFileSync(findTsx(), [cli, ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: Object.assign({}, process.env, { ENSEMBLE_ROOT: root }),
  });
} catch (err) {
  process.exit(err.status || 1);
}
