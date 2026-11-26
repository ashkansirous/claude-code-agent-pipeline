#!/usr/bin/env node
// Usage: node push-branch.mjs <worktree> <branch>
// The one command for a branch's first push: refuses unless HEAD of <worktree> is on <branch> and has at
// least one commit that origin/main lacks; runs the slice-number check (parallel_check.py --check-slice, the
// same one push-guard.mjs wants) when the repo has docs/plan/slices; then `git push -u origin <branch>`.
// push-guard.mjs does not touch a call of this helper, because the push happens inside it, after the check.
// Exit 0 pushed, 1 refused or check failed, 2 bad usage. (2026-11-01, ReadTheStupidText: ship-branch's
// `commit && push` chains were denied by the guard and nobody knew whether the commit had run.)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inSliceRepo, isEntryPoint } from './push-guard.mjs';

const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const MAIN_REF = 'origin/main';
const CHECKER = join(dirname(fileURLToPath(import.meta.url)), 'parallel_check.py');
const PYTHONS = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];

function git(worktree, ...args) {
  const run = spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { ok: run.status === 0, out: (run.stdout ?? '').trim(), err: (run.stderr ?? '').trim() };
}

// Returns an error sentence when the branch argument is the trunk, HEAD, a refspec or an option; else null.
export function branchProblem(branch) {
  if (branch === 'main' || branch === 'HEAD') return `refusing to push "${branch}"; push a feature branch. Nothing was pushed.`;
  if (branch.includes(':') || branch.startsWith('-')) return `"${branch}" is not a plain branch name (no refspecs, no options). Nothing was pushed.`;
  return null;
}

// Returns an error sentence, or null when HEAD is on the branch with a commit ahead of origin/main.
export function headProblem(worktree, branch) {
  const head = git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (!head.ok) return `cannot read HEAD of ${worktree}: ${head.err}`;
  if (head.out !== branch) return `HEAD of ${worktree} is on "${head.out}", not "${branch}"; nothing was pushed.`;
  const fetch = git(worktree, 'fetch', '--quiet', 'origin', 'main');
  if (!fetch.ok) return `cannot fetch origin main, so the commits-ahead check would use a stale ref: ${fetch.err}. Nothing was pushed.`;
  const ahead = git(worktree, 'rev-list', '--count', `${MAIN_REF}..HEAD`);
  if (!ahead.ok) return `cannot compare with ${MAIN_REF} (fetch it first): ${ahead.err}`;
  return Number(ahead.out) > 0 ? null : `${branch} has no commit that ${MAIN_REF} lacks; commit first. Nothing was pushed.`;
}

// Slice 33 item 54: the skip-CI marker goes only in the merge subject (agents/ship-branch.md), never on a branch commit, or the PR
// gets no checks (index PR #75). GitHub's own markers: [skip ci], [ci skip], [no ci], [skip actions], [actions skip].
export const SKIP_CI_MARKER = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/i;
// GitHub honours the marker on a pull_request only in the head commit's message, so only HEAD is checked (an earlier commit that
// mentions it does not skip checks). Returns an error sentence naming HEAD when its message carries the marker, or null (also when git cannot say).
export function skipCiProblem(worktree, branch) {
  const log = git(worktree, 'log', '-1', '--format=%h%x09%B');
  if (!log.ok) return null;
  const [sha, ...body] = log.out.trim().split('\t');
  const hit = sha && SKIP_CI_MARKER.exec(body.join('\t'));
  if (!hit) return null;
  return `commit ${sha} on "${branch}" carries ${hit[0]}: the marker belongs only in the merge subject (agents/ship-branch.md), or the PR gets no checks. Reword the commit; nothing was pushed.`;
}

// True when this python starts and runs code (a Windows Store stub starts but exits non-zero).
export function pythonWorks(python) {
  const probe = spawnSync(python, ['-I', '-c', ''], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

// Runs parallel_check.py --check-slice with the first python that really runs; returns its exit status.
export function runSliceCheck(worktree, branch, pythons = PYTHONS, works = pythonWorks) {
  for (const python of pythons) {
    if (!works(python)) continue;
    const run = spawnSync(python, ['-I', CHECKER, worktree, '--check-slice', branch], { stdio: 'inherit' });
    return run.status ?? EXIT_REFUSED;
  }
  process.stderr.write('push-branch: no python found to run the slice-number check.\n');
  return EXIT_REFUSED;
}

// --- Warnings (Slice 33 items 5 and 60): printed to stderr, never refuse the push.

// The `**Touches:**` globs of a slice file's text: every backticked item on the line(s) with that label.
export function touchesGlobs(text) {
  return String(text).split(/\r?\n/).filter((l) => l.includes('**Touches:**'))
    .flatMap((l) => [...l.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim().replace(/\\/g, '/')));
}

// A Touches glob as a regex: `**` crosses folders, `*` does not; a path with no wildcard also matches what is under it.
export function globToRegex(glob) {
  const body = glob.replace(/\/+$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(?:.*/)?').replace(/\u0000/g, '.*');
  return new RegExp(`^${body}(?:/.*)?$`);
}

// One line per open PR (not this branch's) whose changed files match a Touches glob; [] when none.
// `slices` are this work's slice numbers; an open PR whose branch names the same slice (s33a, slice-33-x) is a sibling batch, not a rival.
export const claimsSlice = (headRefName, slices) => slices.some((n) => new RegExp(`(?:^|[^a-z0-9])s(?:lice)?-?0*${Number(n)}(?!\\d)`, 'i').test(String(headRefName)));
export function overlapWarnings(globs, prs, branch, slices = []) {
  const patterns = globs.map(globToRegex);
  return prs.filter((pr) => pr.headRefName !== branch && !claimsSlice(pr.headRefName, slices)).flatMap((pr) => {
    const hits = (pr.files ?? []).map((f) => f.path ?? f).filter((p) => patterns.some((re) => re.test(String(p).replace(/\\/g, '/'))));
    return hits.length ? [`push-branch: WARNING open PR #${pr.number} (${pr.headRefName}) changes files this slice's Touches names: ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', ...' : ''}. Expect a merge conflict or a suite-lock wait; compare before building more.`] : [];
  });
}

// Slice files this branch changed since it left main (three dots: what main gained later is not this branch's).
function changedSliceFiles(worktree) {
  const changed = git(worktree, 'diff', '--name-only', `${MAIN_REF}...HEAD`, '--', 'docs/plan/slices');
  return changed.ok ? changed.out.split('\n').filter(Boolean) : [];
}

function sliceNumbers(worktree) {
  return changedSliceFiles(worktree).map((f) => /slices\/0*(\d+)-/.exec(f)?.[1]).filter(Boolean);
}

function sliceTouches(worktree) {
  return changedSliceFiles(worktree).flatMap((f) => {
    try { return touchesGlobs(readFileSync(join(worktree, f), 'utf8')); } catch { return []; }
  });
}

const GH_TIMEOUT_MS = 20000;
const GH_PR_ARGS = ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefName,files'];

// A stalled network or auth prompt must not hold the push: on timeout the overlap check is skipped with one stderr line.
export function openPrs(worktree, { bin = 'gh', args = GH_PR_ARGS, timeoutMs = GH_TIMEOUT_MS } = {}) {
  const run = spawnSync(bin, args, { cwd: worktree, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.error?.code === 'ETIMEDOUT') {
    process.stderr.write(`push-branch: gh pr list timed out after ${timeoutMs / 1000} s; the overlap warning is skipped, pushing anyway.\n`);
    return [];
  }
  if (run.status !== 0) return [];
  try { return JSON.parse(run.stdout); } catch { return []; }
}

const STAMP_RULE = 'a branch\'s first push goes through push-branch.mjs, never a plain `git push` (agents/ship-branch.md, step 6)';
const stampPath = (worktree, branch) => {
  const dir = git(worktree, 'rev-parse', '--absolute-git-dir');
  return dir.ok ? join(dir.out, 'push-branch-stamps', branch.replace(/[^\w.-]/g, '_')) : null;
};

// The warning when origin already has the branch and this helper never pushed it from this checkout (a plain push came first).
export function unstampedRemoteWarning(worktree, branch) {
  const remote = git(worktree, 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`);
  const stamp = stampPath(worktree, branch);
  if (!remote.ok || (stamp && existsSync(stamp))) return null;
  return `push-branch: WARNING origin already has "${branch}" and push-branch.mjs has not pushed it from this checkout: ${STAMP_RULE}. Name this line in the report.`;
}

function writeStamp(worktree, branch) {
  const stamp = stampPath(worktree, branch);
  if (!stamp) return;
  try { mkdirSync(dirname(stamp), { recursive: true }); writeFileSync(stamp, `${new Date().toISOString()}\n`); } catch { /* a missing stamp only repeats the warning */ }
}

export function pushWarnings(worktree, branch, prs = openPrs) {
  const globs = sliceTouches(worktree);
  const overlaps = globs.length ? overlapWarnings(globs, prs(worktree), branch, sliceNumbers(worktree)) : [];
  return [...overlaps, unstampedRemoteWarning(worktree, branch)].filter(Boolean);
}

export function pushBranch(worktree, branch, check = runSliceCheck, warn = (lines) => lines.forEach((l) => process.stderr.write(`${l}\n`))) {
  const problem = branchProblem(branch) ?? headProblem(worktree, branch) ?? skipCiProblem(worktree, branch);
  if (problem) return { status: EXIT_REFUSED, message: `push-branch: ${problem}` };
  if (inSliceRepo(worktree) && check(worktree, branch) !== 0) return { status: EXIT_REFUSED, message: 'push-branch: the slice-number check failed; nothing was pushed.' };
  try { warn(pushWarnings(worktree, branch)); } catch (e) { process.stderr.write(`push-branch: the warning check failed (${e?.message ?? e}); pushing anyway.\n`); }
  const push = spawnSync('git', ['-C', worktree, 'push', '-u', 'origin', branch], { stdio: 'inherit' });
  if (push.status === 0) writeStamp(worktree, branch);
  return { status: push.status === 0 ? 0 : EXIT_REFUSED, message: push.status === 0 ? '' : 'push-branch: git push failed.' };
}

function main(argv) {
  if (argv.length !== 2) {
    process.stderr.write('usage: node push-branch.mjs <worktree> <branch>\n');
    return EXIT_USAGE;
  }
  const result = pushBranch(argv[0], argv[1]);
  if (result.message) process.stderr.write(`${result.message}\n`);
  return result.status;
}

if (isEntryPoint(process.argv[1], import.meta.url)) process.exitCode = main(process.argv.slice(2));
