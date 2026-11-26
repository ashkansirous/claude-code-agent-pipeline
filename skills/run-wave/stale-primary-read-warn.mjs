#!/usr/bin/env node
// Warn-only PreToolUse hook on Read, Grep and Glob: when the path being read lies inside a primary checkout
// whose HEAD is behind origin/main (local refs only, no fetch), add a note that the files on disk are stale
// and to read origin/main instead (`git show origin/main:<path>`, `git grep <pattern> origin/main`).
// Never denies. Any error lets the call through silently. (2026-11-01, ReadTheStupidText: sessions read a
// primary checkout that was many commits behind origin/main and reported stale facts.)
import { readFileSync, realpathSync, existsSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { primaryRoot } from './primary-checkout-guard.mjs';

const WATCHED_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const MAIN_REF = 'origin/main';
const MARKER_PREFIX = 'stale-primary-warn-';
const MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Read names its path file_path; Grep and Glob name it path; no path means the hook cwd.
function pathOf(input) {
  const given = input.tool_name === 'Read' ? input.tool_input?.file_path : input.tool_input?.path;
  return resolve(input.cwd ?? process.cwd(), given || '.');
}

// How many commits origin/main has that HEAD lacks, from the refs already on disk.
function commitsBehind(root) {
  const out = execFileSync('git', ['-C', root, 'rev-list', '--count', `HEAD..${MAIN_REF}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return Number(out.trim());
}

function warning(root, behind) {
  return `The primary checkout ${root} is ${behind} commit${behind === 1 ? '' : 's'} behind ${MAIN_REF}, so files on disk may be stale. Read ${MAIN_REF} instead: git -C ${root} show ${MAIN_REF}:<path>, or git -C ${root} grep <pattern> ${MAIN_REF}. Do not update the primary checkout just to fix this, unless it is a clean main and a rule you follow allows git pull --ff-only.`;
}

// Deletes this hook's own markers older than a day; never touches other files.
function removeOldMarkers(dir, now = Date.now()) {
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(MARKER_PREFIX)) continue;
    try {
      if (now - statSync(join(dir, name)).mtimeMs > MARKER_MAX_AGE_MS) unlinkSync(join(dir, name));
    } catch { /* another session may have removed it */ }
  }
}

// True the first time this root, behind-count and session are seen; records a marker in the temp dir.
// With no session id there is nothing to key a marker on, so it always warns and writes nothing.
export function firstTime(root, behind, sessionId, dir = tmpdir()) {
  if (!sessionId) return true;
  const key = createHash('sha256').update(`${root}\n${behind}\n${sessionId}`).digest('hex').slice(0, 24);
  const marker = join(dir, `${MARKER_PREFIX}${key}`);
  if (existsSync(marker)) return false;
  writeFileSync(marker, '');
  removeOldMarkers(dir);
  return true;
}

export function decide(input, markerDir) {
  if (!WATCHED_TOOLS.has(input.tool_name)) return null;
  const root = primaryRoot(pathOf(input));
  if (!root) return null;
  const behind = commitsBehind(root);
  if (!(behind > 0)) return null;
  if (!firstTime(root, behind, input.session_id, markerDir)) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warning(root, behind) } };
}

export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch {
    // Fail open and silent: a warning hook must never get in the way of a read.
  }
}
