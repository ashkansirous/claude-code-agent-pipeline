// Is the interactive (main) session still waiting on its own background subagents?
//   node main-busy.mjs <transcript.jsonl>   prints {"busy":bool,"pending":["agent description", ...]}
// Busy = an `Agent` tool_use (any subagent_type) with no completion yet. Completion is any of: a tool_result that is
// not the async launch notice; a <task-notification> whose status is not `running`, found in a user message, in a
// top-level {"type":"queue-operation","content":"<task-notification>..."} record, or in a
// {"type":"attachment","attachment":{"type":"queued_command","prompt":"<task-notification>..."}} record (the shapes
// Claude Code really writes); an agent hand-back; a TaskStop. A SendMessage to a finished agent re-opens it until its
// next completion. Background Bash (timers, sleep, watchers) and Monitor do not count: the main thread's check timer
// writes its transcript every 10 minutes even when it is idle.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ASYNC_LAUNCH_PREFIX = 'Async agent launched';
const NOTIFICATION_PREFIX = '<task-notification>';
const STILL_RUNNING = /<status>\s*running\s*<\/status>/i;
const DESCRIPTION_LIMIT = 100;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c.type === 'text' ? c.text ?? '' : typeof c.content === 'string' ? c.content : '')).join('\n');
}

function parse(jsonl) {
  return jsonl.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).filter((e) => !e.isSidechain);
}

function describe(block) {
  const text = String(block.input?.description ?? block.input?.prompt ?? block.input?.subagent_type ?? 'agent').replace(/\s+/g, ' ').trim();
  return text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT)}...` : text;
}

// The notification text of a record, whichever of the three places holds it; '' when it holds none.
function notificationText(entry) {
  const candidates = [
    entry.type === 'queue-operation' ? entry.content : null,
    entry.type === 'attachment' ? entry.attachment?.prompt : null,
    entry.type === 'user' ? textOf(entry.message?.content) : null,
  ];
  return candidates.find((t) => typeof t === 'string' && t.startsWith(NOTIFICATION_PREFIX)) ?? '';
}

export function analyze(jsonl) {
  const open = new Map(); // key -> { description, agentId, origId }
  const closed = []; // finished agents, kept so a SendMessage can re-open one
  const matches = (a, key) => a.origId === key || a.agentId === key;
  const finish = (key) => {
    for (const [k, a] of open) {
      if (!matches(a, key)) continue;
      open.delete(k);
      closed.push(a);
    }
  };
  for (const entry of parse(jsonl)) {
    const content = entry.message?.content;
    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const b of content.filter((c) => c.type === 'tool_use')) {
        if (b.name === 'Agent') open.set(b.id, { description: describe(b), agentId: null, origId: b.id });
        if (b.name === 'TaskStop' && b.input?.task_id) finish(b.input.task_id);
        if (b.name === 'SendMessage' && b.input?.to) {
          const done = closed.findLast((a) => a.agentId === b.input.to);
          if (done) { closed.splice(closed.indexOf(done), 1); open.set(`resume:${b.id}`, done); }
        }
      }
    }
    if (entry.type === 'user') {
      if (entry.origin?.handback && entry.origin.from) finish(entry.origin.from);
      if (Array.isArray(content)) {
        for (const r of content.filter((c) => c.type === 'tool_result')) {
          const text = textOf(r.content);
          const agent = open.get(r.tool_use_id);
          if (!agent) continue;
          if (text.startsWith(ASYNC_LAUNCH_PREFIX)) agent.agentId = /agentId: ([\w-]+)/.exec(text)?.[1] ?? null;
          else finish(r.tool_use_id);
        }
      }
    }
    const note = notificationText(entry);
    if (note && !STILL_RUNNING.test(note)) {
      for (const tag of ['tool-use-id', 'task-id']) {
        const id = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(note)?.[1];
        if (id) finish(id.trim());
      }
    }
  }
  const pending = [...open.values()].map((a) => a.description);
  return { busy: pending.length > 0, pending };
}

export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return fs.realpathSync.native(argvPath) === fs.realpathSync.native(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  console.log(JSON.stringify(analyze(fs.readFileSync(process.argv[2], 'utf8'))));
}
