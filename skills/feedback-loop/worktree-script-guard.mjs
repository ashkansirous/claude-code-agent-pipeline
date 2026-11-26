#!/usr/bin/env node
// ADVISORY (Slice 307, two strikes): never denies; it allows the call, warns the model and logs (advisory.mjs).
// PreToolUse hook on Bash and PowerShell (Slice 307, item 1): flags the run of a JUST-WRITTEN, UNTRACKED helper script
// (`node tmp_fix.mjs`, `python3 fix.py`) whose source writes files. Builder agents twice rewrote `UsageCounter.cs`
// through such a script although agents/implement-slice.md and fix-review-findings.md forbid it: the shell-write
// guard cannot see inside a script file. Files change with the Edit or Write tool only.
// A script passes when: it is tracked by git (`node tools/x.mjs`), it was last written more than an hour ago, it
// is outside any git repo, it is a test file (*.test.*, `node --test`), or its source either has no file-write call
// or names no file the repo tracks outside tmp/ (scripts writing only to tmp/, os temp or stdout pass).
// Known misses (on purpose): a script created and run inside the SAME command (it does not exist when the hook
// runs), a script run through `bash -c`, `xargs` or a variable, a write done by a program the script spawns.
// Every internal error lets the call through (fail open), with a note on stderr.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, extname, isAbsolute, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
// The advisory helper loads dynamically: when it is missing (a partial install) the hook fails open with a note.
let advisoryLib = null;
try { advisoryLib = await import('./advisory.mjs'); } catch (error) { process.stderr.write(`worktree-script-guard: advisory.mjs unavailable (${error.message}); warnings off\n`); }
const advisory = (reason) => (advisoryLib ? advisoryLib.advisory(reason) : null);
const emit = (hook, verdict, cwd) => { if (advisoryLib) advisoryLib.emit(hook, verdict, cwd); };

export const FRESH_MS = 60 * 60 * 1000;
const INTERPRETER = /^(?:node|python3?(?:\.\d+)?|py)$/;
const PYTHON_WORD = /^(?:python3?(?:\.\d+)?|py)$/;
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;
const LEADING_CD = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&/;
const CODE_FLAGS = /^(?:-[A-Za-z]*[cmepV]|--eval|--print|--version|--check)$/;
const FLAGS_WITH_ARGUMENT = new Set(['-X', '-W', '-r', '--require', '--import', '--loader', '--input-type', '--env-file']);
const JS_WRITE = /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|renameSync|rename|copyFile(?:Sync)?|createWriteStream|rmSync|unlinkSync|truncateSync)\b/;
const PY_WRITE = /\.write_text\(|\.write_bytes\(|\bopen\([^)]*['"][wax]\+?b?['"]|\bmode\s*=\s*['"][wax]|\bos\.(?:replace|rename|remove)\(|\bshutil\.(?:move|copy\w*)\(/;
const SCRIPT_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.py']);

// Splits on newline, `;`, `&&`, `||` and `|` outside quotes.
function statementsOf(command) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const pair = command.slice(i, i + 2);
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '\n' || ch === ';' || ch === '|' || pair === '&&') {
      parts.push(current);
      current = '';
      if (pair === '&&' || pair === '||') i++;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function wordsOf(statement) {
  return [...statement.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

// The script an interpreter statement runs: `node [flags] script`, `python3 [flags] script`; null for -c/-e/-m, stdin or none.
export function scriptArgument(statement) {
  const words = wordsOf(statement.trim());
  while (words.length && (ENV_ASSIGNMENT.test(words[0]) || words[0] === '&')) words.shift();
  const name = (words.shift() ?? '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
  if (!INTERPRETER.test(name)) return null;
  let testFlag = false;
  for (let i = 0; i < words.length; i++) {
    if (CODE_FLAGS.test(words[i]) || words[i] === '-') return null;
    if (!words[i].startsWith('-')) return testFlag ? { name, script: words[i], test: true } : { name, script: words[i] };
    if (words[i] === '--test') testFlag = true;
    if (FLAGS_WITH_ARGUMENT.has(words[i])) i++;
  }
  return null;
}

function writesFiles(name, source) {
  return PYTHON_WORD.test(name) ? PY_WRITE.test(source) : JS_WRITE.test(source);
}

function isTracked(file) {
  try {
    execFileSync('git', ['-C', dirname(file), 'ls-files', '--error-unmatch', '--', basename(file)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function repoRootOf(file) {
  try {
    return execFileSync('git', ['-C', dirname(file), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const MAX_TRACKED_FILES = 50000;
const SCRATCH_PREFIX = 'tmp/';
const TEST_FILE = /\.test\.[a-z]+$/i;

// Whether the source names (relative to the repo root, or absolute) a file the repo tracks outside tmp/.
// Fails open (false) when the index cannot be listed or is huge.
export function namesTrackedFile(source, root) {
  let listing;
  try {
    listing = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return false;
  }
  const files = listing.split('\0').filter((f) => f && !f.startsWith(SCRATCH_PREFIX));
  if (files.length > MAX_TRACKED_FILES) return false;
  const text = source.replaceAll('\\\\', '/').replaceAll('\\', '/');
  const base = root.replaceAll('\\', '/').replace(/\/$/, '');
  return files.some((f) => text.includes(f) || text.includes(`${base}/${f}`));
}

function resolveScript(script, base) {
  const drive = process.platform === 'win32' ? /^\/([a-z])\/(.*)$/i.exec(script) : null;
  const native = drive ? `${drive[1]}:/${drive[2]}` : script;
  return isAbsolute(native) ? native : resolve(base, native);
}

// Whether `file` is a fresh, untracked script in a repo whose source writes files.
export function isFreshWritingScript(name, file, now = Date.now(), runsAsTest = false) {
  if (!SCRIPT_EXTENSIONS.has(extname(file).toLowerCase())) return false;
  const stat = statSync(file);
  if (!stat.isFile() || now - stat.mtimeMs > FRESH_MS) return false;
  if (TEST_FILE.test(basename(file)) || runsAsTest) return false;
  const source = readFileSync(file, 'utf8');
  if (!writesFiles(name, source)) return false;
  const root = repoRootOf(file);
  return Boolean(root) && !isTracked(file) && namesTrackedFile(source, root);
}

// The first script of the command that breaks the rule, or null. A missing file is not a script yet.
export function findScript(command, cwd, now = Date.now()) {
  const lead = LEADING_CD.exec(command);
  const base = lead ? resolveScript(lead[1].replace(/^(['"])(.*)\1$/, '$2'), cwd) : cwd;
  for (const statement of statementsOf(command)) {
    const call = scriptArgument(statement);
    if (!call) continue;
    const file = resolveScript(call.script, base);
    try {
      if (isFreshWritingScript(call.name, file, now, call.test === true)) return call.script;
    } catch (error) {
      if (error.code !== 'ENOENT') process.stderr.write(`worktree-script-guard: could not read ${file} (${error.message})\n`);
    }
  }
  return null;
}

export function decide(input, now = Date.now()) {
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return null;
  const script = findScript(String(input.tool_input?.command ?? ''), input.cwd ?? process.cwd(), now);
  if (!script) return null;
  const reason = `worktree script guard: \`${script}\` is a helper script written in the last hour, not tracked by git, that writes files and names a file the repo tracks. Agents change files only with the Edit or Write tool (a script's writes are invisible to the guards and can flip line endings or truncate a file; Slice 307). Make the change with Edit. If the script only needs to write a report, print it and redirect stdout (\`node ${script} > tmp/out.txt\`), or commit the script under tools/ so it is tracked.`;
  return advisory(reason);
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo (see entry-points.test.mjs).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch (error) {
    process.stderr.write(`worktree-script-guard: realpath failed (${error.message}); comparing plain paths\n`);
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    emit('worktree-script-guard', decide(input), input.cwd ?? process.cwd());
  } catch (error) {
    process.stderr.write(`worktree-script-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
