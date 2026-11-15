import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const checker = join(root, 'scripts/check-syntax.mjs');

test('package.json: ESM, Node >=22, no dependencies', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines?.node, '>=22');
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(pkg[field], undefined, `${field} must not be set (the extension has no dependencies)`);
  }
});

test('package.json: test script uses the spec reporter and a test glob', () => {
  assert.match(pkg.scripts.test, /--test-reporter=spec/);
  assert.match(pkg.scripts.test, /scripts\/test\/\*\*\/\*\.test\.mjs/);
});

function runChecker(files) {
  const dir = mkdtempSync(join(tmpdir(), 'bb-check-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    try {
      const stdout = execFileSync(process.execPath, [checker, dir], { encoding: 'utf8', stdio: 'pipe' });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.status, stdout: err.stdout, stderr: err.stderr };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('check-syntax: passes valid files, including nested ones', () => {
  const r = runChecker({ 'a.mjs': 'export const a = 1;\n', 'lib/b.mjs': 'export default 2;\n' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /checked 2 file\(s\), 0 with syntax errors/);
});

test('check-syntax: fails on a bad file even when it is not the first', () => {
  const r = runChecker({ 'a.mjs': 'export const a = 1;\n', 'z.mjs': 'export const = ;\n' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /z\.mjs/);
});

test('check-syntax: skips fixtures and node_modules', () => {
  const r = runChecker({ 'ok.mjs': '1;\n', 'fixtures/bad.mjs': 'nope(\n', 'node_modules/x/bad.js': 'nope(\n' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /checked 1 file\(s\)/);
});
