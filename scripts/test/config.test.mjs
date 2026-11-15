import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, DEFAULTS, loadConfig, parseConfig } from '../lib/config.mjs';

const expectConfigError = (text, code, pathRe) =>
  assert.throws(
    () => parseConfig(text),
    (err) => err instanceof ConfigError && err.code === code && (!pathRe || pathRe.test(err.path ?? err.message)),
  );

test('config: an empty file gives the spec defaults', () => {
  const { config, warnings } = parseConfig('');
  assert.deepEqual(config, JSON.parse(JSON.stringify(DEFAULTS)));
  assert.deepEqual(warnings, []);
  assert.equal(config.limits.max_parallel, 3);
  assert.equal(config.limits.batch_size, 6);
  assert.equal(config.limits.max_heavy, 1);
  assert.equal(config.branch_pattern, 'fix/{issue}-{slug}');
  assert.deepEqual(config.reviews, ['/speckit-security-review-branch', '/code-review']);
  assert.equal(config.pr.draft, true);
});

test('config: mappings merge with defaults; lists replace them', () => {
  const { config } = parseConfig(`
base_branch: develop
limits:
  max_parallel: 2
reviews: [/code-review]
low_risk:
  excluded_paths: ["**/sql/**"]
`);
  assert.equal(config.base_branch, 'develop');
  assert.equal(config.limits.max_parallel, 2);
  assert.equal(config.limits.batch_size, 6, 'unset limits keep their defaults');
  assert.deepEqual(config.reviews, ['/code-review']);
  assert.deepEqual(config.low_risk.excluded_paths, ['**/sql/**']);
  assert.deepEqual(config.low_risk.bug_labels, DEFAULTS.low_risk.bug_labels);
});

test('config: areas, hot files, targeted tests and worktree env', () => {
  const { config } = parseConfig(`
areas:
  api: [apps/api/**]
  docs: [docs/**]
hot_files:
  - path: packages/a/package.json
    regenerate: npm version minor --no-git-tag-version
  - path: "db/sql/*.sql"
tests:
  targeted:
    - paths: [apps/api/**]
      command: npm test -- {files}
      heavy: false
worktree:
  setup: [npm ci]
  env:
    DATABASE_URL: postgres://localhost/app_{slug}
`);
  assert.deepEqual(Object.keys(config.areas), ['api', 'docs']);
  assert.equal(config.hot_files[1].path, 'db/sql/*.sql');
  assert.equal(config.tests.targeted[0].command, 'npm test -- {files}');
  assert.equal(config.worktree.env.DATABASE_URL, 'postgres://localhost/app_{slug}');
  assert.deepEqual(config.worktree.teardown, []);
});

test('config: unknown keys are errors, at any depth', () => {
  expectConfigError('limts:\n  max_parallel: 2\n', 'E_UNKNOWN_KEY', /^limts$/);
  expectConfigError('limits:\n  max_paralel: 2\n', 'E_UNKNOWN_KEY', /^limits\.max_paralel$/);
  expectConfigError('hot_files:\n  - path: a\n    regen: b\n', 'E_UNKNOWN_KEY', /^hot_files\[0\]\.regen$/);
});

test('config: wrong types and ranges are errors with a path', () => {
  expectConfigError('limits:\n  max_parallel: 0\n', 'E_RANGE', /limits\.max_parallel/);
  expectConfigError('limits:\n  max_parallel: 1.5\n', 'E_RANGE', /limits\.max_parallel/);
  expectConfigError('limits:\n  max_load_ratio: 80\n', 'E_RANGE', /limits\.max_load_ratio/);
  expectConfigError('reviews: /code-review\n', 'E_TYPE', /^reviews$/);
  expectConfigError('pr:\n  draft: "yes"\n', 'E_TYPE', /pr\.draft/);
  expectConfigError('areas:\n  api: apps/api\n', 'E_TYPE', /areas\.api/);
  expectConfigError('limits:\n', 'E_TYPE', /^limits$/);
  expectConfigError('low_risk:\n  policy: lax\n', 'E_RANGE', /low_risk\.policy/);
});

test('config: required keys in list items', () => {
  expectConfigError('hot_files:\n  - regenerate: x\n', 'E_MISSING', /hot_files\[0\]/);
  expectConfigError('tests:\n  targeted:\n    - paths: [a/**]\n', 'E_MISSING', /tests\.targeted\[0\]/);
});

test('config: branch pattern must contain {slug} and be a valid branch name', () => {
  expectConfigError('branch_pattern: fix/{issue}\n', 'E_RANGE', /branch_pattern/);
  expectConfigError('branch_pattern: "fix/{slug} x"\n', 'E_RANGE', /branch_pattern/);
  expectConfigError('branch_pattern: fix/../{slug}\n', 'E_RANGE', /branch_pattern/);
  assert.equal(parseConfig('branch_pattern: bugfix/{slug}\n').config.branch_pattern, 'bugfix/{slug}');
});

test('config: Linear enabled without team keys is an error', () => {
  expectConfigError('trackers:\n  linear:\n    enabled: true\n', 'E_MISSING', /trackers\.linear\.team_keys/);
  const { config } = parseConfig('trackers:\n  linear:\n    enabled: true\n    team_keys: [ABC]\n');
  assert.equal(config.trackers.linear.api_key_env, 'LINEAR_API_KEY');
  assert.equal(config.trackers.github.enabled, true);
});

test('config: invalid env var names are errors', () => {
  expectConfigError('worktree:\n  env:\n    "BAD-NAME": x\n', 'E_RANGE', /worktree\.env\.BAD-NAME/);
});

test('config: batch_size below max_parallel is a warning, not an error', () => {
  const { warnings } = parseConfig('limits:\n  batch_size: 2\n');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /batch_size \(2\) is smaller than limits\.max_parallel \(3\)/);
});

test('config: YAML errors become E_PARSE with the line', () => {
  assert.throws(
    () => parseConfig('limits:\n  max_parallel: *x\n'),
    (err) => err instanceof ConfigError && err.code === 'E_PARSE' && err.line === 2,
  );
  expectConfigError('- a\n- b\n', 'E_TYPE');
});

test('config: defaults are not mutated by a load', () => {
  const before = JSON.stringify(DEFAULTS);
  const { config } = parseConfig('');
  config.limits.max_parallel = 99;
  config.reviews.push('x');
  assert.equal(JSON.stringify(DEFAULTS), before);
});

test('loadConfig: reads .specify/bug-batch.yml, or falls back to defaults with a warning', () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-config-'));
  try {
    let r = loadConfig({ root });
    assert.equal(r.source, null);
    assert.match(r.warnings[0], /not found; using the defaults/);
    mkdirSync(join(root, '.specify'));
    writeFileSync(join(root, '.specify/bug-batch.yml'), 'limits:\n  max_heavy: 2\n');
    r = loadConfig({ root });
    assert.equal(r.source, join(root, '.specify/bug-batch.yml'));
    assert.equal(r.config.limits.max_heavy, 2);
    assert.deepEqual(r.warnings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
