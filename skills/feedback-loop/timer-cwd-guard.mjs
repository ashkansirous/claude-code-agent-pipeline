#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell: refuses a background check timer (`sleep` / `Start-Sleep` with
// run_in_background) whose working directory is inside a linked git worktree. The timer process keeps that
// folder as its cwd for its whole run, and `git worktree remove` then fails with "Permission denied" or
// "busy" (2026-11-01, print-the-damn-book night: three loop folders and one wave folder that stayed locked
// had a `sleep 600` timer started inside them). Reproduced in the final loop that night: with a background
// `sleep 90` running from a throw-away worktree, `git worktree remove` deleted the files and deregistered
// the worktree but failed on the folder itself ("Permission denied"); after the task was stopped, `rmdir`
// of the empty folder worked. A `cd /d/repo && sleep 90` prefix held the folder just the same, so only the
// session's own cwd counts. A linked worktree is found by a `.git` FILE in the cwd or a
// parent that points into `.git/worktrees/` (the primary checkout has a `.git` directory and a submodule's
// file points into `.git/modules/`; both are allowed). A sleep counts at the start, after ; & | { ( and
// after `do` / `then` (an `until ...; do sleep 20; done` wait loop).
// It also denies `git worktree remove <path>` (a Bash/PowerShell command, or an Agent brief's prompt) while the
// session's cwd is inside <path> (Slice 29 item 5); register it on the Agent matcher too for the brief form.
// Passes: foreground sleeps and any background command without such a sleep in it.
// An internal error lets the call through (fail open), with a note on stderr.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMER = /(?:^|[;&|{(\n]\s*|\b(?:do|then)\s+)(?:sleep|Start-Sleep)\b/i;
const WORKTREE_GITDIR = /^gitdir:.*[\\/]\.git[\\/]worktrees[\\/]/m;
// A session that started inside the worktree may be unable to cd out (the harness resets the cwd to its
// start folder); it marks the timer and stops it with TaskStop before removing the worktree.
const OPT_OUT = /#\s*worktree-timer-ok\b/;
const REASON =
  'This background timer would start while the session is inside a git worktree and hold that folder ' +
  'until it ends, so `git worktree remove` fails ("Permission denied"). A `cd` inside the same command does ' +
  'not help. Run `cd <repo root>` as its own call first, in an earlier message, not the same one (parallel calls in one message do not wait for the cd), then start the timer. If the cwd will not leave the ' +
  'worktree (the session started there), end the command with `# worktree-timer-ok` and TaskStop the timer ' +
  'before removing the worktree. See ~/.claude/CLAUDE.md, Work in a worktree.';

export function linkedWorktreeRoot(start) {
  let dir = start;
  for (let i = 0; i < 64 && dir; i++) {
    try {
      const stat = statSync(join(dir, '.git'));
      // A submodule's .git file points into .git/modules/, a linked worktree's into .git/worktrees/.
      return stat.isFile() && WORKTREE_GITDIR.test(readFileSync(join(dir, '.git'), 'utf8')) ? dir : null;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

// `git worktree remove [flags] <path>` in a shell command or an Agent brief (Slice 29 item 5: the main shell's cwd was
// inside the folder when a ship-branch agent, or the session itself, removed it: "Permission denied", three times).
const WORKTREE_REMOVE = /\bworktree\s+remove\b((?:\s+(?:-f|--force|--))*)\s+("[^"]+"|'[^']+'|[^\s"'`;&|)]+)/gi;
const REMOVE_REASON =
  'This would remove a git worktree while the session\'s own working directory is inside it, so the removal ' +
  'fails with "Permission denied" (the folder stays held by the shell). A `cd <root> && git worktree remove <path>` ' +
  'in the same command is denied too: skills/run-wave/SKILL.md section 7 records that form failing. Run `cd <repo root>` ' +
  'as its own tool call first, in an earlier message, then remove the worktree; in an Agent brief, tell the agent to remove ' +
  'it only after that cd. If this shell always starts inside the worktree (the cd does not stick), end the command ' +
  'with `# worktree-remove-ok`. See ~/.claude/CLAUDE.md, Work in a worktree.';
const REMOVE_OPT_OUT = /#\s*worktree-remove-ok\b/;
// Known limits (a guard denies only what it is sure of): the quote mask toggles on every quote, so an unbalanced
// apostrophe earlier in the command, or `bash -c "git worktree remove <path>"` (the argument is quoted, so read as
// prose), passes; a target given through a variable (`$WT`, `~`, `%VAR%`) is not expanded and passes.

// Marks every character that is prose rather than a command: inside '...', "...", `...` or a heredoc body.
function proseMask(text) {
  const mask = new Array(text.length).fill(false);
  for (const heredoc of text.matchAll(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?(?:\n\s*\2\b|$)/g)) {
    const bodyStart = heredoc.index + heredoc[0].indexOf('\n');
    for (let i = bodyStart; i < heredoc.index + heredoc[0].length; i++) mask[i] = true;
  }
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      mask[i] = true;
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (!mask[i] && (ch === '"' || ch === "'" || ch === '`')) {
      quote = ch;
      mask[i] = true;
    }
  }
  return mask;
}

// Marks only the characters inside backticks (an Agent brief's instruction to run a command).
function backtickMask(text) {
  const mask = new Array(text.length).fill(false);
  for (const span of text.matchAll(/`[^`]*`/g)) {
    for (let i = span.index; i < span.index + span[0].length; i++) mask[i] = true;
  }
  return mask;
}

function normalizePath(path, cwd) {
  const unquoted = path.replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/^\/([a-zA-Z])\//, '$1:/');
  const absolute = /^[a-zA-Z]:\/|^\//.test(unquoted) ? unquoted : `${cwd.replace(/\\/g, '/')}/${unquoted}`;
  const parts = [];
  for (const part of absolute.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return parts.join('/').replace(/\/+$/, '').toLowerCase();
}

// `git -C <dir> worktree remove <relative>` resolves the relative path against <dir>.
function baseDirFor(text, matchIndex, cwd) {
  const before = text.slice(Math.max(0, text.lastIndexOf('\n', matchIndex)), matchIndex);
  const dir = [...before.matchAll(/\s-C\s+("[^"]+"|'[^']+'|[^\s"']+)\s/g)].pop();
  return dir ? normalizePath(dir[1], cwd) : cwd;
}

// `isBrief` true for an Agent prompt: only an instruction inside backticks counts; for a shell command, only text outside
// quotes and heredoc bodies counts (a commit message or echo that mentions the command is not the command).
export function removesWorktreeContainingCwd(text, cwd, isBrief = false) {
  if (!text || !cwd) return false;
  const here = normalizePath(cwd, cwd);
  const mask = isBrief ? backtickMask(text) : proseMask(text);
  for (const match of text.matchAll(WORKTREE_REMOVE)) {
    if (mask[match.index] !== isBrief) continue;
    const target = normalizePath(match[2], baseDirFor(text, match.index, cwd));
    if (target && (here === target || here.startsWith(`${target}/`))) return true;
  }
  return false;
}

function denyDecision(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

export function decide(input, findRoot = linkedWorktreeRoot) {
  const toolInput = input?.tool_input ?? {};
  const isBrief = toolInput.command === undefined;
  const text = String(toolInput.command ?? toolInput.prompt ?? '');
  if (!REMOVE_OPT_OUT.test(text) && removesWorktreeContainingCwd(text, input?.cwd, isBrief)) return denyDecision(REMOVE_REASON);
  if (toolInput.run_in_background !== true) return null;
  const command = String(toolInput.command ?? '');
  if (!TIMER.test(command) || OPT_OUT.test(command)) return null;
  if (!input.cwd || !findRoot(input.cwd)) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON } };
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo (see entry-points.test.mjs).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch (error) {
    process.stderr.write(`timer-cwd-guard: realpath failed (${error.message}); comparing plain paths\n`);
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`timer-cwd-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
