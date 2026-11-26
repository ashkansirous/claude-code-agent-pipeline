#!/usr/bin/env node
// Lists the review files in a reviews folder (`<worktrees folder>/reviews/`, where the reviewer agents write
// their findings) that are older than N days, oldest first, with age and size, so the user or a loop can decide
// what to delete. LIST ONLY: this script never deletes, moves or edits a file (Slice 307, item 12: 478 files
// sat in one repo's folder and about 90 in AgentPipeline' since 2026-10-25, because the feedback loop deletes only
// its own round's). A merged PR's merge-gate `## Review` section names these files, so nothing here is removed
// automatically.
// Usage: node prune-reviews.mjs <reviews dir> [--days 14]
// Prints `<age in days>d<TAB><KB>KB<TAB><name>` per stale file and a summary line; exit 0 (also with none), 2 on usage.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const BYTES_PER_KB = 1024;

export function parseArgs(argv) {
  const rest = [];
  let days = DEFAULT_DAYS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--days') { rest.push(argv[i]); continue; }
    days = Number(argv[++i]);
    if (!Number.isFinite(days) || days < 0) return null;
  }
  return rest.length === 1 ? { dir: rest[0], days } : null;
}

// The files (not folders) older than `days`, oldest first. `entries` are { name, mtimeMs, size }.
export function staleFiles(entries, now, days) {
  return entries
    .filter((entry) => now - entry.mtimeMs > days * DAY_MS)
    .map((entry) => ({ ...entry, ageDays: Math.floor((now - entry.mtimeMs) / DAY_MS) }))
    .sort((a, b) => b.mtimeMs === a.mtimeMs ? a.name.localeCompare(b.name) : a.mtimeMs - b.mtimeMs);
}

export function formatList(stale, total, days) {
  const lines = stale.map((f) => `${f.ageDays}d\t${Math.ceil(f.size / BYTES_PER_KB)}KB\t${f.name}`);
  const kb = Math.ceil(stale.reduce((sum, f) => sum + f.size, 0) / BYTES_PER_KB);
  lines.push(`${stale.length} of ${total} files are older than ${days} days (${kb} KB). List only: nothing was deleted.`);
  return lines.join('\n');
}

export function readEntries(dir) {
  return readdirSync(dir).flatMap((name) => {
    // A broken symlink or a file deleted since readdirSync is skipped, not a failure of the whole list.
    const info = statSync(join(dir, name), { throwIfNoEntry: false });
    return info?.isFile() ? [{ name, mtimeMs: info.mtimeMs, size: info.size }] : [];
  });
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write('usage: node prune-reviews.mjs <reviews dir> [--days 14]\n');
    return 2;
  }
  let entries;
  try {
    entries = readEntries(args.dir);
  } catch (error) {
    process.stderr.write(`prune-reviews: cannot read ${args.dir}: ${error.message}\n`);
    return 2;
  }
  process.stdout.write(formatList(staleFiles(entries, Date.now(), args.days), entries.length, args.days) + '\n');
  return 0;
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo (see entry-points.test.mjs).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) process.exit(main(process.argv.slice(2)));
