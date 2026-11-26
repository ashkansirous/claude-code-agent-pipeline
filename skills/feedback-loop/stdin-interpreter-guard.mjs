#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell: refuses the forms that hang on this PC because an interpreter waits
// on an empty stdin. (1) A bare interpreter (`python`, `python3`, `py`, `node`, optionally with a lone `-`) with
// no script, no -c/-e and nothing piped or redirected into it: on night 2026-11-01-2355 (ReadTheStupidText)
// twelve agent reports said a stray `python3` hung. (2) Slice 266: a Python interpreter whose stdin is `< /dev/null`,
// `< NUL` or an EMPTY heredoc never returns (the "is Python here?" probe hung two agents for 2 minutes each).
// Passes: `python3 script.py`, `python3 -c ...`, `python3 - <<'EOF'` with a body, `echo x | python3`, `python3 < f`.
//
// Design (Slice 266, line based, NO quote parsing): join backslash-continued lines; mask `$(( ... ))`; walk the
// lines once, skipping heredoc bodies; split each line on `; && || |`; strip leading `( $( {`, one then/do/else
// and the prefixes (env assignments, env, timeout, cmd /c); test only the segment's first word.
// Accepted trade-off: a quoted string that holds a whole hang form on a line of its own at a segment start can be
// denied; the refusal says to use -c or a script file, so the cost is one rewrite.
// An internal error lets the call through (fail open), with a note on stderr.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REASON =
  'This starts an interpreter with no script, no -c/-e and nothing fed to its stdin, so it waits forever ' +
  'and hangs the call. Give it a script file, use -c / -e, or feed it with a quoted heredoc ' +
  "(`python3 - <<'EOF'` with a body). To edit a file, use the Edit or Write tool, not a one-off script.";
const EMPTY_STDIN_REASON =
  'This feeds the interpreter an empty stdin (an empty heredoc, `< /dev/null` or `< NUL`), which never returns on ' +
  'this PC. Python IS installed (`python` works): never probe for it. Use `-c` or a script file instead.';

const EMPTY_TAG = '<<@E';
const BODY_TAG = '<<@B';
const HEREDOC = /(?<![<\d])<<(?!<)(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/g;
const ARITHMETIC = /\$\(\(.*?\)\)/g;
const SEPARATORS = /(\|\||&&|;|\|)/;
const OPENERS = /^\s*(?:\$\(|\(|\{)\s*/;
// Slice 307: PowerShell's call operator and a quoted program path (`& 'C:\Python\python.exe'`) start a segment too.
const CALL_OPERATOR = /^&\s+/;
const QUOTED_FIRST_WORD = /^(['"])([^\s'"]*)\1/;
const KEYWORD = /^(?:then|do|else)\s+/;
const PREFIX = /^(?:\w+=\$\(\s*|(?:\w+=\S*|env|command|exec|timeout(?:\s+(?:-[sk](?=\s)\s+\S+|-\S+))*\s+\d\S*|cmd\s+\/c)\s+)/;
const PYTHON = String.raw`(?:\S*[\\/])?(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?`;
const NODE = String.raw`(?:\S*[\\/])?node(?:\.exe)?`;
const OPTIONS = String.raw`(?:\s+(?:-[XW]\s+[^\s<>|&;-][^\s<>|&;]*|-[abdefghijklnopqrstuvwxyz0-9.]+))*(?:\s+-(?:\s+[^\s<>|&;]+)*)?`;
const BARE_WORD = new RegExp(`^(?:${PYTHON}|${NODE})(?:\\s+-)?\\s*(?:$|[&>#]|\\d>)`, 'i');
// Slice 307: Python with only startup options and no script (`python3 -u`, `py -3`, `python -i -q`) also waits on stdin.
// The option letters are those that keep the interpreter waiting (-u, -i, -q, -B, ...); -c, -m, -V and -h are left out of the class: they take work or return at once.
const BARE_OPTIONS = new RegExp(`^${PYTHON}(?:\\s+(?:-[XW]\\s+[^\\s<>|&;-][^\\s<>|&;]*|-[1-9][0-9.]*|-[BEIOPRSabdegijklnopqrstuvwxy]+))+(?:\\s+-)?\\s*(?:$|[&>#]|\\d>)`); // case-sensitive on purpose: -V (version) must pass while -v is an option
const DEVNULL_STDIN = new RegExp(`^${PYTHON}${OPTIONS}\\s*\\d?<(?!<)\\s*(?:/dev/null|nul)(?=\\s|$|[;&|)])`, 'i');
const EMPTY_HEREDOC = new RegExp(`^${PYTHON}${OPTIONS}\\s*${EMPTY_TAG}`, 'i');

// Bash ends a plain `<<WORD` body only at a column-0 WORD line; `<<-WORD` also allows leading tabs.
function isTerminator(line, stripTabs, word) {
  return (stripTabs ? line.replace(/^\t+/, '') : line) === word;
}

// Reads one heredoc body from `start`; returns whether it was blank and the index after its terminator.
function readBody(lines, start, stripTabs, word) {
  let empty = true;
  for (let j = start; j < lines.length; j++) {
    if (isTerminator(lines[j], stripTabs, word)) return { empty, next: j + 1 };
    if (lines[j].trim() !== '') empty = false;
  }
  return { empty, next: lines.length };
}

// Joins `\`-continued lines starting at cursor.pos into one logical line.
function nextLogicalLine(cursor) {
  let text = cursor.lines[cursor.pos++];
  while (/\\$/.test(text) && cursor.pos < cursor.lines.length) text = text.slice(0, -1) + ' ' + cursor.lines[cursor.pos++];
  return text;
}

// Swaps each heredoc marker for `<<@E` (blank body) or `<<@B` (has a body) and moves the cursor past the bodies.
function resolveHeredocs(text, cursor) {
  return text.replace(HEREDOC, (_all, dash, _quote, word) => {
    const body = readBody(cursor.lines, cursor.pos, dash === '-', word);
    cursor.pos = body.next;
    return body.empty ? EMPTY_TAG : BODY_TAG;
  });
}

// The command's logical lines: continuations joined, `$(( ))` masked, heredoc bodies dropped, comments cut.
export function commandLines(command) {
  const cursor = { lines: command.split('\n').map((line) => line.replace(/\r$/, '')), pos: 0 };
  const result = [];
  while (cursor.pos < cursor.lines.length) {
    const masked = nextLogicalLine(cursor).replace(ARITHMETIC, (span) => 'x'.repeat(span.length));
    result.push(resolveHeredocs(masked, cursor).replace(/(^|\s)#.*$/, '$1'));
  }
  return result;
}

// The segment with its leading `(`, `$(`, `{`, one then/do/else keyword and the command prefixes removed.
function commandOf(segment) {
  let rest = segment.trim().replace(OPENERS, '').replace(KEYWORD, '').replace(CALL_OPERATOR, '').replace(QUOTED_FIRST_WORD, '$2');
  for (let match = PREFIX.exec(rest); match; match = PREFIX.exec(rest)) rest = rest.slice(match[0].length);
  return rest.trim();
}

// Splits a line into [{ command, afterPipe }] on `; && || |`.
export function segmentsOf(line) {
  const parts = line.split(SEPARATORS);
  const segments = [];
  for (let i = 0; i < parts.length; i += 2) {
    segments.push({ command: commandOf(parts[i]), afterPipe: parts[i - 1] === '|' });
  }
  return segments;
}

function verdictOf({ command, afterPipe }) {
  if (DEVNULL_STDIN.test(command) || EMPTY_HEREDOC.test(command)) return EMPTY_STDIN_REASON;
  if (!afterPipe && (BARE_WORD.test(command) || BARE_OPTIONS.test(command))) return REASON;
  return null;
}

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

export function decide(input) {
  const raw = String(input?.tool_input?.command ?? '');
  for (const line of commandLines(raw)) {
    for (const segment of segmentsOf(line)) {
      const reason = verdictOf(segment);
      if (reason) return deny(reason);
    }
  }
  return null;
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo (see entry-points.test.mjs).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch (error) {
    process.stderr.write(`stdin-interpreter-guard: realpath failed (${error.message}); comparing plain paths\n`);
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`stdin-interpreter-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
