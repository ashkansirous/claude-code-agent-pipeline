#!/usr/bin/env node
// Prints what the user themselves typed about a topic, across every Claude Code session of one repo, so a plan line
// that says "waits on the user's play / test / answer" is checked against what the user already said
// (2026-11-25, ReadTheStupidText Slice 283: the plan said "waits on a real play" a day after the user had played it
// and reported its bugs in chat; nobody had written it down).
//
// Usage: node user-says.mjs --repo <repo path> --terms sonos,self test [--all] [--since 2026-11-01] [--limit 40]
//   --terms  comma-separated words or short phrases ("sonos,self test": each piece is searched as one exact phrase),
//            case-insensitive; a message matches when it holds any piece (all of them with --all)
//   --since  only messages on or after this date (UTC)
// Output: one line per message, oldest first: "<ISO minute> | <session id> | <message, whitespace folded, 600 chars>".
// Reads only ~/.claude/projects/<munged repo path>* (the repo and its worktrees); writes nothing.
import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Claude Code's project folder name: every character that is not a letter, digit or dash becomes a dash.
export function mungeRepoPath(repo) {
  return path.resolve(repo).replace(/[^A-Za-z0-9-]/g, '-');
}

// The text the user typed in one transcript line, or null for tool results, meta lines and harness-injected text.
// A known harness tag may carry attributes (<teammate-message from="x">). A closed block is dropped wherever it sits; an
// unclosed one is dropped to the end only when it opens the text, so a user mentioning a tag mid-sentence keeps their words.
const TAGS = 'system-reminder|ide_\\w+|command-[\\w-]+|local-command-[\\w-]+|bash-[\\w-]+|user-prompt-submit-hook|task-notification|teammate-message|agent-message';
const CLOSED_BLOCKS = new RegExp(`<(${TAGS})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>`, 'g');
const LEADING_UNCLOSED = new RegExp(`^\\s*<(?:${TAGS})(?:\\s[^>]*)?>[\\s\\S]*$`);
const NOT_TYPED = ['This session is being continued', '[Request interrupted by user'];

// Drops the known harness-injected blocks (<system-reminder>, <ide_opened_file> ...) wherever they sit in one text; other "<" text is the user's.
function stripInjected(text) {
  return text.replace(CLOSED_BLOCKS, '').replace(LEADING_UNCLOSED, '').trim();
}

// Non-interactive sessions (`claude -p`, the Agent SDK: entrypoint "sdk-*") hold script-built prompts, not the user's words.
// Kept as a prefix filter on purpose: the real transcripts on this PC hold only "cli" and "sdk-cli", and no field tells an
// SDK-hosted session typed by a person from a scripted one, so there is no reliable signal to narrow it by.
function isTypedByUser(record) {
  if (record?.type !== 'user' || record.isMeta || record.isCompactSummary || record.isSidechain) return false;
  return !String(record.entrypoint ?? '').startsWith('sdk');
}

export function userText(record) {
  if (!isTypedByUser(record)) return null;
  let content = record.message?.content;
  if (Array.isArray(content)) {
    if (content.some((part) => part?.type === 'tool_result')) return null;
    content = content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => stripInjected(part.text)).filter(Boolean).join(' ');
  } else if (typeof content === 'string') {
    content = stripInjected(content);
  }
  if (typeof content !== 'string') return null;
  const text = content.trim();
  if (!text || NOT_TYPED.some((prefix) => text.startsWith(prefix))) return null;
  return text;
}

export function matches(text, terms, all) {
  const lower = text.toLowerCase().replace(/\s+/g, ' ');
  const hit = (term) => lower.includes(term.toLowerCase().replace(/\s+/g, ' ').trim());
  return all ? terms.every(hit) : terms.some(hit);
}

// The repo's own folder, the same repo under a ".<hex hash>" suffix, or its worktrees ("<munged>-worktrees-...",
// "<munged>--claude-worktrees-..."); never a sibling repo whose name merely starts the same (".old", "-Old").
export function isRepoFolder(name, munged) {
  const lower = name.toLowerCase();
  const base = munged.toLowerCase();
  if (lower === base) return true;
  if (lower.startsWith(`${base}-worktrees-`) || lower.startsWith(`${base}--claude-worktrees-`)) return true;
  return lower.startsWith(`${base}.`) && /^[0-9a-f]{8,}$/.test(lower.slice(base.length + 1));
}

function projectFolders(repo) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!existsSync(root)) return [];
  const munged = mungeRepoPath(repo);
  return readdirSync(root).filter((name) => isRepoFolder(name, munged)).map((name) => path.join(root, name));
}

function scanFile(file, opts, out) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (error) { console.error(`skipped ${file}: ${error.message}`); return; } // no-fallback: one unreadable session file must not stop the others
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; } // no-fallback: a half-written last line of a live session
    const text = userText(record);
    if (!text || !matches(text, opts.terms, opts.all)) continue;
    const when = record.timestamp ?? '';
    if (opts.since && when < opts.since) continue;
    out.push({ when, session: path.basename(file, '.jsonl'), text: text.replace(/\s+/g, ' ').slice(0, 600) });
  }
}

export function collect(folders, opts) {
  const out = [];
  for (const folder of folders) {
    for (const name of readdirSync(folder).filter((n) => n.endsWith('.jsonl'))) scanFile(path.join(folder, name), opts, out);
  }
  const seen = new Set();
  return out.sort((a, b) => a.when.localeCompare(b.when)).filter((m) => {
    const key = `${m.when}|${m.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const USAGE = 'usage: node user-says.mjs --repo <path> --terms a,b [--all] [--since YYYY-MM-DD] [--limit N]';
const DATE_START = /^\d{4}-\d{2}-\d{2}(?:T|$)/;

// Date.parse rolls 2026-02-31 over to March, so the date part must survive a round trip.
function isRealDate(text) {
  const day = text.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

// Returns the options, or throws an Error whose message says what is wrong with the arguments.
export function parseArgs(argv) {
  const opts = { repo: null, terms: [], all: false, since: null, limit: 40 };
  const value = (i, flag) => {
    if (i >= argv.length || argv[i].startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') opts.repo = value(++i, arg);
    else if (arg === '--terms') opts.terms = value(++i, arg).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    else if (arg === '--all') opts.all = true;
    else if (arg === '--since') opts.since = value(++i, arg);
    else if (arg === '--limit') opts.limit = Number(value(++i, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.since && (!DATE_START.test(opts.since) || Number.isNaN(Date.parse(opts.since)) || !isRealDate(opts.since))) {
    throw new Error('--since must be a real date, YYYY-MM-DD or an ISO time');
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new Error('--limit must be a positive whole number');
  return opts;
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (error) { console.error(`${error.message}\n${USAGE}`); process.exit(2); }
  if (!opts.repo || opts.terms.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }
  const folders = projectFolders(opts.repo);
  if (folders.length === 0) { console.log(`no Claude Code sessions found for ${opts.repo}`); return; }
  const found = collect(folders, opts);
  for (const m of found.slice(-opts.limit)) console.log(`${m.when.slice(0, 16)} | ${m.session.slice(0, 8)} | ${m.text}`);
  console.log(`(${found.length} matching messages${found.length > opts.limit ? `, newest ${opts.limit} shown` : ''})`);
}

function isEntryPoint() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) main();
