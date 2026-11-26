import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(HERE, 'run-all-waves.ps1');
const PLANNED_PLAN = '# Plan\n\n| # | Slice | Status |\n| --- | --- | --- |\n| 1 | One | planned |\n| 2 | Two | planned |\n';
const DRIVER_RUN_TIMEOUT_MS = 240000;
const TABLELESS_PLAN ='# Plan\n\nNo table here.\n';

// The fake claude: records every prompt; MODE=merge makes housekeeping mark the rows built and push;
// MODE=hang-first makes the first session sleep so the watchdog has to kill it; MODE=child-first makes it
// wait on a live child process (not a timer) that outlasts the idle limit; MODE=hk-fail makes housekeeping exit 1.
const FAKE_CLAUDE = `
import { appendFileSync, existsSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const prompt = process.argv[process.argv.indexOf('-p') + 1];
const calls = process.env.FAKE_CALLS;
const first = !existsSync(calls);
appendFileSync(calls, prompt + '\\n');
if (process.env.FAKE_LEDGER && !process.env.FAKE_LEDGER_REASON && first && prompt.startsWith('/run-all-waves wave')) appendFileSync(process.env.FAKE_LEDGER, '\\n## Wave 2 (closed)\\n- Slice 1 x stage: cloud running s1 link worker 1\\n');
if (process.env.FAKE_LEDGER && process.env.FAKE_LEDGER_REASON && first && prompt.startsWith('/run-all-waves wave')) appendFileSync(process.env.FAKE_LEDGER, '\\n## Wave 2 (closed)\\n- Slice 1 x local: cloud: not used, no RemoteTrigger\\n');
if (process.env.FAKE_LEDGER && process.env.FAKE_LEDGER_REWRITE && prompt.startsWith('/run-all-waves wave 2')) writeFileSync(process.env.FAKE_LEDGER, readFileSync(process.env.FAKE_LEDGER, 'utf8').replace('stage: cloud running s1 link worker 1', 'stage: merged'));
if (process.env.FAKE_MODE === 'hang-first' && first) await new Promise((r) => setTimeout(r, 60000));
if (process.env.FAKE_MODE === 'child-first' && first) spawnSync('node', ['-e', 'setTimeout(() => {}, 6000)']);
if (process.env.FAKE_MODE === 'hk-fail' && prompt.startsWith('/run-all-waves housekeeping')) process.exit(1);
if (process.env.FAKE_MODE === 'fl-slow' && prompt.startsWith('/feedback-loop')) await new Promise((r) => setTimeout(r, 60000));
if (process.env.FAKE_MODE === 'fl-fail' && prompt.startsWith('/feedback-loop')) process.exit(1);
if (process.env.FAKE_MODE === 'wave-fail' && prompt.startsWith('/run-all-waves wave')) process.exit(1);
if (process.env.FAKE_MODE === 'pc-fail'&& prompt.startsWith('/plan-cleanup')) process.exit(1);
if (process.env.FAKE_MODE === 'live-fail' && prompt.startsWith('Live checks')) process.exit(1);
if (process.env.FAKE_MODE === 'merge' && prompt.startsWith('/run-all-waves housekeeping')) {
  const clone = mkdtempSync(join(tmpdir(), 'fake-clone-'));
  const git = (...a) => execFileSync('git', a, { cwd: clone, stdio: 'pipe' });
  execFileSync('git', ['clone', '-q', process.env.FAKE_ORIGIN, clone]);
  writeFileSync(join(clone, 'plan.md'), readFileSync(join(clone, 'plan.md'), 'utf8').replaceAll('planned', 'built'));
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'built');
  git('push', '-q', 'origin', 'main');
}
console.log('ok');
`;

// The fake batch-release.mjs: records "<command> <args>" lines in FAKE_BATCH_CALLS. FAKE_DUE=yes makes `due` exit 0;
// FAKE_RELEASE=nothing prints a not-released line; FAKE_WATCH=failure makes `watch` report a failure and exit 1;
// FAKE_BATCH=throw makes every call exit 5 with no output.
const FAKE_BATCH = `
import { appendFileSync } from 'node:fs';
const [command, repo, ...rest] = process.argv.slice(2);
appendFileSync(process.env.FAKE_BATCH_CALLS, [command, ...rest].join(' ') + '\\n');
if (process.env.FAKE_BATCH === 'throw') process.exit(5);
if (command === 'due') process.exit(process.env.FAKE_DUE === 'yes' ? 0 : 1);
if (command === 'release') console.log(process.env.FAKE_RELEASE === 'nothing' ? '{"released":false,"reason":"nothing merged"}' : '{"released":true,"runs":[{"workflow":"release.yml","runId":"9"}]}');
if (command === 'watch') {
  const failed = process.env.FAKE_WATCH === 'failure';
  console.log('release.yml run 9: conclusion ' + (failed ? 'failure' : 'success'));
  process.exit(failed ? 1 : 0);
}
`;

// The fake placement.mjs: CLOUDY in the slice file means cloud, BROKEN means a failing script.
const FAKE_PLACEMENT = `
import { readFileSync, writeFileSync } from 'node:fs';
const text = readFileSync(process.argv[2], 'utf8');
if (process.env.FAKE_PLACEMENT_MARK) writeFileSync(process.env.FAKE_PLACEMENT_MARK, 'ran');
if (text.includes('BROKEN')) process.exit(3);
console.log(text.includes('CLOUDY') ? 'cloud: big' : 'local: small');
`;

// Slice 30 item B: each test builds its own repo and night folder under `base` (names are unique per test), so the tests
// run 4 at a time; the suite wraps the rest of the file without re-indenting it.
describe('run-all-waves', { concurrency: 4 }, () => {
let base;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'raw-test-'));
  writeFileSync(join(base, 'fake-batch-release.mjs'), FAKE_BATCH);
  writeFileSync(join(base, 'fake-claude.mjs'), FAKE_CLAUDE);
  writeFileSync(join(base, 'fake-placement.mjs'), FAKE_PLACEMENT);
  writeFileSync(join(base, 'claude.cmd'), '@echo off\r\nnode "%~dp0fake-claude.mjs" %*\r\n');
  // Fake gh (a .ps1: cmd.exe would read the ">" in the --search value as a redirect): prints the file named
  // by FAKE_GH_JSON once (then []) when it is set, else [].
  writeFileSync(join(base, 'gh.ps1'), [
    "if (-not $env:FAKE_GH_JSON -or (Test-Path $env:FAKE_GH_MARK)) { '[]'; exit 0 }",
    "Get-Content $env:FAKE_GH_JSON -Raw; Set-Content $env:FAKE_GH_MARK x; exit 0", ''].join('\n'));
});

after(() => rmSync(base, { recursive: true, force: true }));

// Slice 09 item 4: every test here is synchronous (runDriver uses spawnSync), so node:test never returned to the
// event loop between tests and printed nothing until the whole file ended (about 6.5 minutes on Windows, 2026-11-15).
// Yielding after each test lets the reporter write that test's line as soon as it finishes.
afterEach(() => new Promise((resolve) => setImmediate(resolve)));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' });
}

// A repo with a bare origin whose main holds the given plan.md.
function makeRepo(name, plan) {
  const origin = join(base, `${name}-origin.git`);
  const repo = join(base, name);
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'plan.md'), plan);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'plan');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  return { repo, origin, runDir: join(base, `${name}-worktrees`, 'run-all-waves') };
}

// Every driver run cleans a fake temp folder of its own, never the machine's real one.
function fakeTempDir(setup) {
  const dir = join(base, `${setup.repo.split(/[\\/]/).pop()}-temp`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Slice 30 item B: spawnSync blocked the event loop, so tests could not run side by side. Same result shape as spawnSync's
// ({ status, stdout, stderr, error }); a run past `timeout` is killed and reports an error.
function spawnAsync(command, args, { env, timeout }) {
  return new Promise((done) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let error;
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { error = new Error(`timed out after ${timeout} ms`); child.kill('SIGKILL'); }, timeout);
    child.on('error', (e) => { error = e; });
    child.on('close', (status) => { clearTimeout(timer); done({ status, stdout, stderr, error }); });
  });
}

// Only the modes whose session goes idle on purpose need a 1 s watchdog; with four drivers at once a starved fake `claude`
// start-up would look idle to a 1 s watchdog and be killed (Slice 30 review finding 6), so every other run waits longer.
function watchdogSeconds(mode) {
  return mode === 'hang-first' || mode === 'child-first' ? '1' : '30';
}

async function runDriver(setup, mode, extraArgs = [], extraEnv = {}) {
  const calls = join(base, `${setup.repo.split(/[\\/]/).pop()}-calls.log`);
  const args = ['-NoProfile', '-File', DRIVER, '-Repo', setup.repo, '-ClaudeCommand', join(base, 'claude.cmd'),
    '-WatchdogSeconds', watchdogSeconds(mode), '-TempBuildsDir', fakeTempDir(setup),
    '-GhCommand', join(base, 'gh.ps1'), ...(extraArgs.includes('-FastFailureSeconds') ? [] : ['-FastFailureSeconds', '0']),
    '-BatchReleaseScript', join(base, 'fake-batch-release.mjs'), ...extraArgs];
  // Slice 23 item 9: a run that names no -ProjectsDir reads a fake, empty one, never the live sessions under ~/.claude/projects
  // (the starter-session wait read them, so a test passed or failed with whatever the machine was running).
  if (!extraArgs.includes('-ProjectsDir')) {
    const emptyProjects = join(base, `${setup.repo.split(/[\\/]/).pop()}-empty-projects`);
    mkdirSync(emptyProjects, { recursive: true });
    args.push('-ProjectsDir', emptyProjects);
  }
  const batchCalls = join(base, `${setup.repo.split(/[\\/]/).pop()}-batch.log`);
  const env = { ...process.env, FAKE_MODE: mode, FAKE_CALLS: calls, FAKE_ORIGIN: setup.origin, FAKE_BATCH_CALLS: batchCalls, ...extraEnv };
  // A per-run timeout: one fake-claude run once stalled ~12 minutes inside `node --test` (Slice 307's builder, 2026-11-07).
  // spawnSync blocks the event loop, so node:test's own timeout could not interrupt it; this kills pwsh and fails the test.
  const result = await spawnAsync('pwsh', args, { env, timeout: DRIVER_RUN_TIMEOUT_MS });
  if (result.error) assert.fail(`driver run did not finish within ${DRIVER_RUN_TIMEOUT_MS} ms: ${result.error.message}\n${result.stdout}`);
  const night = readdirSync(setup.runDir).filter((f) => /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(f)).sort().pop();
  const status = JSON.parse(readFileSync(join(setup.runDir, night, 'status.json'), 'utf8'));
  const allPrompts = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
  const batchLines = existsSync(batchCalls) ? readFileSync(batchCalls, 'utf8').trim().split('\n') : [];
  const batch = batchLines.map((l) => l.split(' ')[0]);
  // The end-of-night plan-cleanup session sits between the live checks and the feedback loop. Older assertions index
  // sessions and prompts without it, so `status`/`prompts` leave it out; `allStatus`/`allPrompts` keep it (the plan-cleanup tests).
  const prompts = allPrompts.filter((p) => !p.startsWith('/plan-cleanup'));
  const allStatus = status;
  const visible = { ...status, sessions: status.sessions.filter((s) => s.label !== 'plan-cleanup') };
  return { result, status: visible, allStatus, prompts, allPrompts, batch, batchLines };
}

test('no -Repo: exit 2 with a message, no night folder, even from inside a repo', async () => {
  const setup = makeRepo('norepo', PLANNED_PLAN);
  const result = spawnSync('pwsh', ['-NoProfile', '-File', DRIVER, '-ClaudeCommand', join(base, 'claude.cmd')],
    { cwd: setup.repo, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /pass -Repo <primary checkout>; refusing to default to the current folder/);
  assert.ok(!existsSync(setup.runDir));
});

test('-Repo is not a git repository: exit 2 with a message', async () => {
  const plain = join(base, 'not-a-repo');
  mkdirSync(plain, { recursive: true });
  const result = spawnSync('pwsh', ['-NoProfile', '-File', DRIVER, '-Repo', plain, '-ClaudeCommand', join(base, 'claude.cmd')],
    { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /-Repo is not a git repository/);
});

test('-Repo is a linked worktree: exit 2 with a message, no night folder', async () => {
  const setup = makeRepo('linked', PLANNED_PLAN);
  const linked = join(base, 'linked-wt');
  git(setup.repo, 'worktree', 'add', '-q', '-b', 'feat/x', linked);
  const result = spawnSync('pwsh', ['-NoProfile', '-File', DRIVER, '-Repo', linked, '-ClaudeCommand', join(base, 'claude.cmd')],
    { cwd: setup.repo, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /-Repo must be the primary checkout, not a linked worktree/);
  assert.ok(!existsSync(setup.runDir));
  assert.ok(!existsSync(join(base, 'linked-wt-worktrees')));
});

test('nothing changes: stops after 2 rounds with 5 sessions and no lock left', async () => {
  const setup = makeRepo('stalled', PLANNED_PLAN);
  const { status } = await runDriver(setup, 'none');
  assert.match(status.stopReason, /^no progress in 2 rounds/);
  assert.equal(status.sessions.length, 5);
  assert.ok(!existsSync(join(setup.runDir, 'run-all-waves.lock')));
});

// The cleanup treats a file as young by its birth time too, so a test file must be backdated on both clocks.
function backdateBirthTime(path) {
  const script = '[IO.File]::SetCreationTime($env:BACKDATE_PATH, (Get-Date).AddHours(-3))';
  execFileSync('pwsh', ['-NoProfile', '-Command', script], { env: { ...process.env, BACKDATE_PATH: path } });
}

test('on the way out the driver deletes old builds from its temp folder and keeps young ones; status.json says so', async () => {
  const setup = makeRepo('temp-clean', TABLELESS_PLAN);
  const temp = fakeTempDir(setup);
  const old = join(temp, 'tmp1.apk');
  const young = join(temp, 'tmp2.apk');
  const other = join(temp, 'keep.txt');
  for (const f of [old, young, other]) writeFileSync(f, 'x');
  const threeHoursAgo = (Date.now() - 3 * 3_600_000) / 1000;
  for (const f of [old, other]) { utimesSync(f, threeHoursAgo, threeHoursAgo); backdateBirthTime(f); }
  const { status } = await runDriver(setup, 'none');
  assert.ok(!existsSync(old));
  assert.ok(existsSync(young) && existsSync(other));
  assert.equal(status.tempCleanup.deleted, 1);
  assert.equal(status.tempCleanup.exitCode, 0);
});

test('an old build is deleted after each wave, and status.json keeps the per-wave result', async () => {
  const setup = makeRepo('temp-clean-wave', PLANNED_PLAN);
  const old = join(fakeTempDir(setup), 'tmp3.apk');
  writeFileSync(old, 'x');
  const threeHoursAgo = (Date.now() - 3 * 3_600_000) / 1000;
  utimesSync(old, threeHoursAgo, threeHoursAgo);
  backdateBirthTime(old);
  const { status } = await runDriver(setup, 'merge');
  assert.ok(!existsSync(old));
  assert.equal(status.tempCleanupWaves.length, 1);
  assert.equal(status.tempCleanupWaves[0].deleted, 1);
});

test('a failed final loop leaves audited empty, so the next night carries the sessions', async () => {
  const setup = makeRepo('fl-failed', PLANNED_PLAN);
  const { status } = await runDriver(setup, 'fl-fail');
  assert.equal(status.sessions.at(-1).label, 'feedback-loop');
  assert.notEqual(status.sessions.at(-1).exitCode, 0);
  assert.deepEqual(status.audited, []);
});

test('the final loop prompt parks product findings and names the night note and branch', async () => {
  const setup = makeRepo('fl-prompt', TABLELESS_PLAN);
  const { prompts, status } = await runDriver(setup, 'none');
  const night = basename(status.night);
  assert.match(prompts[0], /product finding becomes a slice with status `planned`/);
  assert.match(prompts[0], /never parked for a review the owner did not ask for/);
  assert.doesNotMatch(prompts[0], /parked: feedback loop, waits for the user/);
  assert.match(prompts[0], /park reason contains the words `interactive session`/);
  assert.match(prompts[0], /a reason that only names the user still goes back/);
  assert.ok(prompts[0].includes(`docs/plan/notes/${night}-feedback-loop.md`), prompts[0]);
  assert.ok(prompts[0].includes(`chore/feedback-loop-${night}`), prompts[0]);
});

test('no -PermissionMode writes a warning to status.json and the top of each session log', async () => {
  const setup = makeRepo('nomode', PLANNED_PLAN);
  const { status } = await runDriver(setup, 'merge');
  assert.match(status.warning, /no -PermissionMode/);
  const log = readFileSync(status.sessions[0].log, 'utf8');
  assert.match(log.split('\n')[0], /no -PermissionMode/);
});

test('-PermissionMode given: no warning', async () => {
  const setup = makeRepo('withmode', PLANNED_PLAN);
  const { status } = await runDriver(setup, 'merge', ['-PermissionMode', 'auto']);
  assert.equal(status.warning, null);
});

test('merged docs-index, plan-cleanup and feedback-loop PRs are not progress', async () => {
  const setup = makeRepo('housekeeping-prs', PLANNED_PLAN);
  const json = join(base, 'hk-prs.json');
  writeFileSync(json, '[{"number":1,"headRefName":"chore/docs-index-x-w1"},{"number":2,"headRefName":"chore/feedback-loop-x"},{"number":4,"headRefName":"chore/plan-cleanup-20261125-1019"}]');
  const { status } = await runDriver(setup, 'none', [], { FAKE_GH_JSON: json, FAKE_GH_MARK: join(base, 'hk-prs.mark') });
  assert.match(status.stopReason, /^no progress in 2 rounds/);
  assert.equal(status.sessions.length, 5);
});

test('a merged slice PR counts as progress', async () => {
  const setup = makeRepo('slice-pr', PLANNED_PLAN);
  const json = join(base, 'slice-pr.json');
  writeFileSync(json, '[{"number":3,"headRefName":"feat/slice-1"}]');
  const { status } = await runDriver(setup, 'none', [], { FAKE_GH_JSON: json, FAKE_GH_MARK: join(base, 'slice-pr.mark') });
  assert.match(status.stopReason, /^no progress in 2 rounds/);
  assert.equal(status.sessions.length, 7); // three rounds of wave and housekeeping, then the one feedback loop
});

test('a second launch while a live pwsh holds the lock fails', async () => {
  const setup = makeRepo('locked', PLANNED_PLAN);
  mkdirSync(setup.runDir, { recursive: true });
  const lock = join(setup.runDir, 'run-all-waves.lock');
  const script = `Set-Content '${lock}' $PID -NoNewline; & pwsh -NoProfile -File '${DRIVER}' -Repo '${setup.repo}' -TempBuildsDir '${fakeTempDir(setup)}' 2>&1`;
  const live = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  assert.match(live.stdout, /already running/);
});

test('a stale lock (dead pid) is replaced', async () => {
  const setup = makeRepo('stalelock', PLANNED_PLAN);
  mkdirSync(setup.runDir, { recursive: true });
  writeFileSync(join(setup.runDir, 'run-all-waves.lock'), '999999');
  const { status } = await runDriver(setup, 'merge');
  assert.equal(status.stopReason, 'no planned slices left');
});

test('housekeeping marking the rows built ends with "no planned slices left"', async () => {
  const setup = makeRepo('merged', PLANNED_PLAN);
  const { status } = await runDriver(setup, 'merge');
  assert.equal(status.stopReason, 'no planned slices left');
  assert.deepEqual(status.sessions.map((s) => s.label), ['wave-1', 'housekeeping-1', 'feedback-loop']);
});

test('one feedback loop at the end reads every wave and housekeeping session', async () => {
  const setup = makeRepo('oneloop', PLANNED_PLAN);
  const { status, prompts } = await runDriver(setup, 'merge');
  const [wave, hk] = status.sessions;
  assert.equal(prompts.length, 3);
  assert.match(prompts[2], /^\/feedback-loop .*end of all waves/);
  assert.ok(prompts[2].includes(`${wave.sessionId}, ${hk.sessionId}`));
  for (const prompt of [prompts[0], prompts[1]]) {
    assert.match(prompt, /carries the line `plan-not-needed: \d+` in its first draft/, prompt);
    assert.ok(prompt.includes('`plan-not-needed: 900, 901`'), prompt);
  }
  const SENTENCE = 'Also read the interactive session that started or restarted this run (find it with transcript-digest --list for the repo) and, before the note ships, re-read live state the note asserts (phone connection, host, PR states).';
  assert.ok(prompts[2].includes(SENTENCE));
  assert.equal(prompts[2].split('interactive session that started').length, 2);
  assert.match(prompts[2], /never ask.$/);
});

test('no feedback-loop session runs between rounds', async () => {
  const setup = makeRepo('noperround', PLANNED_PLAN);
  const { status, prompts } = await runDriver(setup, 'none');
  const labels = status.sessions.map((s) => s.label);
  assert.deepEqual(labels, ['wave-1', 'housekeeping-1', 'wave-2', 'housekeeping-2', 'feedback-loop']);
  assert.equal(prompts.filter((p) => p.startsWith('/feedback-loop')).length, 1);
  assert.ok(prompts[4].startsWith('/feedback-loop'));
  for (const id of status.sessions.slice(0, 4).map((s) => s.sessionId)) assert.ok(prompts[4].includes(id));
});

test('a stop file older than the run is ignored and removed', async () => {
  const setup = makeRepo('stale', PLANNED_PLAN);
  mkdirSync(setup.runDir, { recursive: true });
  const stop = join(setup.runDir, 'run-all-waves.stop');
  writeFileSync(stop, '');
  const past = new Date(Date.now() - 86400000);
  utimesSync(stop, past, past);
  const { status } = await runDriver(setup, 'merge');
  assert.equal(status.stopReason, 'no planned slices left');
  assert.ok(!existsSync(stop));
});

test('a plan with no status table stops the loop with the parser reason, then the feedback loop', async () => {
  const setup = makeRepo('tableless', TABLELESS_PLAN);
  const { status } = await runDriver(setup, 'none');
  assert.match(status.stopReason, /no recognised status table/);
  assert.deepEqual(status.sessions.map((s) => s.label), ['feedback-loop']);
});

test('an idle session is killed by the watchdog and housekeeping is told', async () => {
  const setup = makeRepo('hung', PLANNED_PLAN);
  const { status, prompts } = await runDriver(setup, 'hang-first', ['-IdleChecksLimit', '2']);
  assert.equal(status.sessions[0].killedIdle, true);
  assert.match(prompts[1], /killed by the watchdog/);
  assert.match(status.stopReason, /^no progress in 2 rounds/);
});

test('a live non-timer child keeps an otherwise idle session alive', async () => {
  const setup = makeRepo('child', PLANNED_PLAN);
  const { status } = await runDriver(setup, 'child-first', ['-IdleChecksLimit', '2']);
  assert.equal(status.sessions[0].killedIdle, false);
});

test('Slice 377 item 6: with no recorded starter session id, no other transcript is read for silence', async () => {
  const setup = makeRepo('silent-noid', PLANNED_PLAN);
  const lastSpoke = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const entry = JSON.stringify({ type: 'assistant', timestamp: lastSpoke, message: { content: [] } });
  const { projects } = writeStarter(setup, 'silent-noid', [entry]);
  const { status } = await runDriver(setup, 'hang-first', ['-IdleChecksLimit', '2', '-ProjectsDir', projects]);
  assert.equal(status.starterSilentSince, null);
});

test('Slice 377 item 6: a starter with no assistant entry for over 25 minutes while a session runs is recorded as starterSilentSince', async () => {
  const setup = makeRepo('silent', PLANNED_PLAN);
  const lastSpoke = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const entry = JSON.stringify({ type: 'assistant', timestamp: lastSpoke, message: { content: [] } });
  const { projects } = writeStarter(setup, 'silent', [entry]);
  const { status } = await runDriver(setup, 'hang-first', ['-IdleChecksLimit', '2', '-ProjectsDir', projects, '-StarterSessionId', 'starter-session']);
  assert.equal(new Date(status.starterSilentSince).toISOString(), lastSpoke);
});

test('housekeeping failing twice retries once, then stops the loop; the feedback loop still runs', async () => {
  const setup = makeRepo('hkfail', PLANNED_PLAN);
  const { status } = await runDriver(setup, 'hk-fail');
  assert.deepEqual(status.sessions.map((s) => s.label), ['wave-1', 'housekeeping-1', 'housekeeping-1-retry', 'feedback-loop']);
  assert.match(status.stopReason, /housekeeping-1 failed twice/);
});

// Night folders are named yyyy-MM-dd-HHmm in local time; the driver carries only nights at most 48 hours old.
function nightName(hoursAgo) {
  const d = new Date(Date.now() - hoursAgo * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function writeEarlierNight(setup, status, hoursAgo = 2) {
  const dir = join(setup.runDir, nightName(hoursAgo));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
  return dir;
}

test('a dead earlier night\'s unaudited session is named by the new night\'s loop and then audited', async () => {
  const setup = makeRepo('carried', PLANNED_PLAN);
  const dir = writeEarlierNight(setup, { sessions: [
    { label: 'wave-1', sessionId: 'dead-wave-id', exitCode: null, endedAt: null },
    { label: 'housekeeping-1', sessionId: 'dead-hk-id', exitCode: 0, endedAt: 'x' }], audited: ['dead-hk-id'] });
  const { status, prompts } = await runDriver(setup, 'merge');
  assert.deepEqual(status.sessions.map((s) => s.label), ['wave-1', 'housekeeping-1', 'feedback-loop']);
  assert.ok(prompts[2].includes('dead-wave-id'), prompts[2]);
  // Compare the folder name only: on CI the temp path is an 8.3 short name (RUNNER~1) the driver prints in full.
  assert.ok(prompts[2].includes(`run-all-waves${sep}${basename(dir)}`), prompts[2]);
  assert.ok(!prompts[2].includes('dead-hk-id'), prompts[2]);
  assert.ok(status.audited.includes('dead-wave-id'));
  assert.equal(status.carriedUnaudited.length, 0);
});

// The fake reads its argv like the real disk-free.mjs ("<folder>=<need>"), prints freeGb and needGb per folder, and records the argv so a test can check what the driver passed.
function fakeDiskFree(name, freeGb, exitCode) {
  const path = join(base, `${name}-disk-free.mjs`);
  const argvFile = `${path}.argv.json`;
  const body = [
    `import { writeFileSync } from 'node:fs';`,
    `const args = process.argv.slice(2);`,
    `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));`,
    `const folders = args.map((a) => ({ path: a.slice(0, a.lastIndexOf('=')), freeGb: ${freeGb}, needGb: Number(a.slice(a.lastIndexOf('=') + 1)) }));`,
    `console.log(JSON.stringify({ ok: ${exitCode === 0}, folders }));`,
    `process.exit(${exitCode});`,
  ].join('\n');
  writeFileSync(path, `${body}\n`);
  return path;
}

test('Slice 317 review 1: the driver passes <temp>=5 and <worktrees>=5 to disk-free, and an estimate of 24 only warns', async () => {
  const setup = makeRepo('disk-argv', PLANNED_PLAN);
  const script = fakeDiskFree('argv', 10, 0);
  const { status } = await runDriver(setup, 'none', ['-DiskFreeScript', script]);
  const args = JSON.parse(readFileSync(`${script}.argv.json`, 'utf8'));
  assert.equal(args.length, 2);
  assert.match(args[0], /=5$/);
  assert.match(args[1], /-worktrees=5$|worktrees=5$/);
  assert.match(status.stopReason, /^no progress in 2 rounds/, 'under the 24 GB estimate does not stop the night');
  assert.match(status.diskEstimate, /freeGb 10, needGb 24/);
});

test('Slice 317 review 7: the old -MinFreeGb name is still accepted and sets both drives thresholds', async () => {
  const setup = makeRepo('disk-alias', PLANNED_PLAN);
  const script = fakeDiskFree('alias', 10, 0);
  await runDriver(setup, 'none', ['-DiskFreeScript', script, '-MinFreeGb', '3']);
  const args = JSON.parse(readFileSync(`${script}.argv.json`, 'utf8'));
  assert.match(args[0], /=3$/);
  assert.match(args[1], /worktrees=3$/);
});

test('disk preflight: a fake reader under the minimum stops before any session and records why', async () => {
  const setup = makeRepo('disk-low', PLANNED_PLAN);
  const { status, prompts, allPrompts } = await runDriver(setup, 'none', ['-DiskFreeScript', fakeDiskFree('low', 0.4, 1)]);
  assert.match(status.stopReason, /^disk space low: .*0\.4 GB free, needs 5 GB; .*0\.4 GB free, needs 5 GB \(disk-free exit 1\)/);
  assert.ok(!allPrompts.some((p) => p.startsWith('/plan-cleanup')), 'no plan cleanup on a full disk');
  assert.equal(status.sessions.length, 1, 'only the final feedback loop runs');
  assert.equal(status.sessions[0].label, 'feedback-loop');
  assert.ok(!prompts.some((p) => p.startsWith('/run-all-waves wave')));
  assert.match(status.diskFree, /0\.4/);
});

test('disk preflight: a fake reader with enough free space lets the waves run', async () => {
  const setup = makeRepo('disk-ok', PLANNED_PLAN);
  const { status } = await runDriver(setup, 'none', ['-DiskFreeScript', fakeDiskFree('ok', 80, 0)]);
  assert.match(status.stopReason, /^no progress in 2 rounds/);
});

test('the next driver prints why the previous night ended; a killed one is named as killed', async () => {
  const setup = makeRepo('prev-end', PLANNED_PLAN);
  writeEarlierNight(setup, { pid: 999999, current: 'watching-final-release', stopReason: 'no planned slices left', sessions: [], audited: [] });
  const { status, result } = await runDriver(setup, 'none');
  assert.match(status.previousEnd, /is gone and wrote no end status; it was killed .* while current was watching-final-release/);
  assert.match(result.stdout, /run-all-waves: previous night .* is gone/);
});

test('Slice 317 review 3: an older night\'s "current: died" is still read as ended, not killed or running', async () => {
  const setup = makeRepo('prev-died', PLANNED_PLAN);
  writeEarlierNight(setup, { pid: 999999, current: 'died', stopReason: 'driver died: x', sessions: [], audited: [] });
  assert.match((await runDriver(setup, 'none')).status.previousEnd, /ended: current died/);
});

test('the previous night is "still running" only when its pid is a pwsh that started before status.json was written (not a reused pid)', async () => {
  const holder = spawn('pwsh', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 120'], { stdio: 'ignore' });
  try {
    for (const [name, fileTime, expected] of [['pid-reused', new Date(Date.now() - 3600 * 1000), /is gone and wrote no end status/], ['pid-live', new Date(Date.now() + 3600 * 1000), /still running/]]) {
      const setup = makeRepo(name, PLANNED_PLAN);
      const dir = writeEarlierNight(setup, { pid: holder.pid, current: 'wave-1', stopReason: null, sessions: [], audited: [] });
      utimesSync(join(dir, 'status.json'), fileTime, fileTime);
      assert.match((await runDriver(setup, 'none')).status.previousEnd, expected, name);
    }
  } finally { holder.kill(); }
});

test('a normal end stays done: the finally block only rewrites a status that never reached done or failed', async () => {
  const setup = makeRepo('died-status', PLANNED_PLAN);
  const { status } = await runDriver(setup, 'none');
  assert.equal(status.current, 'done', 'a normal end stays done');
});

test('Slice 317 item 7: no died status exists (the catch writes failed for every exception); a clean early exit is stopped', async () => {
  const source = readFileSync(join(import.meta.dirname, 'run-all-waves.ps1'), 'utf8');
  const finallyBlock = source.slice(source.lastIndexOf('} finally {'));
  assert.doesNotMatch(source, /current = 'died'/, 'the dead died branch is gone');
  assert.match(source, /\} catch \{\s*\$failure = \$_\.Exception\.Message\s*\$state\.current = 'failed'/, 'every exception is stamped failed by the catch');
  assert.match(finallyBlock, /ended early without an error[\s\S]*?\$state\.current = 'stopped'/, 'a clean early exit is stopped');
});

test('Slice 393 item 5: free memory under -LowMemoryGb writes a snapshot of the top processes into status.json lowMemory', async () => {
  const low = await runDriver(makeRepo('lowmem-on', PLANNED_PLAN), 'merge', ['-LowMemoryGb', '100000']);
  assert.ok(low.status.lowMemory, 'a threshold above any real RAM records a snapshot');
  assert.ok(low.status.lowMemory.freeGb < 100000 && low.status.lowMemory.top.length > 0, JSON.stringify(low.status.lowMemory));
  const fine = await runDriver(makeRepo('lowmem-off', PLANNED_PLAN), 'merge', ['-LowMemoryGb', '0']);
  assert.equal(fine.status.lowMemory, null, 'a threshold of 0 never records one');
});

test('a carried session appears in the final loop prompt when no wave ran', async () => {
  const setup = makeRepo('carried-final', TABLELESS_PLAN);
  const dir = writeEarlierNight(setup, { sessions: [{ label: 'wave-1', sessionId: 'dead-wave-id', exitCode: null, endedAt: null }], audited: [] });
  const { status, prompts } = await runDriver(setup, 'none');
  assert.deepEqual(status.sessions.map((s) => s.label), ['feedback-loop']);
  assert.ok(prompts[0].includes('dead-wave-id') && prompts[0].includes(`run-all-waves${sep}${basename(dir)}`), prompts[0]);
  assert.ok(status.audited.includes('dead-wave-id'));
});

test('an earlier night whose final loop finished carries nothing', async () => {
  const setup = makeRepo('carried-done', PLANNED_PLAN);
  writeEarlierNight(setup, { sessions: [
    { label: 'wave-1', sessionId: 'old-wave-id', exitCode: 0, endedAt: 'x' },
    { label: 'feedback-loop', sessionId: 'old-final-id', exitCode: 0, endedAt: 'x' }], audited: [] });
  const { prompts } = await runDriver(setup, 'merge');
  assert.ok(!prompts.some((p) => p.includes('old-wave-id')));
});

test('an earlier night whose final loop was killed idle (exit 0) still carries its sessions', async () => {
  const setup = makeRepo('carried-killed', PLANNED_PLAN);
  writeEarlierNight(setup, { sessions: [
    { label: 'wave-1', sessionId: 'old-wave-id', exitCode: 0, endedAt: 'x' },
    { label: 'feedback-loop', sessionId: 'old-final-id', exitCode: 0, endedAt: 'x', killedIdle: true }], audited: [] });
  const { prompts } = await runDriver(setup, 'merge');
  assert.ok(prompts[2].includes('old-wave-id'), prompts[2]);
});

test('an earlier night older than 48 hours carries nothing', async () => {
  const setup = makeRepo('carried-stale', PLANNED_PLAN);
  writeEarlierNight(setup, { sessions: [{ label: 'wave-1', sessionId: 'stale-wave-id', exitCode: null, endedAt: null }], audited: [] }, 72);
  const { prompts } = await runDriver(setup, 'merge');
  assert.ok(!prompts.some((p) => p.includes('stale-wave-id')), prompts.join(' '));
});

const TRACE_NAME = /^driver-.*\.trace\.log$/;

function assertTrace(runDir) {
  const log = readdirSync(runDir).find((f) => TRACE_NAME.test(f));
  assert.ok(log, 'driver trace file exists');
  const text = readFileSync(join(runDir, log), 'utf8');
  assert.match(text, /^\d{4}-\d\d-\d\dT.* driver start/m);
  assert.match(text, /session start: wave-1 id /);
  assert.match(text, /session end: wave-1 id .* exit 0/);
  assert.match(text, /driver finally: current done/);
}

test('the driver trace file gets timestamped lines for start, each session and the finally block', async () => {
  const setup = makeRepo('driverlog', PLANNED_PLAN);
  await runDriver(setup, 'merge');
  assertTrace(setup.runDir);
});

test('the trace still lands when the launcher redirects stdout with cmd >> into driver-<time>.log', async () => {
  const setup = makeRepo('driverlog-cmd', PLANNED_PLAN);
  const stdoutLog = join(base, 'driverlog-cmd-stdout.log');
  const calls = join(base, 'driverlog-cmd-calls.log');
  const pwsh = `pwsh -NoProfile -File "${DRIVER}" -Repo "${setup.repo}" -ClaudeCommand "${join(base, 'claude.cmd')}"`
    + ` -WatchdogSeconds 30 -GhCommand "${join(base, 'gh.ps1')}" -FastFailureSeconds 0 -TempBuildsDir "${fakeTempDir(setup)}"`;
  const env = { ...process.env, FAKE_MODE: 'merge', FAKE_CALLS: calls, FAKE_ORIGIN: setup.origin };
  spawnSync('cmd.exe', ['/c', `"${pwsh} >> "${stdoutLog}" 2>&1"`], { env, encoding: 'utf8', windowsVerbatimArguments: true });
  assertTrace(setup.runDir);
});

test('the exit code comes from the job result, not the last output line', async () => {
  const setup = makeRepo('exitcode', PLANNED_PLAN);
  const { status } = await runDriver(setup, 'hk-fail');
  assert.equal(status.sessions[0].exitCode, 0);
  assert.equal(status.sessions[1].exitCode, 1);
});

const LAUNCH = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'audit the thing' } }] } });
const NOTICE = JSON.stringify({ type: 'user', message: { content: '<task-notification><tool-use-id>ag1</tool-use-id><status>completed</status></task-notification>' } });

// A fake interactive session transcript in the project folder the driver derives from the repo root.
function writeStarter(setup, name, lines) {
  const projects = join(base, `${name}-projects`);
  const folder = join(projects, realpathSync.native(setup.repo).replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'starter-session.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  return { projects, file };
}

test('a feedback-loop session past its cap is killed, marked and left unaudited', async () => {
  const setup = makeRepo('fl-cap', TABLELESS_PLAN);
  const { status } = await runDriver(setup, 'fl-slow', ['-FeedbackLoopMaxMinutes', '0.04', '-IdleChecksLimit', '100']);
  const loop = status.sessions.at(-1);
  assert.equal(loop.label, 'feedback-loop');
  assert.equal(loop.killedTimeout, true);
  assert.equal(loop.killedIdle, false);
  assert.deepEqual(status.audited, []);
  const trace = readFileSync(join(setup.runDir, readdirSync(setup.runDir).find((f) => TRACE_NAME.test(f))), 'utf8');
  assert.match(trace, /minute cap; killing it/);
});

test('the loop prompt states the 30 minute budget', async () => {
  const setup = makeRepo('fl-budget', TABLELESS_PLAN);
  const { prompts } = await runDriver(setup, 'none');
  assert.match(prompts[0], /You have 30 minutes in total; at 25 minutes stop starting new passes/);
});

// Slice 30 item B: appends the agent-finished notice to the starter transcript once the trace log says the driver is waiting.
// A fixed 3-4 s timer raced the driver start-up when 4 tests ran at once (the notice landed before the wait began).
function noticeOnceWaiting(setup, file) {
  const script = `const fs = require('fs'); const t0 = Date.now();
const timer = setInterval(() => {
  let text = '';
  try {
    const log = fs.readdirSync(${JSON.stringify(setup.runDir)}).find((f) => /^driver-.*\\.trace\\.log$/.test(f));
    text = log ? fs.readFileSync(${JSON.stringify(setup.runDir)} + '/' + log, 'utf8') : '';
  } catch { /* a missing or locked log is retried on the next tick */ }
  if (text.includes('feedback loop waiting:')) { fs.appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(NOTICE + '\n')}); clearInterval(timer); }
  else if (Date.now() - t0 > 300000) clearInterval(timer);
}, 200);`;
  return spawn('node', ['-e', script], { stdio: 'ignore' });
}

test('the loop waits while the main session has an agent in flight and starts once it is notified', async () => {
  const setup = makeRepo('fl-wait', TABLELESS_PLAN);
  const { projects, file } = writeStarter(setup, 'fl-wait', [LAUNCH]);
  const poller = noticeOnceWaiting(setup, file);
  let status;
  try {
    ({ status } = await runDriver(setup, 'none', ['-ProjectsDir', projects, '-StarterCheckSeconds', '1']));
  } finally { poller.kill(); }
  assert.equal(status.sessions.at(-1).label, 'feedback-loop');
  assert.equal(status.skippedFeedbackLoop, null);
  const trace = readFileSync(join(setup.runDir, readdirSync(setup.runDir).find((f) => TRACE_NAME.test(f))), 'utf8');
  assert.match(trace, /feedback loop waiting: .*audit the thing/);
});

test('the recorded starter session is the one waited on, not a newer transcript', async () => {
  const setup = makeRepo('fl-recorded', TABLELESS_PLAN);
  const { projects, file } = writeStarter(setup, 'fl-recorded', [LAUNCH]);
  const other = join(file, '..', 'other-session.jsonl');
  writeFileSync(other, [LAUNCH].join('\n') + '\n');
  const future = new Date(Date.now() + 60000);
  utimesSync(other, future, future);
  const poller = noticeOnceWaiting(setup, file);
  let status;
  try {
    ({ status } = await runDriver(setup, 'none', ['-ProjectsDir', projects, '-StarterCheckSeconds', '1', '-StarterSessionId', 'starter-session']));
  } finally { poller.kill(); }
  assert.equal(status.starterSessionId, 'starter-session');
  assert.equal(status.sessions.at(-1).label, 'feedback-loop');
  const trace = readFileSync(join(setup.runDir, readdirSync(setup.runDir).find((f) => TRACE_NAME.test(f))), 'utf8');
  assert.match(trace, /starter transcript starter-session \(recorded\)/);
});

test('a main session with only a timer does not delay the loop', async () => {
  const setup = makeRepo('fl-timer', TABLELESS_PLAN);
  const timer = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 600', run_in_background: true } }] } });
  const { projects } = writeStarter(setup, 'fl-timer', [timer]);
  const { status } = await runDriver(setup, 'none', ['-ProjectsDir', projects, '-StarterCheckSeconds', '1']);
  assert.equal(status.sessions.at(-1).label, 'feedback-loop');
});

test('a starter transcript not written for 30 minutes is idle even with a dangling launch', async () => {
  const setup = makeRepo('fl-stale', TABLELESS_PLAN);
  const { projects, file } = writeStarter(setup, 'fl-stale', [LAUNCH]);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(file, old, old);
  const { status } = await runDriver(setup, 'none', ['-ProjectsDir', projects, '-StarterCheckSeconds', '1']);
  assert.equal(status.sessions.at(-1).label, 'feedback-loop');
  assert.equal(status.skippedFeedbackLoop, null);
});

// Writes the stop file only once the driver's trace log says it is in the starter wait. A fixed timer raced the driver: a
// stop file that landed before the wave loop was consumed there (read and removed), so the wait never saw it and ran to the
// 240 s kill. The wait reads the stop file after each sleep, so a file written once it logs "feedback loop waiting" is seen.
function stopOnceRunStarted(setup) {
  const stop = join(setup.runDir, 'run-all-waves.stop');
  const script = `const fs = require('fs'); const t0 = Date.now();
const timer = setInterval(() => {
  let text = '';
  try {
    const log = fs.readdirSync(${JSON.stringify(setup.runDir)}).find((f) => /^driver-.*\\.trace\\.log$/.test(f));
    text = log ? fs.readFileSync(${JSON.stringify(setup.runDir)} + '/' + log, 'utf8') : '';
  } catch { /* a missing or locked log is retried on the next tick */ }
  if (text.includes('feedback loop waiting:')) { fs.writeFileSync(${JSON.stringify(stop)}, ''); clearInterval(timer); }
  else if (Date.now() - t0 > 300000) clearInterval(timer);
}, 200);`;
  return spawn('node', ['-e', script], { stdio: 'ignore' });
}

test('a stop file during the wait ends it', async () => {
  const setup = makeRepo('fl-stopwait', TABLELESS_PLAN);
  const { projects } = writeStarter(setup, 'fl-stopwait', [LAUNCH]);
  const poller = stopOnceRunStarted(setup);
  let result;
  try {
    result = await runDriver(setup, 'none', ['-ProjectsDir', projects, '-StarterCheckSeconds', '2']);
  } finally { poller.kill(); }
  const { status, prompts } = result;
  assert.equal(prompts.length, 0);
  assert.match(status.stopReason, /stop file/);
});

test('past the wait ceiling the loop is skipped, recorded, and nothing is audited', async () => {
  const setup = makeRepo('fl-skip', TABLELESS_PLAN);
  const { projects } = writeStarter(setup, 'fl-skip', [LAUNCH]);
  const { status, prompts } = await runDriver(setup, 'none', ['-ProjectsDir', projects, '-StarterCheckSeconds', '1', '-StarterWaitMaxMinutes', '0.03']);
  assert.deepEqual(status.sessions, []);
  assert.equal(prompts.length, 0);
  assert.match(status.skippedFeedbackLoop, /audit the thing/);
  assert.deepEqual(status.audited, []);
});

test('batch release: start at the beginning, then not due, then one final release watched before the feedback loop', async () => {
  const setup = makeRepo('batch-normal', PLANNED_PLAN);
  const { status, prompts, batch } = await runDriver(setup, 'merge');
  assert.deepEqual(batch, ['start', 'due', 'release', 'watch', 'release']);
  assert.equal(status.loopRelease.command, 'release');
  assert.match(status.finalRelease.watch.output, /conclusion success/);
  const loop = prompts.at(-1);
  assert.match(loop, /Every merge you make carries batch release: yes in its ship-branch brief/);
  assert.match(loop, /^\/feedback-loop/);
  assert.match(loop, /Batched release at the end of the run: release exit 0:.*conclusion success/);
  assert.ok(!loop.includes('after-merges'));
});

test('batch release: when due after a wave it releases at once and the next housekeeping watches it', async () => {
  const setup = makeRepo('batch-due', PLANNED_PLAN);
  const { status, prompts, batch } = await runDriver(setup, 'none', [], { FAKE_DUE: 'yes' });
  assert.deepEqual(batch.slice(0, 5), ['start', 'due', 'release', 'start', 'due']);
  assert.equal(status.batchReleases.length, 2);
  assert.ok(!prompts[1].includes('batched release was dispatched'), prompts[1]);
  assert.match(prompts[3], /batched release was dispatched after the previous wave: watch it with node .*batch-release\.mjs watch .* --max-minutes 240/);
  assert.equal(batch.filter((c) => c === 'watch').length, 1);
});

// Slice 31: a repo whose primary checkout holds docs/plan/unverified.md with the given bullet lines.
function addUnverified(setup, bullets) {
  mkdirSync(join(setup.repo, 'docs', 'plan'), { recursive: true });
  writeFileSync(join(setup.repo, 'docs', 'plan', 'unverified.md'), `# Not yet verified\n\n### Slice 31: Live checks\n\n${bullets.join('\n')}\n`);
  git(setup.repo, 'add', '.');
  git(setup.repo, 'commit', '-qm', 'unverified');
  git(setup.repo, 'push', '-q', 'origin', 'main');
}

test('live checks: one session before the feedback loop with its own cap, label and status entry', async () => {
  const setup = makeRepo('live-final', PLANNED_PLAN);
  addUnverified(setup, ['- [chrome] The board shows the card.', '- [phone] The test phone opens the page.', '- [owner] Compare the mock.']);
  const { status, prompts } = await runDriver(setup, 'merge', ['-LiveChecksMaxMinutes', '45']);
  assert.deepEqual(status.sessions.map((s) => s.label), ['wave-1', 'housekeeping-1', 'live-checks-final', 'feedback-loop']);
  const live = prompts.find((p) => p.startsWith('Live checks (final)'));
  assert.match(live, /--todo chrome,session,phone,cloud --origin --today \d{4}-\d{2}-\d{2} \(2 open lines\)/);
  assert.match(live, /branch chore\/docs-index-live-checks-\d{4}-\d{2}-\d{2}-\d{4}-final/);
  assert.match(live, /read each run's conclusion with gh run list/);
  assert.match(live, /RESULT being one of: unreachable: WHY, release not live, failed, Slice N/);
  assert.match(live, /marked \(live check \d{4}-\d{2}-\d{2}: release not live\)/);
  assert.match(live, /count-unverified\.mjs on your own worktree folder with --write \(never on /);
  assert.match(live, /says failed before and names a slice is updated in that slice .*never filed as a new slice/);
  assert.match(live, /A marker dated tonight leaves the line out of tonight's lists, an older one is ignored/);
  assert.match(live, /One docs PR/);
  assert.match(live, /--todo chrome,session,phone,cloud --origin/);
  assert.match(live, /You have 45 minutes; at 40 minutes stop/);
  assert.match(live, /repo file .*[\\/]\.claude[\\/]live-checks\.local\.json \(read it by that absolute path/);
  assert.ok(!/["<>&|^%]/.test(live), live);
  assert.deepEqual(status.liveChecks.map((c) => [c.reason, c.openLines, c.exitCode]), [['final', 2, 0]]);
  assert.equal(status.liveChecks[0].chromeConfig, 'missing');
});

test('live checks: no session when only owner and chat lines are open', async () => {
  const setup = makeRepo('live-owner', PLANNED_PLAN);
  addUnverified(setup, ['- [owner] Compare the mock.', '- [chat] Ask on claude.ai.']);
  const { status } = await runDriver(setup, 'merge');
  assert.deepEqual(status.sessions.map((s) => s.label), ['wave-1', 'housekeeping-1', 'feedback-loop']);
  assert.deepEqual(status.liveChecks, []);
});

test('live checks: a release that went live after a wave starts a session, one that did not does not', async () => {
  const live = makeRepo('live-wave', PLANNED_PLAN);
  addUnverified(live, ['- [session] The plugin reports a reading.']);
  const yes = await runDriver(live, 'none', [], { FAKE_DUE: 'yes' });
  const labels = yes.status.sessions.map((s) => s.label);
  assert.equal(labels[2], 'live-checks-after-wave-1', labels.join(','));
  assert.ok(labels.includes('live-checks-final'));
  const quiet = makeRepo('live-wave-no', PLANNED_PLAN);
  addUnverified(quiet, ['- [session] The plugin reports a reading.']);
  const no = await runDriver(quiet, 'none', [], { FAKE_DUE: 'yes', FAKE_RELEASE: 'nothing' });
  assert.ok(!no.status.sessions.some((s) => s.label.startsWith('live-checks-after-wave')));
});

test('live checks: a failing live-checks session never stops the run or the feedback loop', async () => {
  const setup = makeRepo('live-fail', PLANNED_PLAN);
  addUnverified(setup, ['- [chrome] The board shows the card.']);
  const { status } = await runDriver(setup, 'live-fail');
  assert.equal(status.sessions.at(-1).label, 'feedback-loop');
  assert.equal(status.liveChecks[0].exitCode, 1);
  assert.ok(!status.fastFailure, 'a live-checks fast failure never sets fastFailure');
  assert.equal(status.current, 'done');
});

test('batch release: only the first start of a run restarts the due clock', async () => {
  const setup = makeRepo('batch-runstart', PLANNED_PLAN);
  const { batchLines } = await runDriver(setup, 'none', [], { FAKE_DUE: 'yes' });
  assert.equal(batchLines[0], 'start --run-start');
  assert.ok(batchLines.slice(1).filter((l) => l.startsWith('start')).every((l) => l === 'start'));
});

test('batch release: wave and housekeeping prompts say the driver owns releases, with no characters cmd.exe reads', async () => {
  const setup = makeRepo('batch-owner', PLANNED_PLAN);
  const { prompts } = await runDriver(setup, 'none');
  for (const prompt of prompts.slice(0, 2)) {
    assert.match(prompt, /The driver owns releases: run node .*batch-release\.mjs start .* batch release: yes in every merge brief.* never run release or watch/);
    assert.ok(!/["<>&|^%]/.test(prompt), prompt);
    assert.match(prompt, /This session is an orchestrator: first run node .*board\.mjs report-progress --orchestrator once/);
  }
});

test('batch release: the housekeeping prompt that tells it to watch does not also say never watch; the final watch clears failed runs', async () => {
  const setup = makeRepo('batch-watchword', PLANNED_PLAN);
  const { prompts, batchLines } = await runDriver(setup, 'none', [], { FAKE_DUE: 'yes' });
  assert.match(prompts[3], /batched release was dispatched after the previous wave: watch it/);
  assert.match(prompts[3], /never run release./);
  assert.ok(!/never run release or watch/.test(prompts[3]), prompts[3]);
  assert.ok(!/["<>&|^%]/.test(prompts[3]), prompts[3]);
  assert.match(prompts[3], /This session is an orchestrator: first run node .*board\.mjs report-progress --orchestrator once/);
  assert.ok(batchLines.filter((l) => l.startsWith('watch')).every((l) => l.includes('--clear-failed')), batchLines.join('|'));
});

test('batch release: a plan the parser cannot read still gets the final release, an always-run watch (a no-op without runs) and the post-loop release', async () => {
  const setup = makeRepo('batch-stop', TABLELESS_PLAN);
  const { status, batch, prompts } = await runDriver(setup, 'none', [], { FAKE_RELEASE: 'nothing' });
  assert.match(status.stopReason, /no recognised status table/);
  assert.deepEqual(batch, ['start', 'release', 'watch', 'release']);
  assert.match(prompts[0], /Batched release at the end of the run: release exit 0/);
});

test('batch release: a failed final run reaches status.json and the feedback loop prompt', async () => {
  const setup = makeRepo('batch-failed', TABLELESS_PLAN);
  const { status, prompts } = await runDriver(setup, 'none', [], { FAKE_WATCH: 'failure' });
  assert.equal(status.finalRelease.watch.exitCode, 1);
  assert.match(prompts[0], /watch exit 1: release\.yml run 9: conclusion failure/);
});

test('batch release: a broken batch-release script never stops the run or the feedback loop', async () => {
  const setup = makeRepo('batch-throws', TABLELESS_PLAN);
  const { status } = await runDriver(setup, 'none', [], { FAKE_BATCH: 'throw' });
  assert.equal(status.sessions.at(-1).label, 'feedback-loop');
  assert.equal(status.finalRelease.release.exitCode, 5);
});

test('plan cleanup: one session after the waves and before the feedback loop, target all, no branch name, decisions in Outstanding work', async () => {
  const setup = makeRepo('pc-order', PLANNED_PLAN);
  const { allStatus, allPrompts } = await runDriver(setup, 'merge');
  assert.deepEqual(allStatus.sessions.map((s) => s.label), ['wave-1', 'housekeeping-1', 'plan-cleanup', 'feedback-loop']);
  assert.equal(allPrompts.filter((p) => p.startsWith('/plan-cleanup ')).length, 1);
  assert.match(allPrompts[2], /^\/plan-cleanup all - Unattended, once at the end of all waves of a run-all-waves run in /);
  assert.ok(!/chore\/plan-cleanup/.test(allPrompts[2]), 'the prompt leaves the branch name to the skill');
  assert.ok(!/PR body/.test(allPrompts[2]), 'user decisions are not put in the PR body');
  assert.match(allPrompts[2], /Outstanding work/);
  assert.match(allPrompts[2], /Batched release at the end of the run/, 'carries the release-loop note');
  assert.match(allPrompts[3], /^\/feedback-loop /);
  assert.ok(allPrompts[3].includes(allStatus.sessions[2].sessionId), 'the feedback loop lists the plan-cleanup session');
});

test('plan cleanup: not run after a stop file', async () => {
  const setup = makeRepo('pc-stop', PLANNED_PLAN);
  mkdirSync(setup.runDir, { recursive: true });
  const stop = join(setup.runDir, 'run-all-waves.stop');
  writeFileSync(stop, '');
  const future = new Date(Date.now() + 3600 * 1000);
  utimesSync(stop, future, future);
  const { status, allPrompts } = await runDriver(setup, 'none');
  assert.match(status.stopReason, /stop file/);
  assert.ok(!allPrompts.some((p) => p.startsWith('/plan-cleanup')));
});

test('plan cleanup: the housekeeping-branch pattern matches the skill\'s own branch name', () => {
  const source = readFileSync(DRIVER, 'utf8');
  const pattern = source.match(/\$HousekeepingBranch = '([^']+)'/)[1];
  assert.match('chore/plan-cleanup-20261125-1019', new RegExp(pattern));
});

test('plan cleanup: not run after a fast failure of a wave session', async () => {
  const setup = makeRepo('pc-fast', PLANNED_PLAN);
  const { status, allPrompts } = await runDriver(setup, 'wave-fail', ['-FastFailureSeconds', '600']);
  assert.ok(status.fastFailure);
  assert.match(status.stopReason, /failed at once/);
  assert.ok(!allPrompts.some((p) => p.startsWith('/plan-cleanup')));
  assert.ok(allPrompts.some((p) => p.startsWith('/feedback-loop')), 'the feedback loop still runs');
});

test('plan cleanup: runs after the no-progress stop', async () => {
  const setup = makeRepo('pc-stalled', PLANNED_PLAN);
  const { status, allPrompts } = await runDriver(setup, 'none');
  assert.match(status.stopReason, /^no progress in 2 rounds/);
  assert.equal(allPrompts.filter((p) => p.startsWith('/plan-cleanup')).length, 1);
});

test('plan cleanup: a failing session is logged and the feedback loop still runs', async () => {
  const setup = makeRepo('pc-fail', PLANNED_PLAN);
  const { allStatus, allPrompts } = await runDriver(setup, 'pc-fail');
  const labels = allStatus.sessions.map((s) => s.label);
  assert.ok(labels.indexOf('plan-cleanup') >= 0 && labels.at(-1) === 'feedback-loop', labels.join());
  assert.notEqual(allStatus.sessions.find((s) => s.label === 'plan-cleanup').exitCode, 0);
  assert.ok(allPrompts.some((p) => p.startsWith('/feedback-loop')));
});

test('batch release: a stop file still releases on the way out', async () => {
  const setup = makeRepo('batch-stopfile', PLANNED_PLAN);
  const { projects } = writeStarter(setup, 'batch-stopfile', [LAUNCH]);
  stopOnceRunStarted(setup);
  const { status, batch } = await runDriver(setup, 'none', ['-ProjectsDir', projects, '-StarterCheckSeconds', '2']);
  assert.match(status.stopReason, /stop file/);
  assert.ok(batch.includes('release'));
});

test('batch release: a stop file releases but does not watch; status.json says so', async () => {
  const setup = makeRepo('batch-stopnowatch', PLANNED_PLAN);
  mkdirSync(setup.runDir, { recursive: true });
  const stop = join(setup.runDir, 'run-all-waves.stop');
  writeFileSync(stop, '');
  const future = new Date(Date.now() + 3600 * 1000);
  utimesSync(stop, future, future);
  const { status, batch } = await runDriver(setup, 'none');
  assert.match(status.stopReason, /stop file/);
  assert.ok(batch.includes('release'));
  assert.ok(!batch.includes('watch'), batch.join(','));
  assert.equal(status.finalRelease.watched, false);
  assert.equal(status.unwatchedRelease, true);
  // Finding 5: a clean stop-file exit ends in an ended state, so the next run does not call it killed.
  assert.ok(['stopped', 'done'].includes(status.current), status.current);
});

test('batch release: runs an earlier run left unwatched are watched by this run first housekeeping', async () => {
  const setup = makeRepo('batch-carried', PLANNED_PLAN);
  const worktrees = dirname(setup.runDir);
  mkdirSync(worktrees, { recursive: true });
  writeFileSync(join(worktrees, 'batch-release.json'), JSON.stringify({ runs: [{ workflow: 'release.yml', runId: '5' }] }));
  const { prompts } = await runDriver(setup, 'none');
  assert.match(prompts[1], /watch it with node .*batch-release\.mjs watch/);
});

test('Slice 09 item 3: runs carried from an earlier run are called carried, never dispatched after the previous wave', async () => {
  const setup = makeRepo('batch-carried-word', PLANNED_PLAN);
  const worktrees = dirname(setup.runDir);
  mkdirSync(worktrees, { recursive: true });
  writeFileSync(join(worktrees, 'batch-release.json'), JSON.stringify({ runs: [{ workflow: 'release.yml', runId: '5' }] }));
  const { prompts } = await runDriver(setup, 'none');
  assert.match(prompts[1], /batched release was carried from an earlier run: watch it/);
  assert.ok(!prompts[1].includes('dispatched after the previous wave'), prompts[1]);
});

// Slice 08: placement pass-through, the nightly cloud cap and the memory line.
const PLAN_THREE = '# Plan\n\n| # | Slice | Status |\n| --- | --- | --- |\n| 1 | One | planned |\n| 2 | Two | planned |\n| 3 | Three | planned |\n';

function addSliceFiles(setup, texts) {
  mkdirSync(join(setup.repo, 'docs', 'plan', 'slices'), { recursive: true });
  for (const [n, text] of Object.entries(texts)) writeFileSync(join(setup.repo, 'docs', 'plan', 'slices', `0${n}-x.md`), text);
  git(setup.repo, 'add', '.');
  git(setup.repo, 'commit', '-qm', 'slices');
  git(setup.repo, 'push', '-q', 'origin', 'main');
}

const placementArgs = (...more) => ['-PlacementScript', join(base, 'fake-placement.mjs'), ...more];

test('Slice 08: the wave prompt carries each slice placement as the script gives it and the cloud slices left; a failing script means local', async () => {
  const setup = makeRepo('place-cap', PLAN_THREE);
  addSliceFiles(setup, { 1: 'CLOUDY', 2: 'CLOUDY', 3: 'CLOUDY BROKEN' });
  const { prompts } = await runDriver(setup, 'none', placementArgs('-MaxCloudSlices', '1'));
  assert.match(prompts[0], /Placement: 1 cloud, 2 cloud, 3 local\./);
  assert.match(prompts[0], /Cloud slices left tonight: 1 of 1; send at most 1 cloud slices/);
  assert.ok(!prompts[0].includes('"'), prompts[0]);
});

test('Slice 08: cloud slices used are counted from ledger waves after the run start, and the cap then hands out no more', async () => {
  const setup = makeRepo('place-count', PLAN_THREE);
  addSliceFiles(setup, { 1: 'CLOUDY', 2: 'CLOUDY', 3: 'plain' });
  const worktrees = dirname(setup.runDir);
  mkdirSync(worktrees, { recursive: true });
  const ledger = join(worktrees, 'wave-ledger.md');
  writeFileSync(ledger, '## Wave 1 (closed)\n- Slice 9 old cloud: pushed abc run r\n');
  const { prompts, status } = await runDriver(setup, 'none', placementArgs('-MaxCloudSlices', '2'), { FAKE_LEDGER: ledger });
  assert.match(prompts[0], /Placement: 1 cloud, 2 cloud, 3 local\./);
  assert.match(prompts[0], /left tonight: 2 of 2/);
  const wave2 = prompts.find((p) => p.startsWith('/run-all-waves wave 2'));
  assert.match(wave2, /Placement: 1 cloud, 2 cloud, 3 local\./);
  assert.match(wave2, /left tonight: 1 of 2/);
  assert.equal(status.ledgerWaveAtStart, 1);
  assert.equal(status.cloudSlicesUsed, 1);
  assert.deepEqual(status.cloudSlices, ['1']);
});

test('Slice 08: a cloud slice stays counted after the wave session rewrites its ledger line, and with the cap used up every slice is local', async () => {
  const setup = makeRepo('place-keep', PLAN_THREE);
  addSliceFiles(setup, { 1: 'CLOUDY', 2: 'CLOUDY', 3: 'plain' });
  const worktrees = dirname(setup.runDir);
  mkdirSync(worktrees, { recursive: true });
  const ledger = join(worktrees, 'wave-ledger.md');
  writeFileSync(ledger, '## Wave 1 (closed)\n');
  const { prompts, status } = await runDriver(setup, 'none', placementArgs('-MaxCloudSlices', '1'), { FAKE_LEDGER: ledger, FAKE_LEDGER_REWRITE: 'yes' });
  assert.ok(readFileSync(ledger, 'utf8').includes('stage: merged'));
  assert.equal(status.cloudSlicesUsed, 1);
  const wave2 = prompts.find((p) => p.startsWith('/run-all-waves wave 2'));
  assert.ok(wave2, prompts.join('\n'));
  assert.match(wave2, /Placement: every slice local \(the nightly cloud cap of 1 is used up\)/);
});

test('Slice 08: a restarted driver carries the cloud slices of the earlier night that did not finish', async () => {
  const setup = makeRepo('place-carry', PLAN_THREE);
  addSliceFiles(setup, { 1: 'CLOUDY', 2: 'CLOUDY', 3: 'plain' });
  writeEarlierNight(setup, { sessions: [{ label: 'wave-1', sessionId: 'dead-wave-id', exitCode: null, endedAt: null }], audited: [], cloudSlices: ['7', '8'] });
  const { prompts, status } = await runDriver(setup, 'none', placementArgs('-MaxCloudSlices', '3'));
  assert.match(prompts[0], /left tonight: 1 of 3/);
  assert.deepEqual(status.cloudSlices, ['7', '8']);
});

test('Slice 08: a restarted driver keeps the earlier baseline, counts the killed wave ledger lines once, and treats 08 and 8 as one slice', async () => {
  const setup = makeRepo('place-baseline', PLAN_THREE);
  addSliceFiles(setup, { 1: 'CLOUDY', 2: 'CLOUDY', 3: 'plain' });
  const worktrees = dirname(setup.runDir);
  mkdirSync(worktrees, { recursive: true });
  writeFileSync(join(worktrees, 'wave-ledger.md'), '## Wave 1 (closed)\n- Slice 8 killed cloud: pushed abc run r\n- Slice 09 other stage: cloud running\n');
  writeEarlierNight(setup, { sessions: [{ label: 'wave-1', sessionId: 'dead-wave-id', exitCode: null, endedAt: null }], audited: [], cloudSlices: ['08'], ledgerWaveAtStart: 0 });
  const { prompts, status } = await runDriver(setup, 'none', placementArgs('-MaxCloudSlices', '4'));
  assert.equal(status.ledgerWaveAtStart, 0);
  assert.deepEqual(status.cloudSlices, ['8', '9']);
  assert.match(prompts[0], /left tonight: 2 of 4/);
});

test('Slice 08 review: a ledger line "Slice 08:" counts as slice 8, once against the carried 8', async () => {
  const setup = makeRepo('place-punct', PLAN_THREE);
  addSliceFiles(setup, { 1: 'CLOUDY', 2: 'CLOUDY', 3: 'plain' });
  const worktrees = dirname(setup.runDir);
  mkdirSync(worktrees, { recursive: true });
  writeFileSync(join(worktrees, 'wave-ledger.md'), '## Wave 1 (closed)\n- Slice 08: killed cloud: pushed abc run r\n');
  writeEarlierNight(setup, { sessions: [{ label: 'wave-1', sessionId: 'dead-wave-id', exitCode: null, endedAt: null }], audited: [], cloudSlices: ['8'], ledgerWaveAtStart: 0 });
  const { status } = await runDriver(setup, 'none', placementArgs('-MaxCloudSlices', '4'));
  assert.deepEqual(status.cloudSlices, ['8']);
});

test('Slice 08 review: an earlier night that ended (current done, or a stopReason) is not carried even with an incomplete final loop', async () => {
  for (const ended of [{ current: 'done' }, { current: 'feedback-loop', stopReason: 'no planned slices left' }]) {
    const setup = makeRepo(`place-ended-${ended.current}`, PLAN_THREE);
    addSliceFiles(setup, { 1: 'CLOUDY', 2: 'CLOUDY', 3: 'plain' });
    writeEarlierNight(setup, { sessions: [{ label: 'wave-1', sessionId: 'w', exitCode: 0, endedAt: 'x' }], audited: [], cloudSlices: ['7', '8'], ...ended });
    const { prompts, status } = await runDriver(setup, 'none', placementArgs('-MaxCloudSlices', '3'));
    assert.match(prompts[0], /left tonight: 3 of 3/);
    assert.deepEqual(status.cloudSlices, []);
  }
});

test('Slice 08: a cloud: in a reason text on a slice line does not count as a cloud slice', async () => {
  const setup = makeRepo('place-reason', PLAN_THREE);
  addSliceFiles(setup, { 1: 'CLOUDY' });
  const worktrees = dirname(setup.runDir);
  mkdirSync(worktrees, { recursive: true });
  const ledger = join(worktrees, 'wave-ledger.md');
  writeFileSync(ledger, '## Wave 1 (closed)\n');
  const { status } = await runDriver(setup, 'none', placementArgs('-MaxCloudSlices', '2'), { FAKE_LEDGER: ledger, FAKE_LEDGER_REASON: 'yes' });
  assert.equal(status.cloudSlicesUsed, 0);
});

test('Slice 08: -MaxCloudSlices 0 passes every slice as local without running the placement script', async () => {
  const setup = makeRepo('place-off', PLAN_THREE);
  addSliceFiles(setup, { 1: 'CLOUDY' });
  const mark = join(base, 'place-off-ran.txt');
  const { prompts } = await runDriver(setup, 'none', placementArgs('-MaxCloudSlices', '0'), { FAKE_PLACEMENT_MARK: mark });
  assert.match(prompts[0], /Placement: every slice local/);
  assert.ok(!existsSync(mark), 'placement script ran with -MaxCloudSlices 0');
});

test('Slice 08: the trace log memory line has free and total GB, the claude process count and their GB, and the top list', async () => {
  const setup = makeRepo('memory-line', PLANNED_PLAN);
  await runDriver(setup, 'none');
  const trace = readdirSync(setup.runDir).find((f) => f.endsWith('.trace.log'));
  const lines = readFileSync(join(setup.runDir, trace), 'utf8').split('\n').filter((l) => l.includes(' memory: '));
  assert.ok(lines.length > 0);
  assert.match(lines[0], /memory: free [\d.]+ GB of [\d.]+ GB; claude: \d+ processes, [\d.]+ GB; top: /);
});
});
