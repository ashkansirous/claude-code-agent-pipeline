#!/usr/bin/env node
// Slice 393 item 20: when only the user can make an edit (an `autoMode` allow line pasted into settings.example.json), the file is opened
// in a worktree on a branch, never in the primary checkout: a pasted line in the primary blocks every fast-forward and the re-copy into `~/.claude`
// (2026-11-14 and 2026-11-15: the user ran `git restore` by hand twice).
// Usage: node paste-worktree.mjs <repo-root> <file-relative-to-repo> <line> [--slug <name>] [--dry-run]
// Prints the `code -g <worktree>/<file>:<line>` command to give the user. Creates `<repo>-worktrees/<slug>` on `chore/<slug>` from
// origin/main when it does not exist (after `git fetch origin`); --dry-run only prints what it would do. Exit 2 on usage, 1 when git fails.
import { existsSync, realpathSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const DEFAULT_SLUG = 'paste';

// A new slug for each paste (paste-20261118-153045), so a second paste never reuses an old worktree or its `chore/paste` branch.
export function uniqueSlug(now = new Date()) {
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
  return `${DEFAULT_SLUG}-${stamp.slice(0, 8)}-${stamp.slice(8)}`;
}

// The worktree folder for a repo root: the sibling `<repo>-worktrees/<slug>` (the layout every repo of the user's uses).
export function worktreePath(repoRoot, slug) {
  // A drive path (D:/R) or a rooted one is used as given: Linux's resolve would put D:/R under its cwd.
  const given = repoRoot.replace(/\\/g, '/');
  const root = (/^([A-Za-z]:)?\//.test(given) ? given : resolve(given).replace(/\\/g, '/')).replace(/\/+$/, '');
  return posix.join(posix.dirname(root), `${posix.basename(root)}-worktrees`, slug);
}

export function codeCommand(worktree, file, line) {
  return `code -g ${worktree}/${file.replace(/\\/g, '/')}:${line}`;
}

function git(repoRoot, args) {
  const run = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(run.stderr || run.stdout).trim()}`);
  return run.stdout.trim();
}

export function parseArgs(argv) {
  const positional = [];
  const options = { slug: uniqueSlug(), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--slug') options.slug = argv[++i] ?? '';
    else if (argv[i] === '--dry-run') options.dryRun = true;
    else positional.push(argv[i]);
  }
  const [repoRoot, file, line] = positional;
  if (!repoRoot || !file || !/^\d+$/.test(line ?? '') || !/^[\w.-]+$/.test(options.slug)) return null;
  return { repoRoot, file, line, ...options };
}

function isEntryPoint() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) { process.stderr.write('usage: paste-worktree.mjs <repo-root> <file> <line> [--slug <name>] [--dry-run]\n'); process.exit(2); }
  const worktree = worktreePath(args.repoRoot, args.slug);
  try {
    if (!existsSync(worktree)) {
      const add = ['worktree', 'add', '-b', `chore/${args.slug}`, worktree, 'origin/main'];
      if (args.dryRun) process.stdout.write(`would run: git -C ${args.repoRoot} fetch origin; git -C ${args.repoRoot} ${add.join(' ')}\n`);
      else { git(args.repoRoot, ['fetch', 'origin']); git(args.repoRoot, add); }
    }
    process.stdout.write(`${codeCommand(worktree, args.file, args.line)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
}
