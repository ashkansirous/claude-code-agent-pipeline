#!/usr/bin/env node
// Checks an agent's `released:` line against the machine: lists the live processes whose command line names the
// agent's worktree (watcher shells, build servers, dev servers). Usage: node released-check.mjs <worktree-path>
// Exit 0 = none left; 1 = some left (one `<pid><TAB><name><TAB><command line>` line each: send the agent back);
// 2 = bad usage or the process list could not be read. A Claude Code session or an editor (image `claude`, `Code`) that
// merely names the path is printed as "named, not counted" and never makes the exit code 1. Known limit: a server started
// after `cd <worktree>` has no path in its command line and is missed here (folder-holders.ps1 covers open files). It stops nothing. Its own process and its parents are
// never named. (2026-11-15, night 1401 wave 2: a fixer reported nothing left running while 8 watcher shells were alive.)
import { execFileSync } from 'node:child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT = { none: 0, left: 1, error: 2 };

const DRIVE_FORM = /^([a-z]):(\/.*)?$/;
const MSYS_FORM = /^\/([a-z])(\/.*)?$/;

// The folder as `d:/x/y` (drive form) and `/d/x/y` (MSYS form, what Git Bash shells carry), lower case, forward slashes.
// A drive-letter or MSYS argument is not resolved against the current folder.
export function folderForms(path) {
  const slashed = normalise(path);
  const lower = (/^[a-z]:/.test(slashed) || /^\/[a-z](\/|$)/.test(slashed) ? slashed : normalise(resolve(path)))
    .replace(/\/+$/, '');
  const msys = MSYS_FORM.exec(lower);
  if (msys) return [`${msys[1]}:${msys[2] ?? ''}`, lower];
  const drive = DRIVE_FORM.exec(lower);
  if (drive) return [lower, `/${drive[1]}${drive[2] ?? ''}`];
  return [lower];
}

const PATH_START = /[\s"'=;:,(]/;
const PATH_END = /[\s"'/]/;

// The form must start at a path start (line start, space, quote, `=`, `;`, `:`) and end at a path boundary (end, slash,
// quote, space), so `s09` never matches `s091` and `/d/x` never matches inside `c:/other/d/x`.
function namesForm(text, wanted) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(wanted, from);
    if (at === -1) return false;
    const before = text[at - 1];
    const next = text[at + wanted.length];
    if ((before === undefined || PATH_START.test(before)) && (next === undefined || PATH_END.test(next))) return true;
    from = at + 1;
  }
}

function normalise(text) {
  return String(text ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

// Whether `commandLine` names `folder` itself or a path under it (drive or MSYS form, either slash direction, any case).
// A sibling such as `s09-other` does not match `s09`.
export function namesFolder(commandLine, folder) {
  const text = normalise(commandLine);
  return folderForms(folder).some((wanted) => namesForm(text, wanted));
}

// Images of a Claude Code session or an editor: they name a path in a prompt or an open command, not because they hold it.
const SESSION_IMAGES = new Set(['claude', 'code']);

export function isSessionImage(name) {
  return SESSION_IMAGES.has(String(name ?? '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, ''));
}

// processes: [{ pid, name, commandLine }]; skip: pids that never count (this process and its parents).
export function leftRunning(worktree, processes, skip = []) {
  return namingProcesses(worktree, processes, skip).filter((p) => !isSessionImage(p.name));
}

// Processes that name the worktree but are a Claude Code session or an editor: printed, never counted.
export function namedNotCounted(worktree, processes, skip = []) {
  return namingProcesses(worktree, processes, skip).filter((p) => isSessionImage(p.name));
}

function namingProcesses(worktree, processes, skip) {
  const ignored = new Set(skip.map(Number));
  return processes.filter((p) => !ignored.has(Number(p.pid)) && namesFolder(p.commandLine, worktree));
}

// A leftover `sleep 95` wait names no path, so its folder is read from its working directory (Linux: /proc/<pid>/cwd; elsewhere
// unknown). A sleep whose cwd is the worktree counts; one whose cwd is unknown is printed, not counted (Slice 18: a ship-branch
// agent left its `sleep 95` running and called it harmless).
// A real sleep is a process named sleep, or a shell whose whole command is one plain sleep call (`pwsh -Command Start-Sleep -Seconds
// 95`, `bash -c "sleep 600"`); a shell script that merely mentions Start-Sleep is not one.
const SHELL_NAME = /^(?:bash|sh|zsh|pwsh|powershell|cmd)(?:\.exe)?$/i;
const PLAIN_SLEEP = /^\S*(?:bash|sh|zsh|pwsh|powershell|cmd)(?:\.exe)?(?:\s+-[A-Za-z]+)*\s+["']?(?:Start-Sleep(?:\s+-(?:Seconds|s))?|sleep)\s+\d+(?:\.\d+)?["']?$/i;

const baseName = (name) => String(name ?? '').replace(/^.*[\\/]/, '');

export function isSleep(p) {
  if (/^sleep(?:\.exe)?$/i.test(baseName(p.name))) return true;
  return SHELL_NAME.test(baseName(p.name)) && PLAIN_SLEEP.test(String(p.commandLine ?? '').trim());
}

export function readCwd(pid) {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}

// Windows has no /proc cwd: a sleep is tied to the worktree when an ancestor's command line names it (the shell or `claude -p`
// that started it). Only shell ancestors count and the walk stops at the first non-shell, so a `claude -p` or node process whose
// command line names the worktree (--add-dir) never ties a sleep to it. A chain that never names it ties nothing.
const RUNS_A_COMMAND = /(?:^|\s)(?:-[A-Za-z]*c|-command|-encodedcommand|-file|\/c|\/k)(?:\s|$)/i;
// A shell given a script file (`bash run.sh`, `sh -e run.sh`): the first argument after its flags is not an option.
const RUNS_A_SCRIPT = /^\s*["']?\S*(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?["']?(?:\s+-\S+)*\s+["']?[^-\s"']/i;
// An interactive or login terminal (-i, -ic, -li, -lc, -NoExit) is a user's, on both branches (Slice 23 check1 #3).
const INTERACTIVE_FLAG = /\s-[ilc]*[il][ilc]*(?=\s|$)|\s-noexit(?=\s|$)/i;
const runsNonInteractively = (commandLine) => !INTERACTIVE_FLAG.test(commandLine)
  && (RUNS_A_COMMAND.test(commandLine) || RUNS_A_SCRIPT.test(commandLine));
function ancestorNames(worktree, processes, pid) {
  const byPid = new Map(processes.map((p) => [Number(p.pid), p]));
  const seen = new Set();
  for (let at = Number(byPid.get(Number(pid))?.parent); at && !seen.has(at); at = Number(byPid.get(at)?.parent)) {
    seen.add(at);
    const ancestor = byPid.get(at);
    if (!ancestor || !SHELL_NAME.test(baseName(ancestor.name))) return false;
    // Only a shell started to run a command (`bash -c`, `pwsh -Command`, `cmd /c`) ties a sleep to the worktree; an interactive
    // terminal a user opened there is not an agent's (Slice 23 item 6, Slice 18 check3 #4).
    if (runsNonInteractively(String(ancestor.commandLine ?? '')) && namesFolder(ancestor.commandLine, worktree)) return true;
  }
  return false;
}

// -> { counted: sleeps whose cwd (or, with no cwd, an ancestor's command line) names the worktree, unknown: the rest whose
// folder could not be read }
export function liveSleeps(worktree, processes, skip = [], cwdOf = readCwd) {
  const ignored = new Set(skip.map(Number));
  const counted = [];
  const unknown = [];
  for (const p of processes.filter((q) => !ignored.has(Number(q.pid)) && isSleep(q))) {
    const cwd = cwdOf(p.pid);
    if (cwd !== null && cwd !== undefined) {
      if (namesFolder(`${cwd}/`, worktree)) counted.push(p);
    } else if (namesFolder(p.commandLine, worktree) || ancestorNames(worktree, processes, p.pid)) counted.push(p);
    else unknown.push(p);
  }
  return { counted, unknown };
}

function readWindowsProcesses() {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  const raw = execFileSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return [].concat(JSON.parse(raw)).map((p) => ({ pid: p.ProcessId, parent: p.ParentProcessId, name: p.Name, commandLine: p.CommandLine }));
}

function readPosixProcesses() {
  const raw = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return raw.split('\n').filter(Boolean).map((line) => {
    const [, pid, parent, name, args] = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line) ?? [];
    return { pid, parent, name, commandLine: args };
  });
}

// A live sleep named by the process that started it ("parent 123 claude"), so a report can say whose wait it is.
export function parentLabel(processes, pid) {
  const byPid = new Map(processes.map((p) => [Number(p.pid), p]));
  const parent = byPid.get(Number(byPid.get(Number(pid))?.parent));
  return parent ? `parent ${parent.pid} ${baseName(parent.name)}` : 'parent unknown';
}

export function readProcesses(platform = process.platform) {
  return platform === 'win32' ? readWindowsProcesses() : readPosixProcesses();
}

// This process and every ancestor, so the shell that launched the check is not reported as a leftover.
export function selfAndParents(processes, pid = process.pid) {
  const byPid = new Map(processes.map((p) => [Number(p.pid), p]));
  const chain = [];
  for (let at = Number(pid); at && !chain.includes(at); at = Number(byPid.get(at)?.parent)) chain.push(at);
  return chain;
}

const MAX_LINE_CHARS = 200;

// A command line cut to about 200 characters (a `claude -p "<brief>"` process would otherwise flood the output).
export function shorten(commandLine) {
  const text = String(commandLine ?? '');
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}... (${text.length} chars)` : text;
}

// The last line when nothing counts; never says "no live process names" after printing a named one.
export function noneLeftMessage(worktree, namedCount) {
  return namedCount
    ? `released-check: none counted; ${namedCount} named (session or editor) ${worktree}`
    : `released-check: no live process names ${worktree}`;
}

function main(argv) {
  const [worktree] = argv;
  if (!worktree) {
    console.error('usage: node released-check.mjs <worktree-path>');
    return EXIT.error;
  }
  let processes;
  try { processes = readProcesses(); } catch (error) {
    console.error(`released-check: could not read the process list: ${error.message}`);
    return EXIT.error;
  }
  const skip = selfAndParents(processes);
  const named = namedNotCounted(worktree, processes, skip);
  for (const p of named) console.log(`named, not counted\t${p.pid}\t${p.name}\t${shorten(p.commandLine)}`);
  const sleeps = liveSleeps(worktree, processes, skip);
  for (const p of sleeps.unknown) console.log(`named, not counted\t${p.pid}\t${p.name}\tlive sleep, folder unknown, ${parentLabel(processes, p.pid)}: ${shorten(p.commandLine)}`);
  const found = [...leftRunning(worktree, processes, skip), ...sleeps.counted];
  if (found.length === 0) {
    console.log(noneLeftMessage(worktree, named.length + sleeps.unknown.length));
    return EXIT.none;
  }
  for (const p of found) console.log(`${p.pid}\t${p.name}\t${shorten(p.commandLine)}`);
  console.log(`released-check: ${found.length} process(es) still name ${worktree}: send the agent back, or name each as another session's`);
  return EXIT.left;
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo, so argv[1] and import.meta.url differ by path.
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl)); } catch { return resolve(argvPath) === resolve(fileURLToPath(moduleUrl)); }
}

if (isEntryPoint(process.argv[1], import.meta.url)) process.exitCode = main(process.argv.slice(2));
