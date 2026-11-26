// node --test skills/feedback-loop/timer-cwd-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, linkedWorktreeRoot } from './timer-cwd-guard.mjs';

const inWorktree = () => 'D:/x-worktrees/slice';
const outside = () => null;
const bg = (command, cwd = 'D:/x-worktrees/slice/src') => ({ cwd, tool_input: { command, run_in_background: true } });

test('a background sleep inside a linked worktree is denied', () => {
  assert.equal(decide(bg('sleep 600'), inWorktree).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(decide(bg('Start-Sleep -Seconds 600'), inWorktree).hookSpecificOutput.permissionDecision, 'deny');
  // A cd inside the command does not move the background task's own cwd (reproduced 2026-11-01).
  assert.equal(decide(bg('cd /d/x && sleep 600'), inWorktree).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(decide(bg('until [ -f x ]; do sleep 20; done'), inWorktree).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(decide(bg('cd /d/x\nsleep 600'), inWorktree).hookSpecificOutput.permissionDecision, 'deny');
});

test('the denial says the cd goes in an earlier message', () => {
  const reason = decide(bg('sleep 600'), inWorktree).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /in an earlier message, not the same one/);
});

test('foreground, non-timer and outside-worktree calls pass', () => {
  assert.equal(decide({ cwd: 'D:/x', tool_input: { command: 'sleep 600' } }, inWorktree), null);
  assert.equal(decide(bg('npm run dev'), inWorktree), null);
  assert.equal(decide(bg('node sleeper.mjs'), inWorktree), null);
  assert.equal(decide(bg('sleep 600  # worktree-timer-ok'), inWorktree), null);
  assert.equal(decide(bg('sleep 600'), outside), null);
  assert.equal(decide({}, inWorktree), null);
});

test('a worktree remove ending with the # worktree-remove-ok marker is allowed', () => {
  const cwd = 'D:/AgentPipeline-worktrees/s28p';
  const verdict = (command) => decide({ cwd, tool_input: { command } }, outside)?.hookSpecificOutput.permissionDecision;
  assert.equal(verdict('git worktree remove D:/AgentPipeline-worktrees/s28p # worktree-remove-ok'), undefined);
  assert.equal(verdict('git worktree remove D:/AgentPipeline-worktrees/s28p'), 'deny');
});

test('git worktree remove of the folder the cwd is inside is denied, in a command and in an Agent brief', () => {
  const cwd = 'D:\\AgentPipeline-worktrees\\s28p\\src';
  const verdict = (tool_input) => decide({ cwd, tool_input }, outside)?.hookSpecificOutput.permissionDecision;
  assert.equal(verdict({ command: 'git worktree remove D:/AgentPipeline-worktrees/s28p' }), 'deny');
  assert.equal(verdict({ command: 'git -C D:/AgentPipeline worktree remove --force "D:\\AgentPipeline-worktrees\\s28p"' }), 'deny');
  assert.equal(verdict({ command: 'git worktree remove /d/AgentPipeline-worktrees/s28p/' }), 'deny');
  assert.equal(verdict({ prompt: 'Merge, then run `git worktree remove D:/AgentPipeline-worktrees/s28p`.' }), 'deny');
});

test('git worktree remove of another folder, or with no cwd inside it, passes', () => {
  const cwd = 'D:/AgentPipeline-worktrees/s28p';
  assert.equal(decide({ cwd, tool_input: { command: 'git worktree remove D:/AgentPipeline-worktrees/other' } }, outside), null);
  assert.equal(decide({ cwd, tool_input: { command: 'git worktree remove D:/AgentPipeline-worktrees/s28p-2' } }, outside), null);
  assert.equal(decide({ cwd: 'D:/AgentPipeline', tool_input: { command: 'git worktree remove D:/AgentPipeline-worktrees/s28p' } }, outside), null);
  assert.equal(decide({ cwd, tool_input: { prompt: 'git worktree remove <path>' } }, outside), null);
});

test('git worktree remove inside prose is not a command; the same-command cd form and a -C relative path are judged as written', () => {
  const cwd = 'D:/AgentPipeline-worktrees/s28p';
  const verdict = (tool_input) => decide({ cwd, tool_input }, outside)?.hookSpecificOutput.permissionDecision ?? null;
  const path = 'D:/AgentPipeline-worktrees/s28p';
  assert.equal(verdict({ command: `git commit -m "never run git worktree remove ${path} here"` }), null);
  assert.equal(verdict({ command: `echo 'git worktree remove ${path}'` }), null);
  assert.equal(verdict({ command: `gh pr create --body-file - <<'EOF'\nrun git worktree remove ${path}\nEOF` }), null);
  assert.equal(verdict({ prompt: `Do not remove it: git worktree remove ${path} fails while the cwd is inside.` }), null);
  assert.equal(verdict({ command: `cd D:/AgentPipeline && git worktree remove ${path}` }), 'deny');
  assert.equal(verdict({ command: 'git -C D:/AgentPipeline-worktrees worktree remove s28p' }), 'deny');
  assert.equal(verdict({ command: 'git -C D:/AgentPipeline worktree remove s28p' }), null);
  assert.match(decide({ cwd, tool_input: { command: `cd D:/AgentPipeline && git worktree remove ${path}` } }, outside).hookSpecificOutput.permissionDecisionReason, /same command is denied too/);
});

test('linkedWorktreeRoot finds a .git file, not a .git directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'tcg-'));
  try {
    const linked = join(root, 'linked');
    mkdirSync(join(linked, 'src'), { recursive: true });
    writeFileSync(join(linked, '.git'), 'gitdir: D:/repo/.git/worktrees/linked\n');
    const primary = join(root, 'primary');
    mkdirSync(join(primary, '.git', 'objects'), { recursive: true });
    mkdirSync(join(primary, 'src'));
    const submodule = join(root, 'sub');
    mkdirSync(submodule);
    writeFileSync(join(submodule, '.git'), 'gitdir: ../.git/modules/sub\n');
    assert.equal(linkedWorktreeRoot(join(linked, 'src')), linked);
    assert.equal(linkedWorktreeRoot(join(primary, 'src')), null);
    assert.equal(linkedWorktreeRoot(submodule), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
