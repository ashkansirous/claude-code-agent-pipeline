import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from './timer-cwd-guard.mjs';

const AGENTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents');
const TIMER_COMMAND = /arm a background `(sleep \d+[^`]*)`/;
const inWorktree = () => 'D:/x-worktrees/slice';

// The reviewers run from the worktree they review and cannot cd out, so the deadline timer they arm must be the form
// timer-cwd-guard lets through (Slice 315 item 25: the plain `sleep 1200` was denied and the backstop never ran).
for (const name of ['code-review-pass']) {
  test(`${name}: the deadline timer in the agent text passes timer-cwd-guard from a worktree`, () => {
    const text = readFileSync(join(AGENTS, `${name}.md`), 'utf8');
    const command = TIMER_COMMAND.exec(text)?.[1];
    assert.ok(command, 'the agent text names its timer command');
    const input = { cwd: 'D:/x-worktrees/slice/src', tool_input: { command, run_in_background: true } };
    assert.equal(decide(input, inWorktree), null, command);
    assert.equal(decide({ ...input, tool_input: { command: command.replace(/\s*#.*$/, ''), run_in_background: true } }, inWorktree).hookSpecificOutput.permissionDecision, 'deny', 'the bare form is denied');
  });
}
