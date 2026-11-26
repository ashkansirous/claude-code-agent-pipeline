#!/usr/bin/env node
// PreToolUse hook on the Agent tool: refuses a ship-branch claim from the wave's coordinator that would break the
// run-wave limit (at most 4 slices per wave, a closed wave takes no more claims). The coordinator is the session whose transcript
// loaded run-wave/run-all-waves, or whose session id is on the open wave's "Opened ... session <id>" line; any other session is not
// bound by the wave limits (it still needs a claim, and a clash with a cloud-running slice is still refused).
// Reads <repo>-worktrees/wave-ledger.md next to the repo. No ledger, a ledger untouched
// for 24 h, or no "## Wave" heading in it means no wave is running and the claim is allowed
// (a "## Wave" heading that does not parse warns instead of passing silently).
// A claim is a ship-branch call whose brief starts with the line "Claim mode." (ship-branch
// refuses to open a draft claim without it); every other call passes. The wave read is the one with the highest number.
// A ledger slice line saying "cloud running" is live work: that slice is not claimed again and a slice
// whose Touches overlap it is refused until the line says "cloud: pushed" (Slice 06).
// A commit or merge call for a slice in the open wave whose last step report (this wave) names a step before "Review pass 1 (high)" is
// refused too (Slice 32 item D): board.mjs writes <repo>-worktrees/step-reports/slice-N.txt (an ISO time, then the step label) at every
// step report while a wave ledger is live. No stamp, a stamp from before the wave or one that cannot be read allows the call.
// An internal error lets the call through but prints a visible systemMessage warning.
// (2026-10-30, ReadTheStupidText: 16 slices ran as one wave in one context.)
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDocsOnly } from './merge-gate.mjs';

const MAX_SLICES = 4;
const STALE_MS = 24 * 60 * 60 * 1000;
const CLAIM_MARKER = /^\s*Claim mode\./i;
const SLICES = /\bSlices?\s+(\d+(?:\s*(?:,|and|&)\s*(?:Slices?\s+)?\d+)*)/gi;
const WAVE_HEADING = /^##\s+Wave\s+(\d+)\b(.*)$/i;
const WAVE_STATUS = /\b(open|closed)\b/i;
const LEDGER_SLICE = /^\s*(?:[-*]|\|)\s*(?:\*\*)?Slice\s+(\d+)/i;
// A ledger slice line whose stage text is "stage: cloud running" (the form SKILL.md writes) is a cloud session still writing code
// (Slice 06). "cloud: pushed" or "cloud: done" ends it.
const CLOUD_RUNNING = /\bstage:\s*cloud running\b/i;
// A commit or merge call for a slice whose ledger line still says it is claimed or building means the coordinator never wrote
// the review stages: night 2026-11-16-2043 wave 1 merged Slice 07 with the line on "stage: building" and no board step report
// after review 1 began (Slice 15 item B1).
const SHIP_MARKER = /^\s*(?:(?:commit|merge)[ -]mode\b|mode:\s*(?:commit|merge)\b)/i;
// Only the line's own current stage field counts (the first "stage: <word>"), and the newest ledger line of a slice wins, so history
// text such as "stage: review 1 (was stage: building)" or an older line under the same number never denies.
const STAGE_FIELD = /\bstage:\s*(\w+)/i;
const EARLY_STAGES = new Set(['claiming', 'claimed', 'building']);
const TOUCHES_LINE = /^\s*\*\*Touches:\*\*[ \t]*(.*)$/im;

function readInput() {
  return JSON.parse(readFileSync(0, 'utf8'));
}

function claimOf(input) {
  const tool = input.tool_input ?? {};
  if (input.tool_name !== 'Agent' || tool.subagent_type !== 'ship-branch') return null;
  const prompt = String(tool.prompt ?? '');
  if (!CLAIM_MARKER.test(prompt)) return null;
  return { slices: slicesOf(prompt) };
}

function shipOf(input) {
  const tool = input.tool_input ?? {};
  if (input.tool_name !== 'Agent' || tool.subagent_type !== 'ship-branch') return null;
  const prompt = String(tool.prompt ?? '');
  if (!SHIP_MARKER.test(prompt)) return null;
  return { slices: shippedSlices(prompt), worktree: worktreeOf(prompt) };
}

// The slice's own worktree, as the brief names it ("Worktree <path>" or "worktree: <path>"). null when the brief names none, which makes the
// docs-only test unknown and so allows the call (Slice 32 check 2: the coordinator's cwd may be another slice's code branch).
export function worktreeOf(prompt) {
  const m = String(prompt).match(/\bworktree\b[:=]?\s+["'`]?([A-Za-z]:[\\/][^\s"'`,;)]*|\/[^\s"'`,;)]*)/i);
  return m ? m[1].replace(/[.:]+$/, '') : null;
}

// The one slice a commit or merge call is for: the brief names exactly one slice number (numbers after "plan-not-needed:" do not
// count). Several or none gives [], so the stage check allows the call (a guard denies only the case it is certain about).
function shippedSlices(prompt) {
  const text = prompt.split(/plan-not-needed:/i)[0];
  const named = new Set();
  for (const m of text.matchAll(SLICES)) for (const n of m[1].match(/\d+/g)) named.add(String(Number(n)));
  return named.size === 1 ? [...named] : [];
}

// Slices of the brief whose ledger line in the open wave still names an early stage.
// A docs-only branch (docsOnly() true) never ran the build and review stages, so its ledger line may still say building (Slice 33 item 8).
function staleStageSlices(path, slices, docsOnly = () => false) {
  if (docsOnly()) return [];
  const wave = lastWave(readFileSync(path, 'utf8'));
  if (!wave || wave.closed) return [];
  return slices.filter(n => wave.earlyStage.has(n));
}

// Where board.mjs leaves the time of a slice's last step report, next to the ledger.
export function stepReportPath(ledgerFile, slice) {
  return join(dirname(ledgerFile), 'step-reports', `slice-${Number(slice)}.txt`);
}

// The open wave's "Opened HH:MMZ YYYY-MM-DD" time as a Date, or null.
function openedAt(body) {
  const opened = (body ?? []).map((l) => l.match(OPENED_LINE)).find(Boolean);
  if (!opened) return null;
  const time = Date.parse(`${opened[3]}T${opened[1]}:${opened[2]}:00Z`);
  return Number.isNaN(time) ? null : new Date(time);
}

const STEPS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'steps', 'run-wave.json');
const REVIEW_STEP = 'Review pass 1 (high)';

// A ledger that exists and was touched in the last 24 h: the only case in which a wave is running.
export function ledgerLive(path) {
  try { return existsSync(path) && !isStale(path); } catch { return false; }
}

// True when every file the checkout's branch changed against origin/main is documentation (merge-gate.mjs's test). No origin/main,
// an unreadable diff or no changed file is unknown, which the gate treats as docs-only: it allows (a guard denies only what it is certain about).
export function branchIsDocsOnly(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'diff', '--name-only', 'origin/main...HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.split(/\r?\n/).filter(Boolean).map((path) => ({ path }));
    return files.length === 0 || isDocsOnly(files);
  } catch { return true; }
}

// Strict form for the stage check (Slice 33 item 8): true only when the branch's diff against its merge-base with origin/main, committed plus uncommitted
// (tracked changes and untracked files), is non-empty and every file is documentation. An empty diff, a git failure or an unreadable
// worktree path is unknown, so it is false and the stage denial stands.
export function branchChangesOnlyDocs(cwd, run = execFileSync) {
  try {
    const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    // The merge-base, not the origin/main tip: code merged to main after the branch started is not the branch's change.
    const base = String(run('git', ['-C', cwd, 'merge-base', 'origin/main', 'HEAD'], opts)).trim();
    if (!base) return false;
    const tracked = run('git', ['-C', cwd, 'diff', '--name-only', base], opts);
    const untracked = run('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard'], opts);
    const files = `${tracked}\n${untracked}`.split(/\r?\n/).filter(Boolean).map((path) => ({ path: path.replace(/\\/g, '/') }));
    return files.length > 0 && isDocsOnly(files);
  } catch { return false; }
}

// The stamp board.mjs writes at a step report: line 1 an ISO time, line 2 the step label made active or done. null when unreadable.
function readStamp(file) {
  try {
    const [time, label] = readFileSync(file, 'utf8').split(/\r?\n/);
    const at = Date.parse(String(time).trim());
    return Number.isNaN(at) ? null : { at, label: String(label ?? '').trim() };
  } catch { return null; }
}

function stepLabels(stepsFile) {
  return JSON.parse(readFileSync(stepsFile, 'utf8')).steps.map((step) => step.label);
}

// Slices of a commit or merge brief that the gate is certain went to commit or merge with no review ever reported: the slice is in the
// open wave, its stamp was written after the wave's Opened time, and the stamp's step comes before "Review pass 1 (high)". No stamp, an
// older or unreadable stamp or ledger, a step the list does not hold, or a slice outside the wave never counts (Slice 32 item D).
export function unreportedSlices(path, slices, stepsFile = STEPS_FILE, docsOnly = () => false) {
  try {
    if (docsOnly()) return []; // a Markdown-only branch skips both reviews (the gate does not apply to doc-only edits)
    const wave = lastWave(readFileSync(path, 'utf8'));
    if (!wave || wave.closed) return [];
    const opened = openedAt(wave.body);
    if (!opened) return [];
    const labels = stepLabels(stepsFile);
    const review = labels.indexOf(REVIEW_STEP);
    return slices.filter((n) => {
      if (!wave.slices.has(n) || review < 0) return false;
      const stamp = readStamp(stepReportPath(path, n));
      if (!stamp || stamp.at < opened.getTime()) return false;
      const at = labels.indexOf(stamp.label);
      return at >= 0 && at < review;
    });
  } catch { return []; }
}

function numbersIn(text) {
  const first = text.matchAll(SLICES).next().value;
  // Numbers compare without leading zeros: "Slice 020" in the ledger is "Slice 20" in a brief
  // (2026-11-01, print-the-damn-book: two claims were refused over the padding).
  return first ? new Set(first[1].match(/\d+/g).map(n => String(Number(n)))) : new Set();
}

// The brief names its slices on its first line, else at the first "Slice N" anywhere in it.
function slicesOf(prompt) {
  const onFirstLine = numbersIn(prompt.split(/\r?\n/)[0]);
  return [...(onFirstLine.size ? onFirstLine : numbersIn(prompt))];
}

export function ledgerPath(cwd) {
  const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const repo = basename(common) === '.git' ? dirname(common) : common;
  return join(dirname(repo), `${basename(repo)}-worktrees`, 'wave-ledger.md');
}

function findWave(lines) {
  let best = null;
  lines.forEach((line, i) => {
    const m = line.match(WAVE_HEADING);
    if (!m || (best && Number(m[1]) < best.number)) return;
    const status = m[2].match(WAVE_STATUS)?.[1].toLowerCase();
    best = { number: Number(m[1]), closed: status === 'closed', noStatus: !status, index: i };
  });
  return best;
}

export function lastWave(text) {
  const lines = text.split(/\r?\n/);
  const found = findWave(lines);
  if (!found) {
    if (lines.some(l => /^##\s+Wave\b/i.test(l))) throw new Error('wave-ledger.md has a "## Wave" heading without a number ("## Wave <n> (open|closed)")');
    return null;
  }
  const body = [];
  for (const line of lines.slice(found.index + 1)) {
    if (/^##\s/.test(line)) break;
    body.push(line);
  }
  const slices = new Set(body.map(l => l.match(LEDGER_SLICE)?.[1]).filter(Boolean).map(n => String(Number(n))));
  return { heading: lines[found.index], closed: found.closed, noStatus: found.noStatus, slices, cloudRunning: cloudRunningOf(body), earlyStage: earlyStageOf(body), body };
}

// Ledger times are read from `date -u` (SKILL.md), never guessed (Slice 23 item 4: three times were guessed ahead of the clock).
// A `HH:MMZ` time on the open wave's lines that is more than 5 minutes AFTER `now` (UTC) is not from the clock, but only when the
// wave's "Opened HH:MMZ YYYY-MM-DD" line says it was opened today (see openedToday).
// Only a time written as the stamp of a done event ("claimed 10:30Z", "merged at 10:30Z") is read; an ETA, "by", "until" or
// "next check" time is a real future time and is ignored (the gate denies only what it is certain of).
const LEDGER_TIME = /\b(?:claimed|dispatched|pushed|merged|built|opened|closed|started|finished|committed|shipped|done)(?:\s+at|\s*[:@(-])?\s*([01]\d|2[0-3]):([0-5]\d)Z\b/gi;
const FUTURE_AFTER_MIN = 5;
const OPENED_LINE = /\bOpened\s+([01]\d|2[0-3]):([0-5]\d)Z\s+(\d{4}-\d{2}-\d{2})\b/i;

const minutesOfDay = (hour, minute) => Number(hour) * 60 + Number(minute);

// The stamps are checked only when the open wave's own "Opened HH:MMZ YYYY-MM-DD" line names today's UTC date and a time not
// after now: then every stamp of the wave was written today, so one more than FUTURE_AFTER_MIN minutes after now is an error.
// A wave opened on another day, or with no readable Opened line, is never checked (Slice 23 check1 #4).
function openedToday(body, now) {
  const opened = (body ?? []).map((l) => l.match(OPENED_LINE)).find(Boolean);
  if (!opened || opened[3] !== now.toISOString().slice(0, 10)) return false;
  return minutesOfDay(opened[1], opened[2]) <= minutesOfDay(now.getUTCHours(), now.getUTCMinutes());
}

export function isFutureStamp(hour, minute, now = new Date()) {
  return minutesOfDay(hour, minute) - minutesOfDay(now.getUTCHours(), now.getUTCMinutes()) > FUTURE_AFTER_MIN;
}

export function futureLedgerTimes(body, now = new Date()) {
  const bad = [];
  if (!openedToday(body, now)) return bad;
  for (const line of body) {
    for (const m of line.matchAll(LEDGER_TIME)) {
      if (isFutureStamp(m[1], m[2], now)) bad.push(`${m[1]}:${m[2]}Z`);
    }
  }
  return bad;
}

function futureTimeReason(path) {
  const wave = lastWave(readFileSync(path, 'utf8'));
  if (!wave || wave.closed) return null;
  const bad = futureLedgerTimes(wave.body);
  return bad.length ? `the ledger holds ${[...new Set(bad)].join(', ')}, later than the clock now (${new Date().toISOString().slice(11, 16)}Z). Rewrite each time from \`date -u +%H:%MZ\` read in the same step, never an estimate.` : null;
}

function earlyStageOf(body) {
  const early = new Set();
  for (const line of body) {
    const n = line.match(LEDGER_SLICE)?.[1];
    const stage = line.match(STAGE_FIELD)?.[1];
    if (!n || !stage) continue;
    const key = String(Number(n));
    if (EARLY_STAGES.has(stage.toLowerCase())) early.add(key);
    else early.delete(key);
  }
  return early;
}

function cloudRunningOf(body) {
  const running = new Set();
  for (const line of body) {
    const n = line.match(LEDGER_SLICE)?.[1];
    if (n && CLOUD_RUNNING.test(line)) running.add(String(Number(n)));
  }
  return running;
}

// The Touches paths of slice <n>, read from docs/plan/slices/<NN>-*.md in the checkout the call ran in.
// Anything unreadable gives [] (no overlap is claimed from a guess).
function touchesOfSlice(cwd, n) {
  try {
    const root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dir = join(root, 'docs', 'plan', 'slices');
    const file = readdirSync(dir).find(f => /^\d+/.test(f) && String(Number(f.match(/^\d+/)[0])) === n && f.endsWith('.md'));
    const line = readFileSync(join(dir, file), 'utf8').match(TOUCHES_LINE)?.[1] ?? '';
    return [...line.matchAll(/`([^`]+)`/g)].map(m => m[1].trim().replace(/\\/g, '/'));
  } catch { return []; }
}

function normalizePath(p) {
  return p.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
}

// A path that can count as an overlap: a literal path inside the repo. Globs, Markdown (docs
// conflicts are merged by hand), absolute or outside-the-repo paths, "." and empty tokens never do.
function comparablePath(p) {
  const n = normalizePath(p);
  const segments = n.split('/');
  if (!n || /[*?[\]{}]/.test(n) || /\.md$/i.test(n)) return null;
  if (n.startsWith('/') || n.startsWith('~') || /^[a-z]:/i.test(n)) return null;
  if (segments.some(s => s === '' || s === '.' || s === '..')) return null;
  return n;
}

// Equal, or one is a directory holding the other.
function pathsOverlap(a, b) {
  const na = comparablePath(a);
  const nb = comparablePath(b);
  if (!na || !nb) return false;
  return na === nb || nb.startsWith(`${na}/`) || na.startsWith(`${nb}/`);
}

function overlapBetween(touchesA, touchesB) {
  for (const a of touchesA) for (const b of touchesB) if (pathsOverlap(a, b)) return `${a} / ${b}`;
  return null;
}

function cloudVerdict(wave, slices, cwd) {
  const running = [...wave.cloudRunning];
  for (const n of slices) {
    if (wave.cloudRunning.has(n)) {
      return `Slice ${n} is already running in a cloud session (the ledger says "cloud running"). `
        + 'Wait for its branch to be pushed and mark the ledger line "cloud: pushed" before claiming it again.';
    }
    const mine = touchesOfSlice(cwd, n);
    for (const other of running) {
      const clash = overlapBetween(mine, touchesOfSlice(cwd, other));
      if (clash) return `Slice ${n} touches the same files as Slice ${other}, which is running in a cloud session (${clash}). `
        + `Claim it after Slice ${other}'s code is pushed and its ledger line says "cloud: pushed".`;
    }
  }
  return null;
}

function verdict(wave, slices, cwd) {
  if (!wave) return null;
  if (wave.closed) {
    return `The last wave in the ledger is closed ("${wave.heading.trim()}"). If you ran it, compact first. `
      + `Then add "## Wave <n> (open)" listing up to ${MAX_SLICES} slices (one "- Slice N ..." line each), then claim.`;
  }
  if (wave.slices.size > MAX_SLICES) {
    return `The open wave lists ${wave.slices.size} slices; the limit is ${MAX_SLICES}. `
      + 'Close it (mark the heading "(closed)", write the ledger, compact) and put the rest in the next wave.';
  }
  const missing = slices.filter(n => !wave.slices.has(n));
  if (missing.length) {
    return `Slice ${missing.join(', ')} is not in the open wave. A wave takes no new slices once it started: `
      + 'list it in the next wave, and claim it after this one is closed and the session compacted.';
  }
  return cloudVerdict(wave, slices, cwd);
}

// A session runs a wave when its transcript shows the run-wave or run-all-waves skill loaded (the Skill tool call, the slash
// command, or the skill's "Base directory for this skill" text). The wave limits are for that coordinator only: a plain session asked
// to build one slice is not part of another session's wave (2026-11-25, ReadTheStupidText Slice 409 was refused because another
// session's Wave 74 was open). No transcript, or one that cannot be read, counts as a wave session, so a coordinator is never unguarded.
// Only real entries count (a Skill tool call, or a user turn's own text), never a tool's input or result that merely quotes them.
const WAVE_SKILL_NAME = /^(?:[\w-]+:)?run-(?:wave|all-waves)$/;
const WAVE_USER_TEXT = /^<command-name>\/?(?:[\w-]+:)?run-(?:wave|all-waves)<\/command-name>|^Base directory for this skill: .*run-(?:wave|all-waves)\s*$/m;
const OPENED_SESSION = /\bOpened\s+(?:[01]\d|2[0-3]):[0-5]\dZ\s+\d{4}-\d{2}-\d{2}\s+session\s+([\w-]+)/i;

// The session id written on the open wave's Opened line, or null.
function waveSessionId(wave) {
  return (wave?.body ?? []).map((l) => l.match(OPENED_SESSION)?.[1]).find(Boolean) ?? null;
}

export function runsWave(input, wave = null) {
  const owner = waveSessionId(wave);
  if (owner && input?.session_id === owner) return true;
  const file = input?.transcript_path;
  if (!file) return true;
  try {
    return transcriptsOf(file).some((f) => readFileSync(f, 'utf8').split(/\r?\n/).some(entryLoadsWave));
  } catch {
    return true;
  }
}

// A subagent's hook input names its own transcript (`<project>/<session>/subagents/agent-<id>.jsonl`), which never holds the
// coordinator's run-wave load: its parent session's `<project>/<session>.jsonl` is read too, so a ship-branch merge inside a
// wave stays bound by the batch rule.
export function transcriptsOf(file) {
  const dir = dirname(file);
  if (basename(dir) !== 'subagents') return [file];
  const sessionDir = dirname(dir);
  return [file, join(dirname(sessionDir), `${basename(sessionDir)}.jsonl`)];
}

function entryLoadsWave(line) {
  if (!line.includes('run-')) return false;
  let entry;
  try { entry = JSON.parse(line); } catch { return false; }
  const content = entry?.message?.content;
  if (entry?.type === 'assistant' && Array.isArray(content)) {
    return content.some(c => c?.type === 'tool_use' && c.name === 'Skill' && WAVE_SKILL_NAME.test(String(c.input?.skill ?? '')));
  }
  if (entry?.type !== 'user') return false;
  if (typeof content === 'string') return WAVE_USER_TEXT.test(content);
  return Array.isArray(content) && content.some(c => c?.type === 'text' && WAVE_USER_TEXT.test(String(c.text ?? '')));
}

function isStale(path) {
  return Date.now() - statSync(path).mtimeMs > STALE_MS;
}

function say(output) {
  process.stdout.write(JSON.stringify(output));
}

function deny(reason) {
  say({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `run-wave gate: ${reason}` } });
}

function notice(text) {
  say({ systemMessage: 'run-wave gate: ' + text });
}

function warn(err) {
  process.stderr.write(`wave-gate: ${err.message}\n`);
  say({ systemMessage: `run-wave gate failed (${err.message}); this call was NOT checked against the wave ledger.` });
}

// Importing this file (brief-plan-guard.mjs reads the ledger with lastWave) must not run the hook.
// When realpath fails (a broken junction mid-install) the hook must not switch off silently: compare the plain
// resolved paths, and if still unsure treat a run whose script is named wave-gate.mjs as the entry point.
// An import from a test or brief-plan-guard never has that basename.
export function isEntryPoint(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  if (!argvPath) return false;
  const self = fileURLToPath(moduleUrl);
  try { return realpathSync.native(argvPath) === realpathSync.native(self); } catch {
    return resolve(argvPath) === resolve(self) || basename(argvPath) === 'wave-gate.mjs';
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) try {
  const input = readInput();
  const claim = claimOf(input);
  const ship = shipOf(input);
  if (ship) {
    const path = ledgerPath(input.cwd ?? process.cwd());
    if (existsSync(path) && !isStale(path)) {
      const future = futureTimeReason(path);
      if (future) { deny(future); process.exit(0); }
      const docsOnly = () => ship.worktree === null || branchIsDocsOnly(ship.worktree);
      // Unknown (no named worktree, empty diff, git failure) keeps the stage check: it is skipped only for a provably docs-only diff.
      const early = staleStageSlices(path, ship.slices, () => ship.worktree !== null && branchChangesOnlyDocs(ship.worktree));
      if (early.length) deny(`the ledger line of Slice ${early.join(', ')} still says "stage: claiming/building" at commit or merge. `
        + 'Update the ledger stage (review 1, review 2, ready) and send the board step reports for the review rounds, then call ship-branch again.');
      const unreported = unreportedSlices(path, ship.slices, undefined, docsOnly);
      if (unreported.length) deny(`the last board step report of Slice ${unreported.join(', ')} in this wave names a step before "${REVIEW_STEP}", so no review was reported. `
        + 'Send the step report for the stage it is in now (board.mjs report-progress ... --step-active "<label>"), then call ship-branch again.');
    }
  }
  const claimPath = claim ? ledgerPath(input.cwd ?? process.cwd()) : null;
  const claimWave = claimPath && existsSync(claimPath) && !isStale(claimPath) ? lastWave(readFileSync(claimPath, 'utf8')) : null;
  if (claim && !runsWave(input, claimWave)) {
    // Not the coordinator: the open wave is another session's, so only a real file clash with a cloud slice refuses the claim.
    const path = claimPath;
    if (existsSync(path) && !isStale(path)) {
      const wave = claimWave;
      const reason = wave && !wave.closed ? cloudVerdict(wave, claim.slices, input.cwd ?? process.cwd()) : null;
      if (reason) deny(reason);
    }
  } else if (claim) {
    const path = ledgerPath(input.cwd ?? process.cwd());
    if (existsSync(path) && !isStale(path)) {
      const future = futureTimeReason(path);
      if (future) { deny(future); process.exit(0); }
      const wave = lastWave(readFileSync(path, 'utf8'));
      const reason = verdict(wave, claim.slices, input.cwd ?? process.cwd());
      if (reason) deny(reason);
      else if (wave?.noStatus) notice('"' + wave.heading.trim() + '" has no "open" or "closed" token; treated as open.');
    }
  }
} catch (err) {
  // Fail open (a broken gate must not block every Agent call), but say so.
  warn(err);
}
