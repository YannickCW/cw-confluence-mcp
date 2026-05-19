#!/usr/bin/env node
// Sync the version from package.json into source files that hard-code it.
// Runs automatically before `npm run build` (via the `prebuild` hook).
// Run manually with `npm run sync-version`.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const targets = [
  {
    path: join(root, 'src', 'index.ts'),
    pattern: /const SERVER_VERSION = '[^']*';/,
    replacement: `const SERVER_VERSION = '${VERSION}';`,
  },
];

let changed = 0;
let failed = false;

for (const { path, pattern, replacement } of targets) {
  const rel = relative(root, path);
  const before = readFileSync(path, 'utf8');

  if (!pattern.test(before)) {
    console.error(`sync-version: pattern not found in ${rel}`);
    failed = true;
    continue;
  }

  const after = before.replace(pattern, replacement);
  if (before !== after) {
    writeFileSync(path, after);
    console.log(`sync-version: ${rel} → ${VERSION}`);
    changed++;
  }
}

if (failed) process.exit(1);
if (changed === 0) console.log(`sync-version: all targets already at ${VERSION}`);
