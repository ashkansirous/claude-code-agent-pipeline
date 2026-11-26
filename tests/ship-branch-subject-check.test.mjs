// Pins the subject-line version-marker check that agents/ship-branch.md step 4 tells the shipper to run
// (Slice 377 item 10): the pattern is read out of the agent file, then run through bash grep against a
// subject with the marker (refused), a marker only on a trailer line, and a plain subject (both pass).
// Marker texts are built from parts so this file never carries the literal token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'ship-branch.md');
const TOKEN = ['+sem', 'ver'].join('');

function checkLine() {
  const text = readFileSync(AGENT, 'utf8');
  const m = /(printf '%s\\n' "\$MSG" \| head -n 1 \| grep -qiE '[^']+')/.exec(text);
  assert.ok(m, 'the agent file names the subject check command');
  return m[1];
}

function refused(message) {
  const r = spawnSync('bash', ['-c', checkLine()], { env: { ...process.env, MSG: message }, encoding: 'utf8' });
  return r.status === 0;
}

test('a marker in the subject line is refused', () => {
  assert.equal(refused(`fix(dino): stop the crash ${TOKEN}: minor\n\nbody`), true);
  assert.equal(refused(`feat: x ${TOKEN.toUpperCase()} : patch`), true);
});

test('a marker on its own trailer line, or no marker, passes', () => {
  assert.equal(refused(`fix(dino): stop the crash\n\n${TOKEN}: minor`), false);
  assert.equal(refused('docs: tidy'), false);
});

// Slice 393 item 21: the post-commit whole-message check finds a marker anywhere in the body, which the subject check cannot.
function wholeMessageCommand() {
  const m = /(git log -1 --format=%B \| grep -ciE '[^']*\\\+semver[^']*')/.exec(readFileSync(AGENT, 'utf8'));
  assert.ok(m, 'the agent file names the whole-message check command');
  return m[1].replace('git log -1 --format=%B', 'printf \'%s\\n\' "$MSG"');
}

test('the whole-message check counts a marker in the body, and prints 0 for a clean message', () => {
  const count = (message) => spawnSync('bash', ['-c', wholeMessageCommand()], { env: { ...process.env, MSG: message }, encoding: 'utf8' }).stdout.trim();
  assert.equal(count(`fix: x\n\nbody text\n${TOKEN}: patch`), '1');
  assert.equal(count('fix: x\n\nbody text'), '0');
});
