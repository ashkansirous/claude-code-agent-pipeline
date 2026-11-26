#!/usr/bin/env node
// PreToolUse hook on Bash, PowerShell and Write: refuses creating a new folder or file directly at a drive root
// (`D:\scratch-x`, `/d/scratch-x`, `C:\gs`). The harness blocks deletes there, so nobody can clean it up, and
// the rule against it (~/.claude/CLAUDE.md, Release what you hold) was broken
// again on 2026-11-08 (night 2026-11-08-1703 housekeeping: a mirror agent staged in `D:\scratch-mirror-hk1`
// and its own delete was blocked). Only a NEW top-level name counts: writing inside an existing top-level
// folder such as `D:\ReadTheStupidText-worktrees\...` passes.
// Bash/PowerShell: the command is split into segments (; && || | newline, outside quotes; heredoc bodies are
// dropped; `powershell -Command "..."`, `cmd /c ...`, `bash -c '...'` are unwrapped into more segments). A
// segment counts only when its first word is a creator (mkdir, New-Item, touch, cp, mv, robocopy, mklink, ln,
// tee, Set-Content, `git clone`, `git worktree add`, `curl -o`, ...); only that segment's own arguments are
// scanned, as unquoted shell words: a trailing `# comment` and a `<<<` here-string body are dropped, and only a
// WHOLE word that is a drive-root path counts (never one after `=` or inside a longer string). For cp, mv,
// Copy-Item, robocopy, rclone ... only the destination counts. A drive that does not exist never counts. A `>`/`>>` redirect outside quotes counts in any segment. Paths with an unexpanded `$VAR`, `%VAR%`,
// wildcard or brace are skipped. `.`/`..` are resolved first; `D:name` means `D:\name`.
// Opt out for a deliberate new project folder: put `# drive-root-ok` anywhere in the command (or create the
// folder that way first; a Write into an existing top-level folder passes).
// Write: a file_path whose top-level name under the drive does not exist. Edit and NotebookEdit only change an
// existing file, so they are no-ops here. Only on Windows (other platforms return null). An internal error lets
// the call through (fail open).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OPT_OUT = /#\s*drive-root-ok\b/;
const CREATORS = new Set([
  'mkdir', 'md', 'new-item', 'ni', 'touch', 'cp', 'copy', 'copy-item', 'mv', 'move', 'move-item', 'robocopy',
  'mklink', 'ln', 'tee', 'add-content', 'set-content', 'out-file', 'mktemp', 'rclone',
]);
const WORKTREES_SUFFIX = /-worktrees$/i;
// Verbs whose only creating argument is the destination (the last positional; robocopy's is the second one).
const COPIERS = new Set(['cp', 'copy', 'copy-item', 'mv', 'move', 'move-item', 'rclone', 'robocopy']);
const DOWNLOAD_FLAGS = new Set(['-o', '--output', '--output-document', '-outfile']);
const DEST_FLAG = /^-dest(?:ination)?$/i;
// `-x`, `--x`, `/E`, `/XD`, `/Z:5`; a POSIX drive path such as `/d/x` has a second slash, so it is not a flag.
const FLAG = /^(?:-.*|\/[A-Za-z?]+(?::\S*)?)$/;
const SKIP_LIST_FLAG = /^\/(?:XD|XF)$/i;
const VALUE_FLAGS = new Set(['-value']);
// A redirect into a drive-root path counts on its own (a plain `2>&1` does not; `->` and `=>` are not redirects).
const REDIRECT = /(?<![-=<>])>>?\s*(["']?)((?:[A-Za-z]:[\\/]|\/[a-z]\/)[^\s"']*)/g;
// A whole argument that IS a drive-root path: `D:\name`, `D:/name`, `/d/name`, or drive-relative `D:name`.
const ROOT_TOKEN = /^(?:([A-Za-z]):[\\/]|\/([a-z])\/|([A-Z]):(?=[A-Za-z0-9_-]))([^]*)$/;
const UNEXPANDED = /[$%*?{`]/;
const MAX_DEPTH = 3;
const REASON =
  'This would create a new folder or file directly at a drive root (%s). The harness blocks deletes there, ' +
  'so it can never be cleaned up. Use the session scratchpad, your worktree or the job\'s tmp folder instead. ' +
  'For a deliberate new project folder at a drive root, add `# drive-root-ok` to the command. ' +
  'See ~/.claude/CLAUDE.md, Release what you hold when you finish.';

function rootEntry(drive, rest, exists) {
  if (!exists(`${drive.toUpperCase()}:\\`)) return null;
  const rawTop = rest.split(/[\\/]/)[0];
  if (UNEXPANDED.test(rawTop)) return null;
  const normalized = path.win32.normalize(`${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`);
  const top = normalized.slice(3).split('\\')[0];
  if (!top || UNEXPANDED.test(top) || WORKTREES_SUFFIX.test(top)) return null;
  const entry = `${drive.toUpperCase()}:\\${top}`;
  return exists(entry) ? null : entry;
}

export function newRootEntries(text, exists = existsSync) {
  const match = ROOT_TOKEN.exec(String(text).trim());
  if (!match) return [];
  const entry = rootEntry(match[1] ?? match[2] ?? match[3], match[4].replace(/\)+$/, ''), exists);
  return entry ? [entry] : [];
}

export function stripHeredocs(text) {
  const withoutHereStrings = String(text).replace(/@(["'])\r?\n[\s\S]*?\r?\n\1@/g, '');
  const kept = [];
  let tag = null;
  for (const line of withoutHereStrings.split('\n')) {
    if (tag) {
      if (line.trim() === tag) tag = null;
      continue;
    }
    kept.push(line);
    const m = /(?<!<)<<(?!<)-?\s*(["']?)([A-Za-z_]\w*)\1/.exec(line);
    if (m) tag = m[2];
  }
  return kept.join('\n');
}

export function splitSegments(text) {
  const segments = [];
  let current = '';
  let quote = '';
  for (const ch of String(text)) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (';&|\n'.includes(ch)) {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments;
}

function normalizeSegment(raw) {
  let seg = raw.trim();
  for (let i = 0; i < 4; i++) {
    const next = seg.replace(/^[({]\s*/, '').replace(/^\$\w+\s*=\s*/, '').replace(/^(?:\w+=\S*\s+)+/, '');
    if (next === seg) break;
    seg = next;
  }
  return seg;
}

function unquote(text) {
  const t = text.trim();
  const q = t[0];
  return (q === '"' || q === "'") && t.length > 1 && t.endsWith(q) ? t.slice(1, -1) : t;
}

function innerCommands(seg) {
  const patterns = [
    /^(?:powershell|pwsh)(?:\.exe)?\s(?:.*?\s)?-c(?:ommand)?\s+([\s\S]+)$/i,
    /^cmd(?:\.exe)?\s+\/[ck]\s+([\s\S]+)$/i,
    /^(?:bash|sh|zsh)(?:\.exe)?\s(?:.*?\s)?-c\s+([\s\S]+)$/i,
  ];
  for (const re of patterns) {
    const m = re.exec(seg);
    if (m) return [unquote(m[1])];
  }
  return [];
}

// Shell words of a segment, unquoted: stops at an unquoted `#` comment, drops redirects and `<<<` here-string bodies.
function tokenize(seg) {
  const tokens = [];
  let cur = '';
  let has = false;
  let quote = '';
  const push = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  for (const ch of seg) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      push();
    } else if (ch === '#' && !has) {
      break;
    } else {
      cur += ch;
      has = true;
    }
  }
  push();
  return dropRedirects(tokens);
}

function dropRedirects(tokens) {
  const kept = [];
  let skipNext = false;
  for (const t of tokens) {
    if (skipNext) skipNext = false;
    else if (t === '<<<') skipNext = true;
    else if (/^\d*[<>]/.test(t)) skipNext = /^\d*(?:>>?|<)$/.test(t);
    else kept.push(t);
  }
  return kept;
}

// Non-flag arguments; the word after `-Value` and everything after `/XD` or `/XF` (until the next flag) is a value.
function positionals(args) {
  const out = [];
  let skipList = false;
  let skipValue = false;
  for (const t of args) {
    if (FLAG.test(t)) {
      skipList = SKIP_LIST_FLAG.test(t);
      skipValue = VALUE_FLAGS.has(t.toLowerCase());
    } else if (skipValue) {
      skipValue = false;
    } else if (!skipList) {
      out.push(t);
    }
  }
  return out;
}

function valueAfterFlag(args, isFlag) {
  const out = [];
  args.forEach((t, i) => {
    const [name, inline] = t.split(/=(.*)/s);
    if (!isFlag(name)) return;
    out.push(inline ?? args[i + 1]);
  });
  return out.filter((v) => v !== undefined);
}

function copyDestination(first, args) {
  const explicit = args.findIndex((t) => DEST_FLAG.test(t));
  if (explicit >= 0) return [args[explicit + 1]];
  const pos = positionals(args);
  return first === 'robocopy' ? [pos[1]] : [pos.at(-1)];
}

function gitTargets(args) {
  if (args[0] === 'clone') return [positionals(args.slice(1)).at(-1)];
  if (args[0] === 'worktree' && args[1] === 'add') return positionals(args.slice(2));
  return [];
}

// The words of a creator segment that name what it creates (empty for any other command).
function creatorTargets(tokens) {
  const first = (tokens[0] ?? '').toLowerCase().replace(/\.exe$/, '');
  const args = tokens.slice(1);
  if (COPIERS.has(first)) return copyDestination(first, args);
  if (CREATORS.has(first)) return positionals(args);
  if (first === 'git') return gitTargets(args);
  if (first === 'tar') return valueAfterFlag(args, (n) => n === '-C');
  if (first === 'curl') return valueAfterFlag(args, (n) => n === '-o' || DOWNLOAD_FLAGS.has(n.toLowerCase()));
  if (first === 'wget') return valueAfterFlag(args, (n) => n === '-O' || DOWNLOAD_FLAGS.has(n.toLowerCase()));
  return [];
}

// Replaces quoted text with "" in one pass, except a quoted redirect target (`> "D:\x"`).
function maskQuotes(text) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(/"[^"]*"|'[^']*'/g)) {
    out += text.slice(last, m.index);
    out += endsWithRedirect(out) ? m[0] : '""';
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

function endsWithRedirect(out) {
  let i = out.length - 1;
  while (i >= 0 && /\s/.test(out[i])) i--;
  return out[i] === '>';
}

function redirectHits(raw, exists) {
  const hits = [];
  for (const m of maskQuotes(raw).matchAll(REDIRECT)) hits.push(...newRootEntries(m[2], exists));
  return hits;
}

function commandHits(command, exists, depth = 0) {
  const hits = [];
  if (depth > MAX_DEPTH) return hits;
  for (const raw of splitSegments(stripHeredocs(command))) {
    const seg = normalizeSegment(raw);
    for (const inner of innerCommands(seg)) hits.push(...commandHits(inner, exists, depth + 1));
    for (const target of creatorTargets(tokenize(seg))) hits.push(...newRootEntries(target ?? '', exists));
    hits.push(...redirectHits(raw, exists));
  }
  return hits;
}

export function decide(input, exists = existsSync, platform = process.platform) {
  if (platform !== 'win32') return null;
  const toolInput = input?.tool_input ?? {};
  let hits = [];
  if (input?.tool_name === 'Write') {
    hits = newRootEntries(toolInput.file_path ?? '', exists);
  } else if (input?.tool_name !== 'Edit' && input?.tool_name !== 'NotebookEdit') {
    const command = String(toolInput.command ?? '');
    if (OPT_OUT.test(command)) return null;
    hits = commandHits(command, exists);
  }
  if (hits.length === 0) return null;
  const reason = REASON.replace('%s', [...new Set(hits)].join(', '));
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch {
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`drive-root-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
