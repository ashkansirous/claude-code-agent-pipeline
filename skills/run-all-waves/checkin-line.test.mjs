// node --test skills/run-all-waves/checkin-line.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, buildLine, checkUserStep, checkYouLine, clockTime, parseCli } from './checkin-line.mjs';

const SCRIPT = fileURLToPath(new URL('./checkin-line.mjs', import.meta.url));
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function night(status = { current: 'wave-1', remaining: ['16', '17'], stopReason: null, sessions: [{ label: 'wave-1', endedAt: null }] }) {
  const dir = mkdtempSync(join(tmpdir(), 'checkin-'));
  dirs.push(dir);
  const folder = join(dir, '2026-11-17-1526');
  mkdirSync(folder);
  if (status) writeFileSync(join(folder, 'status.json'), JSON.stringify(status));
  return folder;
}

const ask = (folder, ...questions) => buildLine(parseCli(['--night', folder, ...questions.flatMap((q) => ['--question', q])]));
const QUESTION = 'Restart both runs hidden, or leave them?';

test('the line is built from the night folder status', () => {
  const { line, refusals } = ask(night());
  assert.match(line, /^Time \d\d:\d\d \| 2026-11-17-1526: wave-1, 1 session\(s\) running; 2 slice\(s\) still planned \(16, 17\); no stop reason$/);
  assert.deepEqual(refusals, []);
});

test('the same question is printed twice and refused the third time with "record a default instead"', () => {
  const folder = night();
  assert.match(ask(folder, QUESTION).line, /Question: Restart both/);
  assert.match(ask(folder, QUESTION.toUpperCase()).line, /Question: /); // the same text in other case is the same question
  const third = ask(folder, QUESTION);
  assert.ok(!third.line.includes('Question:'));
  assert.match(third.refusals[0], /record a default instead/);
});

test('a question the user replied to is not printed until an answer is recorded', () => {
  const folder = night();
  ask(folder, QUESTION);
  const replied = buildLine(parseCli(['--night', folder, '--user-replied', QUESTION, '--question', QUESTION]));
  assert.ok(!replied.line.includes('Question:'));
  assert.match(replied.refusals[0], /user replied/);
  const recorded = buildLine(parseCli(['--night', folder, '--record-answer', QUESTION, '--answer', 'leave them', '--question', QUESTION]));
  assert.ok(!recorded.line.includes('Question:'));
  assert.match(recorded.refusals[0], /already answered \("leave them"\)/);
});

test('a step for the user without a "tried:" field is refused, one with it is printed', () => {
  assert.notEqual(checkUserStep('Create the deploy hook'), '');
  assert.notEqual(checkUserStep('Create the deploy hook tried:'), '');
  assert.equal(checkUserStep('Create the deploy hook, tried: Cloudflare API with the token from the secrets store: the token cannot create hooks'), '');
  const folder = night();
  const result = buildLine(parseCli(['--night', folder, '--user-step', 'Create the deploy hook', '--user-step', 'Allow Chrome. tried: API, no token scope']));
  assert.ok(!result.line.includes('Your step: Create the deploy hook |'));
  assert.match(result.line, /Your step: Allow Chrome/);
  assert.equal(result.refusals.length, 1);
});

test('--merge-check adds the merge-gate verdict', () => {
  const result = buildLine(parseCli(['--night', night(), '--merge-check', tmpdir()]), () => 'denied: a batch release is open');
  assert.match(result.line, /Merge without the skip marker: denied: a batch release is open/);
});

test('a missing status.json still gives a line, and the CLI exits 1 on a refusal and 2 on a usage error', () => {
  const folder = night(null);
  assert.match(ask(folder).line, /no status\.json yet/);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--night', folder, ...args], { encoding: 'utf8' });
  assert.equal(run('--user-step', 'x').status, EXIT.refused);
  assert.equal(run('--user-step', 'x tried: api, no scope').status, EXIT.ok);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--bogus', 'x'], { encoding: 'utf8' }).status, EXIT.usage);
});

test('a missing night folder still prints the line, and a text with no words is refused', () => {
  const folder = join(night(), 'not-yet');
  const result = ask(folder, QUESTION, '???');
  assert.match(result.line, /Question: Restart both/);
  assert.match(result.refusals[0], /no words or digits/);
});

test('--reset-question lets a recorded question be asked anew', () => {
  const folder = night();
  buildLine(parseCli(['--night', folder, '--record-answer', QUESTION, '--answer', 'leave them']));
  assert.ok(ask(folder, QUESTION).refusals.length);
  assert.match(buildLine(parseCli(['--night', folder, '--reset-question', QUESTION, '--question', QUESTION])).line, /Question: Restart both/);
});

test('a merge check that throws still prints the line and saves the question counters', () => {
  const folder = night();
  const options = parseCli(['--night', folder, '--question', QUESTION]);
  options.mergeCheck = folder;
  const { line } = buildLine(options, () => { throw new Error('not a git repository'); });
  assert.match(line, /Merge without the skip marker: merge check unavailable/);
  assert.match(line, /Question: Restart both/);
  assert.match(ask(folder, QUESTION).line, /Question: /); // the first call saved printed=1, so this is the second print
  assert.ok(!ask(folder, QUESTION).line.includes('Question:')); // and this the third, refused
});

test('Slice 18: a final report You: line with no URL is refused, one with its link is printed', () => {
  assert.notEqual(checkYouLine('Waiting on you: the text and link are in my message above'), '');
  assert.equal(checkYouLine('Approve the store listing: https://example.com/console/listing'), '');
  const folder = night();
  const bad = buildLine(parseCli(['--night', folder, '--you-line', 'Waiting on you: see my message above']));
  assert.equal(bad.refusals.length, 1);
  assert.doesNotMatch(bad.line, /You:/);
  const good = buildLine(parseCli(['--night', folder, '--you-line', 'Approve it: https://example.com/x']));
  assert.deepEqual(good.refusals, []);
  assert.match(good.line, /You: Approve it: https:\/\/example\.com\/x/);
});

test('Slice 22: the line prints the real clock time it was built at', () => {
  assert.equal(clockTime(new Date(2026, 10, 17, 14, 7)), '14:07');
  const { line } = buildLine(parseCli(['--night', night()]), () => '', new Date(2026, 10, 17, 16, 29));
  assert.match(line, /^Time 16:29 \| /);
});

test('Slice 22: a You: line with a <placeholder> or a bare domain is refused; a public repo keeps its placeholder', () => {
  assert.notEqual(checkYouLine('Open <board address>/#/setup'), '');
  assert.notEqual(checkYouLine('Open https://claude.ai'), '');
  assert.notEqual(checkYouLine('Open https://claude.ai/ now'), '');
  assert.equal(checkYouLine('Open <board address>/#/setup', true), '');
  assert.equal(checkYouLine('Open https://claude.ai/settings/connectors'), '');
  assert.notEqual(checkYouLine('Open <board address>', true), '');
  assert.notEqual(checkYouLine('Link in my message above <link>', true), '');
  assert.equal(checkYouLine('Press <Save> at <https://console.cloud.google.com/x>'), '');
  assert.equal(checkYouLine('Press <Enter> on https://claude.ai/settings'), '');
  assert.equal(checkYouLine('Open https://claude.ai?x=1'), '');
  assert.equal(checkYouLine('Press <Save> at https://console.cloud.google.com/x', true), '');
  assert.equal(checkYouLine('Open https://claude.ai/x and <board address>/y', true), '');
  assert.equal(checkYouLine('The link in my message above https://claude.ai/x'), ''); // a page URL present: wording never refuses (#1)
  assert.equal(checkYouLine('Open https://console.cloud.google.com/x and check the URL before you press Save'), '');
  assert.notEqual(checkYouLine('Open https://claude.ai, then press Save'), ''); // trailing punctuation stripped: still bare (#2)
  assert.notEqual(checkYouLine('Open https://claude.ai.'), '');
  assert.notEqual(checkYouLine('Open https://<host>/setup'), ''); // placeholder host in a URL: unresolved in a private repo (#3)
  assert.equal(checkYouLine('Open https://<host>/setup', true), '');
  assert.notEqual(checkYouLine('Press <Save>/<Cancel>', true), ''); // no space in the token: not a placeholder link (#4)
  assert.notEqual(checkYouLine('Open <host>/x'), '');
  const refused = buildLine(parseCli(['--night', night(), '--you-line', 'Open <board address>/#/setup']), () => '');
  assert.equal(refused.refusals.length, 1);
  const allowed = buildLine(parseCli(['--night', night(), '--public-repo', 'yes', '--you-line', 'Open <board address>/#/setup']), () => '');
  assert.deepEqual(allowed.refusals, []);
  for (const value of ['true', '1', 'YES']) assert.equal(parseCli(['--night', night(), '--public-repo', value]).publicRepo, true); // (#6)
  assert.equal(parseCli(['--night', night(), '--public-repo', 'no']).publicRepo, false);
});
