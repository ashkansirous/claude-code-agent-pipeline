#!/usr/bin/env node
// Waits for a cloud-built slice (Slice 07).
//   cloud-wait.mjs <pr> --run-file <path> [--max-minutes N] [--poll-seconds N] [--no-checks-grace-minutes N] [--repo <dir>]
// A script cannot call RemoteTrigger, so the coordinator writes what it read from `list_runs` / `get_run_log` to the
// run file, JSON { "status": "<run status>", "lastLine": "<last log line>" }, and this script re-reads it on every poll.
// It owns what gh and git can see: the branch head, the PR state, the checks, and pushes after done.
// The last output line is one of: done | failed <why> | cancelled (PR closed) | superseded (new pushes, or "superseded PR merged")
// | checks-failing <sha> <what>.
// Exit code 0 only for done; checks-failing (pushed, a check is red: keep the branch, fix locally) is exit 5.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT_DONE = 0;
export const EXIT_FAILED = 1;
export const EXIT_CANCELLED = 2;
export const EXIT_SUPERSEDED = 3;
export const EXIT_USAGE = 4;
export const EXIT_CHECKS_FAILING = 5;

const DEFAULT_MAX_MINUTES = 120;
const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_NO_CHECKS_GRACE_MINUTES = 3;
const GH_FAILURE_LIMIT = 5;
const GIT_FAILURE_LIMIT = 5;
const RED_BUCKETS = new Set(['fail', 'cancel']);
const OPTIONS_WITH_VALUE = new Set(['--run-file', '--max-minutes', '--poll-seconds', '--no-checks-grace-minutes', '--repo']);
const MS_PER_MINUTE = 60000;
const MS_PER_SECOND = 1000;
const GH_MAX_BUFFER = 64 * 1024 * 1024;
const STATE_CLOSED = 'CLOSED';
const STATE_MERGED = 'MERGED';
const FAILED_RUN_STATUSES = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled', 'timed_out', 'timeout']);
const ENDED_RUN_STATUSES = new Set(['completed', 'succeeded', 'success', 'finished', 'ended', 'done']);
const NO_CHECKS_TEXT = 'no checks reported';
const DONE_LINE = /^CLOUD DONE ([0-9a-f]{7,40}) pushed=yes(?: checks=failing\s*(.*))?$/;
const BLOCKED_LINE = /^CLOUD BLOCKED\s*(.*)$/;
const USAGE = 'usage: cloud-wait.mjs <pr> --run-file <path> [--max-minutes N] [--poll-seconds N] [--no-checks-grace-minutes N] [--repo <dir>]';

// ---- reading the run ----

export function parseLastLine(line) {
  const text = String(line ?? '').trim();
  const done = DONE_LINE.exec(text);
  if (done) return { kind: 'done', sha: done[1], checksFailing: text.includes('checks=failing'), detail: done[2] ?? '' };
  const blocked = BLOCKED_LINE.exec(text);
  if (blocked) return { kind: 'blocked', detail: blocked[1] };
  return { kind: 'none' };
}

// A missing, unreadable or malformed file is "no result yet", never a crash.
export function readRunFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

// What the run says on its own: 'done' / 'failed' with a reason, or null while it is still going.
export function judgeRun(run) {
  if (!run) return null;
  const last = parseLastLine(run.lastLine);
  if (last.kind === 'blocked') return { verdict: 'failed', why: `CLOUD BLOCKED ${last.detail}`.trim() };
  if (last.kind === 'done' && last.checksFailing) return { verdict: 'checks-failing', sha: last.sha, why: last.detail };
  if (last.kind === 'done') return { verdict: 'done', sha: last.sha };
  const status = String(run.status ?? '').toLowerCase();
  if (FAILED_RUN_STATUSES.has(status)) return { verdict: 'failed', why: `run status ${status}` };
  if (ENDED_RUN_STATUSES.has(status)) return { verdict: 'failed', why: 'run ended with no CLOUD DONE line' };
  return null;
}

// ---- what gh and git can see ----

// { ok: true, view } or { ok: false, error }: a gh failure is never the same as "the PR is still open".
function prView(ctx) {
  const r = ghIn(ctx, ['pr', 'view', ctx.pr, '--json', 'state,headRefName']);
  if (r.status !== 0) return { ok: false, error: firstLine(r.stderr || r.stdout) || `exit ${r.status}` };
  try { return { ok: true, view: JSON.parse(r.stdout) }; } catch { return { ok: false, error: 'gh pr view printed no JSON' }; }
}

function firstLine(text) { return String(text ?? '').trim().split(/\r?\n/)[0] ?? ''; }

// gh runs in the repo the wait was given, not in whatever directory the script was started from.
function ghIn(ctx, args, options = {}) { return ctx.deps.gh(args, { ...options, cwd: ctx.repo }); }

// { ok: true, head } (head null when the branch is not on origin) or { ok: false, error }: a git failure is not "nothing pushed".
export function remoteHead(ctx, branch) {
  try {
    const line = ctx.deps.git(ctx.repo, ['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\r?\n/)[0] ?? '';
    return { ok: true, head: line.split(/\s+/)[0] || null };
  } catch (e) { return { ok: false, error: firstLine(e.message) }; }
}

function shaMatches(head, sha) {
  return Boolean(head) && (head === sha || head.startsWith(sha) || sha.startsWith(head));
}

// The branch head moved on past the done sha (someone pushed on top of it): fetch it and test the ancestry.
// { ok: true, descends } or { ok: false, error } when the fetch itself failed (a failed ancestry test is just "not a descendant").
function headDescendsFrom(ctx, branch, sha) {
  try { ctx.deps.git(ctx.repo, ['fetch', 'origin', branch]); } catch (e) { return { ok: false, error: firstLine(e.message) }; }
  try {
    ctx.deps.git(ctx.repo, ['merge-base', '--is-ancestor', sha, `origin/${branch}`]);
    return { ok: true, descends: true };
  } catch { return { ok: true, descends: false }; }
}

// The verdict comes from `gh pr checks --json name,bucket`, never from the watch's text: red = any bucket fail or cancel.
function readChecks(ctx) {
  const r = ghIn(ctx, ['pr', 'checks', ctx.pr, '--json', 'name,bucket']);
  if (r.status !== 0) {
    if (`${r.stdout}\n${r.stderr}`.toLowerCase().includes(NO_CHECKS_TEXT)) return { kind: 'none' };
    return { kind: 'error', detail: firstLine(r.stderr || r.stdout) || `exit ${r.status}` };
  }
  let rows;
  try { rows = JSON.parse(r.stdout); } catch { return { kind: 'error', detail: 'gh pr checks printed no JSON' }; }
  if (!Array.isArray(rows)) return { kind: 'error', detail: 'gh pr checks printed no JSON list' };
  if (rows.length === 0) return { kind: 'none' };
  const red = rows.filter((row) => RED_BUCKETS.has(String(row.bucket).toLowerCase()));
  return red.length > 0 ? { kind: 'red', detail: red.map((row) => row.name).join(', ') } : { kind: 'ok' };
}

// 'ok' | 'red' (a check failed or was cancelled) | 'error' (gh itself failed) | 'timeout' | 'none' (no checks registered yet).
function runWatch(ctx, remainingMs) {
  const r = ghIn(ctx, ['pr', 'checks', ctx.pr, '--watch', '--fail-fast'], { timeoutMs: Math.max(remainingMs, 1) });
  if (r.timedOut) return { kind: 'timeout' };
  if (r.status !== 0 && `${r.stdout}\n${r.stderr}`.toLowerCase().includes(NO_CHECKS_TEXT)) return { kind: 'none' };
  const checks = readChecks(ctx);
  if (checks.kind === 'ok' && r.status !== 0) return { kind: 'error', detail: firstLine(r.stderr || r.stdout) || `exit ${r.status}` };
  return checks;
}

// A repo with no checks for the PR (a docs-only PR) has nothing to be red, but "no checks reported" right after a push
// also means GitHub has not registered the workflows yet: re-poll for the grace window before counting it green.
async function watchChecks(ctx, deadline) {
  const graceEnd = ctx.deps.now().getTime() + ctx.noChecksGraceMinutes * MS_PER_MINUTE;
  for (;;) {
    const watched = runWatch(ctx, deadline - ctx.deps.now().getTime());
    if (watched.kind === 'ok') return { ok: true };
    if (watched.kind === 'red') return { ok: false, red: true, why: `checks are red ${watched.detail}`.trim() };
    if (watched.kind === 'error') return { ok: false, why: `gh pr checks failed: ${watched.detail}` };
    if (watched.kind === 'timeout') return { ok: false, why: 'time limit reached while the checks were running' };
    const now = ctx.deps.now().getTime();
    if (now >= graceEnd || now >= deadline) return { ok: true };
    await ctx.deps.sleep(ctx.pollMs);
  }
}

// ---- the wait ----

function result(code, line) { return { code, line }; }

// A MERGED PR is not an abandoned one: the work landed, so the coordinator must not rebuild it.
function closedResult(view) {
  const prState = String(view.state).toUpperCase();
  if (prState === STATE_MERGED) return result(EXIT_SUPERSEDED, 'superseded PR merged');
  if (prState === STATE_CLOSED) return result(EXIT_CANCELLED, 'cancelled');
  return null;
}

// Five git failures in a row end the wait naming git. Each kind of git call (ls-remote, fetch) counts on its own,
// so a good ls-remote in the same poll does not reset a failing fetch.
function gitFailureResult(state, outcome, kind) {
  state.gitFailureCounts ??= {};
  const count = outcome.ok ? 0 : (state.gitFailureCounts[kind] ?? 0) + 1;
  state.gitFailureCounts[kind] = count;
  state.gitFailures = Math.max(...Object.values(state.gitFailureCounts));
  if (!outcome.ok) state.lastGitError = outcome.error;
  if (count < GIT_FAILURE_LIMIT) return null;
  return result(EXIT_FAILED, `failed git failed ${count} times in a row: ${state.lastGitError}`);
}

// The head is not the CLOUD DONE sha: newer work on top of it is superseded; anything else is not what the run said it pushed.
function headMismatchResult(ctx, state, branch, head, sha) {
  if (!head) return null;
  const descent = headDescendsFrom(ctx, branch, sha);
  const gitFailed = gitFailureResult(state, descent, 'fetch');
  if (gitFailed) return gitFailed;
  if (!descent.ok) return null;
  if (descent.descends) return result(EXIT_SUPERSEDED, 'superseded');
  return result(EXIT_FAILED, `failed head ${head} is not the CLOUD DONE sha ${sha}`);
}

// One look at the PR and the run: a final result, or null to keep polling.
function pollOnce(ctx, state) {
  const looked = prView(ctx);
  state.ghFailures = looked.ok ? 0 : (state.ghFailures ?? 0) + 1;
  if (!looked.ok) state.lastGhError = looked.error;
  if (state.ghFailures >= GH_FAILURE_LIMIT) return result(EXIT_FAILED, `failed gh pr view failed ${state.ghFailures} times in a row: ${state.lastGhError}`);
  const view = looked.ok ? looked.view : null;
  const closed = view ? closedResult(view) : null;
  if (closed) return closed;
  const judged = judgeRun(ctx.deps.readRunFile(ctx.runFile));
  if (!judged) return null;
  if (judged.verdict === 'failed') return result(EXIT_FAILED, `failed ${judged.why}`);
  const branch = view?.headRefName;
  if (!branch) return null;
  const headed = remoteHead(ctx, branch);
  const gitFailed = gitFailureResult(state, headed, 'ls-remote');
  if (gitFailed) return gitFailed;
  if (!headed.ok) return null;
  if (!shaMatches(headed.head, judged.sha)) return headMismatchResult(ctx, state, branch, headed.head, judged.sha);
  if (judged.verdict === 'checks-failing') return result(EXIT_CHECKS_FAILING, `checks-failing ${judged.sha} ${judged.why}`.trim());
  state.sha = judged.sha;
  state.branch = branch;
  return 'finished';
}

// After done: new pushes mean the branch moved on without us. A gh failure here is not a closed PR; the branch head still decides.
function afterChecks(ctx, state) {
  const looked = prView(ctx);
  const closed = looked.ok ? closedResult(looked.view) : null;
  if (closed) return closed;
  const headed = remoteHead(ctx, state.branch);
  if (!headed.ok) return result(EXIT_FAILED, `failed git ls-remote failed: ${headed.error}`);
  if (!shaMatches(headed.head, state.sha)) return result(EXIT_SUPERSEDED, 'superseded');
  return result(EXIT_DONE, 'done');
}

function timeLimitLine(ctx, state) {
  let cause = ' (nothing pushed or no CLOUD DONE line)';
  if (state.gitFailures > 0) cause = `; git was failing: ${state.lastGitError}`;
  if (state.ghFailures > 0) cause = `; gh pr view was failing: ${state.lastGhError}`;
  return `failed no result after ${ctx.maxMinutes} minutes${cause}`;
}

export async function waitForCloud(ctx) {
  const deadline = ctx.deps.now().getTime() + ctx.maxMinutes * MS_PER_MINUTE;
  const state = {};
  for (;;) {
    const polled = pollOnce(ctx, state);
    if (polled && polled !== 'finished') return polled;
    if (polled === 'finished') return finishAfterDone(ctx, state, deadline);
    if (ctx.deps.now().getTime() >= deadline) return result(EXIT_FAILED, timeLimitLine(ctx, state));
    await ctx.deps.sleep(ctx.pollMs);
  }
}

async function finishAfterDone(ctx, state, deadline) {
  const before = afterChecks(ctx, state);
  if (before.code !== EXIT_DONE) return before;
  const checks = await watchChecks(ctx, deadline);
  if (checks.red) return result(EXIT_CHECKS_FAILING, `checks-failing ${state.sha} ${checks.why}`);
  if (!checks.ok) return result(EXIT_FAILED, `failed ${checks.why}`);
  return afterChecks(ctx, state);
}

// ---- command line ----

function numberOption(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const value = Number(args[i + 1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function stringOption(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
}

// The first argument that is not an option and not the value of one.
function positionalPr(args) {
  for (let i = 0; i < args.length; i++) {
    if (OPTIONS_WITH_VALUE.has(args[i])) { i++; continue; }
    if (/^\d+$/.test(args[i])) return args[i];
  }
  return null;
}

function realGh(args, options = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: GH_MAX_BUFFER, cwd: options.cwd });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const stderr = (r.stderr ?? '') + (r.error && !timedOut ? r.error.message : '');
  return { status: r.status, stdout: r.stdout ?? '', stderr, timedOut };
}

function realGit(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const realSleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function run(argv, deps = {}) {
  const full = { gh: realGh, git: realGit, readRunFile, now: () => new Date(), sleep: realSleep, out: console.log, ...deps };
  const pr = positionalPr(argv);
  const runFile = stringOption(argv, '--run-file');
  const maxMinutes = numberOption(argv, '--max-minutes', DEFAULT_MAX_MINUTES);
  const pollSeconds = numberOption(argv, '--poll-seconds', DEFAULT_POLL_SECONDS);
  const noChecksGraceMinutes = numberOption(argv, '--no-checks-grace-minutes', DEFAULT_NO_CHECKS_GRACE_MINUTES);
  if (!pr || !runFile || maxMinutes === null || pollSeconds === null || noChecksGraceMinutes === null) { full.out(USAGE); return EXIT_USAGE; }
  const ctx = { pr, runFile, maxMinutes, noChecksGraceMinutes, pollMs: pollSeconds * MS_PER_SECOND, repo: stringOption(argv, '--repo') ?? process.cwd(), deps: full };
  const outcome = await waitForCloud(ctx);
  full.out(outcome.line);
  return outcome.code;
}

// ~/.claude/skills/run-wave is a symlink into this repo: compare real paths, or the script does nothing and exits 0.
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl)); } catch { return resolve(argvPath) === resolve(fileURLToPath(moduleUrl)); }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((e) => { console.error(e.message); process.exitCode = EXIT_USAGE; });
}
