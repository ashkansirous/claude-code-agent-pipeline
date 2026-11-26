#!/usr/bin/env node
// ADVISORY (Slice 307, two strikes): never denies; it allows the call, warns the model and logs (advisory.mjs).
// PreToolUse hook on Bash and PowerShell (Slice 307, item 13): flags `start-detached.ps1` (the call that starts a
// whole unattended night run) unless the user's own LAST message in this session asks for it. On
// 2026-11-07 (ReadTheStupidText, d75d7cfc) "any reason not to run the waves?" was read as a go and a run started.
// Deny ONLY when the user's last typed message is a question (it ends with `?`, and is not a `/run-all-waves` slash
// command) and this session has not already started the run successfully. Everything else passes: "yes", a list of
// answers to the skill's questions, "ok", no typed message at all. (The skill asks questions first, so the last
// message is usually an answer, never a go phrase.)
// A RESTART passes: a call earlier in this transcript counts as "already ran" only when its tool result came back
// without an error, so a call this hook denied (still written to the transcript) does not open the door.
// A `start-detached.ps1` named inside a commit message or echo is not a call: the match is anchored to the start of a
// statement.
// The hook reads `transcript_path` from its input. Without a readable transcript (a subagent, a test) it lets the
// call through with a note on stderr: it cannot prove a refusal. Every internal error fails open the same way.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// The advisory helper lives in another skill folder and loads dynamically: when it is missing (a partial install)
// the hook fails open with a note.
let advisoryLib = null;
try { advisoryLib = await import('../feedback-loop/advisory.mjs'); } catch (error) { process.stderr.write(`start-guard: advisory.mjs unavailable (${error.message}); warnings off\n`); }
const advisory = (reason) => (advisoryLib ? advisoryLib.advisory(reason) : null);
const emit = (hook, verdict, cwd) => { if (advisoryLib) advisoryLib.emit(hook, verdict, cwd); };

const STATEMENT_START = String.raw`(?:^|[;&|\n]\s*|&\s+)`;
const STARTER = new RegExp(`${STATEMENT_START}(?:(?:pwsh|powershell)(?:\\.exe)?\\s+[^\\n;|&]*?-File\\s+["']?\\S*start-detached\\.ps1|["']?\\S*[\\\\/]start-detached\\.ps1)`, 'i');
const TRAILING_QUOTES = /["'”’)\]\s]+$/;
const COMMAND_NAME = /<command-name>\s*([^<\s]+)\s*<\/command-name>/;
const NON_HUMAN_PREFIXES = ['<', '[Request interrupted', 'Caveat:'];

// Whether the command starts a detached run (not a mention of it in a commit message or an echo).
export function startsDetachedRun(command) {
  return STARTER.test(String(command ?? ''));
}

// The text of a transcript entry the user typed, or null: not a tool result, meta note, hand-back or system tag.
function humanText(entry) {
  if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
    const human = entry.attachment.origin?.kind === 'human' || entry.attachment.humanTurn === true;
    return human ? textOf(entry.attachment.prompt) : null;
  }
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.origin?.handback) return null;
  const content = entry.message?.content;
  if (Array.isArray(content) && content.some((c) => c.type === 'tool_result')) return null;
  const text = textOf(content).trim();
  const slash = COMMAND_NAME.exec(text);
  if (slash) return slash[1].startsWith('/') ? slash[1] : `/${slash[1]}`;
  return !text || NON_HUMAN_PREFIXES.some((p) => text.startsWith(p)) ? null : text;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n') : '';
}

function entriesOf(transcript) {
  return transcript.split('\n').flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

// The user's last typed message in the transcript, or null.
export function lastHumanMessage(transcript) {
  const texts = entriesOf(transcript).map(humanText).filter(Boolean);
  return texts.length ? texts[texts.length - 1] : null;
}

// Whether the message is a question: it ends with `?` and is not a slash command (`/run-all-waves ...`).
export function isQuestion(message) {
  const text = String(message ?? '').trim();
  return !text.startsWith('/') && text.replace(TRAILING_QUOTES, '').endsWith('?');
}

function resultsById(entries) {
  const failed = new Map();
  for (const entry of entries) {
    if (entry.type !== 'user' || !Array.isArray(entry.message?.content)) continue;
    for (const c of entry.message.content) {
      if (c.type === 'tool_result' && c.tool_use_id) failed.set(c.tool_use_id, c.is_error === true);
    }
  }
  return failed;
}

// Whether an earlier assistant call in the transcript ran start-detached.ps1 AND its result came back without an
// error (a call this hook denied has an error result, or none).
export function hasEarlierStart(transcript) {
  const entries = entriesOf(transcript);
  const failed = resultsById(entries);
  return entries.some((entry) => entry.type === 'assistant' && Array.isArray(entry.message?.content)
    && entry.message.content.some((c) => c.type === 'tool_use' && startsDetachedRun(c.input?.command) && failed.get(c.id) === false));
}

const REASON = 'start guard: `start-detached.ps1` starts a whole unattended night run, and the last message from the user is a question (such as "any reason not to run the waves?", which is not a go; 2026-11-07). Answer the question, and start the run only after the user answers or says to start. A restart of a run this session already started successfully is allowed.';

export function decide(input, readTranscript = (path) => readFileSync(path, 'utf8'), warn = (t) => process.stderr.write(t)) {
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return null;
  if (!startsDetachedRun(input.tool_input?.command)) return null;
  if (!input.transcript_path) { warn('start-guard: no transcript_path in the hook input; let the call through\n'); return null; }
  const transcript = readTranscript(input.transcript_path);
  if (!isQuestion(lastHumanMessage(transcript)) || hasEarlierStart(transcript)) return null;
  return advisory(REASON);
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo (see entry-points.test.mjs).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch (error) {
    process.stderr.write(`start-guard: realpath failed (${error.message}); comparing plain paths\n`);
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    emit('start-guard', decide(input), input.cwd ?? process.cwd());
  } catch (error) {
    process.stderr.write(`start-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
