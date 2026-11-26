#!/usr/bin/env node
// Fast-forwards a repo's primary checkout to origin/main after a merge, unless that would destroy a real edit.
// Usage: node ff-primary.mjs <primary-checkout-dir>
// Exit 0 = up to date or fast-forwarded; 1 = blocked (a real edit or an untracked file is in the way, or not a
// fast-forward); 2 = not applicable (not on main, not a git repo); 3 = could not fetch origin.
// Rules (2026-11-01, ReadTheStupidText: the primary sat 226 commits behind because two untracked items and one
// phantom-modified file made every session skip the pull):
//  - untracked files never block, except when an incoming file would overwrite one (git says so; the path is printed);
//  - a tracked file whose raw bytes equal HEAD's blob is a phantom change (eol normalisation): never blocks, and is
//    removed first when the incoming commits change it, so git can write the new version;
//  - a real edit blocks only when the incoming commits also change that file; its diff is saved under
//    <git dir>/ff-primary-backups/ first and nothing is deleted.
// The primary-checkout-guard hook only inspects git commands typed in the shell, so running this script is allowed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, existsSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_BRANCH = 'main';
const REMOTE = 'origin';
const BACKUP_DIR = 'ff-primary-backups';
const EXIT = { ok: 0, blocked: 1, notApplicable: 2, fetchFailed: 3 };

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}

function tryGit(dir, args) {
  try { return git(dir, args).trim(); } catch { return null; }
}

// Tracked paths with any staged or unstaged change (untracked left out).
export function changedTracked(dir) {
  return git(dir, ['status', '--porcelain', '-z', '-uno', '--no-renames']).split('\0').filter(Boolean)
    .map((e) => ({ xy: e.slice(0, 2), path: e.slice(3) }));
}

// True when the working file's raw bytes (no eol/clean filters) are the blob HEAD holds and the index matches HEAD.
export function isPhantom(dir, entry) {
  if (entry.xy[0] !== ' ' || entry.xy[1] !== 'M') return false;
  const raw = tryGit(dir, ['hash-object', '--no-filters', '--', entry.path]);
  const head = tryGit(dir, ['rev-parse', `HEAD:${entry.path}`]);
  return raw !== null && raw === head;
}

function incomingFiles(dir, target) {
  return new Set(git(dir, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', target]).split('\0').filter(Boolean));
}

function saveBackup(dir, entry) {
  const gitDir = resolve(dir, git(dir, ['rev-parse', '--git-dir']).trim());
  const folder = join(gitDir, BACKUP_DIR);
  mkdirSync(folder, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${entry.path.split(/[\/]/).pop().slice(-60)}-${Math.random().toString(36).slice(2, 8)}.patch`;
  const file = join(folder, name);
  writeFileSync(file, git(dir, ['diff', '--binary', 'HEAD', '--', entry.path]));
  return file;
}

function refusedPaths(error) {
  const text = String(error.stderr ?? '');
  const paths = [...text.matchAll(/^\s+(\S.*)$/gm)].map((m) => m[1].trim());
  return paths.length ? paths : [text.trim()];
}

const EDIT_LOOKBACK_MS = 60 * 60 * 1000;
const EDIT_LOOKAHEAD_MS = 2 * 60 * 1000;

// The scan must never slow the fast-forward: only transcripts modified in the window, a file-count cap, a size cap per
// file, one pass for every blocked path and a time budget. Anything skipped makes the result "incomplete".
const SCAN_LIMITS = { maxFiles: 300, maxFileBytes: 256 * 1024 * 1024, maxLineChars: 8 * 1024 * 1024, budgetMs: 3000 };
const SCAN_CHUNK_BYTES = 1024 * 1024;

// Lists the transcripts, one project folder at a time, and stops (outcome.complete = false) when the deadline passes.
// Throws when the top folder cannot be read; a missing folder holds no transcripts.
function transcriptFiles(projectsDir, deadline, outcome) {
  if (!existsSync(projectsDir)) return [];
  const found = [];
  for (const d of readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    if (Date.now() > deadline) { outcome.complete = false; break; }
    try {
      for (const f of readdirSync(join(projectsDir, d.name)).filter((n) => n.endsWith('.jsonl'))) found.push({ project: d.name, file: join(projectsDir, d.name, f), id: f.slice(0, -'.jsonl'.length) });
    } catch { outcome.complete = false; }
  }
  return found;
}

// Streams a file in chunks and calls onLine for each line. A line over maxLineChars is skipped. Returns false when the
// file was not read to the end (line skipped or deadline passed).
function eachLine(file, deadline, maxLineChars, onLine) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(SCAN_CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    let carry = '';
    let skipping = false;
    let complete = true;
    for (;;) {
      if (Date.now() > deadline) return false;
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      let text = decoder.write(buffer.subarray(0, count));
      if (skipping) {
        const newline = text.indexOf('\n');
        if (newline === -1) continue;
        text = text.slice(newline + 1);
        skipping = false;
      }
      const parts = (carry + text).split('\n');
      carry = parts.pop();
      for (const part of parts) {
        if (part.length > maxLineChars) complete = false;
        else onLine(part);
      }
      if (carry.length > maxLineChars) { carry = ''; skipping = true; complete = false; }
    }
    if (carry.length > maxLineChars) return false;
    onLine(carry);
    return complete;
  } finally { closeSync(fd); }
}

// The latest timestamp (ms) of a transcript line that names `want.rel` inside [want.from, want.to] for each want, kept in `latest`.
function noteMentions(line, wants, latest) {
  if (!wants.some((w) => line.includes(w.base))) return;
  const slashed = line.replace(/\\\\/g, '/');
  const named = wants.filter((w) => line.includes(w.base) && slashed.includes(w.rel));
  if (!named.length) return;
  let at;
  try { at = Date.parse(JSON.parse(line).timestamp ?? ''); } catch { return; /* a line that is not JSON names nothing */ }
  for (const w of named) if (at >= w.from && at <= w.to && (latest.get(w.rel) ?? -Infinity) < at) latest.set(w.rel, at);
}

function candidateTranscripts(wants, projectsDir, limits, deadline, outcome) {
  const earliest = Math.min(...wants.map((w) => w.from)); // the same window noteMentions accepts
  const fresh = [];
  for (const t of transcriptFiles(projectsDir, deadline, outcome)) {
    if (Date.now() > deadline) { outcome.complete = false; break; }
    try {
      const info = statSync(t.file);
      if (info.mtimeMs >= earliest) fresh.push({ ...t, mtime: info.mtimeMs, size: info.size });
    } catch { outcome.complete = false; }
  }
  fresh.sort((a, b) => b.mtime - a.mtime);
  if (fresh.length > limits.maxFiles) outcome.complete = false;
  return fresh.slice(0, limits.maxFiles);
}

// One pass over the transcripts for every path in `relPaths`: which sessions named each path in the hour before the file was
// last saved (who asked for, or made, the edit; 2026-11-15: ten blocked fast-forwards of settings.example.json, each a line the
// user pasted in VS Code after a session's `code -g`). A transcript last written before the save cannot hold it.
// Returns { sessions: Map(path -> [{ project, id, at }] newest first), complete }; complete is false when any file was
// skipped (too big, unreadable, over the count cap) or the time budget ran out. Never throws.
export function scanTranscripts(dir, relPaths, projectsDir = join(homedir(), '.claude', 'projects'), options = {}) {
  const limits = { ...SCAN_LIMITS, ...options };
  const outcome = { sessions: new Map(relPaths.map((p) => [p, []])), complete: true };
  const deadline = Date.now() + limits.budgetMs;
  try {
    const wants = relPaths.map((p) => {
      const rel = p.replace(/\\/g, '/');
      const saved = statSync(join(dir, p)).mtimeMs;
      return { path: p, rel, base: basename(rel), saved, from: saved - EDIT_LOOKBACK_MS, to: saved + EDIT_LOOKAHEAD_MS };
    });
    for (const t of candidateTranscripts(wants, projectsDir, limits, deadline, outcome)) {
      if (t.size > limits.maxFileBytes) { outcome.complete = false; continue; }
      const latest = new Map();
      try {
        if (!eachLine(t.file, deadline, limits.maxLineChars, (line) => noteMentions(line, wants, latest))) outcome.complete = false;
      } catch { outcome.complete = false; }
      for (const w of wants) if (latest.has(w.rel)) outcome.sessions.get(w.path).push({ project: t.project, id: t.id, at: latest.get(w.rel) });
      if (Date.now() > deadline) { outcome.complete = false; break; }
    }
  } catch { outcome.complete = false; }
  for (const [p, list] of outcome.sessions) outcome.sessions.set(p, list.sort((a, b) => b.at - a.at).map((s) => ({ ...s, at: new Date(s.at).toISOString() })));
  return outcome;
}

const INCOMPLETE_NOTE = 'Not all transcripts were read (some were skipped or the scan was cut short by its size, count or time cap)';

function editorsNote(entry, scan) {
  const found = scan.sessions.get(entry.path).slice(0, 3);
  if (!found.length) {
    return scan.complete
      ? ' No session transcript names it in the hour before the file was saved: look for a hand edit.'
      : ` ${INCOMPLETE_NOTE}, so no session can be ruled out: look for a hand edit too.`;
  }
  const names = found.map((s) => `${s.project}/${s.id} (named it at ${s.at})`).join('; ');
  return ` The edit was likely made after, or by, ${names}: read that transcript with transcript-digest.mjs.${scan.complete ? '' : ` ${INCOMPLETE_NOTE}.`}`;
}

// The session lookup is decoration on the BLOCKED message: any failure gives no note and never changes the outcome.
function safeScan(dir, paths, projectsDir, scanOptions) {
  try { return scanTranscripts(dir, paths, projectsDir, scanOptions); } catch { return null; }
}

export function fastForward(dir, log = (t) => process.stdout.write(`${t}\n`), projectsDir = undefined, scanOptions = {}) {
  if (tryGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) !== MAIN_BRANCH) {
    log(`ff-primary: ${dir} is not on ${MAIN_BRANCH}; nothing done.`);
    return EXIT.notApplicable;
  }
  try { git(dir, ['fetch', '--quiet', REMOTE, MAIN_BRANCH]); } catch (error) {
    log(`ff-primary: could not fetch ${REMOTE} (${String(error.stderr ?? error.message).trim()}); nothing done.`);
    return EXIT.fetchFailed;
  }
  const target = `${REMOTE}/${MAIN_BRANCH}`;
  if (tryGit(dir, ['merge-base', '--is-ancestor', 'HEAD', target]) === null) {
    log('ff-primary: local main is not an ancestor of origin/main (local commits); not a fast-forward, nothing done.');
    return EXIT.blocked;
  }
  const incoming = incomingFiles(dir, target);
  const entries = changedTracked(dir);
  const real = entries.filter((e) => !isPhantom(dir, e) && incoming.has(e.path));
  if (real.length) {
    const backups = real.map((e) => saveBackup(dir, e)); // the block and the backup come first; the lookup is only a note
    const scan = safeScan(dir, real.map((e) => e.path), projectsDir, scanOptions);
    real.forEach((e, i) => log(`ff-primary: BLOCKED by a real edit to ${e.path} (saved a copy of the diff: ${backups[i]}). Nothing was deleted.${scan ? editorsNote(e, scan) : ''}`));
    return EXIT.blocked;
  }
  const removed = entries.filter((x) => isPhantom(dir, x) && incoming.has(x.path))
    .map((x) => ({ file: join(dir, x.path), bytes: readFileSync(join(dir, x.path)) }));
  for (const r of removed) unlinkSync(r.file);
  try {
    git(dir, ['merge', '--ff-only', target]);
  } catch (error) {
    for (const r of removed) if (!existsSync(r.file)) writeFileSync(r.file, r.bytes);
    log(`ff-primary: BLOCKED, git refused: ${refusedPaths(error).join(', ')}`);
    return EXIT.blocked;
  }
  log(`ff-primary: ${dir} is now at ${git(dir, ['rev-parse', '--short', 'HEAD']).trim()}.`);
  return EXIT.ok;
}

function isEntryPoint() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) {
  const dir = process.argv[2];
  if (!dir || !existsSync(dir)) {
    process.stderr.write('usage: node ff-primary.mjs <primary-checkout-dir>\n');
    process.exit(EXIT.notApplicable);
  }
  try {
    process.exit(fastForward(resolve(dir)));
  } catch (error) {
    process.stderr.write(`ff-primary: failed: ${error.message}\n`);
    process.exit(EXIT.blocked);
  }
}
