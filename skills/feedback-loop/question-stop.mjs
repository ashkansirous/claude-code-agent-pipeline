#!/usr/bin/env node
// Stop hook: when the turn's last assistant message ends with a question, or its last paragraph
// makes an offer, block the stop once so
// the model checks whether it is truly the user's decision; otherwise it does the work.
// Input (stdin JSON): stop_hook_active, last_assistant_message, transcript_path.
// Output to block: {"decision":"block","reason":...}. stop_hook_active true means we already
// blocked this turn, so it passes (never loops). Any error lets the stop through.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dueForSession } from './mirror-due.mjs';

// The "Mirror due" check needs the mirror-to-drive agent to act on it; without that agent installed it is skipped.
export function mirrorAgentInstalled(env = process.env) {
  return existsSync(join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'agents', 'mirror-to-drive.md'));
}

export function dueWhenMirrorInstalled(input, env = process.env) {
  return mirrorAgentInstalled(env) ? dueForSession(input) : [];
}

const QUESTION_END = /[?\uFF1F\u061F\u2E2E\u203D]$/;
const TRAILING_NOISE = /[\s*_'")\]>~-]+$/;
const TRAILING_CODE_BLOCK = /```[\s\S]*?```\s*$/;
const TRAILING_CODE_SPAN = /`[^`\n]*`\s*$/;
const TRAILING_URL = /(?:https?|file):\/\/\S*$/;
// The user sees this text too and asked what it is (2026-11-18): it opens by saying who it is for.
const REASON = 'Note to Claude from the question-stop hook (nothing for the user to do): your last message ends with a question or an offer ("if you want, I can...", "say X and I\'ll..."). If it is truly the user\'s (their decision, a guide step\'s "did it work?", an outward action not authorised), end the turn with the question itself restated in one or two plain sentences as the last paragraph, saying what it blocks (for example "Waiting for your answer: keep "Row C" or change it to "their seats"? Page 11\'s audio waits on it."), never a bare "Waiting for your answer.". Otherwise do the work instead of asking.';

// Drop trailing code, URLs and markdown so only the final sentence of prose is tested.
export function proseTail(text) {
  let current = text;
  for (;;) {
    const next = current.replace(TRAILING_NOISE, '').replace(TRAILING_CODE_BLOCK, '').replace(TRAILING_CODE_SPAN, '').replace(TRAILING_URL, '');
    if (next === current) return current;
    current = next;
  }
}

export function endsWithQuestion(text) {
  return typeof text === 'string' && QUESTION_END.test(proseTail(text));
}

// An offer phrased as a statement ends with a full stop, so QUESTION_END misses it (2026-11-01,
// print-the-damn-book: "If you want, I can make the hook..." and "Say 'resume checks' and I'll
// start it again." both ended turns). The broad OFFER pattern is tested on the last paragraph only;
// STRONG_OFFER, which ordinary prose rarely matches, on every paragraph, because the "If you want,
// I can make the hook..." offer sat above a status paragraph and slipped through (2026-11-01 final
// loop). A false block costs one extra turn (the hook blocks once).
// Apostrophes may be straight or curly (’). "shall I" / "should I" are left to QUESTION_END:
// as statements they are mostly ordinary prose.
const OFFER = /\b(?:if you(?:['’]d)? (?:want|like|prefer)|say ["'“‘][^"”\n]{1,40}["'”’] and I(?:['’]ll| will)|want me to|let me know if you(?:['’]d)? (?:want|like))\b/i;
const STRONG_OFFER = /\b(?:if you(?:['’]d)? (?:want|like|prefer)(?: it| that| me to)?,? I(?:['’]ll| can| could| will)\b|say ["'“‘][^"”\n]{1,40}["'”’] and I(?:['’]ll| will)\b|want me to\b|let me know if you(?:['’]d)? (?:want|like) me to\b)/i;

function paragraphs(text) {
  return proseTail(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

const lastOf = (parts) => (parts.length ? parts[parts.length - 1] : '');

export function lastParagraph(text) {
  return lastOf(paragraphs(text));
}

// A double-quoted span that STARTS with an offer phrase is a quotation, not an offer: an answer explaining this
// hook quoted ("if you want, I can...", "say X and I'll...") and was blocked (2026-11-18, ReadTheStupidText night
// 2026-11-17-2105, entry 2025). Anchored at the span's start, so a stray quote (an inch mark) pairing with a later
// one never hides a real offer, and the short quoted X of a real `say "X" and I'll` stays. Stripped from the whole
// text before proseTail, which would otherwise drop a closing quote at the very end first.
// Spans are found one opener at a time (item 23): a stray quote that opens no offer span only moves the scan one character
// on, so its would-be closer can open the next span instead of being eaten by the stray pair. Single quotes (straight or
// curly) count too; a straight ' is an opener only after a non-word character and a closer only before one (apostrophes stay).
const QUOTE_CLOSERS = { '"': '"”', '“': '”"', '‘': '’' };
const MAX_QUOTED = 200;
function closerIndex(text, open, from) {
  const limit = Math.min(text.length, from + MAX_QUOTED + 1);
  for (let j = from; j < limit; j++) {
    if (text[j] === '\n') return -1;
    const apostropheCloser = (open === "'" && text[j] === "'") || (open === '‘' && text[j] === '’');
    const isCloser = apostropheCloser ? !/\w/.test(text[j + 1] ?? '') : open !== "'" && QUOTE_CLOSERS[open].includes(text[j]);
    if (isCloser && j > from) return j;
  }
  return -1;
}
const isOpener = (text, i) => (text[i] === "'" ? !/\w/.test(text[i - 1] ?? '') : text[i] in QUOTE_CLOSERS);
const closerLooksLikeOpener = (text, j) => /\s/.test(text[j - 1] ?? ' ') && !/\s/.test(text[j + 1] ?? ' ');
const OFFER_START =/^\s*(?:if you(?:['’]d)? (?:want|like|prefer)\b|say\b[^\n]{1,40}\band I(?:['’]ll| will)\b|want me to\b|let me know if you(?:['’]d)? (?:want|like)\b)/i;

export function withoutQuotedOffers(text) {
  // A placeholder, not '', so a paragraph that was only a quotation stays a paragraph and the last one stays last.
  let out = '';
  let i = 0;
  while (i < text.length) {
    const close = isOpener(text, i) ? closerIndex(text, text[i], i + 1) : -1;
    if (close !== -1 && OFFER_START.test(text.slice(i + 1, close))) { out += '(quoted)'; i = close + 1; continue; }
    // A non-offer pair is copied through when its closer looks like a closer (`"go" if`), so that closer does not open a span
    // that hides a real offer; a closer that looks like an opener (space before, text after: the `5" screen ... "if you want` case)
    // is left to open the next span.
    if (close !== -1 && !closerLooksLikeOpener(text, close)) { out += text.slice(i, close + 1); i = close + 1; continue; }
    out += text[i++];
  }
  return out;
}

export function endsWithOffer(text) {
  if (typeof text !== 'string') return false;
  const parts = paragraphs(withoutQuotedOffers(text));
  const last = lastOf(parts);
  return OFFER.test(last) || parts.some((p) => STRONG_OFFER.test(p));
}

// A turn that ends offering a read-only check ("I can rerun that", "I haven't run that yet") hands in-scope, reversible
// work back to the user (~/.claude/CLAUDE.md, Feedback loop; session 2a8525d6 ended on "I can rerun that calculation ... if
// useful"). Only an offer ("I can rerun that ... if useful / if you want") is flagged. A statement that something was not
// run is not, and neither is an offer paragraph that gives a reason the session cannot run it (needs the phone, the
// user's login, a device): the global rule asks for exactly that report. Last paragraph only; a false block costs a turn.
const CHECK_OFFER = /\bI can (?:re-?run|re-?check|run|check|verify|test) (?:that|this|it|the)\b[^\n]*\bif (?:useful|helpful|needed|you(?:['\u2019]d)? (?:want|like|prefer)|wanted)\b/i;
const CANNOT_RUN_REASON = /\b(?:because|needs?|requires?|by design|cannot|can['\u2019]t|unable|not possible|only the user|your (?:login|phone|device)|the (?:phone|device|emulator|test phone|Mac))\b/i;
const CHECK_REASON = 'Your last message ends by offering a check you could run now ("I can rerun that ... if useful"). A read-only, reversible check inside the task is yours to run: run it now and report its result instead of offering it.';
export function endsWithCheckOffer(text) {
  if (typeof text !== 'string') return false;
  const last = lastParagraph(text);
  return CHECK_OFFER.test(last) && !CANNOT_RUN_REASON.test(last);
}

// A promised fix names its slice (~/.claude/CLAUDE.md, Own mistakes plainly; Slice 22): "will be fixed" / "the fix isn't built
// yet" with no "Slice N" anywhere in the message is flagged. Narrow on purpose: a missed promise only loses one catch.
// Only a fix pointed at later work counts: a bare "will be fixed" (a typo fixed by the PR just opened) is not a promise.
const FIX_PROMISE = /\b(?:will be fixed (?:later|tomorrow|next|in (?:a|the) (?:later|next|follow-up|future|separate) (?:slice|PR|wave))|(?:a|the) (?:later|next|follow-up|future) slice will fix|(?:the|a) fix (?:is not|isn['’]t|has not been|hasn['’]t been) (?:built|written|planned)(?: yet)?|I(?:['’]ll| will) fix (?:this|that|it) (?:later|next|tomorrow|in (?:a|the) (?:later|next|follow-up|future|separate)))\b/i;
// Known limit: any "Slice N" in the message satisfies this, even one that is not the slice of the promised fix.
const SLICE_NAMED = /\bSlices?\s+\d+|\bS\d{2,}\b(?!\s+(?:phone|device|ultra|emulator))/i;
const FIX_REASON = 'Your last message promises a fix ("will be fixed", "the fix isn\'t built yet") without naming the slice. Name the repo, slice number, title and the plan row\'s state, read from origin/main in this turn (git show origin/main:plan.md), or say plainly that no slice exists yet and write one first.';
export function promisesFixWithoutSlice(text) {
  return typeof text === 'string' && FIX_PROMISE.test(text) && !SLICE_NAMED.test(text);
}

// --- Slice 29 items 7, 27, 33, 44, 49, 50: phrases a final turn must not carry. Each is blocked once (stop_hook_active
// lets the second stop through); a false block costs one turn. Quoted spans and fenced code are dropped first, so a turn
// that explains a phrase does not trip it.
const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
const QUOTED_OR_SPAN = /"[^"\n]{0,200}"|“[^”\n]{0,200}”|`[^`\n]*`/g;
function bareProse(text) {
  return text.replace(FENCED_CODE, ' ').replace(QUOTED_OR_SPAN, ' ');
}

export const REVIEW_WAIT = /\bwait(?:s|ing)? for (?:your|the owner['’]s|the user['’]s) review\b|\buntil you['’]ve reviewed\b|\bwait for your review\b/i;
export function holdsForReview(text) {
  return typeof text === 'string' && REVIEW_WAIT.test(bareProse(text));
}

// A placeholder where a real value or link belongs: `<board address>/#/setup` (a hash route), `https://<host>/x`,
// `AGENT_BOARD_URL=<...>`. A path such as `<worktree>/reviews/x.md` is not a link, and inline code is dropped first.
// Known limit: "a site home page as the only link" (item 33) needs the real value from memory or the secrets store and is not checked here.
const PLACEHOLDER_LINK = /https?:\/\/<[A-Za-z][^<>\n]{1,40}>|\]\(<[A-Za-z][^<>\n]{1,40}>[^)\n]*\)|\b[A-Z][A-Z0-9_]{3,}=<[^<>\n]{1,60}>/;
export function hasPlaceholderLink(text) {
  return typeof text === 'string' && PLACEHOLDER_LINK.test(text.replace(FENCED_CODE, ' ').replace(INLINE_CODE, ' '));
}

// "I haven't checked" is allowed when the same sentence says why it cannot be checked (the global rule asks for that).
const UNCHECKED = /\bI haven['’]t (?:checked|confirmed)\b|\bhaven['’]t (?:checked|confirmed) (?:it|that|this|yet)\b/i;
const CANNOT_CHECK_REASON = /\b(?:because|only you|no tool|cannot be checked|can['’]t be checked|no way to|not reachable|can['’]t reach)\b/i;
export function admitsUnchecked(text) {
  if (typeof text !== 'string') return false;
  // The reason may sit anywhere in the same paragraph, not only in the sentence that says "haven't checked".
  return bareProse(text).split(/\n\s*\n/).some((p) => UNCHECKED.test(p) && !CANNOT_CHECK_REASON.test(p));
}

// A confident cause for a failed worktree removal with no holder named (starter entries 1575, 1610, 3094).
const HOLDER_CLAIM = /\ba process (?:is )?still holds? it\b|\bmy shell was still (?:inside|in) (?:it|the (?:folder|worktree))\b|\bsomething (?:is )?still holds? (?:it|the (?:folder|worktree))\b/i;
const HOLDER_NAMED = /\bpid\s*\d+|\breleased-check\b|\bholder: \S+/i;
export function claimsUnnamedHolder(text) {
  return typeof text === 'string' && HOLDER_CLAIM.test(bareProse(text)) && !HOLDER_NAMED.test(text);
}

const OVERRULE = /\b(?:you|the owner) can overrule\b|\boverrule me\b|\bcan be overruled\b/i;
export function offersOverrule(text) {
  return typeof text === 'string' && OVERRULE.test(bareProse(text));
}

// "why ..." gets its cause in the first line (~/.claude/CLAUDE.md, Own mistakes plainly; item 50).
// Decided scope (item 50): fires only when the user's last real message asks why the assistant acted ("why did you", "why didn't you",
// "why did not you", "why are you", "why were you", "why do you", "why have you", "why would you", or "Claude" for "you");
// "why did the build fail" never fires. The check is skipped once the turn made tool calls after the question
// (that is task work, not an answer to the question).
const WHY_ASKED = /\bwhy (?:did|didn['’]t|did not|are|were|do|have|would) (?:you|claude)\b/i;
const CAUSE_PHRASE = /\bI made a mistake\b|\bI didn['’]t (?:check|think|read|run|look|notice|realize|realise|know|see|test)\b|\bbecause\b|\bsince\b|\bdue to\b|\bcaused by\b|\b(?:the )?(?:cause|reason) (?:is|was)\b|\bI (?:forgot|missed|assumed|skipped|misread|chose|used|did not)\b/i;
export function whyWithoutCause(userText, text, toolCalls = false) {
  if (toolCalls || typeof userText !== 'string' || typeof text !== 'string') return false;
  if (!WHY_ASKED.test(userText)) return false;
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return !CAUSE_PHRASE.test(first);
}

// A click path ("/plugin -> agent-board -> Configure options") that ends the final reply right after a denied call: report the
// rule that would allow it (item 7). Last paragraph only, and only a UI-like path or one of three hops, so a flow
// ("main -> branch -> PR") elsewhere in the message passes.
const CLICK_PATH_END = /(?:[^\s>→-][^\n>→]{0,40}?\s*(?:->|→)\s*){2,}[^\s>→-][^\n>→]{0,40}$/;
const UI_TOKEN = /\b(?:Settings|Click|Configure|Options|Preferences|Toggle|Enable|Select)\b|\/plugin\b/;
export function clickPathAfterDenial(text, denied) {
  if (denied !== true || typeof text !== 'string') return false;
  const last = lastParagraph(text.replace(FENCED_CODE, ' ')).replace(/[.\s]+$/, '');
  const match = CLICK_PATH_END.exec(last);
  if (!match) return false;
  return (match[0].match(/->|→/g) ?? []).length >= 3 || UI_TOKEN.test(match[0]);
}

const TAIL_BYTES = 400000;
// A real permission or auto-mode denial as the harness words it, case-sensitive, and only inside an error tool result.
const DENIAL = /Permission to use [^\n]{0,60} has been denied|\bwas denied by (?:the )?(?:auto mode|permission)|\b(?:denied|blocked) by (?:the )?(?:auto mode|permission)/;
function userTextOf(entry) {
  const content = entry?.message?.content;
  if (entry?.type !== 'user' || entry.isMeta === true) return null;
  const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text) : [];
  // System reminders and interrupt notes are not the user's own message.
  const real = texts.filter((t) => typeof t === 'string' && !/^\s*(?:<system-reminder>|<command-name>|<command-message>|<local-command-stdout>|<task-notification>|\[Request interrupted)/.test(t));
  return real.length ? real.join('\n') : null;
}
// Text of the error tool results only: a denial is a failed call, not any result that mentions the word.
function errorResultTextOf(entry) {
  const content = entry?.message?.content;
  if (entry?.type !== 'user' || !Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'tool_result' && b.is_error === true).map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''))).join('\n');
}
// A later tool call that succeeded means the denial was resolved.
function hasSuccessfulResult(entry) {
  const content = entry?.message?.content;
  return entry?.type === 'user' && Array.isArray(content) && content.some((b) => b?.type === 'tool_result' && b.is_error !== true);
}
function hasToolCall(entry) {
  const content = entry?.message?.content;
  return entry?.type === 'assistant' && Array.isArray(content) && content.some((b) => b?.type === 'tool_use');
}

// Only the last TAIL_BYTES bytes of the transcript are read, never the whole file (it can be hundreds of MB).
function readTailLines(path, tailBytes = TAIL_BYTES) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    // A cut tail starts mid-line, so its first (partial) line is dropped; a short file is read whole.
    return buffer.toString('utf8').split('\n').slice(size > tailBytes ? 1 : 0).filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

// The turn's Edit/Write paths, Bash commands and assistant prose, for the warn-only checks below.
function collectTurnFacts(entry, facts) {
  if (entry?.type !== 'assistant' || !Array.isArray(entry.message?.content)) return;
  for (const block of entry.message.content) {
    if (block?.type === 'text' && typeof block.text === 'string') facts.assistantText += `\n${block.text}`;
    if (block?.type !== 'tool_use') continue;
    const input = block.input ?? {};
    if ((block.name === 'Edit' || block.name === 'Write') && typeof input.file_path === 'string') facts.editedPaths.push(input.file_path);
    if (block.name === 'Bash' && typeof input.command === 'string') facts.commands.push(input.command);
  }
}

// Last real user message, whether a tool call was denied after it, and whether the turn made tool calls after it, from
// the transcript's tail. Fails open to nothing.
export function transcriptFacts(path) {
  const facts = { lastUserText: '', denied: false, toolCalls: false, editedPaths: [], commands: [], assistantText: '' };
  try {
    for (const line of readTailLines(path)) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const user = userTextOf(entry);
      if (user !== null) { Object.assign(facts, { lastUserText: user, denied: false, toolCalls: false, editedPaths: [], commands: [], assistantText: '' }); continue; }
      if (hasToolCall(entry)) facts.toolCalls = true;
      collectTurnFacts(entry, facts);
      if (DENIAL.test(errorResultTextOf(entry))) facts.denied = true;
      else if (hasSuccessfulResult(entry)) facts.denied = false;
    }
  } catch { /* fail open */ }
  return facts;
}

// A promised later check at a time or interval needs a timer behind it (~/.claude/CLAUDE.md, Background agents get a 10-minute
// check; 2026-11-25 ReadTheStupidText: "next check at 03:17 UTC" with no timer, 5.5 h without news). Matched in prose
// only (quoted spans and code dropped). A timer is a background Bash `sleep` with no later completed task-notification,
// or a ScheduleWakeup call after the last user message.
const CHECK_PROMISE = /\b(?:next check (?:(?:at|around) \S|in (?:\d|an? |a few|about |roughly |~))|I(?:['’]ll| will) (?:check|look) (?:again|back) (?:at|in|around)\b|check(?:ing)? back (?:at|in|around)\b)/i;
// A timer can be started long before the last 400 KB of the transcript, so the timer check reads a wider tail.
const TIMER_TAIL_BYTES = 8000000;
export function promisesTimedCheck(text) {
  return typeof text === 'string' && CHECK_PROMISE.test(bareProse(text));
}

const SLEEP_COMMAND = /(?:^|[\s;&|(])sleep\s+\d/;
const TASK_ID = /\b(?:ID|id)[: ]+([A-Za-z0-9_-]{4,})/;
function blocksOf(entry) {
  return Array.isArray(entry?.message?.content) ? entry.message.content : [];
}
function textOfResult(block) {
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
}
function markCompleted(text, running) {
  if (!text.includes('<task-notification>')) return;
  const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text)?.[1];
  if (id && /<status>\s*(?:completed|failed|killed|cancelled|stopped)/i.test(text)) running.delete(id);
}

// entries: parsed transcript lines in order. Pure, so the tests feed it directly.
export function timerRunningIn(entries) {
  const sleepCalls = new Set(); // tool_use ids of background sleeps
  const running = new Set(); // task ids of background sleeps not yet completed
  let wakeupAfterUser = false;
  for (const entry of entries) {
    if (userTextOf(entry) !== null) wakeupAfterUser = false;
    for (const block of blocksOf(entry)) {
      if (block?.type === 'tool_use' && block.name === 'ScheduleWakeup') wakeupAfterUser = true;
      if (block?.type === 'tool_use' && block.name === 'Bash' && block.input?.run_in_background === true && SLEEP_COMMAND.test(String(block.input.command ?? ''))) sleepCalls.add(block.id);
      if (block?.type === 'tool_result' && sleepCalls.has(block.tool_use_id)) {
        const id = TASK_ID.exec(textOfResult(block))?.[1];
        if (id) running.add(id);
      }
    }
    // The notice may sit in a user, queue or attachment entry; the raw line is searched, JSON escapes undone.
    if (entry) markCompleted(JSON.stringify(entry).replace(/\\"/g, '"').replace(/\\\//g, '/'), running);
  }
  return wakeupAfterUser || running.size > 0;
}

function readTranscriptEntries(path) {
  const entries = [];
  for (const line of readTailLines(path, TIMER_TAIL_BYTES)) {
    try { entries.push(JSON.parse(line)); } catch { /* skip a bad line */ }
  }
  return entries;
}

const TIMER_REASON = 'Your last message promises a later check at a time or interval ("next check at 03:17", "I\'ll check again in 10 minutes") but no timer is running, so nothing will make that check happen. Start one now (background Bash `sleep 600` with timeout 660000, after a separate `cd` to the repo root) or drop the promise (~/.claude/CLAUDE.md, Background agents get a 10-minute check).';

const HOLD_REASON = 'Your last message says something waits for the user\'s review ("waits for your review", "until you\'ve reviewed"). A pasted "wait for my review" line holds nothing and no review round the owner did not ask for is added (~/.claude/CLAUDE.md, Solve the problem the user has): drop the hold and say what you do next instead.';
const PLACEHOLDER_REASON = 'Your last message has a placeholder where a real link or value belongs (`<board address>/#/setup`, `NAME=<...>`). Read the real value from memory, config or the secrets store now and write it, or say which value is missing.';
const UNCHECKED_REASON = 'Your last message says "I haven\'t checked" or "I haven\'t confirmed" with no reason it cannot be checked. If any tool can check it, check it now and state what you read; only for what no tool can reach say what cannot be checked and why (~/.claude/CLAUDE.md, Check before you state).';
const HOLDER_REASON = 'Your last message names a holder ("a process still holds it", "my shell was still inside it") without a process id or a released-check reading. Run `node ~/.claude/skills/run-wave/released-check.mjs` for the worktree, name the holder it prints, or say you did not read it.';
const OVERRULE_REASON = 'Your last message hands the owner points they "can overrule". The mock trumps the plan and a slice Decision stands where the mock is silent (~/.claude/CLAUDE.md, Claude Design): record the choice in the slice and drop the question.';
const WHY_REASON = 'The user asked "why". The first line of your answer must hold the cause in plain words ("I made a mistake: ...", "I didn\'t check ...", "I didn\'t think of ...", "because ..."), then what it cost and what happens now (~/.claude/CLAUDE.md, Own mistakes plainly).';
const CLICK_PATH_REASON = 'Your last message ends on an arrow click path right after a denied action. Say it was blocked and which permission rule would allow it, never click-by-click steps (~/.claude/CLAUDE.md, Solve the problem the user has: the permission-block bullet).';

// The checks that need the transcript run only when the text checks passed.
function decideFromTranscript(input, text) {
  if (!input.transcript_path) return null;
  const { lastUserText, denied, toolCalls } = transcriptFacts(input.transcript_path);
  if (whyWithoutCause(lastUserText, text, toolCalls)) return { decision: 'block', reason: WHY_REASON };
  if (clickPathAfterDenial(text, denied)) return { decision: 'block', reason: CLICK_PATH_REASON };
  if (promisesTimedCheck(text) && !timerRunningIn(readTranscriptEntries(input.transcript_path))) return { decision: 'block', reason: TIMER_REASON };
  return null;
}

// --- Docs lint (items 6, 19, 27): `question-stop.mjs --lint-docs <file>...` reads plan.md, slice files and a _STATUS.md body.
export function findReviewHolds(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    // Quoted spans (the user's own words) are dropped, then the one shared REVIEW_WAIT pattern is tested.
    if (REVIEW_WAIT.test(line.replace(QUOTED_OR_SPAN, ' '))) found.push({ line: i + 1, text: line.trim().slice(0, 160), why: 'a "waits for review" hold with no quoted user message' });
  });
  return found;
}

// Only the lines slice 29's items name (a review round, the tab bar's place, "which of N"). A real owner step is never
// flagged: a line with a link or naming a store submission is skipped before the rules run.
const SETTLED_RULES = [
  [/\b(?:OK|approval|go-ahead) to (?:build|merge|start)\b|\b(?:review|approve|sign[- ]off on) (?:the )?(?:plan|slice|mock|design)\b/i, 'no review round the owner did not ask for (~/.claude/CLAUDE.md)'],
  [/\btab bar\b[^\n]*\b(?:top|bottom)\b|\b(?:top|bottom)\b[^\n]*\btab bar\b/i, 'the newer mock wins, never a question (~/.claude/CLAUDE.md, Claude Design)'],
  [/\bchoose which of \d+\b|\bwhich of (?:the )?\d+\b/i, 'a choice the plan can take itself and record'],
];
const OWNER_STEP = /https?:\/\/|\b(?:App Store|Play Console|TestFlight|Partner Center|store submission|submit)\b/i;
const WAITING_HEADING = /waiting on the user/i;
export function findSettledQuestions(text) {
  const found = [];
  let inside = false;
  text.split('\n').forEach((line, i) => {
    if (/^#{1,6}\s/.test(line)) inside = WAITING_HEADING.test(line);
    const sameLine = /^[\s>*_-]*waiting on the user/i.test(line);
    if ((!inside && !sameLine) || OWNER_STEP.test(line)) return;
    for (const [pattern, why] of SETTLED_RULES) {
      if (pattern.test(line)) { found.push({ line: i + 1, text: line.trim().slice(0, 160), why }); break; }
    }
  });
  return found;
}

export function lintDocs(files, read = (f) => readFileSync(f, 'utf8')) {
  const problems = [];
  for (const file of files) {
    const text = read(file);
    for (const p of [...findReviewHolds(text), ...findSettledQuestions(text)]) problems.push(`${file}:${p.line}: ${p.why}: ${p.text}`);
  }
  return problems;
}

// --- Warn-only checks (FL-0852 items 4, 6, 26): heuristics that are not certain enough to block a stop (root CLAUDE.md:
// a guard denies only what it is certain of). Each returns a sentence for the user's `systemMessage`, or null.

// Item 6: a final report that hands the user a step ("you:", "restart", "check that") with no link and no reason only the user can do it.
const USER_STEP = /^[\s>*_-]*(?:\d+[.)]\s*)?(?:\*\*)?(?:you:|restart (?:claude|the app|your)|check (?:that|a toast)\b)/im;
const STEP_LINK_OR_REASON = /https?:\/\/|\b(?:because|only you|no tool|cannot be checked|can['’]t be checked|needs your|your (?:login|phone|device|account)|only the user)\b/i;
export function userStepWithoutLink(text) {
  if (typeof text !== 'string') return null;
  const paragraph = bareProse(text).split(/\n\s*\n/).find((p) => USER_STEP.test(p) && !STEP_LINK_OR_REASON.test(p));
  return paragraph ? 'question-stop (warning, nothing blocked): the final report lists a step for the user with no link and no reason only the user can do it. Do it yourself if a tool can, else add the direct link and why (~/.claude/CLAUDE.md, Every user action comes with a direct link).' : null;
}

// Item 26: a claim about CI state needs `gh workflow list --all` run in the same turn.
const CI_CLAIM = /\b(?:(?:Linux |GitHub )?CI|the (?:test )?workflows?|Actions) (?:already |still |also )?(?:tests? (?:the|this|that|it|every|all|everything|only)\b|covers?\b|is (?:on|off|enabled|disabled)|are (?:on|off|enabled|disabled))\b/i;
export function ciClaimUnchecked(text, commands = []) {
  if (typeof text !== 'string' || !CI_CLAIM.test(bareProse(text))) return null;
  if (commands.some((c) => /\bgh\s+workflow\s+list\b/.test(c))) return null;
  return 'question-stop (warning, nothing blocked): the final report states what CI runs or whether workflows are on, but no `gh workflow list --all` ran this turn. Read it live before stating it (~/.claude/CLAUDE.md, Check before you state).';
}

// Item 4: the turn edited files the user's last message did not name, and no line states the understood goal.
const NAMED_PATH = /[\w.@~-]+(?:[\\/][\w.@~-]+)+|\b[\w-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json|md|ps1|sh|yml|yaml|cs|py|css|html|txt|toml)\b/g;
const trimPunct = (n) => n.replace(/[.,;:)]+$/, '');
const GOAL_LINE = /\b(?:the goal (?:is|here)|goal:|my understanding|I understand (?:that )?you want|you want(?:ed)? me to|so (?:you|the) (?:want|ask))\b/i;
const basename = (p) => p.split(/[\\/]/).pop().toLowerCase();
export function editsBeyondAsk(userText, editedPaths = [], assistantText = '') {
  if (typeof userText !== 'string' || !editedPaths.length || GOAL_LINE.test(assistantText)) return null;
  const named = (userText.match(NAMED_PATH) ?? []).map((n) => trimPunct(n.toLowerCase().replace(/\\/g, '/'))).filter(Boolean);
  if (!named.length) return null; // the user named no file, so there is nothing to compare against
  const outside = [...new Set(editedPaths)].filter((p) => {
    const norm = p.toLowerCase().replace(/\\/g, '/');
    return !named.some((n) => norm.endsWith(n) || norm.includes(`${n}/`) || basename(n) === basename(norm));
  });
  return outside.length ? `question-stop (warning, nothing blocked): this turn edited ${outside.length} file(s) the last message did not name (${outside.slice(0, 3).map(basename).join(', ')}) and no line states the understood goal. Past the literal ask, state the goal in one line and confirm it (~/.claude/CLAUDE.md, Solve the problem the user has).` : null;
}

// The warnings for a finished turn, as one string (or null). Fails open.
export function warnings(input) {
  const text = input.last_assistant_message;
  if (typeof text !== 'string' || input.stop_hook_active) return null;
  const facts = input.transcript_path ? transcriptFacts(input.transcript_path) : { lastUserText: '', editedPaths: [], commands: [], assistantText: '' };
  const found = [userStepWithoutLink(text), ciClaimUnchecked(text, facts.commands), editsBeyondAsk(facts.lastUserText, facts.editedPaths, `${facts.assistantText}\n${text}`)].filter(Boolean);
  return found.length ? found.join('\n') : null;
}

const MIRROR_REASON = (markers) => `A merge printed "Mirror due" and no mirror ran for it yet: ${markers.map((m) => `${m.repo} @ ${String(m.sha).slice(0, 8)}`).join(', ')}. Dispatch your docs-mirror agent now (it clears the marker with mirror-due.mjs clear <repo> <sha>), or clear the marker if the mirror was done another way.`;

// Without last_assistant_message the transcript may lag the turn, so the hook passes instead of guessing.
export function decide(input, due = dueWhenMirrorInstalled) {
  if (input.stop_hook_active) return null;
  const text = input.last_assistant_message;
  if (endsWithQuestion(text) || endsWithOffer(text)) return { decision: 'block', reason: REASON };
  if (endsWithCheckOffer(text)) return { decision: 'block', reason: CHECK_REASON };
  if (promisesFixWithoutSlice(text)) return { decision: 'block', reason: FIX_REASON };
  if (holdsForReview(text)) return { decision: 'block', reason: HOLD_REASON };
  if (hasPlaceholderLink(text)) return { decision: 'block', reason: PLACEHOLDER_REASON };
  if (admitsUnchecked(text)) return { decision: 'block', reason: UNCHECKED_REASON };
  if (claimsUnnamedHolder(text)) return { decision: 'block', reason: HOLDER_REASON };
  if (offersOverrule(text)) return { decision: 'block', reason: OVERRULE_REASON };
  const fromTranscript = typeof text === 'string' ? decideFromTranscript(input, text) : null;
  if (fromTranscript) return fromTranscript;
  // The mirror reminder is spent (the once-per-session record is written) only for a final turn this hook can judge.
  if (typeof text !== 'string') return null;
  let markers = [];
  try { markers = due(input); } catch { /* fail open */ }
  return markers.length ? { decision: 'block', reason: MIRROR_REASON(markers) } : null;
}

// Compares real paths: ~/.claude/skills/<name> is a symlink, so argv[1] is the link path while
// import.meta.url is the resolved one, and a plain === never matched (the hook never fired).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch (error) {
    // Say why, then compare the plain paths, so a failed realpath never silently turns the hook off.
    process.stderr.write(`question-stop: realpath failed (${error.message}); comparing plain paths\n`);
    return argvPath === fileURLToPath(moduleUrl);
  }
}

// Exit 0 clean, 1 findings, 2 usage error (no files, or a file that cannot be read, named in the message).
function runLintDocs(files) {
  if (!files.length) {
    process.stderr.write('question-stop --lint-docs: no files given (usage: --lint-docs <file>...)\n');
    process.exitCode = 2;
    return;
  }
  const texts = new Map();
  for (const file of files) {
    try { texts.set(file, readFileSync(file, 'utf8')); } catch (error) {
      process.stderr.write(`question-stop --lint-docs: cannot read ${file} (${error.code ?? error.message})\n`);
      process.exitCode = 2;
      return;
    }
  }
  const problems = lintDocs(files, (f) => texts.get(f));
  if (problems.length) process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = problems.length ? 1 : 0;
}

if (isEntryPoint(process.argv[1], import.meta.url) && process.argv[2] === '--lint-docs') {
  runLintDocs(process.argv.slice(3));
} else if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const verdict = decide(input);
    if (verdict) process.stdout.write(JSON.stringify(verdict));
    else { const warn = warnings(input); if (warn) process.stdout.write(JSON.stringify({ systemMessage: warn })); }
  } catch (error) {
    process.stderr.write(`question-stop: failed open (${error.message})\n`);
  }
}
