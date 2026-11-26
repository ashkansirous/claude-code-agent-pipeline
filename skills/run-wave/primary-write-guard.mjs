#!/usr/bin/env node
// PreToolUse hook on Write, Edit and NotebookEdit: asks before a file is written inside a primary checkout
// that has linked worktrees. All coding happens in worktrees (~/.claude/CLAUDE.md, Work in a worktree); a
// stray file in the primary blocks `ff-primary.mjs` after the next merge. On night 2026-11-01-2355
// (ReadTheStupidText) an agent left an empty `tests/DinoReader.Tests/ScrollAnchorRulesTests.cs` in the
// primary and the fast-forward after #724 stopped on it; `primary-checkout-guard.mjs` covers git commands
// only. "ask", not "deny": the user may say to edit the primary on purpose. Files under `.git/` pass.
// A primary is a folder whose `.git` is a directory holding a non-empty `worktrees/` folder.
// An internal error lets the call through (fail open), with a note on stderr.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REASON =
  'This writes into a primary checkout that has worktrees. All coding happens in a worktree ' +
  '(~/.claude/CLAUDE.md, Work in a worktree), and a stray file here blocks ff-primary after the next merge. ' +
  'Write the file in your worktree instead, unless the user asked for this edit in the primary.';

// A `worktrees/<name>` entry is live only when its `gitdir` file points at a path that still exists;
// stale (prunable) entries whose folder is gone do not count.
function isLiveEntry(entryDir) {
  try {
    const target = readFileSync(join(entryDir, 'gitdir'), 'utf8').trim();
    return target !== '' && existsSync(target);
  } catch {
    return false;
  }
}

function hasWorktrees(gitDir) {
  try {
    const root = join(gitDir, 'worktrees');
    return readdirSync(root).some((name) => isLiveEntry(join(root, name)));
  } catch {
    return false;
  }
}

// Resolves the nearest existing ancestor through realpath so a write via a symlink/junction is judged by
// where it really lands.
export function realTarget(filePath) {
  const target = resolve(filePath);
  let existing = dirname(target);
  const missing = [target.slice(existing.length).replace(/^[\\/]+/, '')];
  for (let i = 0; i < 64; i++) {
    try {
      return join(realpathSync.native(existing), ...missing);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return target;
      missing.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ''));
      existing = parent;
    }
  }
  return target;
}

export function primaryWithWorktrees(filePath) {
  let dir = dirname(realTarget(filePath));
  for (let i = 0; i < 64; i++) {
    const gitPath = join(dir, '.git');
    try {
      return statSync(gitPath).isDirectory() && hasWorktrees(gitPath) ? dir : null;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

export function decide(input, findPrimary = primaryWithWorktrees) {
  const filePath = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  if (!filePath) return null;
  const parts = resolve(filePath).split(/[\\/]/);
  if (parts.includes('.git')) return null;
  if (!findPrimary(filePath)) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: REASON } };
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo (see entry-points.test.mjs).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch (error) {
    process.stderr.write(`primary-write-guard: realpath failed (${error.message}); comparing plain paths\n`);
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`primary-write-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
