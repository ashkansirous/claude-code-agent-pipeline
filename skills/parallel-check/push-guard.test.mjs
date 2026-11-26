import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsCheck, decide, branchOf } from './push-guard.mjs';

test('branchOf takes the destination of a refspec and null for a bare HEAD', () => {
  assert.equal(branchOf('-u origin feat/y'), 'feat/y');
  assert.equal(branchOf('-u origin HEAD:feat/y'), 'feat/y');
  assert.equal(branchOf('origin feat/y:feat/y --no-verify'), 'feat/y');
  assert.equal(branchOf('origin HEAD'), null);
  assert.equal(branchOf('-u origin'), null);
  assert.equal(branchOf('-u -o ci.skip origin feat/x'), 'feat/x');
  assert.equal(branchOf('--push-option ci.skip origin feat/x'), 'feat/x');
  assert.equal(branchOf('--repo foo origin feat/x'), 'feat/x');
  assert.equal(branchOf('--push-option=ci.skip origin feat/x'), 'feat/x');
});

function repo(withSlices) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-guard-'));
  if (withSlices) fs.mkdirSync(path.join(root, 'docs', 'plan', 'slices'), { recursive: true });
  return root;
}

test('first push in a slice repo without the check is denied', () => {
  const root = repo(true);
  assert.equal(needsCheck(`git -C ${root} push -u origin feat/x`, os.tmpdir()), true);
  assert.equal(needsCheck('git push --set-upstream origin feat/x', root), true);
});

test('first push chained after the check passes', () => {
  const root = repo(true);
  const command = `python -I ~/.claude/skills/parallel-check/parallel_check.py ${root} --check-slice feat/x && git -C ${root} push -u origin feat/x`;
  assert.equal(needsCheck(command, os.tmpdir()), false);
});

test('a later push and a repo without slices are not touched', () => {
  assert.equal(needsCheck('git push origin feat/x', repo(true)), false);
  assert.equal(needsCheck('git push -u origin feat/x', repo(false)), false);
  assert.equal(needsCheck('git commit -m "git push -u origin x"', repo(true)), false);
});

const CHECK_CMD = (root) => `python -I ~/.claude/skills/parallel-check/parallel_check.py ${root} --check-slice feat/x`;

test('a check that runs after the push, or is not joined by &&, does not count', () => {
  const root = repo(true);
  assert.equal(needsCheck(`git -C ${root} push -u origin feat/x && ${CHECK_CMD(root)}`, os.tmpdir()), true);
  assert.equal(needsCheck(`${CHECK_CMD(root)} ; git -C ${root} push -u origin feat/x`, os.tmpdir()), true);
  assert.equal(needsCheck(`${CHECK_CMD(root)} || git -C ${root} push -u origin feat/x`, os.tmpdir()), true);
  assert.equal(needsCheck(`${CHECK_CMD(root)}
git -C ${root} push -u origin feat/x`, os.tmpdir()), true);
  assert.equal(needsCheck(`echo parallel_check.py --check-slice; git -C ${root} push -u origin feat/x`, os.tmpdir()), true);
  assert.equal(needsCheck(`${CHECK_CMD(root)} && git -C ${root} push -u origin feat/x`, os.tmpdir()), false);
});

test('cd and Set-Location before the push set the repo', () => {
  const root = repo(true);
  assert.equal(needsCheck(`cd ${root} && git push -u origin feat/x`, os.tmpdir()), true);
  assert.equal(needsCheck(`Set-Location "${root}"; git push -u origin feat/x`, os.tmpdir()), true);
  assert.equal(needsCheck(`cd ${root} && ${CHECK_CMD(root)} && git push -u origin feat/x`, os.tmpdir()), false);
  assert.equal(needsCheck(`cd ${repo(false)} && git push -u origin feat/x`, root), false);
});

test('git -c key=value before push is recognised', () => {
  const root = repo(true);
  assert.equal(needsCheck(`git -c core.hooksPath=x -C ${root} push -u origin feat/x`, os.tmpdir()), true);
  assert.equal(needsCheck(`git -c user.name=t push --set-upstream origin feat/x`, root), true);
});

test('a cwd inside a repo subdirectory finds the repo root; a nested repo without slices stops the walk', () => {
  const root = repo(true);
  const sub = path.join(root, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(needsCheck('git push -u origin feat/x', sub), true);
  const other = path.join(root, 'nested');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  assert.equal(needsCheck('git push -u origin feat/x', other), false);
});

test('quoted strings and heredoc bodies are never a push; quoted -C paths still work', () => {
  const root = repo(true);
  assert.equal(needsCheck('git commit -m "fix; git push -u origin x"', root), false);
  assert.equal(needsCheck("echo 'a && git push -u origin x'", root), false);
  assert.equal(needsCheck('git commit -F - <<\'EOF\'\nmsg\n; git push -u origin x\nEOF', root), false);
  assert.equal(needsCheck(`git -C "${root}" push -u origin feat/x`, os.tmpdir()), true);
  assert.equal(needsCheck('git commit -m "x" && git push -u origin feat/x', root), true);
});

test('combined short flags with u are a first push; long flags are not', () => {
  const root = repo(true);
  for (const flag of ['-fu', '-uf', '-vu']) assert.equal(needsCheck(`git push ${flag} origin feat/x`, root), true);
  assert.equal(needsCheck('git push --upload-pack=x origin feat/x', root), false);
  assert.equal(needsCheck('git push -f origin feat/x', root), false);
});

test('decide returns a deny only for Bash or PowerShell', () => {
  const root = repo(true);
  const input = { tool_name: 'Bash', cwd: root, tool_input: { command: 'git push -u origin feat/x' } };
  assert.equal(decide(input).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(decide({ ...input, tool_name: 'Read' }), null);
});

test('the deny reason names the worktree and branch and says the denied command did not run', () => {
  const root = repo(true);
  const verdict = decide({ tool_name: 'Bash', cwd: os.tmpdir(), tool_input: { command: `git -C ${root} commit -m m && git -C ${root} push -u origin feat/y` } });
  const reason = verdict.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /feat\/y/);
  assert.ok(reason.includes(path.resolve(root)));
  assert.match(reason, /did not run at all/);
  assert.match(reason, /commit chained before the push in the same command has NOT happened/);
  assert.match(reason, /push-branch\.mjs/);
});

test('a call of the push-branch helper is not denied', () => {
  const root = repo(true);
  const command = `node ~/.claude/skills/parallel-check/push-branch.mjs ${root} feat/y`;
  assert.equal(decide({ tool_name: 'Bash', cwd: os.tmpdir(), tool_input: { command } }), null);
});

test('a push naming no branch still gets a reason with a placeholder', () => {
  const root = repo(true);
  const verdict = decide({ tool_name: 'Bash', cwd: root, tool_input: { command: 'git push -u' } });
  assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /branch <branch>/);
});
