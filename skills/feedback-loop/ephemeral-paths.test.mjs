import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ephemeralPaths } from './ephemeral-paths.mjs';

const SCRIPT = join(import.meta.dirname, 'ephemeral-paths.mjs');

test('a path inside a worktree tmp or temp folder is found, either slash direction, with or without backticks', () => {
  const text = [
    'Evidence: `D:/ReadTheStupidText-worktrees/s383/tmp/run1/out.log` and',
    'D:\\ReadTheStupidText-worktrees\\s383\\temp\\shot.png, plus',
    'ok line',
  ].join('\n');
  const hits = ephemeralPaths(text);
  assert.deepEqual(hits.map((h) => h.line), [1, 2]);
  assert.match(hits[0].path, /s383\/tmp\/run1\/out\.log$/);
});

test('reviews folders, repo paths and a tmp folder outside a worktree are fine', () => {
  const text = 'D:/ReadTheStupidText-worktrees/reviews/s1-high.md\nsrc/tmp/a.cs\nD:/ReadTheStupidText-worktrees/s383/docs/x.md\n/tmp/x.log\n';
  assert.deepEqual(ephemeralPaths(text), []);
});

test('the command exits 1 naming the file and line, 0 for a clean file, 2 with no file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eph-'));
  const bad = join(dir, 'bad.md');
  const ok = join(dir, 'ok.md');
  writeFileSync(bad, 'x\nsee D:/R-worktrees/s9/tmp/a.txt\n');
  writeFileSync(ok, 'nothing here\n');
  const run = spawnSync(process.execPath, [SCRIPT, bad], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /bad\.md:2: cites D:\/R-worktrees\/s9\/tmp\/a\.txt/);
  assert.equal(spawnSync(process.execPath, [SCRIPT, ok], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
});
