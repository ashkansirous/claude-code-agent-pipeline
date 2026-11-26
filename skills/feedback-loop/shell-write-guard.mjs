#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell: refuses a command that WRITES A FILE with shell-generated text
// in which the shell itself changes the backslashes (or a raw control character lands in the file), so the
// file comes out corrupted. Write the text with the Write or Edit tool, or write a script file with Write
// and run it. This runs on every call, so a false deny is worse than a miss. Forms refused:
//   - an UNQUOTED heredoc (`cat > f <<EOF`, `cat <<EOF > f`, `tee f <<EOF`) whose body holds a backslash; a heredoc
//     with a quoted tag (<<'EOF', <<"EOF", <<\EOF) keeps backslashes literal, so only a raw control character counts;
//   - `sed -i` (also -i.bak, -i'') and `perl -i` / `-pi` whose s/// REPLACEMENT holds a backslash other than a
//     back-reference (\1-\9, \&); the regex side is fine;
//   - `echo` whose own output is redirected to a file or piped straight into tee, with a backslash (printf is not checked);
//   - `python -c` / `node -e` that calls a FILE write (open(..,'w'/'a'), writeFile, appendFile, write_text) with a backslash;
//   - PowerShell Set-Content / Out-File / Add-Content / `>` fed by an expandable here-string (@"..."@) whose body holds
//     a backtick, in the same statement. A single-quoted here-string (@'..'@) is literal and passes;
//   - a cat/tee heredoc of any kind APPENDED (`>>`, `tee -a`) to an existing file that uses CRLF: the LF lines would
//     mix the endings (the path is resolved against a leading `cd <dir> &&`, else the hook cwd).
//   - Slice 315: a python/node HEREDOC whose script writes a LITERAL path outside tmp/temp (open('f','w'), Path('f').write_text,
//     writeFileSync('f',..)) is ADVISORY (a warning, never a deny: the target is a regex guess), like a variable target or a node heredoc (below);
//   - Slice 307 (ADVISORY, never a deny: two strikes): inline PYTHON (`python -c`, or a heredoc feeding python/py) that
//     writes a file (open(..,'w'/'a'/'x'), write_text, write_bytes): the call is allowed, the model gets a warning
//     and advisory.mjs logs it;
//   - Slice 307: `sed -i` on an existing file that uses CRLF (Git for Windows' sed rewrites it with LF endings).
//   - Slice 393 item 8: `sed -i` / `perl -i` on a TRACKED file named by a literal path (the same answer as an inline script rewriting it).
// Never refused: a heredoc that feeds an interpreter (node, bash, sh, pwsh; python only when its body has no file write) or git/gh, whatever its
// output is redirected to; reads (grep 'a\|b', sed -n, sed without -i); stdout writes (process.stdout.write);
// a quoted Windows drive path ("C:\x") in an echo, and drive paths in commands that write no file; writes to /dev/null, /dev/stderr, /dev/stdout, $null or nul.
// Known misses (on purpose): echo/printf inside `if ...; then`, `for ...; do`, `{ }` or `$( )`; PowerShell plain
// strings (PowerShell does not rewrite backslashes); a here-string assigned to a variable and written later;
// an interpreter heredoc whose script writes a file; sed/perl run through xargs or find -exec.
// A CRLF-throughout command is read as LF. An internal error lets the call through (fail open), with a note on stderr.
// (2026-10-31, ReadTheStupidText: a raw CR in a slice file, a literal \r before every line end of
// branch-sweep/SKILL.md, and a heredoc that ate a backslash in question-stop.test.mjs.)
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { isAbsolute, resolve, relative, sep, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The advisory helper loads dynamically: when it is missing (a partial install) the hook fails open with a note.
let advisoryLib = null;
try { advisoryLib = await import('./advisory.mjs'); } catch (error) { process.stderr.write(`shell-write-guard: advisory.mjs unavailable (${error.message}); warnings off\n`); }
const advisory = (reason) => (advisoryLib ? advisoryLib.advisory(reason) : null);
const emit = (hook, verdict, cwd) => { if (advisoryLib) advisoryLib.emit(hook, verdict, cwd); };

const FORM = {
  heredoc: 'heredoc written to a file',
  sed: 'sed -i / perl -i edit',
  echo: 'echo redirected to a file',
  oneLiner: 'python -c / node -e one-liner that writes a file',
  hereString: 'PowerShell here-string written to a file',
  inlinePython: 'inline Python (python -c or a python heredoc) or a node heredoc that writes a file',
  scriptHeredoc: 'python/node heredoc that writes a file at a path it names',
};
// Slice 307: a Python file write in inline code (any text, not only with a backslash): open(..,'w'/'a'/'x'), write_text, write_bytes.
const PY_WRITE = /\.write_text\(|\.write_bytes\(|\bopen\([^)]*['"][wax]\+?b?['"]|\bmode\s*=\s*['"][wax]/;
// A Python write passes when every path literal in the code is under a tmp/ or temp folder (or, with no path
// literal at all, the code uses tempfile/gettempdir/TEMP): scratch output cannot corrupt a source file. Code whose
// target is a variable or any other path is still refused (Slice 307).
const STRING_LITERAL = /(["'])((?:\\.|(?!\1).)*)\1/g;
const PATH_LIKE = /[\\/]|\.\w{1,5}$/;
// One rule (Slice 315, round 2): a path is scratch iff, resolved to an absolute path against the command's cwd, it lies under
// <root>/tmp or <root>/temp (<root> = the git worktree root of that cwd) or under the OS temp dir. `src/tmp/A.cs` is repo code.
const OS_TEMP_SPELLING = /[\\/]AppData[\\/]Local[\\/]Temp[\\/]|^\/tmp\//i;
const worktreeRoots = new Map();
const GIT_ROOT_TIMEOUT_MS = 3000; // a hung git must not block the hook: on timeout or error the cwd is the root
export function worktreeRoot(cwd, runGit = spawnSync) {
  if (!worktreeRoots.has(cwd)) {
    const run = runGit('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: GIT_ROOT_TIMEOUT_MS });
    worktreeRoots.set(cwd, !run.error && run.status === 0 ? run.stdout.trim() : null);
  }
  return worktreeRoots.get(cwd);
}
function isUnder(dir, file) {
  const rel = relative(resolve(dir), file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
function isScratchPath(path, cwd) {
  if (OS_TEMP_SPELLING.test(path)) return true;
  const file = resolve(cwd, path);
  const root = worktreeRoot(cwd) ?? cwd; // outside any git worktree the cwd itself is the root
  const homes = [tmpdir(), resolve(root, 'tmp'), resolve(root, 'temp')];
  return homes.some((dir) => isUnder(dir, file));
}
const TEMP_API = /\btempfile\b|\bgettempdir\b|\bTEMP\b|\bTMP\b/;
// The string literals of the code; a literal that itself holds quotes is the shell's quoting of the code, so its inside is read instead.
function literalsOf(text) {
  return [...text.matchAll(STRING_LITERAL)].flatMap((m) => (/["']/.test(m[2]) ? literalsOf(m[2]) : [m[2]]));
}
function pythonWritesOnlyScratch(text, cwd) {
  const paths = literalsOf(text).filter((s) => PATH_LIKE.test(s));
  if (paths.length === 0) return TEMP_API.test(text);
  return paths.every((p) => isScratchPath(p, cwd));
}
function pythonWritesFile(text, cwd) {
  return PY_WRITE.test(text) && !pythonWritesOnlyScratch(text, cwd);
}
// Slice 315 item 19: Node writes in a heredoc (`node - <<'EOF'`), advisory like Python's.
const NODE_WRITE = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\b/;
function nodeWritesFile(text, cwd) {
  return NODE_WRITE.test(text) && !pythonWritesOnlyScratch(text, cwd);
}
// A heredoc script that writes a LITERAL path outside tmp/temp: open('src/A.cs','w'), Path('f').write_text, writeFileSync('f', ..).
// A variable target is not seen (advisory only): a false deny on every call is worse than a miss.
const LITERAL = String.raw`(['"\x60])((?:\\.|(?!\1).)*)\1`;
const PY_OPEN_TARGET = new RegExp(String.raw`\bopen\(\s*(?:[rbfu]{0,2})${LITERAL}\s*,\s*(?:mode\s*=\s*)?['"][wax]`, 'g');
const PY_PATH_TARGET = new RegExp(String.raw`\bPath\(\s*${LITERAL}\s*\)\.write_(?:text|bytes)\(`, 'g');
const NODE_TARGET = new RegExp(String.raw`\b(?:writeFile|writeFileSync|appendFile|appendFileSync)\(\s*${LITERAL}`, 'g');
function writesLiteralRepoPath(text, isPython, cwd) {
  const patterns = isPython ? [PY_OPEN_TARGET, PY_PATH_TARGET] : [NODE_TARGET];
  return patterns.some((pattern) => [...text.matchAll(pattern)].some((m) => !isScratchPath(m[2], cwd)));
}
const BAD_TEXT = /\\|[\x00-\x08\x0b-\x1f\x7f]/;
const CONTROL_TEXT = /[\x00-\x08\x0b-\x1f\x7f]/;
const HEREDOC_TAG = /(?<!<)<<(-?)[ \t]*(?:(['"])([A-Za-z_]\w*)\2|\\([A-Za-z_]\w*)|([A-Za-z_]\w*))/g;
const HERE_STRING = /@(['"])[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1@/g;
const HERE_STRING_MARK = '__BAD_HERE_STRING__';
const REDIRECT_TO_FILE = /(?<![0-9<>=-])>>?[ \t]*(?!&|\/dev\/(?:null|stderr|stdout|stdin|tty)(?![\w.\/])|\$null|nul(?![\w.]))[^\s>]/i;
const PIPE_TO_TEE = /\btee\b(?:[ \t]+-\w+)*[ \t]+(?!\/dev\/(?:null|stderr|stdout|stdin|tty)(?![\w.\/]))[^\s|;&-]/;
const HARMLESS_BACKREF = /(?<!\\)\\[1-9&]/g;
const POWERSHELL_WRITER = /\b(Set-Content|Out-File|Add-Content|WriteAllText|WriteAllLines|AppendAllText)\b/i;
const WRITE_CALL = /\b(writeFile(Sync)?|appendFile(Sync)?|write_text|write_bytes)\b|\bopen\([^)]*['"][wax]\+?b?['"]/;
// Only a real in-place flag: -i, -ni, -i.bak, --in-place; never a long option or word such as -input (an optional backup suffix starts with . or ~).
// A combined short flag containing i counts (-ni, -ie, -is, -iE: sed's short options are n E r s z u e i); GNU reads what follows i as the backup suffix.
const SED_IN_PLACE_FLAG = /^(?:-[nErszu]*i[nErszue]*(?:[.~][\w.~-]*|''|"")?|--in-place(?:=\S*)?)$/;
// perl bundles no-argument switches (-wpi, -pie, -in: everything after i is the backup suffix, so those are in place). Only switches that take no value and keep running may precede i:
// never -v or -c (print/check and exit), -M, -I, -e, -E, -x, -F, -C, -d, -D (they take an argument or end the run).
const PERL_IN_PLACE_FLAG = /^-[planwWtTuUsS0-9]*i(?:[.~][\w.~-]*|\w?)$/;
const PYTHON_WORD = /^(?:python3?(?:\.\d+)?|py)$/;
const PYTHON_CODE_FLAG = /^-[A-Za-z]*c$/;
const NODE_CODE_FLAG = /^(?:-e|-p|-pe|--eval|--print)$/;
const FLAGS_WITH_ARGUMENT = new Set(['-X', '-W', '-r', '--require', '--import', '--loader', '--input-type']);
const HEREDOC_WRITERS = new Set(['cat', 'tee']);
const QUOTED_ECHO_PATH = /\b[A-Za-z]:(?:\\[\w.-]+)+/g;
const ECHO_ESCAPE_FLAG = /^-[a-zA-Z]*e[a-zA-Z]*$/;
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;
const LEADING_CD = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&/;
const APPEND_TARGET = /(?<![0-9<>=-])>>[ \t]*("[^"]+"|'[^']+'|[^\s;&|<>]+)/;
const TEE_APPEND_TARGET = /\btee\s+(?:-a|--append)\s+("[^"]+"|'[^']+'|[^\s;&|<>]+)/;

function commandOf(input) {
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return null;
  return String(input.tool_input?.command ?? '');
}

// A command that uses CRLF throughout is read as LF, so a Windows-style line end is not taken for a stray CR.
function normalizeLineEnds(command) {
  const lf = (command.match(/\n/g) ?? []).length;
  const crlf = (command.match(/\r\n/g) ?? []).length;
  return lf > 0 && lf === crlf ? command.replace(/\r\n/g, '\n') : command;
}

function stripQuotes(text) {
  return text.replace(/"[^"]*"|'[^']*'/g, '""');
}

function hasBadText(text) {
  return BAD_TEXT.test(text);
}

// A quoted drive path ("D:\x") keeps its backslashes in a bash echo without -e; an unquoted one loses
// them. Only single backslashes between plain name characters count, so "\$" or "\\" is still seen.
function hasBadTextOutsideQuotedPaths(text, args) {
  if (args.some((arg) => ECHO_ESCAPE_FLAG.test(arg))) return hasBadText(text);
  // $'..' expands escapes like \t and \x41, so its paths are not exempt.
  return hasBadText(text.replace(/(\$?)("[^"]*"|'[^']*')/g, (quoted, ansi) => (ansi ? quoted : quoted.replace(QUOTED_ECHO_PATH, ''))));
}

function writesToFile(line) {
  const bare = stripQuotes(line);
  return REDIRECT_TO_FILE.test(bare) || PIPE_TO_TEE.test(bare);
}

// The program name and the words after it (quotes stripped), skipping leading VAR=value assignments.
function commandWords(segment) {
  const words = stripQuotes(segment).trim().split(/\s+/).filter(Boolean);
  while (words.length && ENV_ASSIGNMENT.test(words[0])) words.shift();
  const name = (words.shift() ?? '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
  return { name, args: words };
}

// Splits a command into its heredocs (command line, quoted tag, body) and the remaining lines.
// A tag with no terminating line is not a heredoc.
function extractHeredocs(command) {
  const lines = command.split('\n');
  const heredocs = [];
  const rest = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    rest.push(line);
    for (const tag of [...line.matchAll(HEREDOC_TAG)]) {
      const found = readHeredocBody(lines, i, tag);
      if (!found) continue;
      i = found.end;
      heredocs.push({ line, prefix: line.slice(0, tag.index), quoted: Boolean(tag[2] || tag[4]), body: found.body });
    }
  }
  return { heredocs, rest: rest.join('\n') };
}

function readHeredocBody(lines, start, tag) {
  const indented = tag[1] === '-';
  const name = tag[3] ?? tag[4] ?? tag[5];
  const body = [];
  for (let j = start + 1; j < lines.length; j++) {
    const next = lines[j].replace(/\r$/, '');
    if ((indented ? next.replace(/^\t+/, '') : next) === name) return { end: j, body: body.join('\n') };
    body.push(next);
  }
  return null;
}

// Splits on newline, ; and &&/|| outside quotes (and on a single pipe when asked); by default a pipe
// stays inside its statement so `echo ... | tee f` is seen whole.
function splitOutsideQuotes(command, splitPipes = false) {
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
    } else if (ch === '\n' || ch === ';' || pair === '&&' || pair === '||' || (splitPipes && ch === '|' && command[i - 1] !== '>')) {
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

// Text of the replacement side of every s<d>regex<d>replacement<d> command in a sed script.
function sedReplacements(text) {
  const found = [];
  for (const start of text.matchAll(/\bs([^\w\s\\'"])/g)) {
    const delim = start[1];
    const regexEnd = indexOfUnescaped(text, delim, start.index + 2);
    if (regexEnd < 0) continue;
    const replacementEnd = indexOfUnescaped(text, delim, regexEnd + 1);
    if (replacementEnd < 0) continue;
    found.push(text.slice(regexEnd + 1, replacementEnd).split('\\' + delim).join(''));
  }
  return found;
}

function indexOfUnescaped(text, char, from) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === char) return i;
  }
  return -1;
}

function sedForm(segment, args) {
  if (!args.some((arg) => SED_IN_PLACE_FLAG.test(arg.replace(/""$/, '')))) return null;
  if (CONTROL_TEXT.test(segment)) return FORM.sed;
  return replacementsHaveBackslash(segment) ? FORM.sed : null;
}

// A back-reference (\1-\9) or \& in a replacement is harmless; any other backslash, a drive path's
// included (sed reads D:\x as a hex escape), is rewritten.
function replacementsHaveBackslash(segment) {
  return sedReplacements(segment).some((r) => r.replace(HARMLESS_BACKREF, '').includes('\\'));
}

function perlForm(segment, args) {
  if (!args.some((arg) => PERL_IN_PLACE_FLAG.test(arg))) return null;
  if (CONTROL_TEXT.test(segment)) return FORM.sed;
  return replacementsHaveBackslash(segment) ? FORM.sed : null;
}

function isCodeFlagCall(name, args) {
  const isPython = PYTHON_WORD.test(name);
  if (!isPython && name !== 'node') return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (isPython ? PYTHON_CODE_FLAG.test(arg) : NODE_CODE_FLAG.test(arg)) return true;
    if (!arg.startsWith('-')) return false;
    if (FLAGS_WITH_ARGUMENT.has(arg)) i++;
  }
  return false;
}

// echo's text reaches a file only through its own redirect or a tee right after it, not a later command's redirect.
function echoWritesFile(segment, next) {
  if (REDIRECT_TO_FILE.test(stripQuotes(segment))) return true;
  return next !== undefined && commandWords(next).name === 'tee' && PIPE_TO_TEE.test(stripQuotes(next));
}

function segmentForm(segment, next, tool, cwd) {
  const { name, args } = commandWords(segment);
  if (name === 'sed') return sedForm(segment, args);
  if (name === 'perl') return perlForm(segment, args);
  if (name === 'echo' && tool !== 'PowerShell') {
    return echoWritesFile(segment, next) && hasBadTextOutsideQuotedPaths(segment, args) ? FORM.echo : null;
  }
  if (isCodeFlagCall(name, args)) {
    if (WRITE_CALL.test(segment) && hasBadText(segment)) return FORM.oneLiner;
    return PYTHON_WORD.test(name) && pythonWritesFile(segment, cwd) ? FORM.inlinePython : null;
  }
  return null;
}

function statementForm(statement, tool, hardOnly, cwd) {
  const segments = splitOutsideQuotes(statement, true);
  for (let i = 0; i < segments.length; i++) {
    const found = segmentForm(segments[i], segments[i + 1], tool, cwd);
    if (found && !(hardOnly && found === FORM.inlinePython)) return found;
  }
  return null;
}

// The program a heredoc feeds: the first word of the last command before its `<<`.
function heredocCommand(prefix) {
  const segments = splitOutsideQuotes(prefix, true);
  return commandWords(segments[segments.length - 1]).name;
}

function heredocBodyIsBad(heredoc) {
  return heredoc.quoted ? CONTROL_TEXT.test(heredoc.body) : hasBadText(heredoc.body);
}

function heredocForm(command, hardOnly, cwd) {
  const { heredocs, rest } = extractHeredocs(command);
  const hit = heredocs.some((h) => HEREDOC_WRITERS.has(heredocCommand(h.prefix)) && writesToFile(h.line) && heredocBodyIsBad(h));
  if (hit) return { form: FORM.heredoc, rest };
  const script = (h) => (PYTHON_WORD.test(heredocCommand(h.prefix)) ? 'python' : heredocCommand(h.prefix) === 'node' ? 'node' : null);
  const literal = heredocs.some((h) => script(h) && writesLiteralRepoPath(h.body, script(h) === 'python', cwd));
  if (literal) return { form: hardOnly ? null : FORM.scriptHeredoc, rest }; // advisory like the other guess-based rules
  const advisory = heredocs.some((h) => (script(h) === 'python' && pythonWritesFile(h.body, cwd)) || (script(h) === 'node' && nodeWritesFile(h.body, cwd)));
  return { form: advisory && !hardOnly ? FORM.inlinePython : null, rest };
}

// Replaces every here-string: an expandable one with a backtick becomes a marker, the rest become "".
function markHereStrings(command) {
  return command.replace(HERE_STRING, (all, quote, body) => (quote === '"' && body.includes('`') ? HERE_STRING_MARK : '""'));
}

// Only the statement that holds the marked here-string counts: it must be written to a file in that statement.
function hereStringForm(marked) {
  for (const statement of splitOutsideQuotes(marked)) {
    if (!statement.includes(HERE_STRING_MARK)) continue;
    if (markerFeedsWriter(statement)) return FORM.hereString;
  }
  return null;
}

// The here-string must be the input of the writer: an argument of Set-Content & co, or bare text piped or redirected to one.
function markerFeedsWriter(statement) {
  const segments = splitOutsideQuotes(statement, true);
  const at = segments.findIndex((s) => s.includes(HERE_STRING_MARK));
  const bare = stripQuotes(segments[at].replace(HERE_STRING_MARK, ''));
  if (POWERSHELL_WRITER.test(commandWords(bare).name)) return true;
  if (!segments[at].trim().startsWith(HERE_STRING_MARK)) return false;
  const next = segments[at + 1];
  return REDIRECT_TO_FILE.test(bare) || (next !== undefined && POWERSHELL_WRITER.test(commandWords(next).name));
}

// The name of the refused form, or null when the command is fine. `tool` is 'Bash' or 'PowerShell'.
// `hardOnly` skips the advisory inline-Python form, so a hard form later in the same command is still found.
export function shellWriteForm(command, tool = 'Bash', hardOnly = false, cwd = process.cwd()) {
  if (!command) return null;
  const { form, rest } = heredocForm(normalizeLineEnds(command), hardOnly, cwd);
  if (form) return form;
  const marked = markHereStrings(rest);
  const hereString = hereStringForm(marked);
  if (hereString) return hereString;
  for (const statement of splitOutsideQuotes(marked.replaceAll(HERE_STRING_MARK, '""'))) {
    const found = statementForm(statement, tool, hardOnly, cwd);
    if (found) return found;
  }
  return null;
}

// A path from the command as node can open it: quotes off, a Git Bash /d/x turned into d:/x, relative to base.
function resolvePath(word, base) {
  const bare = word.replace(/^(['"])(.*)\1$/, '$2');
  const drive = process.platform === 'win32' ? /^\/([a-z])\/(.*)$/i.exec(bare) : null;
  const native = drive ? `${drive[1]}:/${drive[2]}` : bare;
  return isAbsolute(native) ? native : resolve(base, native);
}

// The part of a command line that holds the heredoc's `<<`, cut at `;`, `&&` and `||`, so a `>>` of another
// command on the same line is not read as the heredoc's target. (`cat <<EOF >> f` and `cat >> f <<EOF` both stay whole.)
function heredocStatement(line) {
  return line.split(/;|&&|\|\|/).find((part) => part.includes('<<')) ?? line;
}

// The files a cat/tee heredoc appends to (`cat >> f <<EOF`, `tee -a f <<EOF`), resolved against a leading
// `cd <dir> &&` or the cwd.
function heredocAppendTargets(command, cwd) {
  const lead = LEADING_CD.exec(command);
  const base = lead ? resolvePath(lead[1], cwd) : cwd;
  const targets = [];
  for (const h of extractHeredocs(normalizeLineEnds(command)).heredocs) {
    if (!HEREDOC_WRITERS.has(heredocCommand(h.prefix))) continue;
    const own = heredocStatement(h.line);
    const found = APPEND_TARGET.exec(own) ?? TEE_APPEND_TARGET.exec(own);
    if (found) targets.push(resolvePath(found[1], base));
  }
  return targets;
}

// Whether the command appends heredoc (LF) lines to an existing CRLF file. Unreadable files pass.
export function appendsLfToCrlf(command, cwd) {
  return heredocAppendTargets(command, cwd).some((file) => {
    try { return existsSync(file) && readFileSync(file, 'latin1').includes('\r\n'); } catch { return false; }
  });
}

// Words of a statement with quotes taken off (one word per quoted or bare run), for reading sed's file arguments.
function plainWords(statement) {
  return [...statement.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

// The files named by one `sed -i ...` statement: words that are neither flags, the script (the first plain
// word, unless -e/-f supplied it) nor the value of -e/-f/--expression/--file.
function sedFileArguments(words) {
  const files = [];
  let scriptSeen = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (/^(-e|-f|--expression|--file)$/.test(word)) { i++; scriptSeen = true; } else if (/^--(expression|file)=/.test(word)) scriptSeen = true;
    else if (word.startsWith('-') && word !== '-') continue;
    else if (!scriptSeen) scriptSeen = true;
    else files.push(word);
  }
  return files;
}

// Slice 307: Git for Windows' sed -i (msys; Linux GNU sed keeps the CR) writes its output with LF only, so on a CRLF file every line ending flips (2026-11-03:
// StoryVoicing.cs). The files a `sed -i` statement of the command rewrites, resolved like heredoc append targets.
function sedInPlaceTargets(command, cwd, tools = ['sed']) {
  const lead = LEADING_CD.exec(command);
  const base = lead ? resolvePath(lead[1], cwd) : cwd;
  const targets = [];
  for (const statement of splitOutsideQuotes(normalizeLineEnds(command), true)) {
    const words = plainWords(statement.trim());
    while (words.length && ENV_ASSIGNMENT.test(words[0])) words.shift();
    const name = commandWords(statement).name;
    const flag = name === 'perl' ? PERL_IN_PLACE_FLAG : SED_IN_PLACE_FLAG;
    if (!tools.includes(name) || !words.slice(1).some((w) => flag.test(w))) continue;
    targets.push(...sedFileArguments(words).map((file) => resolvePath(file, base)));
  }
  return targets;
}

// Whether the command runs `sed -i` on an existing CRLF file. Unreadable files pass.
export function sedFlipsCrlf(command, cwd) {
  return sedInPlaceTargets(command, cwd).some((file) => {
    try { return existsSync(file) && readFileSync(file, 'latin1').includes('\r\n'); } catch { return false; }
  });
}

// Slice 377 item 15: inline scripts that rewrite a TRACKED file at a literal path are denied (not advisory like the guesses above: the path is named and git knows it).
// Texts checked: a python/node heredoc body, a `python -c` / `node -e` command, and a scratch helper script run by name (`node tmp/fix.mjs`, `python tmp_fix.py`).
// A tracked generator run by name (`node tools/gen.mjs`) is not a helper and passes, as does any write to scratch, to an untracked file or to a variable path.
// Limit, on purpose: this is a best-effort nudge against the common inline-edit shape (a literal path in open()/writeFileSync()/write_text() in the
// command or a scratch helper already on disk), NOT a security boundary. Other spellings pass (a path held in a variable or built with path.join,
// renameSync/copyFileSync, createWriteStream, a helper written in the same command or run from another folder); a regex cannot close those without false denies.
const SCRIPT_FILE = /\.(?:mjs|cjs|js|py)$/i;
const HELPER_NAME = /(?:^|[\\/])(?:tmp|temp)[\\/]|(?:^|[\\/])(?:tmp|temp)_[^\\/]*$/i;
const SCRIPT_FILE_LIMIT = 500_000;
function isTrackedFile(file, cwd, runGit = spawnSync) {
  const full = resolvePath(file, cwd); // Git Bash /d/x paths map to D:/x; the target may sit in another repo than the cwd
  return runGit('git', ['-C', dirname(full), 'ls-files', '--error-unmatch', '--', full], { encoding: 'utf8', timeout: GIT_ROOT_TIMEOUT_MS }).status === 0;
}
function readHelperScript(segment, cwd) {
  const words = plainWords(segment.trim());
  while (words.length && ENV_ASSIGNMENT.test(words[0])) words.shift();
  const name = (words.shift() ?? '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
  const isPython = PYTHON_WORD.test(name);
  if (!isPython && name !== 'node') return null;
  const file = words.find((w) => !w.startsWith('-'));
  if (!file || !SCRIPT_FILE.test(file) || !HELPER_NAME.test(file)) return null;
  try {
    const full = resolvePath(file, cwd);
    return existsSync(full) && readFileSync(full, 'utf8').length < SCRIPT_FILE_LIMIT ? { text: readFileSync(full, 'utf8'), isPython } : null;
  } catch { return null; }
}
function inlineScriptTexts(command, cwd) {
  const { heredocs } = extractHeredocs(normalizeLineEnds(command));
  const texts = heredocs.filter((h) => PYTHON_WORD.test(heredocCommand(h.prefix)) || heredocCommand(h.prefix) === 'node')
    .map((h) => ({ text: h.body, isPython: PYTHON_WORD.test(heredocCommand(h.prefix)) }));
  for (const segment of splitOutsideQuotes(normalizeLineEnds(command), true)) {
    const { name, args } = commandWords(segment);
    if (isCodeFlagCall(name, args)) texts.push({ text: segment, isPython: PYTHON_WORD.test(name) });
    const helper = readHelperScript(segment, cwd);
    if (helper) texts.push(helper);
  }
  return texts;
}
// Slice 21: a write through a variable that the same script assigns exactly once to a literal path
// (`p = 'tests/a.mjs'` ... `open(p, 'w')`, `const f = 'a.md'` ... `writeFileSync(f, ..)`, `Path(p).write_text(`, `f.write_text(`).
// A variable assigned twice or from anything but a literal is not followed (a miss, never a false deny).
const VAR_ASSIGN = new RegExp(String.raw`(?:^|[\s;(])(?:(?:const|let|var)\s+)?([A-Za-z_]\w*)\s*=\s*(?:Path\(\s*)?${LITERAL.replaceAll('\\1', '\\2')}\s*\)?`, 'g');
function variableWriteTargets(text, isPython) {
  const assigned = new Map();
  for (const m of text.matchAll(VAR_ASSIGN)) assigned.set(m[1], assigned.has(m[1]) ? null : m[3]);
  const writes = isPython
    ? [/\bopen\(\s*([A-Za-z_]\w*)\s*,\s*(?:mode\s*=\s*)?['"][wax]/g, /\bPath\(\s*([A-Za-z_]\w*)\s*\)\.write_(?:text|bytes)\(/g, /\b([A-Za-z_]\w*)\.write_(?:text|bytes)\(/g]
    : [/\b(?:writeFile|writeFileSync|appendFile|appendFileSync)\(\s*([A-Za-z_]\w*)\s*[,)]/g];
  const assignments = (name) => (text.match(new RegExp(String.raw`(?<![\w.])${name}\s*=(?!=)`, 'g')) ?? []).length;
  return writes.flatMap((re) => [...text.matchAll(re)].map((m) => (assignments(m[1]) === 1 ? assigned.get(m[1]) : null))).filter((t) => typeof t === 'string');
}
function literalWriteTargets(text, isPython) {
  const patterns = isPython ? [PY_OPEN_TARGET, PY_PATH_TARGET] : [NODE_TARGET];
  return [...patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[2])), ...variableWriteTargets(text, isPython)];
}
// The tracked file an inline script of the command rewrites at a literal path, or null.
export function inlineScriptTrackedTarget(command, cwd, runGit = spawnSync) {
  if (!command) return null;
  const lead = LEADING_CD.exec(command);
  const base = lead ? resolvePath(lead[1], cwd) : cwd; // targets resolve against a leading `cd <dir> &&`, like sed -i and the append checks
  for (const { text, isPython } of inlineScriptTexts(command, base)) {
    const hit = literalWriteTargets(text, isPython).find((t) => !isScratchPath(t, base) && isTrackedFile(t, base, runGit));
    if (hit) return hit;
  }
  return null;
}

const SED_CRLF_REASON = 'shell write guard: `sed -i` rewrites a CRLF file with LF line endings (the sed of Git for Windows drops the CR; 2026-11-03: it flipped StoryVoicing.cs). Change the file with the Edit tool, which keeps its endings.';
const INLINE_PYTHON_REASON = 'shell write guard: this runs inline Python that writes a file. Agents change files only with the Edit or Write tool (a helper script cannot be seen by the guards, and Python rewrites line endings). Write the file with Write, or read-only Python is fine (Slice 307).';
const CRLF_APPEND_REASON = 'shell write guard: this heredoc appends LF lines to a file that uses CRLF, so the file would end with mixed line endings (2026-11-01: it happened twice in one feedback loop). Add the text with the Edit tool, which keeps the file\'s endings.';

const SCRIPT_HEREDOC_REASON = 'shell write guard (advisory, the call is allowed): this heredoc feeds Python or Node a script that writes a file at a path it names (outside tmp/). If that path is in the repo, use the Write or Edit tool instead: a script\'s writes are invisible to the other guards and can flip line endings or truncate a file (Slice 315 item 19: index agents rewrote repo files with `python -I - <<EOF`). Scratch output under tmp/ or outside the repo is fine.';

function reasonFor(form) {
  return `shell write guard: this command writes a file with shell-generated text where the shell rewrites a backslash or a raw control character lands in the file (${form}). The file would come out corrupted. Use the Write or Edit tool for this text, or write a script file with Write and run it; read the file back if a shell wrote it.`;
}

// The warning (never a deny) for a guess-based form: inline Python that writes a file, or a script heredoc naming a literal path.
function advisoryFor(form) {
  if (form === FORM.scriptHeredoc) return advisory(SCRIPT_HEREDOC_REASON);
  return form === FORM.inlinePython ? advisory(INLINE_PYTHON_REASON) : null;
}

// Slice 393 item 8: `sed -i` / `perl -i` is the same inline edit of a tracked file as an inline script, so it gets the same answer (before, only a backslash
// replacement or a CRLF file was denied and every other `sed -i` passed). The target must be named as a literal path git tracks; scratch and untracked files pass.
export function sedTrackedTarget(command, cwd, runGit = spawnSync) {
  if (!command) return null;
  const lead = LEADING_CD.exec(command);
  const base = lead ? resolvePath(lead[1], cwd) : cwd;
  return sedInPlaceTargets(command, cwd, ['sed', 'perl']).find((file) => !isScratchPath(file, base) && isTrackedFile(file, base, runGit)) ?? null;
}

function inlineTrackedReason(command, cwd) {
  const target = inlineScriptTrackedTarget(command, cwd);
  if (target) return `shell write guard: this inline Python or Node script rewrites the tracked file ${target}. Agents change files only with the Edit or Write tool (a script's writes are invisible to the other guards, flip line endings and can truncate a file; Slice 377 item 15). Make the change with Edit, or write to a path under tmp/.`;
  const sed = sedTrackedTarget(command, cwd);
  return sed ? `shell write guard: \`sed -i\` / \`perl -i\` rewrites the tracked file ${sed}. Agents change tracked files only with the Edit tool, like every inline script (it keeps the line endings and a failed match is visible; Slice 393 item 8). Make the change with Edit, or write to a path under tmp/.` : null;
}

export function decide(input) {
  const command = commandOf(input);
  const cwd = input.cwd ?? process.cwd();
  const form = shellWriteForm(command, input.tool_name, true, cwd);
  const soft = form ? null : shellWriteForm(command, input.tool_name, false, cwd);
  const reason = form ? reasonFor(form)
    : command && appendsLfToCrlf(command, cwd) ? CRLF_APPEND_REASON
      : command && sedFlipsCrlf(command, cwd) ? SED_CRLF_REASON : inlineTrackedReason(command, cwd);
  if (!reason) return advisoryFor(soft);
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// Compares real paths: ~/.claude/skills/<name> is a copy of, or a symlink to, the AgentPipeline repo.
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const verdict = decide(input);
    if (verdict && !verdict.hookSpecificOutput.permissionDecision) emit('shell-write-guard', verdict, input.cwd ?? process.cwd());
    else if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`shell-write-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
