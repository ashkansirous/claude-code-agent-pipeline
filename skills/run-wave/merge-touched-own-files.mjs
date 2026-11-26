#!/usr/bin/env node
// ship-branch M2 helper: after `git merge origin/main` into a PR branch, did the merge change any of the PR's own
// files? Usage: node merge-touched-own-files.mjs <worktree> <old-head> [new-head=HEAD] [base=origin/main]
// The PR's own files are `git diff --name-only <base>...<old-head>` (three-dot); the merge's effect is
// `git diff --name-only <old-head>..<new-head>`. Prints each own file the merge touched; exit 0 when none (push
// and keep waiting for CI, the CI run on the pushed merge commit is the check), exit 1 when any (push and stop,
// the caller re-runs the checks), exit 2 on a git error (treat as touched). (Slice 306)
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function touchedOwnFiles(own, merged) {
  const norm = (p) => String(p).replace(/\\/g, '/');
  const ownSet = new Set(own.map(norm));
  return merged.map(norm).filter((p) => ownSet.has(p));
}

const lines = (text) => text.split(/\r?\n/).filter(Boolean);

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function mergeTouchedOwnFiles(cwd, oldHead, newHead = 'HEAD', base = 'origin/main') {
  // Three-dot: the PR's changes against its merge base with `base`, whatever earlier merges of main it holds.
  // --no-renames: with rename detection a rename lists only the new path, hiding that the old (PR-edited) path changed.
  const own = lines(git(cwd, ['diff', '--no-renames', '--name-only', `${base}...${oldHead}`]));
  const merged = lines(git(cwd, ['diff', '--no-renames', '--name-only', `${oldHead}..${newHead}`]));
  return touchedOwnFiles(own, merged);
}

function isEntryPoint() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) {
  const [cwd, oldHead, newHead, base] = process.argv.slice(2);
  if (!cwd || !oldHead) { process.stderr.write('usage: merge-touched-own-files.mjs <worktree> <old-head> [new-head] [base]\n'); process.exit(2); }
  try {
    const touched = mergeTouchedOwnFiles(cwd, oldHead, newHead, base);
    if (touched.length) process.stdout.write(`${touched.join('\n')}\n`);
    process.exit(touched.length ? 1 : 0);
  } catch (error) {
    process.stderr.write(`merge-touched-own-files: ${error.message}\n`);
    process.exit(2);
  }
}
