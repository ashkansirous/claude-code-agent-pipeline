#!/usr/bin/env node
// Line-ending check for changed files: node line-endings.mjs <file> [<file> ...]
// Or what git stores at a ref: node line-endings.mjs --ref origin/main <file> ...  (prints LF, CRLF, mixed per file)
// Prints one line per problem file and exits 1: a doubled CR (`\r\r\n`), a lone CR mid-line, or mixed endings (some lines end
// CRLF and some LF). Files that are all LF or all CRLF pass. Binary files (a NUL byte) and missing files
// are skipped. Replaces `grep -P`, which Git Bash on this host refuses ("-P supports only unibyte and UTF-8
// locales", 2026-10-30/31: builder and fixer agents could not run the check their brief named).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';

// { doubled, crlf, lf } counts of line endings in text.
// lone: a CR not followed by LF (a shell turned `\r` in a Windows path into a real CR: 2026-11-01,
// ReadTheStupidText wave 2, `..\reset-dev-app.ps1` became `..<CR>eset-dev-app.ps1` and cost a phone run).
export function countEndings(text) {
  const doubled = (text.match(/\r\r\n/g) ?? []).length;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const all = (text.match(/\n/g) ?? []).length;
  const trailing = text.endsWith('\r') ? 1 : 0; // a CR as the file's last byte is not a mid-file one
  const lone = (text.match(/\r(?!\n)/g) ?? []).length - doubled - trailing;
  return { doubled, crlf, lf: all - crlf, lone };
}

// The problem with one file's text, or null when its endings are consistent.
export function problemOf(text) {
  if (text.includes('\0')) return null;
  const { doubled, crlf, lf, lone } = countEndings(text);
  if (doubled) return `doubled CR on ${doubled} line(s)`;
  if (lone) return `lone CR (not before LF) ${lone} time(s)`;
  if (crlf && lf) return `mixed endings: ${crlf} CRLF, ${lf} LF`;
  return null;
}

export function check(files, read = (f) => readFileSync(f, 'latin1')) {
  return files.filter((f) => existsSync(f)).map((f) => ({ file: f, problem: problemOf(read(f)) })).filter((r) => r.problem);
}

// The ending of a text as one word: LF, CRLF, mixed, none (no line break) or binary.
export function endingKind(text) {
  if (text.includes('\0')) return 'binary';
  const { crlf, lf } = countEndings(text);
  if (crlf && lf) return 'mixed';
  if (crlf) return 'CRLF';
  return lf ? 'LF' : 'none';
}

// `git show <ref>:<path>` reads the path from the repo root, so a path given from the cwd (absolute, `./x`, backslashes, from a
// subfolder) is first made repo-root-relative with forward slashes.
export function repoRelative(file, cwd = process.cwd(), top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()) {
  // Backslashes first: on Linux `..\y.md` would otherwise be one file name, not a parent path.
  return relative(top, resolve(cwd, file.replace(/\\/g, '/'))).replace(/\\/g, '/');
}

export const OUTSIDE_REPO = 'outside the repo';

const gitShow = (ref, file) => {
  const rel = repoRelative(file);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error(OUTSIDE_REPO);
  return execFileSync('git', ['show', `${ref}:${rel}`], { encoding: 'latin1', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
};

// `--ref <ref>` (Slice 29 item 52): the endings of each file as git stores it at that ref (`git show <ref>:<file>`), never the
// working copy, which `core.autocrlf` may have turned CRLF. One `<file>@<ref>: <kind>` line per file; a problem or a file
// missing at the ref is a line with the reason. Returns { lines, bad }.
export function checkRef(files, ref, show = gitShow) {
  const lines = [];
  let bad = 0;
  for (const file of files) {
    let text;
    try { text = show(ref, file); } catch (error) {
      const reason = error.message === OUTSIDE_REPO ? OUTSIDE_REPO : 'missing at that ref';
      lines.push(`${file}@${ref}: ${reason}`);
      bad += 1;
      continue;
    }
    const problem = problemOf(text);
    if (problem) bad += 1;
    lines.push(`${file}@${ref}: ${endingKind(text)}${problem ? ` (${problem})` : ''}`);
  }
  return { lines, bad };
}

function isEntryPoint() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--ref');
  if (at >= 0) {
    const ref = args[at + 1];
    const files = args.filter((_, i) => i !== at && i !== at + 1);
    if (!ref || !files.length) { process.stderr.write('usage: line-endings.mjs --ref <ref> <file> [<file> ...]\n'); process.exit(2); }
    const { lines, bad } = checkRef(files, ref);
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exit(bad ? 1 : 0);
  }
  const found = check(args);
  for (const r of found) process.stdout.write(`${r.file}: ${r.problem}\n`);
  process.exit(found.length ? 1 : 0);
}
