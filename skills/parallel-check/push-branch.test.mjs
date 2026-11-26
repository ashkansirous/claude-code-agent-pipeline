import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { headProblem, pushBranch, runSliceCheck, touchesGlobs, overlapWarnings, pushWarnings, unstampedRemoteWarning, globToRegex, claimsSlice, openPrs } from './push-branch.mjs';

test('review check2 #1: a gh pr list that stalls times out, returns no PRs and the push goes on', () => {
  const started = Date.now();
  const prs = openPrs(os.tmpdir(), { bin: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], timeoutMs: 300 });
  assert.deepEqual(prs, []);
  assert.ok(Date.now() - started < 10000);
});

test('runSliceCheck tries every python in turn (skipping ones that do not work) and fails when none works', () => {
  const tried = [];
  const works = (python) => { tried.push(python); return false; };
  assert.equal(runSliceCheck(os.tmpdir(), 'x', ['python', 'py'], works), 1);
  assert.deepEqual(tried, ['python', 'py']);
});

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'push-branch.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

// A bare origin with main, plus a clone on branch feat/x with `ahead` commits on top of main.
function fixture({ ahead = 1, slices = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'push-branch-'));
  const origin = path.join(base, 'origin.git');
  const clone = path.join(base, 'clone');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, clone]);
  if (slices) fs.mkdirSync(path.join(clone, 'docs', 'plan', 'slices'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'f.txt'), 'a');
  git(clone, 'checkout', '-q', '-b', 'main');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'base');
  git(clone, 'push', '-q', '-u', 'origin', 'main');
  git(clone, 'checkout', '-q', '-b', 'feat/x');
  for (let i = 0; i < ahead; i++) git(clone, 'commit', '-q', '--allow-empty', '-m', `c${i}`);
  return { origin, clone };
}

const remoteBranches = (origin) => git(origin, 'branch', '--list').replace(/\*/g, '');

test('pushes a branch that is checked out and ahead of origin/main', () => {
  const { origin, clone } = fixture();
  assert.equal(pushBranch(clone, 'feat/x').status, 0);
  assert.match(remoteBranches(origin), /feat\/x/);
});

test('refuses when HEAD is on another branch, and pushes nothing', () => {
  const { origin, clone } = fixture();
  const result = pushBranch(clone, 'feat/other');
  assert.equal(result.status, 1);
  assert.match(result.message, /is on "feat\/x", not "feat\/other"/);
  assert.doesNotMatch(remoteBranches(origin), /feat/);
});

test('refuses when the branch has no commit that origin/main lacks', () => {
  const { origin, clone } = fixture({ ahead: 0 });
  assert.match(headProblem(clone, 'feat/x'), /no commit that origin\/main lacks/);
  assert.equal(pushBranch(clone, 'feat/x').status, 1);
  assert.doesNotMatch(remoteBranches(origin), /feat/);
});

test('in a slice repo the check runs first, and a failing check stops the push', () => {
  const { origin, clone } = fixture({ slices: true });
  const calls = [];
  const failed = pushBranch(clone, 'feat/x', (worktree, branch) => { calls.push([worktree, branch]); return 1; });
  assert.equal(failed.status, 1);
  assert.deepEqual(calls, [[clone, 'feat/x']]);
  assert.doesNotMatch(remoteBranches(origin), /feat/);
  assert.equal(pushBranch(clone, 'feat/x', () => 0).status, 0);
  assert.match(remoteBranches(origin), /feat\/x/);
});

test('a repo without docs/plan/slices skips the check', () => {
  const { clone } = fixture();
  assert.equal(pushBranch(clone, 'feat/x', () => { throw new Error('check must not run'); }).status, 0);
});

test('refuses main, HEAD, refspecs and options as the branch, and pushes nothing', () => {
  const { origin, clone } = fixture();
  for (const bad of ['main', 'HEAD', 'feat/x:main', '--force', '-f']) {
    const result = pushBranch(clone, bad);
    assert.equal(result.status, 1, bad);
  }
  assert.doesNotMatch(remoteBranches(origin), /feat/);
});

test('refuses when origin main cannot be fetched', () => {
  const { origin, clone } = fixture();
  fs.renameSync(origin, `${origin}-gone`);
  const result = pushBranch(clone, 'feat/x');
  assert.equal(result.status, 1);
  assert.match(result.message, /cannot fetch origin main/);
});

test('fetches origin main first, so a stale ref does not let an already-merged branch pass', () => {
  const { origin, clone } = fixture();
  const other = path.join(path.dirname(origin), 'other');
  git(clone, 'push', '-q', 'origin', 'feat/x:feat/y');
  execFileSync('git', ['clone', '-q', origin, other]);
  git(other, 'merge', '-q', '--ff-only', 'origin/feat/y');
  git(other, 'push', '-q', 'origin', 'main');
  assert.match(headProblem(clone, 'feat/x'), /no commit that origin\/main lacks/);
});

test('the command line refuses a wrong argument count and pushes via the script', () => {
  assert.equal(spawnSync('node', [SCRIPT], { encoding: 'utf8' }).status, 2);
  const { origin, clone } = fixture();
  const run = spawnSync('node', [SCRIPT, clone, 'feat/x'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(remoteBranches(origin), /feat\/x/);
});

test('item 5 review: ** matches zero folders, ? is one character, a sibling batch PR is skipped', () => {
  assert.ok(globToRegex('docs/**/x.md').test('docs/x.md'));
  assert.ok(globToRegex('docs/**/x.md').test('docs/a/b/x.md'));
  assert.ok(!globToRegex('a?.md').test('a/.md'));
  assert.ok(claimsSlice('chore/s33a-tools', ['33']));
  assert.ok(!claimsSlice('chore/s330-tools', ['33']));
  const prs = [{ number: 1, headRefName: 'feat/s33a-x', files: ['a.md'] }, { number: 2, headRefName: 'feat/other', files: ['a.md'] }];
  const out = overlapWarnings(['a.md'], prs, 'feat/s33b-x', ['33']);
  assert.equal(out.length, 1);
  assert.match(out[0], /#2/);
});

test('item 5: touchesGlobs reads the Touches line; overlapWarnings names an open PR whose files match, skipping the own branch', () => {
  const globs = touchesGlobs('# S\n\n**Touches:** `skills/run-wave/*.mjs`, `agents/ship-branch.md`, `.github/**`\n');
  assert.deepEqual(globs, ['skills/run-wave/*.mjs', 'agents/ship-branch.md', '.github/**']);
  const prs = [
    { number: 375, headRefName: 'feat/other', files: [{ path: 'skills/run-wave/wave-gate.mjs' }, { path: 'README.md' }] },
    { number: 9, headRefName: 'feat/x', files: [{ path: 'agents/ship-branch.md' }] },
    { number: 10, headRefName: 'feat/none', files: [{ path: 'skills/run-wave/sub/deep.mjs' }] },
  ];
  const out = overlapWarnings(globs, prs, 'feat/x');
  assert.equal(out.length, 1);
  assert.match(out[0], /WARNING open PR #375 \(feat\/other\).*wave-gate\.mjs/);
});

test('item 5: pushWarnings prints the overlap for a fake gh answer, and the push still happens', () => {
  const { origin, clone } = fixture({ slices: true });
  fs.writeFileSync(path.join(clone, 'docs', 'plan', 'slices', '01-x.md'), '# S\n\n**Touches:** `f.txt`\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'slice');
  const prs = () => [{ number: 7, headRefName: 'feat/other', files: [{ path: 'f.txt' }] }];
  assert.match(pushWarnings(clone, 'feat/x', prs).join('\n'), /open PR #7/);
  const seen = [];
  assert.equal(pushBranch(clone, 'feat/x', () => 0, (lines) => seen.push(...lines)).status, 0);
  assert.match(remoteBranches(origin), /feat\/x/);
});

test('Slice 33 item 54: a branch commit carrying a skip-CI marker is refused, naming the commit, and nothing is pushed', () => {
  const { origin, clone } = fixture();
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'docs: index pass [skip ci]');
  const sha = git(clone, 'rev-parse', '--short', 'HEAD');
  const result = pushBranch(clone, 'feat/x');
  assert.equal(result.status, 1);
  assert.match(result.message, new RegExp(`commit ${sha} .*\\[skip ci\\]`));
  assert.doesNotMatch(remoteBranches(origin), /feat/);
  const { origin: o2, clone: c2 } = fixture();
  git(c2, 'commit', '-q', '--allow-empty', '-m', 'subject', '-m', 'body with [CI Skip] in it');
  assert.equal(pushBranch(c2, 'feat/x').status, 1);
  assert.doesNotMatch(remoteBranches(o2), /feat/);
  // an earlier commit that mentions the marker, under a clean head commit, is not refused (GitHub reads only the head message)
  const { clone: c3 } = fixture();
  git(c3, 'commit', '-q', '--allow-empty', '-m', 'docs: explain [skip ci] rule');
  git(c3, 'commit', '-q', '--allow-empty', '-m', 'feat: code');
  assert.equal(pushBranch(c3, 'feat/x', () => 0, () => {}).status, 0);
});

test('item 60 review: a remote branch that only ends in the same name does not warn', () => {
  const { clone } = fixture();
  git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/team/feat/x');
  assert.equal(unstampedRemoteWarning(clone, 'feat/x'), null);
});

test('item 60: a remote branch with no stamp of the helper warns naming the rule; the helper\'s own push does not', () => {
  const { clone } = fixture();
  assert.equal(unstampedRemoteWarning(clone, 'feat/x'), null);
  git(clone, 'push', '-q', '-u', 'origin', 'feat/x'); // the plain push the rule forbids
  assert.match(unstampedRemoteWarning(clone, 'feat/x'), /already has "feat\/x".*never a plain `git push`/);
  const seen = [];
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'more');
  assert.equal(pushBranch(clone, 'feat/x', () => 0, (lines) => seen.push(...lines)).status, 0);
  assert.match(seen.join('\n'), /already has "feat\/x"/);
  assert.equal(unstampedRemoteWarning(clone, 'feat/x'), null);
});

test('review pass 3 #1: a slice file main gained after the branch point is not this work\'s slice', () => {
  const { clone } = fixture({ slices: true });
  fs.writeFileSync(path.join(clone, 'docs', 'plan', 'slices', '01-x.md'), '# S\n\n**Touches:** `f.txt`\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'slice');
  git(clone, 'checkout', '-q', 'main');
  fs.mkdirSync(path.join(clone, 'docs', 'plan', 'slices'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'docs', 'plan', 'slices', '02-y.md'), '# S\n\n**Touches:** `other.txt`\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'main moved on');
  git(clone, 'push', '-q', 'origin', 'main');
  git(clone, 'checkout', '-q', 'feat/x');
  const prs = () => [{ number: 8, headRefName: 'feat/s02-y', files: [{ path: 'f.txt' }] }];
  assert.match(pushWarnings(clone, 'feat/x', prs).join('\n'), /open PR #8/);
});

test('review pass 3 #2: a Touches folder with a trailing slash covers the files under it', () => {
  assert.ok(globToRegex('skills/run-wave/').test('skills/run-wave/merge-gate.mjs'));
  assert.ok(globToRegex('skills/run-wave//').test('skills/run-wave/sub/a.mjs'));
  assert.ok(!globToRegex('skills/run-wave/').test('skills/run-wave-x/a.mjs'));
  const prs = [{ number: 5, headRefName: 'feat/other', files: [{ path: 'skills/run-wave/merge-gate.mjs' }] }];
  assert.equal(overlapWarnings(['skills/run-wave/'], prs, 'feat/x').length, 1);
});

test('review pass 3 #3: a throw while building the warnings prints one stderr line and the push goes on', () => {
  const { origin, clone } = fixture();
  const stderr = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { stderr.push(String(s)); return true; };
  let result;
  try { result = pushBranch(clone, 'feat/x', () => 0, () => { throw new Error('boom'); }); } finally { process.stderr.write = orig; }
  assert.equal(result.status, 0);
  assert.equal(stderr.filter((l) => /warning check failed \(boom\)/.test(l)).length, 1);
  assert.match(remoteBranches(origin), /feat\/x/);
});
