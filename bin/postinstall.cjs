#!/usr/bin/env node

/**
 * postinstall — make shell scripts executable after npm install
 */

const { readdirSync, chmodSync } = require('fs');
const { join } = require('path');

const root = join(__dirname, '..');
const scriptsDir = join(root, 'scripts');

try {
  const scripts = readdirSync(scriptsDir).filter(f => f.endsWith('.sh') || f.endsWith('.py'));
  for (const script of scripts) {
    chmodSync(join(scriptsDir, script), 0o755);
  }
} catch {
  // scripts dir may not exist in dev, that's fine
}
