#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell: `gh pr merge` is refused for a PR that changes code unless its
// body has a `## Review` section naming at least two distinct review files (paths ending .md under a
// `reviews/` folder), each existing on disk, one whose name contains `high` (or `pass-1`) and one whose name
// contains `medium` (or `pass-2`). A PR whose every changed file is docs (Markdown, skill and agent .md files
// included, or any file under a docs/design/ folder: Claude Design mocks) is docs-only and passes. Any error reading the PR lets the call through (fail open) with the
// reason on stderr.
// It also checks coverage: every changed code file (not Markdown, not under docs/design/) must appear, with the blob sha it has at the PR
// head, in the `Reviewed files:` block (`<path> <git blob sha>`, `<path> deleted` for deletions) of ANY listed
// review file. The sha may also be the file's blob at the PR branch's last own (non-merge, first-parent) commit
// that touched it, so merging origin/main into the branch never causes a denial; a later non-merge commit does.
// A file missing from every block or with another sha means code changed after the last review: run a check
// pass and list it. If git cannot resolve the head, the coverage check is skipped (the call is let through) with
// the reason on stderr. A PR in another repo than the hook cwd's origin is checked the same way, with the head
// blobs read from the API (one `gh api repos/<o>/<r>/contents/<path>?ref=<sha>` per path, at the head and at the PR's last
// own commit from `pulls/<n>/commits`; a path is deleted only on `HTTP 404` in gh's stderr); any other API error fails open.
// (Three nights in a row a PR merged with no review pass on record.)
// The PR is looked up, and review files and git are read, in the session cwd, even when `--repo`/`-R` or a PR URL pins
// the repo (the coverage check then reads the PR's files and blobs through the API for a PR in another repo). Every `gh pr merge`
// of the command is gated on its own, and any deny denies the whole call. A merge without --repo/-R/PR URL that comes
// after a directory-changing command (cd, cd.., cd-backslash, cd/d, pushd, popd, chdir, Set-Location, sl, Push-Location,
// Pop-Location, in command position; for a merge inside a for/while/until loop, anywhere in the command) is DENIED
// (fail closed), because the folder the merge runs in cannot be told: add `--repo <owner>/<repo>` to `gh pr merge`.
// A cd after the merge or in a heredoc body does not count. No cd chain is followed.
// While the repo's batch-release.json has an open batch (a base, started in the last 24 h), a merge without a `[skip ci]`
// `--subject`/`-t` is denied, docs-only included (an unplanned release starts otherwise; Slice 315 item 13), but only for a
// session that runs a wave (wave-gate `runsWave`: its transcript loaded run-wave/run-all-waves, or its session id is on the open
// wave's Opened line; an unreadable transcript counts as a wave session). A plain session merges normally and its pipeline runs
// (2026-11-25, ReadTheStupidText PR #1358 was forced to [skip ci] by another session's Wave 74).
// A merge the raw text shows in command position (line start, or after `&&`, `||`, `;`, `|`, `(`, `$(`, then, do, else, `{`;
// a line start inside a CLOSED quote is prose and does not count) that the tokenizer
// did not find (an unclosed quote or heredoc swallowed it, or a wrapper string like `bash -c "x && gh pr merge 5"`) is DENIED.
// Known limits (fail open, not seen or not understood): wrappers that hide the command in a string when the merge is not
// in command position inside it (cmd /c, bash -c, sh -c, pwsh -Command, eval), `env -C`/`--chdir`, `GH_REPO=o/r gh pr merge`, a merge in an assignment
// (`x=$(gh pr merge 5)`), an apostrophe in a shell comment
// (the tokenizer then hides the merge), gh called by full path, and one `--watch &&`/`--auto` in a multi-merge
// command exempting every merge's checks. Too strict: `(cd x && make); gh pr merge`, a cd after a merge inside a
// loop, and a same-repo `cd <worktree> && gh pr merge` are denied (add --repo). (merge-gate-cd2 reviews, 2026-11-01.)
// (2026-11-01: `cd /d/AgentPipeline && gh pr merge 125` was checked against the session repo's #125.)
// A repo may list `contentPaths` globs in `.claude/merge-gate.json` on its base branch (read with git in the hook cwd;
// ignored when --repo/-R/a PR URL names a repo other than the hook cwd's origin: strict): those files count as docs, e.g. Dino story content.
// A `gh pr merge` after `gh pr checks` in the same command joined by `;` or a newline is denied (the merge runs whatever the checks
// call returned; PR #272): join them with `&&`. For a code PR, every `docs/plan/slices/*.md` file it changes is run through
// feedback-loop/check-review-skips.mjs (its text at the PR head); a non-zero exit denies. Docs-only PRs skip both reviews and this check.
// Also (Slice 29): `gh pr create` of a non-draft PR whose literal body has no `## Test plan` heading is denied (item 26; a body the
// command does not show, `--fill`, `--web` and `--draft` claims pass); a merge is denied when the last `gh pr checks <n>` call of the
// session (`transcript_path` of the hook input, a subagent's own file when `agent_id` is set) failed with a non-zero exit, unless its output
// says "no checks reported" or the merge command waits for the checks itself (item 37; no transcript: fail open); and an allowed merge
// of a PR that changed plan.md, README.md, scope.md, a CLAUDE.md or docs/plan/ writes the pending-mirror marker (item 46).
// Every merge, docs-only included, also needs green checks: each entry of the PR's statusCheckRollup must have
// finished and passed (SUCCESS, SKIPPED or NEUTRAL; STALE is let through, CANCELLED is denied), unless the same command waits for them first with
// `gh pr checks <n> --watch ... && gh pr merge ...` (2026-11-01: a merge ran after a failed checks call, not chained).
import { readFileSync, statSync, realpathSync, mkdtempSync, writeFileSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reviewSectionLines } from '../feedback-loop/check-review-skips.mjs';
import { mark as markMirror, primaryRoot } from '../feedback-loop/mirror-due.mjs';
// Loaded guarded: a copy of this folder without .github/ must disable only the Selected-run acceptance (it then fails
// closed in selectedRunProblems), never the whole gate.
let selectAffected = null;
try { ({ selectAffected } = await import('../../.github/scripts/select-tests.mjs')); } catch { /* selectAffected stays null */ }
// Static, not a guarded top-level `await import`: wave-gate.mjs imports this file, and a top-level await inside that
// cycle never settles (the hook and its tests hang). A throw from wave-gate at call time is caught in sessionRunsWave,
// which then applies the batch denial (the old rule).
import { runsWave, ledgerPath, lastWave } from './wave-gate.mjs';

const SKIP_CHECK = fileURLToPath(new URL('../feedback-loop/check-review-skips.mjs', import.meta.url));
const SLICE_FILE = /^docs\/plan\/slices\/[^/]+\.md$/;

// A listed review file whose first line says the pass did not run (code-review-pass writes it; Slice 17 part I).
const INCOMPLETE_FIRST_LINE = /^\s*(?:#+\s*)?REVIEW INCOMPLETE/i;
// Slice 29 item 30: a findings file in which the reviewer admits, on one line, that it "did not check the diff ... against the slice".
// First person only ("I did not check ..."): a numbered finding that says the builder did not check something is a finding, not an admission.
const NOT_CHECKED_AGAINST_SLICE = /\bI\s+(?:did not|didn't)\s+(?:check|compare|read)\b[^\n]{0,120}\bagainst the slice\b/i;
// The line `.github/scripts/run-suite.mjs` writes into its summary (Slice 17 part B).
const SUITE_TREE_LINE = /^Suite code tree:[ \t]*([0-9a-f]{64})[ \t]*$/m;
const SUITE_FILES_LINE = /^Files run: (\d+) of (\d+); failed: (\d+)/m;
const SUITE_SUBSET_LINE = /^Subset run/m;
// Slice 30 item F: a `--changed` summary. It counts as the suite when it covers every file the selection names for the PR.
const SUITE_SELECTED_LINE = /^Selected run/m;
const SUITE_PASS_LINE = /^All files exited 0\.\s*$/m;

// A PR or diff with many thousand paths overflows Node's 1 MB default (ENOBUFS, night 2026-11-04-1441).
const MAX_BUFFER = 256 * 1024 * 1024;
const YOUNG_PR_MS = 90 * 1000;

const MIN_REVIEWS = 2;
const REVIEW_HEADING = /^##\s+Review\b.*$/im;
const NEXT_HEADING = /^##\s/m;
const MD_PATH = /[^\s`'"<>|*?()]+\.md/gi;
const IN_REVIEWS = /(^|[\\/])reviews[\\/]/i;
// Matched as a whole name segment (split on - _ . and spaces), so a slug like `highlight-fix` is no high pass.
// A review round number may follow the word (`s375bd-high6.md`): reviewers number later rounds that way (2026-11-14).
const HIGH_NAME = /(^|[-_. ])(high\d*|pass-1)(?=$|[-_. ])/i;
const MEDIUM_NAME = /(^|[-_. ])(medium\d*|pass-2)(?=$|[-_. ])/i;
// One text for the naming rule HIGH_NAME and MEDIUM_NAME accept, used by both denial messages.
const REVIEW_NAMING_RULE = 'one file named for the high pass (name contains `high`, `high<round>` such as `high6`, or `pass-1`) and another for the medium pass (`medium`, `medium<round>` or `pass-2`)';
// `Reviewed files:` on its own line, optionally after `#`s and/or wrapped in `**` (`**Reviewed files:**`).
const REVIEWED_HEADING = /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?Reviewed files:?(?:\*\*)?:?[ \t]*$/gim;
const GIT_TIMEOUT_MS = 20000;
const DELETED = 'deleted';
const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n']);
const SUBJECT_FLAGS = new Set(['-t', '--subject']);
const SKIP_CI = /\[skip ci\]/i;
const BATCH_STATE_FILE = 'batch-release.json';
const BATCH_OPEN_MAX_AGE_MS = 24 * 3600 * 1000;
const VALUE_FLAGS = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit']);
const GROUP_START = /^(?:\$?\(|\{)+/;
const GROUP_END = /[)}]+$/;
// A directory changer: the word, or cd/chdir/sl glued to dot-dot, backslash or slash (cd.., cd-backslash, cd/d), which PowerShell and cmd accept.
const DIR_CHANGER = /^(?:cd|chdir|sl|pushd|popd|set-location|push-location|pop-location)(?=$|\.\.|[\\/])/;
// Words that may stand before the command proper (`then cd x`, `! cd x`, `time cd x`).
const LEAD_WORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'time', 'builtin', 'command']);
// A leading `NAME=value` environment assignment (`FOO=1 cd x`) is skipped to reach the command word.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// A checks call that opens `if`, `elif`, `while` or `until` is a condition: the merge after it runs on its result.
const CONDITION_WORDS = new Set(['if', 'elif', 'while', 'until']);
const LOOP_WORDS = new Set(['for', 'while', 'until']);
const REPO_FLAGS = new Set(['-R', '--repo']);
const PASSING = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const AUTO_FLAGS = new Set(['--auto', '--disable-auto']);
// STALE (a superseded run) does not block; CANCELLED does (a check that never got a runner never turned green: rerun it).
const NOT_BLOCKING = new Set(['STALE']);
const PR_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/i;
const MARKDOWN_FILE = /\.md$/i;
const CONFIG_PATH = '.claude/merge-gate.json';
// Design mocks copied from Claude Design live in docs/design/; they run nowhere and
// count as docs like Markdown, whatever their extension (.html, .jsx, .css, .svg, .png). (2026-11-01.)
const DESIGN_FOLDER = /(^|\/)docs\/design\//i;
const WORKFLOW_FILE = /^\.github\/workflows\//;
const MERGED_STATE = 'MERGED';
// `gh pr view --json files` returns at most this many files; a list this long may be cut short.
const PR_FILES_CAP = 100;

// True for a file that is documentation, not code: any Markdown file, and anything under docs/design/.
// `contentPaths` are the repo's own globs from `.claude/merge-gate.json` (`**` any depth, `*` within a folder):
// files matching them (e.g. Dino story content) count as docs too.
export function isDocPath(path, contentPaths = []) {
  const normal = String(path ?? '').replace(/\\/g, '/');
  return MARKDOWN_FILE.test(normal) || DESIGN_FOLDER.test(normal) || contentPaths.some((g) => globToRegExp(g).test(normal));
}

export function globToRegExp(glob) {
  const parts = String(glob).replace(/\\/g, '/').replace(/^\.?\//, '').split(/(\*\*\/|\*\*|\*)/);
  const body = parts.map((part) => {
    if (part === '**/') return '(?:.*/)?';
    if (part === '**') return '.*';
    if (part === '*') return '[^/]*';
    return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${body}$`, 'i');
}

// The `contentPaths` array of `.claude/merge-gate.json` as it is on the PR's base branch (never the PR's own
// copy, so a PR cannot exempt itself); [] when the file is missing, unreadable or malformed (strict).
const MISSING_CONFIG = /does not exist in|exists on disk, but not in|invalid object name|unknown revision|bad revision/;

// A missing config is normal ([]); one that exists but cannot be read or parsed is reported through `warn` (when given).
export function contentPathsFor(pr, cwd, git = runGit, warn = null) {
  try {
    const base = `origin/${pr.baseRefName || 'main'}`;
    const list = JSON.parse(git(cwd, ['show', `${base}:${CONFIG_PATH}`])).contentPaths;
    return Array.isArray(list) ? list.filter((g) => typeof g === 'string' && g) : [];
  } catch (error) {
    const text = `${error.message}\n${error.stderr ?? ''}`;
    if (warn && (error instanceof SyntaxError || !MISSING_CONFIG.test(text))) warn(`${CONFIG_PATH} on origin/${pr.baseRefName || 'main'} could not be read (${String(error.message).split('\n')[0]}); every changed file is treated as code\n`);
    return [];
  }
}

// Splits a command into word tokens (quotes removed) and separator tokens, outside quotes.
export function tokenize(command) {
  const tokens = [];
  let word = null;
  const flush = () => { if (word !== null) tokens.push(word); word = null; };
  const text = String(command ?? '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      const stop = end === -1 ? text.length : end;
      word = (word ?? '') + text.slice(i + 1, stop);
      i = stop;
    } else if (/\s/.test(c) && c !== '\n') flush();
    else if (c === '\n' || c === ';') { flush(); tokens.push(c); }
    else if ((c === '&' || c === '|') && text[i + 1] === c) { flush(); tokens.push(c + c); i++; }
    else if (c === '|' || c === '&') { flush(); tokens.push(c); }
    else word = (word ?? '') + c;
  }
  flush();
  return tokens;
}

function segments(tokens) {
  const out = [[]];
  for (const t of tokens) {
    if (SEPARATORS.has(t)) out.push([]);
    else out[out.length - 1].push(t);
  }
  return out;
}

// `--repo=o/r`, `-Ro/r`, or the flag followed by its value; returns { repo, next } or null.
function repoFlag(words, i) {
  const word = words[i];
  if (REPO_FLAGS.has(word)) return { repo: words[i + 1], next: i + 2 };
  const eq = /^--repo=(.+)$/.exec(word);
  if (eq) return { repo: eq[1], next: i + 1 };
  const glued = /^-R(.+)$/.exec(word);
  return glued ? { repo: glued[1], next: i + 1 } : null;
}

// The selector (number, URL or branch) and -R of one `gh [-R r] pr merge ...` segment, or null.
function mergeInSegment(raw) {
  const words = unwrap(raw);
  let i = words.findIndex((w) => /^(?:\$?\()?gh(\.exe)?$/i.test(w));
  if (i === -1) return null;
  i++;
  let repo;
  while (i < words.length && words[i] !== 'pr') {
    const flag = repoFlag(words, i);
    if (!flag) return null;
    repo = trimGroupEnd(flag.repo);
    i = flag.next;
  }
  if (words[i] !== 'pr' || words[i + 1] !== 'merge') return null;
  let selector;
  let subject = '';
  for (i += 2; i < words.length;) {
    const flag = repoFlag(words, i);
    if (flag) { repo = trimGroupEnd(flag.repo); i = flag.next; continue; }
    if (SUBJECT_FLAGS.has(words[i])) subject += ` ${words[i + 1] ?? ''}`;
    const glued = /^--subject=(.*)$/.exec(words[i]);
    if (glued) subject += ` ${glued[1]}`;
    if (VALUE_FLAGS.has(words[i])) { i += 2; continue; }
    if (words[i].startsWith('-')) { i++; continue; }
    selector ??= trimGroupEnd(words[i]);
    i++;
  }
  return { selector, repo, subject: subject.trim() };
}

// A selector or --repo value without the `)` / `}` that closes a group the merge sits in.
function trimGroupEnd(value) {
  return typeof value === 'string' ? value.replace(GROUP_END, '') : value;
}

// A segment's words without a leading `(`, `$(` or `{` group opener, so `(gh pr merge 5)` is seen.
function unwrap(words) {
  const out = [...words];
  while (out.length && /^(?:\$?\(|\{)+$/.test(out[0])) out.shift();
  if (out.length) out[0] = out[0].replace(GROUP_START, '');
  return out;
}

const MERGE_FLAG = String.raw`(?:\s+(?:-R|--repo)(?:\s+|=)\S+)?`;
// Command position also follows `then`, `do`, `else`, `elif`, `!` and `{` (`if x; then gh pr merge 5`), which the tokenizer
// finds when it is not swallowed by an unclosed quote (Slice 306 known limit).
const RAW_LEAD = String.raw`(?:(?:then|do|else|elif|!|\{)[ \t]+)*`;
const RAW_MERGE = new RegExp(String.raw`(?:^|&&|\|\||;|\||\(|\$\()[ \t]*${RAW_LEAD}gh(?:\.exe)?${MERGE_FLAG}[ \t]+pr${MERGE_FLAG}[ \t]+merge(?![\w-])`, 'gm');

// [start, end) of every quoted string that is closed; an unclosed quote ends the scan (what it swallows stays unknown).
function closedQuoteSpans(text) {
  const spans = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"' && text[i] !== "'") continue;
    const end = text.indexOf(text[i], i + 1);
    if (end === -1) break;
    spans.push([i, end]);
    i = end;
  }
  return spans;
}

// A quote opened right after a message/body flag carries prose (`git commit -m "..."`, `gh pr create --body "..."`).
// Any other closed quote (`bash -c "..."`, `pwsh -Command "..."`, `python -c "..."`) may be a wrapper that runs its lines.
const PROSE_FLAG_BEFORE_QUOTE = /(?:^|\s)(?:-m|-am|--message|--body|--title|-b|--notes)(?:=|[ \t]+)$/;

// A match that starts a line inside a closed quoted string opened by a prose flag is prose (a commit message or note that
// quotes the command on its own line), not a command. A merge after `&&`, `;` ... inside a quote, or on any line of a wrapper
// string (`bash -c "set -e\ngh pr merge 5"`), still counts.
function isQuotedProseLine(match, text, spans) {
  const startsLine = match.index === 0 || text[match.index - 1] === '\n';
  if (!startsLine || !/^[ \t]*gh/.test(match[0])) return false;
  return spans.some(([from, to]) => match.index > from && match.index < to && PROSE_FLAG_BEFORE_QUOTE.test(text.slice(0, from)));
}

const SEARCH_COMMANDS = ['grep', 'egrep', 'fgrep', 'rg'];
// Flags that take no value, so the next word is not their argument (`-n`, `-rin`, `--ignore-case`). Flags that take a value
// (`-A 3`, `-f file`, `rg --pre cmd`) are absent on purpose: a quote after them is not known to be the pattern.
const PLAIN_SEARCH_FLAG = String.raw`(?:-[inclLhHrREFGwxoqsaIZzUP]+|--(?:ignore-case|line-number|count|no-filename|with-filename|recursive|fixed-strings|extended-regexp|word-regexp|files-with-matches|only-matching|quiet|no-messages|invert-match))`;
const SEARCH_PREFIX = new RegExp(String.raw`^\s*(?:${SEARCH_COMMANDS.join('|')})(?:\s+${PLAIN_SEARCH_FLAG})*\s+(?:(?:-e|--regexp)\s+)?$`);
// Outside quotes the shell may escape, run or background something: a backslash, a lone `&` (not the `&` of `2>&1` or `>&2`), `$(`, a backtick, `<(` or `>(`.
const UNSAFE_OUTSIDE_QUOTES = /\\|\$\(|`|<\(|>\(|(?<![>&])&(?!&)/;

// Outside quotes, an unquoted newline or a `#` starting a word (a shell comment) means the command is not one line: a quote
// opened in a comment could be mistaken for a pattern while the shell runs a later line, so the exemption needs neither.
const SINGLE_LINE_BREAKERS = /\n|(?:^|[\s;&|(])#/;

// The command with every closed quoted string removed (a double-quoted one that held a backslash leaves a single `\` behind:
// a backslash inside a double quote can hide a quote end), so what is left is what the shell reads unquoted.
function unquoted(text, spans) {
  let out = '';
  let at = 0;
  for (const [from, to] of spans) {
    out += text.slice(at, from);
    if (text[from] === '"' && text.slice(from, to).includes('\\')) out += '\\';
    at = to + 1;
  }
  return out + text.slice(at);
}

// Where the command segment holding position `at` starts: just after the last `&&`, `||`, `;`, `|` or newline before it
// that is not inside a closed quote.
function segmentStart(text, at, spans) {
  let start = 0;
  for (const m of text.slice(0, at).matchAll(/&&|\|\||[;|\n]/g)) {
    if (!spans.some(([from, to]) => m.index > from && m.index < to)) start = m.index + m[0].length;
  }
  return start;
}

// A match inside a closed quote that is the pattern of a read-only search (`grep -n "&& gh pr merge" file`) is data, not a
// command. Spared only when (a) the segment's command is grep, egrep, fgrep or rg, (b) the whole command has no backslash, lone
// `&` (`2>&1` and `>&2` are fine), `$(`, backtick or `<(` outside quotes (and no `$(` or backtick in any double quote), and (c) the quote is the first
// non-flag argument or directly follows `-e`. Anything else keeps the denial (a miss here is a hole in the raw-text backstop).
function isSearchPattern(match, text, spans) {
  const span = spans.find(([from, to]) => match.index > from && match.index < to);
  if (!span) return false;
  const outside = unquoted(text, spans);
  if (UNSAFE_OUTSIDE_QUOTES.test(outside) || SINGLE_LINE_BREAKERS.test(outside)) return false;
  if (spans.some(([from, to]) => text[from] === '"' && /\$\(|`/.test(text.slice(from + 1, to)))) return false;
  return SEARCH_PREFIX.test(text.slice(segmentStart(text, span[0], spans), span[0]));
}

// Whether the RAW command text has `gh [-R r] pr [-R r] merge` in command position (line start, or right after
// `&&`, `||`, `;`, `|`, `(`, `$(`, then/do/else/elif/!/{). Used against hasMergeSegment: a merge the text shows but the tokenizer
// lost (an unclosed quote or heredoc swallowed it) is denied. No heredoc parsing; quotes only to spare quoted prose lines.
// A heredoc whose body is only written to a file or printed (`cat > f <<'EOF'`, the whole opener line is that, the delimiter quoted so
// nothing in the body expands) is data: a reviewer's findings that mention `gh pr merge` (or hold an apostrophe) are not a merge
// (Slice 23 item 14). `bash <<EOF` and any other opener keep the body, since the shell runs it.
const DATA_HEREDOC_OPEN = /^[ \t]*cat[ \t]*(?:>>?[ \t]*[^\s<>|;&'"`$()]+[ \t]*)?<<-?[ \t]*(['"])(\w+)\1[ \t]*(?:>>?[ \t]*[^\s<>|;&'"`$()]+[ \t]*)?\r?\n/m;
export function stripDataHeredocs(text) {
  let out = text;
  let from = 0;
  for (;;) {
    const open = DATA_HEREDOC_OPEN.exec(out.slice(from));
    if (!open) return out;
    const start = from + open.index;
    const bodyStart = start + open[0].length;
    const close = new RegExp(`^[ \\t]*${open[2]}[ \\t]*\\r?$`, 'm').exec(out.slice(bodyStart));
    if (!close) return out;
    out = `${out.slice(0, bodyStart)}${out.slice(bodyStart + close.index)}`;
    from = bodyStart + 1;
  }
}

export function rawMergeInCommandPosition(command) {
  const text = stripDataHeredocs(String(command ?? ''));
  const spans = closedQuoteSpans(text);
  return [...text.matchAll(RAW_MERGE)].some((match) => !isQuotedProseLine(match, text, spans) && !isSearchPattern(match, text, spans));
}

// Whether any segment of the command is a `gh [-R r] pr merge`, found with decide's tokenizer.
// The here-string quotes (`@'` ending a line, a line-start `'@`) are dropped first: an unclosed one would make the tokenizer swallow the rest.
function hasMergeSegment(command) {
  const text = String(command ?? '').replace(/@['"][ \t]*(\r?\n)/g, '$1').replace(/^['"]@/gm, '');
  // A heredoc that closes before the merge (`gh pr create --body-file - <<'EOF' ... EOF`, then `gh pr merge`) must not hide it: its
  // body, with an apostrophe in it, would otherwise open a quote the tokenizer never closes (Slice 29 item 53).
  return segments(tokenize(stripHeredocs(text, true))).some((words) => mergeInSegment(words));
}

// Drops the body of each heredoc (<<EOF ... EOF): it is data, not commands.
// closedOnly: stop at the first heredoc that never closes (quoted `<<EOF` prose) instead of dropping the rest of the text.
function stripHeredocs(text, closedOnly = false) {
  let out = text;
  for (;;) {
    const open = /<<[-~]?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n/.exec(out);
    if (!open) return out;
    const bodyStart = open.index + open[0].length;
    const close = new RegExp(`^[ \\t]*${open[2]}[ \\t]*\\r?$`, 'm').exec(out.slice(bodyStart));
    if (closedOnly && !close) return out;
    const bodyEnd = close ? bodyStart + close.index + close[0].length : out.length;
    const lineRest = open[0].slice(open[0].indexOf(open[2]) + open[2].length + open[1].length);
    out = `${out.slice(0, open.index)}${lineRest}${out.slice(bodyEnd)}`;
  }
}

// The command word of a segment (after group openers and then/do/else/!/time), lowercased, without a leading backslash.
function commandWord(words) {
  const skip = (w) => LEAD_WORDS.has(w.toLowerCase()) || ENV_ASSIGNMENT.test(w) || /^(?:\$?\(|\{)+$/.test(w);
  const at = words.findIndex((w) => !skip(w));
  const first = at === -1 ? '' : words[at];
  return first.replace(GROUP_START, '').replace(GROUP_END, '').replace(/^\\/, '').toLowerCase();
}

function segmentChangesDirectory(words) {
  return DIR_CHANGER.test(commandWord(words));
}

function startsLoop(words) {
  return LOOP_WORDS.has((words[0] ?? '').toLowerCase());
}

function commandSegments(command) {
  return segments(tokenize(stripHeredocs(String(command ?? ''))));
}

// Whether the command has a directory-changing command (cd, cd.., cd-backslash, cd/d, pushd, Set-Location, ...) in command
// position (segment start, or after then/do/else/!/time or a group opener). Quoted text, heredoc bodies and
// ordinary arguments (`git checkout cd`) are not one.
export function changesDirectory(command) {
  return commandSegments(command).some(segmentChangesDirectory);
}

function targetOf(found) {
  const url = found.selector ? PR_URL.exec(found.selector) : null;
  if (url) return { number: url[2], selector: found.selector, repo: found.repo ?? url[1], subject: found.subject };
  const number = /^#?\d+$/.test(found.selector ?? '') ? found.selector.replace('#', '') : undefined;
  return { number, selector: found.selector, repo: found.repo, subject: found.subject };
}

// The batch-release.json of the repo the hook runs in (next to its primary checkout, as batch-release.mjs writes it) when its
// batch is open: a base is recorded (a release clears it) and the batch's own last `start` (batchStartedAt, reset on every start)
// is under 24 h old (an older one is a forgotten leftover, not a live run; a state without the field is not enforced).
// null when there is no file, no open batch, or anything cannot be read.
export function openBatch(cwd, git = runGit, now = Date.now(), read = readFileSync) {
  try {
    const primary = dirname(resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir'])));
    const file = resolve(dirname(primary), `${basename(primary)}-worktrees`, BATCH_STATE_FILE);
    const state = JSON.parse(read(file, 'utf8'));
    const started = Date.parse(state.batchStartedAt ?? '');
    return state.baseSha && Number.isFinite(started) && now - started < BATCH_OPEN_MAX_AGE_MS ? { ...state, file } : null;
  } catch { return null; }
}

function batchDenial(number, batch) {
  const where = batch?.file ? `${batch.file}, batch started ${batch.batchStartedAt}` : BATCH_STATE_FILE;
  const reason = `merge gate: a batch release is open for this repo (${where}; the file sits beside the worktrees folder, not in the repo), so PR ${number ?? 'the current branch'} must merge with a [skip ci] subject, `
    + 'or it starts an unplanned release: add `--subject "Merge pull request #<n> from <branch> [skip ci]"` to `gh pr merge`.';
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// Every `gh pr merge` of the command: { number, selector, repo, cdBefore }. cdBefore: a directory change comes
// before that merge (one after it, or in a heredoc, cannot move it), or the merge is inside a loop that has one.
export function mergeTargets(command) {
  const segs = commandSegments(command);
  const merges = [];
  segs.forEach((words, index) => {
    const found = mergeInSegment(words);
    if (!found) return;
    const before = segs.slice(0, index);
    const scope = before.some(startsLoop) ? segs : before;
    merges.push({ ...targetOf(found), cdBefore: scope.some(segmentChangesDirectory) });
  });
  return merges;
}

// { number, selector, repo } of the first merge: number is set when the selector is a number or a PR URL; with
// no selector gh uses the current branch (number then comes from `gh pr view`).
export function mergeTarget(command) {
  const first = mergeTargets(command)[0];
  return first ? { number: first.number, selector: first.selector, repo: first.repo } : null;
}

// The words after `gh [-R r] pr checks` of one segment (the command must be gh, as in mergeInSegment), or null.
function checksArguments(raw) {
  const words = unwrap(raw);
  let i = words.findIndex((w) => /^(?:\$?\()?gh(\.exe)?$/i.test(w));
  if (i === -1) return null;
  i++;
  while (i < words.length && words[i] !== 'pr') {
    const flag = repoFlag(words, i);
    if (!flag) return null;
    i = flag.next;
  }
  return words[i] === 'pr' && words[i + 1] === 'checks' ? words.slice(i + 2) : null;
}

function isChecksWatch(words) {
  return Boolean(checksArguments(words)?.includes('--watch'));
}

// Whether a `gh pr checks ... --watch` segment is joined by && (directly or through more && segments)
// to the merge segment that follows it.
export function waitsForChecks(command) {
  const tokens = tokenize(command);
  let watched = false;
  let start = 0;
  for (let i = 0; i <= tokens.length; i++) {
    if (i < tokens.length && !SEPARATORS.has(tokens[i])) continue;
    const words = tokens.slice(start, i);
    if (mergeInSegment(words)) return watched;
    watched = (watched || isChecksWatch(words)) && tokens[i] === '&&';
    start = i + 1;
  }
  return false;
}

function isChecksCall(words) {
  return checksArguments(words) !== null;
}

// A `gh pr checks` call followed by a `gh pr merge` joined by `;` or a newline (blank lines between do not matter): the merge runs
// whatever the checks call returned (PR #272: the watch exited 1 with "no checks reported" and the merge ran anyway). Only this shape;
// `&&`, `||` and a pipe are left to the other rules.
export function mergeAfterUnchainedChecks(command) {
  const tokens = tokenize(command);
  let afterChecks = false;
  let looseOnly = true;
  let start = 0;
  for (let i = 0; i <= tokens.length; i++) {
    if (i < tokens.length && !SEPARATORS.has(tokens[i])) continue;
    const words = tokens.slice(start, i);
    if (words.length && mergeInSegment(words)) {
      // `--auto` / `--disable-auto`: GitHub itself waits for the checks, so the merge is safe after a failed checks call.
      if (afterChecks && looseOnly && !words.some((w) => AUTO_FLAGS.has(w))) return true;
      afterChecks = false;
    } else if (words.length && !words[0].startsWith('#')) {
      afterChecks = isChecksCall(words) && !CONDITION_WORDS.has(words[0].toLowerCase());
      looseOnly = true;
    }
    if (afterChecks && i < tokens.length && tokens[i] !== ';' && tokens[i] !== '\n') looseOnly = false;
    start = i + 1;
  }
  return false;
}

function unchainedDenial() {
  const reason = 'merge gate: `gh pr merge` follows `gh pr checks` in the same command joined by `;` or a newline, so the merge runs even when the checks call failed or was cut off. '
    + 'Join them with `&&`: `gh pr checks <n> --watch --fail-fast && gh pr merge <n> --merge`.';
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// `gh pr merge --auto` (GitHub merges only after required checks pass) or `--disable-auto` (merges nothing).
export function setsAutoMerge(command) {
  return segments(tokenize(command)).some((words) => mergeInSegment(words) && words.some((w) => AUTO_FLAGS.has(w)));
}

// Labels of the statusCheckRollup entries that are still running, failed or cancelled. Only STALE (a superseded
// run) does not block; a cancelled check is rerun, never merged past.
export function unfinishedChecks(rollup) {
  const result = (c) => String(c.conclusion || c.state || '').toUpperCase();
  return (rollup ?? []).filter((c) => !PASSING.has(result(c)) && !NOT_BLOCKING.has(result(c)))
    .map((c) => `${c.name ?? c.context ?? 'check'} (${c.conclusion || c.state || c.status || 'pending'})`);
}

export function isDocsOnly(files, contentPaths = []) {
  return files.length > 0 && files.every((file) => isDocPath(file.path, contentPaths));
}

export function reviewPaths(body) {
  const text = String(body ?? '');
  const start = REVIEW_HEADING.exec(text);
  if (!start) return [];
  const rest = text.slice(start.index + start[0].length);
  const end = rest.search(NEXT_HEADING);
  const section = end === -1 ? rest : rest.slice(0, end);
  return [...new Set((section.match(MD_PATH) ?? []).filter((p) => IN_REVIEWS.test(p)))];
}

// Git Bash writes C:\x as /c/x; node on Windows needs the drive form.
export function nativePath(text) {
  const drive = process.platform === 'win32' ? /^\/([a-z])\/(.*)$/i.exec(text) : null;
  return drive ? `${drive[1]}:/${drive[2]}` : text;
}

// Relative review paths are looked up in the cwd, the repo root of the cwd (the PR's worktree), that
// root's parent (where <worktree parent>/reviews/ lives) and the primary checkout's sibling
// `<repo>-worktrees` folder, so a merge run from the primary checkout finds `reviews/...` too
// (night 2026-11-17-1657: PR #90's merge was denied twice from the primary).
export function searchRoots(cwd) {
  const roots = [cwd];
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    roots.push(resolve(nativePath(top)), dirname(resolve(nativePath(top))));
    roots.push(...worktreesFolder(cwd));
  } catch { roots.push(dirname(resolve(cwd))); }
  return [...new Set(roots.map((r) => resolve(r)))];
}

// The `<primary>-worktrees` folder beside the primary checkout (found from the common git dir), or none.
function worktreesFolder(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const primary = dirname(resolve(cwd, nativePath(common)));
    return [resolve(dirname(primary), `${basename(primary)}-worktrees`)];
  } catch { return []; }
}

// The first search root where the file exists wins (else the cwd spelling); de-duplicated by resolved path,
// so two spellings of one file count once.
export function resolveReviews(paths, roots) {
  const bases = Array.isArray(roots) ? roots : [roots];
  const seen = new Map();
  for (const p of paths) {
    const candidates = bases.map((base) => resolve(base, nativePath(p)));
    const full = candidates.find((c) => onDisk(c)) ?? candidates[0];
    const key = process.platform === 'win32' ? full.toLowerCase() : full;
    if (!seen.has(key)) seen.set(key, { written: p, full });
  }
  return [...seen.values()];
}

function onDisk(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

// sha256 of the sorted `<path> <blob sha>` lines of the code files (docs excluded) in a tree: the same value for a worktree
// (run-suite.mjs, from a throwaway index) and for a PR head (`git ls-tree -r`), so a suite summary can be tied to a PR head.
// ownChanged (a Set of repo-relative paths, the PR's own changed files; null counts every workflow file): a `.github/workflows/`
// file the PR did not change is left out, so a workflow-only change merged in from main does not force a suite rerun (Slice 29 item 2).
export function codeTreeHash(entries, contentPaths = [], ownChanged = null) {
  const foreignWorkflow = (path) => ownChanged !== null && WORKFLOW_FILE.test(path) && !ownChanged.has(path);
  const lines = entries.filter(([path]) => !isDocPath(path, contentPaths) && !foreignWorkflow(path)).map(([path, sha]) => `${path} ${sha}`).sort();
  return createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex');
}

function headTreeEntries(headOid, cwd, git) {
  // -z: paths come out verbatim (no quoting of non-ASCII or quote characters), as in run-suite.mjs's `ls-files -s -z`.
  return git(cwd, ['ls-tree', '-r', '-z', '--full-tree', headOid]).split('\0').filter(Boolean).map((line) => {
    const match = /^\S+ \S+ ([0-9a-f]+)\t([\s\S]*)$/.exec(line);
    return [match[2], match[1]];
  });
}

function firstLine(file) {
  try { return readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.trim()) ?? ''; } catch { return ''; }
}

// A listed review that says it did not run is not a review: the merge waits for a real one (agent-progress-board PR #79 merged
// after "REVIEW INCOMPLETE: fork not run").
function incompleteProblems(existing) {
  const started = existing.filter((r) => INCOMPLETE_FIRST_LINE.test(firstLine(r.full))).map((r) => `${r.written} starts with REVIEW INCOMPLETE: that review pass did not happen, run it again and list its findings file`);
  const unchecked = existing.filter((r) => !INCOMPLETE_FIRST_LINE.test(firstLine(r.full)) && NOT_CHECKED_AGAINST_SLICE.test(safeRead(r.full)))
    .map((r) => `${r.written} says the reviewer did not check the diff against the slice: that pass is incomplete, run it again with the slice's Work and Verification sections and list its findings file`);
  return [...started, ...unchecked];
}

// A listed suite summary (run-suite.mjs) whose code tree is not the PR head's: the suite ran on other code than the one merging.
// Only for a PR in the hook cwd's repo; a head git cannot read fails open.
function suiteProblems(pr, existing, cwd, git, warn) {
  if (!pr.headRefOid || !sameRepoAsCwd(pr.targetRepo, cwd, git)) return [];
  const listed = existing.map((r) => ({ r, hash: SUITE_TREE_LINE.exec(safeRead(r.full))?.[1] })).filter((x) => x.hash);
  if (!listed.length) return [];
  const unfinished = listed.map((x) => ({ x, why: suiteIncompleteReason(safeRead(x.r.full)) })).filter((y) => y.why);
  if (unfinished.length) return unfinished.map((y) => `${y.x.r.written} is not a full passing suite run (${y.why}): rerun \`node .github/scripts/run-suite.mjs\` until it ends with "All files exited 0."`);
  try {
    // A missing or capped file list is unknown (null): every workflow file stays in the hash.
    const complete = Array.isArray(pr.files) && pr.files.length < PR_FILES_CAP;
    const ownChanged = complete ? new Set(pr.files.map((f) => String(f.path).replace(/\\/g, '/'))) : null;
    const head = codeTreeHash(headTreeEntries(pr.headRefOid, cwd, git), pr.contentPaths, ownChanged);
    const stale = listed.filter((x) => x.hash !== head).map((x) => `${x.r.written} is a suite summary of another code tree than the PR head (suite ${x.hash.slice(0, 12)}, head ${head.slice(0, 12)}): the tree changed after the suite ran, rerun \`node .github/scripts/run-suite.mjs\` on the final code`);
    if (stale.length) return stale;
  } catch (error) {
    warn(`merge-gate: let the call through (suite summary tree not compared: ${String(error.message ?? error).split(/\r?\n/)[0]})\n`);
    return [];
  }
  return selectedRunProblemsClosed(pr, listed, cwd, git);
}

// Fails closed: when the selection cannot be recomputed (no origin/main, an unreadable path, no select-tests.mjs), a Selected
// run is not accepted and the full suite is needed.
function selectedRunProblemsClosed(pr, listed, cwd, git) {
  try {
    return selectedRunProblems(pr, listed, cwd, git);
  } catch (error) {
    const selected = listed.filter((x) => SUITE_SELECTED_LINE.test(safeRead(x.r.full)));
    const why = String(error.message ?? error).split(/\r?\n/)[0];
    return selected.map((x) => `${x.r.written} is a selected run (--changed), but the gate cannot recompute the selection (${why}): run the full suite, \`node .github/scripts/run-suite.mjs\` without --changed`);
  }
}

// A `Selected run` summary is accepted only when select-tests.mjs, run on the PR's own diff, names no file the summary lacks
// and does not say "run all" (a change under .github/).
function selectedRunProblems(pr, listed, cwd, git) {
  const selected = listed.filter((x) => SUITE_SELECTED_LINE.test(safeRead(x.r.full)));
  if (!selected.length) return [];
  if (!selectAffected) throw new Error('select-tests.mjs is not available next to this gate');
  const cache = new Map();
  const read = (f) => {
    if (!cache.has(f)) cache.set(f, git(cwd, ['show', `${pr.headRefOid}:${f}`]));
    return cache.get(f);
  };
  const mergeBase = git(cwd, ['merge-base', `origin/${pr.baseRefName || 'main'}`, pr.headRefOid]).trim();
  const changed = git(cwd, ['diff', '--name-only', '--no-renames', mergeBase, pr.headRefOid]).split(/\r?\n/).filter(Boolean);
  const files = git(cwd, ['ls-tree', '-r', '--name-only', pr.headRefOid]).split(/\r?\n/).filter(Boolean);
  const wanted = selectAffected(changed, files, read);
  return selected.flatMap((x) => {
    if (wanted.all) return [`${x.r.written} is a selected run (--changed), but this PR changes .github/, so select-tests.mjs says run all: run \`node .github/scripts/run-suite.mjs\` without --changed`];
    const text = safeRead(x.r.full);
    if (!text.split(/\r?\n/).some((l) => l.startsWith('exit 0  '))) return [`${x.r.written} is a selected run that ran 0 files: a selection of 0 files is not a passing run, rerun \`node .github/scripts/run-suite.mjs\``];
    const missing = wanted.picks.filter((p) => !text.split(/\r?\n/).some((l) => l.startsWith(`exit 0  ${p.file} `)));
    return missing.length ? [`${x.r.written} is a selected run that lacks ${missing.length} file(s) the selection names for this PR (${missing.slice(0, 3).map((p) => p.file).join(', ')}): rerun \`node .github/scripts/run-suite.mjs --changed\``] : [];
  });
}

// Why a suite summary is not a complete, passing run of every test file ('' when it is one).
function suiteIncompleteReason(text) {
  const counts = SUITE_FILES_LINE.exec(text);
  if (SUITE_SUBSET_LINE.test(text)) return 'it ran only a subset of the files';
  if (!counts) return 'no "Files run" line';
  if (counts[1] !== counts[2]) return `only ${counts[1]} of ${counts[2]} files ran`;
  if (counts[3] !== '0') return `${counts[3]} file(s) failed`;
  return SUITE_PASS_LINE.test(text) ? '' : 'it does not end with "All files exited 0."';
}

function safeRead(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

export function reviewProblems(body, cwd, pr = null, git = runGit, warn = () => {}, api = runApi) {
  const paths = reviewPaths(body);
  if (!paths.length) return [`the PR body has no \`## Review\` section naming review files under a reviews/ folder (write each path with forward slashes, \`D:/x/reviews/<name>-high.md\`: backslashes are lost when a body passes through a shell or an agent; ${REVIEW_NAMING_RULE})`];
  const reviews = resolveReviews(paths, searchRoots(cwd));
  const problems = reviews.filter((r) => !onDisk(r.full)).map((r) => `${r.written} is not on disk`);
  const existing = reviews.filter((r) => onDisk(r.full));
  problems.push(...incompleteProblems(existing));
  if (existing.length < MIN_REVIEWS) problems.push(`${existing.length} existing review file(s), need ${MIN_REVIEWS} (one per review pass)`);
  // A name matching both passes counts as neither: one file cannot stand in for both.
  const high = existing.filter((r) => HIGH_NAME.test(basename(r.full)) && !MEDIUM_NAME.test(basename(r.full)));
  const medium = existing.filter((r) => MEDIUM_NAME.test(basename(r.full)) && !HIGH_NAME.test(basename(r.full)));
  if (!high.length || !medium.length) {
    problems.push(`need ${REVIEW_NAMING_RULE}`);
  }
  if (!problems.length && pr) problems.push(...coverageProblems(pr, existing, cwd, git, warn, api));
  if (!problems.length && pr) problems.push(...skipProblems(pr, cwd, git, warn));
  if (!problems.length && pr) problems.push(...suiteProblems(pr, existing, cwd, git, warn));
  return problems;
}

// The slice files a PR changes, checked with feedback-loop/check-review-skips.mjs on their text at the PR head: a skipped finding whose
// reason is not in the findings file it cites is a problem (night 2026-11-17: update-docs reported "did not run check-review-skips" and the
// slice shipped). Only for a PR in the hook cwd's repo; any error running the check fails open with a warning.
function skipProblems(pr, cwd, git, warn) {
  if (!pr.headRefOid || !sameRepoAsCwd(pr.targetRepo, cwd, git)) {
    warn(`merge-gate: let the call through (skip check not run: PR ${pr.number ?? 'current branch'} is in another repo or has no head commit)\n`);
    return [];
  }
  const slices = (pr.files ?? []).map((f) => f.path).filter((p) => SLICE_FILE.test(String(p)));
  const problems = [];
  for (const path of slices) {
    const text = sliceTextAtHead(pr, path, cwd, git, warn);
    // A deleted or renamed slice file has no text at the head; one with no From review section yet is update-docs' to write.
    if (text === null || !reviewSectionLines(text).length) continue;
    try { problems.push(...skipProblemsOf(path, text, cwd)); }
    catch (error) { warn(`merge-gate: let the call through (skip check of ${path} did not run): ${error.message}\n`); }
  }
  return problems;
}

function sliceTextAtHead(pr, path, cwd, git, warn) {
  try { return git(cwd, ['show', `${pr.headRefOid}:${path}`]); } catch (error) {
    warn(`merge-gate: let the call through (skip check of ${path} not run: git show ${pr.headRefOid} failed: ${String(error.message ?? error).split(/\r?\n/)[0]})\n`);
    return null;
  }
}

function skipProblemsOf(path, text, cwd) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-gate-skips-'));
  try {
    const file = join(dir, basename(path));
    writeFileSync(file, text);
    const roots = searchRoots(cwd).flatMap((r) => ['--root', r]);
    const run = spawnSync(process.execPath, [SKIP_CHECK, ...roots, file], { encoding: 'utf8' });
    if (run.status === 0) return [];
    if (run.status !== 1) throw new Error(`check-review-skips exited ${run.status}: ${run.stderr}`);
    return [`check-review-skips.mjs failed for ${path}: ${run.stdout.trim().split(/\r?\n/).join(' | ')}`];
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function coverageProblems(pr, existing, cwd, git, warn, api = runApi) {
  try {
    const { parsed, stale } = staleFiles(pr, existing, cwd, git, blobSource(pr, cwd, git, api));
    if (!stale.length) return [];
    const note = parsed ? '' : ' (no listed review file has a parseable `Reviewed files:` block: the heading on its own line, then `<path> <sha>` lines)';
    return [`code changed after the last review: ${stale.join(', ')}; run a check pass and list it (a listed review file needs a \`Reviewed files:\` block with these files at their final sha)${note}`];
  } catch (error) {
    warn(`merge-gate: let the call through (coverage of PR ${pr.number ?? 'current branch'} not checked): ${error.message}\n`);
    return [];
  }
}

// Where the head blobs come from: the local checkout when the PR is in the hook cwd's repo, else the GitHub API.
function blobSource(pr, cwd, git, api) {
  if (sameRepoAsCwd(pr.targetRepo, cwd, git)) return (paths) => headBlobs(paths, pr.headRefOid, cwd, git);
  return (paths) => remoteHeadBlobs(paths, pr.targetRepo, pr.headRefOid, api, pr.number);
}

// owner/repo from `o/r`, `github.com/o/r`, `https://github.com/o/r(.git)` and similar; undefined when none.
export function repoSlug(text) {
  return /(?:^|[/:])([^/:\s]+\/[^/:\s]+?)(?:\.git)?\/?$/.exec(String(text ?? '').trim())?.[1];
}

const NOT_FOUND = /HTTP 404/;

// The blob sha of one path at a commit through the contents API (no tree listing, so no truncation), or DELETED
// when gh's stderr says `HTTP 404` (never the command line). Any other API error throws (the gate fails open).
function contentsSha(api, slug, commit, path) {
  const route = path.split('/').map(encodeURIComponent).join('/');
  try { return api([`repos/${slug}/contents/${route}?ref=${commit}`, '--jq', '.sha']).trim().toLowerCase() || DELETED; } catch (error) {
    if (NOT_FOUND.test(String(error.stderr ?? ''))) return DELETED;
    throw error;
  }
}

// The PR branch's last own commit: the last entry of the PR's own commit list (`pulls/<n>/commits`) with exactly
// one parent (a merge of origin/main has two), or '' when there is none.
function lastOwnCommit(api, slug, number) {
  const jq = '[.[] | select((.parents | length) == 1) | .sha] | last // empty';
  const out = api([`repos/${slug}/pulls/${number}/commits`, '--paginate', '--jq', jq]).trim().split(/\s+/).pop();
  return /^[0-9a-f]{40,64}$/i.test(out) ? out : '';
}

// path -> Set of acceptable blob shas (or `deleted`): the path at the PR head and at the branch's last own commit
// (as the local path does), each read with one per-path `gh api repos/<o>/<r>/contents/<path>?ref=<sha>` call.
// An API error other than a 404 throws (fail open).
export function remoteHeadBlobs(paths, repo, headOid, api = runApi, number) {
  if (!headOid) throw new Error('no headRefOid in the PR data');
  const slug = repoSlug(repo);
  if (!slug) throw new Error(`cannot read owner/repo from ${repo}`);
  const own = number ? lastOwnCommit(api, slug, number) : '';
  return new Map(paths.map((p) => {
    const accepted = new Set([contentsSha(api, slug, headOid, p)]);
    if (own) accepted.add(contentsSha(api, slug, own, p));
    return [p, accepted];
  }));
}

function runApi(args) {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
}

// Throws when the PR is in another repo than the hook cwd's origin: the head commit cannot be read from here.
export function assertSameRepo(targetRepo, cwd, git = runGit) {
  if (!targetRepo) return;
  const origin = git(cwd, ['remote', 'get-url', 'origin']);
  const slug = repoSlug(origin);
  if (!slug || slug.toLowerCase() !== (repoSlug(targetRepo) ?? targetRepo).toLowerCase()) {
    throw new Error(`the PR is in ${targetRepo} but the hook cwd's origin is ${slug ?? 'unknown'}, so its head cannot be read here`);
  }
}

// path -> sha from the last `Reviewed files:` block of a review file, or null when it has none.
export function reviewedFiles(text) {
  const all = String(text ?? '');
  const starts = [...all.matchAll(REVIEWED_HEADING)];
  if (!starts.length) return null;
  const start = starts[starts.length - 1];
  const map = new Map();
  for (const line of all.slice(start.index + start[0].length).split(/\r?\n/)) {
    const entry = /^\s*[-*]?\s*`?(.+?)`?\s+([0-9a-f]{40,64}|deleted)\s*$/i.exec(line);
    if (entry) map.set(entry[1].replace(/\\/g, '/'), entry[2].toLowerCase());
    else if (map.size) break;
  }
  return map;
}

function runGit(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER }).trim();
}

function blobAt(git, cwd, commit, path) {
  // ls-tree prints nothing for a path that is not in the tree; any git failure throws (unknown, not deleted).
  // --full-tree: the path is repo-relative even when the hook runs in a subdirectory.
  const entry = git(cwd, ['ls-tree', '--full-tree', commit, '--', path]);
  return entry ? /^\S+ \S+ ([0-9a-f]+)	/.exec(entry)[1].toLowerCase() : DELETED;
}

// The blobs a review of this path may have hashed: its version at the PR head, and its version at the PR
// branch's last own commit (non-merge, first-parent) that touched it, which a later merge of origin/main
// into the branch does not move.
function acceptedBlobs(git, cwd, headOid, path) {
  const accepted = new Set([blobAt(git, cwd, headOid, path)]);
  const own = git(cwd, ['log', '-1', '--first-parent', '--no-merges', '--format=%H', headOid, '--', path]);
  if (own) accepted.add(blobAt(git, cwd, own, path));
  return accepted;
}

// path -> Set of acceptable blob shas (or `deleted`); throws when the head commit cannot be resolved.
export function headBlobs(paths, headOid, cwd, git = runGit) {
  if (!headOid) throw new Error('no headRefOid in the PR data');
  try { git(cwd, ['cat-file', '-e', `${headOid}^{commit}`]); } catch {
    git(cwd, ['fetch', '-q', 'origin', headOid]);
    git(cwd, ['cat-file', '-e', `${headOid}^{commit}`]);
  }
  return new Map(paths.map((p) => [p, acceptedBlobs(git, cwd, headOid, p)]));
}

// { parsed, stale }: the changed code files no listed review covers (any listed file with a block that has
// the path at an accepted blob covers it), and how many listed files had a parseable block.
export function staleFiles(pr, reviews, cwd, git = runGit, blobsOf = (paths) => headBlobs(paths, pr.headRefOid, cwd, git)) {
  const code = (pr.files ?? []).map((f) => String(f.path).replace(/\\/g, '/')).filter((p) => !isDocPath(p, pr.contentPaths));
  if (!code.length) return { parsed: 0, stale: [] };
  const blocks = reviews.map((r) => reviewedFiles(readFileSync(r.full, 'utf8'))).filter(Boolean);
  if (!blocks.length) return { parsed: 0, stale: code };
  const heads = blobsOf(code);
  return { parsed: blocks.length, stale: code.filter((p) => !blocks.some((b) => heads.get(p).has(b.get(p)))) };
}

function viewPr(target, cwd) {
  const args = ['pr', 'view'];
  if (target.selector) args.push(target.selector);
  args.push('--json', 'files,body,number,headRefOid,baseRefName,statusCheckRollup,createdAt,state');
  if (target.repo && !PR_URL.test(target.selector ?? '')) args.push('--repo', target.repo);
  return execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER });
}

function denial(number, problems) {
  const reason = `merge gate: PR #${number} changes code, so both review passes must be on record: ${problems.join('; ')}. `
    + 'Add a `## Review` section to the PR body (`gh pr edit <n> --body-file <file>`) listing the high and medium review files (paths under reviews/, names containing high and medium). '
    + 'Edits after the last pass need a check pass listed as a third file. '
    + 'Run that `gh pr edit` as its own command first: the gate reads the PR body before a command runs, so an edit chained before the merge in the same command is not seen.';
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function checksDenial(number, red) {
  const reason = `merge gate: PR #${number} has checks that are not green: ${red.join(', ')}. `
    + `Wait for them in the same command: \`gh pr checks ${number} --watch --fail-fast && gh pr merge ${number} --merge\` `
    + '(never `;`, and never a separate merge call after a watch that failed or was cut off). '
    + 'A CANCELLED check (for example no runner came) is not green: rerun it (`gh run rerun <run-id> --failed`) and wait for it.';
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// A PR opened seconds ago may have checks GitHub has not registered yet, so an empty rollup proves nothing
// (night 2026-11-04-1441: #827 merged at 23:36:39, its check started at 23:36:40).
export function tooYoungForChecks(pr, now = Date.now()) {
  if ((pr.statusCheckRollup ?? []).length) return false;
  const created = Date.parse(pr.createdAt ?? '');
  return Number.isFinite(created) && now - created < YOUNG_PR_MS;
}

function youngDenial(number, pr = {}, now = Date.now()) {
  const created = Date.parse(pr.createdAt ?? '');
  const left = Number.isFinite(created) ? Math.max(1, Math.ceil((YOUNG_PR_MS - (now - created)) / 1000)) : YOUNG_PR_MS / 1000;
  const reason = `merge gate: PR #${number} was opened under ${YOUNG_PR_MS / 1000} s ago and lists no checks yet, so its checks may not have started (${left} s left of the ${YOUNG_PR_MS / 1000} s age). `
    + `Wait in the same command: \`gh pr checks ${number} --watch --fail-fast && gh pr merge ${number} --merge\`; if the repo has no PR checks (that watch then exits at once with an error), retry the plain merge once, after ${left} s.`;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function cdDenial(number) {
  const reason = `merge gate: the command changes directory, so the gate cannot tell which repo PR ${number ?? 'the current branch'} is in: add --repo <owner>/<repo> to gh pr merge`;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function unclosedDenial() {
  const reason = 'merge gate: the command shows `gh pr merge` but the gate could not parse it as a merge (an unclosed quote or heredoc hides it): run it as a plain `gh pr checks <n> --watch --fail-fast && gh pr merge <n> --merge` line';
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// ---- `gh pr create` body check (Slice 29 item 26) ----

const CREATE_VALUE_FLAGS = new Set(['-t', '--title', '-B', '--base', '-H', '--head', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '--recover', '-R', '--repo']);
const CREATE_BODY_FLAGS = new Set(['-b', '--body']);
const CREATE_FILE_FLAGS = new Set(['-F', '--body-file']);
// Flags after which the body is not a literal the command shows (generated, edited by hand, taken from a template or the web form).
const CREATE_NO_BODY_FLAGS = new Set(['--fill', '--fill-first', '--fill-verbose', '-f', '-w', '--web', '-T', '--template', '-e', '--editor']);
const TEST_PLAN_HEADING = /^[ \t]*#{1,6}[ \t]*Test plan\b/im;
const HERE_STRING = /@(['"])[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1@/g;

// { draft, bodyFlag: 'inline'|'file'|null, value, noBody } of one `gh [-R r] pr create ...` segment, or null. The command word must be
// gh itself (a heredoc line of prose never counts), after env assignments and then/do/else.
function createInSegment(raw) {
  const words = unwrap(raw);
  const at = words.findIndex((w) => !(LEAD_WORDS.has(w.toLowerCase()) || ENV_ASSIGNMENT.test(w)));
  if (at === -1 || !/^(?:\$?\()?gh(\.exe)?$/i.test(words[at])) return null;
  let i = at + 1;
  while (i < words.length && words[i] !== 'pr') {
    const flag = repoFlag(words, i);
    if (!flag) return null;
    i = flag.next;
  }
  if (words[i] !== 'pr' || words[i + 1] !== 'create') return null;
  const found = { draft: false, bodyFlag: null, value: null, noBody: false };
  for (i += 2; i < words.length; i++) {
    const word = words[i];
    const eq = /^(--body|--body-file)=([\s\S]*)$/.exec(word);
    if (eq) { found.bodyFlag = eq[1] === '--body' ? 'inline' : 'file'; found.value = eq[2]; continue; }
    if (word === '--draft' || word === '-d') found.draft = true;
    else if (CREATE_NO_BODY_FLAGS.has(word)) found.noBody = true;
    else if (CREATE_BODY_FLAGS.has(word) || CREATE_FILE_FLAGS.has(word)) { found.bodyFlag = CREATE_BODY_FLAGS.has(word) ? 'inline' : 'file'; found.value = words[++i] ?? null; }
    else if (CREATE_VALUE_FLAGS.has(word)) i++;
  }
  return found;
}

// The text of each heredoc body and PowerShell here-string in the raw command (the places an inline body can hide).
function hereTexts(command) {
  const text = String(command ?? '');
  const out = [...text.matchAll(HERE_STRING)].map((m) => m[2]);
  for (const open of text.matchAll(/<<[-~]?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n/g)) {
    const rest = text.slice(open.index + open[0].length);
    const close = new RegExp(`^[ \\t]*${open[2]}[ \\t]*\\r?$`, 'm').exec(rest);
    out.push(close ? rest.slice(0, close.index) : rest);
  }
  return out;
}

// The body text a create segment brings, or null when the command does not show it (anything unknown lets the call through).
function createBodyText(found, command, cwd, read = readFileSync) {
  if (found.draft || found.noBody || !found.bodyFlag || found.value === null) return null;
  const heres = hereTexts(command);
  if (found.bodyFlag === 'file' && found.value === '-') return heres.length ? heres.join('\n') : null;
  if (found.bodyFlag === 'file') {
    // A file the same command also writes (its name used twice, in any spelling: `body.md`, `./body.md`) may not hold the final body yet.
    const fileName = found.value.split(/[\\/]/).pop();
    if (fileName && String(command).split(fileName).length > 2) return null;
    // A relative path after a `cd` in the same command points elsewhere than the hook's cwd: not read.
    if (/(?:^|[;&|\n])[ \t]*(?:cd|pushd|Set-Location)\b/i.test(String(command))) return null;
    try { return read(resolve(cwd, found.value), 'utf8'); } catch { return null; }
  }
  // Only a value that starts with a substitution is unknown; the tokenizer has dropped the quotes, so inline code or `$(` inside the text is shown text.
  if (/^(?:\$|`)/.test(found.value)) return heres.length ? heres.join('\n') : null;
  return found.value;
}

// Why a `gh pr create` in the command is refused (a non-draft whose literal body has no `## Test plan` heading), or ''. A heading anywhere in
// the command text lets it through: an escaped quote can cut the tokenizer's word short.
export function createBodyProblem(command, cwd, read = readFileSync) {
  const raw = String(command ?? '');
  if (!/\bgh(?:\.exe)?\b[^\n]*\bpr\b[^\n]*\bcreate\b/.test(raw) || TEST_PLAN_HEADING.test(raw)) return '';
  const text = raw.replace(/@['"][ \t]*(\r?\n)/g, '$1').replace(/^['"]@/gm, '');
  for (const words of commandSegments(text)) {
    const found = createInSegment(words);
    const body = found && createBodyText(found, raw, cwd, read);
    if (typeof body === 'string' && !TEST_PLAN_HEADING.test(body)) return 'the body has no `## Test plan` heading';
  }
  return '';
}

function createDenial(problem) {
  const reason = `merge gate: \`gh pr create\` is refused: ${problem}. Every PR body ends with a \`## Test plan\` heading, even a docs-only one (\`pr-conventions\`, Body shape; `
    + 'a docs-only PR writes `- [x] docs only, no tests apply: <reason>`). Add the heading to the body and run it again. A draft claim PR (`--draft`) is exempt.';
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// ---- a merge after a failed `gh pr checks` call of the session (Slice 29 item 37) ----

const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const CHECKS_VALUE_FLAGS = new Set(['-i', '--interval', '--json', '-q', '--jq', '-t', '--template', '-R', '--repo']);
const EXIT_CODE_TEXT = /^\s*Exit code [1-9]\d*/;
const NO_CHECKS_TEXT = /no checks reported/i;

// The transcript file whose tool calls this hook call belongs to: a subagent's own file next to the session's, else the session's.
function transcriptFileOf(input) {
  const path = input.transcript_path;
  if (typeof path !== 'string' || !path) return null;
  if (!input.agent_id) return path;
  return join(path.replace(/\.jsonl$/i, ''), 'subagents', `agent-${input.agent_id}.jsonl`);
}

function readTranscriptLines(file) {
  const size = statSync(file).size;
  const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8').split('\n').slice(size > TRANSCRIPT_TAIL_BYTES ? 1 : 0).filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

// The PR number a `gh pr checks <selector>` call names, or null (a branch or no selector is not matched: only a certain match counts).
function checksNumber(command) {
  return checksTarget(command)?.number ?? null;
}

// The -R repo a `gh -R r pr checks` puts before `pr`, or undefined.
function ghLevelRepo(raw) {
  const words = unwrap(raw);
  let i = words.findIndex((w) => /^(?:\$?\()?gh(\.exe)?$/i.test(w)) + 1;
  let repo;
  while (i > 0 && i < words.length && words[i] !== 'pr') {
    const flag = repoFlag(words, i);
    if (!flag) break;
    repo = flag.repo;
    i = flag.next;
  }
  return repo;
}

// { number, repo } of a `gh pr checks <selector>` call (repo from -R/--repo or a PR URL, undefined when the call names none), or null.
function checksTarget(command) {
  for (const words of commandSegments(command)) {
    const args = checksArguments(words);
    if (!args) continue;
    let repo = ghLevelRepo(words);
    let number = null;
    let selectorSeen = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-R' || args[i] === '--repo') { repo = args[i + 1]; i++; continue; }
      if (CHECKS_VALUE_FLAGS.has(args[i])) { i++; continue; }
      if (args[i].startsWith('-') || number !== null || selectorSeen) continue;
      selectorSeen = true;
      const url = PR_URL.exec(args[i]);
      if (url) { number = url[2]; repo = url[1]; } else number = /^#?\d+$/.test(args[i]) ? args[i].replace('#', '') : null;
    }
    return number ? { number, repo } : null;
  }
  return null;
}

// A checks call counts for a merge target only when both name the same repo, or neither names one (the hook cwd's repo).
const sameChecksRepo = (callRepo, targetRepo) => String(callRepo ?? '').toLowerCase() === String(targetRepo ?? '').toLowerCase();

const resultText = (block) => (typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''));

// { failed, text } of the last `gh pr checks <number>` call of the transcript lines that has a result, or null. A call that also merges
// (`checks --watch && merge`) is not a checks call of its own. A failure whose output is "no checks reported" is a repo with no PR checks,
// not a failed check.
// repo is the merge target's -R repo (undefined for the hook cwd's repo); a call naming another repo is not this PR's. `at` is the result's time in ms (NaN when unknown).
export function lastChecksCall(lines, number, repo) {
  const calls = new Map();
  let last = null;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const command = block?.input?.command;
      if (block?.type === 'tool_use' && typeof command === 'string' && /gh(?:\.exe)?\b[^\n]*\bpr\b[^\n]*\bchecks\b/.test(command) && !/\bpr\b[^\n]*\bmerge\b/.test(command) && matchesChecksTarget(checksTarget(command), number, repo)) calls.set(block.id, true);
      if (block?.type === 'tool_result' && calls.has(block.tool_use_id)) {
        const text = resultText(block);
        last = { failed: block.is_error === true && EXIT_CODE_TEXT.test(text) && !NO_CHECKS_TEXT.test(text), text, at: Date.parse(entry.timestamp) };
      }
    }
  }
  return last;
}

const matchesChecksTarget = (call, number, repo) => call?.number === String(number) && sameChecksRepo(call.repo, repo);

// A failed result older than the PR head commit is about code that was replaced: not held against the merge.
function olderThanHead(last, pr, cwd, git, target) {
  if (!Number.isFinite(last.at) || !pr.headRefOid || !sameRepoAsCwd(target.repo, cwd, git)) return false;
  try { return last.at < Date.parse(git(cwd, ['show', '-s', '--format=%cI', pr.headRefOid]).trim()); } catch { return false; }
}

// The failed checks result the session holds for this PR, or null; any read problem is null (fail open). The live rollup being non-empty
// and all finished and passed, or the result being older than the head commit, also lets the merge through.
function failedChecksBefore(input, pr, target, cwd, git) {
  try {
    const number = pr.number ?? target.number;
    const file = transcriptFileOf(input);
    if (!file || !number) return null;
    if ((pr.statusCheckRollup ?? []).length && !unfinishedChecks(pr.statusCheckRollup).length) return null;
    const last = lastChecksCall(readTranscriptLines(file), number, target.repo);
    return last?.failed && !olderThanHead(last, pr, cwd, git, target) ? last : null;
  } catch { return null; }
}

function failedChecksDenial(number, last) {
  const firstLine = last.text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const reason = `merge gate: the last \`gh pr checks ${number}\` call of this session failed (${firstLine.trim().slice(0, 120)}), so merging PR #${number} now is refused. `
    + `Wait for the checks and merge in one command: \`gh pr checks ${number} --watch --fail-fast && gh pr merge ${number} --merge\`; a failing watch then stops the merge. `
    + 'A repo with no PR checks prints "no checks reported" and is not refused.';
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// ---- a merged docs PR marks the mirror due (Slice 29 item 46) ----

const MIRRORED_DOC = /^(?:plan\.md|README\.md|scope\.md|(?:.*\/)?CLAUDE\.md|docs\/plan\/.+)$/;
export const touchesMirroredDocs = (files) => (files ?? []).some((f) => MIRRORED_DOC.test(String(f.path ?? f).replace(/\\/g, '/')));

// Writes the pending-mirror marker the Stop hook names after 10 minutes until the mirror agent clears it (`mirror-due.mjs mark`). The marker is the
// repo's slug, the PR head sha and the primary checkout. Fails open (a repo or root git cannot name writes nothing).
// No reachable-from-origin/main check here (Slice 35 item 18): this runs in the PreToolUse hook, before the merge, so the head sha is
// not merged yet, and `markMirrorDue` is not retried after the merge lands; a check here would refuse the marker for a reason that is
// only about timing. `mirror-due.mjs mark` (ship-branch, after the merge) holds that check.
function markMirrorDue(repo, sha, cwd, git) {
  try {
    const slug = repo ?? repoSlug(git(cwd, ['remote', 'get-url', 'origin']));
    // The recorded root is the hook cwd's primary checkout, only when the PR is that repo's (a marker with no root falls back to the repo name).
    const root = !repo || sameRepoAsCwd(repo, cwd, git) ? primaryRoot(cwd) : '';
    if (slug && sha) markMirror(slug, sha, undefined, undefined, root);
  } catch { /* nothing to mark */ }
}

// git(cwd, args) runs git; gh(target, cwd) returns the `gh pr view --json files,body,number` text; warn(text) reports a fail-open.
// api(args) runs `gh api <args>` and returns its text (per-path blobs and the commit list of a PR in another repo).
// markDue(repo, sha, cwd, git) records a mirror due for an allowed merge of a PR that changed mirrored docs.
export function decide(input, gh = viewPr, warn = (t) => process.stderr.write(t), git = runGit, api = runApi, markDue = markMirrorDue) {
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return null;
  const command = input.tool_input?.command;
  const cwd = input.cwd ?? process.cwd();
  const created = createBodyProblem(command, cwd);
  if (created) return createDenial(created);
  if (rawMergeInCommandPosition(command) && !hasMergeSegment(command)) return unclosedDenial();
  if (mergeAfterUnchainedChecks(command)) return unchainedDenial();
  for (const target of mergeTargets(command)) {
    const verdict = decideOne(target, command, cwd, gh, warn, git, api, input, markDue);
    if (verdict) return verdict;
  }
  return null;
}

// Whether this session runs a wave, so the batch [skip ci] rule binds it. Any error counts as yes (the old rule).
function sessionRunsWave(input, cwd) {
  try { return runsWave(input, openWaveOf(cwd)); } catch { return true; }
}

// One merge of the command: a deny for it, or null. Any deny denies the whole call.
function decideOne(target, command, cwd, gh, warn, git, api, input = {}, markDue = markMirrorDue) {
  if (!target.repo && target.cdBefore) return cdDenial(target.number ?? target.selector);
  const batch = SKIP_CI.test(target.subject ?? '') || !sameRepoAsCwd(target.repo, cwd, git) ? null : openBatch(cwd, git);
  if (batch && sessionRunsWave(input, cwd)) return batchDenial(target.number ?? target.selector, batch);
  try {
    const pr = JSON.parse(gh(target, cwd));
    // An already merged PR (the first merge printed nothing and landed, Slice 29 item 45) has nothing left to gate.
    // Only for a PR the command names by number or URL: a branch name or no selector resolves to whatever PR that branch had,
    // which can be an old merged one while the command opens the new PR in the same line.
    // The number gh returned must equal the named one, so a lookup that resolved to another PR never passes it.
    if (target.number && Number(pr.number) === Number(target.number) && String(pr.state ?? '').toUpperCase() === MERGED_STATE) return null;
    const waits = waitsForChecks(command) || setsAutoMerge(command);
    const failedChecks = waits ? null : failedChecksBefore(input, pr, target, cwd, git);
    if (failedChecks) return failedChecksDenial(pr.number ?? target.number, failedChecks);
    const red = waits ? [] : unfinishedChecks(pr.statusCheckRollup);
    if (red.length) return checksDenial(pr.number ?? target.number ?? 'current branch', red);
    pr.contentPaths = sameRepoAsCwd(target.repo, cwd, git) ? contentPathsFor(pr, cwd, git) : [];
    // An allowed merge of a PR that changed mirrored docs marks the mirror due, whoever merges (Slice 29 item 46); `--disable-auto` merges nothing.
    const allow = () => {
      if (touchesMirroredDocs(pr.files) && !command.includes('--disable-auto')) markDue(target.repo, pr.headRefOid, cwd, git);
      return null;
    };
    if (isDocsOnly(pr.files ?? [], pr.contentPaths)) return allow();
    if (!waits && tooYoungForChecks(pr)) return youngDenial(pr.number ?? target.number ?? 'current branch', pr);
    const problems = reviewProblems(pr.body, cwd, { ...pr, targetRepo: target.repo }, git, warn, api);
    return problems.length ? denial(pr.number ?? target.number ?? 'current branch', problems) : allow();
  } catch (error) {
    warn(`merge-gate: let the call through (could not check PR ${target.number ?? target.selector ?? 'current branch'}): ${error.message}\n`);
    return null;
  }
}

// The newest wave of the repo's ledger (for its Opened session id), or null when there is none or it cannot be read.
function openWaveOf(cwd) {
  try { return lastWave(readFileSync(ledgerPath(cwd), 'utf8')); } catch { return null; }
}

function sameRepoAsCwd(repo, cwd, git) {
  try { assertSameRepo(repo, cwd, git); return true; } catch { return false; }
}

export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl)); } catch { return false; }
}

// `--explain <repo folder>`: would a merge without a `[skip ci]` subject be denied in that repo right now? Run by the
// run-all-waves start mode before it recommends a merge shape (Slice 17 part E).
// `session` is the hook input ({session_id, transcript_path}) when the caller knows it: a session that runs no wave is told `allowed`.
export function explainMerge(repo, git = runGit, now = Date.now(), read = readFileSync, session = null) {
  const batch = openBatch(resolve(repo), git, now, read);
  if (batch && session && !sessionRunsWave(session, resolve(repo))) return `allowed: a batch release is open (${batch.file}) but this session runs no wave, so a merge needs no [skip ci] subject\n`;
  if (!batch) return `allowed: no open batch release in ${repo}, a merge needs no [skip ci] subject\n`;
  return `denied: a batch release is open (${batch.file}, started ${batch.batchStartedAt}); merge with --subject "Merge pull request #<n> from <branch> [skip ci]"\n`;
}

if (isEntryPoint(process.argv[1], import.meta.url) && process.argv[2] === '--explain') {
  process.stdout.write(explainMerge(process.argv[3] ?? process.cwd()));
} else if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`merge-gate: let the call through after an internal error: ${error.message}\n`);
  }
}
