#!/usr/bin/env node
// Pending-mirror markers (Slice 21): ship-branch's "Mirror due" is easy to miss (night 2026-11-17-1826: five merges, no
// mirror dispatched, mirrored copy 70 minutes stale). ship-branch runs `mark <repo> <sha>` where it prints "Mirror due";
// the docs-mirror agent runs `clear <repo> <sha> <start ms>` after a successful mirror (every marker of that repo written
// before the mirror started is removed; the sha is for the reminder text only); the Stop hook (question-stop.mjs) names a marker 10 minutes to 24 hours old that
// nothing cleared, once per session, only in a session working in that repo.
// `clear` prints the real markers first (Slice 29 item 36). A marker written after the mirror started is also cleared
// when the mirrored sha contains its commit (Slice 29 item 35).
// Usage: node mirror-due.mjs mark <repo> <sha> [primary-root] | clear <repo> <sha> [mirror-start-ms] | list
// Markers live in <CLAUDE_CONFIG_DIR or ~/.claude>/state/mirror-due/<repo>.json. Fails open: exit 0 on any error, one stderr line,
// except `mark` (Slice 35, 406 item 18): a sha that git says is not on origin/main (after one `git fetch origin main`) writes no
// marker and exits 1 with one stderr line; any git failure still allows the mark.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DUE_AFTER_MS = 10 * 60 * 1000;
export const MARKER_EXPIRES_MS = 24 * 60 * 60 * 1000;

export function markerDir(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'state', 'mirror-due');
}

const fileFor = (dir, repo) => join(dir, `${String(repo).replace(/[^A-Za-z0-9._-]+/g, '__')}.json`);

export function mark(repo, sha, dir = markerDir(), now = Date.now(), root = '') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(dir, repo), JSON.stringify({ repo, sha, at: now, ...(root ? { root } : {}), firedFor: [] }));
}

function readMarker(dir, repo) {
  try { return JSON.parse(readFileSync(fileFor(dir, repo), 'utf8')); } catch { return null; }
}

// One rule: removes the repo's marker when it was written before the mirror started (startedAt; with none, only the marker
// still in place when the delete runs, by its mark time), so a
// merge's marker written while the mirror ran survives. The sha is kept for the reminder text only (the merge sha and
// the mirrored origin/main sha differ). Returns true when a marker was removed.
// Slice 29 item 35: a marker written after the mirror's start time still goes when the mirrored sha already contains its
// commit (a merge that landed between the start time and the mirror's `git fetch`; "Mirror due 69def923" fired 10 minutes
// after a verified mirror). `covers(marker, sha)` says so; the default asks git in the marker's recorded root.
export function mirroredCovers(marker, sha, run = spawnSync) {
  // A marker with no recorded root (a hand-run or old one) falls back to the primary checkout of the repo the caller is in.
  // A recorded root that no longer exists (a worktree removed after `mark`) falls back the same way.
  const rootGone = marker.root && run === spawnSync && !existsSync(marker.root);
  const root = (rootGone ? '' : marker.root) || (run === spawnSync ? primaryRoot(process.cwd()) : '');
  if (!root || !marker.sha || !sha) return false;
  const result = run('git', ['-C', root, 'merge-base', '--is-ancestor', marker.sha, sha], { encoding: 'utf8' });
  return result.status === 0;
}

export function clear(repo, sha, dir = markerDir(), startedAt, covers = mirroredCovers) {
  const marker = readMarker(dir, repo);
  if (!marker || !sha) return false;
  // No start time (an agent cannot know it): the marker in place now is removed, whatever its `at` (a non-numeric one included).
  const writtenBefore = startedAt === undefined || Number(marker.at) < startedAt;
  if (!writtenBefore && !covers(marker, sha)) return false;
  rmSync(fileFor(dir, repo), { force: true });
  return true;
}

// Slice 29 item 36: the markers that really exist, one line each, so a typed sha that matches none is seen.
export function allMarkers(dir = markerDir()) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const marker = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (marker && typeof marker.repo === 'string') out.push(marker);
    } catch { /* an unreadable marker is ignored */ }
  }
  return out;
}

export function describeMarkers(dir = markerDir()) {
  const markers = allMarkers(dir);
  if (!markers.length) return 'pending mirror markers: none';
  return `pending mirror markers: ${markers.map((m) => `${m.repo} ${m.sha}`).join('; ')}`;
}

// Markers older than minAgeMs (and younger than maxAgeMs) that nothing cleared: [{ repo, sha, at }].
export function dueMarkers(dir = markerDir(), now = Date.now(), minAgeMs = DUE_AFTER_MS, maxAgeMs = Infinity) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const marker = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const age = now - Number(marker && marker.at);
      if (marker && typeof marker.repo === 'string' && age >= minAgeMs && age < maxAgeMs) out.push(marker);
    } catch { /* an unreadable marker is ignored */ }
  }
  return out;
}

// The primary checkout folder of the repo that cwd is in (a worktree resolves to its primary), or '' when not in git.
export function primaryRoot(cwd) {
  const run = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  if (run.status !== 0) return '';
  return dirname(run.stdout.trim());
}

const samePath = (a, b) => {
  const norm = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  return norm(a).toLowerCase() === norm(b).toLowerCase();
};

// True when the session's cwd is in the marker's repo: its recorded root, else the repo name's last segment.
export function inMarkerRepo(marker, cwd) {
  if (!cwd) return false;
  const root = primaryRoot(cwd);
  if (!root) return false;
  if (marker.root) return samePath(root, marker.root);
  return basename(root).toLowerCase() === String(marker.repo).split('/').pop().toLowerCase();
}

// The markers this session should be reminded of: due (10 minutes to 24 hours old), for the repo the session works in,
// and not yet reminded in this session. Records the reminder in the marker file. Fails open: [] on any error.
export function dueForSession(input, dir = markerDir(), now = Date.now()) {
  try {
    const session = String((input && input.session_id) || 'no-session');
    const out = [];
    for (const marker of dueMarkers(dir, now, DUE_AFTER_MS, MARKER_EXPIRES_MS)) {
      const fired = Array.isArray(marker.firedFor) ? marker.firedFor : [];
      if (fired.includes(session) || !inMarkerRepo(marker, input && input.cwd)) continue;
      writeFileSync(fileFor(dir, marker.repo), JSON.stringify({ ...marker, firedFor: [...fired, session] }));
      out.push(marker);
    }
    return out;
  } catch { return []; }
}

// Slice 35 (406 item 18): a marker is for a merge on main, so `mark` refuses a sha that is not an ancestor of origin/main
// (git exit 1). `mark` runs right after `gh pr merge`, when the local origin/main may not have the merge yet, so on exit 1 it
// runs `git fetch origin main` once (timeout FETCH_TIMEOUT_MS) and checks again. Fails open: any other git result (no repo,
// unknown sha, no origin/main, a failed or timed-out fetch) allows the mark.
export const FETCH_TIMEOUT_MS = 20000;
export function reachableFromMain(sha, root, run = spawnSync) {
  const dir = root || primaryRoot(process.cwd());
  if (!dir || !sha) return true;
  const check = () => run('git', ['-C', dir, 'merge-base', '--is-ancestor', sha, 'origin/main'], { encoding: 'utf8' });
  if (check().status !== 1) return true;
  const fetched = run('git', ['-C', dir, 'fetch', 'origin', 'main'], { encoding: 'utf8', timeout: FETCH_TIMEOUT_MS });
  if (fetched.status !== 0) return true;
  return check().status !== 1;
}

// Slice 33 item 22: a marker is for a merge that changed a file the mirror copies (CLAUDE.md, README.md, plan.md, scope.md at the repo
// root, anything under docs/plan/). `mark` refuses a sha whose change touches none (print-the-damn-book #63 changed only
// `.claude/settings.json`). The change is sha against its first parent (a merge commit) or its parent. Fails open: any git result
// that is not a clean file list (no repo, unknown sha, a root commit) allows the mark.
export const isMirrorFile = (file) => /^(?:plan\.md|README\.md|scope\.md|(?:.*\/)?CLAUDE\.md|docs\/plan\/.+)$/.test(file);
export function touchesMirrorFile(sha, root, run = spawnSync) {
  const dir = root || primaryRoot(process.cwd());
  if (!dir || !sha) return true;
  const diff = run('git', ['-C', dir, 'diff', '--name-only', `${sha}^1`, sha], { encoding: 'utf8' });
  if (diff.status !== 0) return true;
  const files = String(diff.stdout ?? '').split(/\r?\n/).map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean);
  return files.length === 0 || files.some(isMirrorFile);
}

function isEntryPoint() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) {
  const [command, repo, sha, extra] = process.argv.slice(2);
  try {
    if (command === 'mark' && repo && sha) {
      const onMain = reachableFromMain(sha, extra);
      if (onMain && !touchesMirrorFile(sha, extra)) {
        process.stderr.write(`mirror-due: ${sha} changed no mirror file (CLAUDE.md, README.md, plan.md, scope.md, docs/plan/); no marker written, no mirror due\n`);
        process.exitCode = 1;
      } else if (onMain) mark(repo, sha, markerDir(), Date.now(), extra);
      else {
        process.stderr.write(`mirror-due: ${sha} is not reachable from origin/main; no marker written (mark the merge commit on main)\n`);
        process.exitCode = 1;
      }
    }
    else if (command === 'clear' && repo && sha) {
      const dir = markerDir();
      process.stdout.write(`${describeMarkers(dir)}\n`);
      const markers = allMarkers(dir);
      if (!markers.some((m) => m.repo === repo)) {
        process.stdout.write(markers.length > 0
          ? `note: no pending marker for ${repo} (check the repo name); nothing to clear\n`
          : `note: no pending marker for ${repo}: already cleared; nothing to clear\n`);
      }
      clear(repo, sha, dir, Number(extra) || undefined);
    }
    else if (command === 'list') process.stdout.write(`${JSON.stringify(dueMarkers(markerDir(), Date.now(), 0))}\n`);
    else process.stderr.write('usage: mirror-due.mjs mark <repo> <sha> [primary-root] | clear <repo> <sha> [mirror-start-ms] | list\n');
  } catch (error) {
    process.stderr.write(`mirror-due: ${error.message}\n`);
  }
}
