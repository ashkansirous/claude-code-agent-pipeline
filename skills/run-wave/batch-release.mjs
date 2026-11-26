#!/usr/bin/env node
// Batched release: merges done by run-wave / run-all-waves carry [skip ci], so no push workflow starts for them.
// At the batch point this script starts by hand the workflows a push to main would have started, watches them and
// reports each conclusion.
//   start <repo> [--run-start]         remember origin/main as the base of this batch (kept if open); --run-start restarts the `due` clock
//   due <repo> --hours N               exit 0 when N hours passed since the last release (or the start), else 1
//   release <repo>                     dispatch every workflow a push to main since the base would have started; when the batch changed a
//                                      `workerPaths` glob of .claude/merge-gate.json (on origin/main; `!` globs remove; none declared: no check) the JSON also has
//                                      workerNotDeployed, repeated by every release until `worker-deployed`; the release POSTs the Workers Builds
//                                      deploy hook (CF_WORKER_DEPLOY_HOOK_URL, env or secrets store) and the JSON has workerHook (started | failed | no hook url)
//   worker-deployed <repo>             clear the workerNotDeployed warning (after a Workers Builds run of main: its deploy hook or retry; never `wrangler deploy`),
//                                      then print one `check, then rewrite with "deployed <time>" ...: origin/main plan.md <n>: <line>` candidate per origin/main plan.md line still saying "with the next batched release" (the caller checks each, then rewrites it)
//   watch <repo> [--max-minutes N] [--clear-failed]
//                                      watch the dispatched runs to their conclusion, then print the recorded deploy hook outcome once (no deployment check: the reader confirms the deploy in Cloudflare); exit 1 on any failure. A failed run stays listed (the next
//                                      watch reports it again) unless --clear-failed: that reports every run, then drops every finished run, failed included
// State: <primary checkout parent>/<primary name>-worktrees/batch-release.json (found through the git common dir, so a worktree path works). Tests: node --test skills/run-wave/batch-release.test.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_BRANCH = 'main';
const ORIGIN_MAIN = `origin/${MAIN_BRANCH}`;
const WORKFLOWS_DIR = '.github/workflows';
const WORKFLOW_FILE = /\.ya?ml$/i;
const STATE_FILE = 'batch-release.json';
const DEFAULT_HOURS = 6;
const DEFAULT_WATCH_MINUTES = 240;
const MS_PER_HOUR = 3600 * 1000;
const MS_PER_MINUTE = 60 * 1000;
const GH_MAX_BUFFER = 256 * 1024 * 1024; // `gh run watch` prints a lot over hours; an overflow would kill it and look like a timeout
// gh's message for a run id GitHub no longer has (2026-11-13: two runs of a retired release.yml stayed listed for a week).
const RUN_GONE = /HTTP 404/;
const RUN_URL =/\/actions\/runs\/(\d+)/;
const RUN_ID_RETRIES = 5;
const RUN_ID_WAIT_MS = 3000;
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_ERRORS = 2;
const EXIT_TIMEOUT = 3;
// RTST Slice 354 item 18 (Slice 377 item 1): a batch that changed Worker paths starts a Workers Builds run of main through the repo's deploy
// hook (never `wrangler deploy`); `watch` only prints the recorded outcome, the reader confirms the deploy in Cloudflare. The hook URL is a
// credential: from the environment, else from the secrets store (`<SECRETS_DIR or ~/.secrets>/<primary checkout name, lower case>/secrets.env`); it is never printed.
const HOOK_URL_ENV = 'CF_WORKER_DEPLOY_HOOK_URL';
const SECRETS_DIR_ENV = 'SECRETS_DIR';
const DEFAULT_SECRETS_DIR = join(homedir(), '.secrets');
const HOOK_STARTED = 'started';
const HOOK_FAILED = 'failed';
const HOOK_NO_URL = 'no hook url';
const HOOK_TIMEOUT_MS = 30 * 1000;
const BROKEN_CONCLUSIONS = new Set(['startup_failure', 'failure']);
const PUSH_EVENT = 'push';
const DISPATCH_EVENT = 'workflow_dispatch';

// ---- the `on:` block of a workflow file (only what these repos use) ----

const stripComment = (line) => line.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trimEnd();
const indentOf = (line) => line.length - line.trimStart().length;
const unquote = (text) => text.trim().replace(/^(['"])(.*)\1$/, '$2');

function parseInlineList(text) {
  const t = text.trim();
  if (t.startsWith('[')) return t.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
  return t ? [unquote(t)] : [];
}

// Child entries of a mapping block: [{ key, inline, children }]; every deeper (or dash) line under a key is a child.
function parseMapping(lines) {
  const entries = [];
  const base = lines.length ? indentOf(lines[0]) : 0;
  for (const line of lines) {
    const text = line.trim();
    if (indentOf(line) === base && !text.startsWith('-')) {
      const [, key, rest = ''] = /^(['"]?[\w.-]+['"]?):\s*(.*)$/.exec(text) ?? [];
      entries.push({ key: unquote(key ?? text), inline: rest, children: [] });
    } else if (entries.length) entries.at(-1).children.push(line);
  }
  return entries;
}

function onBlockLines(text) {
  const lines = text.split(/\r?\n/).map(stripComment).filter((l) => l.trim());
  const start = lines.findIndex((l) => /^['"]?on['"]?:/.test(l));
  if (start === -1) return null;
  const inline = lines[start].replace(/^['"]?on['"]?:\s*/, '');
  const block = [];
  for (const line of lines.slice(start + 1)) { if (indentOf(line) === 0) break; block.push(line); }
  return { inline, block };
}

function listOf(entry) {
  if (entry.inline) return parseInlineList(entry.inline);
  return entry.children.filter((l) => l.trim().startsWith('-')).map((l) => unquote(l.trim().slice(1)));
}

function pushFilters(entry) {
  const filters = {};
  for (const child of parseMapping(entry.children)) filters[child.key] = listOf(child);
  return filters;
}

// { push: null | { branches, 'branches-ignore', tags, paths, 'paths-ignore' }, dispatch } or { unreadable: true }.
export function parseOn(text) {
  const on = onBlockLines(text);
  if (!on) return { unreadable: true };
  if (on.inline.startsWith('{')) return { unreadable: true };
  if (on.inline) {
    const events = parseInlineList(on.inline);
    return { push: events.includes(PUSH_EVENT) ? {} : null, dispatch: events.includes(DISPATCH_EVENT) };
  }
  if (on.block.length && on.block[0].trim().startsWith('-')) {
    const events = on.block.map((l) => unquote(l.trim().replace(/^-\s*/, '')));
    return { push: events.includes(PUSH_EVENT) ? {} : null, dispatch: events.includes(DISPATCH_EVENT) };
  }
  const entries = parseMapping(on.block);
  const push = entries.find((e) => e.key === PUSH_EVENT);
  return { push: push ? pushFilters(push) : null, dispatch: entries.some((e) => e.key === DISPATCH_EVENT) };
}

// ---- would a push to main with these changed files start the workflow? ----

export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') out += '[^/]*';
    else if ('?+[]'.includes(c)) out += c;
    else out += c.replace(/[.^${}()|\\]/g, '\\$&');
  }
  try { return new RegExp(`^${out}$`); } catch { return /^[\s\S]*$/; }
}

// GitHub path patterns are evaluated in order; a later `!pattern` removes what an earlier one matched.
function matchesPatterns(file, patterns) {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (globToRegExp(negated ? pattern.slice(1) : pattern).test(file)) matched = !negated;
  }
  return matched;
}

function branchAllows(push) {
  const include = push.branches ?? [];
  const ignore = push['branches-ignore'] ?? [];
  if (push.tags && !include.length && !ignore.length) return false;
  if (include.length && !matchesPatterns(MAIN_BRANCH, include)) return false;
  return !(ignore.length && matchesPatterns(MAIN_BRANCH, ignore));
}

// files === null: the changed files are unknown, so every path filter counts as matching.
function pathsAllow(push, files) {
  if (!files) return true;
  if (push.paths?.length) return files.some((f) => matchesPatterns(f, push.paths));
  if (push['paths-ignore']?.length) return files.some((f) => !matchesPatterns(f, push['paths-ignore']));
  return true;
}

// Anything the parser cannot read counts as "would run".
export function wouldRunOnPush(parsed, files) {
  if (parsed.unreadable) return true;
  if (!parsed.push) return false;
  return branchAllows(parsed.push) && pathsAllow(parsed.push, files);
}

// ---- process helpers (injectable) ----

function realGh(args, options = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: GH_MAX_BUFFER });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const stderr = (r.stderr ?? '') + (r.error && !timedOut ? r.error.message : '');
  return { status: r.status, stdout: r.stdout ?? '', stderr, timedOut };
}

function realGit(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The deploy hook URL: the environment first, then the secrets store file of this repo (KEY=value lines). null when neither has it.
export function realHookUrl(ctx, env = process.env) {
  if (env[HOOK_URL_ENV]?.trim()) return env[HOOK_URL_ENV].trim();
  const file = join(env[SECRETS_DIR_ENV] || DEFAULT_SECRETS_DIR, ctx.name.toLowerCase(), 'secrets.env');
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim().replace(/^export\s+/, ''));
  const line = lines.find((l) => l.startsWith(`${HOOK_URL_ENV}=`));
  return line ? unquote(line.slice(HOOK_URL_ENV.length + 1).trim()) || null : null;
}

// POST the deploy hook (no Authorization header: the id inside the URL is the credential). Never put the URL in a message.
export async function realPostHook(url) {
  try {
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(HOOK_TIMEOUT_MS) });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok && body.success !== false, status: response.status, buildUuid: body.result?.build_uuid ?? null };
  } catch (error) {
    // The error text can carry the URL (a malformed one is quoted back by fetch): keep only the error's name.
    return { ok: false, status: 0, error: `the deploy hook request failed (${error?.name ?? 'error'}; the URL is not shown)` };
  }
}

export function repoSlug(url) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url.trim());
  if (!m) throw new Error(`cannot read owner/name from remote ${url}`);
  return `${m[1]}/${m[2]}`;
}

function context(repo, deps) {
  const root = deps.git(repo, ['rev-parse', '--show-toplevel']);
  // The state lives next to the primary checkout, whichever worktree the command was given.
  const primary = dirname(resolve(repo, deps.git(repo, ['rev-parse', '--git-common-dir'])));
  const statePath = join(dirname(primary), `${basename(primary)}-worktrees`, STATE_FILE);
  return { root, name: basename(primary), statePath, slug: repoSlug(deps.git(root, ['remote', 'get-url', 'origin'])), deps };
}

function loadState(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function fetchHead(ctx) {
  ctx.deps.git(ctx.root, ['fetch', 'origin', '--quiet']);
  return ctx.deps.git(ctx.root, ['rev-parse', ORIGIN_MAIN]);
}

// ---- commands ----

// runStart (the driver's first call of a run) restarts the `due` clock; the state itself outlives runs.
export function startBatch(ctx, out, runStart = false) {
  const state = loadState(ctx.statePath);
  const now = ctx.deps.now().toISOString();
  if (runStart) state.runStartedAt = now;
  state.batchStartedAt = now; // each start resets the age of the open batch (merge-gate's openBatch reads it)
  if (state.baseSha) {
    saveState(ctx.statePath, state);
    out(`batch already open at ${state.baseSha}`);
    return EXIT_OK;
  }
  state.baseSha = fetchHead(ctx);
  state.startedAt ??= now;
  saveState(ctx.statePath, state);
  out(`batch started at ${state.baseSha}`);
  return EXIT_OK;
}

// The later of the last release and the start of this run.
function dueReference(state) {
  const marks = [state.lastReleaseAt, state.runStartedAt ?? state.startedAt].filter(Boolean);
  return marks.sort((a, b) => new Date(b) - new Date(a))[0];
}

export function isDue(ctx, hours, out) {
  const state = loadState(ctx.statePath);
  const reference = dueReference(state);
  if (!reference) { out('not due: no start or release recorded'); return EXIT_FAILED; }
  const elapsed = (ctx.deps.now() - new Date(reference)) / MS_PER_HOUR;
  out(`${elapsed.toFixed(2)} hours since ${reference}; limit ${hours}`);
  return elapsed >= hours ? EXIT_OK : EXIT_FAILED;
}

function workflowFiles(ctx) {
  const names = ctx.deps.git(ctx.root, ['ls-tree', '--name-only', ORIGIN_MAIN, `${WORKFLOWS_DIR}/`]);
  return names.split(/\r?\n/).filter((n) => WORKFLOW_FILE.test(n));
}

export function selectWorkflows(ctx, changed) {
  const selected = [];
  const errors = [];
  for (const path of workflowFiles(ctx)) {
    const parsed = parseOn(ctx.deps.git(ctx.root, ['show', `${ORIGIN_MAIN}:${path}`]));
    if (!wouldRunOnPush(parsed, changed)) continue;
    if (parsed.unreadable || parsed.dispatch) selected.push(basename(path));
    else errors.push(`${basename(path)} would run on a push to main but has no workflow_dispatch: add it in that repo`);
  }
  return { selected, errors };
}

async function findRunId(ctx, file, startedAt) {
  for (let attempt = 0; attempt < RUN_ID_RETRIES; attempt++) {
    const r = ctx.deps.gh(['run', 'list', '--repo', ctx.slug, '--workflow', file, '--event', DISPATCH_EVENT,
      '--branch', MAIN_BRANCH, '--limit', '5', '--json', 'databaseId,createdAt']);
    const fresh = r.status === 0 ? JSON.parse(r.stdout || '[]').filter((x) => new Date(x.createdAt) >= startedAt) : [];
    if (fresh.length) return String(Math.max(...fresh.map((x) => x.databaseId)));
    await ctx.deps.sleep(RUN_ID_WAIT_MS);
  }
  return null;
}

async function dispatch(ctx, file) {
  const startedAt = new Date(ctx.deps.now().getTime() - MS_PER_MINUTE);
  const r = ctx.deps.gh(['workflow', 'run', file, '--repo', ctx.slug, '--ref', MAIN_BRANCH]);
  if (r.status !== 0) return { workflow: file, error: `gh workflow run ${file} failed: ${r.stderr.trim()}` };
  const runId = RUN_URL.exec(r.stdout + r.stderr)?.[1] ?? await findRunId(ctx, file, startedAt);
  if (!runId) return { workflow: file, error: `${file} was dispatched but its run id could not be found: check the Actions tab` };
  return { workflow: file, runId };
}

// What a push to main since the base would have changed. Without a base: the last released sha; without that, unknown (null).
function changedSince(ctx, since) {
  if (!since) return null;
  return ctx.deps.git(ctx.root, ['diff', '--name-only', `${since}..${ORIGIN_MAIN}`]).split(/\r?\n/).filter(Boolean);
}

// A Cloudflare Worker is deployed by Workers Builds, which skips every [skip ci] merge, and by no workflow here, so a batch that
// changed the repo's Worker paths leaves the Worker stale (2026-11-07, ReadTheStupidText: POST /alexa returned 404 after three such merges).
// The paths are the repo's own `workerPaths` globs in `.claude/merge-gate.json` on origin/main; a repo that declares none gets no warning.
// Report only; start a Workers Builds run of main (its deploy hook or retry); never `wrangler deploy` from a shell (deploy-guard.mjs).
const CONFIG_PATH = '.claude/merge-gate.json';
const WORKER_NOT_DEPLOYED = 'Worker not deployed: the batch changed Worker paths and Workers Builds skips [skip ci] merges; start a Workers Builds run of main (its deploy hook or retry), never wrangler deploy';

// The `workerPaths` of the repo's merge-gate.json on origin/main; [] when the file or key is missing or malformed.
export function workerPathsFor(ctx) {
  try {
    const list = JSON.parse(ctx.deps.git(ctx.root, ['show', `${ORIGIN_MAIN}:${CONFIG_PATH}`])).workerPaths;
    return Array.isArray(list) ? list.filter((g) => typeof g === 'string' && g) : [];
  } catch { return []; }
}

// `!` globs remove files, as in a workflow's paths list (the last matching glob wins, so put a `!` after its include), so a repo can leave out what the Worker never serves ("!worker/**/*.md")
// (2026-11-14, ReadTheStupidText: a worker/CLAUDE.md-only batch kept workerNotDeployed set although the live Worker matched main).
export function workerFilesChanged(changed, workerPaths = []) {
  return (changed ?? []).filter((file) => matchesPatterns(file, workerPaths));
}

// The report fields for a Worker left undeployed: set from the state, so every release reports it the same way until `worker-deployed` clears it.
function workerReport(state) {
  const pending = state.workerNotDeployed;
  return pending ? { workerNotDeployed: true, workerFiles: pending.files, workerNote: WORKER_NOT_DEPLOYED, ...(pending.hook && { workerHook: pending.hook.status, ...(pending.hook.error && { workerHookError: pending.hook.error }) }) } : {};
}

// Start a Workers Builds run of main through the deploy hook. The time is taken before the call, so a deployment created after it is the hook's.
// Never throws: every error (reading the URL, the call) becomes a recorded HOOK_FAILED outcome, so the release's state is already saved and stays right.
async function startWorkerBuild(ctx) {
  const at = ctx.deps.now().toISOString();
  try {
    const url = ctx.deps.hookUrl(ctx);
    if (!url) return { status: HOOK_NO_URL, at };
    const result = await ctx.deps.postHook(url);
    if (result.ok) return { status: HOOK_STARTED, at, ...(result.buildUuid && { buildUuid: result.buildUuid }) };
    return { status: HOOK_FAILED, at, error: result.error ?? `the deploy hook answered HTTP ${result.status}` };
  } catch (error) {
    // The message can carry the URL: keep only the error's name and code.
    return { status: HOOK_FAILED, at, error: `the deploy hook step failed (${error?.code ?? error?.name ?? 'error'}; no URL shown)` };
  }
}

// After `watch`: print the recorded deploy hook outcome once. The deploy is started by the hook and confirmed in Cloudflare by the reader;
// watch checks nothing and clears nothing (`worker-deployed` clears the warning). Never a failed run.
export function reportWorkerHook(ctx, out) {
  const state = loadState(ctx.statePath);
  const hook = state.workerNotDeployed?.hook;
  if (!hook || hook.reported) return EXIT_OK;
  const text = {
    [HOOK_STARTED]: `Worker deploy hook called at ${hook.at}: Workers Builds started; confirm the deployment in Cloudflare, then run worker-deployed`,
    [HOOK_FAILED]: `Worker deploy hook failed (${hook.error ?? 'no detail'}): the Worker is still not deployed`,
    [HOOK_NO_URL]: 'Worker deploy hook not called (no hook URL): the Worker is still not deployed',
  }[hook.status];
  if (text) out(text);
  hook.reported = true;
  saveState(ctx.statePath, state);
  return EXIT_OK;
}

// plan.md says a change "goes live with the next batched release": once the Worker is deployed that line is stale (Slice 29 item 29:
// board plan.md still said it for Slices 34 to 45 hours after two deployments).
const NEXT_RELEASE_LINE = /with the next batched release/i;

// The lines of a plan.md text that still promise the next batched release, as `<line number>: <text>`.
export function staleLiveStateLines(planText) {
  return String(planText).split(/\r?\n/).map((text, i) => ({ n: i + 1, text })).filter((l) => NEXT_RELEASE_LINE.test(l.text)).map((l) => `${l.n}: ${l.text.trim()}`);
}

function planStaleLines(ctx) {
  // origin/main's plan.md, not the working tree's: the primary checkout may be behind, and the caller edits its own worktree.
  try {
    ctx.deps.git(ctx.root, ['fetch', 'origin', '--quiet']);
  } catch { /* offline: read the last known origin/main */ }
  try { return staleLiveStateLines(ctx.deps.git(ctx.root, ['show', `${ORIGIN_MAIN}:plan.md`])); } catch { return []; }
}

// The user (or the repo's own step) deployed the Worker: forget the warning, and list the plan.md lines the caller must now rewrite
// with the deployment time (this script never edits plan.md).
export function workerDeployed(ctx, out) {
  const state = loadState(ctx.statePath);
  delete state.workerNotDeployed;
  saveState(ctx.statePath, state);
  out('worker marked deployed');
  const stale = planStaleLines(ctx);
  const at = ctx.deps.now().toISOString();
  // Candidates only: a line can belong to a client-app change that the Worker deployment did not ship.
  stale.forEach((line) => out(`check, then rewrite with "deployed ${at}" if the Worker change shipped it: origin/main plan.md ${line}`));
  return EXIT_OK;
}

export async function releaseBatch(ctx, out) {
  const state = loadState(ctx.statePath);
  const head = fetchHead(ctx);
  const since = state.baseSha ?? state.lastReleasedSha ?? null;
  if (since === head) {
    out(JSON.stringify({ released: false, reason: 'nothing merged', ...workerReport(state) }));
    return EXIT_OK;
  }
  const note = since ? undefined : 'no base recorded: every push workflow is treated as matching';
  // What already ran counts only for a retry against the same head; new merges dispatch every matching workflow again.
  const done = new Set(state.dispatchedSha === head ? state.dispatched ?? [] : []);
  const changed = changedSince(ctx, since);
  const { selected, errors } = selectWorkflows(ctx, changed);
  const workerFiles = workerFilesChanged(changed, workerPathsFor(ctx));
  const runs = [];
  for (const file of selected.filter((f) => !done.has(f))) {
    const result = await dispatch(ctx, file);
    if (result.error) errors.push(result.error); else runs.push(result);
  }
  // Runs of an earlier release that nobody watched yet stay on the list.
  const allRuns = [...(state.runs ?? []), ...runs];
  Object.assign(state, { lastReleasedSha: head, runs: allRuns, errors });
  // Stays set, and is reported by every release, until `worker-deployed` clears it.
  // Files of earlier undeployed releases stay listed (a later Worker release must not hide them).
  const earlier = state.workerNotDeployed;
  // A retry release (same head) whose hook already started must not start a second Workers Builds run.
  const hookDone = workerFiles.length > 0 && earlier?.sha === head && earlier.hook?.status === HOOK_STARTED;
  if (workerFiles.length) {
    state.workerNotDeployed = { sha: head, files: [...new Set([...(earlier?.files ?? []), ...workerFiles])] };
    if (hookDone) state.workerNotDeployed.hook = earlier.hook;
  }
  // A release with errors does not restart the interval: the next `due` retries what is missing.
  if (!errors.length) state.lastReleaseAt = ctx.deps.now().toISOString();
  // Any error keeps the base (and what already ran for it), so the next release retries only what is missing.
  if (errors.length) Object.assign(state, { dispatched: [...done, ...runs.map((r) => r.workflow)], dispatchedSha: head });
  else { state.baseSha = null; delete state.dispatched; delete state.dispatchedSha; }
  // Saved BEFORE the hook step: the dispatched runs are recorded whatever the hook does (a retry never dispatches them twice).
  saveState(ctx.statePath, state);
  if (workerFiles.length && !hookDone) {
    state.workerNotDeployed.hook = await startWorkerBuild(ctx);
    saveState(ctx.statePath, state);
  }
  out(JSON.stringify({ released: true, sha: head, runs, errors, ...workerReport(state), ...(note && { note }) }));
  return errors.length ? EXIT_ERRORS : EXIT_OK;
}

function describeRun(ctx, run) {
  const r = ctx.deps.gh(['run', 'view', run.runId, '--repo', ctx.slug, '--json', 'status,conclusion,jobs']);
  const info = r.status === 0 ? JSON.parse(r.stdout) : { status: 'unknown', conclusion: null, jobs: [] };
  const conclusion = info.conclusion || info.status;
  const broken = BROKEN_CONCLUSIONS.has(info.conclusion) && !(info.jobs ?? []).length;
  // A run GitHub no longer has (its workflow file deleted, or past retention) can never finish: report it once, then drop it.
  // A 404 counts only when the repo itself answers, so an auth, scope or wrong-slug 404 never drops a live run.
  const gone = r.status !== 0 && RUN_GONE.test(r.stderr ?? '') && ctx.deps.gh(['api', `repos/${ctx.slug}`, '--jq', '.full_name']).status === 0;
  return { ...run, conclusion, broken, gone, ok: info.conclusion === 'success', finished: Boolean(info.conclusion) };
}

// A watch error is a gh problem (could not run; or a non-zero exit while the run has no conclusion, e.g. auth, network, not found), not a failed workflow.
function watchErrorFor(watched, described) {
  if (watched.timedOut) return {};
  const couldNotRun = watched.status === null;
  const unexplained = watched.status !== 0 && !described.finished;
  if (!couldNotRun && !unexplained) return {};
  const watchError = (watched.stderr || (couldNotRun ? 'gh run watch could not run' : `gh run watch exited ${watched.status}`)).trim();
  return { watchError, ok: false };
}

export function watchRuns(ctx, maxMinutes, out, clearFailed = false) {
  const state = loadState(ctx.statePath);
  if (!(state.runs ?? []).length) { out('no runs to watch'); return EXIT_OK; }
  const deadline = ctx.deps.now().getTime() + maxMinutes * MS_PER_MINUTE;
  const results = [];
  let timedOut = false;
  for (const run of state.runs ?? []) {
    const left = deadline - ctx.deps.now().getTime();
    if (left <= 0) { timedOut = true; break; }
    const watched = ctx.deps.gh(['run', 'watch', run.runId, '--repo', ctx.slug, '--exit-status'], { timeoutMs: left });
    // Only a gh timeout is "still running"; a null status without one (gh missing, spawn error) is a failed watch.
    if (watched.timedOut) timedOut = true;
    const described = describeRun(ctx, run);
    results.push({ ...described, ...watchErrorFor(watched, described) });
  }
  for (const r of results) out(`${r.workflow} run ${r.runId}: conclusion ${r.conclusion}${r.broken ? ' - main is broken (no jobs started)' : ''}${r.gone ? ' - the run no longer exists on GitHub, dropped from the list' : r.watchError ? ` - watch failed: ${r.watchError}` : ''}`);
  if (timedOut) out(`still running after ${maxMinutes} minutes`);
  state.watched = results;
  // Only runs that finished green leave the list; failed and unfinished ones stay so the next watch still reports them.
  // With clearFailed every finished run leaves (failed included, once reported above); unfinished runs and failed watches stay.
  const green = new Set(results.filter((r) => r.ok).map((r) => r.runId));
  const finished = new Set(results.filter((r) => r.finished && !r.watchError).map((r) => r.runId));
  const gone = new Set(results.filter((r) => r.gone).map((r) => r.runId));
  state.runs = state.runs.filter((r) => !gone.has(r.runId));
  if (clearFailed) state.runs = state.runs.filter((r) => !finished.has(r.runId));
  else if (!timedOut) state.runs = state.runs.filter((r) => !green.has(r.runId));
  saveState(ctx.statePath, state);
  if (timedOut) return EXIT_TIMEOUT;
  return results.every((r) => r.ok) ? EXIT_OK : EXIT_FAILED;
}

// ---- command line ----

const USAGE = 'usage: batch-release.mjs start|due|release|watch|worker-deployed <repo> [--hours N] [--max-minutes N] [--clear-failed]';
const COMMANDS = new Set(['start', 'due', 'release', 'watch', 'worker-deployed']);

// A missing or non-numeric value is null (usage error), never NaN.
function option(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const raw = args[i + 1];
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// The repo is the first argument after the command that is not a flag or a flag's value.
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const valueFlags = new Set(['--hours', '--max-minutes']);
  let repo = null;
  for (let i = 0; i < rest.length; i++) {
    if (valueFlags.has(rest[i])) { i++; continue; }
    if (rest[i].startsWith('--')) continue;
    repo = rest[i];
    break;
  }
  return { command, repo: repo ?? process.cwd(), rest };
}

export async function main(argv, deps = {}) {
  const full = { gh: realGh, git: realGit, now: () => new Date(), sleep: realSleep, out: console.log, hookUrl: realHookUrl, postHook: realPostHook, ...deps };
  const { command, repo, rest } = parseArgs(argv);
  const hours = option(rest, '--hours', DEFAULT_HOURS);
  const maxMinutes = option(rest, '--max-minutes', DEFAULT_WATCH_MINUTES);
  if (!COMMANDS.has(command) || hours === null || maxMinutes === null) { full.out(USAGE); return EXIT_ERRORS; }
  const ctx = context(repo, full);
  if (command === 'start') return startBatch(ctx, full.out, rest.includes('--run-start'));
  if (command === 'due') return isDue(ctx, hours, full.out);
  if (command === 'release') return releaseBatch(ctx, full.out);
  if (command === 'worker-deployed') return workerDeployed(ctx, full.out);
  const watched = watchRuns(ctx, maxMinutes, full.out, rest.includes('--clear-failed'));
  // Report the hook outcome only when the runs were watched fine.
  if (watched !== EXIT_OK) return watched;
  return reportWorkerHook(ctx, full.out);
}

// ~/.claude/skills/run-wave is a symlink into this repo: compare real paths, or the script does nothing and exits 0.
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl)); } catch { return resolve(argvPath) === resolve(fileURLToPath(moduleUrl)); }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((e) => { console.error(e.message); process.exitCode = EXIT_ERRORS; });
}
