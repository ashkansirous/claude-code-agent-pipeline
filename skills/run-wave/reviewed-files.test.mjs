// node --test skills/run-wave/reviewed-files.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reviewedBlock } from './reviewed-files.mjs';
import { reviewedFiles } from './merge-gate.mjs';

test('the block lists changed, untracked and deleted code files, skips Markdown and docs/design files, and the gate parses it', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-'));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  for (const [name, text] of [['src/a.cs', 'one'], ['src/gone.cs', 'bye'], ['README.md', 'doc'], ['docs/design/mock.dc.html', 'm1'], ['src/ünï.cs', 'u']]) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'x');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  fs.writeFileSync(path.join(repo, 'src/a.cs'), 'two');
  fs.writeFileSync(path.join(repo, 'README.md'), 'doc2');
  fs.writeFileSync(path.join(repo, 'docs/design/mock.dc.html'), 'm2');
  fs.writeFileSync(path.join(repo, 'src/new.cs'), 'new');
  fs.writeFileSync(path.join(repo, 'src/ünï.cs'), 'u2');
  fs.rmSync(path.join(repo, 'src/gone.cs'));
  const block = reviewedBlock(repo);
  const map = reviewedFiles(block);
  assert.deepEqual([...map.keys()], ['src/a.cs', 'src/gone.cs', 'src/new.cs', 'src/ünï.cs']);
  assert.equal(map.get('src/a.cs'), git('hash-object', 'src/a.cs'));
  assert.equal(map.get('src/new.cs'), git('hash-object', 'src/new.cs'));
  assert.equal(map.get('src/ünï.cs'), git('hash-object', 'src/ünï.cs'));
  assert.equal(map.get('src/gone.cs'), 'deleted');
});

test('files main added after the branch point are not listed when origin/main moves ahead', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-'));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/a.cs'), 'one');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(repo, 'src/a.cs'), 'two');
  git('commit', '-q', '-am', 'feature work');
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'src/main-only.cs'), 'later');
  git('add', '-A');
  git('commit', '-q', '-m', 'main moves on');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', 'feature');
  const map = reviewedFiles(reviewedBlock(repo));
  assert.deepEqual([...map.keys()], ['src/a.cs']);
});

const lfsInstalled = (() => { try { execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function contentRepo(lfs) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-'));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  if (lfs) {
    git('lfs', 'install', '--local');
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'content/** filter=lfs diff=lfs merge=lfs -text\n');
  }
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.writeFileSync(path.join(repo, '.claude/merge-gate.json'), JSON.stringify({ contentPaths: ['content/**'] }));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/a.cs'), 'one');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  fs.writeFileSync(path.join(repo, 'src/a.cs'), 'two');
  fs.writeFileSync(path.join(repo, 'src/new.cs'), 'new');
  fs.mkdirSync(path.join(repo, 'content/book/audio/da'), { recursive: true });
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(repo, `content/book/audio/da/${i}.m4a`), Buffer.from([0, 1, 2, i % 256]));
  return { repo, git };
}

function assertOnlyCode(repo, git) {
  const started = Date.now();
  const map = reviewedFiles(reviewedBlock(repo));
  assert.deepEqual([...map.keys()], ['src/a.cs', 'src/new.cs']);
  assert.equal(map.get('src/a.cs'), git('hash-object', 'src/a.cs'));
  assert.ok(Date.now() - started < 20000, 'finishes fast');
}

test('several code files in the batch get the same shas as per-file git hash-object, and a call is made once for the batch', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-'));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'seed.cs'), 'seed');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const names = ['a.cs', 'b.cs', 'c d.cs', 'e.cs'];
  names.forEach((n, i) => fs.writeFileSync(path.join(repo, n), `content ${i}`));
  let hashCalls = 0;
  const counting = (worktree, args, input) => {
    if (args[0] === 'hash-object') hashCalls++;
    return execFileSync('git', ['-C', worktree, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8', input, maxBuffer: 1 << 26 });
  };
  const map = reviewedFiles(reviewedBlock(repo, counting));
  assert.deepEqual([...map.keys()], [...names].sort());
  for (const n of names) assert.equal(map.get(n), git('hash-object', '--', n));
  assert.equal(hashCalls, 1);
});

test('a batch hash that throws falls back to one call per path, and a path that vanished is reported deleted', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-'));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'seed.cs'), 'seed');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  ['a.cs', 'b.cs', 'gone.cs'].forEach((n, i) => fs.writeFileSync(path.join(repo, n), `content ${i}`));
  const vanishing = (worktree, args, input) => {
    if (args.includes('--stdin-paths')) {
      fs.rmSync(path.join(repo, 'gone.cs'));
      throw new Error('git hash-object failed');
    }
    return execFileSync('git', ['-C', worktree, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8', input, maxBuffer: 1 << 26 });
  };
  const map = reviewedFiles(reviewedBlock(repo, vanishing));
  assert.equal(map.get('a.cs'), git('hash-object', '--', 'a.cs'));
  assert.equal(map.get('b.cs'), git('hash-object', '--', 'b.cs'));
  assert.equal(map.get('gone.cs'), 'deleted');
});

test('files matching the repo contentPaths are left out of the block', () => {
  const { repo, git } = contentRepo(false);
  assertOnlyCode(repo, git);
});

test('a few hundred untracked LFS files under contentPaths are not hashed and not listed', { skip: lfsInstalled ? false : 'git-lfs is not installed' }, () => {
  const { repo, git } = contentRepo(true);
  assertOnlyCode(repo, git);
});
