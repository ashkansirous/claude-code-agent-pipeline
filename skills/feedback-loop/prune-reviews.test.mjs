// node --test skills/feedback-loop/prune-reviews.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, staleFiles, formatList, readEntries, DEFAULT_DAYS } from './prune-reviews.mjs';

const SCRIPT = fileURLToPath(new URL('./prune-reviews.mjs', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 7);

test('parseArgs takes one folder and an optional --days, and rejects anything else', () => {
  assert.deepEqual(parseArgs(['d']), { dir: 'd', days: DEFAULT_DAYS });
  assert.deepEqual(parseArgs(['--days', '3', 'd']), { dir: 'd', days: 3 });
  for (const argv of [[], ['a', 'b'], ['d', '--days'], ['d', '--days', 'x'], ['d', '--days', '-1']]) assert.equal(parseArgs(argv), null, argv.join(' '));
});

test('staleFiles keeps only files older than the limit, oldest first, with their age', () => {
  const entries = [
    { name: 'new.md', mtimeMs: NOW - DAY, size: 10 },
    { name: 'b-old.md', mtimeMs: NOW - 30 * DAY, size: 2048 },
    { name: 'edge.md', mtimeMs: NOW - 14 * DAY, size: 1 },
    { name: 'a-old.md', mtimeMs: NOW - 30 * DAY, size: 1 },
    { name: 'older.md', mtimeMs: NOW - 90 * DAY - 5, size: 5 },
  ];
  const stale = staleFiles(entries, NOW, 14);
  assert.deepEqual(stale.map((f) => f.name), ['older.md', 'a-old.md', 'b-old.md']);
  assert.deepEqual(stale.map((f) => f.ageDays), [90, 30, 30]);
  assert.match(formatList(stale, 5, 14), /3 of 5 files are older than 14 days \(3 KB\)\. List only: nothing was deleted\.$/);
});

test('the script lists old files, deletes nothing, and exits 2 on a bad folder or no argument', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'));
  writeFileSync(join(dir, 'old-high.md'), 'x');
  writeFileSync(join(dir, 'fresh-high.md'), 'x');
  mkdirSync(join(dir, 'sub'));
  const old = new Date(Date.now() - 40 * DAY);
  utimesSync(join(dir, 'old-high.md'), old, old);
  const run = (...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  const listed = run(dir);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^40d\t1KB\told-high\.md$/m);
  assert.doesNotMatch(listed.stdout, /fresh-high|sub/);
  assert.match(listed.stdout, /1 of 2 files are older than 14 days/);
  assert.deepEqual(readdirSync(dir).sort(), ['fresh-high.md', 'old-high.md', 'sub']);
  assert.match(run(dir, '--days', '60').stdout, /0 of 2 files/);
  assert.equal(run(join(dir, 'missing')).status, 2);
  assert.equal(run().status, 2);
});

test('a broken symlink in the folder is skipped, the rest is still listed (review of Slice 307)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-link-'));
  writeFileSync(join(dir, 'a.md'), 'x');
  try {
    symlinkSync(join(dir, 'gone.md'), join(dir, 'broken.md'));
  } catch {
    return t.skip('cannot create a symlink here');
  }
  assert.deepEqual(readEntries(dir).map((e) => e.name), ['a.md']);
});
