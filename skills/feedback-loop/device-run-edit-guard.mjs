#!/usr/bin/env node
// DENY only the certain case (Slice 35 item 4); every other case stays an advisory warning. It denies an edit whose target
// file is inside a checkout whose own git dir holds a mark that is clearly live: younger than LIVE_MAX_AGE_MS (a device run
// stops at 10 minutes), or carrying a process id in its name (run-flows marks) that is still alive. The mark sits in that
// checkout's own git dir, so the verdict does not depend on the caller's cwd. A mark between that bound and 90 minutes with
// no live pid may be a leftover of a dead run (agents/device-test.md rule 0): it only warns. The device-test writer itself
// is never denied. Each deny writes one advisory-log line.
// PreToolUse hook on Write, Edit and NotebookEdit (Slice 307, item 8). `device-test` marks its worktree with
// `<absolute git dir>/device-test-running-<id>` (agents/device-test.md rule 0); the builder agents already refuse to
// edit under a mark, but only by their own text. The mark lives in the worktree's OWN git dir, so no path is recorded.
// A mark older than 90 minutes is a leftover and ignored (the same bound the agents use).
// Passes: files outside any git checkout, files under the checkout's `tmp/` folder (scratch and run evidence),
// files inside the git dir itself, and any internal error (fail open, with a note on stderr).
// Not covered: edits made through Bash (sed, redirects); the shell guards and the agents' own rule cover those.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// The advisory helper (only its log writer is used) loads dynamically: when it is missing the deny still works, unlogged.
let advisoryLib = null;
try { advisoryLib = await import('./advisory.mjs'); } catch (error) { process.stderr.write(`device-run-edit-guard: advisory.mjs unavailable (${error.message}); deny log off\n`); }
const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const warn = (reason) => (advisoryLib ? advisoryLib.advisory(reason) : null);
// Prints the verdict and keeps the one-line log of it (the log failing never changes the verdict).
const emit = (hook, verdict, cwd) => {
  if (!verdict) return;
  const out = verdict.hookSpecificOutput;
  if (out.permissionDecision === 'deny') {
    if (advisoryLib) advisoryLib.logAdvisory(hook, cwd, `DENIED: ${out.permissionDecisionReason}`);
  } else if (advisoryLib) advisoryLib.logAdvisory(hook, cwd, out.additionalContext);
  process.stdout.write(JSON.stringify(verdict));
};

export const MARK_PREFIX = 'device-test-running';
export const MARK_MAX_AGE_MS = 90 * 60 * 1000;
// A live run stops at 10 minutes (agents/device-test.md); a mark younger than this is certainly a run in progress.
export const LIVE_MAX_AGE_MS = 15 * 60 * 1000;
// Only the exact name form the run-flows runner writes carries a pid; a timestamp id such as `-20261126-1432-ab` is not one.
const PID_IN_NAME = new RegExp(`^${MARK_PREFIX}-run-flows-(\\d+)-`);
// The flows and checks a missing-check writer creates (agents/device-test.md, "Writing a missing check").
const RUN_FILES_FOLDERS = ['flows', 'checks'];
const SCRATCH_FOLDER = 'tmp';
// The subagent that creates the mark writes missing flows/checks itself (agents/device-test.md, "Writing a missing
// check"), so it is exempt. Claude Code puts `agent_type` (and `agent_id`) in every hook input fired inside a
// subagent: https://code.claude.com/docs/en/agent-sdk/hooks ("Callback functions > Inputs"; PreToolUseHookInput).
const DEVICE_AGENT = 'device-test';
const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m;

// { root, gitDir } of the checkout that holds `file` (walking up to the nearest `.git`), or null.
export function checkoutOf(file) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    if (existsSync(dotGit)) return { root: dir, gitDir: gitDirOf(dotGit, dir) };
    if (dirname(dir) === dir) return null;
  }
}

// `.git` is a folder in a primary checkout and a `gitdir: <path>` file in a worktree.
function gitDirOf(dotGit, root) {
  if (statSync(dotGit).isDirectory()) return dotGit;
  const pointer = GITDIR_LINE.exec(readFileSync(dotGit, 'utf8'));
  return pointer ? resolve(root, pointer[1]) : null;
}

const MAX_PID = 2 ** 31 - 1;

// kill(0, 0) signals the whole process group, so pid 0 (and anything not a whole number above 0) is never a live run.
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PID) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// A mark younger than 90 minutes: { name, certain }. certain = under LIVE_MAX_AGE_MS, or its name holds a live pid.
// A certain mark wins over an uncertain one. Null when none.
export function liveMark(gitDir, now = Date.now()) {
  if (!gitDir || !existsSync(gitDir)) return null;
  let found = null;
  for (const name of readdirSync(gitDir)) {
    if (!name.startsWith(MARK_PREFIX)) continue;
    const age = now - statSync(join(gitDir, name)).mtimeMs;
    if (age >= MARK_MAX_AGE_MS) continue;
    const pid = PID_IN_NAME.exec(name)?.[1];
    const certain = age < LIVE_MAX_AGE_MS || (pid !== undefined && pidAlive(Number(pid)));
    if (certain) return { name, certain };
    found ??= { name, certain };
  }
  return found;
}

function isRunFile(file, root) {
  const parts = relative(root, file).split(sep);
  return parts[0] === 'tools' && parts.slice(1, -1).some((part) => RUN_FILES_FOLDERS.includes(part));
}

function isScratchOrGit(file, root, gitDir) {
  const inside = relative(root, file);
  if (inside.startsWith('..') || isAbsolute(inside)) return true;
  const first = inside.split(sep)[0];
  const underGit = gitDir && !relative(gitDir, file).startsWith('..');
  return first === SCRATCH_FOLDER || first === '.git' || Boolean(underGit);
}

function targetOf(input) {
  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(input.cwd ?? process.cwd(), raw);
}

export function decide(input, now = Date.now()) {
  if (!['Write', 'Edit', 'NotebookEdit'].includes(input.tool_name)) return null;
  if (input.agent_type === DEVICE_AGENT) return null;
  const file = targetOf(input);
  if (!file) return null;
  const checkout = checkoutOf(file);
  if (!checkout || isScratchOrGit(file, checkout.root, checkout.gitDir) || isRunFile(file, checkout.root)) return null;
  const mark = liveMark(checkout.gitDir, now);
  if (!mark) return null;
  if (!mark.certain) {
    return warn(`device run guard: ${checkout.root} has a device-test mark (${mark.name}) under 90 minutes old but over 15, so the run may have died. If a run is live, changing files under it makes its result worthless; otherwise tell the coordinator the mark is a leftover. Do not delete it yourself.`);
  }
  const reason = `device run guard: ${checkout.root} is held by a device run (${mark.name} in its git dir). Changing files under a running test makes its result worthless (2026-11-01: a fixer rewrote a worktree under a landscape check). Stop, edit nothing, and report \`blocked: device test running on this worktree\` to the coordinator; wait for the device-test report. Never delete the mark file: only the coordinator removes a mark.`;
  return deny(reason);
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo (see entry-points.test.mjs).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch (error) {
    process.stderr.write(`device-run-edit-guard: realpath failed (${error.message}); comparing plain paths\n`);
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    emit('device-run-edit-guard', decide(input), input.cwd ?? process.cwd());
  } catch (error) {
    process.stderr.write(`device-run-edit-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
