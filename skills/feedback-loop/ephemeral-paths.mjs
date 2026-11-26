#!/usr/bin/env node
// Slice 393 item 11: a slice (or note) file never cites a path inside a worktree's tmp/ folder, which `git worktree remove --force`
// deletes with the worktree (night 2026-11-14, wave 7: Slice 383's evidence files were lost that way). Evidence goes in the repo
// (a notes file) or under `<worktrees folder>/reviews/`, never under `<worktree>/tmp/`.
// Usage: node ephemeral-paths.mjs <file>...   Exit 0 when no file cites one, 1 when any does (each line printed), 2 on usage.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `...-worktrees/<name>/tmp/...` or `...-worktrees\<name>\temp\...`, in either slash direction, inside or outside backticks.
export const WORKTREE_TMP = /[\w.:~\\/-]*-worktrees[\\/][\w.-]+[\\/](?:tmp|temp)(?:[\\/]|\b)[^\s`'"<>|)]*/gi;

// [{ line, path }] for every worktree tmp/ path of a text.
export function ephemeralPaths(text) {
  return String(text ?? '').split(/\r?\n/).flatMap((line, i) => [...line.matchAll(WORKTREE_TMP)].map((m) => ({ line: i + 1, path: m[0] })));
}

function isEntryPoint() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) {
  const files = process.argv.slice(2);
  if (!files.length) { process.stderr.write('usage: ephemeral-paths.mjs <file>...\n'); process.exit(2); }
  let bad = 0;
  for (const file of files) {
    for (const hit of ephemeralPaths(readFileSync(file, 'utf8'))) {
      bad++;
      process.stdout.write(`${file}:${hit.line}: cites ${hit.path}, which is deleted with its worktree; copy the evidence into the repo (docs/plan/notes/) or <worktrees>/reviews/ and cite that\n`);
    }
  }
  process.exit(bad ? 1 : 0);
}
