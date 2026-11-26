// node --test skills/run-wave/stale-primary-read-warn.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide } from './stale-primary-read-warn.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stale-primary-read-warn.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

// A bare origin and a clone of it; `behind` commits are then added to origin/main and fetched into the clone.
function fixture(behind) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-read-'));
  const origin = path.join(base, 'origin.git');
  const clone = path.join(base, 'clone');
  const other = path.join(base, 'other');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, other]);
  git(other, 'checkout', '-q', '-b', 'main');
  git(other, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(other, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, clone]);
  for (let i = 0; i < behind; i++) git(other, 'commit', '-q', '--allow-empty', '-m', `n${i}`);
  git(other, 'push', '-q', 'origin', 'main');
  git(clone, 'fetch', '-q', 'origin');
  return { clone, base };
}

const read = (cwd, file) => ({ tool_name: 'Read', cwd, tool_input: { file_path: file } });

test('warns for a Read inside a primary checkout that is behind origin/main, never denies', () => {
  const { clone } = fixture(2);
  const verdict = decide(read(os.tmpdir(), path.join(clone, 'x.txt')));
  assert.equal(verdict.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(verdict.hookSpecificOutput.permissionDecision, undefined);
  assert.match(verdict.hookSpecificOutput.additionalContext, /2 commits behind origin\/main/);
  assert.match(verdict.hookSpecificOutput.additionalContext, /show origin\/main:<path>/);
  assert.match(verdict.hookSpecificOutput.additionalContext, /git -C .* grep <pattern> origin\/main/);
});

test('Grep and Glob use path, and no path means the cwd', () => {
  const { clone } = fixture(1);
  assert.match(decide({ tool_name: 'Grep', cwd: os.tmpdir(), tool_input: { pattern: 'x', path: clone } }).hookSpecificOutput.additionalContext, /1 commit behind/);
  assert.match(decide({ tool_name: 'Glob', cwd: clone, tool_input: { pattern: '*.md' } }).hookSpecificOutput.additionalContext, /1 commit behind/);
});

test('silent when the checkout is up to date, outside any repo, or the tool is not watched', () => {
  const { clone } = fixture(0);
  assert.equal(decide(read(os.tmpdir(), path.join(clone, 'x.txt'))), null);
  assert.equal(decide(read(os.tmpdir(), path.join(os.tmpdir(), 'nowhere.txt'))), null);
  assert.equal(decide({ tool_name: 'Bash', cwd: clone, tool_input: { command: 'ls' } }), null);
});

test('silent in a linked worktree, which is not a primary checkout', () => {
  const { clone, base } = fixture(2);
  const worktree = path.join(base, 'wt');
  git(clone, 'worktree', 'add', '-q', '-b', 'feat/w', worktree, 'origin/main');
  assert.equal(decide(read(os.tmpdir(), path.join(worktree, 'x.txt'))), null);
});

test('warns once per root, behind-count and session; allows the clean-main pull in its wording', () => {
  const { clone, base } = fixture(1);
  const markers = fs.mkdtempSync(path.join(base, 'markers-'));
  const input = { ...read(os.tmpdir(), path.join(clone, 'x.txt')), session_id: 's1' };
  const first = decide(input, markers);
  assert.match(first.hookSpecificOutput.additionalContext, /unless it is a clean main/);
  assert.equal(decide(input, markers), null);
  assert.notEqual(decide({ ...input, session_id: 's2' }, markers), null);
});

test('without a session id it warns every time and writes no marker', () => {
  const { clone, base } = fixture(1);
  const markers = fs.mkdtempSync(path.join(base, 'markers-'));
  const input = read(os.tmpdir(), path.join(clone, 'x.txt'));
  assert.notEqual(decide(input, markers), null);
  assert.notEqual(decide(input, markers), null);
  assert.deepEqual(fs.readdirSync(markers), []);
});

test('writing a marker removes this hook\'s own markers older than 24 h, and only those', () => {
  const { clone, base } = fixture(1);
  const markers = fs.mkdtempSync(path.join(base, 'markers-'));
  const old = path.join(markers, 'stale-primary-warn-old');
  const other = path.join(markers, 'unrelated-old');
  fs.writeFileSync(old, '');
  fs.writeFileSync(other, '');
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
  fs.utimesSync(other, twoDaysAgo, twoDaysAgo);
  decide({ ...read(os.tmpdir(), path.join(clone, 'x.txt')), session_id: 'cleanup' }, markers);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(other), true);
});

test('as a hook: prints the JSON for a stale checkout, and nothing (exit 0) on garbage input', () => {
  const { clone } = fixture(1);
  const run = spawnSync('node', [HOOK], { input: JSON.stringify(read(clone, 'x.txt')), encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(JSON.parse(run.stdout).hookSpecificOutput.additionalContext, /1 commit behind/);
  const bad = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr, '');
});
