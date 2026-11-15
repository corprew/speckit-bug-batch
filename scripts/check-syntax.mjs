#!/usr/bin/env node
// Syntax-check every .mjs/.js file under the given directories with `node --check`.
//
// `node --check` only checks its first argument, so each file gets its own run.
// Directories named node_modules or fixtures are skipped (fixtures may be
// deliberately invalid).
//
// Usage: node scripts/check-syntax.mjs [dir ...]   (default: scripts)
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', 'fixtures']);

export function listSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...listSources(path));
    } else if (/\.(mjs|js)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out.sort();
}

export function checkFiles(files) {
  const failures = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      failures.push({ file, message: String(err.stderr || err.message).trim() });
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dirs = process.argv.length > 2 ? process.argv.slice(2) : ['scripts'];
  const files = dirs.flatMap(listSources);
  const failures = checkFiles(files);
  for (const { file, message } of failures) console.error(`✖ ${file}\n${message}\n`);
  console.log(`checked ${files.length} file(s), ${failures.length} with syntax errors`);
  process.exitCode = failures.length ? 1 : 0;
}
