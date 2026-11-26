#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell: a first push of a branch (`git push -u` / `--set-upstream`)
// in a repo with docs/plan/slices must run in the same command as the slice-number check
// (`parallel_check.py <worktree> --check-slice <branch> && git ... push -u ...`), so the push can never
// go out before the check. Later pushes to an existing upstream are not touched. A repo without
// docs/plan/slices is not touched. An internal error lets the call through (fail open), with a note
// on stderr. (2026-10-31, ReadTheStupidText: ship-branch pushed PR #645 before the check, against the
// one-command rule already written in agents/ship-branch.md.)
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEPARATOR = /(\r?\n|;|&&|\|\||\|)/;
const AND = '&&';
const GIT_PUSH = /^\s*(?:&\s*)?["']?[^\s"']*\bgit(?:\.exe)?["']?\s+((?:(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)|-c\s+\S+|--[\w-]+(?:=\S+)?)\s+)*)push\b(.*)$/id;
const GIT_DIR_OPTION = /-C\s+("[^"]+"|'[^']+'|\S+)/gi;
const CHANGE_DIR = /^\s*(?:cd|chdir|pushd|set-location|sl)\s+(?:-(?:path|literalpath)\s+|\/d\s+)?("[^"]+"|'[^']+'|\S+)\s*$/i;
const FIRST_PUSH = /\s(--set-upstream|-[a-zA-Z]*u[a-zA-Z]*)(\s|$)/;
const CHECK = /^\s*(?:&\s*)?["']?[^\s"']*(?:python|py)[^\s"']*["']?\s[\s\S]*parallel_check\.py[\s\S]*--check-slice/i;
const SLICES_DIR = join('docs', 'plan', 'slices');
// The one command that does the check and the push together (push-branch.mjs); the guard lets it through.
// (2026-11-01, ReadTheStupidText: a denied `commit && push` left agents unsure whether the commit had run.)
const HELPER = 'node ~/.claude/skills/parallel-check/push-branch.mjs';
const REASON = 'push guard: a first push (git push -u) in a repo with docs/plan/slices must run the slice-number check before it. Use the one command that does both, as its own call: ' + HELPER + ' <worktree> <branch>. (Or, in one command: python -I ~/.claude/skills/parallel-check/parallel_check.py <worktree> --check-slice <branch> && git -C <worktree> push -u origin <branch>; agents/ship-branch.md step 6.)';

function commandOf(input) {
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return null;
  return String(input.tool_input?.command ?? '');
}

function unquote(text) {
  return text.replace(/^['"]|['"]$/g, '');
}

// Git Bash writes C:\x as /c/x; node on Windows needs the drive form.
function nativePath(text) {
  const drive = process.platform === 'win32' ? /^\/([a-z])\/(.*)$/i.exec(text) : null;
  return drive ? `${drive[1]}:/${drive[2]}` : text;
}

const HEREDOC = /<<-?\s*(["']?)([\w.-]+)\1/y;
const MASK = '_';

// Skips a quoted string from index i; returns the index after the closing quote, masking what is inside.
function maskQuoted(chars, i) {
  const quote = chars[i];
  let end = i + 1;
  while (end < chars.length && chars[end] !== quote) end++;
  for (let k = i + 1; k < Math.min(end, chars.length); k++) chars[k] = MASK;
  return end + 1;
}

// Masks the body of a heredoc (after the line that opens it, up to the terminator line).
function maskHeredoc(chars, text, from, word) {
  let lineStart = text.indexOf('\n', from) + 1;
  if (lineStart === 0) return;
  for (; lineStart < text.length; ) {
    const lineEnd = text.indexOf('\n', lineStart);
    const stop = lineEnd === -1 ? text.length : lineEnd;
    if (text.slice(lineStart, stop).trim() === word) return;
    for (let k = lineStart; k < stop; k++) chars[k] = MASK;
    if (lineEnd === -1) return;
    lineStart = lineEnd + 1;
  }
}

// Same length as the command, with quoted strings and heredoc bodies blanked so their text is never read as a statement.
function maskedOf(command) {
  const chars = [...command];
  const heredocs = [];
  for (let i = 0; i < command.length; ) {
    const ch = command[i];
    if (ch === '"' || ch === "'") { i = maskQuoted(chars, i); continue; }
    HEREDOC.lastIndex = i;
    const heredoc = ch === '<' ? HEREDOC.exec(command) : null;
    if (heredoc) { heredocs.push({ from: i + heredoc[0].length, word: heredoc[2] }); i += heredoc[0].length; continue; }
    i++;
  }
  for (const { from, word } of heredocs) maskHeredoc(chars, command, from, word);
  return chars.join('');
}

// Statements (original text, masked text) with the separator that precedes each one.
function statementsOf(command) {
  const masked = maskedOf(command);
  const parts = masked.split(SEPARATOR);
  const found = [];
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) found.push({ text: command.slice(offset, offset + parts[i].length), masked: parts[i], before: i === 0 ? '' : parts[i - 1] });
    offset += parts[i].length;
  }
  return found;
}

// True when an unbroken `&&` chain ending just before statement `index` contains the slice check.
function checkedBefore(statements, index) {
  for (let i = index; i > 0 && statements[i].before === AND; i--) {
    if (CHECK.test(statements[i - 1].text)) return true;
  }
  return false;
}

// The directory a statement runs in: the hook cwd moved by the `cd` statements before it, then its `git -C` paths.
function pushDirectory(statements, index, cwd, gitOptions) {
  let dir = cwd;
  for (const { text } of statements.slice(0, index)) {
    const target = CHANGE_DIR.exec(text)?.[1];
    if (target) dir = resolve(dir, nativePath(unquote(target)));
  }
  for (const option of gitOptions.matchAll(GIT_DIR_OPTION)) dir = resolve(dir, nativePath(unquote(option[1])));
  return dir;
}

// Walks up from dir: true when a repo root with docs/plan/slices is reached before a `.git` without one.
export function inSliceRepo(dir) {
  for (let current = dir, parent = dirname(current); ; current = parent, parent = dirname(current)) {
    if (existsSync(join(current, SLICES_DIR))) return true;
    if (existsSync(join(current, '.git')) || parent === current) return false;
  }
}

// The first denied push in the command: { dir, branch } (branch is null when the command names none).
export function unchecked(command, cwd) {
  if (!command) return null;
  const statements = statementsOf(command);
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index];
    const push = GIT_PUSH.exec(statement.masked);
    if (!push || !FIRST_PUSH.test(` ${push[2]}`)) continue;
    const [from, to] = push.indices[1];
    const dir = pushDirectory(statements, index, cwd, statement.text.slice(from, to));
    if (!checkedBefore(statements, index) && inSliceRepo(dir)) return { dir, branch: branchOf(statement.text.slice(push.indices[2][0])) };
  }
  return null;
}

export function needsCheck(command, cwd) {
  return unchecked(command, cwd) !== null;
}

// git push options that take their value as the next word (`-o ci.skip`, `--repo x`); `--opt=v` needs no skip.
const VALUED_OPTIONS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

// The words of a push that are neither options nor the value of an option that takes one.
function positionalWords(pushArguments) {
  const words = [];
  const tokens = pushArguments.trim().split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    if (VALUED_OPTIONS.has(tokens[index])) index++;
    else if (!tokens[index].startsWith('-')) words.push(tokens[index]);
  }
  return words;
}

// `origin feat/y` -> feat/y: the second word that is not an option. A refspec (`HEAD:feat/y`) gives its
// destination; a bare `HEAD` or an empty destination gives null. Null when the push names no branch.
export function branchOf(pushArguments) {
  const words = positionalWords(pushArguments);
  if (words.length < 2) return null;
  const name = unquote(words[1]).replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '');
  return name && name !== 'HEAD' ? name : null;
}

// Says which worktree and branch were denied and that NOTHING in the denied command ran.
export function reasonFor(found) {
  const where = `${found.dir ? `worktree ${found.dir}` : 'the worktree'}, branch ${found.branch ?? '<branch>'}`;
  return `${REASON} Denied push: ${where}. The denied command did not run at all, so a git commit chained before the push in the same command has NOT happened: run the commit as its own call first, then push with ${HELPER} ${found.dir ?? '<worktree>'} ${found.branch ?? '<branch>'}.`;
}

export function decide(input) {
  const found = unchecked(commandOf(input), input.cwd ?? process.cwd());
  if (!found) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reasonFor(found) } };
}

// Compares real paths: ~/.claude/skills/<name> is a copy of, or a symlink to, the AgentPipeline repo.
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`push-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
