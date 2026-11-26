// node --test skills/feedback-loop/device-run-edit-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, MARK_MAX_AGE_MS, LIVE_MAX_AGE_MS } from './device-run-edit-guard.mjs';

const HOOK = fileURLToPath(new URL('./device-run-edit-guard.mjs', import.meta.url));
// Slice 35 item 4: only the certain case is denied (a young mark, or a live pid in the mark's name); the rest only warns.
const isAdvisory = (verdict) => !verdict?.hookSpecificOutput?.permissionDecision && Boolean(verdict?.hookSpecificOutput?.additionalContext);
const aged = (path, ms) => { const t = new Date(Date.now() - ms); utimesSync(path, t, t); };
const isDenied = (verdict) => verdict?.hookSpecificOutput?.permissionDecision === 'deny' && Boolean(verdict.hookSpecificOutput.permissionDecisionReason);
const edit = (tool, file) => ({ tool_name: tool, tool_input: { file_path: file } });

// A primary checkout with one real worktree, so the `.git` FILE form (gitdir: ...) is the one under test.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dreg-'));
  const primary = join(base, 'primary');
  mkdirSync(primary);
  const git = (...args) => execFileSync('git', ['-C', primary, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(primary, 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-q', '-m', 'x');
  const worktree = join(base, 'wt');
  git('worktree', 'add', '-q', '-b', 'feat/x', worktree);
  const gitDir = execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
  return { primary, worktree, gitDir, base };
}

test('an edit in a worktree is denied while a fresh device-test-running mark sits in its git dir', () => {
  const { primary, worktree, gitDir } = fixture();
  assert.equal(decide(edit('Edit', join(worktree, 'a.txt'))), null);
  writeFileSync(join(gitDir, 'device-test-running-20261107-1'), '');
  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    const verdict = decide(edit(tool, join(worktree, 'src', 'A.cs')));
    assert.ok(isDenied(verdict), tool);
    assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /device-test-running-20261107-1/);
  }
  assert.ok(isDenied(decide({ tool_name: 'Edit', cwd: worktree, tool_input: { file_path: 'a.txt' } })));
  // The caller's cwd is another checkout (the primary): the path is still inside the marked worktree, so it is denied.
  assert.ok(isDenied(decide({ tool_name: 'Edit', cwd: primary, tool_input: { file_path: join(worktree, 'a.txt') } })));
});

test('a mark of 90 minutes or more is a leftover and is ignored', () => {
  const { worktree, gitDir } = fixture();
  const mark = join(gitDir, 'device-test-running-old');
  writeFileSync(mark, '');
  const old = new Date(Date.now() - MARK_MAX_AGE_MS - 60_000);
  utimesSync(mark, old, old);
  assert.equal(decide(edit('Write', join(worktree, 'a.txt'))), null);
});

test('a mark between 15 and 90 minutes old only warns, unless its name holds a live pid', () => {
  const { worktree, gitDir } = fixture();
  const mark = join(gitDir, 'device-test-running-20261107-2');
  writeFileSync(mark, '');
  aged(mark, LIVE_MAX_AGE_MS + 60_000);
  const verdict = decide(edit('Edit', join(worktree, 'a.txt')));
  assert.ok(isAdvisory(verdict));
  assert.match(verdict.hookSpecificOutput.additionalContext, /Do not delete it/);
  const own = join(gitDir, `device-test-running-run-flows-${process.pid}-abcd`);
  writeFileSync(own, '');
  aged(own, LIVE_MAX_AGE_MS + 60_000);
  assert.ok(isDenied(decide(edit('Edit', join(worktree, 'a.txt')))));
  rmSync(own);
  const dead = join(gitDir, 'device-test-running-run-flows-999999999-abcd');
  writeFileSync(dead, '');
  aged(dead, LIVE_MAX_AGE_MS + 60_000);
  assert.ok(isAdvisory(decide(edit('Edit', join(worktree, 'a.txt')))));
  rmSync(dead);
  for (const odd of ['0', '00', '99999999999999999999']) {
    const bad = join(gitDir, `device-test-running-run-flows-${odd}-abcd`);
    writeFileSync(bad, '');
    aged(bad, LIVE_MAX_AGE_MS + 60_000);
    assert.ok(isAdvisory(decide(edit('Edit', join(worktree, 'a.txt')))), `pid ${odd} is not a live run`);
    rmSync(bad);
  }
  const stamp = join(gitDir, `device-test-running-${process.pid}-1432-ab`);
  writeFileSync(stamp, '');
  aged(stamp, LIVE_MAX_AGE_MS + 60_000);
  assert.ok(isAdvisory(decide(edit('Edit', join(worktree, 'a.txt')))), 'a digit group in a timestamp id is not a pid');
});

test('the deny text never tells the agent to delete the mark, and the flows/checks folders are exempt', () => {
  const { worktree, gitDir } = fixture();
  writeFileSync(join(gitDir, 'device-test-running-5'), '');
  const verdict = decide(edit('Edit', join(worktree, 'a.txt')));
  assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /blocked: device test running/);
  assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /Never delete the mark/);
  assert.doesNotMatch(verdict.hookSpecificOutput.permissionDecisionReason, /delete its mark file/);
  assert.equal(decide(edit('Write', join(worktree, 'tools', 'emulator', 'flows', 'new.yaml'))), null);
  assert.equal(decide(edit('Write', join(worktree, 'tools', 'phone', 'checks', 'c.ps1'))), null);
});

test('only the marked worktree is held: the primary, another worktree, tmp/, the git dir and other tools pass', () => {
  const { primary, worktree, gitDir, base } = fixture();
  writeFileSync(join(gitDir, 'device-test-running-1'), '');
  assert.equal(decide(edit('Edit', join(primary, 'a.txt'))), null);
  assert.equal(decide(edit('Write', join(worktree, 'tmp', 'evidence', 'log.txt'))), null);
  assert.equal(decide(edit('Write', join(gitDir, 'device-test-running-2'))), null);
  assert.equal(decide(edit('Write', join(base, 'outside.txt'))), null);
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: join(worktree, 'a.txt') } }), null);
  assert.equal(decide({ tool_name: 'Edit', tool_input: {} }), null);
  assert.equal(decide({}), null);
  const outside = mkdtempSync(join(tmpdir(), 'dreg-out-'));
  assert.equal(decide(edit('Write', join(outside, 'x.txt'))), null);
  rmSync(outside, { recursive: true, force: true });
});

test('the device-test subagent (agent_type in the hook input) may write under its own mark; other agents may not', () => {
  const { worktree, gitDir } = fixture();
  writeFileSync(join(gitDir, 'device-test-running-4'), '');
  const file = join(worktree, 'src', 'new.yaml');
  assert.equal(decide({ ...edit('Write', file), agent_type: 'device-test', agent_id: 'x' }), null);
  assert.ok(isDenied(decide({ ...edit('Write', file), agent_type: 'fix-review-findings', agent_id: 'y' })));
  assert.ok(isDenied(decide(edit('Write', file))));
});

test('a primary checkout (.git is a folder) with a mark holds its files too', () => {
  const { primary } = fixture();
  writeFileSync(join(primary, '.git', 'device-test-running-9'), '');
  assert.ok(isDenied(decide(edit('Edit', join(primary, 'a.txt')))));
});

test('the hook runs from the command line, denies on stdout, logs the deny and fails open on garbage', () => {
  const { worktree, gitDir } = fixture();
  writeFileSync(join(gitDir, 'device-test-running-3'), '');
  const log = join(mkdtempSync(join(tmpdir(), 'dreg-log-')), 'advisory-hooks.log');
  const run = (stdin) => spawnSync('node', [HOOK], { input: stdin, encoding: 'utf8', env: { ...process.env, ADVISORY_HOOKS_LOG: log } });
  const warned = run(JSON.stringify(edit('Edit', join(worktree, 'a.txt')))).stdout;
  assert.match(warned, /"permissionDecision":"deny"/);
  assert.match(readFileSync(log, 'utf8'), /^\S+\tdevice-run-edit-guard\t.*\tDENIED: device run guard/);
  // The log cannot be written (its folder path is a file): the deny still goes out.
  const blocker = join(mkdtempSync(join(tmpdir(), 'dreg-blk-')), 'file');
  writeFileSync(blocker, '');
  const noLog = spawnSync('node', [HOOK], { input: JSON.stringify(edit('Edit', join(worktree, 'a.txt'))), encoding: 'utf8', env: { ...process.env, ADVISORY_HOOKS_LOG: join(blocker, 'x', 'log') } });
  assert.match(noLog.stdout, /"permissionDecision":"deny"/);
  // advisory.mjs missing (a copy of the hook alone in a folder): the deny still goes out, unlogged.
  const lone = join(mkdtempSync(join(tmpdir(), 'dreg-lone-')), 'guard.mjs');
  writeFileSync(lone, readFileSync(HOOK, 'utf8'));
  const noLib = spawnSync('node', [lone], { input: JSON.stringify(edit('Edit', join(worktree, 'a.txt'))), encoding: 'utf8' });
  assert.match(noLib.stdout, /"permissionDecision":"deny"/);
  const garbage = run('garbage');
  assert.equal(garbage.status, 0);
  assert.match(garbage.stderr, /device-run-edit-guard/);
});
