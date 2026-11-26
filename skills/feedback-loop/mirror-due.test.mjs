// node --test skills/feedback-loop/mirror-due.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mark, clear, dueMarkers, markerDir, mirroredCovers, describeMarkers, reachableFromMain, touchesMirrorFile } from './mirror-due.mjs';

const SCRIPT = fileURLToPath(new URL('./mirror-due.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-due-'));

test('a marker is due only after 10 minutes, and clear removes it', () => {
  const dir = tmp();
  mark('owner/repo', 'abc123', dir, 1000);
  assert.deepEqual(dueMarkers(dir, 1000 + 9 * 60 * 1000), []);
  assert.equal(dueMarkers(dir, 1000 + 10 * 60 * 1000)[0].sha, 'abc123');
  clear('owner/repo', 'abc123', dir);
  assert.deepEqual(dueMarkers(dir, 1000 + 60 * 60 * 1000), []);
});

test('clear removes the marker written before the mirror started whatever its sha, not a later merge\'s', () => {
  const dir = tmp();
  mark('o/r', 'sha-b', dir, 5000);
  assert.equal(clear('o/r', 'sha-b', dir, 4000), false);
  assert.equal(clear('o/r', 'sha-a', dir, 6000), true);
  assert.equal(dueMarkers(dir, 1e9, 0).length, 0);
});

test('markerDir honours CLAUDE_CONFIG_DIR; no folder means no markers', () => {
  assert.equal(markerDir({ CLAUDE_CONFIG_DIR: '/x' }), path.join('/x', 'state', 'mirror-due'));
  assert.deepEqual(dueMarkers(path.join(tmp(), 'missing')), []);
});

test('the CLI marks, lists and clears', () => {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: tmp() };
  spawnSync(process.execPath, [SCRIPT, 'mark', 'a/b', 'deadbeef'], { env });
  const listed = JSON.parse(spawnSync(process.execPath, [SCRIPT, 'list'], { env, encoding: 'utf8' }).stdout);
  assert.equal(listed[0].repo, 'a/b');
  spawnSync(process.execPath, [SCRIPT, 'clear', 'a/b', 'deadbeef'], { env });
  assert.deepEqual(JSON.parse(spawnSync(process.execPath, [SCRIPT, 'list'], { env, encoding: 'utf8' }).stdout), []);
});

test('Slice 23 check1 #5: clear with no start time removes a marker whose at is not a number', () => {
  const dir = tmp();
  mark('o/r', 'sha-a', dir, 5000);
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  fs.writeFileSync(file, JSON.stringify({ repo: 'o/r', sha: 'sha-a', at: 'soon', firedFor: [] }));
  assert.equal(clear('o/r', 'sha-a', dir), true);
  assert.equal(fs.existsSync(file), false);
});

test('Slice 29 item 35: a marker written after the mirror started is cleared when the mirrored sha covers its commit', () => {
  const dir = tmp();
  mark('o/r', 'merge-sha', dir, 5000, '/root');
  assert.equal(clear('o/r', 'mirrored', dir, 4000, () => false), false);
  assert.equal(clear('o/r', 'mirrored', dir, 4000, (marker, sha) => marker.sha === 'merge-sha' && sha === 'mirrored'), true);
  assert.deepEqual(dueMarkers(dir, 1e9, 0), []);
});

test('mirroredCovers falls back to the primary checkout when the recorded root is gone', () => {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const gone = path.join(tmp(), 'removed-worktree');
  assert.equal(mirroredCovers({ sha: head, root: gone }, head), true);
});

test('Slice 29 item 35: mirroredCovers asks git whether the marker sha is an ancestor, and needs a root', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push(args); return { status: 0 }; };
  assert.equal(mirroredCovers({ sha: 'a', root: '/r' }, 'b', run), true);
  assert.deepEqual(calls[0], ['-C', '/r', 'merge-base', '--is-ancestor', 'a', 'b']);
  assert.equal(mirroredCovers({ sha: 'a', root: '/r' }, 'b', () => ({ status: 1 })), false);
  assert.equal(mirroredCovers({ sha: 'a' }, 'b', run), false);
});

test('Slice 35 (406 item 18): reachableFromMain refuses only on git exit 1 and fails open otherwise', () => {
  const run = (status) => () => ({ status });
  assert.equal(reachableFromMain('abc', '/root', run(0)), true);
  assert.equal(reachableFromMain('abc', '/root', (cmd, args) => ({ status: args.includes('fetch') ? 0 : 1 })), false);
  assert.equal(reachableFromMain('abc', '/root', run(128)), true);
  assert.equal(reachableFromMain('', '/root', run(1)), true);
});

test('Slice 35 (406 item 18): a sha that only a fetch brings into origin/main is accepted; a failed fetch fails open', () => {
  const calls = [];
  const script = (checks, fetchStatus) => (cmd, args) => {
    calls.push(args.includes('fetch') ? 'fetch' : 'check');
    return { status: args.includes('fetch') ? fetchStatus : checks.shift() };
  };
  assert.equal(reachableFromMain('abc', '/root', script([1, 0], 0)), true);
  assert.deepEqual(calls, ['check', 'fetch', 'check']);
  assert.equal(reachableFromMain('abc', '/root', script([1, 1], 0)), false);
  assert.equal(reachableFromMain('abc', '/root', script([1], 128)), true);
});

test('Slice 35 (406 item 18): the CLI refuses a sha that is not on origin/main and writes no marker', () => {
  const repo = tmp();
  const remote = tmp();
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
  const onMain = git('rev-parse', 'HEAD').stdout.trim();
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main');
  git('fetch', '-q', 'origin', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'branch only');
  const offMain = git('rev-parse', 'HEAD').stdout.trim();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: tmp() };
  const bad = spawnSync(process.execPath, [SCRIPT, 'mark', 'a/b', offMain, repo], { env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not reachable from origin\/main/);
  assert.deepEqual(JSON.parse(spawnSync(process.execPath, [SCRIPT, 'list'], { env, encoding: 'utf8' }).stdout), []);
  const good = spawnSync(process.execPath, [SCRIPT, 'mark', 'a/b', onMain, repo], { env, encoding: 'utf8' });
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(spawnSync(process.execPath, [SCRIPT, 'list'], { env, encoding: 'utf8' }).stdout)[0].sha, onMain);
  // A merge that exists on the remote's main but not yet in the local origin/main (a stale clone right after `gh pr merge`).
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'merged remotely');
  const merged = git('rev-parse', 'HEAD').stdout.trim();
  git('push', '-q', 'origin', 'HEAD:main');
  git('update-ref', 'refs/remotes/origin/main', onMain);
  const stale = spawnSync(process.execPath, [SCRIPT, 'mark', 'a/c', merged, repo], { env, encoding: 'utf8' });
  assert.equal(stale.status, 0);
});

test('Slice 29 item 36: a typed sha not in the list prints the real markers before clearing', () => {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: tmp() };
  spawnSync(process.execPath, [SCRIPT, 'mark', 'a/b', '69def923'], { env });
  const out = spawnSync(process.execPath, [SCRIPT, 'clear', 'a/b', 'c67a2faa'], { env, encoding: 'utf8' }).stdout;
  assert.match(out, /pending mirror markers: a\/b 69def923/);
  assert.doesNotMatch(out, /note:/);
  const other = spawnSync(process.execPath, [SCRIPT, 'clear', 'c/d', 'c67a2faa'], { env, encoding: 'utf8' }).stdout;
  assert.match(other, /no pending marker for c\/d/);
  const odd = tmp();
  fs.writeFileSync(path.join(odd, 'o_r.json'), JSON.stringify({ repo: 'o/r', sha: 's', at: 'soon' }));
  assert.match(describeMarkers(odd), /o\/r s/);
  const matching = spawnSync(process.execPath, [SCRIPT, 'clear', 'a/b', 'x'], { env, encoding: 'utf8' }).stdout;
  assert.match(matching, /pending mirror markers: none/);
  assert.equal(describeMarkers(path.join(tmp(), 'missing')), 'pending mirror markers: none');
});

test('Slice 23 item 16: clear with no start time uses the mark time', () => {
  const dir = tmp();
  mark('o/r', 'sha-a', dir, 5000);
  assert.equal(clear('o/r', 'sha-a', dir), true);
  assert.deepEqual(dueMarkers(dir, 10 ** 9, 0), []);
});

test('Slice 33 item 22: touchesMirrorFile is false only for a clean list with no mirror file, and fails open', () => {
  const files = (out, status = 0) => () => ({ status, stdout: out });
  assert.equal(touchesMirrorFile('abc', '/root', files('.claude/settings.json\n')), false);
  assert.equal(touchesMirrorFile('abc', '/root', files('src/a.ts\nREADME.md\n')), true);
  assert.equal(touchesMirrorFile('abc', '/root', files('docs/plan/slices/01-x.md\n')), true);
  assert.equal(touchesMirrorFile('abc', '/root', files('docs/design/README.md\nsub/plan.md\n')), false);
  assert.equal(touchesMirrorFile('abc', '/root', files('tools/CLAUDE.md\n')), true);
  assert.equal(touchesMirrorFile('abc', '/root', files('~/.claude/CLAUDE.md\n')), true);
  assert.equal(touchesMirrorFile('abc', '/root', files('', 128)), true);
  assert.equal(touchesMirrorFile('abc', '/root', files('')), true);
});

test('Slice 33 item 22: the CLI refuses a merge that changed no mirror file and marks one that changed plan.md', () => {
  const repo = tmp();
  const remote = tmp();
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const git = (...args) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  git('remote', 'add', 'origin', remote);
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{}');
  git('add', '-A'); git('commit', '-q', '-m', 'settings only');
  const settingsOnly = git('rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(repo, 'plan.md'), '# plan');
  git('add', '-A'); git('commit', '-q', '-m', 'plan');
  const planChange = git('rev-parse', 'HEAD').stdout.trim();
  git('push', '-q', 'origin', 'main');
  git('fetch', '-q', 'origin', 'main');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: tmp() };
  const bad = spawnSync(process.execPath, [SCRIPT, 'mark', 'a/b', settingsOnly, repo], { env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /changed no mirror file/);
  assert.deepEqual(JSON.parse(spawnSync(process.execPath, [SCRIPT, 'list'], { env, encoding: 'utf8' }).stdout), []);
  const good = spawnSync(process.execPath, [SCRIPT, 'mark', 'a/b', planChange, repo], { env, encoding: 'utf8' });
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(spawnSync(process.execPath, [SCRIPT, 'list'], { env, encoding: 'utf8' }).stdout)[0].sha, planChange);
});
