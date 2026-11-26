// node --test skills/archive-docs/archive_docs.test.mjs (needs python3 or python on PATH; skipped without)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./archive_docs.py', import.meta.url));
const PYTHON = ['python3', 'python'].find((name) => spawnSync(name, ['-I', '-c', 'print(1)']).status === 0);
const skip = PYTHON ? false : 'no python on PATH';
const py = (...args) => spawnSync(PYTHON, ['-I', SCRIPT, ...args], { encoding: 'utf8' });

// Two kept sections around a Slice section; the kept ones end in runs of blank lines like the 2026-10-30 pass left.
const PLAN = ['# Plan', '', '## Status', 'row', '', '', '', '', '## Slice 1 — one', 'body one', '', '',
  '## Outstanding work', 'item', '', '', '', '', '', '## Slice 2 — two', 'body two', ''].join('\n') + '\n';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ad-'));
  mkdirSync(join(dir, 'docs'));
  const plan = join(dir, 'plan.md');
  writeFileSync(plan, PLAN);
  return { dir, plan, original: join(dir, 'original.md'), manifest: join(dir, 'm.json') };
}

function blankRunsIn(text) {
  return text.replace(/\n$/, '').split('\n').reduce((state, line) => {
    const blank = line.trim() === '';
    return { blanks: blank ? state.blanks + 1 : 0, runs: state.runs + (blank && state.blanks === 1 ? 1 : 0) };
  }, { blanks: 0, runs: 0 }).runs;
}

test('apply leaves at most one blank line after each kept segment and verify passes', { skip }, () => {
  const { dir, plan, original, manifest } = setup();
  writeFileSync(original, PLAN);
  assert.equal(py('propose', plan, manifest).status, 0);
  const entries = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const entry of entries) entry.target = /Slice (\d+)/.test(entry.heading) ? `docs/s${/Slice (\d+)/.exec(entry.heading)[1]}.md` : 'keep';
  writeFileSync(manifest, JSON.stringify(entries));
  const applied = py('apply', plan, manifest, dir);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const kept = readFileSync(plan, 'utf8');
  assert.equal(blankRunsIn(kept), 0, JSON.stringify(kept));
  assert.match(kept, /## Status\nrow\n\n## Outstanding work\nitem\n\n$/);
  const verified = py('verify', original, dir, manifest);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
});

test('verify fails when plan.md has more blank-line runs than the original', { skip }, () => {
  const { dir, plan, original, manifest } = setup();
  writeFileSync(original, '# Plan\n\n## Status\nrow\n');
  writeFileSync(manifest, JSON.stringify([{ start: 1, end: 4, target: 'keep', heading: '# Plan' }]));
  writeFileSync(plan, '# Plan\n\n\n\n## Status\nrow\n');
  const verified = py('verify', original, dir, manifest);
  assert.equal(verified.status === 0, false);
  assert.match(verified.stderr, /blank lines: plan\.md has 1 new runs/);
});

test('verify fails when a new blank run appears in a different place than the original run', { skip }, () => {
  const { dir, plan, original, manifest } = setup();
  writeFileSync(original, '# Plan\n\n\nrow\nlast\n');
  writeFileSync(manifest, JSON.stringify([{ start: 1, end: 5, target: 'keep', heading: '# Plan' }]));
  writeFileSync(plan, '# Plan\nrow\n\n\nlast\n');
  const verified = py('verify', original, dir, manifest);
  assert.equal(verified.status === 0, false);
  assert.match(verified.stderr, /1 new runs/);
});

test('verify passes a correct archive whose old blank run now sits before a different line (review of Slice 307)', { skip }, () => {
  const { dir, plan, original, manifest } = setup();
  writeFileSync(original, '# Plan\nA\n\n\n## Slice 1 — one\nbody\n## Next\nC\n');
  writeFileSync(manifest, JSON.stringify([
    { start: 1, end: 4, target: 'keep', heading: '# Plan' },
    { start: 5, end: 6, target: 'docs/s1.md', heading: '## Slice 1 — one' },
    { start: 7, end: 8, target: 'keep', heading: '## Next' }]));
  writeFileSync(plan, '# Plan\nA\n\n\n## Next\nC\n');
  writeFileSync(join(dir, 'docs', 's1.md'), '## Slice 1 — one\nbody\n');
  const verified = py('verify', original, dir, manifest);
  assert.doesNotMatch(verified.stderr, /blank lines/);
});

test('a blank run inside a fenced code block is not counted', { skip }, () => {
  const { dir, plan, original, manifest } = setup();
  const text = '# Plan\n\n```\na\n\n\nb\n```\n';
  writeFileSync(original, text);
  writeFileSync(plan, text);
  writeFileSync(manifest, JSON.stringify([{ start: 1, end: 8, target: 'keep', heading: '# Plan' }]));
  const verified = py('verify', original, dir, manifest);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
});

test('verify passes when the original ends in one blank line and the new plan.md ends in two (blank lines at EOF)', { skip }, () => {
  const { dir, plan, original, manifest } = setup();
  writeFileSync(original, '# Plan\nrow\n\n');
  writeFileSync(manifest, JSON.stringify([{ start: 1, end: 3, target: 'keep', heading: '# Plan' }]));
  writeFileSync(plan, '# Plan\nrow\n\n\n');
  const verified = py('verify', original, dir, manifest);
  assert.doesNotMatch(verified.stderr, /blank lines/);
});

test('apply keeps trailing blank lines of a kept segment that ends inside an unclosed code fence', { skip }, () => {
  const { dir, plan, manifest } = setup();
  const text = '# Plan\n\n```\na\n\n\n\n';
  writeFileSync(plan, text);
  writeFileSync(manifest, JSON.stringify([{ start: 1, end: 7, target: 'keep', heading: '# Plan' }]));
  assert.equal(py('apply', plan, manifest, dir).status, 0);
  assert.equal(readFileSync(plan, 'utf8'), text);
});

test('CRLF plan.md keeps its endings through apply', { skip }, () => {
  const { dir, plan, manifest } = setup();
  writeFileSync(plan, PLAN.replace(/\n/g, '\r\n'));
  assert.equal(py('propose', plan, manifest).status, 0);
  const entries = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const entry of entries) entry.target = /Slice 1/.test(entry.heading) ? 'docs/s1.md' : 'keep';
  writeFileSync(manifest, JSON.stringify(entries));
  assert.equal(py('apply', plan, manifest, dir).status, 0);
  const kept = readFileSync(plan, 'utf8');
  assert.ok(!/[^\r]\n/.test(kept), 'every line ending is CRLF');
  assert.equal(blankRunsIn(kept.replace(/\r\n/g, '\n')), 0);
});
