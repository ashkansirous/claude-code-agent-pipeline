// node --test skills/feedback-loop/coauthor-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { decide, messageFiles } from './coauthor-guard.mjs';

const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const bash = (command, cwd = 'D:/repo') => ({ tool_name: 'Bash', cwd, tool_input: { command } });
const denied = (verdict) => verdict?.hookSpecificOutput?.permissionDecision === 'deny';

test('a commit with the trailer in its message is denied', () => {
  assert.ok(denied(decide(bash(`git commit -m "fix: x" -m "${TRAILER}"`))));
  assert.ok(denied(decide(bash(`git -C D:/w commit -m "$(printf 'x\\n\\n${TRAILER}')"`))));
  assert.ok(denied(decide(bash(`git commit -m "x\n\nco-authored-by: Someone <a@b.c>"`))));
});

test('a commit whose -F message file has the trailer is denied', () => {
  const read = (path) => (path.endsWith('msg.txt') ? `fix: x\n\n${TRAILER}\n` : '');
  assert.ok(denied(decide(bash('git commit -F msg.txt'), read)));
  assert.ok(denied(decide(bash('git commit --file "D:/tmp/msg.txt"'), read)));
  assert.equal(decide(bash('git commit -F other.txt'), read), null);
});

test('a brief with the trailer is denied, one quoting the rule passes', () => {
  assert.ok(denied(decide({ tool_name: 'Agent', tool_input: { prompt: `Commit with:\n${TRAILER}` } })));
  assert.equal(decide({ tool_name: 'Agent', tool_input: { prompt: 'Commits carry no Co-Authored-By line.' } }), null);
});

test('an Agent brief with coauthor-ok passes', () => {
  assert.equal(decide({ tool_name: 'Agent', tool_input: { prompt: `Commit with:\n${TRAILER}\n# coauthor-ok` } }), null);
});

test('a commit mentioning the bare word coauthor-ok without # is still denied; an Agent brief may use the bare word', () => {
  assert.ok(denied(decide(bash(`git commit -m "coauthor-ok" -m "${TRAILER}"`))));
  assert.equal(decide({ tool_name: 'Agent', tool_input: { prompt: `Commit with:\n${TRAILER}\ncoauthor-ok` } }), null);
});

test('non-commit commands, the opt-out and plain commits pass', () => {
  assert.equal(decide(bash(`git log --grep "${TRAILER}"`)), null);
  assert.equal(decide(bash(`git commit -m "x" -m "${TRAILER}"  # coauthor-ok`)), null);
  assert.equal(decide(bash('git commit -m "fix: plain"')), null);
  assert.equal(decide({}), null);
});

test('messageFiles resolves relative paths against the cwd', () => {
  assert.deepEqual(messageFiles('git commit -F m.txt', 'D:/w'), [join('D:/w', 'm.txt')]);
  assert.deepEqual(messageFiles('git commit -F -'), []);
});
