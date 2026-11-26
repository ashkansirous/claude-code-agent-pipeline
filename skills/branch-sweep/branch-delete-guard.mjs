#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell: denies `git branch -d|-D|--delete <b>` unless `gh pr list --state merged --head <b>`
// finds a merged PR whose head is that branch (Slice 18; night 2026-11-17-1657: a ship-branch agent ran `git branch -d chore/issues`
// on a branch no merged PR had as its head, and the main thread restored it from a sha). `agents/ship-branch.md` and the
// branch-sweep skill already forbid it; this enforces it.
// The guard acts only on a command that, trimmed, is one line of exactly
// `git [-C <native absolute path>] branch (-d|-D|--delete|-df|-Df) [--force] <name> [<name>...]` with plain names. Anything else
// (quotes, ; && |, $, backticks, redirects, globs, ~, env assignments, --git-dir, wrappers, several lines, other flags) is allowed
// untouched: it denies only what it is certain of. Fail open: a `gh` that fails or cannot be parsed lets the call through.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_NAMES = 10;
const NAME = /^[A-Za-z0-9._/-]+$/;
const DIR = /^[^\s"'`$;&|<>*?~()!{}\[\]#%^=,]+$/;
const NATIVE_ABSOLUTE = process.platform === 'win32' ? /^[a-zA-Z]:[\\/]/ : /^\//;
// The MSYS drive form (/d/x) is a native path on Linux but not on Windows: never certain, so allowed on every platform.
const MSYS_DRIVE = /^\/[A-Za-z](\/|$)/;
const SHAPE =/^git(?: -C (\S+))? branch (-d|-D|--delete|-df|-Df)((?: --force)?)((?: +\S+)+)$/;

// { dir, names } for a command of exactly the one shape above (dir null = the hook's cwd); null for anything else.
export function parseDelete(command) {
  const text = String(command ?? '').trim();
  const match = SHAPE.exec(text);
  if (!match) return null;
  const [, dir, , , rest] = match;
  if (dir !== undefined && (MSYS_DRIVE.test(dir) || !NATIVE_ABSOLUTE.test(dir) || !DIR.test(dir))) return null;
  const names = [...new Set(rest.trim().split(/ +/))];
  if (names.length > MAX_NAMES || !names.every((name) => NAME.test(name) && !name.startsWith('-'))) return null;
  return { dir: dir ?? null, names };
}

// true when a merged PR has the branch as its head and the branch has nothing newer: the PR's head commit is the branch's tip, or
// the tip is already in origin/main (a reused name, or commits added after the merge, lose work). When the tip or the PR's head
// commit cannot be read for sure, a merged PR alone allows it (the guard denies only what it is certain of). Throws when gh fails
// or answers something unreadable.
export function hasMergedPr(branch, dir, run = defaultRun, git = defaultGit, fetched = new Set()) {
  const out = run(['pr', 'list', '--state', 'merged', '--head', branch, '--json', 'number,headRefOid', '--limit', '30'], dir);
  const parsed = JSON.parse(out);
  if (!Array.isArray(parsed)) throw new Error('gh pr list did not return a list');
  if (!parsed.length) return false;
  const tip = readTip(branch, dir, git);
  if (!tip || parsed.some((pr) => typeof pr.headRefOid !== 'string')) return true;
  if (parsed.some((pr) => pr.headRefOid === tip)) return true;
  let reached = inMain(tip, dir, git);
  if (reached === false) {
    // A stale local origin/main would deny a branch that merged since the last fetch (Slice 23 item 6): fetch it once and look again.
    // One fetch per hook call and directory (a failed fetch is remembered too): offline, the first answer stands.
    if (!fetched.has(dir ?? '')) {
      fetched.add(dir ?? '');
      try { git(['fetch', '--quiet', 'origin', 'main'], dir); reached = inMain(tip, dir, git); } catch { /* offline: the first answer stands */ }
    }
  }
  return reached !== false;
}

function readTip(branch, dir, git) {
  try { return String(git(['rev-parse', '--verify', `refs/heads/${branch}`], dir)).trim() || null; } catch { return null; }
}

// true / false when git says the tip is / is not in origin/main; null when it cannot tell.
function inMain(tip, dir, git) {
  try {
    git(['merge-base', '--is-ancestor', tip, 'origin/main'], dir);
    return true;
  } catch (error) {
    return error?.status === 1 ? false : null;
  }
}

const FETCH_TIMEOUT_MS = 5000;

function defaultGit(args, dir) {
  return execFileSync('git', args, { encoding: 'utf8', cwd: dir || undefined, timeout: args[0] === 'fetch' ? FETCH_TIMEOUT_MS : 20000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function defaultRun(args, dir) {
  return execFileSync('gh', args, { encoding: 'utf8', cwd: dir || undefined, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

export function decide(input, run = defaultRun, warn = (text) => process.stderr.write(text), git = defaultGit) {
  const call = parseDelete(input?.tool_input?.command);
  if (!call) return null;
  const dir = call.dir ?? input?.cwd;
  if (!dir) {
    warn('branch-delete-guard: let the call through (the repo it runs in cannot be told for sure)\n');
    return null;
  }
  const unmerged = [];
  const fetched = new Set();
  for (const branch of call.names) {
    try {
      if (!hasMergedPr(branch, dir, run, git, fetched)) unmerged.push(branch);
    } catch (error) {
      warn(`branch-delete-guard: let ${branch} through (gh pr list failed: ${String(error.message ?? error).split(/\r?\n/)[0]})\n`);
    }
  }
  if (!unmerged.length) return null;
  return deny(`branch-delete guard: no merged PR has ${unmerged.join(', ')} as its head, or the branch has commits that PR did not merge (\`gh pr list --state merged --head <branch>\` compared with the branch tip and origin/main), so deleting it loses work that is on no other branch. Only a merged PR's head is deleted (agents/ship-branch.md, the branch-sweep skill). Ask the owner, or keep the branch.`);
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo (see entry-points.test.mjs).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch (error) {
    process.stderr.write(`branch-delete-guard: realpath failed (${error.message}); comparing plain paths\n`);
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`branch-delete-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
