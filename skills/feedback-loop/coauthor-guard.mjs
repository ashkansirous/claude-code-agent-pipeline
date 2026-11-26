#!/usr/bin/env node
// PreToolUse hook on Bash, PowerShell and Agent: refuses a git commit (or a subagent brief) that carries a
// `Co-Authored-By: Name <email>` trailer. The rule (~/.claude/CLAUDE.md, Commit and push defaults) says no
// co-author, ever, unless the user asks in that turn; settings.json already sets attribution.commit to "",
// but on night 2026-11-01-2355 (ReadTheStupidText) the main thread still typed the trailer by habit into
// about 15 of its own commits and into a ship-branch brief. Only the trailer shape (a name and an <email>)
// counts, so a brief that quotes the rule ("no Co-Authored-By line") passes.
// Bash/PowerShell: checked only when the command runs `git commit` / `git commit-tree`; a message file given
// with -F / --file is read too. Agent: the prompt is checked.
// Escape hatch, for a turn where the user asked for a co-author: put `# coauthor-ok` (with the `#`) in the
// command; an Agent prompt may carry the bare word `coauthor-ok`.
// An internal error lets the call through (fail open), with a note on stderr.
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRAILER = /co-authored-by:\s*[^\n<>]+<[^\n<>@]+@[^\n<>]+>/i;
const COMMIT = /\bgit\b[^\n;&|]*\b(?:commit|commit-tree)\b/;
const MESSAGE_FILE = /(?:\s-F\s*|\s--file[=\s])(?:"([^"]+)"|'([^']+)'|(\S+))/g;
const OPT_OUT_COMMAND = /#\s*coauthor-ok\b/;
const OPT_OUT_PROMPT = /\bcoauthor-ok\b/;
const REASON =
  'This commit or brief carries a Co-Authored-By trailer. A model is not a co-author: commits carry no ' +
  'Co-Authored-By line unless the user asked for one in this turn (~/.claude/CLAUDE.md, Commit and push ' +
  'defaults). Remove the line and run it again. If the user did ask, add `# coauthor-ok` to the command.';

export function messageFiles(command, cwd) {
  const files = [];
  for (const match of command.matchAll(MESSAGE_FILE)) {
    const path = match[1] ?? match[2] ?? match[3];
    if (path && path !== '-') files.push(isAbsolute(path) || !cwd ? path : join(cwd, path));
  }
  return files;
}

function readOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export function carriesTrailer(input, read = readOrEmpty) {
  const toolInput = input?.tool_input ?? {};
  if (input?.tool_name === 'Agent') {
    const prompt = String(toolInput.prompt ?? '');
    return !OPT_OUT_PROMPT.test(prompt) && TRAILER.test(prompt);
  }
  const command = String(toolInput.command ?? '');
  if (!COMMIT.test(command) || OPT_OUT_COMMAND.test(command)) return false;
  if (TRAILER.test(command)) return true;
  return messageFiles(command, input.cwd).some((file) => TRAILER.test(read(file)));
}

export function decide(input, read = readOrEmpty) {
  if (!carriesTrailer(input, read)) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON } };
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo (see entry-points.test.mjs).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch (error) {
    process.stderr.write(`coauthor-guard: realpath failed (${error.message}); comparing plain paths\n`);
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`coauthor-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
