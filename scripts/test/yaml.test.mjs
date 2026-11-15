import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlError } from '../lib/yaml.mjs';

test('yaml: block maps, nested maps, scalars and comments', () => {
  const doc = parseYaml(`---
# leading comment
name: bug-batch   # trailing comment
count: 3
ratio: 0.8
on: true
off: false
none: null
tilde: ~
empty:
nested:
  deeper:
    key: value
url: http://example.com/a#frag
`);
  assert.deepEqual(doc, {
    name: 'bug-batch',
    count: 3,
    ratio: 0.8,
    on: true,
    off: false,
    none: null,
    tilde: null,
    empty: null,
    nested: { deeper: { key: 'value' } },
    url: 'http://example.com/a#frag',
  });
});

test('yaml: quoted strings keep colons, hashes and escapes', () => {
  const doc = parseYaml(`a: "x: y # not a comment"
b: 'it''s'
c: "line\\nnext \\"q\\""
d: "**/migrations/**"
"quoted key": 1
`);
  assert.deepEqual(doc, { a: 'x: y # not a comment', b: "it's", c: 'line\nnext "q"', d: '**/migrations/**', 'quoted key': 1 });
});

test('yaml: block sequences, sequences of maps, and same-indent sequences', () => {
  const doc = parseYaml(`list:
  - one
  - "two"
  - 3
flush:
- a
- b
maps:
  - path: x/package.json
    regenerate: npm version minor
  - path: "db/*.sql"
nested:
  -
    k: v
`);
  assert.deepEqual(doc, {
    list: ['one', 'two', 3],
    flush: ['a', 'b'],
    maps: [{ path: 'x/package.json', regenerate: 'npm version minor' }, { path: 'db/*.sql' }],
    nested: [{ k: 'v' }],
  });
});

test('yaml: inline lists and empty collections', () => {
  assert.deepEqual(parseYaml('a: [x, "y z", 3, ]\nb: []\nc: {}\n'), { a: ['x', 'y z', 3], b: [], c: {} });
});

test('yaml: an empty or comment-only document is an empty mapping', () => {
  assert.deepEqual(parseYaml(''), {});
  assert.deepEqual(parseYaml('# nothing\n\n'), {});
});

test('yaml: a top-level sequence is allowed', () => {
  assert.deepEqual(parseYaml('- a\n- b\n'), ['a', 'b']);
});

const rejects = [
  ['an alias', 'a: *x', /line 1: .*"\*" must be quoted/],
  ['an anchor', 'a: &x 1', /"&" must be quoted/],
  ['a tag', 'a: !str 1', /"!" must be quoted/],
  ['a block scalar', 'a: |\n  text', /"\|" must be quoted/],
  ['a folded scalar', 'a: >\n  text', /">" must be quoted/],
  ['a flow mapping', 'a: {b: 1}', /"\{" must be quoted/],
  ['a nested inline list', 'a: [[1]]', /nested inline/],
  ['an unquoted ": " in a value', 'a: b: c', /": " must be quoted/],
  ['a tab in indentation', 'a:\n\tb: 1', /line 2: tabs/],
  ['a duplicate key', 'a: 1\na: 2', /line 2: duplicate key "a"/],
  ['a second document', '---\na: 1\n---\nb: 2', /line 3: only one document/],
  ['bad indentation', 'a:\n  b: 1\n c: 2', /line 3: unexpected indentation/],
  ['an unterminated string', 'a: "x', /unterminated/],
  ['a complex key', '? a\n: b', /line 1/],
  ['a prototype key', '__proto__: 1', /not allowed/],
  ['an unsupported escape', 'a: "\\x41"', /unsupported escape/],
];

for (const [name, src, re] of rejects) {
  test(`yaml: rejects ${name}`, () => {
    assert.throws(() => parseYaml(src), (err) => err instanceof YamlError && re.test(err.message));
  });
}

test('yaml: errors carry the line number', () => {
  try {
    parseYaml('ok: 1\n\n# c\nbad: *alias\n');
    assert.fail('expected an error');
  } catch (err) {
    assert.equal(err.line, 4);
  }
});
