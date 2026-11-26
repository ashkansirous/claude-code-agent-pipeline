#!/usr/bin/env node
// Fails when a text file a branch changed holds a C0 control character or DEL (0x7F) other than tab, LF, or a
// CR directly before LF (a CRLF ending).
// A shell heredoc or sed can turn a backslash sequence in a Windows path (\f, \r, \b) into a real
// control byte (2026-10-31, ReadTheStupidText: `\fl-c` became a form feed; earlier a `\r\r` became CRs).
// Usage: node control-chars.mjs <worktree> [<base ref, default origin/main>] [--all]
// --all checks every tracked and untracked file instead of only the branch's changes.
// Exit 0: clean. Exit 1: prints file:line:column and the code for each hit. Exit 2: usage or git error.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';

// A diff with many thousand paths overflows Node's 1 MB default (ENOBUFS, night 2026-11-04-1441).
const MAX_BUFFER = 256 * 1024 * 1024;
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED = new Set([0x09, 0x0a, 0x0d]);
// DEL: an octal `\177` in a Windows path (`\reviews\177-review1.md`) becomes 0x7F through a shell
// (2026-11-01, ReadTheStupidText Slice 177's record: found next to a CR the scan did report).
const DEL = 0x7f;
// A CR is allowed only as the last character of a line (a CRLF ending). A CR mid-line is a
// `\r` from a Windows path in a brief (2026-11-01, print-the-damn-book: one reached main in PR #35).
const CR = 0x0d;
const BINARY_SNIFF_BYTES = 8000;

// The opposite damage: a script that meant to write a CR wrote the two characters `\r` (or `\n`)
// at the end of a line (2026-10-31: every line of branch-sweep/SKILL.md ended in a literal `\r`,
// which broke its front matter). Reported with code -1.
const ESCAPED_LINE_END = /\\[rn]$/;

export function findControlChars(text) {
  const hits = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (let col = 0; col < line.length; col++) {
      const code = line.charCodeAt(col);
      if ((code < 0x20 && !ALLOWED.has(code)) || code === DEL) hits.push({ line: index + 1, column: col + 1, code });
      if (code === CR && col < line.length - 1) hits.push({ line: index + 1, column: col + 1, code });
    }
    const body = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (ESCAPED_LINE_END.test(body)) hits.push({ line: index + 1, column: body.length - 1, code: -1 });
  });
  return hits;
}

function describe(hit) {
  if (hit.code < 0) return `${hit.file}:${hit.line}:${hit.column}: literal \\r or \\n at the end of the line`;
  return `${hit.file}:${hit.line}:${hit.column}: control character 0x${hit.code.toString(16).padStart(2, '0')}`;
}

export function isBinary(buffer) {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function git(worktree, args) {
  return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER });
}

export function changedFiles(worktree, base) {
  const committed = git(worktree, ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]);
  const working = git(worktree, ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']);
  const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard']);
  const names = `${committed}\n${working}\n${untracked}`.split('\n').map((s) => s.trim()).filter(Boolean);
  return [...new Set(names)];
}

function checkFile(worktree, name) {
  const path = join(worktree, name);
  if (!existsSync(path) || !statSync(path).isFile()) return [];
  const buffer = readFileSync(path);
  if (isBinary(buffer)) return [];
  return findControlChars(buffer.toString('utf8')).map((hit) => ({ file: name, ...hit }));
}

// Every tracked file plus untracked ones: for `--all`, which also finds damage already merged
// (2026-11-01: a 0x01 byte had sat in AgentPipeline ~/.claude/CLAUDE.md since 2026-10-31; no branch touched that line).
// core.quotepath=false keeps non-ASCII names unquoted, so they are read, not skipped.
export function allFiles(worktree) {
  const tracked = git(worktree, ['-c', 'core.quotepath=false', 'ls-files']);
  const untracked = git(worktree, ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']);
  return [...new Set(`${tracked}\n${untracked}`.split('\n').map((s) => s.trim()).filter(Boolean))];
}

function main(argv) {
  const all = argv.includes('--all');
  const [worktree, base = 'origin/main', ...extra] = argv.filter((a) => a !== '--all');
  if (!worktree || extra.length || [worktree, base].some((a) => a.startsWith('-'))) {
    console.error('usage: node control-chars.mjs <worktree> [<base ref>] [--all]');
    return 2;
  }
  let files;
  try {
    files = all ? allFiles(worktree) : changedFiles(worktree, base);
  } catch (error) {
    console.error(`git failed: ${error.message}`);
    return 2;
  }
  const hits = files.flatMap((name) => checkFile(worktree, name));
  for (const hit of hits) console.log(describe(hit));
  if (hits.length) console.log(`${hits.length} hit(s): rewrite those lines with the Write or Edit tool, never a shell.`);
  return hits.length ? 1 : 0;
}

// Compares real paths: ~/.claude/skills/<name> is a copy of, or a symlink to, the AgentPipeline repo, and a plain
// URL compare never matched through it, so the documented call ran nothing and exited 0 (2026-11-01).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  const self = fileURLToPath(moduleUrl);
  try { return realpathSync.native(argvPath) === realpathSync.native(self); } catch { return resolve(argvPath) === resolve(self); }
}

if (isEntryPoint(process.argv[1], import.meta.url)) process.exit(main(process.argv.slice(2)));
