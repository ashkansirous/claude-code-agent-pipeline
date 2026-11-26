#!/usr/bin/env node
// A marker that the merged-branch sweep ran, so ship-branch claim mode can refuse a claim made without one
// (a wave-2 coordinator skipped the sweep; Slice 315 item 31). The stamp is one ISO time in
// <git common dir>/branch-sweep-stamp (shared by every worktree of the repo, never committed).
//
// Usage: node sweep-stamp.mjs write <repo-or-worktree>
//        node sweep-stamp.mjs check <repo-or-worktree> [--max-minutes 240]   exit 0 when the stamp is that recent, else 1
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAMP_FILE = 'branch-sweep-stamp';
export const DEFAULT_MAX_MINUTES = 240;
const MS_PER_MINUTE = 60 * 1000;
const EXIT_STALE = 1;
const EXIT_USAGE = 2;

function commonDir(repo) {
  const raw = execFileSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  return isAbsolute(raw) ? raw : resolve(repo, raw);
}

export function writeStamp(repo, now = new Date()) {
  writeFileSync(join(commonDir(repo), STAMP_FILE), now.toISOString());
}

// { ok, reason }: ok when the stamp exists and is at most maxMinutes old.
export function checkStamp(repo, maxMinutes = DEFAULT_MAX_MINUTES, now = Date.now()) {
  let text;
  try { text = readFileSync(join(commonDir(repo), STAMP_FILE), 'utf8').trim(); } catch { return { ok: false, reason: 'no branch sweep recorded for this repo' }; }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return { ok: false, reason: `unreadable sweep stamp: ${text}` };
  const age = (now - at) / MS_PER_MINUTE;
  return age <= maxMinutes ? { ok: true, reason: `swept ${Math.round(age)} min ago` } : { ok: false, reason: `last branch sweep was ${Math.round(age)} min ago (limit ${maxMinutes})` };
}

export function main(argv, out = console.log) {
  const [mode, repo, flag, value] = argv;
  if (!repo || (mode !== 'write' && mode !== 'check')) { out('usage: sweep-stamp.mjs write|check <repo> [--max-minutes N]'); return EXIT_USAGE; }
  if (mode === 'write') { writeStamp(repo); out('branch sweep recorded'); return 0; }
  const maxMinutes = flag === '--max-minutes' ? Number(value) : DEFAULT_MAX_MINUTES;
  const result = checkStamp(repo, maxMinutes);
  out(result.reason);
  return result.ok ? 0 : EXIT_STALE;
}

function isEntryPoint() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) process.exit(main(process.argv.slice(2)));
