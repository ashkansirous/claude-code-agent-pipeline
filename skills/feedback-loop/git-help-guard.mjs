#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell: refuses git's long help forms. On Git for Windows, `git <cmd> --help`,
// `git help <cmd>` and `git --help <cmd>` open the HTML manual in the user's default browser, even with the output
// sent to /dev/null. On night 2026-11-06 (ReadTheStupidText) a fix-review-findings agent ran
// `git checkout --help >/dev/null 2>&1` as a stray probe at 23:00, and the user found git-checkout.html open in Chrome
// the next morning. The short form `git <cmd> -h` prints usage in the terminal and is allowed, and so are
// `git help -a|--all|-g|--guides|-c|--config` (they print a list in the terminal).
//
// Design: reuses the segment walker of stdin-interpreter-guard.mjs (continued lines joined, heredoc bodies skipped,
// split on `; && || |`, prefixes stripped). Only a segment whose first word is git (bare, a path, `.exe`, or a quoted
// path after PowerShell's `&`) is tested, so a commit message, a PR body or a heredoc that merely mentions the form
// passes. Separators inside quotes are masked first. Git's global options are skipped to find the subcommand.
// An internal error lets the call through (fail open), with a note on stderr.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commandLines, segmentsOf } from './stdin-interpreter-guard.mjs';

const REASON =
  "On Windows, git's long help (`git <cmd> --help`, `git help <cmd>`) opens the HTML manual in the user's browser, " +
  'even when its output is redirected. Use `git <cmd> -h` for usage in the terminal, or the library-docs agent for ' +
  'anything more. Never probe git with a help command.';

const HELP = 'help';
const LONG_HELP = '--help';
const END_OF_OPTIONS = '--';
const CALL_OPERATOR = '&';
const TERMINAL_HELP_FLAGS = new Set(['-a', '--all', '-g', '--guides', '-c', '--config']);
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
const FLAG_OPTIONS = new Set([
  '-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-advice', '--exec-path',
]);
const VALUE_PREFIXES = ['--git-dir=', '--work-tree=', '--namespace=', '--exec-path=', '--super-prefix=', '--config-env='];
const TOKEN = /(?:"[^"]*"?|'[^']*'?|[^\s"'])+/g;
const GIT_EXE = /^git(?:\.exe)?$/i;

// Replaces `; & |` inside quotes (an unclosed quote runs to the end of the line) so the walker cannot split there.
function maskQuotedSeparators(line) {
  let quote = '';
  let out = '';
  for (const ch of line) {
    if (quote) {
      out += /[;&|]/.test(ch) ? '_' : ch;
      if (ch === quote) quote = '';
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      out += ch;
    }
  }
  return out;
}

const unquote = (token) => token.replace(/["']/g, '');

// A trailing `)` counts only when the segment closes more parens than it opens (`(git help)`, not `$(foo --help)`).
function valueOf(token, closers) {
  const value = unquote(token);
  return closers > 0 && value.endsWith(')') ? value.slice(0, -1) : value;
}

// The words of a segment as values, minus a leading `&` call operator; null unless the first word is git.
function gitArguments(command) {
  const tokens = command.match(TOKEN) ?? [];
  if (tokens[0] === CALL_OPERATOR) tokens.shift();
  if (!tokens.length || !GIT_EXE.test(unquote(tokens[0]).split(/[\\/]/).pop())) return null;
  const closers = (command.match(/\)/g) ?? []).length - (command.match(/\(/g) ?? []).length;
  return tokens.slice(1).map((token) => valueOf(token, closers));
}

// Index of the first word after git's global options (`-C <path>`, `-c k=v`, `--no-pager`, `--git-dir=...`).
function subcommandIndex(args) {
  let i = 0;
  while (i < args.length) {
    const word = args[i];
    if (VALUE_OPTIONS.has(word)) i += 2;
    else if (FLAG_OPTIONS.has(word) || VALUE_PREFIXES.some((prefix) => word.startsWith(prefix))) i += 1;
    else return i;
  }
  return args.length;
}

function opensManual(args) {
  const at = subcommandIndex(args);
  if (at >= args.length) return false;
  const [subcommand, ...rest] = args.slice(at);
  if (subcommand === LONG_HELP) return true;
  if (subcommand === HELP) return !rest.some((word) => TERMINAL_HELP_FLAGS.has(word));
  const end = rest.indexOf(END_OF_OPTIONS);
  return (end === -1 ? rest : rest.slice(0, end)).includes(LONG_HELP);
}

function segmentOpensManual({ command }) {
  const args = gitArguments(command);
  return args !== null && opensManual(args);
}

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

export function decide(input) {
  const raw = String(input?.tool_input?.command ?? '');
  const hit = commandLines(raw).some((line) => segmentsOf(maskQuotedSeparators(line)).some(segmentOpensManual));
  return hit ? deny(REASON) : null;
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo (see entry-points.test.mjs).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch (error) {
    process.stderr.write(`git-help-guard: realpath failed (${error.message}); comparing plain paths\n`);
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`git-help-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
