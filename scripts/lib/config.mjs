// Load .specify/bug-batch.yml, merge it with the defaults, and validate it.
//
// loadConfig({ root }) returns { config, source, warnings }:
//   - config: the merged, validated configuration
//   - source: the file path, or null when the file is missing (defaults only)
//   - warnings: strings for the caller to show
// It throws ConfigError (code, path, line) for anything invalid.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, YamlError } from './yaml.mjs';

export const CONFIG_PATH = '.specify/bug-batch.yml';

export class ConfigError extends Error {
  constructor(code, message, { path = null, line = null } = {}) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'ConfigError';
    this.code = code;
    this.path = path;
    this.line = line;
  }
}

// Defaults follow spec.md (FR-003, NFR-1, US5, US6) and plan.md §3.
export const DEFAULTS = Object.freeze({
  base_branch: null, // null: use origin's default branch (origin/HEAD)
  trackers: {
    github: { enabled: true },
    linear: { enabled: false, team_keys: [], api_key_env: 'LINEAR_API_KEY' },
  },
  low_risk: {
    policy: 'moderate',
    bug_labels: ['bug', 'type:bug', 'kind/bug'],
    exclude_labels: ['severity:high', 'severity:critical', 'priority:critical', 'feature', 'enhancement', 'spec', 'question'],
    flaky_labels: ['flaky', 'flaky-test'],
    excluded_paths: [
      '**/migrations/**',
      '.github/**',
      'infra/**',
      '**/Dockerfile',
      '.specify/memory/security_constitution.md',
    ],
  },
  areas: {},
  hot_files: [],
  limits: {
    max_parallel: 3,
    batch_size: 6,
    max_heavy: 1,
    max_load_ratio: 0.8,
    min_free_memory_gb: 4,
    min_free_disk_gb: 10,
  },
  worktree: { setup: [], teardown: [], env: {} },
  tests: { targeted: [] },
  reviews: ['/speckit-security-review-branch', '/code-review'],
  review_dir: 'docs/security-reviews',
  branch_pattern: 'fix/{issue}-{slug}',
  pr: { base: null, draft: true, body_template: null }, // base null: same as base_branch
  screenshots_required: false,
});

// Schema node kinds: 'string', 'string?', 'bool', 'int+', 'number+', 'ratio',
// ['string'] (list of strings), { ... } (fixed keys), { '*': kind } (free keys),
// and { list: { ... } } (list of fixed-key maps).
const SCHEMA = {
  base_branch: 'string?',
  trackers: {
    github: { enabled: 'bool' },
    linear: { enabled: 'bool', team_keys: ['string'], api_key_env: 'string' },
  },
  low_risk: {
    policy: 'string',
    bug_labels: ['string'],
    exclude_labels: ['string'],
    flaky_labels: ['string'],
    excluded_paths: ['string'],
  },
  areas: { '*': ['string'] },
  hot_files: { list: { path: 'string', regenerate: 'string?' }, required: ['path'] },
  limits: {
    max_parallel: 'int+',
    batch_size: 'int+',
    max_heavy: 'int+',
    max_load_ratio: 'number+',
    min_free_memory_gb: 'number+',
    min_free_disk_gb: 'number+',
  },
  worktree: { setup: ['string'], teardown: ['string'], env: { '*': 'string' } },
  tests: {
    targeted: { list: { paths: ['string'], command: 'string', heavy: 'bool' }, required: ['paths', 'command'] },
  },
  reviews: ['string'],
  review_dir: 'string',
  branch_pattern: 'string',
  pr: { base: 'string?', draft: 'bool', body_template: 'string?' },
  screenshots_required: 'bool',
};

const POLICIES = ['moderate', 'strict', 'custom'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v === 'object' ? 'mapping' : typeof v);

function bad(path, message) {
  return new ConfigError('E_TYPE', message, { path });
}

function validate(value, schema, path) {
  if (typeof schema === 'string') {
    switch (schema) {
      case 'string':
        if (typeof value !== 'string' || value === '') throw bad(path, `expected a non-empty string, got ${typeName(value)}`);
        return;
      case 'string?':
        if (value !== null && (typeof value !== 'string' || value === '')) throw bad(path, `expected a string or null, got ${typeName(value)}`);
        return;
      case 'bool':
        if (typeof value !== 'boolean') throw bad(path, `expected true or false, got ${typeName(value)}`);
        return;
      case 'int+':
        if (!Number.isInteger(value) || value < 1) throw new ConfigError('E_RANGE', `expected a whole number of at least 1, got ${JSON.stringify(value)}`, { path });
        return;
      case 'number+':
        if (typeof value !== 'number' || !(value > 0)) throw new ConfigError('E_RANGE', `expected a number greater than 0, got ${JSON.stringify(value)}`, { path });
        return;
      default:
        throw new Error(`unknown schema kind ${schema}`);
    }
  }
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) throw bad(path, `expected a list, got ${typeName(value)}`);
    value.forEach((item, i) => validate(item, schema[0], `${path}[${i}]`));
    return;
  }
  if (schema.list) {
    if (!Array.isArray(value)) throw bad(path, `expected a list, got ${typeName(value)}`);
    value.forEach((item, i) => {
      const itemPath = `${path}[${i}]`;
      if (!isPlainObject(item)) throw bad(itemPath, `expected a mapping, got ${typeName(item)}`);
      for (const key of schema.required ?? []) {
        if (!(key in item)) throw new ConfigError('E_MISSING', `missing required key "${key}"`, { path: itemPath });
      }
      validateFixed(item, schema.list, itemPath);
    });
    return;
  }
  if (!isPlainObject(value)) throw bad(path, `expected a mapping, got ${typeName(value)}`);
  if ('*' in schema) {
    for (const [key, v] of Object.entries(value)) validate(v, schema['*'], `${path}.${key}`);
    return;
  }
  validateFixed(value, schema, path);
}

function validateFixed(value, schema, path) {
  for (const [key, v] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (!(key in schema)) throw new ConfigError('E_UNKNOWN_KEY', `unknown key "${key}"`, { path: childPath });
    validate(v, schema[key], childPath);
  }
}

function clone(v) {
  return v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v));
}

// Mappings merge key by key; lists and scalars from the user replace the default.
// Free-key mappings (areas, worktree.env) replace too, so defaults never leak in.
function merge(defaults, user, schema) {
  if (!isPlainObject(defaults) || !isPlainObject(user) || '*' in schema || schema.list) return clone(user);
  const out = clone(defaults);
  for (const [key, v] of Object.entries(user)) {
    out[key] = key in defaults ? merge(defaults[key], v, schema[key]) : clone(v);
  }
  return out;
}

function crossChecks(config) {
  const warnings = [];
  const { limits } = config;
  if (!POLICIES.includes(config.low_risk.policy)) {
    throw new ConfigError('E_RANGE', `expected one of ${POLICIES.join(', ')}, got "${config.low_risk.policy}"`, { path: 'low_risk.policy' });
  }
  if (limits.max_load_ratio > 4) {
    throw new ConfigError('E_RANGE', `expected a ratio of load average to CPU count (for example 0.8), got ${limits.max_load_ratio}`, { path: 'limits.max_load_ratio' });
  }
  if (!config.branch_pattern.includes('{slug}')) {
    throw new ConfigError('E_RANGE', 'must contain {slug} so every bug gets its own branch', { path: 'branch_pattern' });
  }
  if (/\s|\.\.|^\/|\/$|~|\^|:|\\/.test(config.branch_pattern.replace(/\{(issue|slug)\}/g, 'x'))) {
    throw new ConfigError('E_RANGE', 'is not a valid git branch name pattern', { path: 'branch_pattern' });
  }
  if (limits.batch_size < limits.max_parallel) {
    warnings.push(`limits.batch_size (${limits.batch_size}) is smaller than limits.max_parallel (${limits.max_parallel}), so at most ${limits.batch_size} bugs will run at once`);
  }
  if (config.trackers.linear.enabled && config.trackers.linear.team_keys.length === 0) {
    throw new ConfigError('E_MISSING', 'Linear is enabled but no team keys are set', { path: 'trackers.linear.team_keys' });
  }
  for (const name of Object.keys(config.worktree.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ConfigError('E_RANGE', 'is not a valid environment variable name', { path: `worktree.env.${name}` });
    }
  }
  return warnings;
}

// Parse, merge and validate config text. Exposed for tests and for callers that
// already have the text.
export function parseConfig(text, { source = CONFIG_PATH } = {}) {
  let user;
  try {
    user = parseYaml(text);
  } catch (err) {
    if (err instanceof YamlError) throw new ConfigError('E_PARSE', `${source}: ${err.message}`, { line: err.line });
    throw err;
  }
  if (!isPlainObject(user)) throw new ConfigError('E_TYPE', `${source}: the top level must be a mapping`);
  validateFixed(user, SCHEMA, '');
  const config = merge(DEFAULTS, user, SCHEMA);
  validate(config, SCHEMA, '');
  const warnings = crossChecks(config);
  return { config, warnings };
}

export function loadConfig({ root = process.cwd(), file = CONFIG_PATH } = {}) {
  const path = join(root, file);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      const { config, warnings } = parseConfig('');
      return { config, source: null, warnings: [`${file} not found; using the defaults`, ...warnings] };
    }
    throw new ConfigError('E_READ', `cannot read ${file}: ${err.code ?? err.message}`);
  }
  const { config, warnings } = parseConfig(text, { source: file });
  return { config, source: path, warnings };
}
