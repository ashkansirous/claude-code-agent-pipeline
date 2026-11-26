#!/usr/bin/env node
// Deletes leftover app builds (installer copies) from the top level of a temp folder, so a run of emulator
// installs cannot fill the disk. Only package files directly in the folder, older than --min-age-minutes, are
// removed: a build a live test is installing right now is younger than that and stays.
// (2026-11-07, ReadTheStupidText: 1,402 tmp*.apk copies, 124.5 GB, filled C: and stopped a run-all-waves night.)
//
// Usage: node clean-temp-builds.mjs <temp dir> [--min-age-minutes 120]
// Prints one JSON line: { dir, deleted, freedBytes, failed, minAgeMinutes }. Exit 0 even when some deletes fail
// and when the folder is missing (nothing deleted). A drive or filesystem root is refused: error result, exit 2.
import { readdirSync, statSync, rmSync, realpathSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD_EXTENSIONS = ['.apk', '.apks', '.aab', '.ipa', '.msix', '.msixbundle', '.appx', '.appxbundle'];
export const DEFAULT_MIN_AGE_MINUTES = 120;
const MS_PER_MINUTE = 60_000;

export function isBuildFile(name) {
  const lower = name.toLowerCase();
  return BUILD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Old enough build files directly in dir (never inside subfolders: those belong to tools that clean them).
// A file is as young as its newest timestamp: a copy keeps the source's old mtime but gets a new birth time.
export function findOldBuilds(dir, minAgeMinutes, now = Date.now()) {
  const cutoff = now - minAgeMinutes * MS_PER_MINUTE;
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !isBuildFile(entry.name)) continue;
    const path = join(dir, entry.name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat && Math.max(stat.mtimeMs, stat.birthtimeMs) < cutoff) found.push({ path, size: stat.size });
  }
  return found;
}

export function isFilesystemRoot(dir) {
  const full = resolve(dir);
  return parse(full).root === full;
}

export function cleanTempBuilds(dir, minAgeMinutes = DEFAULT_MIN_AGE_MINUTES, now = Date.now()) {
  const result = { dir, deleted: 0, freedBytes: 0, failed: 0, minAgeMinutes };
  if (isFilesystemRoot(dir)) return { ...result, error: 'refusing to clean a drive or filesystem root' };
  if (!statSync(dir, { throwIfNoEntry: false })) return result;
  for (const file of findOldBuilds(dir, minAgeMinutes, now)) {
    try {
      rmSync(file.path, { force: true });
      result.deleted += 1;
      result.freedBytes += file.size;
    } catch {
      // no-fallback: a file another process holds open stays; the count reports it
      result.failed += 1;
    }
  }
  return result;
}

function parseArgs(argv) {
  const dir = argv[0];
  if (!dir) throw new Error('usage: clean-temp-builds.mjs <temp dir> [--min-age-minutes N]');
  const flag = argv.indexOf('--min-age-minutes');
  const minAge = flag >= 0 ? Number(argv[flag + 1]) : DEFAULT_MIN_AGE_MINUTES;
  if (!Number.isFinite(minAge) || minAge < 0) throw new Error(`bad --min-age-minutes: ${argv[flag + 1]}`);
  return { dir, minAge };
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
// Never throws: bad arguments and unreadable folders become a JSON result with an error field.
export function runCli(argv) {
  const dir = argv[0] ?? null;
  try {
    const parsed = parseArgs(argv);
    return cleanTempBuilds(parsed.dir, parsed.minAge);
  } catch (error) {
    return { dir, deleted: 0, freedBytes: 0, failed: 0, error: error.message };
  }
}

if (invokedDirectly) {
  const result = runCli(process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (result.error) process.exitCode = 2;
}
