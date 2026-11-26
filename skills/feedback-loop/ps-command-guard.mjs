#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell: refuses `pwsh|powershell -Command "<text>" <file>.ps1`. PowerShell appends
// every argument after -Command to the command text, so a .ps1 trailing the quoted text is not parsed as a file: the
// quoted text runs with the path as an extra argument (night 2026-11-06-1641: `pwsh -Command "<ParseFile script>"
// skills/run-all-waves/run-all-waves.ps1` meant to parse-check the night driver and started it instead). A
// verification step must never be able to run its target. Use `node ~/.claude/skills/feedback-loop/ps-parse.mjs <files>`.
//
// Rule: deny only what is
// certain; every unclear parse allows. Deny only when, in one command segment: (1) the command word, after wrappers
// (`sudo -u x`, `nohup`, `env`, `VAR=x`, `&` ...) are removed with their flag values, is pwsh/powershell; (2) it has
// -Command/-c (any prefix, any case); (3) the command text is a quoted word or a here-string (bare `-Command
// Get-Content a.ps1` passes); (4) a later word, not a redirect target, ends in .ps1.
// `lex(text, tool)` is the one lexer, per tool. Bash: backslash escapes inside double quotes, heredoc bodies are
// skipped (not `<<` in `$((...))`), `$(...)` and backticks in double quotes are scanned only over their own span, an
// apostrophe always opens a quote. PowerShell: backtick is the escape (a backtick before a newline joins the lines),
// backslash is a plain character, no heredocs, `@'...'@` and `@"..."@` are here-strings. A quote still open at the
// end allows the whole command (no fallback pattern). Text of `bash -c`, `cmd /c`, `iex`, `pwsh -Command`,
// `Start-Process pwsh -ArgumentList` and `$(...)` is scanned the same way (nested, depth 4). The guard is a safety
// net for the well-formed command typed on purpose, not a sandbox: shell variables, `eval`, piped `xargs`, `ssh` and
// `-EncodedCommand` are not followed. An internal error lets the call through.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REASON =
  'PowerShell appends every argument after `-Command "<text>"` to the command text, so a trailing .ps1 is not parsed: ' +
  'the file can be executed (or the text runs with it as an argument). This check is deliberately conservative: any .ps1 ' +
  'word after the quoted command text is denied, even a read-only use; put the path inside the text (`-Command "Get-Content a.ps1"`) ' +
  'or use `-File <script>.ps1`. To parse-check scripts without running them use ' +
  '`node ~/.claude/skills/feedback-loop/ps-parse.mjs <files>`.';

const MAX_DEPTH = 4;
const POWERSHELL = 'PowerShell';
const BASH = 'Bash';
const PWSH_EXE = /^(?:pwsh|powershell)(?:\.exe)?$/i;
const SHELL_EXE = /^(?:bash|sh|zsh|dash)(?:\.exe)?$/i;
const CMD_EXE = /^cmd(?:\.exe)?$/i;
const CMD_FLAG = /^\/[ck]$/i;
const IEX_EXE = /^(?:iex|invoke-expression)$/i;
const START_PROCESS = /^(?:start-process|saps)$/i;
const ARGUMENT_LIST = /^-(?:argumentlist|args|arg)$/i;
const WRAPPER_EXE = /^(?:sudo|doas|nohup|time|exec|command|env|start|wsl|xargs|nice|call|stdbuf|setsid)(?:\.exe)?$/i;
// Wrapper flags that take a separate value (`sudo -u deploy pwsh`), by wrapper name.
const WRAPPER_VALUE_FLAGS = {
  sudo: ['u', 'g', 'h', 'p', 'C', 'D', 'R', 'T', 'U', 'r', 't', 'user', 'group', 'host', 'prompt', 'chdir', 'chroot'],
  doas: ['u', 'C'],
  env: ['u', 'C', 'S'],
  nice: ['n'],
  xargs: ['n', 'I', 'L', 'P', 's', 'd', 'E', 'a'],
  stdbuf: ['i', 'o', 'e'],
  wsl: ['d', 'u', 'distribution', 'user'],
};
const ASSIGNMENT = /^\w+=/;
const REDIRECT = /^(?:\d*|&)(?:>>?|<)(.*)$/;
// PowerShell accepts any prefix of -Command (-c, -co, -com, ...); -File and its prefixes end the search.
const COMMAND_FLAG = /^[-/]c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i;
const FILE_FLAG = /^[-/]f(?:i(?:l(?:e)?)?)?$/i;
const BASH_COMMAND_FLAG = /^-\w*c\w*$/;
const BASH_DQ_ESCAPES = '"\\$`';

const isQuote = (ch) => ch === '"' || ch === "'";
const isPs = (st) => st.tool === POWERSHELL;

function newState(tool) {
  return { tool, segments: [], words: [], cur: null, open: false, heredocs: [] };
}

const endWord = (st) => {
  if (st.cur) st.words.push(st.cur);
  st.cur = null;
};

function endSegment(st) {
  endWord(st);
  if (st.words.length) st.segments.push(st.words);
  st.words = [];
}

const wordOf = (st) => (st.cur ??= { text: '', bare: true, subs: [] });

// Index after the here-string body that starts at `at` (the quote of `@'`/`@"`), or the end when it never closes.
function hereString(raw, at, st) {
  const quote = raw[at];
  const end = new RegExp(`\\r?\\n${quote}@`).exec(raw.slice(at + 1));
  const word = wordOf(st);
  word.bare = false;
  if (!end) {
    st.open = true;
    word.text = raw.slice(at + 1);
    return raw.length;
  }
  word.text = raw.slice(at + 1, at + 1 + end.index).replace(/^\r?\n/, '');
  return at + 1 + end.index + end[0].length;
}

// Index of the `)` that closes the `(` before `from`, skipping quoted runs; -1 when it never closes.
function matchParen(raw, from) {
  let depth = 1;
  for (let i = from; i < raw.length; i++) {
    const ch = raw[i];
    if (isQuote(ch)) {
      const close = raw.indexOf(ch, i + 1);
      if (close < 0) return -1;
      i = close;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

// A substitution inside double quotes at `i`: { span, end } (end = index of its last char) or null when unclear.
function substitutionAt(raw, i, st) {
  if (raw[i] === '$' && raw[i + 1] === '(') {
    const close = matchParen(raw, i + 2);
    return close < 0 ? null : { span: raw.slice(i + 2, close), end: close };
  }
  if (raw[i] !== '`' || isPs(st)) return null;
  const close = raw.indexOf('`', i + 1);
  const nextQuote = raw.indexOf('"', i + 1);
  return close < 0 || (nextQuote >= 0 && close > nextQuote) ? null : { span: raw.slice(i + 1, close), end: close };
}

// One character of a quoted run: returns { text, skip } (chars consumed beyond the first) for an escape, else null.
function escapeIn(raw, i, quote, st) {
  const ch = raw[i];
  if (isPs(st)) {
    if (quote === '"' && ch === '`' && i + 1 < raw.length) return { text: raw[i + 1], skip: 1 };
    if (quote === "'" && ch === "'" && raw[i + 1] === "'") return { text: "'", skip: 1 };
    return null;
  }
  return quote === '"' && ch === '\\' && BASH_DQ_ESCAPES.includes(raw[i + 1] ?? '') ? { text: raw[i + 1], skip: 1 } : null;
}

// A quoted string starting at `at`; text goes into the current word. Returns the next index.
function quoted(raw, at, st) {
  const quote = raw[at];
  const word = wordOf(st);
  if (isPs(st) && word.text === '@' && /^\r?\n/.test(raw.slice(at + 1))) return hereString(raw, at, st);
  let text = '';
  for (let i = at + 1; i < raw.length; i++) {
    const escape = escapeIn(raw, i, quote, st);
    const sub = quote === '"' && !escape ? substitutionAt(raw, i, st) : null;
    if (escape) {
      text += escape.text;
      i += escape.skip;
    } else if (sub) {
      word.subs.push(sub.span);
      text += raw.slice(i, sub.end + 1);
      i = sub.end;
    } else if (raw[i] === quote) {
      word.text += text;
      word.bare = false;
      return i + 1;
    } else text += raw[i];
  }
  st.open = true;
  word.text += text;
  word.bare = false;
  return raw.length;
}

const insideArithmetic = (raw, at) => raw.lastIndexOf('$((', at) > raw.lastIndexOf('))', at);

// `<<[-]['"]WORD['"]`: remembers the terminator; the body is skipped at the next newline. Returns the next index.
function heredocMarker(raw, at, st) {
  const match = /^<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(raw.slice(at));
  if (!match) {
    wordOf(st).text += '<';
    return at + 1;
  }
  st.heredocs.push({ dash: match[1] === '-', word: match[3] });
  return at + match[0].length;
}

// Index after the bodies of the pending heredocs, starting at the first line after the newline.
function skipHeredocBodies(raw, from, st) {
  let pos = from;
  for (const { dash, word } of st.heredocs) {
    while (pos < raw.length) {
      const stop = raw.indexOf('\n', pos);
      const line = raw.slice(pos, stop < 0 ? raw.length : stop).replace(/\r$/, '');
      pos = stop < 0 ? raw.length : stop + 1;
      if ((dash ? line.trim() : line) === word) break;
    }
  }
  st.heredocs = [];
  return pos;
}

const isSeparator = (ch, raw, i, st) => {
  if (ch === ';' || ch === '|' || ch === '(' || ch === ')') return true;
  if (ch === '&') return raw[i - 1] !== '>' && raw[i - 1] !== '<' && raw[i + 1] !== '>';
  return (ch === '{' || ch === '}') && !st.cur;
};

const lineBreakAt = (raw, i) => /^\r?\n/.exec(raw.slice(i))?.[0].length ?? 0;

// A backslash in Bash (a continuation, an escaped quote) or a backtick in PowerShell (a continuation, an escape).
function escapeStep(raw, i, st) {
  const ch = raw[i];
  const lineBreak = lineBreakAt(raw, i + 1);
  if (isPs(st) && ch === '`') {
    if (lineBreak) {
      endWord(st);
      return i + 1 + lineBreak;
    }
    if (i + 1 < raw.length) wordOf(st).text += raw[i + 1];
    return i + 2;
  }
  if (!isPs(st) && ch === '\\') {
    if (lineBreak) return i + 1 + lineBreak;
    if (isQuote(raw[i + 1])) {
      wordOf(st).text += raw[i + 1];
      return i + 2;
    }
  }
  return -1;
}

function step(raw, i, st) {
  const ch = raw[i];
  if (ch === '\n') {
    endSegment(st);
    return skipHeredocBodies(raw, i + 1, st);
  }
  if (/\s/.test(ch)) {
    endWord(st);
    return i + 1;
  }
  if (ch === '#' && !st.cur) return raw.indexOf('\n', i) < 0 ? raw.length : raw.indexOf('\n', i);
  if (isQuote(ch)) return quoted(raw, i, st);
  const escaped = ch === '\\' || ch === '`' ? escapeStep(raw, i, st) : -1;
  if (escaped >= 0) return escaped;
  if (ch === '<' && raw[i + 1] === '<' && raw[i + 2] !== '<' && raw[i - 1] !== '<' && !isPs(st) && !insideArithmetic(raw, i)) return heredocMarker(raw, i, st);
  if (ch === '`' || isSeparator(ch, raw, i, st)) {
    endSegment(st);
    return i + 1;
  }
  wordOf(st).text += ch;
  return i + 1;
}

// Segments (arrays of words { text, bare, subs }) of a command, and whether a quote was left open.
export function lex(text, tool) {
  const st = newState(tool === POWERSHELL ? POWERSHELL : BASH);
  for (let i = 0; i < text.length; ) i = step(text, i, st);
  endSegment(st);
  return { segments: st.segments, open: st.open };
}

const exeName = (text) => text.split(/[\\/]/).pop();
const isPs1 = (word) => /\.ps1$/i.test(word.text.replace(/[)}]+$/, ''));
const wordsAfterRedirects = (words) => {
  const kept = [];
  for (let i = 0; i < words.length; i++) {
    const redirect = words[i].bare ? REDIRECT.exec(words[i].text) : null;
    if (!redirect) kept.push(words[i]);
    else if (redirect[1] === '') i++;
  }
  return kept;
};

const isWrapperFlag = (word) => (word.bare && /^(?:-\S|\/[A-Za-z]+$)/.test(word.text)) || (!word.bare && word.text === '');

// The wrapper's own flags, and the value of those that take one.
function skipWrapperFlags(words, wrapper) {
  const valued = WRAPPER_VALUE_FLAGS[wrapper] ?? [];
  let rest = words;
  while (rest.length && isWrapperFlag(rest[0])) rest = rest.slice(valued.includes(rest[0].text.replace(/^[-/]+/, '')) ? 2 : 1);
  return rest;
}

// The segment without leading `VAR=x`, wrapper commands (`sudo -u x`, `nohup`, `start`, ...) and their flags.
function withoutWrappers(words) {
  let rest = words;
  while (rest.length) {
    const first = rest[0];
    if (first.bare && ASSIGNMENT.test(first.text)) rest = rest.slice(1);
    else if (first.bare && WRAPPER_EXE.test(exeName(first.text))) {
      rest = skipWrapperFlags(rest.slice(1), exeName(first.text).toLowerCase().replace(/\.exe$/, ''));
    } else break;
  }
  return rest;
}

// `pwsh ... -Command "<text>" ... x.ps1`: the command text must be quoted; then a .ps1 word after it, or nested text that hits.
function pwshHits(args, depth) {
  const clean = wordsAfterRedirects(args);
  const flagAt = clean.findIndex((word) => FILE_FLAG.test(word.text) || COMMAND_FLAG.test(word.text));
  if (flagAt < 0 || FILE_FLAG.test(clean[flagAt].text)) return false;
  const body = clean[flagAt + 1];
  if (body === undefined || body.bare) return false;
  return clean.slice(flagAt + 2).some(isPs1) || scan(body.text, depth + 1, POWERSHELL);
}

// A comma list ('-c','x','a.ps1') is quoted items; one string ("-c x a.ps1") is bare words, so its command text passes.
function argumentListWords(word) {
  const items = word.text.split(',').filter(Boolean);
  const bare = items.length === 1;
  return items.flatMap((item) => item.split(/\s+/).filter(Boolean).map((text) => ({ text, bare, subs: [] })));
}

function startProcessHits(args, depth) {
  const exeAt = args.findIndex((word) => PWSH_EXE.test(exeName(word.text)));
  if (exeAt < 0) return false;
  const after = args.slice(exeAt + 1);
  const listAt = after.findIndex((word) => ARGUMENT_LIST.test(word.text));
  const listed = listAt >= 0 ? after.slice(listAt + 1, listAt + 2) : after;
  return pwshHits(listed.flatMap(argumentListWords), depth);
}

function cmdHits(args, depth) {
  const flagAt = args.findIndex((word) => CMD_FLAG.test(word.text));
  if (flagAt < 0) return false;
  const tail = args.slice(flagAt + 1);
  return tail.length === 1 ? scan(tail[0].text, depth + 1, BASH) : tail.length > 1 && segmentHits(tail, depth + 1, BASH);
}

function shellHits(args, depth) {
  const flagAt = args.findIndex((word) => word.bare && BASH_COMMAND_FLAG.test(word.text));
  return flagAt >= 0 && args[flagAt + 1] !== undefined && scan(args[flagAt + 1].text, depth + 1, BASH);
}

function segmentHits(words, depth, tool) {
  const rest = withoutWrappers(words);
  if (!rest.length) return false;
  const exe = exeName(rest[0].text);
  const args = rest.slice(1);
  if (PWSH_EXE.test(exe)) return pwshHits(args, depth);
  if (SHELL_EXE.test(exe)) return shellHits(args, depth);
  if (CMD_EXE.test(exe)) return cmdHits(args, depth);
  if (IEX_EXE.test(exe)) return scan(args.map((word) => word.text).join(' '), depth + 1, POWERSHELL);
  return START_PROCESS.test(exe) && startProcessHits(args, depth, tool);
}

const substitutionHits = (words, depth, tool) => words.some((word) => word.subs.some((span) => scan(span, depth + 1, tool)));

function scan(text, depth, tool) {
  if (depth > MAX_DEPTH) return false;
  const { segments, open } = lex(text, tool);
  if (open) return false;
  return segments.some((words) => segmentHits(words, depth, tool) || substitutionHits(words, depth, tool));
}

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

export function decide(input) {
  const raw = String(input?.tool_input?.command ?? '');
  try {
    return scan(raw, 0, input?.tool_name === POWERSHELL ? POWERSHELL : BASH) ? deny(REASON) : null;
  } catch (error) {
    process.stderr.write(`ps-command-guard: let the call through after an internal error: ${error.message}\n`);
    return null;
  }
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo (see entry-points.test.mjs).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch (error) {
    process.stderr.write(`ps-command-guard: realpath failed (${error.message}); comparing plain paths\n`);
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`ps-command-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
