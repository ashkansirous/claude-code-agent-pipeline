#!/usr/bin/env node
// Runs a script of the agent-board plugin for a caller that is not the plugin (Slice 20): our skills and agents
// call `node ~/.claude/skills/run-wave/board.mjs <script> [args...]` instead of a path inside the plugin, whose
// install folder changes with every version. The folder is read from Claude Code's installed_plugins.json.
//   <script>            report-progress | sync-docs | usage-tick | usage-report | cap-reading   -> scripts/<script>.mjs
//   hooks/<name>        scripts/hooks/<name>.mjs
// Before it starts the script it needs AGENT_BOARD_URL (your board's address; unset means the report is skipped) and fills AGENT_BOARD_TOKEN (the
// write token from the secrets store) unless it is already set; the token goes to the child by environment
// only, never printed and never on a command line. `--steps-file <name>` with a bare name is rewritten to
// our step list skills/run-wave/steps/<name>.json. Every other flag, `--under-step <id>` and `--orchestrator` (Slice 24) included,
// goes to the plugin's script unchanged, except with `--under-step`: AGENT_BOARD_MODEL is removed from the child's environment (any letter case), `--steps-file`/`--touches`/`--touches-file` become inline `--steps "a|b|c"` (labels trimmed to the Touches line by the plugin's own readers) and `--agent` is dropped, so the report never overwrites the slice card's model or agent; a plugin version that does not know a flag exits non-zero and is skipped below. Fails open: a missing plugin, script or token, or a child that
// exits non-zero, prints one `board: skipped (<reason>)` line and exits 0.
// Slice 34 B/C: each step's `process` key in a steps file reaches the board (a steps-file report: the plugin reads it; an `--under-step` report:
// sent as `--step-process "<label>|<key>"` before the caller's flags, so a caller's own flag wins); `--counts "name=1,other=2"` (on the
// `--step-done` step) goes to the plugin unchanged. A plugin that predates them ignores the flags.
// `--started-at <ISO>` / `--done-at <ISO>` (Slice 32 C) go to the plugin unchanged, `--under-step` rewrites included: the plugin puts them on the
// step `--step-active` / `--step-done` names (an ISO date-time with a zone, not in the future; it drops a bad one with a stderr line). A late
// report sends the real times read from evidence (a review file's mtime, a PR's mergedAt), or none; never "now". An installed plugin that
// predates them takes any unknown `--flag value` pair, ignores it and exits 0: the report goes out and the board stamps its own times, so
// `runBoard` checks the plugin script's source for the flag and prints one `board: note (...)` line saying the times are ignored (not a skip).
// Env: CLAUDE_CONFIG_DIR (else ~/.claude), AGENT_BOARD_URL, AGENT_BOARD_TOKEN, AGENT_BOARD_SECRETS_FILE.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ledgerLive, ledgerPath, stepReportPath } from './wave-gate.mjs';

// No default address: set AGENT_BOARD_URL to your own board's address (and AGENT_BOARD_TOKEN, or AGENT_BOARD_SECRETS_FILE).
// With AGENT_BOARD_URL unset every report is skipped and the token is never read or sent anywhere.
export const SECRETS_FILE = join(homedir(), '.secrets', 'agent-progress-board', 'secrets.env');
export const TOKEN_KEY = 'BOARD_WRITE_TOKEN';
export const MODEL_VARIABLE = 'AGENT_BOARD_MODEL';
export const PLUGIN_ID = 'agent-board@agent-progress-board';
const STEPS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'steps');
const STEPS_FLAG = '--steps-file';
const HOOKS_PREFIX = 'hooks/';
const USER_SCOPE = 'user';
const SCRIPT_NAME = /^[A-Za-z0-9_-]+$/;
const USAGE_SCRIPTS = new Set(['usage-tick', 'usage-report', 'cap-reading']);
const BARE_STEPS_NAME = /^[A-Za-z0-9_-]+$/;

function skip(reason) {
  process.stderr.write(`board: skipped (${reason})\n`);
  return { ok: false, reason };
}

export function configDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function entryTime(entry) {
  const time = Date.parse(entry && entry.lastUpdated);
  return Number.isNaN(time) ? 0 : time;
}

// Orders install entries best first: a user-scope install before a project-scope one, then the newest
// lastUpdated, a later entry before an earlier one on a tie.
function byPreference(a, b) {
  const scoreA = a.entry.scope === USER_SCOPE ? 1 : 0;
  const scoreB = b.entry.scope === USER_SCOPE ? 1 : 0;
  if (scoreA !== scoreB) return scoreB - scoreA;
  if (entryTime(a.entry) !== entryTime(b.entry)) return entryTime(b.entry) - entryTime(a.entry);
  return b.index - a.index;
}

// The install folder of the plugin that exists on disk (user scope first, then the newest), or '' when Claude
// Code has no record of it or every recorded folder is gone.
export function pluginInstallPath(env = process.env) {
  try {
    const record = JSON.parse(readFileSync(join(configDir(env), 'plugins', 'installed_plugins.json'), 'utf8'));
    const entries = ((record && record.plugins) || {})[PLUGIN_ID];
    if (!Array.isArray(entries)) return '';
    const usable = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry && typeof entry.installPath === 'string' && entry.installPath && existsSync(entry.installPath));
    usable.sort(byPreference);
    return usable.length ? usable[0].entry.installPath : '';
  } catch {
    return '';
  }
}

// Claude Code's persistent data folder for the plugin: <config>/plugins/data/<id>, the id being the plugin
// identifier with every character other than a letter, digit, `_` or `-` replaced by `-` (Claude Code plugins
// docs, "Path variables and persistent data"). It is what the plugin's own hooks get as CLAUDE_PLUGIN_DATA.
export function pluginDataPath(env = process.env) {
  return join(configDir(env), 'plugins', 'data', PLUGIN_ID.replace(/[^A-Za-z0-9_-]/g, '-'));
}

// The script file for a name, or '' for a name that is not one of the plugin's scripts.
export function scriptPath(installPath, name) {
  const isHook = name.startsWith(HOOKS_PREFIX);
  const bare = isHook ? name.slice(HOOKS_PREFIX.length) : name;
  if (!SCRIPT_NAME.test(bare)) return '';
  return isHook ? join(installPath, 'scripts', 'hooks', `${bare}.mjs`) : join(installPath, 'scripts', `${bare}.mjs`);
}

function readSecretsValue(env, key) {
  try {
    const text = readFileSync(env.AGENT_BOARD_SECRETS_FILE || SECRETS_FILE, 'utf8');
    // [ \t] not \s: a blank `KEY=` line must not capture the next line.
    const match = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[ \\t]*(.*?)[ \\t]*$`, 'm').exec(text);
    if (!match) return '';
    const quoted = /^(["'])(.*?)\1/.exec(match[1]);
    return quoted ? quoted[2] : match[1].replace(/[ \t]+#.*$/, '');
  } catch {
    return '';
  }
}

// Two spellings of one folder (slashes, trailing slash, drive-letter case on Windows) are the same folder.
export function samePath(a, b, platform = process.platform) {
  const norm = (p) => {
    const text = resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? text.toLowerCase() : text;
  };
  return norm(a) === norm(b);
}

// The child's environment: the board address and write token filled in unless the caller set them, and, given the
// plugin's install folder, CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA as Claude Code sets them for the plugin's own
// hooks, so a report from here writes its task file where the hooks look for it (AGENT_BOARD_SESSION_ROOT, a
// deliberate override, is left alone).
export function childEnv(env = process.env, installPath = '') {
  const filled = { ...env };
  if (installPath) {
    // A root left by another plugin's hook (a session started from one) is not this plugin's: replace it and its data folder (Slice 23).
    const foreign = Boolean(filled.CLAUDE_PLUGIN_ROOT) && !samePath(filled.CLAUDE_PLUGIN_ROOT, installPath);
    if (!filled.CLAUDE_PLUGIN_ROOT || foreign) filled.CLAUDE_PLUGIN_ROOT = installPath;
    if (!filled.CLAUDE_PLUGIN_DATA || foreign) filled.CLAUDE_PLUGIN_DATA = pluginDataPath(env);
  }
  if (filled.AGENT_BOARD_URL && !filled.AGENT_BOARD_TOKEN) {
    const token = readSecretsValue(env, TOKEN_KEY);
    if (token) filled.AGENT_BOARD_TOKEN = token;
  }
  return filled;
}

// `--steps-file run-wave` (a bare name) becomes the absolute path of our step list; a path or a name with .json is kept.
export function rewriteArgs(args) {
  const out = [];
  for (let index = 0; index < args.length; index++) {
    const joined = typeof args[index] === 'string' && args[index].startsWith(`${STEPS_FLAG}=`) ? args[index].slice(STEPS_FLAG.length + 1) : null;
    if (joined !== null) {
      out.push(BARE_STEPS_NAME.test(joined) && !isAbsolute(joined) ? `${STEPS_FLAG}=${join(STEPS_DIR, `${joined}.json`)}` : args[index]);
      continue;
    }
    out.push(args[index]);
    const value = args[index + 1];
    if (args[index] === STEPS_FLAG && typeof value === 'string' && BARE_STEPS_NAME.test(value) && !isAbsolute(value)) {
      out.push(join(STEPS_DIR, `${value}.json`));
      index++;
    }
  }
  return out;
}

// Starts the plugin's script; returns { ok, reason } and never throws. `spawnFn` is the test seam.
// A report titled "x" went out twice (wave 1, night 2026-11-17-1526); the plugin accepts any title, so the refusal is here, where the
// title is sent (Slice 23 item 13). Only a title given and shorter than 3 characters is refused; a report with no title is left alone.
export function placeholderTitle(args) {
  for (let index = 0; index < args.length; index++) {
    const joined = typeof args[index] === 'string' && args[index].startsWith('--title=') ? args[index].slice('--title='.length) : null;
    const value = joined !== null ? joined : args[index] === '--title' ? args[index + 1] : undefined;
    if (typeof value === 'string' && value.trim().length < 3) return true;
  }
  return false;
}

export function isUnderStep(args) {
  return args.some((arg) => arg === '--under-step' || (typeof arg === 'string' && arg.startsWith('--under-step=')));
}

// An `--under-step` report is a helper's list of children: the plugin fills `model` from AGENT_BOARD_MODEL, which would overwrite the
// slice card's model, so the variable is removed from that child's environment, whatever its letter case (Windows keys differ in case once copied) (Slice 24).
export function withoutModelForUnderStep(env, args) {
  if (!isUnderStep(args)) return env;
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== MODEL_VARIABLE));
}

// Splits `--flag value` / `--flag=value` out of args: { rest, values } with the value of each named flag.
function takeFlags(args, names) {
  const rest = [];
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const joined = typeof arg === 'string' ? names.find((name) => arg.startsWith(`${name}=`)) : undefined;
    if (joined) {
      values[joined] = arg.slice(joined.length + 1);
    } else if (names.includes(arg)) {
      values[arg] = args[index + 1] === undefined ? '' : args[index + 1];
      index++;
    } else {
      rest.push(arg);
    }
  }
  return { rest, values };
}

// The plugin's own step reader and Touches reader, from its located scripts folder; null for an export the installed version lacks.
async function pluginStepReaders(file) {
  try {
    const module = await import(pathToFileURL(file).href);
    return {
      loadStepList: typeof module.loadStepList === 'function' ? module.loadStepList : null,
      readTouchesFile: typeof module.readTouchesFile === 'function' ? module.readTouchesFile : null,
    };
  } catch {
    return { loadStepList: null, readTouchesFile: null };
  }
}

function stepsOfFile(path) {
  try {
    const steps = JSON.parse(readFileSync(resolve(path), 'utf8')).steps;
    return steps.filter((step) => step && typeof step.label === 'string' && step.label.trim());
  } catch {
    return [];
  }
}

// Slice 34 item B: the inline `--steps` list cannot carry a step's `process` key, so each one goes as `--step-process "<label>|<key>"`
// (the plugin, agent-progress-board Slice 55, puts it on that step). A caller's own `--step-process` comes later in `rest`, so it wins.
function processArgs(steps, stepsFile) {
  const keys = new Map(stepsOfFile(stepsFile).filter((step) => typeof step.process === 'string' && step.process.trim()).map((step) => [step.label.trim(), step.process.trim()]));
  return steps.filter((step) => keys.has(step.label.trim())).flatMap((step) => ['--step-process', `${step.label.trim()}|${keys.get(step.label.trim())}`]);
}

// An `--under-step` report sends the labels inline (`--steps "a|b|c"`), already trimmed to the slice's Touches line with the plugin's own
// readers, so the plugin sets no agent from a steps file and no helper's report touches the parent's `agent`; `--agent` is dropped too (Slice 24).
export async function underStepArgs(args, reportFile) {
  const flags = ['--steps-file', '--touches', '--touches-file', '--agent'];
  const { rest, values } = takeFlags(args, flags);
  const stepsFile = values['--steps-file'];
  if (!stepsFile) return rest;
  const readers = await pluginStepReaders(reportFile);
  let steps;
  if (readers.loadStepList) {
    const touches = [values['--touches'], readers.readTouchesFile ? readers.readTouchesFile(values['--touches-file']) : ''].filter(Boolean).join(' ');
    const list = readers.loadStepList(stepsFile, touches);
    steps = list ? list.steps : [];
  } else {
    steps = stepsOfFile(stepsFile);
  }
  return steps.length ? [...processArgs(steps, stepsFile), ...rest, '--steps', steps.map((step) => step.label).join('|')] : rest;
}

// Slice 32 item A: every open line of a slice's block in docs/plan/unverified.md is one more step after the static list.
// Item B: a check that waits on something else is a `pending` step whose note starts `waits on: ` (the plugin has no
// `blocked` step state until agent-progress-board Slice 51; switching to it is item C/E's later build).
const STEP_LABEL_LIMIT = 80;
const STEPS_TOTAL_MAX = 30;
const VANISHED_MAX = 3;
const CHECK_PREFIX = 'Check: ';
// "waits on" / "waiting on" counts only as the text's start or after a colon or dash ("waits on: Slice 51", "x - waiting on the owner"),
// never mid-sentence ("the page waits on the CDN"); `[owner]` and `**You:**` tags are OWNER_CHECK.
const WAITING_CHECK = /(?:^|:\s*|\s[-–—]\s*)(?:waits?|waiting)\s+on\b(?!\s+(?:nothing|no\s*one|none)\b)|\bneeds\s+(?:the\s+)?(?:owner|user)\b/i;
const OWNER_CHECK = /^\s*(?:\[owner\]|\*\*you:\*\*)/i;
const CHECKED_LINE = /^\[[xX]\]/;

// The open checks of one slice's block: a bullet at column 0 starts one, indented lines after it continue it; `[x]` lines are closed.
export function openChecksOf(text, slice) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^###\\s+Slice\\s+0*${Number(slice)}\\b(?!\\d)`, 'i').test(line));
  if (start < 0) return [];
  const checks = [];
  let open = false;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line)) break;
    const item = line.match(/^(?:[-*]|\d+[.)])\s+(.*\S)\s*$/);
    if (item) {
      open = !CHECKED_LINE.test(item[1]);
      if (open) checks.push(item[1]);
    } else if (open && /^\s+\S/.test(line)) {
      checks[checks.length - 1] += ` ${line.trim()}`;
    } else if (line.trim()) {
      open = false; // an unindented paragraph ends the check; a blank line alone does not
    }
  }
  return checks;
}

function fitLabel(plain, suffix = '') {
  const room = STEP_LABEL_LIMIT - CHECK_PREFIX.length - suffix.length;
  const cut = plain.length + suffix.length > STEP_LABEL_LIMIT - CHECK_PREFIX.length ? `${plain.slice(0, room - 1).trimEnd()}…` : plain;
  return `${CHECK_PREFIX}${cut}${suffix}`;
}

// The trailing "(live check YYYY-MM-DD: ...)" a live-checks session appends is not part of the check's label.
// Both follow the writer (live-checks.mjs TAG_PATTERN and MARKER): one whitespace character of any kind after the tag, and a
// trailing marker whose reason may hold one level of `( )`, ending at the line's final `)`; a `[x](url)` link or any other
// text is left alone. The board repo's sync-docs.mjs checkHash uses the same two regexes.
const CHECK_TAG = /^\[(?:chrome|session|phone|cloud|chat|owner)\]\s(?=\s*\S)/;
const LIVE_CHECK_MARKER = /\s*\(live check \d{4}-\d{2}-\d{2}: (?:[^()]|\([^()]*\))*\)\s*$/;

// The check's label text: no tag, no marker (a bullet that is only a marker keeps its text), no bold marks.
function checkPlain(text) {
  const untagged = text.replace(CHECK_TAG, '');
  const body = untagged.replace(LIVE_CHECK_MARKER, '').trim() ? untagged.replace(LIVE_CHECK_MARKER, '') : untagged;
  return body.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

export function checkStep(text) {
  const plain = checkPlain(text);
  const step = { label: fitLabel(plain) };
  if (OWNER_CHECK.test(text)) step.note = `waits on: owner: ${plain}`;
  else if (WAITING_CHECK.test(plain)) step.note = `waits on: ${plain}`;
  return step;
}

// A label no earlier label of the list has: a cut label that collides gets " (2)", " (3)" ... inside the 80 characters.
function distinctLabel(step, text, seen) {
  if (!seen.has(step.label)) return step.label;
  const plain = checkPlain(text);
  for (let n = 2; ; n++) {
    const label = fitLabel(plain, ` (${n})`);
    if (!seen.has(label)) return label;
  }
}

// The static list plus the open checks (cap: the plugin's 30 steps in all; the last kept step says how many more were cut), after
// `vanished` check labels (checks that left unverified.md since an earlier report) placed first so the plugin's positional states mark them done.
export function stepsWithChecks(base, checks, vanished = [], total = STEPS_TOTAL_MAX) {
  const seen = new Set(base.map((step) => step.label));
  const done = vanished.slice(-VANISHED_MAX).filter((label) => !seen.has(label)).map((label) => ({ label }));
  done.forEach((step) => seen.add(step.label));
  const extra = [];
  const texts = new Set();
  for (const check of checks) {
    if (texts.has(check)) continue;
    texts.add(check);
    const step = checkStep(check);
    step.label = distinctLabel(step, check, seen);
    seen.add(step.label);
    extra.push(step);
  }
  const room = total - base.length - done.length;
  const kept = extra.length > room ? [...extra.slice(0, Math.max(room - 1, 0)), { label: `+${extra.length - Math.max(room - 1, 0)} more checks (see unverified.md)` }] : extra;
  return kept.length || done.length ? [...done, ...base, ...kept] : base;
}

// The stamp file of a slice: line 1 the report time, line 2 the step label, then one `check: <label>` line per check label ever sent.
function readStampLines(file) {
  try { return readFileSync(file, 'utf8').split(/\r?\n/); } catch { return []; }
}

function stampChecks(file) {
  return readStampLines(file).slice(2).filter((l) => l.startsWith('check: ')).map((l) => l.slice('check: '.length));
}

function writeStamp(file, time, label, checks) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [time, label, ...checks.map((c) => `check: ${c}`)].join('\n') + '\n');
}

function hasFlag(args, name) {
  return args.some((arg) => arg === name || (typeof arg === 'string' && arg.startsWith(`${name}=`)));
}

// The slice's own report: a `--slice N` number, no `--part` or `--under-step` (those report a part's or a helper's steps, never the slice's).
function sliceOfOwnReport(args) {
  const slice = flagValue(args, '--slice');
  if (!slice || !/^\d+$/.test(slice) || hasFlag(args, '--part') || hasFlag(args, '--under-step')) return null;
  return slice;
}

function flagValue(args, name) {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name) return args[index + 1];
    if (typeof args[index] === 'string' && args[index].startsWith(`${name}=`)) return args[index].slice(name.length + 1);
  }
  return undefined;
}

function repoRoot(cwd) {
  try {
    return spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
  } catch {
    return '';
  }
}

// A `--steps-file run-wave` report for `--slice N` sends the static list plus the slice's open checks (and, first, the check labels that
// left unverified.md since the last report as done ones): the list is written to a file under <repo>-worktrees/step-reports/ and the flag
// points at it; the path goes into `made` so the caller deletes it after the plugin call. After `--step-done "Index pass"` the plugin makes
// the first open check active (an open check is the slice's current open work). A `--part` or `--under-step` report gets none.
// Any failure leaves the args as they are (fail open).
// The check part of the stamp is written only once the plugin call exited 0: `commits` receives the write as a function the caller runs then.
export function withOpenChecks(args, cwd = process.cwd(), made = [], commits = []) {
  try {
    const slice = sliceOfOwnReport(args);
    const stepsFile = flagValue(args, STEPS_FLAG);
    if (!slice || !stepsFile || resolve(stepsFile) !== join(STEPS_DIR, 'run-wave.json')) return args;
    const root = repoRoot(cwd);
    const ledger = ledgerPath(cwd);
    if (!root || !ledgerLive(ledger)) return args;
    const stamp = stepReportPath(ledger, slice);
    const open = openChecksOf(readFileSync(join(root, 'docs', 'plan', 'unverified.md'), 'utf8'), slice);
    const list = JSON.parse(readFileSync(stepsFile, 'utf8'));
    const sent = stampChecks(stamp);
    const everyOpen = stepsWithChecks([], open, [], Infinity).map((step) => step.label);
    const vanished = sent.filter((label) => !everyOpen.includes(label));
    const steps = stepsWithChecks(list.steps, open, vanished);
    if (steps === list.steps) return args;
    mkdirSync(dirname(stamp), { recursive: true });
    const out = join(dirname(stamp), `steps-slice-${Number(slice)}-${process.pid}.json`);
    writeFileSync(out, JSON.stringify({ ...list, steps }));
    made.push(out);
    // the stamp lists only the check labels in this report as open checks (a vanished label is in it as done, once; a capped one is not)
    const sentNow = steps.map((step) => step.label).filter((l) => l.startsWith(CHECK_PREFIX) && !vanished.includes(l));
    commits.push(() => {
      const [time, label] = readStampLines(stamp);
      if (time) writeStamp(stamp, time, label ?? '', sentNow);
    });
    return args.map((arg) => (arg === stepsFile ? out : typeof arg === 'string' && arg === `${STEPS_FLAG}=${stepsFile}` ? `${STEPS_FLAG}=${out}` : arg));
  } catch {
    return args;
  }
}

// Slice 32 item D: a report that moves a step of the slice leaves a stamp the wave gate reads (<repo>-worktrees/step-reports/slice-N.txt):
// the time and the step label made active (else done). Written at the top of runBoard, before any skip, so a skipped plugin still stamps;
// only while a live wave ledger exists (never creates the folder next to a repo with no wave). Fails open.
export function noteStepReport(args, cwd = process.cwd(), now = new Date()) {
  try {
    const slice = sliceOfOwnReport(args);
    const label = flagValue(args, '--step-active') ?? flagValue(args, '--step-done');
    if (!slice || label === undefined) return;
    const ledger = ledgerPath(cwd);
    if (!ledgerLive(ledger)) return;
    const file = stepReportPath(ledger, slice);
    writeStamp(file, now.toISOString(), String(label).trim(), stampChecks(file));
  } catch {
    // no stamp: the gate then has nothing to read and allows
  }
}

function removeFiles(files) {
  for (const file of files) {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

// A plugin script that predates `--started-at`/`--done-at` ignores them and exits 0, so say once that the times will be lost.
// Returns true when the note applies; the caller prints it after the reporter exits 0.
function oldPluginNote(args, file) {
  if (!hasFlag(args, '--started-at') && !hasFlag(args, '--done-at')) return false;
  let source = '';
  try { source = readFileSync(file, 'utf8'); } catch { return false; }
  return !source.includes('--started-at');
}

// `cwd` and `now` are injectable so a test never writes into a real <repo>-worktrees/step-reports folder.
export async function runBoard(argv, env = process.env, spawnFn = spawnSync, { cwd = process.cwd(), now = new Date() } = {}) {
  const [name, ...rest] = argv;
  if (!name) return skip('no script named');
  if (name === 'report-progress') noteStepReport(rest, cwd, now);
  if (USAGE_SCRIPTS.has(name) && String(env.AGENT_BOARD_USAGE || '').toLowerCase() === 'off') return skip('AGENT_BOARD_USAGE=off');
  if (name === 'report-progress' && placeholderTitle(rest)) return skip('title shorter than 3 characters: a placeholder is not sent');
  if (!env.AGENT_BOARD_URL) return skip('AGENT_BOARD_URL not set');
  const installPath = pluginInstallPath(env);
  if (!installPath) return skip('agent-board plugin not installed');
  const file = scriptPath(installPath, name);
  if (!file) return skip(`unknown script "${name}"`);
  if (!existsSync(file)) return skip(`${name} not found in the plugin`);
  const oldPlugin = name === 'report-progress' && oldPluginNote(rest, file);
  const made = [];
  const commits = [];
  let result;
  try {
    const rewritten = name === 'report-progress' ? withOpenChecks(rewriteArgs(rest), cwd, made, commits) : rewriteArgs(rest);
    const childArgs = isUnderStep(rest) ? await underStepArgs(rewritten, file) : rewritten;
    result = spawnFn(process.execPath, [file, ...childArgs], { env: withoutModelForUnderStep(childEnv(env, installPath), rest), stdio: 'inherit', windowsHide: true });
  } finally {
    removeFiles(made);
  }
  if (result.error) return skip(`${name} did not start`);
  if (result.status !== 0) return skip(`${name} exited ${result.status}`);
  if (oldPlugin) process.stderr.write('board: note (the installed agent-board plugin predates --started-at/--done-at: the times are ignored and the board stamps its own; update the plugin)\n');
  for (const commit of commits) { try { commit(); } catch { /* no stamp: the next report resends */ } }
  return { ok: true };
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    await runBoard(process.argv.slice(2));
  } catch {
    process.stderr.write('board: skipped (error)\n');
  }
  process.exit(0);
}
