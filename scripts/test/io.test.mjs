import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../lib/config.mjs';
import { atomicWrite, atomicWriteJson, EXIT, exitCodeFor, formatJson, redact, redactString, REDACTED, UsageError } from '../lib/io.mjs';

const ioUrl = new URL('../lib/io.mjs', import.meta.url).href;

test('redact: values of secret env vars are removed wherever they appear', () => {
  const env = { LINEAR_API_KEY: 'abcd1234efgh5678', GH_TOKEN: 'tok-0000-1111' };
  const out = redactString('key=abcd1234efgh5678 and tok-0000-1111!', { env });
  assert.equal(out, `key=${REDACTED} and ${REDACTED}!`);
  assert.equal(redactString('short', { env: { LINEAR_API_KEY: 'short' } }), 'short', 'values under 8 chars are not treated as secrets');
  assert.equal(redactString('x MY_SECRET_VALUE y', { env: { CUSTOM: 'MY_SECRET_VALUE' }, extraEnvNames: ['CUSTOM'] }), `x ${REDACTED} y`);
});

test('redact: known token shapes, auth headers and URL credentials', () => {
  const env = {};
  assert.equal(redactString('lin_api_ABCDEFGHIJKLMNOPqrst', { env }), REDACTED);
  assert.equal(redactString(`ghp_${'a'.repeat(36)}`, { env }), REDACTED);
  assert.equal(redactString(`github_pat_${'A1_'.repeat(10)}`, { env }), REDACTED);
  assert.equal(redactString('Authorization: Bearer abc.def', { env }), `Authorization: ${REDACTED}`);
  assert.equal(redactString('{"Authorization":"Bearer abc"}', { env }), `{"Authorization":"${REDACTED}"}`);
  assert.equal(redactString("authorization='token xyz'", { env }), `authorization='${REDACTED}'`);
  assert.equal(redactString('https://user:pa55@github.com/o/r', { env }), `https://${REDACTED}@github.com/o/r`);
});

test('redact: deep over objects, arrays and errors, without mutating input', () => {
  const env = { LINEAR_API_KEY: 'supersecretkey123' };
  const err = new ConfigError('E_X', 'failed with supersecretkey123', { path: 'a.b' });
  const input = { a: ['supersecretkey123', 1, null], nested: { e: err }, ok: true };
  const out = redact(input, { env });
  assert.deepEqual(out, {
    a: [REDACTED, 1, null],
    nested: { e: { name: 'ConfigError', message: `a.b: failed with ${REDACTED}`, code: 'E_X', path: 'a.b' } },
    ok: true,
  });
  assert.equal(input.a[0], 'supersecretkey123');
  const circ = { x: 1 };
  circ.self = circ;
  assert.deepEqual(redact(circ, { env }), { x: 1, self: '[Circular]' });
});

test('formatJson redacts and ends with a newline', () => {
  const s = formatJson({ k: 'abcd1234efgh5678' }, { env: { LINEAR_API_KEY: 'abcd1234efgh5678' } });
  assert.equal(s, `{\n  "k": "${REDACTED}"\n}\n`);
});

test('exit codes: config and usage errors are USAGE, anything else ENV', () => {
  assert.deepEqual(EXIT, { OK: 0, FAIL: 1, USAGE: 2, ENV: 3 });
  assert.equal(exitCodeFor(new ConfigError('E', 'x')), EXIT.USAGE);
  assert.equal(exitCodeFor(new UsageError('x')), EXIT.USAGE);
  assert.equal(exitCodeFor(new Error('x')), EXIT.ENV);
});

function runScript(body, env = {}) {
  const src = `import { runMain, EXIT, UsageError } from ${JSON.stringify(ioUrl)};\n${body}`;
  try {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.status, json: JSON.parse(err.stdout) };
  }
}

test('runMain: prints the result with its exit code', () => {
  const r = runScript('await runMain(async () => ({ result: { ok: false, reasons: ["load"] }, exitCode: EXIT.FAIL }));');
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { ok: false, reasons: ['load'] });
});

test('runMain: a thrown error becomes redacted JSON and a matching exit code', () => {
  const r = runScript('await runMain(async () => { throw new UsageError("bad flag " + process.env.LINEAR_API_KEY); });', { LINEAR_API_KEY: 'leakyleakyleaky1' });
  assert.equal(r.code, 2);
  assert.deepEqual(r.json, { ok: false, error: { name: 'UsageError', message: `bad flag ${REDACTED}`, code: 'E_USAGE' } });
  assert.equal(runScript('await runMain(async () => { throw new Error("boom"); });').code, 3);
});

test('atomicWrite: replaces the file and leaves no temp files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-io-'));
  try {
    const file = join(dir, 'state.json');
    writeFileSync(file, 'old');
    atomicWriteJson(file, { v: 1 });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 1 });
    assert.deepEqual(readdirSync(dir), ['state.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomicWrite: a failed write removes the temp file and keeps the old content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-io-'));
  try {
    const file = join(dir, 'state.json');
    writeFileSync(file, 'old');
    assert.throws(() => atomicWrite(file, Symbol('not writable')));
    assert.equal(readFileSync(file, 'utf8'), 'old');
    assert.deepEqual(readdirSync(dir), ['state.json']);
    assert.throws(() => atomicWrite(join(dir, 'missing-dir', 'x.json'), 'x'), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomicWrite: concurrent writers never leave a partial file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-io-'));
  const file = join(dir, 'state.json');
  const writer = (n) =>
    new Promise((resolve, reject) => {
      const src = `import { atomicWriteJson } from ${JSON.stringify(ioUrl)};
        const big = 'x'.repeat(200000);
        for (let i = 0; i < 30; i++) atomicWriteJson(${JSON.stringify(file)}, { writer: ${n}, i, big });`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: 'inherit' });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${n} exited ${code}`))));
    });
  try {
    let reads = 0;
    let done = false;
    const all = Promise.all([0, 1, 2, 3].map(writer)).finally(() => (done = true));
    while (!done) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        assert.equal(parsed.big.length, 200000);
        reads++;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      await new Promise((r) => setImmediate(r));
    }
    await all;
    assert.ok(reads > 0, 'the reader saw at least one complete file');
    assert.deepEqual(readdirSync(dir), ['state.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
