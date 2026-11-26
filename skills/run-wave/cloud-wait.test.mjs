// node --test skills/run-wave/cloud-wait.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, parseLastLine, judgeRun, readRunFile, EXIT_DONE, EXIT_FAILED, EXIT_CANCELLED, EXIT_SUPERSEDED, EXIT_USAGE, EXIT_CHECKS_FAILING } from './cloud-wait.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BRANCH = 'feat/s07-x';
const DONE = `CLOUD DONE ${SHA} pushed=yes`;

// A scripted world: runs[i] is what the run file holds on poll i (the last one repeats), heads likewise for the branch head.
function world({ runs = [], heads = [SHA], states = ['OPEN'], checks = [{ status: 0, stdout: '', stderr: '' }], minutesPerSleep = 1, ancestor = false, viewFails = 0, viewError = 'HTTP 401', checksJson = [{ name: 'build', bucket: 'pass' }], gitError = null, fetchOnlyError = null } = {}) {
  const checkList = Array.isArray(checks) ? checks : [checks];
  const jsonList = Array.isArray(checksJson) && Array.isArray(checksJson[0]) ? checksJson : [checksJson];
  let checkPolls = 0;
  let jsonPolls = 0;
  const ghCwds = [];
  let t = 0;
  let runPolls = 0;
  let headPolls = 0;
  let statePolls = 0;
  const lines = [];
  const calls = [];
  const pick = (list, n) => list[Math.min(n, list.length - 1)];
  const deps = {
    out: (l) => lines.push(l),
    now: () => new Date(t),
    sleep: async () => { t += minutesPerSleep * 60000; },
    readRunFile: () => pick(runs, runPolls++) ?? null,
    git: (_repo, args) => {
      calls.push(args.join(' '));
      if (gitError && (args[0] === 'ls-remote' || args[0] === 'fetch')) throw new Error(gitError);
      if (fetchOnlyError && args[0] === 'fetch') throw new Error(fetchOnlyError);
      if (args[0] === 'fetch') return '';
      if (args[0] === 'merge-base') { if (!ancestor) throw new Error('not an ancestor'); return ''; }
      return `${pick(heads, headPolls++)}\trefs/heads/${BRANCH}`;
    },
    gh: (args, options = {}) => {
      calls.push(`gh ${args.join(' ')}`);
      ghCwds.push(options.cwd);
      if (args[1] === 'view' && statePolls < viewFails) { statePolls++; return { status: 1, stdout: '', stderr: viewError }; }
      if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ state: pick(states, statePolls++), headRefName: BRANCH }), stderr: '' };
      if (args.includes('--json')) return { status: 0, stdout: JSON.stringify(pick(jsonList, jsonPolls++)), stderr: '' };
      return pick(checkList, checkPolls++);
    },
  };
  return { deps, lines, calls, ghCwds };
}

const args = (extra = []) => ['268', '--run-file', 'run.json', '--poll-seconds', '1', ...extra];

test('parseLastLine knows the three forms and nothing else', () => {
  assert.deepEqual(parseLastLine(DONE), { kind: 'done', sha: SHA, checksFailing: false, detail: '' });
  const failing = parseLastLine(`CLOUD DONE ${SHA} pushed=yes checks=failing lint fails`);
  assert.equal(failing.checksFailing, true);
  assert.equal(failing.detail, 'lint fails');
  assert.deepEqual(parseLastLine('CLOUD BLOCKED needs file x'), { kind: 'blocked', detail: 'needs file x' });
  assert.equal(parseLastLine('working on it').kind, 'none');
  assert.equal(parseLastLine(undefined).kind, 'none');
});

test('judgeRun: still running, ended without a line, failed status', () => {
  assert.equal(judgeRun(null), null);
  assert.equal(judgeRun({ status: 'running', lastLine: 'compiling' }), null);
  assert.match(judgeRun({ status: 'completed', lastLine: 'bye' }).why, /no CLOUD DONE/);
  assert.match(judgeRun({ status: 'failed', lastLine: '' }).why, /run status failed/);
});

test('readRunFile: missing, malformed and good files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-wait-'));
  try {
    assert.equal(readRunFile(join(dir, 'none.json')), null);
    writeFileSync(join(dir, 'bad.json'), '{oops');
    assert.equal(readRunFile(join(dir, 'bad.json')), null);
    writeFileSync(join(dir, 'ok.json'), JSON.stringify({ status: 'running', lastLine: 'x' }));
    assert.equal(readRunFile(join(dir, 'ok.json')).status, 'running');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('done: run says done, branch head matches, checks green', async () => {
  const w = world({ runs: [null, { status: 'running', lastLine: 'x' }, { status: 'completed', lastLine: DONE }] });
  assert.equal(await run(args(), w.deps), EXIT_DONE);
  assert.equal(w.lines.at(-1), 'done');
  assert.ok(w.calls.includes('gh pr checks 268 --watch --fail-fast'));
});

test('a head that is neither the done sha nor descended from it is failed, not polled to the limit', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: DONE }], heads: [OTHER], ancestor: false });
  assert.equal(await run(args(), w.deps), EXIT_FAILED);
  assert.equal(w.lines.at(-1), `failed head ${OTHER} is not the CLOUD DONE sha ${SHA}`);
});

test('a branch not on origin yet is waited for', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: DONE }], heads: ['', SHA] });
  assert.equal(await run(args(), w.deps), EXIT_DONE);
});

test('git failures in a row end the wait naming git', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: DONE }], gitError: 'fatal: unable to access origin' });
  assert.equal(await run(args(), w.deps), EXIT_FAILED);
  assert.match(w.lines.at(-1), /^failed git failed 5 times in a row: fatal: unable to access origin/);
});

test('a failing fetch counts on its own while ls-remote keeps succeeding', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: DONE }], heads: [OTHER], fetchOnlyError: 'fatal: fetch broke' });
  assert.equal(await run(args(), w.deps), EXIT_FAILED);
  assert.match(w.lines.at(-1), /^failed git failed 5 times in a row: fatal: fetch broke/);
});

test('gh runs in the --repo directory', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: DONE }] });
  assert.equal(await run(args(['--repo', '/some/clone']), w.deps), EXIT_DONE);
  assert.ok(w.ghCwds.length > 0 && w.ghCwds.every((c) => c === '/some/clone'));
});

test('a merged PR is superseded, not cancelled', async () => {
  const w = world({ runs: [{ status: 'running', lastLine: 'x' }], states: ['OPEN', 'MERGED'] });
  assert.equal(await run(args(), w.deps), EXIT_SUPERSEDED);
  assert.equal(w.lines.at(-1), 'superseded PR merged');
});

test('CLOUD BLOCKED is failed and never runs the checks', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: 'CLOUD BLOCKED needs docs/x.md' }] });
  assert.equal(await run(args(), w.deps), EXIT_FAILED);
  assert.equal(w.lines.at(-1), 'failed CLOUD BLOCKED needs docs/x.md');
  assert.ok(!w.calls.some((c) => c.includes('checks')));
});

test('checks=failing variant is failed with its reason', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: `${DONE} checks=failing tests red` }] });
  assert.equal(await run(args(), w.deps), EXIT_CHECKS_FAILING);
  assert.equal(w.lines.at(-1), `checks-failing ${SHA} tests red`);
});

test('a run that ends with nothing pushed is failed', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: 'finished' }] });
  assert.equal(await run(args(), w.deps), EXIT_FAILED);
  assert.match(w.lines.at(-1), /^failed run ended with no CLOUD DONE/);
});

test('red checks are pushed with checks failing, never a rebuild', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: DONE }], checks: { status: 1, stdout: '', stderr: '' }, checksJson: [{ name: 'ci / fail-fast  build', bucket: 'fail' }, { name: 'tests', bucket: 'pass' }] });
  assert.equal(await run(args(), w.deps), EXIT_CHECKS_FAILING);
  assert.equal(w.lines.at(-1), `checks-failing ${SHA} checks are red ci / fail-fast  build`);
  assert.ok(w.calls.includes('gh pr checks 268 --json name,bucket'));
});

test('a cancelled check is red, a check merely named fail is not', async () => {
  const cancelled = world({ runs: [{ status: 'completed', lastLine: DONE }], checks: { status: 1, stdout: '', stderr: '' }, checksJson: [{ name: 'lint', bucket: 'cancel' }] });
  assert.equal(await run(args(), cancelled.deps), EXIT_CHECKS_FAILING);
  const named = world({ runs: [{ status: 'completed', lastLine: DONE }], checksJson: [{ name: 'fail', bucket: 'pass' }, { name: 'x', bucket: 'skipping' }] });
  assert.equal(await run(args(), named.deps), EXIT_DONE);
});

test('a gh failure while watching the checks is failed and names gh, not red checks', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: DONE }], checks: { status: 1, stdout: '', stderr: 'error connecting to api.github.com' } });
  assert.equal(await run(args(), w.deps), EXIT_FAILED);
  assert.equal(w.lines.at(-1), 'failed gh pr checks failed: error connecting to api.github.com');
});

const NO_CHECKS = { status: 1, stdout: '', stderr: 'no checks reported on the branch' };

test('a PR with no checks at all counts as green only after the grace window', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: DONE }], checks: [NO_CHECKS] });
  assert.equal(await run(args(), w.deps), EXIT_DONE);
  const watches = w.calls.filter((c) => c.startsWith('gh pr checks')).length;
  assert.ok(watches >= 3, `re-polled during the grace window (${watches} watches)`);
});

test('the grace window is a parameter', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: DONE }], checks: [NO_CHECKS] });
  assert.equal(await run(args(['--no-checks-grace-minutes', '10']), w.deps), EXIT_DONE);
  assert.ok(w.calls.filter((c) => c.startsWith('gh pr checks')).length >= 10);
});

test('checks that register inside the grace window are judged, not skipped', async () => {
  const red = { status: 1, stdout: '', stderr: '' };
  const w = world({ runs: [{ status: 'completed', lastLine: DONE }], checks: [NO_CHECKS, NO_CHECKS, red], checksJson: [{ name: 'build', bucket: 'fail' }] });
  assert.equal(await run(args(), w.deps), EXIT_CHECKS_FAILING);
});

test('the PR number is the first positional, not a numeric option value', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: DONE }] });
  assert.equal(await run(['--max-minutes', '120', '268', '--run-file', 'r.json', '--poll-seconds', '1'], w.deps), EXIT_DONE);
  assert.ok(w.calls.includes('gh pr view 268 --json state,headRefName'));
});

test('head ahead of the done sha, with the done sha an ancestor, is superseded before any wait', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: DONE }], heads: [OTHER], ancestor: true });
  assert.equal(await run(args(), w.deps), EXIT_SUPERSEDED);
  assert.ok(w.calls.some((c) => c.startsWith('merge-base --is-ancestor')));
});

test('repeated gh pr view failures name gh as the cause', async () => {
  const w = world({ runs: [null], viewFails: 100, viewError: 'HTTP 401: bad credentials' });
  assert.equal(await run(args(), w.deps), EXIT_FAILED);
  assert.match(w.lines.at(-1), /^failed gh pr view failed 5 times in a row: HTTP 401: bad credentials/);
});

test('one gh pr view failure is survived, and a closed PR is still cancelled', async () => {
  const w = world({ runs: [{ status: 'running', lastLine: 'x' }], viewFails: 1, states: ['CLOSED'] });
  assert.equal(await run(args(), w.deps), EXIT_CANCELLED);
});

test('the time limit names gh when gh was failing', async () => {
  const w = world({ runs: [null], viewFails: 3, states: ['OPEN'], minutesPerSleep: 20 });
  assert.equal(await run(args(['--max-minutes', '30']), w.deps), EXIT_FAILED);
  assert.match(w.lines.at(-1), /gh pr view was failing/);
});

test('PR closed while waiting is cancelled', async () => {
  const w = world({ runs: [{ status: 'running', lastLine: 'x' }], states: ['OPEN', 'CLOSED'] });
  assert.equal(await run(args(), w.deps), EXIT_CANCELLED);
  assert.equal(w.lines.at(-1), 'cancelled');
});

test('PR closed during the checks is cancelled', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: DONE }], states: ['OPEN', 'OPEN', 'CLOSED'] });
  assert.equal(await run(args(), w.deps), EXIT_CANCELLED);
});

test('new pushes after done are superseded', async () => {
  const w = world({ runs: [{ status: 'completed', lastLine: DONE }], heads: [SHA, SHA, OTHER] });
  assert.equal(await run(args(), w.deps), EXIT_SUPERSEDED);
  assert.equal(w.lines.at(-1), 'superseded');
});

test('the time limit ends in failed when nothing shows up', async () => {
  const w = world({ runs: [null], minutesPerSleep: 10 });
  assert.equal(await run(args(['--max-minutes', '30']), w.deps), EXIT_FAILED);
  assert.match(w.lines.at(-1), /^failed no result after 30 minutes/);
});

test('usage errors exit 4 and print usage', async () => {
  const w = world();
  assert.equal(await run(['--run-file', 'r.json'], w.deps), EXIT_USAGE);
  assert.equal(await run(['268'], w.deps), EXIT_USAGE);
  assert.equal(await run(args(['--max-minutes', 'x']), w.deps), EXIT_USAGE);
  assert.match(w.lines[0], /^usage:/);
});
