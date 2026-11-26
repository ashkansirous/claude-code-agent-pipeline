import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { touchedOwnFiles, mergeTouchedOwnFiles } from './merge-touched-own-files.mjs';

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-touch-'));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), text); };
  git('init', '-q', '-b', 'main');
  write('shared.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  write('own.txt', 'mine');
  git('add', '-A');
  git('commit', '-q', '-m', 'own');
  git('checkout', '-q', 'main');
  return { repo, git, write };
}

function mergeMainInto(f) {
  f.git('checkout', '-q', 'feature');
  const oldHead = f.git('rev-parse', 'HEAD');
  f.git('merge', '-q', '--no-edit', 'main');
  return oldHead;
}

test('touchedOwnFiles intersects the lists, either slash', () => {
  assert.deepEqual(touchedOwnFiles(['a/b.txt', 'c.txt'], ['a\\b.txt', 'z.txt']), ['a/b.txt']);
  assert.deepEqual(touchedOwnFiles(['a.txt'], ['b.txt']), []);
});

test('a merge of main that changes only other files touched none of the PR files', () => {
  const f = fixture();
  f.write('other.txt', 'new on main');
  f.git('add', '-A');
  f.git('commit', '-q', '-m', 'main moves');
  const oldHead = mergeMainInto(f);
  assert.deepEqual(mergeTouchedOwnFiles(f.repo, oldHead, 'HEAD', 'main'), []);
});

test('a merge of main that changes a file the PR also changed (no conflict) is reported', () => {
  const f = fixture();
  f.git('checkout', '-q', 'feature');
  f.write('shared.txt', 'feature line\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n');
  f.git('add', '-A');
  f.git('commit', '-q', '-m', 'feature edits shared');
  f.git('checkout', '-q', 'main');
  f.write('shared.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nmain line\n');
  f.git('add', '-A');
  f.git('commit', '-q', '-m', 'main edits shared');
  const oldHead = mergeMainInto(f);
  assert.deepEqual(mergeTouchedOwnFiles(f.repo, oldHead, 'HEAD', 'main'), ['shared.txt']);
});

test('main renaming a file the PR edited counts as touching it (the old path is listed)', () => {
  const f = fixture();
  f.git('checkout', '-q', 'feature');
  f.write('shared.txt', 'feature line\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n');
  f.git('add', '-A');
  f.git('commit', '-q', '-m', 'feature edits shared');
  f.git('checkout', '-q', 'main');
  f.git('mv', 'shared.txt', 'renamed.txt');
  f.git('commit', '-q', '-m', 'main renames shared');
  const oldHead = mergeMainInto(f);
  assert.deepEqual(mergeTouchedOwnFiles(f.repo, oldHead, 'HEAD', 'main'), ['shared.txt']);
});

test('main changing a file only main touched is not a PR file', () => {
  const f = fixture();
  f.write('shared.txt', 'main changed it');
  f.git('add', '-A');
  f.git('commit', '-q', '-m', 'main edits shared');
  const oldHead = mergeMainInto(f);
  assert.deepEqual(mergeTouchedOwnFiles(f.repo, oldHead, 'HEAD', 'main'), []);
});

test('a file the PR edited before an earlier merge of main still counts as own when main touches it again', () => {
  const f = fixture();
  f.git('checkout', '-q', 'feature');
  f.write('shared.txt', 'feature line\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n');
  f.git('add', '-A');
  f.git('commit', '-q', '-m', 'feature edits shared');
  f.git('checkout', '-q', 'main');
  f.write('other.txt', 'first main move');
  f.git('add', '-A');
  f.git('commit', '-q', '-m', 'main moves');
  mergeMainInto(f);
  f.git('checkout', '-q', 'main');
  f.write('shared.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nmain line\n');
  f.git('add', '-A');
  f.git('commit', '-q', '-m', 'main edits shared');
  const oldHead = mergeMainInto(f);
  assert.deepEqual(mergeTouchedOwnFiles(f.repo, oldHead, 'HEAD', 'main'), ['shared.txt']);
});
