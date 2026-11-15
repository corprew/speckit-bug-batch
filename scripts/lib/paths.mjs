// Repo ids and the per-repository state folder (plan §3, §5).
//
// A repo id is the first 16 hex characters of the sha256 of the normalized origin
// URL, so every clone of a repository shares one id, and with it one set of
// heavy-job slots and batch state. With no origin remote, the id comes from the
// real path of the git common dir instead (one id per clone), and a warning says so.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const DEFAULT_PORTS = { ssh: '22', https: '443', http: '80', git: '9418' };

// Normalize a git remote URL to `host/path` (lowercase, no credentials, no
// default port, no trailing `.git` or `/`). Local paths become `file:<abs path>`.
export function normalizeRemoteUrl(url, { base = process.cwd() } = {}) {
  const raw = String(url ?? '').trim();
  if (raw === '') throw new Error('empty remote URL');

  // scp-like syntax: [user@]host:path (no scheme, and the colon isn't a drive letter)
  const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) {
    return tidy(`${scp[1]}/${scp[2]}`);
  }

  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (!scheme) return `file:${realish(resolve(base, raw))}`;

  const kind = scheme[1].toLowerCase();
  if (kind === 'file') return `file:${realish(decodeURIComponent(new URL(raw).pathname))}`;

  const u = new URL(raw.replace(/^git\+ssh:/i, 'ssh:').replace(/^ssh\+git:/i, 'ssh:'));
  const proto = u.protocol.replace(':', '');
  const port = u.port && u.port !== DEFAULT_PORTS[proto] ? `:${u.port}` : '';
  return tidy(`${u.hostname}${port}${decodeURIComponent(u.pathname)}`);
}

// Real path when it exists (so /tmp and /private/tmp agree), without a trailing slash.
function realish(p) {
  const trimmed = p.replace(/\/+$/, '') || '/';
  return existsSync(trimmed) ? realpathSync(trimmed) : trimmed;
}

function tidy(s) {
  return s
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

export function repoIdFromString(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export function repoIdFromUrl(url) {
  return repoIdFromString(normalizeRemoteUrl(url));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Resolve the repo id for the repository containing `cwd`.
// Returns { id, source: 'origin' | 'git-dir', key, warning? }.
export function resolveRepoId({ cwd = process.cwd(), remote = 'origin' } = {}) {
  let url = null;
  try {
    url = git(['remote', 'get-url', remote], cwd);
  } catch {
    url = null;
  }
  if (url) {
    // Relative remote paths are resolved from the main checkout, so every worktree
    // of a clone gets the same id.
    const base = dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd));
    const key = normalizeRemoteUrl(url, { base });
    return { id: repoIdFromString(key), source: 'origin', key };
  }
  let commonDir;
  try {
    commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  } catch (err) {
    throw new Error(`not a git repository: ${cwd}`);
  }
  const key = `git-dir:${realpathSync(commonDir)}`;
  return {
    id: repoIdFromString(key),
    source: 'git-dir',
    key,
    warning: `no "${remote}" remote; the repo id comes from this clone's git dir, so other clones won't share its locks or state`,
  };
}

// ${XDG_STATE_HOME:-~/.local/state}/speckit-bug-batch. A relative XDG_STATE_HOME
// is ignored, as the XDG spec requires.
export function stateRoot({ env = process.env, home = homedir() } = {}) {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'state');
  return join(base, 'speckit-bug-batch');
}

export function repoPaths(id, opts = {}) {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error(`invalid repo id: ${id}`);
  const repo = join(stateRoot(opts), id);
  return { root: stateRoot(opts), repo, locks: join(repo, 'locks'), batches: join(repo, 'batches') };
}

export function ensureRepoDirs(paths) {
  mkdirSync(paths.locks, { recursive: true });
  mkdirSync(paths.batches, { recursive: true });
  return paths;
}
