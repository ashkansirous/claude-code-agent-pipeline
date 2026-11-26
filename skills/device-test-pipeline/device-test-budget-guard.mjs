#!/usr/bin/env node
// PreToolUse hook on the Agent tool: refuses a device-test brief that gives the run more than 10 minutes
// (a time budget, a lock wait or a timeout over the cap). Every device, emulator or VM run stops at 10
// minutes (~/.claude/CLAUDE.md, implementation workflow step 6); what it didn't reach goes to the slice's
// "Not yet verified". The written rule did not hold: on 2026-11-01 (print-the-damn-book) three briefs gave
// 60, 45 and 40 minutes, the rule was sharpened in AgentPipeline #150, and a brief seven minutes after that
// merge still said "Budget 40 minutes" and "wait up to 20 min" (a long-running session keeps the rules it
// loaded at start). A duration counts when a budget word sits just before or after it.
// Two modes. subagent_type 'device-test': any over-cap duration with a budget word in the same clause is denied.
// Any other agent (a VM run briefed to `general-purpose`: "fix and test ... in the shared Hyper-V VM, within 60
// minutes total" passed the type-only check, print-the-damn-book 2026-11-01, feedback-loop entry I 2381): denied
// only when ONE SENTENCE holds both a device-run word (DEVICE_RUN below) and an over-cap duration with a budget
// word; there "within" and "total" also count as budget words. A CI wait or a build time in a brief that merely
// mentions the emulator is a different sentence and passes.
// Passes: other agents with no device run and a duration in one sentence, and durations of 10 minutes or less.
// An internal error lets the call through (fail open), with a note on stderr.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CAP_MINUTES = 10;
const DEVICE_AGENT = 'device-test';
const DEVICE_RUN =
  // A word joined by a hyphen ("emulator-build workflow") names something else, not a run.
  /Invoke-DesktopTest|Hyper-V|\bVMs?\b(?!-)|\b(?:emulators?|simulators?|phones?)\b(?!-)|\badb\b|wireless debugging|device run|tools[\\/](?:desktop-vm|emulator|phone)/i;
// Units read: h/hr/hours, m/min/minutes, s/sec/seconds, ms, and compound 1h30m. Spelled-out numbers
// ("twenty minutes") are not read: they stay out on purpose.
const DURATION =
  /(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*m(?:in(?:ute)?s?)?(?![a-z])|(\d+(?:\.\d+)?)\s*-?\s*(hours?|hrs?|h|minutes?|mins?|milliseconds?|ms|seconds?|secs?|m|s)(?![a-z])/gi;
// Only words that set a run limit; generic take/allow/within/limit/cap count only when they govern the run.
const BUDGET_WORD =
  /\b(budget|up to|at most|max(?:imum)?|(?:time )?limit|timeout|time-?box|wait|spend|allow(?:ed)? (?:the |a |each )?(?:run|test)s?|runs? (?:takes?|may take|can take))\b/i;
// Extra words for the any-agent mode, where a device word in the same sentence already says what is budgeted.
const BUDGET_WORD_IN_DEVICE_SENTENCE = /\b(within|total)\b/i;
const SENTENCE_BREAK = /(?<=[.!?])\s+|[\n;]/;
// In the any-agent mode a duration whose own clause is about CI, PR checks, a build or a polling interval is not a run limit.
const NOT_A_RUN_LIMIT = /\b(?:CI|PR checks?|builds?|poll(?:s|ed|ing)?|intervals?|every)\b/i;
const BEFORE = 40;
const AFTER = 20;
const CLAUSE_BREAK = /[;\n]|\.(?:\s|$)/;

function minutesOf(amount, unit) {
  const value = Number(amount);
  const u = unit.toLowerCase();
  if (u === 'ms' || u.startsWith('milli')) return value / 60000;
  if (u === 's' || u.startsWith('sec')) return value / 60;
  return u.startsWith('h') ? value * 60 : value;
}

function durationMinutes(m) {
  return m[1] !== undefined ? Number(m[1]) * 60 + Number(m[2]) : minutesOf(m[3], m[4]);
}

// The part of the sentence/clause around a match, cut at . ; and newline.
function clauseAround(text, start, end) {
  const lo = Math.max(0, start - BEFORE);
  const hi = end + AFTER;
  const beforeParts = text.slice(lo, start).split(CLAUSE_BREAK);
  const afterParts = text.slice(end, hi).split(CLAUSE_BREAK);
  return beforeParts[beforeParts.length - 1] + text.slice(start, end) + afterParts[0];
}

export function overCap(prompt, inDeviceSentence = false) {
  const text = String(prompt ?? '');
  const hits = [];
  for (const m of text.matchAll(DURATION)) {
    if (durationMinutes(m) <= CAP_MINUTES) continue;
    const clause = clauseAround(text, m.index, m.index + m[0].length);
    if (inDeviceSentence && NOT_A_RUN_LIMIT.test(clause)) continue;
    if (BUDGET_WORD.test(clause) || (inDeviceSentence && BUDGET_WORD_IN_DEVICE_SENTENCE.test(clause))) hits.push(m[0].trim());
  }
  return hits;
}

// Over-cap durations in sentences that also name a device run (the mode for agents other than device-test).
function overCapInDeviceSentences(prompt) {
  return String(prompt ?? '')
    .split(SENTENCE_BREAK)
    .filter((sentence) => DEVICE_RUN.test(sentence))
    .flatMap((sentence) => overCap(sentence, true));
}

function overCapHits(tool) {
  return tool.subagent_type === DEVICE_AGENT ? overCap(tool.prompt) : overCapInDeviceSentences(tool.prompt);
}

export function decide(input) {
  const tool = input?.tool_input ?? {};
  if (input?.tool_name !== 'Agent') return null;
  const hits = overCapHits(tool);
  if (!hits.length) return null;
  const reason =
    `This brief gives a device, emulator or VM run more than ${CAP_MINUTES} minutes (${hits.join(', ')}). The cap covers ` +
    'a device-test brief (any budget or wait over the cap) and any other agent whose brief puts a device word (VM, emulator, ' +
    'adb, phone) and an over-cap time limit in one sentence. Every device, ' +
    `emulator or VM run stops at ${CAP_MINUTES} minutes, lock waits included; what it doesn't reach goes to the ` +
    'slice\'s "Not yet verified" (a held lock is reported, not waited out). Rewrite the brief with at most ' +
    `${CAP_MINUTES} minutes. See ~/.claude/CLAUDE.md, implementation workflow step 6.`;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo (see entry-points.test.mjs).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch (error) {
    process.stderr.write(`device-test-budget-guard: realpath failed (${error.message}); comparing plain paths\n`);
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`device-test-budget-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
