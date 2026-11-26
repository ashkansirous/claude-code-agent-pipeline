// node --test .github/scripts/run-suite.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { changedFiles, EXIT, LOCK_ENV, TREE_LABEL, parseCli, runSuite, summaryText, timeoutFor, FILE_TIMEOUT_MS, FILE_BUDGET_S, failureLines, acquireLock, releaseLock } from './run-suite.mjs';

test('a file with an override gets its longer cap; others and an explicit --timeout-ms keep theirs', () => {
  const slow = 'made-up/slow-file.test.mjs';
  const def = parseCli([]).timeoutMs;
  assert.equal(def, null);
  FILE_TIMEOUT_MS[slow] = 1800000;
  try {
    assert.equal(timeoutFor(slow, def), 1800000);
    assert.equal(timeoutFor('some.test.mjs', def), 1200000, 'the default cap is 20 minutes');
    assert.equal(timeoutFor('other.test.mjs', def), 1200000);
    assert.equal(timeoutFor(slow, 4000), 4000);
    assert.equal(timeoutFor(slow, 600000), 600000, 'an explicit 600000 beats the override');
    assert.equal(timeoutFor(slow, null), 1800000, 'the override is bounded only by its own value, not the budget');
  } finally {
    delete FILE_TIMEOUT_MS[slow];
  }
});

const SCRIPT = fileURLToPath(new URL('./run-suite.mjs', import.meta.url));
const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// A throwaway repo with three test files: one passes, one fails, one passes with a skipped test.
function fixtureRepo() {
  const base = mkdtempSync(join(tmpdir(), 'run-suite-'));
  made.push(base);
  const root = join(base, 'repo');
  mkdirSync(root);
  const files = {
    'a.test.mjs': "import test from 'node:test';\ntest('ok', () => {});\n",
    'b.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('bad', () => assert.equal(1, 2));\n",
    'c.test.mjs': "import test from 'node:test';\ntest('needs jq', { skip: 'jq is not installed' }, () => {});\ntest('ok', () => {});\n",
    'notes.md': 'docs\n',
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'init']]) execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  return { root, out: join(base, 'reviews', 'suite-summary.md') };
}

test('one failing test file is listed with exit 1 and the others with exit 0', async () => {
  const { root, out } = fixtureRepo();
  const code = await runSuite(parseCli(['--root', root, '--out', out]), () => {});
  assert.equal(code, EXIT.failed);
  const text = readFileSync(out, 'utf8');
  assert.match(text, /^exit 0 {2}a\.test\.mjs /m);
  assert.match(text, /^exit 1 {2}b\.test\.mjs /m);
  assert.match(text, /^exit 0 {2}c\.test\.mjs /m);
  assert.match(text, /FAILED: b\.test\.mjs/);
});

test('the summary lists skipped tests with their reason and carries the tree hash', async () => {
  const { root, out } = fixtureRepo();
  await runSuite(parseCli(['--root', root, '--out', out]), () => {});
  const text = readFileSync(out, 'utf8');
  assert.match(text, /Skipped tests:\nc\.test\.mjs: 1\n {2}.*jq is not installed/);
  assert.match(text, new RegExp(`^${TREE_LABEL} [0-9a-f]{64}$`, 'm'));
});

test('a changed code file changes the tree hash, a changed Markdown file does not', async () => {
  const { root, out } = fixtureRepo();
  const treeOf = async () => {
    await runSuite(parseCli(['--root', root, '--out', out, '--tests', 'a.test.mjs']), () => {});
    return new RegExp(`^${TREE_LABEL} ([0-9a-f]{64})$`, 'm').exec(readFileSync(out, 'utf8'))[1];
  };
  const before = await treeOf();
  writeFileSync(join(root, 'notes.md'), 'more docs\n');
  assert.equal(await treeOf(), before);
  writeFileSync(join(root, 'a.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n// edited\n");
  assert.notEqual(await treeOf(), before);
});

test('a budget stops the run as incomplete and --resume finishes it without rerunning', async () => {
  const { root, out } = fixtureRepo();
  const first = await runSuite(parseCli(['--root', root, '--out', out, '--budget-ms', '0']), () => {});
  assert.equal(first, EXIT.incomplete);
  assert.match(readFileSync(out, 'utf8'), /INCOMPLETE/);
  const ran = [];
  await runSuite(parseCli(['--root', root, '--out', out, '--resume', '--tests', 'a.test.mjs,c.test.mjs']), (line) => ran.push(line));
  const again = [];
  const code = await runSuite(parseCli(['--root', root, '--out', out, '--resume']), (line) => again.push(line));
  assert.equal(code, EXIT.failed);
  assert.deepEqual(again.map((l) => l.trim().split(/\s+/)[2]), ['b.test.mjs']); // a and c were kept, only b ran
});

test('--rerun reruns the named files and --resume reruns a timed-out file, keeping the other results', async () => {
  const { root, out } = fixtureRepo();
  await runSuite(parseCli(['--root', root, '--out', out, '--tests', 'a.test.mjs,b.test.mjs']), () => {});
  const rerun = [];
  await runSuite(parseCli(['--root', root, '--out', out, '--tests', 'a.test.mjs,b.test.mjs', '--rerun', 'a.test.mjs']), (line) => rerun.push(line));
  assert.deepEqual(rerun.map((l) => l.trim().split(/\s+/)[2]), ['a.test.mjs']); // b kept (a real failure), only a ran again
  const json = out.replace(/\.md$/, '') + '.json';
  const saved = JSON.parse(readFileSync(json, 'utf8'));
  saved.results.find((r) => r.file === 'a.test.mjs').code = 'timeout';
  writeFileSync(json, JSON.stringify(saved));
  const resumed = [];
  assert.equal(await runSuite(parseCli(['--root', root, '--out', out, '--tests', 'a.test.mjs,b.test.mjs', '--resume']), (line) => resumed.push(line)), EXIT.failed);
  assert.deepEqual(resumed.map((l) => l.trim().split(/\s+/)[2]), ['a.test.mjs']);
});

test('the command line form exits 1 with a failing file and prints the summary path', () => {
  const { root, out } = fixtureRepo();
  const run = spawnSync(process.execPath, [SCRIPT, '--root', root, '--out', out], { encoding: 'utf8', env: { ...process.env, [LOCK_ENV]: join(root, '..', 'own.lock') } });
  assert.equal(run.status, EXIT.failed);
  assert.match(run.stdout, /exit 1 {2}b\.test\.mjs/);
  assert.match(run.stdout, /summary: /);
  const bad = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, EXIT.usage);
});

const SLEEPER = "import test from 'node:test';\ntest('sleeps', async () => { await new Promise((r) => setTimeout(r, 2500)); });\n";

test('--jobs runs files side by side: four 2.5 s files with 4 jobs take far less than 4 x 2.5 s', async () => {
  const { root, out } = fixtureRepo();
  for (const name of ['s1', 's2', 's3', 's4']) writeFileSync(join(root, `${name}.test.mjs`), SLEEPER);
  const tests = 's1.test.mjs,s2.test.mjs,s3.test.mjs,s4.test.mjs';
  const started = Date.now();
  assert.equal(await runSuite(parseCli(['--root', root, '--out', out, '--tests', tests, '--jobs', '4']), () => {}), EXIT.ok);
  assert.ok(Date.now() - started < 8000, `4 jobs took ${Date.now() - started} ms; one at a time would be 10 s or more`);
  assert.match(readFileSync(out, 'utf8'), /Files run: 4 of 4; failed: 0/);
  assert.equal(parseCli([]).jobs, 4);
  assert.throws(() => parseCli(['--jobs', '0']), /--jobs/);
});

test('the summary names the failing tests and flags a file over its time budget', async () => {
  const { root, out } = fixtureRepo();
  writeFileSync(join(root, 'b.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('the broken thing', () => assert.equal(1, 2));\n");
  FILE_BUDGET_S['a.test.mjs'] = 0;
  try {
    await runSuite(parseCli(['--root', root, '--out', out]), () => {});
  } finally {
    delete FILE_BUDGET_S['a.test.mjs'];
  }
  const text = readFileSync(out, 'utf8');
  assert.match(text, /Failed tests:\nb\.test\.mjs:\n {2}the broken thing/);
  assert.match(text, /^exit 0 {2}a\.test\.mjs .* OVER BUDGET \(0s\)$/m);
  assert.match(text, /Over budget \(flagged, not failed\):/);
  assert.doesNotMatch(text, /c\.test\.mjs .*OVER BUDGET/);
  assert.deepEqual(failureLines('ok 1 - x\nnot ok 2 - y\n  not ok 3 - z # SKIP\n'), ['y']);
});

test('--changed runs only the tests the diff touches and says why; a .github change makes it a full run', async () => {
  const { root, out } = fixtureRepo();
  writeFileSync(join(root, 'a.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n// edited\n");
  const args = ['--root', root, '--out', out, '--changed', '--base', 'main'];
  assert.equal(await runSuite(parseCli(args), () => {}), EXIT.ok);
  const text = readFileSync(out, 'utf8');
  assert.match(text, /^Selected run \(--changed\) against main: 1 file\(s\)/m);
  assert.match(text, /Selected because:\n {2}a\.test\.mjs: its own file changed/);
  assert.match(text, /Files run: 1 of 1; failed: 0/);
  assert.doesNotMatch(text, /b\.test\.mjs/);
  mkdirSync(join(root, '.github'));
  writeFileSync(join(root, '.github', 'x.txt'), 'runner changed\n');
  const logged = [];
  assert.equal(await runSuite(parseCli(args), (l) => logged.push(l)), EXIT.failed);
  assert.match(logged[0], /full run/);
  assert.doesNotMatch(readFileSync(out, 'utf8'), /Selected run/);
});

test('a renamed file is listed under both its old and new path', () => {
  const { root } = fixtureRepo();
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  git('mv', 'notes.md', 'renamed.md');
  git('add', '-A');
  const changed = changedFiles(root, 'main');
  assert.ok(changed.includes('notes.md') && changed.includes('renamed.md'), changed.join());
});

test('summaryText says incomplete when fewer files ran than exist', () => {
  const text = summaryText('t'.repeat(64), 'd', [{ file: 'a', code: 0, pass: 1, fail: 0, skipped: 0, skips: [], seconds: 1 }], 2);
  assert.match(text, /INCOMPLETE/);
});

test('a new untracked test file is run and a file longer than the budget is not recorded', async () => {
  const { root, out } = fixtureRepo();
  writeFileSync(join(root, 'd.test.mjs'), "import test from 'node:test';\ntest('new', () => {});\n");
  await runSuite(parseCli(['--root', root, '--out', out]), () => {});
  assert.match(readFileSync(out, 'utf8'), /^exit 0 {2}d\.test\.mjs /m);
  const slow = fixtureRepo();
  writeFileSync(join(slow.root, 'b.test.mjs'), "import test from 'node:test';\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 3000)); });\n");
  const code = await runSuite(parseCli(['--root', slow.root, '--out', slow.out, '--tests', 'a.test.mjs,b.test.mjs', '--budget-ms', '1000']), () => {});
  assert.equal(code, EXIT.incomplete);
  const text = readFileSync(slow.out, 'utf8');
  assert.match(text, /^exit 0 {2}a\.test\.mjs /m);
  assert.doesNotMatch(text, /b\.test\.mjs /);
  assert.match(text, /Subset run/);
});

test('the first file of a call gets the full cap even when longer than the budget, so --resume progresses', async () => {
  const { root, out } = fixtureRepo();
  writeFileSync(join(root, 'a.test.mjs'), "import test from 'node:test';\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 1500)); });\n");
  const args = ['--root', root, '--out', out, '--tests', 'a.test.mjs,c.test.mjs', '--budget-ms', '300', '--jobs', '1'];
  assert.equal(await runSuite(parseCli(args), () => {}), EXIT.incomplete);
  assert.match(readFileSync(out, 'utf8'), /^exit 0 {2}a\.test\.mjs /m);
  assert.equal(await runSuite(parseCli([...args, '--resume']), () => {}), EXIT.ok);
});

test('a failure plus unfinished files exits 3 so the resume loop continues, and a deleted test file is skipped', async () => {
  const { root, out } = fixtureRepo();
  assert.equal(await runSuite(parseCli(['--root', root, '--out', out, '--tests', 'b.test.mjs']), () => {}), EXIT.failed);
  const resume = ['--root', root, '--out', out, '--tests', 'b.test.mjs,a.test.mjs', '--budget-ms', '0', '--resume'];
  assert.equal(await runSuite(parseCli(resume), () => {}), EXIT.incomplete); // b failed earlier, a not run yet
  rmSync(join(root, 'c.test.mjs'));
  await runSuite(parseCli(['--root', root, '--out', out]), () => {});
  const text = readFileSync(out, 'utf8');
  assert.doesNotMatch(text, /c\.test\.mjs/);
  assert.match(text, /^exit 0 {2}a\.test\.mjs /m);
});

test('a timed-out file is recorded as timeout and its child processes are killed with it', async () => {
  const { root, out } = fixtureRepo();
  const pidFile = join(root, 'grandchild.pid');
  const grandchild = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000);";
  writeFileSync(join(root, 'hang.test.mjs'), [
    "import test from 'node:test';",
    "import { spawn } from 'node:child_process';",
    `test('hangs', async () => { spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, ${JSON.stringify(pidFile)}], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 60000)); });`,
    '',
  ].join('\n'));
  await runSuite(parseCli(['--root', root, '--out', out, '--tests', 'hang.test.mjs', '--timeout-ms', '4000']), () => {});
  assert.match(readFileSync(out, 'utf8'), /^exit timeout {2}hang\.test\.mjs /m);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 500));
  assert.throws(() => process.kill(pid, 0), 'the grandchild is still alive after the cap');
});

test('a second run while the first holds the lock exits 4 and names the first pid; a stale lock is taken over', () => {
  const { root, out } = fixtureRepo();
  const lock = join(root, '..', 'host.lock');
  const env = { ...process.env, [LOCK_ENV]: lock };
  assert.equal(acquireLock(lock, process.pid), null, 'the first run takes the lock');
  const second = spawnSync(process.execPath, [SCRIPT, '--root', root, '--out', out], { encoding: 'utf8', env });
  assert.equal(second.status, EXIT.busy);
  assert.match(second.stderr, new RegExp(`pid ${process.pid}\\b`));
  releaseLock(lock, process.pid);
  writeFileSync(lock, JSON.stringify({ pid: 2147483646, started: 'long ago' }));
  const third = spawnSync(process.execPath, [SCRIPT, '--root', root, '--out', out], { encoding: 'utf8', env });
  assert.equal(third.status, EXIT.failed, 'a lock whose pid is gone does not block');
  assert.equal(acquireLock(lock, process.pid), null, 'the finished run released the lock');
  releaseLock(lock, process.pid);
});

test('a failing file lists its failing test names and error lines in the summary', async () => {
  const { root, out } = fixtureRepo();
  await runSuite(parseCli(['--root', root, '--out', out]), () => {});
  const text = readFileSync(out, 'utf8');
  assert.match(text, /^Failed tests:$/m);
  assert.match(text, /^ {2}bad: Expected values to be strictly equal: \| 1 !== 2/m);
});

test('failureLines keeps leaf failures with their error line and drops "N subtests failed" parents', () => {
  const tap = [
    '# Subtest: outer', '    not ok 1 - bad inner', '      ---', "      failureType: 'testCodeFailure'", '      error: |-', '        Expected 1', '        got 2', "      code: 'X'", '      ...',
    'not ok 1 - outer', '  ---', "  failureType: 'subtestsFailed'", "  error: '1 subtest failed'", '  ...',
    'not ok 2 - x', '  ---', "  error: 'boom'", '  ...', 'ok 3 - fine',
  ].join('\n');
  assert.deepEqual(failureLines(tap), ['bad inner: Expected 1 | got 2', 'x: boom']);
});

test('a lock whose pid is alive but started at another time is stale; a matching start time is live', () => {
  const lock = join(mkdtempSync(join(tmpdir(), 'rs-lock-')), 'l.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, started: 'x', processStart: 'earlier' }));
  assert.equal(acquireLock(lock, process.pid, () => 'later'), null, 'a reused pid with another start time is taken over');
  releaseLock(lock, process.pid);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, started: 'x', processStart: 'same' }));
  assert.equal(acquireLock(lock, 99, () => 'same')?.pid, process.pid, 'same pid and start time is live');
  rmSync(lock, { force: true });
});

test('two concurrent acquires: exactly one wins and the lock is never left half-written or with temp files beside it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-race-'));
  const lock = join(dir, 'race.lock');
  const modUrl = new URL('./run-suite.mjs', import.meta.url).href;
  const code = `import(${JSON.stringify(modUrl)}).then((m) => { const h = m.acquireLock(${JSON.stringify(lock)}, process.pid, () => 'same'); process.stdout.write(h ? 'held' : 'won'); setTimeout(() => {}, 1500); });`;
  const runs = [0, 1].map(() => new Promise((resolve) => {
    let out = '';
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out));
  }));
  const results = await Promise.all(runs);
  assert.deepEqual(results.sort(), ['held', 'won']);
  assert.deepEqual(readdirSync(dir), ['race.lock'], 'no temp or aside file is left beside the lock');
});

test('a stale lock is taken over and a run releases its lock on exit, leaving no files beside it', () => {
  const { root, out } = fixtureRepo();
  const dir = mkdtempSync(join(tmpdir(), 'rs-stale-'));
  const lock = join(dir, 'x.lock');
  writeFileSync(lock, JSON.stringify({ pid: 2147483646, started: 'long ago' }));
  assert.equal(acquireLock(lock, process.pid), null, 'the dead holder is replaced');
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid);
  releaseLock(lock, process.pid + 1);
  assert.ok(existsSync(lock), 'a release by another pid leaves the lock');
  releaseLock(lock, process.pid);
  assert.deepEqual(readdirSync(dir), []);
  const run = spawnSync(process.execPath, [SCRIPT, '--root', root, '--out', out], { encoding: 'utf8', env: { ...process.env, [LOCK_ENV]: lock } });
  assert.equal(run.status, EXIT.failed);
  assert.deepEqual(readdirSync(dir), [], 'the run released the lock on exit');
});

test('failureLines does not give a not-ok line without a YAML block the next test error', () => {
  const tap = ['not ok 1 - a', 'not ok 2 - b', '  ---', "  error: 'boom'", '  ...'].join('\n');
  assert.deepEqual(failureLines(tap), ['a', 'b: boom']);
});
