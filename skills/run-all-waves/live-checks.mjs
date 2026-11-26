#!/usr/bin/env node
// Slice 31: every open line of docs/plan/unverified.md starts with one tag saying who runs it. After a release the driver
// starts a "live checks" session over the lines tagged chrome, session, phone or cloud; chat and owner lines go to the owner.
//
// Usage: node live-checks.mjs <repo root> --lint [--base <git ref>]   exit 1 when a new line has no tag
//        node live-checks.mjs <repo root> --todo <tags> [--json]      the open lines a session should run (tags: comma list)
//        node live-checks.mjs <repo root> --count <tags>              how many such lines are open
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BULLET } from '../run-wave/count-unverified.mjs';
import { isEntryPoint } from '../feedback-loop/control-chars.mjs';

export const TAGS = ['chrome', 'session', 'phone', 'cloud', 'chat', 'owner'];
export const SESSION_TAGS = ['chrome', 'session', 'phone', 'cloud'];
const UNVERIFIED = 'docs/plan/unverified.md';
const SLICE_HEADING = /^###\s+(.*)$/;
const TAG_PATTERN = new RegExp(String.raw`^- \[(${TAGS.join('|')})\]\s`);
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

// [{ slice, text, tag }]: a bullet under a `### ` heading plus its wrapped lines (indented or plain text up to the next
// bullet, heading or blank line). tag is null for an untagged line. Pointer bullets ("moved to Slice N") are not checks.
export function parseLines(text) {
  const lines = [];
  let slice = null;
  let open = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const heading = SLICE_HEADING.exec(raw);
    if (/^## /.test(raw)) { slice = null; open = null; continue; }
    if (heading) { slice = heading[1]; open = null; continue; }
    if (slice === null) continue;
    if (/^- \S/.test(raw)) {
      open = BULLET.test(raw) ? { slice, text: raw.trim(), tag: tagOf(raw) } : null;
      if (open) lines.push(open);
      continue;
    }
    if (!raw.trim()) { open = null; continue; }
    if (open) open.text += ` ${raw.trim()}`;
  }
  return lines;
}

export function tagOf(line) {
  const match = TAG_PATTERN.exec(line);
  return match ? match[1] : null;
}

// The untagged lines of `text` that are not (word for word) in `baseText`: only a new line is refused, so the lines
// written before the tags existed do not block every PR until the tagging pass is done.
export function untaggedNew(text, baseText = '') {
  const known = new Set(parseLines(baseText).map((line) => line.text));
  return parseLines(text).filter((line) => line.tag === null && !known.has(line.text));
}

// A session writes one marker at the end of a line it did not pass: (live check YYYY-MM-DD: <result>), result one of
// "unreachable: <why>", "release not live", "failed, Slice N" or "failed, follow-up in Slice N". A new marker replaces the
// old one. The line stays open in unverified.md; it is left out of --todo and --count only on the marker's own date (the
// night's UTC date), so it is tried again the next night.
const MARKER = /\(live check (\d{4}-\d{2}-\d{2}): ([^)]*)\)/g;
const FAILED_SLICE = /^failed,\s*(?:follow-up in\s+)?Slice\s+(\d+)/i;

// The last marker in a line's text: { date, result, failedSlice } or null.
export function markerOf(text) {
  const all = [...String(text).matchAll(MARKER)];
  if (!all.length) return null;
  const [, date, result] = all[all.length - 1];
  const slice = FAILED_SLICE.exec(result.trim());
  return { date, result: result.trim(), failedSlice: slice ? Number(slice[1]) : null };
}

export function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

export function todoLines(text, tags = SESSION_TAGS, today = utcToday()) {
  return parseLines(text)
    .filter((line) => line.tag !== null && tags.includes(line.tag))
    .map((line) => ({ ...line, marker: markerOf(line.text) }))
    .filter((line) => line.marker?.date !== today);
}

export function parseTagList(value) {
  const tags = String(value ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return tags.every((t) => TAGS.includes(t)) && tags.length ? tags : null;
}

// The file at `ref`, or null when git cannot show it (no such ref, shallow clone, file not yet in the base).
function readBase(root, ref) {
  try {
    return execFileSync('git', ['-C', root, 'show', `${ref}:${UNVERIFIED}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

// True only when git reads the ref's tree fine and the file is not in it (ls-tree exits 0 with no output); a git failure is not "absent".
function fileAbsent(root, ref) {
  try {
    const listed = execFileSync('git', ['-C', root, 'ls-tree', '--name-only', ref, '--', UNVERIFIED], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return listed.trim() === '';
  } catch { return false; }
}

function refExists(root, ref) {
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function runLint(text, root, args, out) {
  const ref = option(args, '--base') ?? 'origin/main';
  const base = readBase(root, ref);
  if (base === null) {
    // A guard denies only what it is sure of: with no base to compare against, every untagged line would look new.
    out(`warning: cannot read ${ref}:${UNVERIFIED}; lint skipped`);
    return 0;
  }
  const bad = untaggedNew(text, base);
  for (const line of bad) out(`untagged: ${line.slice}: ${line.text.slice(0, 120)}`);
  if (bad.length) out(`${bad.length} new line(s) in ${UNVERIFIED} start with no tag; begin each with one of ${TAGS.map((t) => `[${t}]`).join(' ')}`);
  return bad.length ? EXIT_FAIL : 0;
}

function runTodo(text, args, out) {
  const tags = parseTagList(option(args, '--todo'));
  if (!tags) { out(`usage: --todo <comma list of ${TAGS.join('|')}>`); return EXIT_USAGE; }
  const lines = todoLines(text, tags, option(args, '--today') ?? utcToday());
  out(args.includes('--json') ? JSON.stringify(lines) : lines.map((l) => `${l.slice}\n  ${l.text}${failedNote(l)}`).join('\n'));
  return 0;
}

// A line that already failed and cites its slice: the session updates that slice instead of filing a new one.
function failedNote(line) {
  return line.marker?.failedSlice ? `\n  (failed before: update Slice ${line.marker.failedSlice}, do not file a new slice)` : '';
}

function runCount(text, args, out) {
  const tags = parseTagList(option(args, '--count'));
  if (!tags) { out(`usage: --count <comma list of ${TAGS.join('|')}>`); return EXIT_USAGE; }
  out(String(todoLines(text, tags, option(args, '--today') ?? utcToday()).length));
  return 0;
}

// --origin: read origin/main's copy (the caller fetched first), not the primary checkout's, which can be behind.
// Exit 1 when origin/main cannot be read, so the caller counts "failed" rather than "none"; no unverified.md on a readable
// origin/main means no open lines (count 0, empty list).
function fromOrigin(root, args, out) {
  if (!refExists(root, 'origin/main')) { out(`cannot read origin/main:${UNVERIFIED}`); return EXIT_FAIL; }
  const read = readBase(root, 'origin/main');
  if (read === null && !fileAbsent(root, 'origin/main')) { out(`cannot read ${UNVERIFIED} at origin/main`); return EXIT_FAIL; }
  const text = read ?? '';
  if (args.includes('--todo')) return runTodo(text, args, out);
  if (args.includes('--count')) return runCount(text, args, out);
  out('usage: --origin goes with --todo <tags> or --count <tags>');
  return EXIT_USAGE;
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function main(argv, out = console.log) {
  const [root, ...args] = argv;
  if (!root || root.startsWith('-') || !isDirectory(root)) {
    // The first argument is the repo root: a flag or a missing folder there is a usage error, never "no unverified.md".
    out(`usage: node live-checks.mjs <repo root, an existing folder> --lint | --todo <tags> | --count <tags>${root ? ` (got "${root}" as the repo root)` : ''}`);
    return EXIT_USAGE;
  }
  if (args.includes('--origin')) return fromOrigin(resolve(root), args, out);
  const file = join(resolve(root), UNVERIFIED);
  if (!existsSync(file)) {
    out(args.includes('--count') ? '0' : `no ${UNVERIFIED} in ${root}`);
    return 0;
  }
  const text = readFileSync(file, 'utf8');
  if (args.includes('--lint')) return runLint(text, resolve(root), args, out);
  if (args.includes('--todo')) return runTodo(text, args, out);
  if (args.includes('--count')) return runCount(text, args, out);
  out('usage: node live-checks.mjs <repo root> --lint | --todo <tags> | --count <tags>');
  return EXIT_USAGE;
}

if (isEntryPoint(process.argv[1], import.meta.url)) process.exit(main(process.argv.slice(2)));
