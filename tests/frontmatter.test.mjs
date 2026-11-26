// node --test tests/frontmatter.test.mjs
// Every skill and agent must load. A broken front matter makes Claude Code drop the file or its
// description silently: 2026-10-31, a literal "\r" before every line end of branch-sweep/SKILL.md,
// and 13 skills whose unquoted description held ": ", which strict YAML rejects, so they showed
// no description and never triggered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FENCE = '---';
const BOM = String.fromCharCode(0xfeff);
const MODELS = /^(haiku|sonnet|opus|fable|claude-[a-z0-9-]+)$/;
const PLAIN_SCALAR_BREAKERS = /(: | #)/;

// A one-line YAML double-quoted scalar with only \\ and \" escapes is also a valid JSON string.
function validDoubleQuoted(value) {
  try {
    return typeof JSON.parse(value) === 'string';
  } catch {
    return false;
  }
}

function fieldProblems(key, value) {
  if (value.startsWith('"')) return validDoubleQuoted(value) ? [] : [`${key}: double-quoted value is not closed or has an unescaped quote`];
  if (value.startsWith("'")) return /^'([^']|'')*'$/.test(value) ? [] : [`${key}: single-quoted value is not closed on its line`];
  if (/^[>|]/.test(value)) return [];
  if (PLAIN_SCALAR_BREAKERS.test(value)) return [`${key}: unquoted value holds ": " or " #" (strict YAML rejects it; quote it)`];
  return [];
}

function readBlockScalar(lines, start, end) {
  const out = [];
  for (let i = start + 1; i < end && /^\s+\S/.test(lines[i]); i++) out.push(lines[i].trim());
  return out.join(' ');
}

function parseFrontMatter(text) {
  if (text.startsWith(BOM)) return { error: 'starts with a byte order mark' };
  const lines = text.split(/\r?\n/);
  if (lines[0].trimEnd() !== FENCE) return { error: 'does not start with ---' };
  if (lines[0] !== FENCE) return { error: 'trailing characters after the opening ---' };
  const end = lines.indexOf(FENCE, 1);
  if (end < 0) return { error: 'front matter is never closed with ---' };
  const fields = {};
  const errors = [];
  for (let i = 1; i < end; i++) {
    if (/\\r$/.test(lines[i])) errors.push(`line ${i + 1}: literal \\r at the line end`);
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    errors.push(...fieldProblems(m[1], m[2]));
    fields[m[1]] = /^[>|]/.test(m[2]) ? readBlockScalar(lines, i, end) : m[2].replace(/^["']|["']$/g, '');
  }
  return { fields, errors };
}

function problems(file, expectedName, isAgent) {
  const parsed = parseFrontMatter(fs.readFileSync(file, 'utf8'));
  if (parsed.error) return [parsed.error];
  const { fields, errors } = parsed;
  const out = [...errors];
  if (fields.name !== expectedName) out.push(`name is "${fields.name}", expected "${expectedName}"`);
  if (!fields.description) out.push('no description');
  if (isAgent && !MODELS.test(fields.model ?? '')) out.push(`model "${fields.model}" is not a pinned model`);
  return out;
}

function listed(dir, pick) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).map(pick).filter(Boolean);
}

const skills = () => listed('skills', (d) => d.isDirectory() && { name: d.name, file: path.join(ROOT, 'skills', d.name, 'SKILL.md') });
const agents = () => listed('agents', (d) => d.name.endsWith('.md') && { name: d.name.slice(0, -3), file: path.join(ROOT, 'agents', d.name) });

test('every skill folder has a SKILL.md', () => {
  assert.deepEqual(skills().filter((s) => !fs.existsSync(s.file)).map((s) => s.name), []);
});

test('every SKILL.md has a valid front matter', () => {
  const bad = skills().filter((s) => fs.existsSync(s.file))
    .flatMap((s) => problems(s.file, s.name, false).map((p) => `${s.name}: ${p}`));
  assert.deepEqual(bad, []);
});

test('every agent has a valid front matter with a pinned model', () => {
  const bad = agents().flatMap((a) => problems(a.file, a.name, true).map((p) => `${a.name}: ${p}`));
  assert.deepEqual(bad, []);
});

test('parser rejects each known kind of damage', () => {
  assert.match(parseFrontMatter('no fence\n').error, /does not start/);
  assert.match(parseFrontMatter('---\nname: x\n').error, /never closed/);
  assert.match(parseFrontMatter(`${BOM}---\nname: x\n---\n`).error, /byte order mark/);
  assert.match(parseFrontMatter('--- \nname: x\n---\n').error, /trailing characters/);
  assert.match(parseFrontMatter('---\\r\nname: x\\r\n---\\r\n').error, /does not start/);
  const colon = parseFrontMatter('---\nname: x\ndescription: Do this: then that\n---\n');
  assert.match(colon.errors.join(), /unquoted value/);
  assert.match(parseFrontMatter('---\nname: x\ndescription: "a "b" c"\n---\n').errors.join(), /unescaped quote/);
  assert.match(parseFrontMatter('---\nname: x\ndescription: "open\n---\n').errors.join(), /not closed/);
  const escaped = parseFrontMatter('---\nname: x\\r\ndescription: y\n---\n');
  assert.match(escaped.errors.join(), /literal \\r/);
});

test('parser accepts quoted, block and CRLF front matter', () => {
  const quoted = parseFrontMatter('---\nname: x\ndescription: "Do this: then that"\n---\n');
  assert.deepEqual(quoted.errors, []);
  assert.equal(quoted.fields.description, 'Do this: then that');
  const block = parseFrontMatter('---\nname: x\ndescription: >\n  folded: text\n---\n');
  assert.equal(block.fields.description, 'folded: text');
  const crlf = parseFrontMatter('---\r\nname: x\r\ndescription: y\r\n---\r\nbody\r\n');
  assert.equal(crlf.fields.name, 'x');
});
