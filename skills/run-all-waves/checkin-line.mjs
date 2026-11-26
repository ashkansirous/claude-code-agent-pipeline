#!/usr/bin/env node
// Builds the check-in line of a night run from its folder and keeps the questions and user steps it has printed
// (Slice 17 part E), so the same question is not asked at every check-in and a step is not handed to the user unproven.
//   node checkin-line.mjs --night <night folder> [--question "<text>"]... [--user-step "<step> tried: <tool and why it cannot>"]...
//                         [--you-line "<step with its link>"]... [--user-replied "<question>"] [--record-answer "<question>" --answer "<text>"] [--merge-check <repo folder>]
// The line is the night's status (`status.json`: the current session, the slices still planned, the stop reason) plus:
//   - each question, unless it was already printed twice with the same text (the third time is refused: record a default
//     instead), the user replied to it and no answer was recorded yet, or an answer was recorded;
//   - each user step, only when it names what was tried ("tried: ...": the tool or API and why it cannot do it, and for a
//     step only the signed-in browser can do, that the user is asked once to allow it);
//   - each --you-line "<text>" (a `**You:**` step of the final report), only when it carries its link inline (an http(s) URL):
//     "the link is in my message above" is refused (night 2026-11-17-1657: the owner could not find the referenced message);
//   - with --merge-check, whether a merge without the skip-CI marker would be denied right now (merge-gate.mjs --explain).
// --reset-question "<question>" forgets what was recorded for that text (a later wave asking it anew).
// State: `<night folder>/checkin-state.json`. Exit 0 when the line was printed in full, 1 when anything was refused (the
// line is still printed without the refused parts, the refusals go to stderr), 2 on a usage error.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { explainMerge } from '../run-wave/merge-gate.mjs';

export const EXIT = { ok: 0, refused: 1, usage: 2 };
export const MAX_REPEATS = 2; // a question may be printed twice; the third time is refused
const STATE_FILE = 'checkin-state.json';
const STATUS_FILE = 'status.json';
const TRIED = /\btried:\s*\S/i;
const URL_INLINE = /https?:\/\/[^\s<>()"'`\]]*/gi;

export function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
}

export function loadState(night) {
  try {
    const state = JSON.parse(readFileSync(join(night, STATE_FILE), 'utf8'));
    return { questions: state.questions && typeof state.questions === 'object' ? state.questions : {} };
  } catch { return { questions: {} }; }
}

// A state that cannot be saved is a warning, never a lost check-in line (a missing night folder is created first).
function saveState(night, state) {
  try {
    mkdirSync(night, { recursive: true });
    writeFileSync(join(night, STATE_FILE), JSON.stringify(state, null, 2));
  } catch (error) {
    process.stderr.write(`checkin-line: state not saved (${error.message})\n`);
  }
}

// The real local clock time the line was built, "HH:MM": the caller copies it into "Check at ..." instead of typing one
// (Slice 22: "Check at 14:41" was typed at 14:34).
export function clockTime(now) {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

// "wave-1 running; 2 slices still planned (16, 17); no stop reason" from the night's status.json.
export function statusText(night) {
  const file = join(night, STATUS_FILE);
  if (!existsSync(file)) return `${basename(night)}: no status.json yet`;
  try {
    const status = JSON.parse(readFileSync(file, 'utf8'));
    const remaining = Array.isArray(status.remaining) ? status.remaining : [];
    const open = (status.sessions ?? []).filter((s) => !s.endedAt).length;
    const stop = status.stopReason ? `stopped: ${status.stopReason}` : 'no stop reason';
    return `${basename(night)}: ${status.current ?? 'no current session'}, ${open} session(s) running; ${remaining.length} slice(s) still planned${remaining.length ? ` (${remaining.join(', ')})` : ''}; ${stop}`;
  } catch (error) {
    return `${basename(night)}: status.json unreadable (${error.message})`;
  }
}

// { print, refusal }: whether this question may be printed now, and the state change that follows.
export function askQuestion(state, text) {
  const key = normalize(text);
  if (!key) return { print: false, refusal: 'the question has no words or digits: write it out' };
  const known = state.questions[key] ?? { text, printed: 0 };
  state.questions[key] = known;
  if (known.answer) return { print: false, refusal: `question already answered ("${known.answer}"): drop it` };
  if (known.replied) return { print: false, refusal: 'the user replied to this question and no answer is recorded: answer them or record a default (--record-answer "<question>" --answer "<text>") and drop it' };
  if (known.printed >= MAX_REPEATS) return { print: false, refusal: `the same question was printed ${known.printed} times: record a default instead (--record-answer "<question>" --answer "<the obvious choice>") and say what you chose` };
  known.printed += 1;
  return { print: true, refusal: '' };
}

export function checkUserStep(text) {
  return TRIED.test(text) ? '' : 'a step for the user needs a "tried:" field naming the tool or API tried and why it cannot do it (and, when only the signed-in browser can, that the user is asked once to allow it)';
}

// Slice 22: a placeholder like <board address>/#/setup or a bare domain (https://claude.ai) is no link. In a public repo's
// files the placeholder stays (the board forbids hostnames in git), so `publicRepo` accepts it; the report to the owner
// resolves it from private memory or config.
const BARE_URL = /^https?:\/\/[^/?#]+\/?$/i;
const LINK_ABOVE = /\b(?:link|url)\b[^.\n]{0,30}\b(?:above|earlier|before)\b|\b(?:above|earlier)\b[^.\n]{0,30}\b(?:link|url)\b/i;

// An angle token with a space in it followed by a path: <board address>/#/setup, not <Save>/<Cancel>.
const PUBLIC_PLACEHOLDER_PATH = /<(?!https?:)[^<>\n]{0,59}\s[^<>\n]{0,59}>\/\S/;

const URL_KIND = { placeholder: 'placeholder', bare: 'bare', page: 'page' };

// A URL with no host (the text after "https://" starts with "<") is a placeholder, host only is bare, the rest is a page.
function classifyUrls(text) {
  return (text.match(URL_INLINE) ?? []).map((raw) => raw.replace(/[.,;:!?]+$/, '')).map((url) => {
    if (/^https?:\/\/$/i.test(url)) return URL_KIND.placeholder;
    return BARE_URL.test(url) ? URL_KIND.bare : URL_KIND.page;
  });
}

// One ordered check for both repo kinds. A guard refuses only what it is certain about: a non-link angle token (<Save>)
// never causes a refusal. 1) a real page URL passes, whatever the wording; 2) a placeholder link (https://<host>/x or
// <board address>/path) passes in a public repo and is an unresolved link in a private one; 3) otherwise "link above"
// wording, a bare domain, or no link at all is refused.
export function checkYouLine(text, publicRepo = false) {
  const kinds = classifyUrls(text);
  if (kinds.includes(URL_KIND.page)) return '';
  if (kinds.includes(URL_KIND.placeholder) || PUBLIC_PLACEHOLDER_PATH.test(text)) {
    return publicRepo ? '' : 'a `You:` line carries a <placeholder> instead of its real link: resolve it from the app\'s real ids before sending (only a public repo\'s files keep a placeholder)';
  }
  if (LINK_ABOVE.test(text)) return 'a `You:` line points at a link elsewhere: put the link in the line itself, never "the link is in my message above"';
  if (kinds.includes(URL_KIND.bare)) return 'a `You:` line links only a bare domain: give the direct link to the exact page';
  return publicRepo
    ? 'a `You:` line in a public repo needs a link: a real URL or a <placeholder> host followed by its path'
    : 'a `You:` line needs its link inline (an http(s) URL in the line itself)';
}

export function parseCli(argv) {
  const parsed = { night: '', questions: [], steps: [], youLines: [], replied: [], answers: [], answerText: '', mergeCheck: '', reset: [], publicRepo: false };
  const flags = { '--public-repo': (v) => { parsed.publicRepo = /^(?:yes|true|1)$/i.test(v); }, '--night': (v) => { parsed.night = resolve(v); }, '--question': (v) => parsed.questions.push(v), '--user-step': (v) => parsed.steps.push(v), '--you-line': (v) => parsed.youLines.push(v), '--user-replied': (v) => parsed.replied.push(v), '--record-answer': (v) => parsed.answers.push(v), '--reset-question': (v) => parsed.reset.push(v), '--answer': (v) => { parsed.answerText = v; }, '--merge-check': (v) => { parsed.mergeCheck = resolve(v); } };
  for (let i = 0; i < argv.length; i += 2) {
    if (!flags[argv[i]] || argv[i + 1] === undefined) throw new Error(`unknown or incomplete argument ${argv[i]}`);
    flags[argv[i]](argv[i + 1]);
  }
  if (!parsed.night) throw new Error('--night <night folder> is required');
  if (parsed.answers.length && !parsed.answerText) throw new Error('--record-answer needs --answer "<text>"');
  return parsed;
}

function applyReplies(state, options) {
  for (const text of options.reset) delete state.questions[normalize(text)];
  for (const text of options.replied) {
    const key = normalize(text);
    if (!key) continue;
    state.questions[key] = { text, printed: 0, ...state.questions[key], replied: true };
  }
  for (const text of options.answers) {
    const key = normalize(text);
    if (!key) continue;
    state.questions[key] = { text, printed: 0, ...state.questions[key], replied: false, answer: options.answerText };
  }
}

// The merge check reads git; on a folder it cannot read the line still prints and the question counters still save.
function safeMergeNote(mergeNote) {
  try { return mergeNote(); } catch { return 'merge check unavailable'; }
}

// { line, refusals }: the check-in line and what was left out of it.
export function buildLine(options, mergeNote = () => explainMerge(options.mergeCheck).trim(), now = new Date()) {
  const state = loadState(options.night);
  applyReplies(state, options);
  const parts = [`Time ${clockTime(now)}`, statusText(options.night)];
  const refusals = [];
  for (const text of options.questions) {
    const verdict = askQuestion(state, text);
    if (verdict.print) parts.push(`Question: ${text}`);
    else refusals.push(`${text}: ${verdict.refusal}`);
  }
  for (const step of options.steps) {
    const problem = checkUserStep(step);
    if (problem) refusals.push(`${step}: ${problem}`);
    else parts.push(`Your step: ${step}`);
  }
  for (const text of options.youLines ?? []) {
    const problem = checkYouLine(text, options.publicRepo);
    if (problem) refusals.push(`${text}: ${problem}`);
    else parts.push(`You: ${text}`);
  }
  if (options.mergeCheck) parts.push(`Merge without the skip marker: ${safeMergeNote(mergeNote)}`);
  saveState(options.night, state);
  return { line: parts.join(' | '), refusals };
}

function isEntryPoint() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}
const invokedDirectly = isEntryPoint();
if (invokedDirectly) {
  try {
    const { line, refusals } = buildLine(parseCli(process.argv.slice(2)));
    process.stdout.write(`${line}\n`);
    refusals.forEach((r) => process.stderr.write(`checkin-line refused: ${r}\n`));
    process.exit(refusals.length ? EXIT.refused : EXIT.ok);
  } catch (error) {
    process.stderr.write(`checkin-line: ${error.message}\n`);
    process.exit(EXIT.usage);
  }
}
