import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStamp, checkStamp, main } from './sweep-stamp.mjs';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-stamp-'));
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  return dir;
}

test('no stamp: check fails with a reason', () => {
  const result = checkStamp(repo());
  assert.equal(result.ok, false);
  assert.match(result.reason, /no branch sweep recorded/);
});

test('a fresh stamp passes, an old one fails, and the limit is the argument', () => {
  const dir = repo();
  writeStamp(dir, new Date('2026-11-08T10:00:00Z'));
  const at = (minutes) => Date.parse('2026-11-08T10:00:00Z') + minutes * 60000;
  assert.equal(checkStamp(dir, 240, at(239)).ok, true);
  assert.equal(checkStamp(dir, 240, at(241)).ok, false);
  assert.equal(checkStamp(dir, 10, at(11)).ok, false);
});

test('a worktree shares the primary stamp (it lives in the git common dir)', () => {
  const dir = repo();
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const worktrees = mkdtempSync(join(tmpdir(), 'sweep-wt-'));
  const wt = join(worktrees, 'wt');
  execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'feat/x', wt]);
  writeStamp(dir);
  assert.equal(checkStamp(wt).ok, true);
});

test('main: write then check exit 0; check alone on a fresh repo exits 1; bad usage exits 2', () => {
  const dir = repo();
  const lines = [];
  assert.equal(main(['check', dir], (t) => lines.push(t)), 1);
  assert.equal(main(['write', dir], (t) => lines.push(t)), 0);
  assert.equal(main(['check', dir, '--max-minutes', '5'], (t) => lines.push(t)), 0);
  assert.equal(main(['nope'], (t) => lines.push(t)), 2);
  mkdirSync(join(dir, 'sub'));
  assert.equal(main(['check', join(dir, 'sub')], () => {}), 0);
});
