#!/usr/bin/env node
// Turns a Claude Code session transcript (JSONL) into a short text digest an audit agent
// can read whole: user messages, assistant text, compaction summaries, agent briefs and
// tool calls, each with its entry number. Ordinary tool results are left out (they are the
// bulk); kept are permission denials (DENIED), subagent reports (AGENT RESULT, also the
// hand-backs that arrive as a user entry) and failed calls (TOOL ERROR). A last section lists
// slow stretches: dispatches whose result took long, and long gaps between entries.
//
// Usage:
//   node transcript-digest.mjs --list <project cwd> [hours=24]     sessions written lately, with first/last prompt
//   node transcript-digest.mjs --find <project cwd> "<phrase>"     sessions whose user messages contain the phrase
//   node transcript-digest.mjs <a.jsonl> [b.jsonl ...] --out <digest.txt> [--gaps <minutes=10>]   (--out=x and --gaps=10 also work)
// Never pick "the newest file": a parallel session in the same folder may be newer.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_INPUT_LIMIT = 300;
const AGENT_PROMPT_LIMIT = 1200;
const NOTIFICATION_LIMIT = 800;
const AGENT_RESULT_HEAD = 900;
const AGENT_RESULT_TAIL = 600;
const TOOL_ERROR_LIMIT = 400;
const DENIED_LIMIT = 400;
const DEFAULT_GAP_MINUTES = 10;
const MS_PER_MINUTE = 60_000;
const DISPATCH_TOOLS = ['Agent', 'Bash', 'Workflow'];
const DENIED_MARKERS = ['denied by the Claude Code auto mode', 'Permission for this action was denied'];
const HAND_BACK_MARKER = '[Subagent hand-back]';
const HAND_BACK_BODY_MARKER = 'The report follows:';
const ASYNC_LAUNCH_PREFIX = 'Async agent launched';
const HAND_BACK_FRAME = 'Another Claude session sent a message';
const AGENT_MESSAGE_FRAME = '<agent-message';
const SKIPPED_USER_PREFIXES = ['<local-command-caveat>', '<local-command-stdout>', '<local-command-stderr>', '<bash-stdout>', '<bash-stderr>'];
const SHELL_INPUT_PREFIX = '<bash-input>';
const USER_SHELL_PREFIX = 'USER SHELL: ';
const COMMAND_PREFIXES = ['<command-name>', '<command-message>'];
const USER_LINE_PREFIX = 'USER: ';
const USER_COMMAND_PREFIX = 'USER COMMAND: ';
const USER_SENT_WHILE_WORKING_PREFIX = 'USER (sent while working): ';
const SLEEP_COMMAND = /^\s*sleep\b/;
const NOTIFICATION_PREFIX = '<task-notification>';
const VALUE_FLAGS = ['--out', '--gaps'];

export function projectFolder(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

function transcripts(cwd) {
  const dir = projectFolder(cwd);
  return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    .map(f => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
}

export function userPrompts(jsonl) {
  return jsonl.split('\n').filter(Boolean).flatMap(line => {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user') return [];
      return userLines(entry).flatMap(l => [USER_LINE_PREFIX, USER_COMMAND_PREFIX].filter(p => l.startsWith(p)).map(p => l.slice(p.length)));
    } catch { return []; }
  });
}

function listSessions(cwd, hours) {
  const since = Date.now() - hours * 3600_000;
  return transcripts(cwd).filter(t => t.mtime >= since).map(t => {
    const prompts = userPrompts(fs.readFileSync(t.file, 'utf8'));
    const when = new Date(t.mtime).toISOString().slice(0, 16);
    return `${when}  ${t.file}\n  first: ${clip(prompts[0], 120)}\n  last:  ${clip(prompts.at(-1), 120)}`;
  }).join('\n');
}

function findSessions(cwd, phrase) {
  return transcripts(cwd).filter(t => userPrompts(fs.readFileSync(t.file, 'utf8')).some(p => p.includes(phrase)))
    .map(t => t.file).join('\n');
}

function clip(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)} [...]` : flat;
}

// Keeps the start and the end of a report: leftovers ("not verified") sit at the end.
function clipEnds(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= AGENT_RESULT_HEAD + AGENT_RESULT_TAIL) return flat;
  return `${flat.slice(0, AGENT_RESULT_HEAD)} [...] ${flat.slice(-AGENT_RESULT_TAIL)}`;
}

function describeToolUse(block) {
  const input = block.input ?? {};
  if (block.name === 'Agent') {
    const who = input.subagent_type ?? 'general-purpose';
    return `AGENT ${who} "${input.description ?? ''}": ${clip(input.prompt, AGENT_PROMPT_LIMIT)}`;
  }
  if (block.name === 'SendMessage') return `SEND ${input.to ?? ''}: ${clip(input.message, TOOL_INPUT_LIMIT)}`;
  const summary = input.description ?? input.command ?? input.file_path ?? input.skill ?? JSON.stringify(input);
  return `TOOL ${block.name}: ${clip(summary, TOOL_INPUT_LIMIT)}`;
}

function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.map(p => p.text ?? '').join('\n') : '';
}

function describeToolResult(block, names) {
  const name = names.get(block.tool_use_id) ?? 'unknown';
  const text = resultText(block);
  if (block.is_error && DENIED_MARKERS.some(m => text.includes(m))) return [`DENIED ${name}: ${clip(text, DENIED_LIMIT)}`];
  if (name === 'Agent' && !text.startsWith(ASYNC_LAUNCH_PREFIX)) return [`AGENT RESULT: ${clipEnds(text)}`];
  if (block.is_error) return [`TOOL ERROR ${name}: ${clip(text, TOOL_ERROR_LIMIT)}`];
  return [];
}

function handBackLine(content) {
  const at = content.indexOf(HAND_BACK_BODY_MARKER);
  const body = at < 0 ? content : content.slice(at + HAND_BACK_BODY_MARKER.length);
  return `AGENT RESULT: ${clipEnds(body)}`;
}

// A hand-back is stored as a meta user entry whose `origin` has handback:true and the report text;
// older transcripts only have the framed message as a string. One that arrives while the coordinator
// is mid-turn is an `attachment` entry of type `queued_command` (2026-10-31: 3 of 42 were dropped).
// Both kinds go through the same frame check, so a message merely quoting the marker is not one.
function handBackOf(entry) {
  if (entry.origin?.handback) return { from: entry.origin.from, text: entry.origin.handbackReportText ?? entry.origin.body ?? '' };
  const queued = entry.type === 'attachment' && entry.attachment?.type === 'queued_command';
  const framed = queued ? textOfContent(entry.attachment.prompt) : textOfContent(entry.message?.content);
  const start = framed.trimStart();
  const framedAsHandBack = start.startsWith(HAND_BACK_FRAME) || (queued && start.startsWith(AGENT_MESSAGE_FRAME));
  if (entry.origin?.kind === 'human' || !framedAsHandBack || !framed.includes(HAND_BACK_MARKER)) return null;
  return { from: /from="([\w-]+)"/.exec(framed)?.[1], text: handBackLine(framed).slice('AGENT RESULT: '.length) };
}

function queuedHandBackLines(entry) {
  const handBack = handBackOf(entry);
  return handBack ? [`AGENT RESULT: ${clipEnds(handBack.text)}`] : [];
}

// A message the user typed while the assistant was working is an `attachment` of type `queued_command`
// whose origin.kind is `human` (or humanTurn is true). A hand-back frame is never the user's words.
// (2026-11-01, ReadTheStupidText: a typed instruction about not waiting was dropped from the digest.)
function queuedHumanLines(entry) {
  const queued = entry.type === 'attachment' && entry.attachment?.type === 'queued_command';
  if (!queued || handBackOf(entry)) return [];
  const human = entry.attachment.origin?.kind === 'human' || entry.attachment.humanTurn === true;
  const text = textOfContent(entry.attachment.prompt).trim();
  return human && text ? [`${USER_SENT_WHILE_WORKING_PREFIX}${text}`] : [];
}

function attachmentLines(entry) {
  const handBack = queuedHandBackLines(entry);
  return handBack.length ? handBack : queuedHumanLines(entry);
}

function entryLines(entry, names) {
  if (entry.type === 'user') return userLines(entry, names);
  if (entry.type === 'assistant') return assistantLines(entry);
  return entry.type === 'attachment' ? attachmentLines(entry) : [];
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n') : '';
}

// The user's slash command is the user's own words: keep its name and arguments.
function commandLine(text) {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1];
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  const message = /<command-message>\s*([^<]*?)\s*<\/command-message>/.exec(text)?.[1];
  const shown = name ? (name.startsWith('/') ? name : `/${name}`) : `/${message ?? ''}`;
  return `${USER_COMMAND_PREFIX}${args ? `${shown} ${args}` : shown}`;
}

const SECRET_PATTERNS = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  /\bBearer\s+\S+/gi,
  /(--(?:token|password|secret|api-key)(?:=|\s+))\S+/gi,
  /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*=)\S+/gi,
];
const REDACTED = '[REDACTED]';

function redactSecrets(command) {
  return SECRET_PATTERNS.reduce((text, re) => text.replace(re, (m, keep) => (typeof keep === 'string' ? `${keep}${REDACTED}` : REDACTED)), command);
}

function shellLine(text) {
  const body = text.slice(SHELL_INPUT_PREFIX.length);
  const command = /^([\s\S]*?)(?:<\/bash-input>|<bash-stdout>|<bash-stderr>|$)/.exec(body)[1];
  return `${USER_SHELL_PREFIX}${clip(redactSecrets(command), TOOL_INPUT_LIMIT)}`;
}

function isCommand(text) {
  return COMMAND_PREFIXES.some(p => text.startsWith(p));
}

function userLines(entry, names = new Map()) {
  const content = entry.message?.content;
  const handBack = handBackOf(entry);
  if (handBack) return [`AGENT RESULT: ${clipEnds(handBack.text)}`];
  if (entry.isMeta) return [];
  if (typeof content === 'string') {
    if (SKIPPED_USER_PREFIXES.some(p => content.startsWith(p))) return [];
    if (content.startsWith(SHELL_INPUT_PREFIX)) return [shellLine(content)];
    if (isCommand(content)) return [commandLine(content)];
    if (entry.isCompactSummary) return [`COMPACT SUMMARY: ${content}`];
    if (content.startsWith(NOTIFICATION_PREFIX)) return [`NOTIFICATION: ${clip(content, NOTIFICATION_LIMIT)}`];
    return [`${USER_LINE_PREFIX}${content}`];
  }
  if (!Array.isArray(content)) return [];
  return content.flatMap(c => {
    if (c.type === 'text' && typeof c.text === 'string') {
      if (SKIPPED_USER_PREFIXES.some(p => c.text.startsWith(p))) return [];
      if (c.text.startsWith(SHELL_INPUT_PREFIX)) return [shellLine(c.text)];
      return [isCommand(c.text) ? commandLine(c.text) : `${USER_LINE_PREFIX}${c.text}`];
    }
    if (c.type === 'tool_result') return describeToolResult(c, names);
    return [];
  });
}

function assistantLines(entry) {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap(c => {
    if (c.type === 'text') return [`ASSISTANT: ${c.text}`];
    if (c.type === 'tool_use') return [describeToolUse(c)];
    return [];
  });
}

export function digestFiles(files, gapMinutes = DEFAULT_GAP_MINUTES) {
  return files.map(f => `=== session ${path.basename(f, '.jsonl')}\n${digest(fs.readFileSync(f, 'utf8'), gapMinutes)}`).join('\n');
}

function parseEntries(jsonl) {
  return jsonl.split('\n').filter(Boolean).flatMap((line, index) => {
    try { return [{ entry: JSON.parse(line), number: index + 1 }]; } catch { return []; }
  }).filter(({ entry }) => !entry.isSidechain);
}

function toolUseBlocks(entry) {
  const content = entry.message?.content;
  return entry.type === 'assistant' && Array.isArray(content) ? content.filter(c => c.type === 'tool_use') : [];
}

function toolResultBlocks(entry) {
  const content = entry.message?.content;
  return entry.type === 'user' && Array.isArray(content) ? content.filter(c => c.type === 'tool_result') : [];
}

function minutesBetween(from, to) {
  return (Date.parse(to) - Date.parse(from)) / MS_PER_MINUTE;
}

function backgroundTaskId(entry) {
  const text = textOfContent(entry.message?.content);
  return entry.type === 'user' && text.startsWith(NOTIFICATION_PREFIX) ? /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1] : undefined;
}

// A background `sleep` is the agent's own check timer, not slow work.
function isBackgroundTask(block) {
  return block.name !== 'Agent' && block.input?.run_in_background === true && !SLEEP_COMMAND.test(block.input.command ?? '');
}

// Dispatches whose result took long. A background Bash/Workflow task answers at once with a
// launch notice and finishes through a <task-notification> entry carrying its tool-use-id.
function slowDispatches(parsed, gapMinutes) {
  const open = new Map();
  const found = [];
  const report = (d, number, entry, via) => {
    const minutes = minutesBetween(d.at, entry.timestamp);
    if (minutes > gapMinutes) found.push({ from: d.number, to: number, line: `DISPATCH [${d.number}] ${clip(d.what, 100)} -> ${via} [${number}] after ${Math.round(minutes)} min` });
  };
  for (const { entry, number } of parsed) {
    for (const b of toolUseBlocks(entry)) {
      if (DISPATCH_TOOLS.includes(b.name)) open.set(b.id, { number, at: entry.timestamp, what: describeToolUse(b), background: isBackgroundTask(b) });
    }
    for (const r of toolResultBlocks(entry)) {
      const d = open.get(r.tool_use_id);
      if (!d || d.background) continue;
      open.delete(r.tool_use_id);
      report(d, number, entry, 'result');
    }
    const taskId = backgroundTaskId(entry);
    const task = taskId && open.get(taskId);
    if (task) { open.delete(taskId); report(task, number, entry, 'task notification'); }
  }
  for (const d of open.values()) {
    if (d.background) found.push({ from: d.number, to: d.number, line: `DISPATCH [${d.number}] ${clip(d.what, 100)} -> NO RESULT by the end of the transcript` });
  }
  return found;
}

function slowAsyncAgents(parsed, gapMinutes) {
  const launched = new Map();
  const found = [];
  for (const { entry, number } of parsed) {
    for (const r of toolResultBlocks(entry)) {
      const text = resultText(r);
      const id = text.startsWith(ASYNC_LAUNCH_PREFIX) ? /agentId: ([\w-]+)/.exec(text)?.[1] : null;
      if (id) launched.set(id, { number, at: entry.timestamp });
    }
    const from = handBackOf(entry)?.from;
    const l = from && launched.get(from);
    if (!l) continue;
    const minutes = minutesBetween(l.at, entry.timestamp);
    if (minutes > gapMinutes) found.push({ from: l.number, to: number, line: `DISPATCH [${l.number}] background agent ${from} -> hand-back [${number}] after ${Math.round(minutes)} min` });
  }
  return found;
}

// A user entry that is not a tool result, task notification or agent hand-back was started by the
// user (a prompt, a slash command, a resumed session's compaction summary): the wait before it is idle time.
function isUserInitiated(entry) {
  return entry.type === 'user' && !toolResultBlocks(entry).length && !backgroundTaskId(entry)
    && !textOfContent(entry.message?.content).startsWith(NOTIFICATION_PREFIX) && !handBackOf(entry);
}

// Gaps between entries, except the user's idle time (a gap ending at a human prompt) and
// stretches a DISPATCH line already explains.
function entryGaps(parsed, gapMinutes, dispatches) {
  const stamped = parsed.filter(({ entry }) => (entry.type === 'user' || entry.type === 'assistant') && entry.timestamp);
  return stamped.slice(1).flatMap((cur, i) => {
    const prev = stamped[i];
    const minutes = minutesBetween(prev.entry.timestamp, cur.entry.timestamp);
    if (!(minutes > gapMinutes) || isUserInitiated(cur.entry)) return [];
    if (dispatches.some(d => prev.number >= d.from && cur.number <= d.to)) return [];
    return [`GAP [${prev.number}] -> [${cur.number}] ${Math.round(minutes)} min`];
  });
}

function slowStretchesOf(parsed, gapMinutes) {
  const dispatches = [...slowDispatches(parsed, gapMinutes), ...slowAsyncAgents(parsed, gapMinutes)];
  const lines = [...dispatches.map(d => d.line), ...entryGaps(parsed, gapMinutes, dispatches)];
  return [`--- slow stretches (over ${gapMinutes} min)`, ...(lines.length ? lines : ['none'])].join('\n');
}

export function slowStretches(jsonl, gapMinutes = DEFAULT_GAP_MINUTES) {
  return slowStretchesOf(parseEntries(jsonl), gapMinutes);
}

export function digest(jsonl, gapMinutes = DEFAULT_GAP_MINUTES) {
  const out = [];
  const names = new Map();
  const parsed = parseEntries(jsonl);
  for (const { entry, number } of parsed) {
    toolUseBlocks(entry).forEach(b => names.set(b.id, b.name));
    const lines = entryLines(entry, names);
    const stamp = (entry.timestamp ?? '').slice(0, 16);
    for (const text of lines) out.push(`[${number} ${stamp}] ${text}`);
  }
  return [...out, slowStretchesOf(parsed, gapMinutes)].join('\n');
}

// Accepts `--flag value` and `--flag=value`; anything else starting with `--` is an error, never a file.
export function parseArgs(argv) {
  const flags = {};
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].startsWith('--') ? argv[i].split(/=(.*)/s) : [null];
    if (!name) { files.push(argv[i]); continue; }
    if (!VALUE_FLAGS.includes(name)) throw new Error(`unknown flag ${name}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    flags[name] = value;
  }
  return { flags, files };
}

function main(argv) {
  const [first, second, third] = argv;
  if (first === '--list') return console.log(listSessions(second, Number(third ?? 24)));
  if (first === '--find') return console.log(findSessions(second, third));
  const { flags, files } = parseArgs(argv);
  if (!flags['--out']) throw new Error('usage: see the header of transcript-digest.mjs');
  const gapMinutes = flags['--gaps'] === undefined ? DEFAULT_GAP_MINUTES : Number(flags['--gaps'].trim() || NaN);
  if (!(gapMinutes > 0)) throw new Error('--gaps needs a positive number of minutes');
  if (!files.length) throw new Error('no transcript given');
  const text = digestFiles(files, gapMinutes);
  fs.writeFileSync(flags['--out'], text);
  console.error(`sessions: ${files.length}\ndigest: ${flags['--out']} (${text.length} chars)`);
}

// Compare real paths: ~/.claude/skills/<name> is a link to the repo, so the two spellings differ.
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return fs.realpathSync.native(argvPath) === fs.realpathSync.native(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2));
}
