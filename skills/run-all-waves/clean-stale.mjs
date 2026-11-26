#!/usr/bin/env node
// Deletes what a run or a wave leaves behind on the worktree drive and the temp drive, so neither fills up.
// (2026-11-08, ReadTheStupidText: D: hit 0 bytes because `_builds` held 35 GB of cache entries since 2026-10-28;
// the build cache only prunes the building worktree's own entries. User: "if it is there for 24 hours, it is not
// needed, both in C drive temp and in D drive build, worktree etc.")
// Principle: when in doubt, keep. Unknown age, a held folder, a capped scan or a failed backup all mean "keep".
//
// Modes (one JSON line on stdout; exit 0 even when some deletes fail; a drive root, a folder not named
// `<repo>-worktrees` or a bad --hours is refused: error result, exit 2):
//   --wave <worktrees dir> (--ledger | --slices <NNN,...> | --worktrees <name,...>) [--temp <temp dir>] [--dry-run]
//       End of a wave: delete the `_builds` entries whose build.json records a worktree of this wave (--ledger reads
//       the highest wave of <dir>/wave-ledger.md, ignored when its last write is over 24 h old; a worktree belongs to
//       slice NNN when its folder name is exactly sNNN, or the branch git lists for it is */NNN-* or */NNN),
//       never one a live process holds (one holder check for all candidates), never `packs` or a
//       `.building-*` entry; with --temp also the old temp build files (the clean-temp-builds.mjs pass).
//   --stale <worktrees dir> --temp <temp dir> [--hours 24] [--dry-run]     (--hours is at least 1)
//       End of a run: (a) `git worktree prune`; (b) `_builds` entries whose newest file is older than --hours (not
//       `packs`, not `.building-*`, not held); (c) git worktrees idle for --hours (newest of folder, index, HEAD commit
//       and every modified or untracked file), never a held one, the primary checkout, one under a `_*`, `.*`,
//       `reviews` or `run-all-waves` folder, a detached HEAD on no branch, or one mid merge/rebase/cherry-pick;
//       its diff (--binary) and every untracked file are copied to <repo>/.git/worktree-backups/<name>-<stamp>/
//       first (git-ignored files too, except build output and files over 20 MB, which README.txt lists; the folder is
//       <name>-<yyyymmddHHmmss>-<random>, never reused) and a failed backup means no removal; a backup over 500 MB or
//       leaving under 5 GB free keeps the worktree (keptBackupTooBig); the branch stays; (d) other top-level folders of the worktrees
//       dir idle for --hours (deep newest time), except `_*`, `.*`, `reviews`, `run-all-waves`, held ones and any
//       folder containing a `.git`; (e) top-level entries of the temp dir idle for --hours (deep newest time, birth
//       time counts), except `claude`; no holder check there: a delete that fails (in use) is skipped, not an error.
//       `_builds` entries age by their own top-level times (written once), not a deep scan.
import { readdirSync, statSync, statfsSync, lstatSync, rmSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, realpathSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname, resolve, parse, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cleanTempBuilds } from './clean-temp-builds.mjs';

export const DEFAULT_HOURS = 24;
export const MIN_HOURS = 1;
export const BUILDS_DIR = '_builds';
export const BUILD_META_FILE = 'build.json';
export const LEDGER_FILE = 'wave-ledger.md';
export const PACKS_BUILD_NAME = 'packs';
export const BUILDING_PREFIX = '.building-';
export const WORKTREES_SUFFIX = '-worktrees';
export const KEEP_TEMP_NAMES = ['claude'];
// `reviews` holds the findings files that merge-gate.mjs requires on disk for every open PR.
export const KEEP_WORKTREE_DIR_NAMES = ['run-all-waves', 'reviews'];
export const TOOL_PREFIXES = ['_', '.'];
export const DEEP_MAX_DEPTH = 6;
export const DEEP_MAX_FILES = 50_000;
export const LEDGER_MAX_AGE_HOURS = 24;
// Git-ignored files the backup does not copy: build output and caches, packages, and anything big.
export const BACKUP_SKIP_DIRS = ['bin', 'obj', 'node_modules', '.artifacts', '.gradle', '.vs'];
export const BACKUP_SKIP_EXTENSIONS = ['.apk', '.msix'];
export const BACKUP_MAX_BYTES = 20 * 1024 * 1024;
export const BACKUP_README = 'README.txt';
export const IN_PROGRESS_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];
// A worktree whose backup would be bigger than this, or would leave the backup drive under MIN_FREE, is kept (kept-backup-too-big).
export const BACKUP_TOTAL_MAX_BYTES = 500 * 1024 * 1024;
export const BACKUP_MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;
const BACKUP_DIR_ATTEMPTS = 5;
const BACKUP_SUFFIX_BYTES = 3;
const MS_PER_HOUR = 3_600_000;
// One pwsh process checks every candidate. The driver kills the whole node run after -StaleCleanupTimeoutSeconds (900 s,
// run-all-waves.ps1), so this cap must stay below it, leaving time for the deletes and backups after the check.
export const HOLDERS_TIMEOUT_MS = 480_000;
const HOLD_LINE_PATTERN = /^HOLD\t(\d+)\t(.*)$/;
const GIT_TIMEOUT_MS = 120_000;
const HOLDERS_NOT_HELD_EXIT = 0;

export function isFilesystemRoot(dir) {
  const full = resolve(dir);
  return parse(full).root === full;
}

export function cutoffMs(now, hours) {
  return now - hours * MS_PER_HOUR;
}

// "<repo>-worktrees" -> "<repo>" (sibling); null when the folder is not named that way.
export function repoNameFromWorktreesDir(dir) {
  const leaf = basename(resolve(dir));
  return leaf.endsWith(WORKTREES_SUFFIX) && leaf.length > WORKTREES_SUFFIX.length ? leaf.slice(0, -WORKTREES_SUFFIX.length) : null;
}

// Why a folder may not be cleaned, or null.
export function worktreesDirError(dir) {
  if (isFilesystemRoot(dir)) return 'refusing to clean a drive or filesystem root';
  if (!repoNameFromWorktreesDir(dir)) return `refusing to clean a folder not named <repo>${WORKTREES_SUFFIX}: ${dir}`;
  return null;
}

export function hoursError(hours) {
  return Number.isFinite(hours) && hours >= MIN_HOURS ? null : `bad --hours (needs a number of at least ${MIN_HOURS}): ${hours}`;
}

// ---- pure decisions -------------------------------------------------------------------------------------------

export function isProtectedBuildName(name) {
  return name === PACKS_BUILD_NAME || name.startsWith(BUILDING_PREFIX);
}

// Slice numbers of the highest wave in a wave-ledger.md (`## Wave <n> (open)`, `- Slice NNN ...` lines).
export function parseLedgerSlices(text) {
  const waves = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const head = /^##\s+Wave\s+(\d+)/i.exec(line);
    if (head) { current = { n: Number(head[1]), slices: [] }; waves.push(current); continue; }
    const slice = /^-\s+Slice\s+(\d+)/i.exec(line);
    if (slice && current) current.slices.push(slice[1]);
  }
  if (!waves.length) return [];
  return waves.reduce((top, wave) => (wave.n > top.n ? wave : top)).slices;
}

// True when a worktree folder name is exactly `s<N>` or starts with `<N>-`, or a branch name is `*/<N>-*` or `*/<N>`
// (s320, 320-foo, feat/320-x, feat/320; not s3200, and not a number inside a date or another name such as
// chore-docs-index-2026-11-08, which would put another session's build on the wave's list).
export function matchesSlice(name, slices, branch = '') {
  const branchName = String(branch ?? '').replace(/^refs\/heads\//, '');
  return slices.filter((s) => /^\d+$/.test(s)).some((s) => name === `s${s}` || new RegExp(`^.+/${s}(-.*)?$`).test(branchName));
}

// "folder name (lower case) -> branch" of the registered worktrees, from `git worktree list --porcelain`; a failure gives
// an empty map, so only the exact `s<N>` folder names match.
export function worktreeBranches(listText) {
  const map = new Map();
  for (const wt of parseWorktreeList(listText)) if (wt.branch) map.set(basename(wt.path).toLowerCase(), wt.branch);
  return map;
}

// Entries recording a worktree of the wave (by exact name, folder `s<N>` or the worktree's own branch); never packs or a
// build in progress. `branches` maps a worktree folder name (lower case) to its branch.
export function selectWaveBuilds(entries, worktreeNames, slices = [], branches = new Map()) {
  const names = new Set(worktreeNames);
  return entries.filter((entry) => entry.worktree && !isProtectedBuildName(entry.name)
    && (names.has(entry.worktree) || names.has(basename(entry.worktree))
      || matchesSlice(basename(entry.worktree), slices, branches.get(basename(entry.worktree).toLowerCase()))));
}

// Entries whose deep newest timestamp is older than the cutoff. Unknown or capped times are kept.
export function selectStaleEntries(entries, now, hours) {
  const cutoff = cutoffMs(now, hours);
  return entries.filter((entry) => !isProtectedBuildName(entry.name) && Number.isFinite(entry.newestMs) && entry.newestMs < cutoff);
}

// Worktrees to remove: idle past the cutoff, not the primary checkout, not held, not under a tool folder, safe to lose.
export function selectStaleWorktrees(worktrees, now, hours) {
  const cutoff = cutoffMs(now, hours);
  return worktrees.filter((wt) => !wt.primary && !wt.held && !wt.toolOwned && !wt.unsafe
    && Number.isFinite(wt.activityMs) && wt.activityMs < cutoff);
}

export function isToolOwnedName(name) {
  return TOOL_PREFIXES.some((prefix) => name.startsWith(prefix)) || KEEP_WORKTREE_DIR_NAMES.includes(name);
}

// True when the worktree lives under a `_*`, `.*`, `reviews` or `run-all-waves` top-level folder of the worktrees dir.
export function isUnderToolFolder(wtPath, worktreesDir) {
  const first = relative(resolve(worktreesDir), resolve(wtPath)).split(/[\\/]/)[0];
  return isToolOwnedName(first);
}

// Top-level folders of the worktrees dir that are not worktrees, repos, tool-owned or held, and idle past the cutoff.
export function selectStaleFolders(folders, worktreeNames, now, hours) {
  const cutoff = cutoffMs(now, hours);
  const skip = new Set(worktreeNames);
  return folders.filter((folder) => !isToolOwnedName(folder.name) && !skip.has(folder.name) && !folder.isWorktree
    && !folder.hasGit && !folder.holdsWorktree && Number.isFinite(folder.newestMs) && folder.newestMs < cutoff);
}

export function selectStaleTempEntries(entries, now, hours) {
  const cutoff = cutoffMs(now, hours);
  return entries.filter((entry) => !KEEP_TEMP_NAMES.includes(entry.name.toLowerCase())
    && Number.isFinite(entry.newestMs) && entry.newestMs < cutoff);
}

// "<worktree>-<yyyymmddHHmmss>[-<suffix>]": the backup folder holding changes.patch and untracked/.
export function backupName(worktreeName, date, suffix = '') {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${worktreeName}-${stamp}${suffix ? `-${suffix}` : ''}`;
}

// A backup folder that does not exist yet: stamp with seconds plus a short random suffix; an existing one is never reused.
export function newBackupDir(parent, worktreeName, date) {
  for (let attempt = 0; attempt < BACKUP_DIR_ATTEMPTS; attempt++) {
    const dir = join(parent, backupName(worktreeName, date, randomBytes(BACKUP_SUFFIX_BYTES).toString('hex')));
    if (!existsSync(dir)) return dir;
  }
  throw new Error('no free backup folder name');
}

// folder-holders.ps1 exit codes: 0 = clean "not held"; 1 held, 2 bad path, 3 partial check, anything else = unknown.
export function heldFromExit(status) {
  return status !== HOLDERS_NOT_HELD_EXIT;
}

// Parses `git worktree list --porcelain`: [{ path, branch, head, detached, primary }]; the first block is the primary checkout.
export function parseWorktreeList(text) {
  const blocks = text.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block, index) => {
    const lines = block.split(/\r?\n/);
    const field = (key) => (lines.find((l) => l.startsWith(`${key} `)) ?? '').slice(key.length + 1);
    return { path: field('worktree'), branch: field('branch'), head: field('HEAD'), detached: lines.includes('detached'), primary: index === 0 };
  });
}

// ---- file system helpers ----------------------------------------------------------------------------------------

// A copy keeps the source's old mtime but gets a new birth time, so temp entries count both (useBirth).
function newestOfStat(stat, useBirth) {
  return useBirth ? Math.max(stat.mtimeMs, stat.birthtimeMs ?? 0) : stat.mtimeMs;
}

// Newest timestamp anywhere in the entry (symlinks are not followed). Over the file cap the newest time is Infinity,
// which every selector reads as "keep"; below maxDepth a folder counts by its own time only. hasGit: a `.git` inside.
// Review item 4 ("the depth cap errs toward keep") is accepted: the scan is a cheap guess, and the real guard against
// deleting something in use is the holder check that runs on every candidate before it is deleted.
export function deepScan(path, options = {}) {
  const limits = { useBirth: false, maxDepth: DEEP_MAX_DEPTH, maxFiles: DEEP_MAX_FILES, ...options };
  const state = { newest: -Infinity, hasGit: false, count: 0, capped: false };
  scanInto(path, 0, limits, state);
  const newestMs = state.capped ? Infinity : (state.newest === -Infinity ? NaN : state.newest);
  return { newestMs, hasGit: state.hasGit, capped: state.capped };
}

function scanInto(path, depth, limits, state) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  state.count += 1;
  if (state.count > limits.maxFiles) { state.capped = true; return; }
  state.newest = Math.max(state.newest, newestOfStat(stat, limits.useBirth));
  if (!stat.isDirectory() || depth >= limits.maxDepth) return;
  for (const child of readdirSync(path)) {
    if (child === '.git') { state.hasGit = true; state.newest = Math.max(state.newest, newestOfStat(lstatSync(join(path, child)), limits.useBirth)); continue; }
    scanInto(join(path, child), depth + 1, limits, state);
    if (state.capped) return;
  }
}

export function sizeOf(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const child of readdirSync(path)) total += sizeOf(join(path, child));
  return total;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } // no-fallback: unreadable meta means unknown
}

function listBuildEntries(worktreesDir) {
  const root = join(worktreesDir, BUILDS_DIR);
  if (!statSync(root, { throwIfNoEntry: false })) return [];
  return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
    const path = join(root, e.name);
    const meta = readJson(join(path, BUILD_META_FILE));
    const built = meta?.built ? Date.parse(meta.built) : NaN;
    // A cache entry is written once, so its age is its own mtime, its top-level files' (build.json, logs) and the
    // recorded build time; a deep scan would hit the file cap on a big build and keep it forever.
    const newest = Math.max(deepScan(path, { maxDepth: 1 }).newestMs, Number.isFinite(built) ? built : 0);
    return { name: e.name, path, worktree: meta?.worktree ?? null, newestMs: newest };
  });
}

function listFolders(dir, registered) {
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
    const path = join(dir, e.name);
    const scan = deepScan(path);
    const prefix = realLower(path) + sep;
    const holdsWorktree = registered.some((wtPath) => realLower(wtPath).startsWith(prefix));
    return { name: e.name, path, isWorktree: existsSync(join(path, '.git')), hasGit: scan.hasGit || scan.capped, holdsWorktree, newestMs: scan.newestMs };
  });
}

export function listTempEntries(dir, useBirth = true) {
  return readdirSync(dir).map((name) => {
    const path = join(dir, name);
    const isDirectory = lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
    return { name, path, isDirectory, newestMs: deepScan(path, { useBirth }).newestMs };
  });
}

// ---- deleting ---------------------------------------------------------------------------------------------------

function emptyCount() {
  return { deleted: 0, freedBytes: 0, failed: 0, skipped: 0, paths: [] };
}

// lockedIsSkip (temp entries): they are judged by their timestamps only, so a delete that fails (a file in use) is
// counted as skipped, not failed, and is neither retried nor forced.
function deleteEntries(entries, dryRun, lockedIsSkip = false) {
  const result = emptyCount();
  const rmOptions = lockedIsSkip ? { recursive: true } : { recursive: true, force: true, maxRetries: 2, retryDelay: 200 };
  for (const entry of entries) {
    const size = safeSize(entry.path);
    if (dryRun) { result.deleted += 1; result.freedBytes += size; result.paths.push(entry.path); continue; }
    try {
      rmSync(entry.path, rmOptions);
      if (existsSync(entry.path)) throw new Error('still exists');
      result.deleted += 1;
      result.freedBytes += size;
    } catch {
      // no-fallback: a locked entry stays; the failed or skipped count reports it
      if (lockedIsSkip) result.skipped += 1; else result.failed += 1;
    }
  }
  return result;
}

function safeSize(path) {
  try { return sizeOf(path); } catch { return 0; } // no-fallback: size is only a report figure
}

function git(args, cwd, encoding = 'utf8') {
  return execFileSync('git', args, { cwd, encoding, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 });
}

// `HOLD<TAB><exit code><TAB><path>` lines of folder-holders.ps1 -ListFile -> Map(path -> held). Only a clean exit 0 is
// "not held"; a path with no line (the check timed out before it) is absent, which the caller reads as held.
export function parseHoldLines(text) {
  const held = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = HOLD_LINE_PATTERN.exec(line);
    if (match) held.set(match[2], heldFromExit(Number(match[1])));
  }
  return held;
}

// One pwsh process for all paths (a process per folder took seconds each and ran past the driver's budget).
// Returns Map(path -> held); on any failure or timeout the paths not reported are simply missing.
export function checkHeldBatch(paths, timeoutMs = HOLDERS_TIMEOUT_MS) {
  if (!paths.length) return new Map();
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'run-wave', 'folder-holders.ps1');
  const scratch = mkdtempSync(join(tmpdir(), 'clean-stale-'));
  const listFile = join(scratch, 'paths.txt');
  try {
    writeFileSync(listFile, paths.join('\n'), 'utf8');
    const run = spawnSync('pwsh', ['-NoProfile', '-File', script, '-ListFile', listFile], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return parseHoldLines(run.stdout); // stdout survives a timeout: the folders checked before it still count
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// A held-checker: prefetch(paths) asks about all new paths in one batch; isHeld(path) is true unless it was checked and
// found clean. A caller-supplied checker (tests) is used as it is.
function makeHeldChecker(custom) {
  if (custom) return { prefetch() {}, isHeld: custom };
  const known = new Map();
  return {
    prefetch(paths) { for (const [path, held] of checkHeldBatch([...new Set(paths)].filter((p) => !known.has(p)))) known.set(path, held); },
    isHeld: (path) => known.get(path) ?? true,
  };
}

// Splits entries into those safe to delete and the held ones.
function splitHeld(entries, isHeld) {
  const free = [];
  let skippedHeld = 0;
  for (const entry of entries) {
    if (isHeld(entry.path)) skippedHeld += 1; else free.push(entry);
  }
  return { free, skippedHeld };
}

function listModifiedPaths(repo, wtPath) {
  return git(['-C', wtPath, 'ls-files', '-m', '-o', '--exclude-standard', '-z'], repo).split('\0').filter(Boolean);
}

// Newest of: the folder, its index, the HEAD commit and every modified or untracked file.
function worktreeActivityMs(repo, wtPath) {
  let newest = lstatSync(wtPath).mtimeMs;
  const indexPath = git(['-C', wtPath, 'rev-parse', '--git-path', 'index'], repo).trim();
  const indexStat = statSync(resolve(wtPath, indexPath), { throwIfNoEntry: false });
  if (indexStat) newest = Math.max(newest, indexStat.mtimeMs);
  const commitSeconds = Number(git(['-C', wtPath, 'log', '-1', '--format=%ct'], repo).trim());
  if (Number.isFinite(commitSeconds)) newest = Math.max(newest, commitSeconds * 1000);
  for (const rel of listModifiedPaths(repo, wtPath)) {
    const stat = lstatSync(join(wtPath, rel), { throwIfNoEntry: false });
    if (stat) newest = Math.max(newest, stat.mtimeMs);
  }
  return newest;
}

// Why this worktree must stay although it is idle, or null: a merge/rebase/cherry-pick in progress, or a detached
// HEAD whose commits are on no branch (nothing else would keep them). A check that fails keeps the worktree.
function worktreeKeepReason(repo, wt) {
  try {
    const gitDir = git(['-C', wt.path, 'rev-parse', '--absolute-git-dir'], repo).trim();
    const operation = IN_PROGRESS_MARKERS.find((marker) => existsSync(join(gitDir, marker)));
    if (operation) return `${operation} in progress`;
    if (wt.detached && !git(['-C', wt.path, 'for-each-ref', '--contains', 'HEAD', 'refs/heads', 'refs/remotes'], repo).trim()) return 'detached HEAD on no branch';
    return null;
  } catch {
    return 'could not inspect'; // no-fallback: an uninspectable worktree stays
  }
}

// Splits git-ignored files into those worth a backup (.env, .dev.vars, local signing files, ...) and build output:
// a path under bin, obj, node_modules, .artifacts, .gradle or .vs, an .apk or .msix, or a file over 20 MB.
export function selectIgnoredBackups(relPaths, sizeOfFile) {
  const copy = [];
  const skipped = [];
  for (const rel of relPaths) {
    const parts = rel.split(/[\\/]/);
    const lower = rel.toLowerCase();
    if (parts.slice(0, -1).some((part) => BACKUP_SKIP_DIRS.includes(part))) skipped.push({ rel, reason: 'build output folder' });
    else if (BACKUP_SKIP_EXTENSIONS.some((ext) => lower.endsWith(ext))) skipped.push({ rel, reason: 'package file' });
    else if (sizeOfFile(rel) > BACKUP_MAX_BYTES) skipped.push({ rel, reason: 'over 20 MB' });
    else copy.push(rel);
  }
  return { copy, skipped };
}

function backupReadme(skipped) {
  const lines = ['Git-ignored files of this worktree that were NOT copied (build output or over 20 MB):', ...skipped.map((s) => `${s.rel}  (${s.reason})`)];
  return lines.join('\n') + '\n';
}

function copyInto(dir, group, wtPath, relPaths) {
  for (const rel of relPaths) {
    const target = join(dir, group, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(wtPath, rel), target, { recursive: true });
    if (!existsSync(target)) throw new Error(`backup of ${rel} missing`);
  }
}

function ignoredFileSize(wtPath, rel) {
  return lstatSync(join(wtPath, rel), { throwIfNoEntry: false })?.size ?? 0;
}

// Copies the diff (binary), every untracked non-ignored file and the git-ignored files that are not build output
// (the skipped ones are listed in README.txt); returns the backup folder, or null when there is nothing to keep.
export class BackupTooBigError extends Error {}

export function freeBytesOf(path) {
  const stat = statfsSync(path);
  return Number(stat.bavail) * Number(stat.bsize);
}

// Throws BackupTooBigError when the backup (bytes) is over the total cap or would leave under the minimum free on its drive.
export function assertBackupFits(bytes, freeBytes, limits) {
  if (bytes > limits.maxBytes) throw new BackupTooBigError(`backup of ${bytes} bytes is over the ${limits.maxBytes} cap`);
  if (freeBytes - bytes < limits.minFreeBytes) throw new BackupTooBigError(`backup of ${bytes} bytes would leave under ${limits.minFreeBytes} bytes free`);
}

function totalBytes(wtPath, relPaths) {
  return relPaths.reduce((sum, rel) => sum + ignoredFileSize(wtPath, rel), 0);
}

// Copies the diff (binary), every untracked non-ignored file and the git-ignored files that are not build output
// (the skipped ones are listed in README.txt, which is written whenever anything was skipped); returns the backup
// folder, or null when there is nothing to keep or skip. Over the size cap, or short of free space: BackupTooBigError.
function saveBackup(repo, wt, now, limits) {
  const patch = git(['-C', wt.path, 'diff', 'HEAD', '--binary'], repo, 'buffer');
  const untracked = git(['-C', wt.path, 'ls-files', '-o', '--exclude-standard', '-z'], repo).split('\0').filter(Boolean);
  const ignored = git(['-C', wt.path, 'ls-files', '-o', '-i', '--exclude-standard', '-z'], repo).split('\0').filter(Boolean);
  const { copy, skipped } = selectIgnoredBackups(ignored, (rel) => ignoredFileSize(wt.path, rel));
  if (!patch.length && !untracked.length && !copy.length && !skipped.length) return null;
  const common = resolve(repo, git(['rev-parse', '--git-common-dir'], repo).trim());
  const parent = join(common, 'worktree-backups');
  mkdirSync(parent, { recursive: true });
  assertBackupFits(patch.length + totalBytes(wt.path, untracked) + totalBytes(wt.path, copy), limits.freeBytes(parent), limits);
  const dir = newBackupDir(parent, basename(wt.path), new Date(now));
  mkdirSync(dir);
  try {
    if (patch.length) writeFileSync(join(dir, 'changes.patch'), patch);
    copyInto(dir, 'untracked', wt.path, untracked);
    copyInto(dir, 'ignored', wt.path, copy);
    if (skipped.length) writeFileSync(join(dir, BACKUP_README), backupReadme(skipped));
  } catch (error) {
    rmSync(dir, { recursive: true, force: true }); // a partial backup is worse than none
    throw error;
  }
  return dir;
}

function removeWorktrees(repo, candidates, now, dryRun, limits) {
  const result = { ...emptyCount(), backups: [], keptBackupTooBig: 0, keptBackupTooBigPaths: [] };
  for (const wt of candidates) {
    const size = safeSize(wt.path);
    if (dryRun) { result.deleted += 1; result.freedBytes += size; result.paths.push(wt.path); continue; }
    try {
      const backup = saveBackup(repo, wt, now, limits); // throws when the backup fails: then nothing is removed
      if (backup) result.backups.push(backup);
      git(['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', wt.path], repo);
      result.deleted += 1;
      result.freedBytes += size;
    } catch (error) {
      // no-fallback: a worktree whose backup or removal fails stays; the failed or kept-backup-too-big count reports it
      if (error instanceof BackupTooBigError) { result.keptBackupTooBig += 1; result.keptBackupTooBigPaths.push(wt.path); } else result.failed += 1;
    }
  }
  return result;
}

// ---- modes ------------------------------------------------------------------------------------------------------

// The highest wave's slices, or [] (so nothing is deleted) when there is no ledger or its last write is over 24 h old
// (the ledger rule of run-wave: an untouched ledger is ignored).
export function ledgerSlices(worktreesDir, now = Date.now()) {
  const path = join(worktreesDir, LEDGER_FILE);
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat || stat.mtimeMs < cutoffMs(now, LEDGER_MAX_AGE_HOURS)) return [];
  const text = readTextOrEmpty(path);
  return text ? parseLedgerSlices(text) : [];
}

function readTextOrEmpty(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; } // no-fallback: no ledger means no slices, so nothing is deleted
}

// A build is held when it, or the worktree it was built for, is held by a live process.
function buildWorktreePath(entry, worktreesDir) {
  const wtPath = entry.worktree ? join(worktreesDir, basename(entry.worktree)) : null;
  return wtPath && existsSync(wtPath) ? wtPath : null;
}

function buildIsHeld(entry, worktreesDir, isHeld) {
  if (isHeld(entry.path)) return true;
  const wtPath = buildWorktreePath(entry, worktreesDir);
  return Boolean(wtPath && isHeld(wtPath));
}

function readBranches(worktreesDir) {
  try {
    const repo = discoverRepo(worktreesDir);
    return repo ? worktreeBranches(git(['worktree', 'list', '--porcelain'], repo)) : new Map();
  } catch {
    return new Map(); // no-fallback: no branch list means only the exact s<N> folder names match
  }
}

export function cleanWave(worktreesDir, worktreeNames, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const result = { mode: 'wave', dir: worktreesDir, dryRun, builds: emptyCount() };
  const error = worktreesDirError(worktreesDir);
  if (error) return { ...result, error };
  const slices = options.slices ?? (options.ledger ? ledgerSlices(worktreesDir, options.now) : []);
  const checker = makeHeldChecker(options.isHeld);
  const isHeld = checker.isHeld;
  const picked = selectWaveBuilds(listBuildEntries(worktreesDir), worktreeNames, slices, readBranches(worktreesDir));
  checker.prefetch(picked.flatMap((entry) => [entry.path, buildWorktreePath(entry, worktreesDir)]).filter(Boolean));
  const free = picked.filter((entry) => !buildIsHeld(entry, worktreesDir, isHeld));
  result.builds = deleteEntries(free, dryRun);
  result.builds.skippedHeld = picked.length - free.length;
  result.slices = slices;
  if (options.tempDir && !dryRun) result.tempBuilds = cleanTempBuilds(options.tempDir);
  return result;
}

function discoverRepo(worktreesDir) {
  const name = repoNameFromWorktreesDir(worktreesDir);
  if (!name) return null;
  const repo = join(dirname(resolve(worktreesDir)), name);
  return existsSync(join(repo, '.git')) ? repo : null;
}

// git prints the long, real path; a dir given as an 8.3 short path (C:\Users\RUNNER~1\...) or through a link never
// matches it as written, so both sides are compared as real paths.
function realLower(path) {
  try { return realpathSync.native(resolve(path)).toLowerCase(); } catch { return resolve(path).toLowerCase(); } // no-fallback: a path that cannot be resolved is compared as written
}

function collectWorktrees(repo, worktreesDir) {
  const root = realLower(worktreesDir);
  const listed = parseWorktreeList(git(['worktree', 'list', '--porcelain'], repo));
  return listed.filter((wt) => realLower(wt.path).startsWith(root + '\\') || realLower(wt.path).startsWith(root + '/'))
    .filter((wt) => existsSync(wt.path))
    .map((wt) => ({ ...wt, toolOwned: isUnderToolFolder(realLower(wt.path), root), activityMs: safeActivity(repo, wt.path) }));
}

function safeActivity(repo, path) {
  try { return worktreeActivityMs(repo, path); } catch { return NaN; } // no-fallback: unknown activity keeps the worktree
}

function idleWorktrees(all, options) {
  return all.filter((wt) => !wt.primary && !wt.toolOwned && Number.isFinite(wt.activityMs) && wt.activityMs < cutoffMs(options.now, options.hours));
}

function staleWorktrees(repo, idle, options) {
  const { now, hours, dryRun, isHeld } = options;
  const judged = idle.map((wt) => ({ ...wt, held: Boolean(isHeld(wt.path)), unsafe: worktreeKeepReason(repo, wt) }));
  const result = removeWorktrees(repo, selectStaleWorktrees(judged, now, hours), now, dryRun, options.backupLimits);
  result.skippedHeld = judged.filter((wt) => wt.held).length;
  result.skippedUnsafe = judged.filter((wt) => !wt.held && wt.unsafe).length;
  return result;
}

function deleteUnheld(candidates, options) {
  const { free, skippedHeld } = splitHeld(candidates, options.isHeld);
  return { ...deleteEntries(free, options.dryRun), skippedHeld };
}

// Temp entries are judged by their timestamps only (a folder-holders check on thousands of entries takes hours, and a
// rename probe moves the path under a process that has no open handle). A delete that fails (in use) is skipped.
function staleTemp(tempDir, options) {
  const { now, hours, dryRun, useBirth } = options;
  return deleteEntries(selectStaleTempEntries(listTempEntries(tempDir, useBirth), now, hours), dryRun, true);
}

export function cleanStale(worktreesDir, tempDir, options = {}) {
  const now = options.now ?? Date.now();
  const hours = options.hours ?? DEFAULT_HOURS;
  const dryRun = Boolean(options.dryRun);
  const checker = makeHeldChecker(options.isHeld);
  const backupLimits = { maxBytes: options.backupMaxBytes ?? BACKUP_TOTAL_MAX_BYTES, minFreeBytes: options.backupMinFreeBytes ?? BACKUP_MIN_FREE_BYTES, freeBytes: options.freeBytes ?? freeBytesOf };
  const run = { now, hours, dryRun, isHeld: checker.isHeld, useBirth: options.useBirth ?? true, backupLimits };
  const result = { mode: 'stale', dir: worktreesDir, temp: tempDir, hours, dryRun };
  const error = worktreesDirError(worktreesDir) ?? (isFilesystemRoot(tempDir) ? 'refusing to clean a drive or filesystem root' : null) ?? hoursError(hours);
  if (error) return { ...result, error };
  const repo = discoverRepo(worktreesDir);
  result.repo = repo;
  if (repo && !dryRun) git(['worktree', 'prune'], repo);
  const present = existsSync(worktreesDir);
  const builds = present ? selectStaleEntries(listBuildEntries(worktreesDir), now, hours) : [];
  const all = repo && present ? collectWorktrees(repo, worktreesDir) : [];
  const idle = idleWorktrees(all, run);
  const folders = present ? selectStaleFolders(listFolders(worktreesDir, all.map((wt) => wt.path)), all.map((wt) => basename(wt.path)), now, hours) : [];
  checker.prefetch([...builds, ...idle, ...folders].map((entry) => entry.path)); // one holder check for every candidate
  result.builds = deleteUnheld(builds, run);
  result.worktrees = idle.length ? staleWorktrees(repo, idle, run) : emptyCount();
  result.folders = deleteUnheld(folders, run);
  result.tempEntries = existsSync(tempDir) ? staleTemp(tempDir, run) : emptyCount();
  result.freedBytes = ['builds', 'worktrees', 'folders', 'tempEntries'].reduce((sum, key) => sum + result[key].freedBytes, 0);
  result.failed = ['builds', 'worktrees', 'folders', 'tempEntries'].reduce((sum, key) => sum + result[key].failed, 0);
  return result;
}

// ---- CLI --------------------------------------------------------------------------------------------------------

function valuesAfter(argv, flag) {
  const start = argv.indexOf(flag);
  if (start < 0) return null;
  const values = [];
  for (let i = start + 1; i < argv.length && !argv[i].startsWith('--'); i++) values.push(argv[i]);
  return values;
}

function singleValue(argv, flag) {
  const values = valuesAfter(argv, flag);
  return values && values.length ? values[0] : null;
}

function listValues(argv, flag) {
  return (valuesAfter(argv, flag) ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

function parseHours(argv) {
  if (!argv.includes('--hours')) return DEFAULT_HOURS;
  const hours = Number(singleValue(argv, '--hours') ?? NaN);
  const error = hoursError(hours);
  if (error) throw new Error(error);
  return hours;
}

export function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const tempDir = singleValue(argv, '--temp');
  const waveDir = singleValue(argv, '--wave');
  const staleDir = singleValue(argv, '--stale');
  if (waveDir) {
    return { mode: 'wave', dir: waveDir, names: listValues(argv, '--worktrees'), slices: listValues(argv, '--slices'), ledger: argv.includes('--ledger'), tempDir, dryRun };
  }
  if (staleDir) {
    if (!tempDir) throw new Error('--stale needs --temp <temp dir>');
    return { mode: 'stale', dir: staleDir, tempDir, hours: parseHours(argv), dryRun };
  }
  throw new Error('usage: clean-stale.mjs --wave <worktrees dir> (--ledger | --slices <list> | --worktrees <list>) [--temp <dir>] | --stale <worktrees dir> --temp <dir> [--hours 24] [--dry-run]');
}

// Never throws: bad arguments and unreadable folders become a JSON result with an error field.
export function runCli(argv) {
  try {
    const args = parseArgs(argv);
    if (args.mode === 'wave') {
      const slices = args.slices.length ? args.slices : undefined;
      return cleanWave(args.dir, args.names, { tempDir: args.tempDir, dryRun: args.dryRun, ledger: args.ledger, slices });
    }
    return cleanStale(args.dir, args.tempDir, { hours: args.hours, dryRun: args.dryRun });
  } catch (error) {
    return { error: error.message };
  }
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const result = runCli(process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (result.error) process.exitCode = 2;
}
