#!/usr/bin/env node
// Prints the `Reviewed files:` block a review findings file ends with (the merge gate reads it): one line per
// changed code file (not Markdown, docs/design/ or the repo's `contentPaths`: `isDocPath` in merge-gate.mjs) of a worktree, `<repo-relative path> <git blob sha>`, `<path> deleted` for a deleted
// file. Changed = `git diff --name-only --no-renames <merge-base of origin/main and HEAD>` (working tree) plus untracked
// files, paths unquoted (`core.quotepath=false`, NUL-separated).
// Usage: node reviewed-files.mjs <worktree>
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';

// A diff with many thousand paths overflows Node's 1 MB default (ENOBUFS, night 2026-11-04-1441).
const MAX_BUFFER = 256 * 1024 * 1024;
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDocPath, contentPathsFor } from './merge-gate.mjs';

const BASE_REF = 'origin/main';
const DELETED = 'deleted';
const HEADING = 'Reviewed files:';

function runGit(worktree, args, input) {
  return execFileSync('git', ['-C', worktree, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER });
}

const names = (text) => text.split('\0').filter(Boolean);

// Falls back to the origin/main tip when there is no merge base (shallow clone, unrelated history).
function mergeBase(worktree, git) {
  try {
    const base = git(worktree, ['merge-base', BASE_REF, 'HEAD']).trim();
    if (base) return base;
  } catch {
    // reported below
  }
  process.stderr.write(`reviewed-files: no merge base with ${BASE_REF}; listing changes against its tip (newer main files may show)\n`);
  return BASE_REF;
}

// Diffs against the merge base, not the origin/main tip: once main moves during a wave, a tip diff
// lists main's newer files as changed or `deleted` (2026-11-01, print-the-damn-book Slice 18 check 3).
export function changedPaths(worktree, git = runGit) {
  const base = mergeBase(worktree, git);
  const tracked = names(git(worktree, ['diff', '--name-only', '--no-renames', '-z', base]));
  const untracked = names(git(worktree, ['ls-files', '-o', '--exclude-standard', '-z']));
  // The repo's own contentPaths (.claude/merge-gate.json on origin/main) are docs to the gate too (Slice 26).
  const content = contentPathsFor({ baseRefName: 'main' }, worktree, git, (m) => process.stderr.write(`reviewed-files: ${m}`));
  return [...new Set([...tracked, ...untracked])].filter((p) => !isDocPath(p, content)).sort();
}

// One `git hash-object --stdin-paths` for all existing files: a process per file ran the LFS clean filter
// each time and died on ~1,400 new LFS clips (Slice 26).
const hashOne = (worktree, path, git) => git(worktree, ['hash-object', '--', path]).trim();

// --stdin-paths reads one path per line, so only plain regular files without a newline or a leading quote go in the batch.
function isBatchable(worktree, path) {
  if (/[\n\r]/.test(path) || path.startsWith('"')) return false;
  try { return lstatSync(join(worktree, path)).isFile(); } catch { return false; }
}

// The batch output is matched to paths by position, so a count mismatch falls back to one call per path.
function hashBatch(worktree, paths, git) {
  if (!paths.length) return [];
  try {
    const shas = git(worktree, ['hash-object', '--stdin-paths'], `${paths.join('\n')}\n`).split('\n').filter(Boolean);
    if (shas.length === paths.length) return shas;
  } catch {
    // a path vanished or became unreadable mid-run: hash one by one below
  }
  return paths.map((p) => hashExisting(worktree, p, git));
}

// A path that vanished since the listing has no blob, so it is reported `deleted` like any deleted file.
function hashExisting(worktree, path, git) {
  try { return hashOne(worktree, path, git); } catch (error) {
    if (existsSync(join(worktree, path))) throw error;
    return undefined;
  }
}

function blobsOf(worktree, paths, git) {
  const batch = paths.filter((p) => isBatchable(worktree, p));
  const single = paths.filter((p) => !batch.includes(p));
  const blobs = new Map();
  hashBatch(worktree, batch, git).forEach((sha, i) => blobs.set(batch[i], sha));
  single.forEach((p) => blobs.set(p, hashExisting(worktree, p, git)));
  return blobs;
}

export function reviewedBlock(worktree, git = runGit) {
  const paths = changedPaths(worktree, git);
  const present = paths.filter((p) => existsSync(join(worktree, p)));
  const blobs = blobsOf(worktree, present, git);
  const lines = paths.map((path) => `${path} ${blobs.get(path) ?? DELETED}`);
  return `${HEADING}\n${lines.join('\n')}\n`;
}

export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  if (!process.argv[2]) {
    process.stderr.write('usage: node reviewed-files.mjs <worktree>\n');
    process.exit(2);
  }
  process.stdout.write(reviewedBlock(process.argv[2]));
}
