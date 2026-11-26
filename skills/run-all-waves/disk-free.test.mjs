import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFolders, freeGbOf, nearestExisting, parseArgs, splitNeed } from './disk-free.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'disk-free.mjs');

test('checkFolders: ok only when every folder has the minimum free', () => {
  const reader = (path) => (path === 'low' ? 1 : 50);
  assert.equal(checkFolders(['a', 'b'], 5, reader).ok, true);
  assert.equal(checkFolders(['a', 'low'], 5, reader).ok, false);
});

test('checkFolders: an unreadable folder counts as low', () => {
  assert.equal(checkFolders(['x'], 5, () => null).ok, false);
});

test('a folder that does not exist yet is answered by its nearest existing parent', () => {
  const missing = join(tmpdir(), 'no-such-folder-disk-free', 'deeper');
  assert.equal(nearestExisting(missing), nearestExisting(tmpdir()));
  assert.equal(typeof freeGbOf(missing), 'number');
});

test('parseArgs reads folders and --min-gb', () => {
  assert.deepEqual(parseArgs(['a', '--min-gb', '7', 'b']), { folders: ['a', 'b'], minGb: 7 });
});

test('finding 8: a missing or non-numeric --min-gb is a usage error (exit 2), not "every drive low"', () => {
  assert.equal(parseArgs(['a', '--min-gb']).minGb, null);
  assert.equal(parseArgs(['a', '--min-gb', 'abc']).minGb, null);
  assert.equal(parseArgs(['a']).minGb, 5);
  for (const args of [['--min-gb'], ['--min-gb', 'abc']]) {
    const result = spawnSync('node', [SCRIPT, tmpdir(), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
  }
});

test('Slice 317 item 2: a folder carries its own need after "=", and the need is printed next to the free space', () => {
  const reader = (path) => (path === 'C:\\temp' ? 10 : 20);
  const result = checkFolders(['C:\\temp=5', 'D:\\worktrees=24'], 5, reader);
  assert.equal(result.ok, false, 'D: has 20 GB free but a wave needs 24');
  assert.deepEqual(result.folders.map((f) => [f.path, f.freeGb, f.needGb]), [['C:\\temp', 10, 5], ['D:\\worktrees', 20, 24]]);
  assert.equal(checkFolders(['C:\\temp=5', 'D:\\worktrees=24'], 5, () => 30).ok, true);
});

test('Slice 317 review 4: only a trailing =<digits>[.<digits>] after the last = is a need; anything else is part of the path', () => {
  const paths = ['D:/wt=abc', 'D:/wt=-5', 'D:/wt=', 'D:/wt=0x10', 'D:/wt=1e1', 'D:/work/a=b-worktrees'];
  for (const path of paths) assert.deepEqual(splitNeed(path), { path, needGb: null }, path);
  assert.deepEqual(splitNeed('D:/a=b/wt=2.5'), { path: 'D:/a=b/wt', needGb: 2.5 });
});

test('Slice 317 item 2: a folder with no "=" uses --min-gb', () => {
  const result = checkFolders(['plain', 'other'], 7, () => 50);
  assert.deepEqual(result.folders.map((f) => [f.path, f.needGb]), [['plain', 7], ['other', 7]]);
  assert.equal(checkFolders(['x'], 7, () => 6).ok, false);
});

test('cli: a huge minimum fails with exit 1 and a JSON line; a zero minimum passes', () => {
  const low = spawnSync('node', [SCRIPT, tmpdir(), '--min-gb', '99999999'], { encoding: 'utf8' });
  assert.equal(low.status, 1);
  assert.equal(JSON.parse(low.stdout).ok, false);
  const fine = spawnSync('node', [SCRIPT, tmpdir(), '--min-gb', '0'], { encoding: 'utf8' });
  assert.equal(fine.status, 0);
});
