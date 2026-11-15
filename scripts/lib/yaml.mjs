// A strict YAML subset parser for .specify/bug-batch.yml (no dependencies).
//
// Supported:
//   - block mappings (`key: value`, `key:` followed by an indented block)
//   - block sequences (`- value`, `- key: value` items, `key:` followed by `- ...`
//     at the same indent)
//   - inline lists of scalars (`[a, "b", 3]`), and the empty literals `[]` and `{}`
//   - scalars: null (`null`, `~`, empty), `true`/`false`, integers, decimals,
//     plain strings, "double-quoted" (\" \\ \n \t escapes) and 'single-quoted'
//   - `#` comments (at line start, or after whitespace outside quotes)
//
// Rejected with a YamlError that names the line: tabs in indentation, anchors and
// aliases (`&`, `*`), tags (`!`), block scalars (`|`, `>`), flow mappings other
// than `{}`, nested inline lists, multiple documents, complex keys (`?`),
// duplicate keys, and inconsistent indentation.
//
// Anything this parser accepts parses the same way under YAML 1.2. That's why a
// plain value starting with `*` (for example a `**/x` glob) is an error: real YAML
// would read it as an alias, so it has to be quoted.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'YamlError';
    this.line = line ?? null;
  }
}

const RESERVED_START = new Set(['&', '*', '!', '|', '>', '%', '@', '`', '{', '?']);

function stripComment(text, lineNo) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = null;
    } else if (quote === "'") {
      if (c === "'") {
        if (text[i + 1] === "'") i++;
        else quote = null;
      }
    } else if (c === '"' || c === "'") {
      // A quote only opens a quoted scalar at the start of a token.
      const prev = i === 0 ? ' ' : text[i - 1];
      if (/[\s\[,:-]/.test(prev)) quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  if (quote) throw new YamlError('unterminated quoted string', lineNo);
  return text.trimEnd();
}

function tokenize(source) {
  const lines = [];
  const raw = source.replace(/^﻿/, '').split(/\r?\n/);
  let docMarkers = 0;
  raw.forEach((text, idx) => {
    const lineNo = idx + 1;
    const lead = text.match(/^[ \t]*/)[0];
    if (lead.includes('\t') && text.trim() !== '') {
      throw new YamlError('tabs are not allowed in indentation', lineNo);
    }
    const content = stripComment(text.slice(lead.length), lineNo);
    if (content === '') return;
    if (content === '---' && lead === '') {
      docMarkers++;
      if (docMarkers > 1 || lines.length > 0) throw new YamlError('only one document is allowed', lineNo);
      return;
    }
    if (content === '...' && lead === '') throw new YamlError('document end markers are not supported', lineNo);
    lines.push({ indent: lead.length, content, lineNo });
  });
  return lines;
}

function parseQuoted(text, lineNo) {
  if (text[0] === '"') {
    let out = '';
    for (let i = 1; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') {
        const n = text[++i];
        const map = { '"': '"', '\\': '\\', n: '\n', t: '\t', '/': '/' };
        if (!(n in map)) throw new YamlError(`unsupported escape \\${n ?? ''}`, lineNo);
        out += map[n];
      } else if (c === '"') {
        if (text.slice(i + 1).trim() !== '') throw new YamlError('unexpected text after quoted string', lineNo);
        return out;
      } else {
        out += c;
      }
    }
    throw new YamlError('unterminated quoted string', lineNo);
  }
  let out = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i++;
      } else {
        if (text.slice(i + 1).trim() !== '') throw new YamlError('unexpected text after quoted string', lineNo);
        return out;
      }
    } else {
      out += c;
    }
  }
  throw new YamlError('unterminated quoted string', lineNo);
}

function parsePlain(text, lineNo) {
  if (text === '' || text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return Number.parseFloat(text);
  if (RESERVED_START.has(text[0])) {
    throw new YamlError(`a value starting with "${text[0]}" must be quoted`, lineNo);
  }
  if (text.startsWith('- ') || text === '-') throw new YamlError('unexpected sequence item', lineNo);
  if (/:(\s|$)/.test(text)) throw new YamlError('a value containing ": " must be quoted', lineNo);
  return text;
}

function splitInline(body, lineNo) {
  const items = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (quote === '"' && c === '\\') cur += body[++i] ?? '';
      else if (c === quote) {
        if (quote === "'" && body[i + 1] === "'") cur += body[++i];
        else quote = null;
      }
    } else if ((c === '"' || c === "'") && cur.trim() === '') {
      quote = c;
      cur += c;
    } else if (c === ',') {
      items.push(cur.trim());
      cur = '';
    } else if (c === '[' || c === ']' || c === '{' || c === '}') {
      throw new YamlError('nested inline collections are not supported', lineNo);
    } else {
      cur += c;
    }
  }
  if (quote) throw new YamlError('unterminated quoted string', lineNo);
  items.push(cur.trim());
  if (items.length === 1 && items[0] === '') return [];
  if (items.at(-1) === '') items.pop(); // allow a trailing comma
  if (items.some((s) => s === '')) throw new YamlError('empty item in inline list', lineNo);
  return items;
}

function parseScalar(text, lineNo) {
  if (text[0] === '"' || text[0] === "'") return parseQuoted(text, lineNo);
  if (text === '{}') return {};
  if (text[0] === '[') {
    if (!text.endsWith(']')) throw new YamlError('unterminated inline list', lineNo);
    return splitInline(text.slice(1, -1), lineNo).map((item) => parseScalar(item, lineNo));
  }
  return parsePlain(text, lineNo);
}

// Matches `key:` or `key: rest`. Keys are plain words or quoted strings.
const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\-\[\]{},&*!|>%@`?][^:#]*?|-[^\s:#][^:#]*?)\s*:(?:\s+(.*))?$/;

function isSeqItem(content) {
  return content === '-' || content.startsWith('- ');
}

class Parser {
  constructor(lines) {
    this.lines = lines;
    this.i = 0;
  }

  peek() {
    return this.lines[this.i];
  }

  parseDocument() {
    if (this.lines.length === 0) return {};
    const first = this.peek();
    if (first.indent !== 0) throw new YamlError('the document must start at column 1', first.lineNo);
    const value = isSeqItem(first.content) ? this.parseSeq(0) : this.parseMap(0);
    const rest = this.peek();
    if (rest) throw new YamlError('unexpected indentation or content', rest.lineNo);
    return value;
  }

  // The value after `key:` with nothing on the same line.
  parseNested(parentIndent, lineNo) {
    const next = this.peek();
    if (!next) return null;
    if (next.indent > parentIndent) return this.parseBlock(next.indent);
    if (next.indent === parentIndent && isSeqItem(next.content)) return this.parseSeq(parentIndent);
    return null;
  }

  parseBlock(indent) {
    const line = this.peek();
    return isSeqItem(line.content) ? this.parseSeq(indent) : this.parseMap(indent);
  }

  parseMap(indent) {
    const out = {};
    while (this.peek() && this.peek().indent === indent && !isSeqItem(this.peek().content)) {
      const { content, lineNo } = this.peek();
      const m = content.match(KEY_RE);
      if (!m) throw new YamlError(`expected "key: value", got "${content}"`, lineNo);
      const key = m[1][0] === '"' || m[1][0] === "'" ? parseQuoted(m[1], lineNo) : m[1];
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`duplicate key "${key}"`, lineNo);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new YamlError(`key "${key}" is not allowed`, lineNo);
      }
      this.i++;
      const rest = (m[2] ?? '').trim();
      out[key] = rest === '' ? this.parseNested(indent, lineNo) : parseScalar(rest, lineNo);
    }
    const stray = this.peek();
    if (stray && stray.indent > indent) throw new YamlError('unexpected indentation', stray.lineNo);
    return out;
  }

  parseSeq(indent) {
    const out = [];
    while (this.peek() && this.peek().indent === indent && isSeqItem(this.peek().content)) {
      const line = this.peek();
      const rest = line.content.slice(1).trimStart();
      if (rest === '') {
        this.i++;
        const next = this.peek();
        out.push(next && next.indent > indent ? this.parseBlock(next.indent) : null);
      } else if (isSeqItem(rest)) {
        throw new YamlError('nested sequences on one line are not supported', line.lineNo);
      } else if (KEY_RE.test(rest)) {
        // `- key: value` starts a mapping whose keys line up after the dash.
        const col = indent + (line.content.length - rest.length);
        this.lines[this.i] = { indent: col, content: rest, lineNo: line.lineNo };
        out.push(this.parseMap(col));
      } else {
        this.i++;
        out.push(parseScalar(rest, line.lineNo));
      }
    }
    const stray = this.peek();
    if (stray && stray.indent > indent) throw new YamlError('unexpected indentation', stray.lineNo);
    return out;
  }
}

export function parseYaml(source) {
  return new Parser(tokenize(source)).parseDocument();
}
