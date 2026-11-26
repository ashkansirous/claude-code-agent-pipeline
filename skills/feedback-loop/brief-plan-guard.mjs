#!/usr/bin/env node
// PreToolUse hook on Agent: a brief that names a planned slice ("Slice 350", "Slices 351-352", "Slices 351, 352
// and 353") must point the agent at that slice's own file (`docs/plan/slices/350-...`), so the agent reads and
// follows the plan's lines instead of the coordinator's retelling. The rule is in ~/.claude/CLAUDE.md, Delegate to
// model-pinned subagents ("Briefs for planned work come from the plan, never from memory"); the incident behind it
// is a brief written from memory that dropped lines of the plan.
// Only agents that do the planned work are checked; mechanical agents (ship-branch, reviewers, run-checks, ...)
// get slice numbers as labels and pass. A brief that names a slice only as background lists it in
// `plan-not-needed: 350, 351`; only the slices listed there are exempt.
// An internal error lets the call through (fail open), with a note on stderr.
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastWave, ledgerPath } from '../run-wave/wave-gate.mjs';

// "Slice"/"Slices" with a capital S (how briefs name plan slices), so prose like "slice 2 of the array" passes.
// A list item stops before a date ("2026-11-12"). "Slices 351 and 5 pages" still reads 5 as a slice: a count
// and a slice number look the same, so such a brief lists it as plan-not-needed: 5.
// "Slice #350" is read too. Only the plural "Slices" introduces a list ("Slices 350, 351", "350 and 351", "350 & 351",
// "350; 351"); a singular "Slice N" is one slice, so "Slice 354, 100 files" and "Slice 354 & 355 other PRs" name only 354.
const ITEM = String.raw`#?\d{1,4}[a-z]?(?!\d|-\d{1,2}-)`;
const SEP = String.raw`\s*(?:,|;|&|and|or|to|-|–)\s*`;
const SINGLE = new RegExp(String.raw`\bSlice\s+(${ITEM}(?:\s*(?:to|-|–)\s*${ITEM})?)`, 'g');
const PLURAL = new RegExp(String.raw`\bSlices\s+(${ITEM}(?:${SEP}${ITEM})*)`, 'g');
const LIST_SEP = /\s*(?:,|;|&|and|or)\s*/i;
const RANGE = /^(\d{1,4})[a-z]?\s*(?:-|–|to)\s*(\d{1,4})[a-z]?$/i;
const OPT_OUT = /\bplan-not-needed:[ \t]*([\d, \t]+)/i;
const MAX_RANGE = 100;
const MECHANICAL_AGENTS = new Set([
  'ship-branch', 'run-checks', 'ci-status', 'parallel-check', 'resolve-merge-conflicts',
  'code-review-pass', 'code-review-high', 'code-review-medium', 'code-review-in-detail', 'security-review', 'session-audit',
  'web-research', 'web-fetch', 'library-docs',
  'claude-code-guide', 'statusline-setup',
]);

function expandPart(part) {
  const range = part.match(RANGE);
  if (!range) return [Number.parseInt(part, 10)];
  const [from, to] = [Number(range[1]), Number(range[2])];
  if (to < from || to - from > MAX_RANGE) return [from, to];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

export function sliceNumbers(prompt) {
  const numbers = new Set();
  for (const match of prompt.matchAll(SINGLE)) expandPart(match[1].replace(/#/g, '').trim()).forEach((n) => numbers.add(n));
  for (const match of prompt.matchAll(PLURAL)) {
    for (const part of match[1].replace(/#/g, '').split(LIST_SEP).filter(Boolean)) expandPart(part.trim()).forEach((n) => numbers.add(n));
  }
  return [...numbers].filter((n) => Number.isFinite(n));
}

export function exempted(prompt) {
  const match = prompt.match(OPT_OUT);
  return new Set(match ? (match[1].match(/\d{1,4}/g) ?? []).map(Number) : []);
}

export function pointsAtFile(prompt, number) {
  return new RegExp(`slices[\\\\/]0*${number}[a-z]?(?:-|\\b)`, 'i').test(prompt);
}

// "<repo> Slice 13" names another repo's slice (agent-progress-board Slice 13): its file is not in this repo, so the
// guard cannot ask for it. <repo> is a hyphenated, dotted or CamelCase name, or owner/repo, and not this repo's own name;
// a bare "Slice 13" and "the Slice 13" are still checked. (Slice 17 part C; night 2026-11-17-1216 denied two such briefs.)
const REPO_NAME = String.raw`(?<![\w./-])([A-Za-z0-9][\w.]*(?:-[\w.]+)+|[\w.-]+\/[\w.-]+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)(?:'s)?`;
const FOREIGN = [
  new RegExp(String.raw`${REPO_NAME}\s+Slice\s+${ITEM}(?:\s*(?:to|-|–)\s*${ITEM})?`, 'g'),
  new RegExp(String.raw`${REPO_NAME}\s+Slices\s+${ITEM}(?:${SEP}${ITEM})*`, 'g'),
];

// Sibling repos the briefs name, and ordinary hyphenated words that look like a repo name ("follow-up Slice 13") and are not one.
const KNOWN_REPOS = new Set(['agent-progress-board', 'example-app', 'print-the-damn-book', 'readthestupidtext', 'dino', 'agentpipeline']);
const PLAIN_COMPOUNDS = /^(?:end-to-end|up-to-date|follow-up|read-only|built-in|one-off|state-of-the-art)$/i;

// owner/repo, a known repo, or a hyphenated name of three or more parts / CamelCase of three or more words that is not a plain compound.
export function looksLikeRepoName(name) {
  if (name.includes('/')) return true;
  const lower = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if ([...KNOWN_REPOS].some((known) => known.replace(/-/g, '') === lower)) return true;
  if (name.includes('-')) return name.split('-').length >= 3 && !PLAIN_COMPOUNDS.test(name);
  return (name.match(/[A-Z]/g) ?? []).length >= 3;
}

export function withoutForeignRepoSlices(prompt, ownNames = new Set()) {
  const isOwn = (name) => ownNames.has(name.split('/').pop().toLowerCase());
  return FOREIGN.reduce((text, pattern) => text.replace(pattern, (whole, name) => (looksLikeRepoName(name) && !isOwn(name) ? '' : whole)), prompt);
}

// A sample title quoted in a brief ("Slice 3D viewer", "Slice 12") is text, not planned work: a double-quoted or backticked
// string that opens right at "Slice" is dropped before the numbers are read (night 2026-11-17-1216: four briefs denied).
// The quote must open the string (start, space or bracket before it, so a closing quote never starts a match), and a backticked
// bare `Slice 13` is a real reference, kept.
const QUOTED_TITLE = /(?<![^\s(\[])(?!`\s*Slices?\s+\d+\s*`)(["\u201c`])\s*Slices?\s[^"\u201d`\n]*["\u201d`]/g;

export function withoutQuotedTitles(prompt) {
  return prompt.replace(QUOTED_TITLE, '');
}

// context: slice numbers that are the wave's own siblings (an open wave in the ledger; Slice 21). A ledger slice is exempt
// only when the brief also names another slice and points at that slice's own file (the briefed slice may itself be in the
// open ledger and is being built, so it needs its file). parked: slice numbers parked in plan.md; they are never built from
// this brief, so they are exempt even when the brief names no slice file (Slice 35, 406 item 24; wave decision in the slice file).
export function missingFiles(prompt, ownNames = new Set(), context = new Set(), parked = new Set()) {
  const skip = exempted(prompt);
  const named = sliceNumbers(withoutForeignRepoSlices(withoutQuotedTitles(prompt), ownNames));
  const hasOwnFile = named.some((n) => !skip.has(n) && pointsAtFile(prompt, n));
  return named.filter((n) => !skip.has(n) && !pointsAtFile(prompt, n) && !parked.has(n) && !(hasOwnFile && context.has(n)));
}

function primaryCheckout(cwd) {
  const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return basename(common) === '.git' ? dirname(common) : common;
}

// The ledger rows' slice numbers of the highest wave when it is open (wave-gate.mjs's parser). Any problem gives an empty
// set (fail open to the old, stricter behaviour).
export function contextSlices(cwd) {
  const numbers = new Set();
  try {
    const wave = lastWave(readFileSync(ledgerPath(cwd), 'utf8'));
    if (wave && !wave.closed) wave.slices.forEach((n) => numbers.add(Number(n)));
  } catch { /* no ledger here */ }
  return numbers;
}

// plan.md rows of origin/main whose status starts with "parked"; same fail-open rule.
export function parkedSlices(cwd) {
  const numbers = new Set();
  try {
    const plan = execFileSync('git', ['-C', primaryCheckout(cwd), 'show', 'origin/main:plan.md'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    for (const m of plan.matchAll(/^\|\s*(\d{1,4})[a-z]?\s*\|[^\n]*\|\s*parked\b/gim)) numbers.add(Number(m[1]));
  } catch { /* no plan on origin/main here */ }
  return numbers;
}

// This repo's lower-case names for a cwd: the folder, the repo folder a `<repo>-worktrees/<slug>` worktree belongs to.
export function ownRepoNames(cwd) {
  const names = new Set();
  const parts = String(cwd ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  const last = parts.at(-1);
  if (last) names.add(last.toLowerCase());
  const parent = parts.at(-2);
  if (parent && /-worktrees$/i.test(parent)) names.add(parent.replace(/-worktrees$/i, '').toLowerCase());
  return names;
}

function listSliceFiles(cwd) {
  try {
    return readdirSync(join(cwd, 'docs', 'plan', 'slices'));
  } catch {
    return [];
  }
}

// The file is read from the cwd's docs/plan/slices; when none is found there (the cwd may be another repo), the hint says
// so and names the folder to look in, never a made-up file name.
export function hint(number, files) {
  const file = files.find((name) => new RegExp(`^0*${number}[a-z]?-`).test(name));
  return file ? `Slice ${number} (docs/plan/slices/${file})` : `Slice ${number} (file not found from this session's folder: look for docs/plan/slices/${number}-*.md in the repo the slice belongs to)`;
}

export function decide(input, list = listSliceFiles, context = contextSlices, parked = parkedSlices) {
  if (input?.tool_name !== 'Agent') return null;
  if (MECHANICAL_AGENTS.has(String(input?.tool_input?.subagent_type ?? ''))) return null;
  const cwd = input?.cwd ?? process.cwd();
  const prompt = String(input?.tool_input?.prompt ?? '');
  // The ledger and plan.md are read only when a named slice lacks its file (a git call and two reads per Agent call otherwise).
  const own = ownRepoNames(cwd);
  if (missingFiles(prompt, own).length === 0) return null;
  const missing = missingFiles(prompt, own, context(cwd), parked(cwd));
  if (missing.length === 0) return null;
  const files = list(input?.cwd ?? process.cwd());
  const reason =
    'This brief names a planned slice but does not point the agent at its file. Briefs for planned work come from ' +
    'the plan, never from memory (~/.claude/CLAUDE.md, Delegate to model-pinned subagents). Add the slice file and ' +
    'tell the agent to follow every line of the section it works on: ' + missing.map((n) => hint(n, files)).join(', ') +
    '. If a slice is only a label here, list it as plan-not-needed: <numbers>.';
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo (see entry-points.test.mjs).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch (error) {
    process.stderr.write(`brief-plan-guard: realpath failed (${error.message}); comparing plain paths\n`);
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`brief-plan-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
