import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findingText, LOADING_FINDING, reviewSectionLines, skipRecords, checkSliceText as checkFull, findingNumbers, citedNumbers, isLegacyRecord } from './check-review-skips.mjs';

const checkSliceText = checkFull;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-skips-'));
fs.mkdirSync(path.join(dir, 'reviews'));
fs.writeFileSync(path.join(dir, 'reviews', 'x-high.md'), '# Findings\n\n3. The helper is only\nused once, so inlining it would be churn.\n');
fs.writeFileSync(path.join(dir, 'reviews', 'sev.md'), [
  '# Findings', '',
  '1. a.md:1, low: the loop is intentional churn, per Decision 7; worth a comment.',
  '2. b.md:2, medium: the retry is deliberately silent and by design hides the error.',
  '3. c.md:3, high: the flag is unused.',
  '4. d.md:4: no severity word here.', ''].join('\n'));
const slice = (lines) => `# Slice 9\n\n*From review:* high pass.\n${lines.join('\n')}\n\n#### Next heading\n- skipped #9 elsewhere\n`;
const check = (lines) => checkSliceText(slice(lines), [dir]);

test('a skip whose quoted reason is in the cited findings file passes (whitespace and case ignored)', () => {
  assert.deepEqual(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be CHURN"']), []);
  assert.deepEqual(check(['- Skipped #3 (reviews/x-high.md): "helper is only used once"']), []);
});

test('a reason that the findings file does not contain is flagged', () => {
  const problems = check(['- Skipped #3 (`reviews/x-high.md`): "it was out of scope for this slice"']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /reason not found in the cited findings file/);
});

test('a skip with no cited file, an unreadable file, or no quoted reason is flagged', () => {
  assert.match(check(['- Skipped #3: "inlining it would be churn"'])[0], /cites no findings file/);
  assert.match(check(['- Skipped #3 (`reviews/gone.md`): "inlining it would be churn"'])[0], /not readable/);
  assert.match(check(['- Skipped #3 (`reviews/x-high.md`): out of scope'])[0], /no quoted reason/);
});

test('only the From review section counts, and applied findings need nothing', () => {
  const lines = reviewSectionLines(slice(['- Applied #1', '- Skipped #3 (`reviews/x-high.md`): "inlining"']));
  assert.equal(lines.some((l) => l.includes('elsewhere')), false);
  assert.equal(skipRecords(lines).length, 1);
  assert.deepEqual(check(['- Applied #1, #2']), []);
});

test('a quoted reason of a second cited file is found in either', () => {
  fs.writeFileSync(path.join(dir, 'reviews', 'x-medium.md'), 'Finding 2: leave the name, a rename touches every caller.\n');
  assert.deepEqual(check(['- Skipped #2 (`reviews/x-high.md`, `reviews/x-medium.md`): "a rename touches every caller"']), []);
});

test('a bold label ends the section, so later "skipped" text is not a skip record', () => {
  const text = '*From review:* high pass.\n- Applied #1\n\n**Not yet verified:**\n- the old build was skipped on the device\n';
  assert.deepEqual(checkSliceText(text, [dir]), []);
  assert.equal(reviewSectionLines(text).some((l) => l.includes('old build')), false);
});

test('a skip reason wrapped over two lines is read as one record', () => {
  const text = '*From review:* high pass.\n- Skipped #3 (`reviews/x-high.md`): "inlining it\n  would be churn"\n';
  assert.deepEqual(checkSliceText(text, [dir]), []);
  assert.equal(skipRecords(reviewSectionLines(text)).length, 1);
});

test('a From review section as a list item or bold label is found', () => {
  for (const head of ['- **From review:** high pass.', '1. From review: high', '- *From review:*']) {
    const text = `${head}\n- Skipped #3: "inlining it would be churn"\n`;
    assert.match(checkSliceText(text, [dir])[0], /cites no findings file/, head);
  }
});

test('negated statements are not skips, and a one-word quoted token is not a reason', () => {
  assert.deepEqual(checkSliceText('*From review:* none skipped; skipped nothing; not skipped.\n', [dir]), []);
  assert.match(checkSliceText('*From review:*\n- Skipped #3 (`reviews/x-high.md`): `x-high.md`\n', [dir])[0], /no quoted reason/);
});

test('Slice 315: only the first quoted string after the colon is the reason; later quoted words are explanation', () => {
  assert.deepEqual(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - the `helper` stays because "nobody else calls it"']), []);
  assert.deepEqual(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn", see `utils.ts` for why']), []);
  const wrongFirst = check(['- Skipped #3 (`reviews/x-high.md`): "an invented reason here" - but "inlining it would be churn"']);
  assert.equal(wrongFirst.length, 1);
});

test('Slice 315: the reason is the first quoted string after the cited path, even with a quote or no colon before it', () => {
  assert.deepEqual(check(['- Skipped #4 "inlining it would be churn": not an issue, see `reviews/x-high.md`']), []);
  assert.deepEqual(check(['- Skipped #4 `reviews/x-high.md` "inlining it would be churn" - not a bug']), []);
  assert.deepEqual(check(['- Skipped #4 (`reviews/x-high.md`) with `a:b` first, "inlining it would be churn"']), []);
});

test('Slice 315: one rule, backticked spans removed then the first double-quoted string, wherever it sits', () => {
  // Review 1: the reason quoted before the path, an identifier quoted after it.
  assert.deepEqual(check(['- Skipped #3 "inlining it would be churn" (`reviews/x-high.md`) because the "foo" helper is private']), []);
  // Review 2: a path whose case differs from the cited one, and a plain (unbackticked) path.
  assert.deepEqual(check(['- Skipped #3 (reviews/x-high.md): "inlining it would be churn"']), []);
  // Curly quotes count; a backticked quote is never the reason.
  assert.deepEqual(check(['- Skipped #3 (`reviews/x-high.md`): “inlining it would be churn”']), []);
  assert.match(check(['- Skipped #3 (`reviews/x-high.md`): `"inlining it would be churn"`'])[0], /no quoted reason/);
});

test('FL-1402: a double-quoted reason holding backticked words is read whole and matched ignoring backticks', () => {
  fs.writeFileSync(path.join(dir, 'reviews', 'bt.md'), '# Findings\n\n3. The list_open filter drops parts when empty.\n');
  assert.deepEqual(check(['- Skipped #3 (reviews/bt.md): "the `list_open` filter drops parts"']), []);
  assert.match(check(['- Skipped #3 (reviews/bt.md): "the `list_open` filter keeps parts"'])[0], /reason not found/);
  assert.match(check(['- Skipped #3 (reviews/bt.md): `"the list_open filter drops parts"`'])[0], /no quoted reason/);
});

test('FL-1402: a verbatim reason with backticks touching punctuation is found (both sides normalised alike)', () => {
  fs.writeFileSync(path.join(dir, 'reviews', 'bt3.md'), '# Findings\n\n3. In the `a`/`b` case the `foo`s are dropped.\n');
  assert.deepEqual(check(['- Skipped #3 (reviews/bt3.md): "in the `a`/`b` case the `foo`s are dropped"']), []);
});

test('FL-1402: backticks in the findings text and adjacent spans, and two identifiers are not a reason', () => {
  fs.writeFileSync(path.join(dir, 'reviews', 'bt2.md'), '# Findings\n\n3. The `list_open` filter drops `get_item` parts.\n');
  assert.deepEqual(check(['- Skipped #3 (reviews/bt2.md): "the list_open filter drops get_item parts"']), []);
  assert.deepEqual(check(['- Skipped #3 (reviews/bt2.md): “the `list_open` filter drops `get_item` parts”']), []);
  // Adjacent spans are two words, not one glued token.
  assert.match(check(['- Skipped #3 (reviews/bt2.md): "the `list_open``get_item` parts"'])[0], /reason not found/);
  // Two bare identifiers in backticks inside the quotes carry no reason.
  assert.match(check(['- Skipped #3 (reviews/bt2.md): "`list_open` `get_item`"'])[0], /no quoted reason/);
  // An odd number of backticks does not throw.
  assert.equal(check(['- Skipped #3 (reviews/bt2.md): "a stray ` tick in the reason"']).length, 1);
});

test('Slice 21 review: one shared reason after the number list covers every number', () => {
  assert.deepEqual(check(['- Skipped #3, #4 (`reviews/x-high.md`): "inlining it would be churn"']), []);
  assert.deepEqual(check(['- Skipped 2, 5: "inlining it would be churn" (reviews/x-high.md)']), []);
  assert.deepEqual(check(['- Skipped findings 2 and 5 - both are churn, see "inlining it would be churn" in reviews/x-high.md']), []);
  assert.match(check(['- Skipped 2, 5 (reviews/x-high.md)'])[0], /gives no reason for "2"/);
});

test('Slice 315: an intro line ending "skipped:" is not a skip record; its bullets are', () => {
  assert.deepEqual(skipRecords(['*From review:* high pass, findings skipped:', '- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn"']).length, 1);
  assert.deepEqual(check(['Findings skipped:', '- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn"']), []);
});

test('Slice 376 item 8: a skip that says "by design" needs a Decision number or the user\'s words', () => {
  const bare = check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - by design']);
  assert.equal(bare.length, 1);
  assert.match(bare[0], /by design/);
  assert.deepEqual(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - by design, Decision 137']), []);
  assert.deepEqual(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - by design, user: "keep the helper"']), []);
  assert.deepEqual(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - by design, the user said "keep it as is"']), []);
});

test('Slice 376 round 3: a bare "user said" or "user confirmed" without a quoted span no longer counts', () => {
  assert.equal(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - by design, the user said keep it']).length, 1);
  assert.equal(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - by design, user confirmed']).length, 1);
  assert.equal(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - by design, Decision']).length, 1);
});

test('Slice 376 round 5: any severity needs the citation; a low skip just must not say "by design"', () => {
  assert.equal(check(['- Skipped #1 (`reviews/sev.md`): "the loop is intentional churn" - by design']).length, 1);
  assert.deepEqual(check(['- Skipped #1 (`reviews/sev.md`): "the loop is intentional churn" - low, not worth the churn']), []);
  assert.deepEqual(check(['- Skipped #1 (`reviews/sev.md`): "the loop is intentional churn" - by design, Decision 7']), []);
});

test('Slice 376 item 8: "by design" or a Decision number inside the quoted finding text does not count', () => {
  assert.deepEqual(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - not a bug']), []);
  const quoted = check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - by design']);
  assert.equal(quoted.length, 1);
});

test('Slice 376 round 3: by-design words or a Decision number inside the quoted reason are the finding text, not the skip reason', () => {
  assert.deepEqual(check(['- Skipped #2 (`reviews/sev.md`): "the retry is deliberately silent and by design hides the error" - not a bug']), []);
  const quoteOnly = check(['- Skipped #1 (`reviews/sev.md`): "the loop is intentional churn, per Decision 7" - rewrote the loop']);
  assert.deepEqual(quoteOnly, []);
});

test('Slice 376 item 8: other phrasings of "by design" need a citation too', () => {
  for (const phrase of ['by-design', 'as designed', 'intentional', 'deliberately left']) {
    assert.equal(check([`- Skipped #3 (\`reviews/x-high.md\`): "inlining it would be churn" - ${phrase}`]).length, 1, phrase);
  }
});

test('the command exits 1 for a slice file with no From review section, 0 for one that checks out', () => {
  const script = fileURLToPath(new URL('./check-review-skips.mjs', import.meta.url));
  const bare = path.join(dir, 'bare.md');
  fs.writeFileSync(bare, '# Slice\n\nNo review notes at all.\n');
  const ok = path.join(dir, 'ok.md');
  fs.writeFileSync(ok, '# Slice\n\n- **From review:** none skipped.\n');
  const run = (file) => spawnSync(process.execPath, [script, '--root', dir, file], { encoding: 'utf8' });
  assert.equal(run(bare).status, 1);
  assert.match(run(bare).stdout, /no \*From review:\* section/);
  assert.equal(run(ok).status, 0);
});

fs.writeFileSync(path.join(dir, 'reviews', 'cov.md'), [
  'VERDICT: 3 findings (1 high, 2 low).', '',
  '1. a.md:1, high, the loop never ends when the list is empty.',
  '2. b.md:2, low, the name is vague.',
  '3. c.md:3, low, the helper is only used once.', ''].join('\n'));
const covCheck = (lines) => checkFull(slice(lines), [dir]);

test('Slice 393 item 1: a failing skip prints the exact skip line expected, from the finding file\'s own words', () => {
  const problems = checkFull(slice(['- Skipped #3 (`reviews/cov.md`): "it was out of scope for this slice"', '- Applied #1, #2']), [dir]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /expected: - Skipped #3 \(`reviews\/cov\.md`\): "c\.md:3, low, the helper is only used once\."/);
});

test('Slice 33 item 35: a failing skip with an unreadable finding still prints one example of a valid skip line', () => {
  const problems = checkFull(slice(['- Skipped #3 (`reviews/gone.md`): "inlining it would be churn"']), [dir]);
  assert.match(problems[0], /example of a valid skip line: - Skipped #3 \(`reviews\/pr-12-high\.md`\): "/);
  assert.match(check(['- Skipped #3: "inlining it would be churn"'])[0], /example of a valid skip line/);
});

test('Slice 33 item 19: findings under a second repo\'s reviews folder pass by absolute path or by a second --root', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'review-skips-other-'));
  fs.mkdirSync(path.join(other, 'reviews'));
  fs.writeFileSync(path.join(other, 'reviews', 'far.md'), '1. the cache is never cleared on logout.\n');
  const abs = path.join(other, 'reviews', 'far.md').replace(/\\/g, '/');
  assert.deepEqual(checkFull(slice([`- Skipped #1 (\`${abs}\`): "cache is never cleared on logout"`]), [dir]), []);
  assert.deepEqual(checkFull(slice(['- Skipped #1 (`reviews/far.md`): "cache is never cleared on logout"']), [dir, other]), []);
  const script = fileURLToPath(new URL('./check-review-skips.mjs', import.meta.url));
  const file = path.join(dir, 'tworoot.md');
  fs.writeFileSync(file, slice(['- Skipped #1 (`reviews/far.md`): "cache is never cleared on logout"']));
  assert.equal(spawnSync(process.execPath, [script, '--root', dir, '--root', other, file], { encoding: 'utf8' }).status, 0);
});

test('Slice 393 item 1: findings the slice does not mention are not demanded (per-finding coverage is not enforced)', () => {
  assert.deepEqual(covCheck(['- Skipped #3 (`reviews/cov.md`): "helper is only used once"']), []);
});

test('Slice 393 item 1: skip lines older than the checker are exempt', () => {
  const text = '*From review*:\n- Skipped #3 (`reviews/cov.md`) 2026-11-02: "not a real quote at all"\n';
  assert.deepEqual(checkFull(text, [dir]), []);
  // Review finding 4: a dated heading does not exempt an undated new skip, and a newer date on the line wins.
  const undated = '*From review* (2026-11-02):\n- Skipped #3 (`reviews/cov.md`): "not a real quote at all"\n';
  assert.ok(checkFull(undated, [dir]).length >= 1);
  const mixed = '*From review*:\n- Skipped #3 (`reviews/cov.md`) 2026-11-02, redone 2026-11-09: "not a real quote at all"\n';
  assert.ok(checkFull(mixed, [dir]).length >= 1);
  const fresh = '*From review* (2026-11-09):\n- Skipped #3 (`reviews/cov.md`): "not a real quote at all"\n';
  assert.ok(checkFull(fresh, [dir]).length >= 1);
  const [record] = skipRecords(reviewSectionLines(text));
  assert.equal(isLegacyRecord(record), true);
});

test('Slice 393 item 1: findingNumbers and citedNumbers read the numbers', () => {
  assert.deepEqual(findingNumbers('VERDICT: 2 findings\n1. a\n2. b\n3. step of 2\n'), [1, 2]);
  assert.deepEqual(citedNumbers('Applied #1, #3-#5 and #7-8'), [1, 3, 4, 5, 7, 8]);
  // Review finding 5: only numbers the findings file lists, never "PR #2" or "Slice #1".
  assert.deepEqual(citedNumbers('Skipped #2 in PR #1, Slice #3, #9', new Set([1, 2, 3])), [2]);
  assert.deepEqual(citedNumbers('Applied #1 per PR #218'), [1]);
});

test('Slice 35 item 25: a reason built only from the finding\'s own words is refused unless marked reconstructed', () => {
  const echo = check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - helper is used once, inlining would be churn']);
  assert.equal(echo.length, 1);
  assert.match(echo[0], /built only from the finding's own words/);
  assert.deepEqual(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - helper is used once, inlining would be churn (reconstructed)']), []);
  assert.deepEqual(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - the caller keeps it for the next slice']), []);
  assert.deepEqual(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn"']), []);
  // Review finding 1: no `#N` means no echo check; several numbers likewise.
  assert.deepEqual(check(['- Skipped (`reviews/x-high.md`): "inlining it would be churn" - helper is used once, inlining would be churn']), []);
  assert.deepEqual(check(['- Skipped #3, #4 (`reviews/x-high.md`): "inlining it would be churn" - helper is used once, inlining would be churn']), []);
  // Review finding 2: a short reason of the finding's common words is a judgement, not an echo.
  assert.deepEqual(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - helper used once']), []);
  // Review finding 1: `reconstructed` inside the quoted finding is not the escape hatch.
  fs.writeFileSync(path.join(dir, 'reviews', 'recon.md'), '# Findings\n\n3. The map is reconstructed on every call, so the cache never helps.\n');
  const quotedWord = check(['- Skipped #3 (`reviews/recon.md`): "the map is reconstructed on every call" - the cache never helps on every call, so the map is']);
  assert.equal(quotedWord.length, 1);
  assert.match(quotedWord[0], /built only from the finding's own words/);
  // `reconstructed` in another case still counts.
  assert.deepEqual(check(['- Skipped #3 (`reviews/x-high.md`): "inlining it would be churn" - helper is used once, inlining would be churn (Reconstructed)']), []);
});

test('Slice 21: a placeholder coordinator reason is a problem, a real one passes', async () => {
  const { skipProblems } = await import('./check-review-skips.mjs');
  const read = () => 'the cache is never cleared on logout';
  const rec = (line) => ({ line, files: ['reviews/pr-1-high.md'], reasons: ['the cache is never cleared on logout'] });
  for (const tail of ['(no fix)', '(low, follow-up)', '(same as check #4)', "(coordinator's triage)", '()']) {
    const problems = skipProblems(rec(`- Skipped #3 (\`reviews/pr-1-high.md\`) ${tail}: "the cache is never cleared on logout"`), [], read);
    assert.ok(problems.length > 0, `${tail} should be flagged`);
  }
  assert.deepEqual(skipProblems(rec('- Skipped #3 (`reviews/pr-1-high.md`) (logout is out of scope for this slice): "the cache is never cleared on logout"'), [], read), []);
  assert.deepEqual(skipProblems(rec('- Skipped #3 (`reviews/pr-1-high.md`): "the cache is never cleared on logout" - logout is out of scope here'), [], read), []);
  assert.deepEqual(skipProblems(rec('- Skip: 4 (a real reason here), 6 (another real reason)'), [], read).filter((p) => /placeholder|no reason|no coordinator/.test(p)), []);
});

test('Slice 21: a bare number in a list, "low priority" and "same as" lists are flagged', async () => {
  const { skipProblems } = await import('./check-review-skips.mjs');
  const read = () => 'the cache is never cleared on logout';
  const rec = (line) => ({ line, files: ['reviews/pr-1-high.md'], reasons: ['the cache is never cleared on logout'] });
  const flagged = (line) => skipProblems(rec(line), [], read).length > 0;
  assert.ok(flagged('- Skipped 4, 6, 9: same as check #4 "the cache is never cleared on logout"'));
  assert.ok(flagged('- Skipped #3 (`reviews/pr-1-high.md`) (low priority): "the cache is never cleared on logout"'));
  assert.ok(flagged('- Skip: 4 (a real reason here), 6, 9 (another real reason)'));
  assert.ok(!skipProblems(rec('- Skipped 3 and 5 (both duplicates of #2): "the cache is never cleared on logout"'), [], read).some((p) => /gives no reason/.test(p)));
  assert.ok(!skipProblems(rec('- Skip: 4 (no fix needed because x is unused), 6 (the finding is wrong)'), [], read).some((p) => /Skip"/.test(p)));
});

test('Slice 23 item 17: a skip line after a "Not yet verified" line is still checked', () => {
  const text = '#### From review\n\n- Not yet verified: the dry run (needs a real session).\n- Skipped: finding 3\n';
  assert.equal(skipRecords(reviewSectionLines(text)).length, 1);
});

test('Slice 23 item 17: a "Not yet verified" summary line that says skipped is not a skip with no reason', () => {
  const text = '#### From review\n\n- `reviews/s1-high.md` (3 findings, all read): 3 applied.\n- Not yet verified: the dry run was skipped (needs a real session).\n- **Not yet verified:** item 4 skipped, needs the host.\n';
  assert.deepEqual(skipRecords(reviewSectionLines(text)), []);
});

// Slice 29 item 43: a loading-state finding is never skipped for "no crash, data-loss, security or privacy fault".
fs.writeFileSync(path.join(dir, 'reviews', 'loading-medium.md'), [
  '# Findings', '',
  '1. App.tsx:10, medium: an aborted first load leaves the `loading` flag true, so the spinner never goes away.',
  '2. b.ts:2, medium: the retry count is never reset after a success.', ''].join('\n'));

test('Slice 29 item 43: a loading-state finding skipped as "no crash, data-loss, security or privacy" is refused', () => {
  const problems = check(['- Skipped #1 (`reviews/loading-medium.md`): "an aborted first load leaves the" - no crash, data-loss, security or privacy fault']);
  assert.ok(problems.some((p) => /loading-state finding/.test(p)), problems.join('\n'));
});

test('Slice 29 item 43: a loading-state finding skipped for another real reason, and a non-loading finding skipped on the category reason, pass', () => {
  assert.deepEqual(check(['- Skipped #1 (`reviews/loading-medium.md`): "an aborted first load leaves the" - covered by the retry button added in check 1']), []);
  assert.deepEqual(check(['- Skipped #2 (`reviews/loading-medium.md`): "the retry count is never reset" - no crash, data-loss, security or privacy fault']), []);
});

test('review fix: a finding keeps its own numbered steps, and a bare spinner mention is not a loading-state finding', () => {
  const body = '5. a.ts:1, medium: retry loop.\n   1. step one\n   2. step two\n   the `loading` flag stays true.\n6. b.ts:2, nit: spinner colour is wrong.\n';
  assert.match(findingText(body, 5), /`loading` flag stays true/);
  assert.doesNotMatch(findingText(body, 5), /spinner colour/);
  assert.equal(LOADING_FINDING.test(findingText(body, 6)), false);
  assert.equal(LOADING_FINDING.test('the spinner never goes away'), true);
});

test('Slice 35 batch C follow-up: the last finding ends before Reviewed files, a heading or the triage bullets', () => {
  const tail = '\nReviewed files:\nx.mjs abc\n\n## Outcome\n- 2 skipped: an extra example line is noise, not a wrong verdict.\n';
  const body = '1. a.mjs:1, nit: first.\n2. b.mjs:2, nit: last finding\n   wrapped line\n   1. sub step\n' + tail;
  assert.match(findingText(body, 2, true), /wrapped line/);
  assert.match(findingText(body, 2, true), /sub step/);
  assert.doesNotMatch(findingText(body, 2, true), /Reviewed files|Outcome|noise/);
  const bullets = '1. a.mjs:1, nit: only.\n\n- 1 skipped: triage words here.\n';
  assert.doesNotMatch(findingText(bullets, 1, true), /triage/);
  // The whole text (the default, used by the loading-state check) is not cut.
  assert.match(findingText(bullets, 1), /triage/);
});

test('Slice 35 batch C follow-up: the narrow text stops at a bullet with no blank line, keeps a wrap, a fence with `#` and blanks, and stops before the next finding', () => {
  const noBlank = '4. x.mjs:9, nit: foo\n- 4 skipped: triage words\n';
  assert.doesNotMatch(findingText(noBlank, 4, true), /triage/);
  const wrap = '1. x.mjs:9, nit: foo\nwrapped on\n- 1 skipped: triage\n';
  assert.match(findingText(wrap, 1, true), /wrapped on/);
  assert.doesNotMatch(findingText(wrap, 1, true), /triage/);
  const fenced = '1. x.mjs:9, nit: foo\n   ```\n   # comment\n\n   code\n   ```\n   after fence\n\nSkipped 1: triage\n';
  assert.match(findingText(fenced, 1, true), /# comment/);
  assert.match(findingText(fenced, 1, true), /after fence/);
  assert.doesNotMatch(findingText(fenced, 1, true), /triage/);
  const notLast = '1. a.mjs:1, nit: first\n\n- Fix: loose bullet\n2. b.mjs:2, nit: second\n';
  assert.match(findingText(notLast, 1, true), /first/);
  assert.doesNotMatch(findingText(notLast, 1, true), /second|loose bullet/);
  assert.match(findingText(notLast, 1), /loose bullet/);
});

test('Slice 35 batch C follow-up: a loading-state skip is still refused when the loading words sit in a later paragraph of the finding', () => {
  fs.writeFileSync(path.join(dir, 'reviews', 'loose-medium.md'), '1. App.tsx:10, medium: retry handling.\n\n- Failure scenario: the loading spinner never clears after an abort.\n\nReviewed files:\nApp.tsx abc\n');
  const problems = check(['- Skipped #1 (`reviews/loose-medium.md`): "retry handling." - no crash, data-loss, security or privacy fault']);
  assert.ok(problems.some((p) => /loading-state finding/.test(p)), problems.join('\n'));
});

test('Slice 35 batch C follow-up: a skip of the last finding whose reason is in the triage notes, not the finding, passes the echo check', () => {
  const body = '1. a.mjs:1, nit: the example is picked by `===` on two strings.\n\nReviewed files:\na.mjs abc\n\n## Outcome\n- 1 skipped: an extra example line under an unrelated problem is noise, not a wrong verdict.\n';
  assert.match(findingText(body, 1, true), /picked by/);
  assert.doesNotMatch(findingText(body, 1, true), /unrelated problem/);
  // The same through the checker: an honest reason that reuses only the triage words (not the finding's) is not an echo.
  fs.writeFileSync(path.join(dir, 'reviews', 'triage-medium.md'), body);
  const honest = '- Skipped #1 (`reviews/triage-medium.md`): "the example is picked by" - an extra example line under an unrelated problem is noise';
  assert.deepEqual(check([honest]), []);
  // Counter-case: a reason built from the finding's own words is still refused.
  const echo = '- Skipped #1 (`reviews/triage-medium.md`): "the example is picked by" - the example is picked by on two strings the example is';
  assert.ok(check([echo]).some((p) => /finding's own words/.test(p)), check([echo]).join('\n'));
});

test('Slice 35 batch C follow-up: an unclosed fence ends the narrow text at its opening line, so the triage notes after it are not finding words', () => {
  const body = '1. a.mjs:1, nit: the guard is wrong.\n   ```\n   code with no closing fence\n\n- 1 skipped: an unrelated triage sentence of many words here.\n';
  const narrow = findingText(body, 1, true);
  assert.match(narrow, /the guard is wrong/);
  assert.doesNotMatch(narrow, /code with no closing|triage sentence/);
  fs.writeFileSync(path.join(dir, 'reviews', 'unclosed-medium.md'), body);
  assert.deepEqual(check(['- Skipped #1 (`reviews/unclosed-medium.md`): "the guard is wrong" - an unrelated triage sentence of many words here']), []);
});

test('review fix: an earlier finding\'s indented sub-step "2." is not finding 2', () => {
  const body = '1. a.ts:1, nit: x.\n   1. step one\n   2. step two\n2. b.ts:2, medium: the real second.\n';
  assert.match(findingText(body, 2), /the real second/);
  assert.doesNotMatch(findingText(body, 2), /step two/);
});

test('Slice 34 review 1: a reason that only appears in the findings file\'s `## Outcome` block is not found', () => {
  fs.writeFileSync(path.join(dir, 'reviews', 'out-high.md'), '1. a.ts:1, nit: the real finding text.\n\n## Outcome\n\n1: Skipped - invented later reason here\n');
  const problems = check(['- Skipped #1 (`reviews/out-high.md`): "invented later reason here"']);
  assert.match(problems.join('\n'), /reason not found in the cited findings file/);
  assert.deepEqual(check(['- Skipped #1 (`reviews/out-high.md`): "the real finding text"']), []);
});

test('Slice 34 review 2: findingText of the last finding stops at `## Outcome`', () => {
  const body = '1. a.ts:1, nit: x.\n2. b.ts:2, nit: last one.\n\n## Outcome\n\n2: Skipped - spinner stays hidden by design\n';
  assert.doesNotMatch(findingText(body, 2), /spinner/);
  fs.writeFileSync(path.join(dir, 'reviews', 'out2-high.md'), body);
  assert.deepEqual(check(['- Skipped #2 (`reviews/out2-high.md`): "last one" - no crash, cosmetic']), []);
});
