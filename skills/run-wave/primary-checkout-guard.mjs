#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell: `git checkout|switch|reset|stash|pull|restore|clean|merge|rebase|cherry-pick|revert|am`, `git commit --amend` and
// `git branch -f|--force` are refused
// when the directory it targets (`-C <dir>`, else the hook cwd moved by earlier `cd` statements) is the
// primary checkout of a repo that has worktrees (its `.git` is a directory and `git worktree list` shows
// more than one). Plain `git commit` is not guarded. Allowed: `git stash list|show`; `git pull --ff-only` on branch main,
// only when `git status --porcelain` is empty, with no refspec or exactly `origin main` (AgentPipeline' own after-merge step); and `git checkout main` / `git switch main` (the repair that puts a primary back on the
// trunk). Anything unreadable lets the call through (fail open), with the reason on stderr.
// Also refused, in any repo: `git worktree add` whose path lands inside a primary checkout.
// It catches the common forms, not every one: `cd`/`chdir`/`pushd`/`Set-Location [-Path]`/`Push-Location`
// (also `cd /d X` and `(cd X && git ...)`), `git -C X`, `--git-dir=`/`--work-tree=` (also as `GIT_DIR=`),
// `VAR=x git`, and heredoc / here-string bodies are ignored. Not covered: a command wrapped in `bash -c "..."`,
// `eval`, a script, or a variable used as the directory.
// (2026-10-31: a read-only audit agent ran `git checkout --detach` in the primary checkout; ~/.claude/CLAUDE.md
// forbids it, and a rule alone did not stop it.)
import { readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize, nativePath } from './merge-gate.mjs';

// The advisory helper lives in another skill folder and loads dynamically: when it is missing (a partial install)
// the discard warning is off and the hook still denies as before.
let advisoryLib = null;
try { advisoryLib = await import('../feedback-loop/advisory.mjs'); } catch (error) { process.stderr.write(`primary-checkout-guard: advisory.mjs unavailable (${error.message}); discard warning off\n`); }

const GUARDED = new Set(['checkout', 'switch', 'reset', 'stash', 'pull', 'restore', 'clean']);
const ALWAYS_MOVING = new Set(['merge', 'rebase', 'cherry-pick', 'revert', 'am']);
const FORCE_BRANCH_FLAG = /^(--force|-[A-Za-z]*f[A-Za-z]*)$/;
const STASH_READ_ONLY = new Set(['list', 'show']);
// A redirection word: optional fd digit, `<`, `>` or `>>`, then its target glued on (group 1) or not.
const REDIRECTION = /^\d*(?:>>?|<)(.*)$/;
const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n']);
const CHANGE_DIR = /^(cd|chdir|pushd|set-location|push-location|sl)$/i;
const PATH_FLAG = /^-(path|literalpath)$/i;
const SWITCH_FLAG = /^(\/d|-[a-z]+)$/i;
const ENV_ASSIGNMENT = /^([A-Za-z_]\w*)=(.*)$/;
const COMMAND_PREFIX = /^(env|command|exec|nohup)$/i;
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/;
const HERE_STRING_START = /@(['"])\s*$/;
const MAIN_BRANCH = 'main';
const FAST_FORWARD_ONLY = '--ff-only';
const MAIN_REMOTE = 'origin';
const BRANCH_SWITCHERS = new Set(['checkout', 'switch']);
const WORKTREE_VALUED_FLAGS = new Set(['-b', '-B', '--reason']);

// The command without heredoc (`<<EOF ... EOF`) and PowerShell here-string (`@'` ... `'@`) bodies, which are
// text, not commands. A marker with no closing line is left alone.
export function stripBodies(command) {
  const lines = String(command ?? '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const doc = HEREDOC.exec(lines[i]);
    const str = doc ? null : HERE_STRING_START.exec(lines[i]);
    const closes = doc ? (l) => l.trim() === doc[2] : (l) => str && l.startsWith(`${str[1]}@`);
    const end = doc || str ? lines.findIndex((l, j) => j > i && closes(l)) : -1;
    out.push(doc ? lines[i].replace(HEREDOC, '') : lines[i]);
    if (end !== -1) i = end;
  }
  return out.join('\n');
}

// Removes `2>&1`, `*>&1` (PowerShell) and turns `&>f` / `&>>f` into `>f`, before tokenizing: their `&`
// would otherwise split the statement, and the words after it would escape the check (high review, 2026-11-01).
export function stripFdRedirects(command) {
  return String(command ?? '')
    .replace(/(^|\s)[\d*]?>&\d+(?=$|[\s;|&)])/g, '$1')
    .replace(/(^|\s)&(>>?)/g, '$1$2');
}

function statements(command) {
  const out = [[]];
  for (const token of tokenize(stripFdRedirects(stripBodies(command)))) {
    if (SEPARATORS.has(token)) out.push([]);
    else out[out.length - 1].push(token);
  }
  return out;
}

// `(cd X` and `git ...)`: subshell parentheses are not part of the words.
function unparen(words) {
  const mapped = words.map((w, i) => (i === 0 ? w.replace(/^\(+/, '') : w)).filter((w) => w !== '');
  const last = mapped.length - 1;
  if (last >= 0) mapped[last] = mapped[last].replace(/\)+$/, '');
  return mapped.filter((w) => w !== '');
}

// The directory a `cd`-like statement moves to (`cd /d X`, `Set-Location -Path X`, `Push-Location X`), or null.
function changedDir(words, dir) {
  if (!words.length || !CHANGE_DIR.test(words[0])) return null;
  for (let i = 1; i < words.length; i++) {
    if (PATH_FLAG.test(words[i])) return words[i + 1] ? resolve(dir, nativePath(words[i + 1])) : null;
    if (!SWITCH_FLAG.test(words[i])) return resolve(dir, nativePath(words[i]));
  }
  return null;
}

// The repo directory a `--git-dir` / `--work-tree` pair points at: the work tree, else the parent of a `.git`.
function repoDirOf(gitDir, workTree, fallback) {
  if (workTree) return resolve(fallback, nativePath(workTree));
  if (!gitDir) return fallback;
  const dir = resolve(fallback, nativePath(gitDir));
  return basename(dir) === '.git' ? dirname(dir) : dir;
}

// Leading `VAR=x` words (and `env`/`command`), remembering GIT_DIR / GIT_WORK_TREE.
function skipPrefix(words) {
  const env = {};
  let i = 0;
  for (; i < words.length; i++) {
    const assignment = ENV_ASSIGNMENT.exec(words[i]);
    if (assignment) env[assignment[1]] = assignment[2];
    else if (!COMMAND_PREFIX.test(words[i])) break;
  }
  return { rest: words.slice(i), gitDir: env.GIT_DIR, workTree: env.GIT_WORK_TREE };
}

// { dir, subcommand, args } of a `git [-C d] [-c k=v] [--git-dir=d] [--work-tree=d] <sub> ...` statement, or null.
function gitCall(statement, startDir) {
  const { rest: words, gitDir: envGitDir, workTree: envWorkTree } = skipPrefix(statement);
  if (!words.length || !/(^|[\\/])git(\.exe)?$/i.test(words[0])) return null;
  let dir = startDir;
  let gitDir = envGitDir;
  let workTree = envWorkTree;
  let i = 1;
  for (; i < words.length && words[i].startsWith('-'); i++) {
    const valued = /^--(git-dir|work-tree)(?:=(.*))?$/.exec(words[i]);
    if (words[i] === '-C') dir = resolve(dir, nativePath(words[++i] ?? '.'));
    else if (words[i] === '-c') i++;
    else if (valued) {
      const value = valued[2] ?? words[++i];
      if (valued[1] === 'git-dir') gitDir = value; else workTree = value;
    }
  }
  if (!words[i]) return null;
  return { dir: gitDir || workTree ? repoDirOf(gitDir, workTree, dir) : dir, subcommand: words[i], args: withoutRedirections(words.slice(i + 1)) };
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// The repo root above dir when its `.git` is a directory (a primary checkout), else null.
export function primaryRoot(dir) {
  for (let current = resolve(dir); ; current = dirname(current)) {
    const marker = join(current, '.git');
    if (existsSync(marker)) return statSync(marker).isDirectory() ? current : null;
    if (dirname(current) === current) return null;
  }
}

export function hasWorktrees(root) {
  return git(root, ['worktree', 'list', '--porcelain']).split(/\r?\n/).filter((l) => l.startsWith('worktree ')).length > 1;
}

// Whether the call moves a checkout's branch or files: the guarded subcommands, the history-rewriting ones,
// `commit --amend` and `branch -f`.
function isGuardedCall(call) {
  if (GUARDED.has(call.subcommand) || ALWAYS_MOVING.has(call.subcommand)) return true;
  if (call.subcommand === 'commit') return call.args.includes('--amend');
  return call.subcommand === 'branch' && call.args.some((a) => FORCE_BRANCH_FLAG.test(a));
}

// The words of a call with shell redirections left out: `2>&1` arrives as `2>` (the `&` splits the
// statement), `>log`/`2>/dev/null` as one word, and a bare `>`/`2>>` takes the next word as its target.
// (2026-11-01: `git -C <primary> pull --ff-only origin main 2>&1` was refused as a pull with an extra refspec.)
export function withoutRedirections(words) {
  const kept = [];
  for (let i = 0; i < words.length; i++) {
    const redirect = REDIRECTION.exec(words[i]);
    if (!redirect) kept.push(words[i]);
    else if (!redirect[1]) i++;
  }
  return kept;
}

// `git pull` words after the flags: allowed are none, or exactly `origin main`.
function pullTargetsMain(args) {
  const positional = args.filter((a) => !a.startsWith('-'));
  return positional.length === 0 || (positional.length === 2 && positional[0] === MAIN_REMOTE && positional[1] === MAIN_BRANCH);
}

function isAllowed(call) {
  if (call.subcommand === 'stash') return STASH_READ_ONLY.has(call.args[0] ?? '');
  if (BRANCH_SWITCHERS.has(call.subcommand)) return call.args.length === 1 && call.args[0] === MAIN_BRANCH;
  if (call.subcommand !== 'pull') return false;
  return call.args.includes(FAST_FORWARD_ONLY) && pullTargetsMain(call.args)
    && git(call.dir, ['rev-parse', '--abbrev-ref', 'HEAD']) === MAIN_BRANCH && isClean(call.dir);
}

// No uncommitted or untracked changes: another session's edits there must not move under it
// (2026-11-01: ship-branch pulled in a primary holding another session's work).
function isClean(dir) {
  return git(dir, ['status', '--porcelain']) === '';
}

// The path a `git worktree add` call would create, resolved the way git does (against the `-C` dir), or null.
function worktreeAddTarget(call) {
  if (call.subcommand !== 'worktree' || call.args[0] !== 'add') return null;
  const args = call.args.slice(1);
  for (let i = 0; i < args.length; i++) {
    if (WORKTREE_VALUED_FLAGS.has(args[i])) { i++; continue; }
    if (!args[i].startsWith('-')) return resolve(call.dir, nativePath(args[i]));
  }
  return null;
}

// The primary checkout a new worktree would land inside, or null. Worktrees live next to the repo, never in it
// (2026-11-01, ReadTheStupidText wave 2: `git -C <repo> worktree add <relative path>` put two inside the primary).
export function worktreeInsidePrimary(call) {
  const target = worktreeAddTarget(call);
  if (!target) return null;
  const root = primaryRoot(dirname(target)) ?? primaryRoot(call.dir);
  if (!root) return null;
  const inside = target.toLowerCase().startsWith(resolve(root).toLowerCase() + sep);
  return inside ? { root, target } : null;
}

// Whether the call throws away uncommitted edits in the files it names, in ANY checkout: `git checkout -- <path>`
// (also `git checkout <rev> -- <path>`) and `git restore` unless it is `--staged` alone. A builder ran
// `git checkout --` in its own worktree (2026-11-03) and the edit was gone; restore a truncated file with
// `git show HEAD:<file>` and Edit instead (Slice 307).
// Only the SOURCE-LESS forms are denied: `git checkout -- <path>` and `git restore <path>` (no `--source`/`-s`, not
// staged-only: `--staged`/`-S`). `git checkout <ref> -- <path>` (run-wave's claim step runs
// `git checkout HEAD -- plan.md`), `git checkout --theirs -- <path>` and `git restore -S <path>` pass.
const CHECKOUT_SOURCE_FLAGS = /^(?:--(?:ours|theirs|merge|patch|conflict(?:=.*)?)|-[mp])$/;
const RESTORE_SOURCE_FLAG = /^(?:--source(?:=.*)?|-s)$/;

function checkoutDiscards(args) {
  const dashes = args.indexOf('--');
  if (dashes < 0) return false;
  const before = args.slice(0, dashes);
  return !before.some((a) => !a.startsWith('-') || CHECKOUT_SOURCE_FLAGS.test(a)) && !hasFlag(before, 'p', '--patch') && !hasFlag(before, 'm', '--merge');
}

// Whether a flag word (`-SW`, `-p`, `--staged`) sets the short letter or long name (combined short flags count).
function hasFlag(args, letter, long) {
  return args.some((a) => a === long || (/^-[A-Za-z]+$/.test(a) && a.includes(letter)));
}

function restoreDiscards(args) {
  if (args.some((a) => RESTORE_SOURCE_FLAG.test(a)) || hasFlag(args, 's', '--source')) return false;
  if (hasFlag(args, 'p', '--patch')) return false;
  const staged = hasFlag(args, 'S', '--staged');
  const worktree = hasFlag(args, 'W', '--worktree');
  return (!staged || worktree) && args.some((a) => !a.startsWith('-'));
}

// The files `git checkout <rev> -- <path>` or `git restore --source <rev> <path>` would overwrite (an explicit source), or [].
// `-p`/`--patch`/`--staged`-only and the conflict-side forms are not whole-file overwrites of the working copy.
function sourcedTargets(call) {
  if (call.subcommand === 'checkout') {
    const dashes = call.args.indexOf('--');
    // Without `--`, `git checkout <tree-ish> <path>...` (all plain words, two or more) is sourced too.
    if (dashes < 0) return call.args.length >= 2 && call.args.every((a) => !a.startsWith('-')) ? call.args.slice(1) : [];
    const before = call.args.slice(0, dashes);
    const isSourced = before.some((a) => !a.startsWith('-')) && !before.some((a) => CHECKOUT_SOURCE_FLAGS.test(a)) && !hasFlag(before, 'p', '--patch');
    return isSourced ? call.args.slice(dashes + 1) : [];
  }
  if (call.subcommand !== 'restore' || hasFlag(call.args, 'p', '--patch')) return [];
  const staged = hasFlag(call.args, 'S', '--staged');
  if (staged && !hasFlag(call.args, 'W', '--worktree')) return [];
  const paths = [];
  for (let i = 0; i < call.args.length; i++) {
    if (call.args[i] === '-s' || call.args[i] === '--source') { i++; continue; }
    if (!call.args[i].startsWith('-')) paths.push(call.args[i]);
  }
  return call.args.some((a) => RESTORE_SOURCE_FLAG.test(a)) ? paths : [];
}

// The named files that have uncommitted changes (git status --porcelain), [] when git cannot say. Slice 315 item 5: a wave 3
// coordinator ran `git checkout origin/main -- <file>` over uncommitted work and deleted a new method.
export function dirtyTargets(call) {
  const paths = sourcedTargets(call);
  if (!paths.length) return [];
  try { return git(call.dir, ['status', '--porcelain', '--', ...paths]).split(/\r?\n/).filter(Boolean).map((line) => line.replace(/^\s*\S+\s+/, '').split(' -> ').pop()); } catch { return []; }
}

export function discardsFiles(call) {
  if (call.subcommand === 'checkout') return checkoutDiscards(call.args);
  return call.subcommand === 'restore' && restoreDiscards(call.args);
}

// The first guarded git call aimed at a primary checkout with worktrees, or null. A `cd` inside `( ... )`
// only lasts to the closing parenthesis.
export function findViolation(command, cwd) {
  let dir = cwd;
  let outer = null;
  let discard = null;
  for (const raw of statements(command)) {
    const opens = raw.length > 0 && raw[0].startsWith('(');
    const closes = raw.length > 0 && raw[raw.length - 1].endsWith(')');
    if (opens) outer = dir;
    const words = unparen(raw);
    const moved = changedDir(words, dir);
    const call = moved ? null : gitCall(words, dir);
    if (moved) dir = moved;
    if (closes && outer !== null) { dir = outer; outer = null; }
    const nested = call ? worktreeInsidePrimary(call) : null;
    if (nested) return { root: nested.root, subcommand: 'worktree add', target: nested.target };
    if (call && !discard && discardsFiles(call)) discard = { root: call.dir, subcommand: call.subcommand, discard: true };
    const dirty = call && !discard ? dirtyTargets(call) : [];
    if (dirty.length) discard = { root: call.dir, subcommand: call.subcommand, discard: true, dirty };
    if (!call || !isGuardedCall(call)) continue;
    const root = primaryRoot(call.dir);
    if (root && hasWorktrees(root) && !isAllowed(call)) return { root, subcommand: call.subcommand };
  }
  return discard;
}

// Whether any statement is `dotnet build-server shutdown` (it stops every session's build servers).
export function runsBuildServerShutdown(command) {
  return statements(command).some((raw) => {
    const { rest } = skipPrefix(unparen(raw));
    return rest.length >= 3 && /(^|[\\/])dotnet(\.exe)?$/i.test(rest[0]) && rest[1].toLowerCase() === 'build-server' && rest[2].toLowerCase() === 'shutdown';
  });
}

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

const BUILD_SERVER_REASON = 'build server guard: `dotnet build-server shutdown` stops the build servers of every session on this machine, not just yours. Build with `dotnet build --disable-build-servers` and test with `--no-build` in a worktree that will be removed (~/.claude/CLAUDE.md, "Release what you hold").';

// ADVISORY (Slice 307, two strikes): the source-less discard is a heuristic, so it warns and logs, never denies.
function discardAdvisory(found) {
  if (found.dirty) return advisoryLib.advisory(`discard guard: \`git ${found.subcommand}\` with an explicit source overwrites uncommitted changes in ${found.dirty.join(', ')}. Commit or copy them first; read other versions with \`git show <rev>:<file>\`.`);
  return advisoryLib.advisory(`discard guard: \`git ${found.subcommand}\` with a path throws away uncommitted edits in that file, in any checkout. If a file was truncated or mangled, read the good text with \`git show HEAD:<file>\` and redo the change with the Edit tool; to unstage use \`git restore --staged\`.`);
}

export function decide(input, warn = (t) => process.stderr.write(t)) {
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return null;
  if (runsBuildServerShutdown(String(input.tool_input?.command ?? ''))) return deny(BUILD_SERVER_REASON);
  try {
    const found = findViolation(String(input.tool_input?.command ?? ''), input.cwd ?? process.cwd());
    if (!found) return null;
    if (found.target) return deny(`worktree guard: \`git worktree add\` would create ${found.target} inside ${found.root}. Worktrees live next to the repo: pass an absolute path such as <repo>-worktrees/<slug> (a relative path that stays inside the \`-C\` directory, with no leading \`../\`, resolves inside the repo).`);
    if (found.discard) return advisoryLib ? discardAdvisory(found) : null;
    const reason = `primary checkout guard: \`git ${found.subcommand}\` would change ${found.root}, the primary checkout of a repo with worktrees; other sessions work from it. `
      + 'Read other refs with `git show <ref>:<path>` or `git diff`, or use a worktree (`git worktree add`). The only changes allowed here are `git -C <primary> pull --ff-only [origin main]` on a clean main (for a dirty primary run `node ~/.claude/skills/run-wave/ff-primary.mjs <primary>`, which lets untracked and phantom-modified files pass and never deletes a real edit) and `git checkout main` / `git switch main` (to put a primary that was left on another branch or detached back on the trunk).';
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  } catch (error) {
    warn(`primary-checkout-guard: let the call through (${error.message})\n`);
    return null;
  }
}

export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const verdict = decide(input);
    if (verdict && !verdict.hookSpecificOutput.permissionDecision && advisoryLib) advisoryLib.emit('primary-checkout-guard', verdict, input.cwd ?? process.cwd());
    else if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`primary-checkout-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
