#!/usr/bin/env node
// Runs this repo's whole suite in per-file chunks (Slice 17 part B) and writes what the coordinator needs to
// trust the result: each test file's own exit code, the skipped tests, and the hash of the code tree it ran on.
//   node .github/scripts/run-suite.mjs [--root <dir>] [--out <summary.md>] [--budget-ms <n>] [--resume] [--rerun <a.test.mjs,b.test.mjs>]
//                                      [--timeout-ms <n>] [--tests <a.test.mjs,b.test.mjs>]
// --root       the worktree to test (default: the current folder); every file runs as `node --test <file>` there.
// --out        the summary file (default `<root>/../reviews/suite-summary.md`, a `.json` twin beside it keeps the results).
//              List it in the PR's `## Review` section: merge-gate.mjs compares its `Suite code tree:` line with the PR head.
// --budget-ms  stop starting new files after this many ms and exit 3 ("incomplete"); run again with --resume, which keeps
//              the results the JSON twin holds for the same tree, except a file that timed out or died without an exit code (an
//              outside kill or a cap: not a real failure), which runs again. Keeps each call under a tool's 10-minute limit.
// --rerun      like --resume, and also drops these files' saved results so they run again (no hand-edited state file).
// --timeout-ms per-file limit (default 1200000); a file that hits it counts as failed ("timeout").
// --tests      run only these files (a test seam, and a way to rerun one failed file).
// --jobs       how many files run side by side (default 4; Slice 30 item A).
// --changed    run only the test files select-tests.mjs picks for the diff against --base (default origin/main); the summary
//              says "Selected run" with each file's reason, and merge-gate.mjs accepts it when it covers the PR's selection.
//              A change under .github/ makes it a full run. A file over its time budget is flagged "OVER BUDGET" (not failed).
// Never run it while a fixer still edits the tree: the tree hash changes and the summary no longer matches the PR head.
// One suite per host at a time (Slice 29 item 1): the command line takes a host-wide lock file (`run-suite.lock` in the OS
// temp folder, or RUN_SUITE_LOCK_FILE: a test seam) holding the pid and start time; a second run exits 4 naming the first's
// pid. A lock whose pid is gone is stale and is taken over. Each failed file's failing test names and first error lines go
// into the summary (item 23). No SIGINT/SIGTERM handlers (one would stop Ctrl+C working); a killed run leaves a lock whose pid is gone, which the stale check takes over.
// Exit 0 when every file exited 0, 1 when any failed, 3 when the budget stopped it, 2 on a usage error, 4 when another suite holds the lock.
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMEOUT_EXIT } from './run-one.mjs';
import { selectAffected } from './select-tests.mjs';
import { codeTreeHash, contentPathsFor } from '../../skills/run-wave/merge-gate.mjs';

export const EXIT = { ok: 0, failed: 1, usage: 2, incomplete: 3, busy: 4 };
export const TREE_LABEL = 'Suite code tree:';
export const SUBSET_LINE = 'Subset run';
export const SELECTED_LINE = 'Selected run';
const TEST_SUFFIX = '.test.mjs';
// 20 minutes: the slowest test files take 13-14 minutes under load. Do not name a test file in this source: the Windows
// test selection reads file names in sources as dependencies, so it would tie that test to every test that imports this script.
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
// Per-file cap overrides, keyed by repo-relative path; empty while every file fits the default cap.
export const FILE_TIMEOUT_MS = {};
// The cap for one file: --timeout-ms when given (null means not given, and applies to every file); else the file's override,
// bounded only by its own value (the budget decides whether the next file starts); else the default.
export function timeoutFor(file, timeoutMs) {
  if (timeoutMs !== null && timeoutMs !== undefined) return timeoutMs;
  return FILE_TIMEOUT_MS[file] ?? DEFAULT_TIMEOUT_MS;
}
export const DEFAULT_JOBS = 4;
export const DEFAULT_BASE = 'origin/main';
const MAX_BUFFER = 256 * 1024 * 1024;
// run-one.mjs forces `--test-reporter=tap`, so the output does not depend on the default reporter (tap or spec by node version/TTY).
const SKIP_LINE = /^\s*(?:not )?ok \d+ - .*# SKIP\b/;
const SKIP_COUNT = /^# skipped (\d+)/m;
const COUNTS = { pass: /^# pass (\d+)/m, fail: /^# fail (\d+)/m };
const SKIP_LINES_MAX = 5;
const FAILURES_MAX = 8;
const ERROR_LINES_MAX = 3;
const NOT_OK_LINE = /^(\s*)not ok \d+ - (.*)$/;
const YAML_END = /^\s*\.\.\.\s*$/;
const TEST_RESULT_LINE = /^(\s*)(?:not )?ok \d+ - /;
const ERROR_FIELD = /^\s*error: (.*)$/;
const FAILURE_TYPE_FIELD = /^\s*failureType: '(.*)'/;
const PARENT_FAILURE_TYPE = 'subtestsFailed';
export const LOCK_ENV = 'RUN_SUITE_LOCK_FILE';
const RUN_ONE = fileURLToPath(new URL('./run-one.mjs', import.meta.url));
const BACKSTOP_MS = 15000;

function git(root, args, env = process.env) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function testFiles(root) {
  // -co: tracked and new untracked files (the suite runs before the commit, and the tree hash counts untracked files too).
  // A tracked file deleted or renamed in the working tree is still listed by ls-files and `node --test` fails on it: skip it.
  return git(root, ['ls-files', '-co', '--exclude-standard']).split(/\r?\n/)
    .filter((f) => f.endsWith(TEST_SUFFIX) && existsSync(join(root, f))).sort();
}

// path -> blob sha of the working tree as a commit of it would hold it (a throwaway index, the real one untouched).
export function workingTreeEntries(root) {
  const dir = mkdtempSync(join(tmpdir(), 'run-suite-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
    git(root, ['read-tree', 'HEAD'], env);
    git(root, ['add', '-A'], env);
    return git(root, ['ls-files', '-s', '-z'], env).split('\0').filter(Boolean).map((line) => {
      const match = /^\S+ ([0-9a-f]+) \d\t([\s\S]*)$/.exec(line);
      return [match[2], match[1]];
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// The files the branch itself changed against origin/main's merge base (the PR's file list, as the merge gate sees it) plus new
// untracked ones; the tree hash leaves out workflow files not in it (Slice 29 item 2). null (unknown: keep every workflow
// file in the hash, as the merge gate does) when origin/main or the merge base cannot be read.
export function ownChangedFiles(root) {
  try {
    const base = git(root, ['merge-base', 'HEAD', 'origin/main']).trim();
    const changed = git(root, ['diff', '--name-only', '-z', base]).split('\0');
    const added = git(root, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0');
    return new Set([...changed, ...added].filter(Boolean));
  } catch { return null; }
}

export function diffHash(root) {
  return createHash('sha256').update(git(root, ['diff', 'HEAD'])).digest('hex');
}

// Slice 30 item H: the seconds a file may take before the summary marks it. Default 60; the run-all-waves driver tests
// start many processes per test and get more. A file over its budget is flagged, not failed: the run still passes.
export const DEFAULT_BUDGET_S = 60;
export const FILE_BUDGET_S = {};
// Prefixes, not file names: the Windows test selection reads file names in sources as dependencies (see DEFAULT_TIMEOUT_MS).
const SLOW_BUDGET_S = 120;
const SLOW_PREFIXES = ['skills/run-all-waves/run-all-waves.test'];
export function budgetFor(file) {
  if (FILE_BUDGET_S[file] !== undefined) return FILE_BUDGET_S[file];
  return SLOW_PREFIXES.some((p) => file.startsWith(p)) ? SLOW_BUDGET_S : DEFAULT_BUDGET_S;
}
// The first lines of a TAP `error:` field: a one-line value, or the indented block after `error: |-`.
function errorLines(block, fieldIndex) {
  const value = ERROR_FIELD.exec(block[fieldIndex])[1].trim();
  if (!/^[|>][-+]?$/.test(value)) return [value.replace(/^'|'$/g, '')];
  const indent = /^\s*/.exec(block[fieldIndex])[0].length;
  const lines = [];
  for (const line of block.slice(fieldIndex + 1)) {
    if (/^\s*$/.test(line)) continue;
    if (/^\s*/.exec(line)[0].length <= indent) break;
    lines.push(line.trim());
  }
  return lines.slice(0, ERROR_LINES_MAX);
}

// Failing tests of one TAP output as `name: first error line(s)`; a parent that only says "N subtests failed" is left out.
export function failureLines(out) {
  const lines = out.split(/\r?\n/);
  const failures = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = NOT_OK_LINE.exec(lines[i]);
    if (!head || /# (SKIP|TODO)\b/.test(head[2])) continue;
    const next = (l) => (TEST_RESULT_LINE.exec(l)?.[1].length ?? Infinity) <= head[1].length;
    const end = lines.findIndex((l, j) => j > i && (YAML_END.test(l) || next(l)));
    const block = lines.slice(i + 1, end < 0 ? lines.length : end);
    if (block.some((l) => FAILURE_TYPE_FIELD.exec(l)?.[1] === PARENT_FAILURE_TYPE)) continue;
    const field = block.findIndex((l) => ERROR_FIELD.test(l));
    const detail = field < 0 ? [] : errorLines(block, field);
    failures.push(`${head[2]}${detail.length ? `: ${detail.join(' | ')}` : ''}`.slice(0, 300));
  }
  return failures.slice(0, FAILURES_MAX);
}

// What one `node --test <file>` run said: its exit code (or `timeout`), counts, skipped tests. Async so files can run side by side.
export function runOne(root, file, timeoutMs) {
  const started = Date.now();
  // NODE_TEST_CONTEXT would make a `node --test` started from inside a test run behave as a child of it (exit 0, no counts).
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  return new Promise((done) => {
    // run-one.mjs kills the whole process tree at the cap; this timer (a little later) is only a backstop.
    const child = spawn(process.execPath, [RUN_ONE, root, file, String(timeoutMs)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let backstop = false;
    const timer = setTimeout(() => { backstop = true; child.kill('SIGKILL'); }, timeoutMs + BACKSTOP_MS);
    child.on('close', (status) => {
      clearTimeout(timer);
      done(resultFrom(file, out, backstop || status === TIMEOUT_EXIT ? 'timeout' : (status ?? 'error'), started));
    });
  });
}

function resultFrom(file, out, code, started) {
  const count = (re) => Number(re.exec(out)?.[1] ?? 0);
  const skips = out.split(/\r?\n/).filter((l) => SKIP_LINE.test(l)).map((l) => l.trim().slice(0, 200));
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  return { file, code, pass: count(COUNTS.pass), fail: count(COUNTS.fail), skipped: count(SKIP_COUNT), skips: skips.slice(0, SKIP_LINES_MAX), failures: code === 0 ? [] : failureLines(out), seconds };
}

const overBudget = (r) => r.seconds > budgetFor(r.file);

// `selected` ({ base, picks: [{ file, reason }] }) marks a --changed run: the gate recomputes the selection for the PR.
export function summaryText(tree, diff, results, total, subset = false, selected = null) {
  const failed = results.filter((r) => r.code !== 0);
  const skipped = results.filter((r) => r.skipped > 0);
  const slow = results.filter(overBudget);
  const lines = [
    '# Suite summary',
    '',
    `${TREE_LABEL} ${tree}`,
    `Diff HEAD hash: ${diff}`,
    `Files run: ${results.length} of ${total}; failed: ${failed.length}; files with skipped tests: ${skipped.length}`,
    ...(subset ? [`${SUBSET_LINE} (--tests): not the whole suite`] : []),
    ...(selected ? [`${SELECTED_LINE} (--changed) against ${selected.base}: ${selected.picks.length} file(s) picked by select-tests.mjs`] : []),
    '',
    ...results.map((r) => `exit ${r.code}  ${r.file}  (pass ${r.pass}, fail ${r.fail}, skipped ${r.skipped}, ${r.seconds}s)${overBudget(r) ? ` OVER BUDGET (${budgetFor(r.file)}s)` : ''}`),
  ];
  if (selected) lines.push('', 'Selected because:', ...selected.picks.map((p) => `  ${p.file}: ${p.reason}`));
  if (slow.length) lines.push('', 'Over budget (flagged, not failed):', ...slow.map((r) => `  ${r.file}: ${r.seconds}s of ${budgetFor(r.file)}s`));
  if (skipped.length) lines.push('', 'Skipped tests:', ...skipped.flatMap((r) => [`${r.file}: ${r.skipped}`, ...r.skips.map((s) => `  ${s}`)]));
  const withFailures = failed.filter((r) => r.failures?.length);
  if (withFailures.length) lines.push('', 'Failed tests:', ...withFailures.flatMap((r) => [`${r.file}:`, ...r.failures.map((f) => `  ${f}`)]));
  lines.push('', results.length < total ? 'INCOMPLETE: run again with --resume.' : (failed.length ? `FAILED: ${failed.map((r) => r.file).join(', ')}` : 'All files exited 0.'));
  return `${lines.join('\n')}\n`;
}

export function parseCli(argv) {
  const options = { root: process.cwd(), out: '', budgetMs: Infinity, timeoutMs: null, resume: false, rerun: [], tests: null, jobs: DEFAULT_JOBS, changed: false, base: DEFAULT_BASE };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--resume') options.resume = true;
    else if (flag === '--rerun') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--rerun needs a comma-separated list of test files');
      options.rerun = value.split(',').filter(Boolean).map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''));
      options.resume = true;
    }
    else if (flag === '--root') options.root = resolve(argv[++i]);
    else if (flag === '--out') options.out = resolve(argv[++i]);
    else if (flag === '--budget-ms') options.budgetMs = Number(argv[++i]);
    else if (flag === '--timeout-ms') options.timeoutMs = Number(argv[++i]);
    else if (flag === '--tests') options.tests = String(argv[++i]).split(',').filter(Boolean);
    else if (flag === '--jobs') options.jobs = Number(argv[++i]);
    else if (flag === '--changed') options.changed = true;
    else if (flag === '--base') options.base = String(argv[++i]);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!Number.isInteger(options.jobs) || options.jobs < 1) throw new Error('--jobs needs a whole number of 1 or more');
  if ((options.timeoutMs !== null && !Number.isFinite(options.timeoutMs)) || Number.isNaN(options.budgetMs)) throw new Error('--budget-ms and --timeout-ms need numbers');
  options.out ||= join(dirname(options.root), 'reviews', 'suite-summary.md');
  return options;
}

// A result an outside kill or a cap produced (`timeout`, or `error`: no exit code) is not a real failure: resume runs it again.
const KILLED_CODES = ['timeout', 'error'];

function previousResults(jsonFile, tree, options) {
  if (!options.resume || !existsSync(jsonFile)) return [];
  try {
    const saved = JSON.parse(readFileSync(jsonFile, 'utf8'));
    if (saved.tree !== tree) return [];
    return saved.results.filter((r) => !KILLED_CODES.includes(r.code) && !options.rerun.includes(r.file));
  } catch { return []; }
}

// Runs the files, writes the summary and its JSON twin, returns the exit code.
export async function runSuite(options, log = (text) => process.stdout.write(text)) {
  // The same base-branch contentPaths the merge gate hashes the PR head with, or the two hashes never match.
  const tree = codeTreeHash(workingTreeEntries(options.root), contentPathsFor({}, options.root, git), ownChangedFiles(options.root));
  const plan = planFiles(options, log);
  const jsonFile = options.out.replace(/\.md$/, '') + '.json';
  const unknown = options.rerun.filter((f) => !plan.files.includes(f));
  if (unknown.length) throw new Error(`--rerun names no planned test file: ${unknown.join(', ')}`);
  const results = previousResults(jsonFile, tree, options).filter((r) => plan.files.includes(r.file));
  const queue = plan.files.filter((f) => !results.some((r) => r.file === f));
  const state = { begun: Date.now(), started: 0, stop: false };
  const save = () => saveSummary(options, jsonFile, tree, results, plan);
  const worker = async () => {
    while (!state.stop && queue.length) {
      const file = queue.shift();
      const result = await runBounded(options, file, state);
      if (!result) continue;
      results.push(result);
      log(`exit ${result.code}  ${file}\n`);
      save();
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.jobs, Math.max(queue.length, 1)) }, worker));
  save();
  // Incomplete wins over failed: a caller repeating while the exit is 3 must reach every file; the failures stay in the summary.
  if (results.length < plan.files.length) return EXIT.incomplete;
  return results.some((r) => r.code !== 0) ? EXIT.failed : EXIT.ok;
}

// One file under the budget; null when the budget cut it (not a result: the next call starts it).
async function runBounded(options, file, state) {
  const remaining = options.budgetMs - (Date.now() - state.begun);
  if (remaining <= 0) { state.stop = true; return null; }
  // The first file of a call always gets the full per-file cap, so --resume always progresses (a file longer than the
  // budget would otherwise be cut every time). Later files never run past the budget, so a call stays under the tool's
  // limit; a file the budget cut is not a result and starts the next call.
  const cap = timeoutFor(file, options.timeoutMs);
  const bounded = state.started > 0 && remaining < cap;
  state.started += 1;
  const result = await runOne(options.root, file, bounded ? Math.ceil(remaining) : cap);
  if (bounded && result.code === 'timeout') { state.stop = true; return null; }
  return result;
}

// The files to run: --tests, or --changed's selection (a full run when the diff touches the runner), or every test file.
function planFiles(options, log) {
  if (options.tests) return { files: options.tests, subset: true, selected: null };
  if (!options.changed) return { files: testFiles(options.root), subset: false, selected: null };
  const all = testFiles(options.root);
  const sel = selectAffected(changedFiles(options.root, options.base), listWorkingFiles(options.root), (f) => readFileSync(join(options.root, f), 'utf8'));
  if (sel.all) {
    log('--changed: a .github/ file changed, so this is a full run\n');
    return { files: all, subset: false, selected: null };
  }
  const picks = sel.picks.filter((p) => all.includes(p.file));
  return { files: picks.map((p) => p.file), subset: false, selected: { base: options.base, picks } };
}

// Files changed against the merge base with `base` (committed, staged and unstaged) plus untracked ones.
export function changedFiles(root, base) {
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  const diff = git(root, ['diff', '--name-only', '--no-renames', mergeBase]).split(/\r?\n/);
  const untracked = git(root, ['ls-files', '-o', '--exclude-standard']).split(/\r?\n/);
  return [...new Set([...diff, ...untracked].filter(Boolean))];
}

function listWorkingFiles(root) {
  return git(root, ['ls-files', '-co', '--exclude-standard']).split(/\r?\n/).filter((f) => f && existsSync(join(root, f)));
}

function saveSummary(options, jsonFile, tree, results, plan) {
  const ordered = plan.files.map((f) => results.find((r) => r.file === f)).filter(Boolean);
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, summaryText(tree, diffHash(options.root), ordered, plan.files.length, plan.subset, plan.selected));
  writeFileSync(jsonFile, JSON.stringify({ tree, results: ordered }));
}

export function lockPath() {
  return process.env[LOCK_ENV] || join(tmpdir(), 'run-suite.lock');
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// When the process with this pid started (an ISO string, whole seconds), or null when it cannot be read. A reused pid has
// another start time, so the pid alone never proves the suite that wrote the lock is still running.
export function processStartTime(pid) {
  const win = process.platform === 'win32';
  const command = win ? 'powershell' : 'ps';
  const args = win
    ? ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString('s')`]
    : ['-o', 'lstart=', '-p', String(Number(pid))];
  const run = spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
  const text = (run.stdout ?? '').trim();
  return run.status === 0 && text ? text : null;
}

// A lock is stale when its pid is gone, or both start times are known and differ (a reused pid). A live pid with an unknown
// start time counts as live: a documented limit, since the start time cannot always be read.
function lockIsLive(holder, startOf) {
  if (!holder || !Number.isInteger(holder.pid) || !pidAlive(holder.pid)) return false;
  if (!holder.processStart) return true;
  const now = startOf(holder.pid);
  return now === null || now === holder.processStart;
}

function uniqueSibling(file, label) {
  return `${file}.${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseHolder(text) {
  try { return JSON.parse(text); } catch { return { pid: 0, started: 'unknown' }; }
}

// Writes the lock content to a temp file, then hard-links it to the lock path: the link is atomic, so the lock never exists
// half-written. Returns true when taken, false when the lock exists (EEXIST).
function tryCreateLock(file, content) {
  const tmp = uniqueSibling(file, 'tmp');
  writeFileSync(tmp, content);
  try {
    linkSync(tmp, file);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Moves the stale lock aside in one atomic rename, so only one of two racing runs takes it over. Returns null when the file
// moved was the stale content read (the caller retries the acquire); else the file moved was a newer lock: it is linked back
// (when that fails someone holds a newer one still) and its holder is returned.
function takeStaleLock(file, staleText) {
  const aside = uniqueSibling(file, 'stale');
  try { renameSync(file, aside); } catch { return null; }
  let movedText = '';
  try { movedText = readFileSync(aside, 'utf8'); } catch { /* gone */ }
  if (movedText === staleText) { rmSync(aside, { force: true }); return null; }
  try { linkSync(aside, file); } catch { /* another run already holds a new lock */ }
  rmSync(aside, { force: true });
  return parseHolder(movedText);
}

// Takes the host-wide lock; returns null when taken, else the live holder `{ pid, started }` (a stale lock is replaced).
// The lock holds the pid and the process start time; startOf is a test seam.
export function acquireLock(file = lockPath(), pid = process.pid, startOf = processStartTime) {
  const content = JSON.stringify({ pid, started: new Date().toISOString(), processStart: startOf(pid) });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (tryCreateLock(file, content)) return null;
    let staleText = '';
    let holder = null;
    try { staleText = readFileSync(file, 'utf8'); holder = JSON.parse(staleText); } catch { /* unreadable: treated as stale */ }
    if (lockIsLive(holder, startOf)) return holder;
    const raced = takeStaleLock(file, staleText);
    if (raced) return raced;
  }
  return { pid: 0, started: 'unknown' };
}

export function releaseLock(file = lockPath(), pid = process.pid) {
  try {
    if (JSON.parse(readFileSync(file, 'utf8')).pid === pid) rmSync(file, { force: true });
  } catch { /* already gone */ }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let locked = false;
  try {
    const options = parseCli(process.argv.slice(2));
    const holder = acquireLock();
    if (holder) {
      process.stderr.write(`run-suite: another suite already runs on this host (pid ${holder.pid}, started ${holder.started}); wait for it, then run again. Lock: ${lockPath()}\n`);
      process.exit(EXIT.busy);
    }
    locked = true;
    process.on('exit', () => releaseLock());
    const code = await runSuite(options);
    process.stdout.write(`summary: ${options.out}\n`);
    releaseLock();
    process.exit(code);
  } catch (error) {
    if (locked) releaseLock();
    process.stderr.write(`run-suite: ${error.message}\n`);
    process.exit(EXIT.usage);
  }
}
