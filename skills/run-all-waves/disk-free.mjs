#!/usr/bin/env node
// Free space of the drives that hold the given folders, so a wave never claims slices onto a full disk
// (2026-11-07, ReadTheStupidText: wave 2 claimed four slices with C: at 0 GB free; reviews and commits failed).
//
// Usage: node disk-free.mjs <folder>[=<gb>] [<folder>[=<gb>] ...] [--min-gb 5]
// A folder may carry its own need after "=" (Slice 317 item 2: the temp drive and the worktree drive need different amounts); --min-gb is the need of the others.
// Prints one JSON line: { minGb, ok, folders: [{ path, freeGb, needGb }] } (freeGb null when the folder or drive cannot be read),
// so the need is printed next to the free space.
// Exit 0 when every readable folder has at least its need free, 1 when one has less (an unreadable one counts as low).
import { statfsSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MIN_GB = 5;
const BYTES_PER_GB = 1024 ** 3;
const LOW_EXIT = 1;
const USAGE_EXIT = 2;

// The nearest existing parent answers for a folder that is not created yet.
export function nearestExisting(path) {
  let current = resolve(path);
  while (!existsSync(current) && current !== parse(current).root) current = dirname(current);
  return current;
}

export function freeGbOf(path) {
  try {
    const stats = statfsSync(nearestExisting(path));
    return Math.round((Number(stats.bavail) * Number(stats.bsize) / BYTES_PER_GB) * 100) / 100;
  } catch { return null; }
}

// A need is only a trailing "=<digits>[.<digits>]" after the LAST "=" (plain decimal); anything else, "=" inside a folder name included, is part of the path.
// "D:\\worktrees=24" -> { path: "D:\\worktrees", needGb: 24 }; no such tail -> { path: arg, needGb: null } (the default need applies).
const TRAILING_NEED = /^(.+)=(\d+(?:\.\d+)?)$/;
export function splitNeed(arg) {
  const match = TRAILING_NEED.exec(arg);
  if (!match) return { path: arg, needGb: null };
  return { path: match[1], needGb: Number(match[2]) };
}

export function checkFolders(folders, minGb = DEFAULT_MIN_GB, reader = freeGbOf) {
  const entries = folders.map(splitNeed).map(({ path, needGb }) => ({ path, freeGb: reader(path), needGb: needGb ?? minGb }));
  const ok = entries.every((entry) => entry.freeGb !== null && entry.freeGb >= entry.needGb);
  return { minGb, ok, folders: entries };
}

export function parseArgs(argv) {
  const folders = [];
  let minGb = DEFAULT_MIN_GB;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--min-gb') minGb = Number(argv[++i]);
    else folders.push(argv[i]);
  }
  return { folders, minGb: Number.isFinite(minGb) && minGb >= 0 ? minGb : null };
}

// Real paths: ~/.claude/skills/<name> is a symlink into the repo, so a plain compare would silently do nothing.
function isEntryPoint() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) {
  const { folders, minGb } = parseArgs(process.argv.slice(2));
  if (minGb === null) {
    console.error('disk-free: --min-gb needs a number of GB (0 or more)');
    process.exit(USAGE_EXIT);
  }
  let result;
  try { result = checkFolders(folders, minGb); } catch (error) {
    console.error(error.message);
    process.exit(USAGE_EXIT);
  }
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : LOW_EXIT);
}
