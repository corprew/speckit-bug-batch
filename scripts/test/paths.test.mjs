import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRepoDirs, normalizeRemoteUrl, repoIdFromUrl, repoPaths, resolveRepoId, stateRoot } from '../lib/paths.mjs';

test('paths: one repo id across ssh, https, ssh:// and .git forms', () => {
  const forms = [
    'git@github.com:Owner/Repo.git',
    'git@github.com:owner/repo',
    'https://github.com/owner/repo.git',
    'https://github.com/Owner/Repo/',
    'https://user:secret-token@github.com/owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'ssh://git@github.com:22/owner/repo',
    'git+ssh://git@github.com/owner/repo.git',
    'https://github.com:443/owner/repo',
  ];
  const keys = new Set(forms.map((f) => normalizeRemoteUrl(f)));
  assert.deepEqual([...keys], ['github.com/owner/repo']);
  const ids = new Set(forms.map(repoIdFromUrl));
  assert.equal(ids.size, 1);
  assert.match([...ids][0], /^[0-9a-f]{16}$/);
});

test('paths: different repos, hosts and non-default ports get different ids', () => {
  const ids = new Set(
    ['git@github.com:owner/repo.git', 'git@github.com:owner/other.git', 'git@gitlab.com:owner/repo.git', 'ssh://git@github.com:2222/owner/repo'].map(repoIdFromUrl),
  );
  assert.equal(ids.size, 4);
});

test('paths: credentials never reach the normalized key', () => {
  assert.doesNotMatch(normalizeRemoteUrl('https://user:secret-token@github.com/o/r.git'), /secret|user/);
});

test('paths: local paths and file:// URLs normalize to the same real path', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bb-paths-')));
  try {
    assert.equal(normalizeRemoteUrl(dir), `file:${dir}`);
    assert.equal(normalizeRemoteUrl(`${dir}/`), `file:${dir}`);
    assert.equal(normalizeRemoteUrl(`file://${dir}`), `file:${dir}`);
    assert.equal(normalizeRemoteUrl('../x', { base: '/a/b' }), 'file:/a/x');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paths: stateRoot follows XDG_STATE_HOME, ignoring relative values', () => {
  assert.equal(stateRoot({ env: {}, home: '/h' }), '/h/.local/state/speckit-bug-batch');
  assert.equal(stateRoot({ env: { XDG_STATE_HOME: '/x/state' }, home: '/h' }), '/x/state/speckit-bug-batch');
  assert.equal(stateRoot({ env: { XDG_STATE_HOME: 'rel/state' }, home: '/h' }), '/h/.local/state/speckit-bug-batch');
});

test('paths: repoPaths lays out locks and batches, and rejects bad ids', () => {
  const p = repoPaths('0123456789abcdef', { env: {}, home: '/h' });
  assert.deepEqual(p, {
    root: '/h/.local/state/speckit-bug-batch',
    repo: '/h/.local/state/speckit-bug-batch/0123456789abcdef',
    locks: '/h/.local/state/speckit-bug-batch/0123456789abcdef/locks',
    batches: '/h/.local/state/speckit-bug-batch/0123456789abcdef/batches',
  });
  assert.throws(() => repoPaths('../../etc'), /invalid repo id/);
});

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

test('resolveRepoId: same id from a clone, a nested linked worktree (relative remote), and another clone', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bb-repo-')));
  try {
    git(['init', '-q', '--bare', '-b', 'main', join(root, 'origin.git')], root);
    git(['clone', '-q', join(root, 'origin.git'), join(root, 'a')], root);
    git(['clone', '-q', join(root, 'origin.git'), join(root, 'b')], root);
    const a = join(root, 'a');
    git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], a);
    // A relative remote: resolving it from the worktree instead of the main
    // checkout would point somewhere else (wts/origin.git).
    git(['remote', 'set-url', 'origin', '../origin.git'], a);
    git(['worktree', 'add', '-q', join(root, 'wts', 'wt'), '-b', 'w'], a);

    const fromA = resolveRepoId({ cwd: a });
    assert.equal(fromA.source, 'origin');
    assert.equal(fromA.key, `file:${join(root, 'origin.git')}`);
    assert.equal(resolveRepoId({ cwd: join(root, 'wts', 'wt') }).id, fromA.id);
    assert.equal(resolveRepoId({ cwd: join(root, 'b') }).id, fromA.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveRepoId: no origin falls back to the git dir with a warning', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bb-repo-')));
  try {
    git(['init', '-q', '-b', 'main', root], root);
    const r = resolveRepoId({ cwd: root });
    assert.equal(r.source, 'git-dir');
    assert.match(r.warning, /no "origin" remote/);
    assert.equal(r.key, `git-dir:${join(root, '.git')}`);
    assert.throws(() => resolveRepoId({ cwd: tmpdir() }), /not a git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureRepoDirs creates the locks and batches folders', () => {
  const home = mkdtempSync(join(tmpdir(), 'bb-home-'));
  try {
    const p = ensureRepoDirs(repoPaths('0123456789abcdef', { env: {}, home }));
    assert.ok(existsSync(p.locks));
    assert.ok(existsSync(p.batches));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
