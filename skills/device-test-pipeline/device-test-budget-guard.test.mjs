// node --test skills/device-test-pipeline/device-test-budget-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, overCap } from './device-test-budget-guard.mjs';

const SCRIPT = fileURLToPath(new URL('./device-test-budget-guard.mjs', import.meta.url));

const brief = (prompt, subagent_type = 'device-test') => ({ tool_name: 'Agent', tool_input: { subagent_type, prompt } });
const denied = (prompt) => decide(brief(prompt))?.hookSpecificOutput.permissionDecision === 'deny';

test('budgets and waits over 10 minutes are denied (the 2026-11-01 briefs)', () => {
  assert.ok(denied('Rules: ... Total budget 45 minutes; one run.'));
  assert.ok(denied('Budget 40 minutes, one run (one extra run only if a failure is clearly timing).'));
  assert.ok(denied('If the lock is held by an RTST/Dino run, wait for it (that is fine) up to 20 minutes.'));
  assert.ok(denied('Wait up to 20 min if the lock is held.'));
  assert.ok(denied('You have a 60-minute budget.'));
  assert.ok(denied('Time-box: 1 hour.'));
});

test('10 minutes or less, other agents and unrelated durations pass', () => {
  assert.equal(decide(brief('Budget 10 minutes, one run.')), null);
  assert.equal(decide(brief('Wait up to 5 min for the lock.')), null);
  assert.equal(decide(brief('Budget 45 minutes.', 'implement-slice')), null);
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'sleep 600' } }), null);
  assert.equal(decide(brief('The previous run, stamp 20261101-220314, found 3 failures.')), null);
  assert.equal(decide(brief('The app logged 30 minutes of idle time before the crash.')), null);
  assert.equal(decide({}), null);
});

test('a budget word in another sentence does not count (finding 1)', () => {
  assert.equal(decide(brief('Budget 10 minutes. Last run: 45 minutes, all failed.')), null);
  assert.equal(decide(brief('Max 10 minutes.\nSlice 189 took 45 minutes over three runs.')), null);
  assert.equal(decide(brief('Budget 10 minutes; PR merged 3 hours ago.')), null);
});

test('generic words do not trigger, run-governing ones do (finding 2)', () => {
  assert.equal(decide(brief('The APK install can take 15 minutes on first boot.')), null);
  assert.equal(decide(brief('CI is allowed within 30 minutes.')), null);
  assert.ok(denied('Allow the run 30 minutes.'));
  assert.ok(denied('The run takes 25 minutes.'));
  assert.ok(denied('Time limit: 30 min.'));
});

test('more units are read (finding 3)', () => {
  assert.ok(denied('Budget 45m'));
  assert.ok(denied('Timeout: 3600 seconds'));
  assert.ok(denied('Timeout 3600 s'));
  assert.ok(denied('Timeout 1800000 ms'));
  assert.ok(denied('Budget 1h30m'));
  assert.ok(denied('Budget 1h 30m'));
  assert.equal(decide(brief('Timeout 600000 ms')), null);
  assert.equal(decide(brief('Budget 600 sec')), null);
  assert.equal(decide(brief('Budget 10m')), null);
  assert.equal(decide(brief('Budget 30 items in the minutes list')), null);
});

test('any agent that runs a device is capped, not only device-test (entry I 2381)', () => {
  const vm = 'You fix and test the Slice 21 desktop-check scripts of print-the-damn-book until they pass in the shared Hyper-V VM, within 60 minutes total.';
  const isDenied = (prompt, type) => decide(brief(prompt, type))?.hookSpecificOutput.permissionDecision === 'deny';
  assert.ok(isDenied(vm, 'general-purpose'));
  assert.ok(isDenied('Run the checks on the VM, budget 30 minutes.', 'general-purpose'));
  assert.ok(isDenied('Test on the real phone over wireless adb within 45 minutes total.', 'general-purpose'));
  assert.equal(decide(brief('Fix the parser, budget 60 minutes total.', 'general-purpose')), null);
  // Medium review 2026-11-01: plurals, phone and simulator count; a hyphen-joined name doesn't.
  assert.ok(isDenied('Run them on the emulators within 30 minutes total.', 'general-purpose'));
  assert.ok(isDenied('Test on the phone, budget 60 minutes.', 'general-purpose'));
  assert.ok(isDenied('Run the iOS simulator checks, budget 20 minutes.', 'general-purpose'));
  assert.equal(decide(brief('Wait up to 30 minutes for the emulator-build workflow.', 'ship-branch')), null);
  assert.equal(decide(brief('Build the slice; an emulator check is written, not run. Budget 10 minutes.', 'implement-slice')), null);
});

test('other agents: a device word and a duration in different sentences pass (review finding 1)', () => {
  const passes = [
    ['The emulator checks are written but not run. Wait up to 20 minutes for CI.', 'implement-slice'],
    ['Do not touch the VM. The build takes 15 minutes total.', 'ship-branch'],
    ['Wait up to 30 minutes for checks.\nThe slice touches the emulator harness.', 'update-docs'],
  ];
  for (const [prompt, type] of passes) assert.equal(decide(brief(prompt, type)), null, prompt);
});

test('other agents: "total" and "within" count only next to a device word; device-test ignores "total" (findings 2, 3)', () => {
  assert.equal(decide(brief('The build takes 15 minutes total.', 'ship-branch')), null);
  assert.equal(decide(brief('The build takes 15 minutes total.')), null);
  assert.equal(decide(brief('The fix is in the rtst-desktop-test VM, budget 60 minutes.', 'general-purpose'))?.hookSpecificOutput.permissionDecision, 'deny');
});

test('a CI wait split off by a semicolon passes even beside a negated device word', () => {
  const prompt = 'gh pr checks --watch, max wait 15 minutes; a Hyper-V run is not part of this.';
  assert.equal(decide(brief(prompt, 'ship-branch')), null);
});

test('CLI: deny on stdout, pass is silent, bad JSON fails open', () => {
  const run = (input) => spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8' });
  const deny = run(JSON.stringify(brief('Budget 45 minutes.')));
  assert.equal(deny.status, 0);
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const pass = run(JSON.stringify(brief('Budget 10 minutes.')));
  assert.equal(pass.status, 0);
  assert.equal(pass.stdout, '');
  const bad = run('not json');
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
});

test('any-agent mode lets a CI wait after a semicolon and a polling interval through', () => {
  assert.equal(decide(brief('Build the Android app and run the emulator checks; CI wait up to 30 minutes for the workflow.', 'general-purpose')), null);
  assert.equal(decide(brief('Poll the phone log every 15 min and wait for the run to finish.', 'general-purpose')), null);
  assert.equal(decide(brief('Run the emulator checks; test on the phone, budget 30 minutes.', 'general-purpose'))?.hookSpecificOutput.permissionDecision, 'deny');
});

test('overCap names every over-cap duration it found', () => {
  assert.deepEqual(overCap('Budget 40 minutes. Wait up to 20 min for the lock.'), ['40 minutes', '20 min']);
});
