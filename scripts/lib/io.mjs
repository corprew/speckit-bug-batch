// Shared helpers for the scripts: JSON output, exit codes, atomic writes and
// secret redaction (plan §1, §5, §6; spec NFR-4).
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

// Every script prints one JSON document on stdout and exits with one of these.
export const EXIT = Object.freeze({
  OK: 0, // ran, and the answer is yes (for example resources ok, lock acquired)
  FAIL: 1, // ran, and the answer is no (for example a limit is exceeded)
  USAGE: 2, // bad arguments or bad config
  ENV: 3, // the environment is broken (git missing, not a repo, I/O error)
});

// ---- Redaction -------------------------------------------------------------

export const SECRET_ENV_VARS = ['LINEAR_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

const SECRET_PATTERNS = [
  /\blin_(?:api|oauth)_[A-Za-z0-9]{16,}\b/g, // Linear keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained tokens
  /(\bAuthorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|token|Basic)\s+)?[^\s"',}]+/gi, // auth headers, plain or JSON
  /(\/\/)[^/@\s:]+:[^/@\s]+@/g, // credentials in URLs: //user:pass@
];

export const REDACTED = '[REDACTED]';

function secretValues(env, extraNames) {
  const names = [...SECRET_ENV_VARS, ...extraNames];
  return names
    .map((n) => env[n])
    .filter((v) => typeof v === 'string' && v.length >= 8)
    .sort((a, b) => b.length - a.length);
}

export function redactString(s, { env = process.env, extraEnvNames = [] } = {}) {
  let out = String(s);
  for (const value of secretValues(env, extraEnvNames)) out = out.split(value).join(REDACTED);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, prefix) => (typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}${REDACTED}${prefix === '//' ? '@' : ''}` : REDACTED));
  }
  return out;
}

// Deep-redact strings inside plain data. Errors become { name, message, code }.
export function redact(value, opts = {}, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value, opts);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) {
    const out = { name: value.name, message: redactString(value.message, opts) };
    for (const key of ['code', 'path', 'line']) if (value[key] != null) out[key] = redact(value[key], opts, seen);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, opts, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redact(v, opts, seen);
  return out;
}

// ---- Output ----------------------------------------------------------------

export function formatJson(value, opts) {
  return `${JSON.stringify(redact(value, opts), null, 2)}\n`;
}

export function printJson(value, { stream = process.stdout, ...opts } = {}) {
  stream.write(formatJson(value, opts));
}

// Map a thrown error to an exit code: ConfigError and UsageError are usage
// problems; anything else is the environment.
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.code = 'E_USAGE';
  }
}

export function exitCodeFor(err) {
  if (err?.name === 'ConfigError' || err?.name === 'UsageError') return EXIT.USAGE;
  return EXIT.ENV;
}

// Run a script body. `fn` returns { result, exitCode? }. The result is printed as
// JSON; a thrown error is printed as { ok: false, error } with a matching exit code.
export async function runMain(fn, { stream = process.stdout } = {}) {
  try {
    const { result, exitCode = EXIT.OK } = await fn();
    printJson(result, { stream });
    process.exitCode = exitCode;
  } catch (err) {
    printJson({ ok: false, error: err }, { stream });
    process.exitCode = exitCodeFor(err);
  }
}

// ---- Atomic writes ---------------------------------------------------------

// Write to a temp file in the same folder, fsync it, then rename over the target,
// so readers see the old file or the new one and never a partial one.
export function atomicWrite(path, data) {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
  try {
    const dfd = openSync(dir, 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Directory fsync isn't supported everywhere; the rename is still atomic.
  }
}

export function atomicWriteJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}
