#!/usr/bin/env node
// Checks that every skipped finding in a slice file's *From review* section names a reason that appears in the
// findings file it cites (Slices 222, 223, 231: skip records were written from briefs, not from the review files).
// Usage: node check-review-skips.mjs [--root <dir>]... <slice-file>...
// A skip line (a line of the section with "skipped", "not applied" or "declined") must read
//   - Skipped #3 (`reviews/pr-12-high.md`): "the exact words the finding file gives for it"
// i.e. cite at least one findings file (a path ending .md under a `reviews/` folder) and quote its reason
// (double quotes, 8+ characters; backticked text is never the reason). Each quoted reason must appear in a cited file (case and
// whitespace ignored). Relative findings paths are looked up in each --root (default: the cwd and its parent).
// Exit 0 when every skip checks out (or there are none), 1 when any does not (each problem printed), 2 on usage.
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECTION_START = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:#{1,6}\s*|>\s*)?[*_]*From review:?[*_]*:?/i;
// A heading, or an italic/bold label such as `*Built:*` or `**Not yet verified:**` (also as a list item).
const SECTION_END = /^\s*(?:[-*+]\s+)?(?:#{1,6}\s|[*_]{1,2}[A-Z][^*_]{2,60}:[*_]{1,2})/;
const ITEM_START = /^\s*(?:[-*+]|\d+[.)])\s/;
const SKIP_WORDS = /\b(?:skipped|not applied|declined)\b/i;
// "none skipped", "skipped nothing", "not skipped": a statement that nothing was skipped, not a skip.
const NEGATED_SKIP = /\b(?:none|no|nothing|not|never|zero)\s+(?:findings?\s+)?(?:were\s+|was\s+)?(?:skipped|declined)\b|\b(?:skipped|declined)\s+(?:none|nothing)\b/gi;
const FINDINGS_PATH = /[^\s`'"<>|*?()]*\breviews[\\/][^\s`'"<>|*?()]*\.md/gi;
const MIN_REASON = 8;
// A reason is words, not a single token such as a file name or identifier that any findings file may contain.
const MIN_REASON_WORDS = 2;
const QUOTED_ONCE = /"([^"]+)"|“([^”]+)”/;
const BACKTICKED = /`[^`]*`/g;

// Slice 34 review 1 and 2: the fixer appends its skip reasons under `## Outcome`; neither a reason's quote nor a finding's text may come from there.
export const beforeOutcome = (body) => String(body).split(/\r?\n/).reduce((kept, l) => (kept.done || /^##\s+Outcome\b/i.test(l) ? { ...kept, done: true } : { ...kept, lines: [...kept.lines, l] }), { lines: [], done: false }).lines.join('\n');

const squash = (text) => String(text).toLowerCase().replace(/`/g, ' ').replace(/\s+/g, ' ').trim();

// The lines of every *From review* section of a slice file's text.
export function reviewSectionLines(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (SECTION_START.test(line)) { inside = true; out.push(line); continue; }
    if (inside && SECTION_END.test(line)) inside = false;
    if (inside) out.push(line);
  }
  return out;
}

// Joins a wrapped list item (or paragraph) into one logical line: a blank line or a new bullet starts the next.
export function logicalItems(sectionLines) {
  const items = [];
  let open = false;
  for (const line of sectionLines) {
    if (!line.trim()) { open = false; continue; }
    if (open && !ITEM_START.test(line) && !SECTION_START.test(line)) items[items.length - 1] += ` ${line.trim()}`;
    else items.push(line.trim());
    open = true;
  }
  return items;
}

// "Findings skipped:" / "Skipped:" ending a line introduces the skip lines below it; it is not a skip itself.
const INTRO_LINE = /\bskipped:[*_]*\s*$/i;
// A "Not yet verified" summary line, bold or plain, is a status line about runs not made, not a skipped finding (Slice 23 item 17).
const NOT_VERIFIED_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?[*_]*Not yet verified\b/i;
const isSkip = (item) => SKIP_WORDS.test(item.replace(NEGATED_SKIP, ' ')) && !INTRO_LINE.test(item) && !NOT_VERIFIED_LINE.test(item);

// One rule (Slice 315): drop every backticked span (paths, code, identifiers), then the reason is the first
// double-quoted string left on the line (straight or curly quotes), wherever it sits.
// A quote that holds backticked words is read whole: the quote is found on a copy with each backticked span
// blanked to the same length, then its text is cut from the real line, backtick characters dropped.
function firstReason(line) {
  const masked = line.replace(BACKTICKED, (span) => ' '.repeat(span.length));
  const first = QUOTED_ONCE.exec(masked);
  if (!first) return [];
  const start = first.index + 1;
  return [line.slice(start, first.index + first[0].length - 1)];
}
const wordCount = (text) => text.trim().split(/\s+/).length;
// A reason needs at least one word outside backticks: identifiers alone are not the reason (Slice 315).
const hasPlainWord = (text) => /\S/.test(text.replace(BACKTICKED, ' '));

// The day this checker was added (Slice 393 item 1): a skip line dated, on that line, before it predates the rules and is not held to them.
export const CHECKER_DATE = '2026-11-07';
const DATE_IN_TEXT = /\b(\d{4}-\d{2}-\d{2})\b/g;
// The newest date the line itself names, or null: a skip with no date of its own is new (an undated skip under an old-dated heading is checked).
const lineDate = (text) => [...String(text).matchAll(DATE_IN_TEXT)].map((m) => m[1]).sort().pop() ?? null;

// { line, files, reasons, date } for each skip item (wrapped lines joined) of the section lines.
export function skipRecords(sectionLines) {
  return logicalItems(sectionLines).flatMap((line) => {
    const date = lineDate(line);
    if (!isSkip(line)) return [];
    const files = [...new Set(line.match(FINDINGS_PATH) ?? [])];
    const reasons = firstReason(line).filter(hasPlainWord)
      .filter((r) => r.length >= MIN_REASON && wordCount(r) >= MIN_REASON_WORDS);
    return [{ line, files, reasons, date }];
  });
}

export const isLegacyRecord = (record) => Boolean(record.date) && record.date < CHECKER_DATE;

function readFinding(path, roots) {
  const candidates = isAbsolute(path) ? [path] : roots.map((r) => resolve(r, path));
  const found = candidates.find((c) => { try { return statSync(c).isFile(); } catch { return false; } });
  return found ? beforeOutcome(readFileSync(found, 'utf8')) : null;
}

// Slice 376 item 8: a skip whose reason says "by design" (any severity) cites `Decision <n>` or `user` followed by
// a quoted span (run-wave, section on skips). The quoted finding text is not the author's reason, so only the
// text around it is checked.
const BY_DESIGN = /\bby[\s-]design\b|\bas designed\b|\bintentional(?:ly)?\b|\bdeliberate(?:ly)?\b/i;
const DESIGN_CITATION = /\bDecisions?\s+\d+\b|\buser\b[^"“”]{0,30}(?:"[^"]{4,}"|“[^”]{4,}”)/i;
const outsideQuote = (line) => line.replace(BACKTICKED, ' ').replace(QUOTED_ONCE, ' ');
const BY_DESIGN_PROBLEM = 'says "by design" but cites no `Decision <n>` or `user` followed by a quoted span ("...")';

// The problems of one skip record: no cited file, an unreadable one, no quoted reason, or a reason in none of the files.
export function skipProblems(record, roots, read = readFinding) {
  const own = outsideQuote(record.line);
  const designProblems = BY_DESIGN.test(own) && !DESIGN_CITATION.test(own) ? [BY_DESIGN_PROBLEM] : [];
  return [...designProblems, ...placeholderProblems(record.line), ...echoProblems(record, roots, read), ...loadingStateProblems(record, roots, read), ...citedFileProblems(record, roots, read)];
}

// Slice 35 item 25: a skip reason written after the fact was "drawn from the finding text" (33 lines in RTST slices 291, 330,
// 346, 384, 387). The mechanical form: the author's own words (the notes in parentheses and the text outside the quote, paths
// and skip words removed) must hold a word the finding does not use; when every one of them is the finding's own word, the
// line is refused unless it says `reconstructed`. A line with no words of its own is left to the other checks.
export const RECONSTRUCTED = /\breconstructed\b/i;
const MIN_ECHO_WORDS = 6;
const wordsOf = (text) => String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
function ownWords(line) {
  const { notes, rest } = reasonTexts(line.replace(BACKTICKED, ' '));
  return wordsOf([...notes, rest].join(' ')).filter((w) => w !== 'reconstructed');
}
function echoProblems(record, roots, read) {
  if (RECONSTRUCTED.test(outsideQuote(record.line)) || !record.files.length) return [];
  const own = ownWords(record.line);
  // A short reason is a judgement, not a copy: only a reason of MIN_ECHO_WORDS own words or more can be an echo.
  if (own.length < MIN_ECHO_WORDS) return [];
  // Only one cited finding's text is compared; no `#N`, several, or one the file does not hold means no echo check.
  const numbers = citedNumbers(record.line);
  if (numbers.length !== 1) return [];
  // The cheap guards come first; a read that throws is not fatal (the other checks report an unreadable file).
  let bodies;
  try { bodies = record.files.map((f) => read(f, roots)).filter((b) => b !== null); } catch { return []; }
  if (!bodies.length) return [];
  const finding = bodies.map((b) => findingText(b, numbers[0], true)).join('\n');
  const used = new Set(wordsOf(finding));
  if (!used.size || own.some((w) => !used.has(w))) return [];
  return ['gives a reason built only from the finding\'s own words: write the coordinator\'s reason, or say `reconstructed` on the line when it was written after the fact'];
}

// Slice 29 item 43: a finding about a loading state (a spinner or `loading` flag that is stuck, missing or never cleared) goes to the
// fixer (`~/.claude/CLAUDE.md`, implementation workflow step 3), so "no crash, data-loss, security or privacy fault" is never a reason to skip one
// (board Slice 47 check 2 #5: an aborted first load left `loading` true and was skipped on that reason).
export const LOADING_FINDING =/\bloading[- ]state\b|`loading`|\bloading (?:flag|indicator|spinner)\b|\bspinner\b[^\n.]{0,40}\b(?:stuck|never|forever|missing|not (?:shown|cleared|hidden)|stays)\b|\b(?:stuck|never[- ]cleared|missing|forever)\b[^\n.]{0,40}\bspinner\b|\bstuck (?:in |on )?loading\b/i;
const CATEGORY_REASON = /\bno (?:crash|data[- ]loss|security|privacy|correctness)\b|\bnot (?:a |an )?(?:crash|data[- ]loss|security|privacy|correctness)\b|\bno crash(?:,| or)/i;
const LOADING_PROBLEM = 'skips a loading-state finding because it is "no crash, data-loss, security or privacy fault": a loading-state finding goes to the fixer, so give another reason (see `~/.claude/CLAUDE.md`, step 3 of the implementation workflow)';

// The text of finding `number` in a findings file: its numbered line and the lines up to the next numbered one.
export function findingText(body, number, narrow = false) {
  const lines = beforeOutcome(body).split(/\r?\n/);
  // Top-level findings sit at the shallowest indent of any numbered line; a deeper `2.` is a sub-step of an earlier finding.
  const numbered = lines.map((l) => /^(\s*)\d+\.\s/.exec(l)).filter(Boolean).map((m) => m[1].length);
  const topIndent = numbered.length ? Math.min(...numbered) : 0;
  const start = lines.findIndex((l) => new RegExp(`^\\s{${topIndent}}${number}\\.\\s`).test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  // The next top-level finding: a higher number at no deeper indent, so a finding's own numbered steps (1. 2. ...) stay inside it.
  const indent = /^\s*/.exec(lines[start])[0].length;
  const end = rest.findIndex((l) => {
    const m = /^(\s*)(\d+)\.\s/.exec(l);
    return m && m[1].length <= indent && Number(m[2]) > Number(number);
  });
  const own = end === -1 ? rest : rest.slice(0, end);
  return [lines[start], ...(narrow ? own.slice(0, narrowEnd(own)) : own)].join('\n');
}

// The narrow text, for the echo check only (a narrower text can only make that check refuse less): the numbered line plus its continuation
// lines, ending at the first blank line, a heading, a `Reviewed files:` line, or a non-indented line that is not a wrap (a bullet or a
// numbered line; a non-indented line right under a non-blank line is a wrap). Indented lines stay in, and a fenced block stays in whole,
// blank lines and `#` lines included. The loading-state check uses the whole text so a finding's later paragraphs are never missed.
function narrowEnd(lines) {
  let fenceStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) { fenceStart = fenceStart === -1 ? i : -1; continue; }
    if (fenceStart !== -1) continue;
    if (l.trim() === '' || /^(#{1,6}\s|Reviewed files:)/i.test(l) || (!/^\s/.test(l) && /^([-*+]|\d+\.)\s/.test(l))) return i;
  }
  // A fence that never closes ends the text at its opening line, so it cannot swallow what follows (the triage notes).
  return fenceStart === -1 ? lines.length : fenceStart;
}

function loadingStateProblems(record, roots, read) {
  if (!record.files.length || !CATEGORY_REASON.test(outsideQuote(record.line))) return [];
  const bodies = record.files.map((f) => read(f, roots)).filter((b) => b !== null);
  const hit = bodies.some((body) => citedNumbers(record.line, new Set(findingNumbers(body))).some((n) => LOADING_FINDING.test(findingText(body, n))));
  return hit ? [LOADING_PROBLEM] : [];
}

// Slice 21: the coordinator's reason for a skip is a real sentence, not a placeholder ("(no fix)", "low, follow-up",
// "same as check #N", "(coordinator's triage)", an empty "()"). The reasons read are the parenthetical notes outside the
// quoted finding and backticked paths, and the plain text left once the skip words, numbers and punctuation are removed.
const PLACEHOLDER = /^(?:no fix|none|n\/a|na|tbd|todo|later|skip(?:ped)?|(?:low|minor|nit)?[ ,;-]*follow[- ]?ups?|(?:low|minor|nit)(?: priority)?|same as(?: check| finding| review)?|(?:the )?coordinator['\u2019]?s triage|triage|coordinator['\u2019]?s call|not needed|won['\u2019]?t fix|wontfix)$/i;
const normalise = (text) => text.replace(/[\s.]+$/, '').replace(/^[\s:;,.-]+/, '').trim();
const bareLine = (line) => outsideQuote(line.replace(/\(\s*`[^`]*`\s*\)/g, ' ')).replace(/same as (?:check |finding |review )?#?\d+/gi, 'same as');
// The reason texts of a skip line: each parenthetical note, and the plain text left once the skip words, numbers and
// punctuation are removed (the trailing " - <reason>" of the `Skipped #N (path): "quote" - reason` form).
function reasonTexts(line) {
  const bare = bareLine(line);
  const notes = [...bare.matchAll(/\(([^)]*)\)/g)].map((m) => normalise(m[1]));
  const rest = bare.replace(/\([^)]*\)/g, ' ').replace(/\b(?:findings?\s+)?(?:skipped|skip|not applied|declined)\b/gi, ' ')
    .replace(/#?\b\d+\b/g, ' ').replace(/[:;,\-–]+/g, ' ');
  return { notes, rest: normalise(rest.replace(/\s+/g, ' ')) };
}
export function placeholderReasons(line) {
  const { notes, rest } = reasonTexts(line);
  return [...notes, rest].filter((r) => r === '' ? false : PLACEHOLDER.test(r));
}
// "Skip: 4 (why), 6, 9 (why)": a list of two or more numbers needs a note after each number.
const NUMBER_LIST = /#?\b\d+\b(?:\s*\([^)]*\))?(?:\s*(?:,|and|&)\s*#?\b\d+\b(?:\s*\([^)]*\))?)+/;
const SHARED_REASON = /^\s*(?::|[-–—]\s)/;
function numbersWithoutReason(line) {
  const afterSkipWord = bareLine(line).replace(/^[\s\S]*?\b(?:skipped|skip|not applied|declined)\b/i, '');
  const list = NUMBER_LIST.exec(afterSkipWord);
  if (!list) return [];
  // "Skipped 2, 5: <reason>" / "Skipped 2 and 5 - <reason>": one shared reason after the list covers every number.
  if (SHARED_REASON.test(afterSkipWord.slice(list.index + list[0].length))) return [];
  const items = list[0].split(/(?<=\))\s*(?:,|and|&)\s*|\s*(?:,|and|&)\s*(?=#?\d)/);
  const noted = (item) => /\([^)]*\S[^)]*\)/.test(item);
  // "3 and 5 (both duplicates of #2)": a last note that opens with both/all/each covers the whole list.
  if (items.length > 1 && /\(\s*(?:both|all|each|these)\b/i.test(items.at(-1)) && noted(items.at(-1))) return [];
  return items.filter((item) => !noted(item)).map((item) => item.replace(/\s+/g, ' ').trim());
}
function placeholderProblems(line) {
  const emptyNote = /\(\s*\)/.test(bareLine(line));
  const found = placeholderReasons(line);
  const bareNumbers = numbersWithoutReason(line).map((n) => `gives no reason for "${n}" (one reason per skipped number)`);
  return [...(emptyNote ? ['has an empty reason "()"'] : []), ...found.map((r) => `gives a placeholder reason ("${r}") instead of the coordinator's reason`), ...bareNumbers];
}

function citedFileProblems(record, roots, read) {
  if (!record.files.length) return ['cites no findings file (a path under reviews/ ending .md)'];
  const texts = record.files.map((f) => { const t = read(f, roots); return t === null ? null : squash(beforeOutcome(t)); });
  const missing = record.files.filter((_, i) => texts[i] === null);
  if (missing.length === record.files.length) return [`cited findings file not readable: ${missing.join(', ')}`];
  if (!record.reasons.length) return [`names no quoted reason (in double quotes, outside backticks, ${MIN_REASON}+ characters and ${MIN_REASON_WORDS}+ words) to look up in the findings file`];
  const readable = texts.filter((t) => t !== null);
  return record.reasons.filter((r) => !readable.some((t) => t.includes(squash(r)))).map((r) => `reason not found in the cited findings file: "${r}"`);
}

// The finding numbers a findings file lists: lines starting "N. ", N up to the count its VERDICT line gives (when it has one).
export function findingNumbers(text) {
  const verdict = /VERDICT:\s*(\d+)\s+findings?/i.exec(text);
  const limit = verdict ? Number(verdict[1]) : Infinity;
  const found = [...String(text).matchAll(/^\s*(\d+)\.\s/gm)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= limit);
  return [...new Set(found)];
}

// The finding numbers a record line names: "#3", "#3, #4", "#3-#5", "#3-5".
// `valid` (a Set of the numbers the cited findings file lists) keeps only real finding numbers; "PR #218" and "Slice #393" are never finding numbers.
export function citedNumbers(line, valid = null) {
  const out = [];
  for (const m of line.matchAll(/(?<!\b(?:PR|pull|Slice|issue|Decision)\s)#(\d+)(?:\s*[-–]\s*#?(\d+))?/gi)) {
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    for (let n = from; n <= to && n - from < 200; n++) out.push(n);
  }
  return valid ? out.filter((n) => valid.has(n)) : out;
}

// The expected skip line for one finding, built from the findings file's own words (Slice 393 item 1).
export function expectedSkipLine(number, file, findingText) {
  const own = String(findingText).split(/\r?\n/).find((l) => new RegExp(`^\\s*${number}\\.\\s`).test(l)) ?? '';
  const words = own.replace(/^\s*\d+\.\s*/, '').split(/\s+/).filter(Boolean).slice(0, 10).join(' ').replace(/"/g, "'");
  return `- Skipped #${number} (\`${file}\`): "${words || '<words from the finding>'}" <why it is not applied>`;
}

// Slice 33 item 35: when the finding cannot be read, a format problem still shows one valid skip line.
const GENERIC_EXAMPLE = 'example of a valid skip line: - Skipped #3 (`reviews/pr-12-high.md`): "the exact words the finding file gives for it" <why it is not applied>';

// The line a skip with a bad reason should read, when its number and file are known.
function expectedFor(record, roots, read, problem = '') {
  const file = record.files[0];
  const body = file ? read(file, roots) : null;
  const number = citedNumbers(record.line, body ? new Set(findingNumbers(body)) : null)[0];
  if (number && body) return `\n    expected: ${expectedSkipLine(number, file, body)}`;
  return problem === LOADING_PROBLEM || problem === BY_DESIGN_PROBLEM ? '' : `\n    ${GENERIC_EXAMPLE}`;
}

export function checkSliceText(text, roots, read = readFinding) {
  const records = skipRecords(reviewSectionLines(text)).filter((r) => !isLegacyRecord(r));
  return records.flatMap((record) => skipProblems(record, roots, read)
    .map((p) => `${p}\n    ${record.line}${expectedFor(record, roots, read, p)}`));
}

function isEntryPoint() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) {
  const roots = [];
  const files = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') roots.push(resolve(args[++i] ?? '.'));
    else files.push(args[i]);
  }
  if (!files.length) { process.stderr.write('usage: check-review-skips.mjs [--root <dir>]... <slice-file>...\n'); process.exit(2); }
  const search = roots.length ? roots : [process.cwd(), dirname(process.cwd())];
  let bad = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    // No section at all is not "no skips": a heading variant would otherwise bypass the check.
    if (!reviewSectionLines(text).length) { bad++; process.stdout.write(`${file}: no *From review:* section found (write one, even "no findings skipped")\n`); continue; }
    for (const problem of checkSliceText(text, search)) { bad++; process.stdout.write(`${file}: ${problem}\n`); }
  }
  process.exit(bad ? 1 : 0);
}
