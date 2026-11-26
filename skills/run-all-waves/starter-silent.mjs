// Has the starter (interactive) session gone quiet while the run goes on?
//   node starter-silent.mjs <transcript.jsonl> [minutes]   prints {"silent":bool,"lastAssistantAt":"<iso>"|null}
// Silent = the newest assistant entry of the main thread (sidechain entries are subagents) is older than `minutes`
// (default 25: a starter waiting on `sleep 600` timers or a long tool call writes no assistant entry for a while).
// Only the last ~200 KB of the file is read (the driver calls this every tick; transcripts reach hundreds of MB).
// A transcript with no assistant entry in that tail gives silent:false (nothing to measure from). Read-only:
// the driver only records it in status.json (`starterSilentSince`); it never kills or restarts anything.
// (Slice 377 item 6: an API error ended the starter's turn and nobody noticed for 2 hours.)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SILENT_MINUTES = 25;
export const TAIL_BYTES = 200 * 1024;

// The last `bytes` of a file as text; when the file is longer, the first (cut) line is dropped.
export function readTail(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } finally {
    fs.closeSync(fd);
  }
}

function parse(jsonl) {
  return jsonl.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

// ISO time of the newest main-thread assistant entry; null when there is none.
export function lastAssistantAt(jsonl) {
  const times = parse(jsonl)
    .filter((e) => e.type === 'assistant' && !e.isSidechain)
    .map((e) => Date.parse(e.timestamp ?? ''))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

export function analyze(jsonl, now = Date.now(), minutes = DEFAULT_SILENT_MINUTES) {
  const last = lastAssistantAt(jsonl);
  const silent = last !== null && now - Date.parse(last) > minutes * 60 * 1000;
  return { silent, lastAssistantAt: last };
}

export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return fs.realpathSync.native(argvPath) === fs.realpathSync.native(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  const minutes = Number(process.argv[3]) || DEFAULT_SILENT_MINUTES;
  console.log(JSON.stringify(analyze(readTail(process.argv[2]), Date.now(), minutes)));
}
