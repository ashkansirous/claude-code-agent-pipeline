#!/usr/bin/env node
// SessionStart hook (Slice 16 part D): sync the session's repo to the Agent Progress Board in the background,
// at most once an hour per repo, so planned work and its checks show without a wave. Fast and fail open: the
// hook reads a gate file and starts a detached run; the run fetches origin and calls the agent-board plugin's
// sync-docs.mjs (found through board.mjs, Slice 20). Never blocks, always exit 0. AGENT_BOARD_USAGE=off (tests, CI)
// turns it off like the usage tick.
// Input (stdin JSON): session_id, cwd. Usage of the detached run: node session-sync.mjs --run <repo dir> <project>
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { childEnv, pluginInstallPath, scriptPath } from './board.mjs';

export const SYNC_GAP_MS = 60 * 60 * 1000;
const SESSION_ROOT_VARIABLE = 'AGENT_BOARD_SESSION_ROOT';
const SESSION_ROOT_FOLDER = 'claude-board-hooks';
const SYNC_SCRIPT = 'sync-docs';
const SWITCH_VARIABLE = 'AGENT_BOARD_USAGE';
const SWITCH_OFF = 'off';
const RUN_FLAG = '--run';
const FETCH_TIMEOUT_MS = 20000;
const GIT_TIMEOUT_MS = 3000;

export const RETRY_GAP_MS = 10 * 60 * 1000;

export function sessionRootOf(env = process.env) {
  return env[SESSION_ROOT_VARIABLE] || join(tmpdir(), SESSION_ROOT_FOLDER);
}

export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// The repo's folder name (the main checkout's, also from inside a worktree), as the board's project slug.
export function projectSlug(dir = process.cwd()) {
  try {
    const raw = execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS, windowsHide: true }).trim();
    const common = resolve(dir, raw);
    if (basename(common) === '.git') return slugify(basename(dirname(common)));
  } catch { /* not a git folder: fall back to the folder name */ }
  return slugify(basename(resolve(dir)));
}

function parseInput(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readStdinText() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function gateFile(project, env) {
  return join(sessionRootOf(env), `sync-${project.replace(/[^A-Za-z0-9_-]/g, '_')}.gate`);
}

// Written after a failed attempt: a short backoff, so a repo with no network or no origin does not refetch on every session start.
function retryFile(project, env) {
  return join(sessionRootOf(env), `sync-${project.replace(/[^A-Za-z0-9_-]/g, '_')}.retry`);
}

function readGate(file) {
  try {
    return Number(readFileSync(file, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
}

function writeGate(file, now) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(now));
  } catch { /* the next session asks again */ }
}

// The repo's working folder for the cwd, or '' outside a git repo.
function repoOf(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS, windowsHide: true }).trim();
  } catch {
    return '';
  }
}

function startBackgroundRun(repo, project, env, spawnFn) {
  const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), RUN_FLAG, repo, project], { env, detached: true, stdio: 'ignore', windowsHide: true });
  if (child && typeof child.on === 'function') child.on('error', () => {});
  child.unref();
}

// Returns { skipped } or { started: true, project }. The gate is written by the run after a successful sync,
// so a failed run is tried again by the next session. The project comes from the repo; AGENT_BOARD_PROJECT
// naming another project means this repo's plan is not that project's snapshot (sync_snapshot closes what
// is missing), so the sync does nothing then.
export function requestSync(input, env = process.env, { now = Date.now(), spawnFn = spawn, repoFn = repoOf, projectFn = projectSlug } = {}) {
  if (env[SWITCH_VARIABLE] === SWITCH_OFF) return { skipped: 'off' };
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const repo = repoFn(cwd);
  if (!repo) return { skipped: 'not a repo' };
  const project = projectFn(repo, { ...env, AGENT_BOARD_PROJECT: '' });
  if (env.AGENT_BOARD_PROJECT && slugify(env.AGENT_BOARD_PROJECT) !== project) {
    process.stderr.write(`session-sync: sync skipped, AGENT_BOARD_PROJECT is "${env.AGENT_BOARD_PROJECT}" but this repo is "${project}"\n`);
    return { skipped: 'other project' };
  }
  if (now - readGate(gateFile(project, env)) < SYNC_GAP_MS) return { skipped: 'gate' };
  if (now - readGate(retryFile(project, env)) < RETRY_GAP_MS) return { skipped: 'retry backoff' };
  try {
    startBackgroundRun(repo, project, env, spawnFn);
  } catch {
    return { skipped: 'no start' };
  }
  return { started: true, project };
}

// The detached run: bring origin/main up to date, then sync. A failed fetch skips the sync: an old origin/main
// would be sent as the whole snapshot and close what merged since. The gate is written only after a sync the
// board accepted (sync-docs main returns { synced: true }).
export async function runSync(repo, project, env = process.env, now = Date.now(), importFn = (url) => import(url)) {
  // The plugin is checked before the fetch: with no plugin the network round trip would be for nothing.
  const installPath = pluginInstallPath(env);
  const file = installPath ? scriptPath(installPath, SYNC_SCRIPT) : '';
  if (!file) {
    process.stderr.write('session-sync: agent-board plugin not installed, sync skipped\n');
    writeGate(retryFile(project, env), now);
    return false;
  }
  try {
    execFileSync('git', ['-C', repo, 'fetch', '--quiet', 'origin'], { stdio: 'ignore', timeout: FETCH_TIMEOUT_MS, windowsHide: true, env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
  } catch {
    process.stderr.write('session-sync: fetch failed, sync skipped\n');
    writeGate(retryFile(project, env), now);
    return false;
  }
  let result;
  try {
    const { main } = await importFn(pathToFileURL(file).href);
    result = await main(['--repo', repo, '--project', project], childEnv(env, installPath));
  } catch {
    process.stderr.write('session-sync: the plugin\'s sync failed\n');
  }
  if (!result || !result.synced) {
    writeGate(retryFile(project, env), now);
    return false;
  }
  writeGate(gateFile(project, env), now);
  return true;
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  if (process.argv[2] === RUN_FLAG) {
    runSync(process.argv[3], process.argv[4]).catch(() => {}).finally(() => process.exit(0));
  } else {
    try {
      requestSync(parseInput(readStdinText()));
    } catch { /* fail open */ }
    process.exit(0);
  }
}
