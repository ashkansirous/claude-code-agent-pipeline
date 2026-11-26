// node --test skills/feedback-loop/question-stop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mirrorAgentInstalled, dueWhenMirrorInstalled, endsWithQuestion, endsWithOffer, decide,isEntryPoint, promisesFixWithoutSlice, promisesTimedCheck, timerRunningIn, userStepWithoutLink, ciClaimUnchecked, editsBeyondAsk, warnings } from './question-stop.mjs';
import { mark, dueForSession } from './mirror-due.mjs';

const HOOK = fileURLToPath(new URL('./question-stop.mjs', import.meta.url));

test('detects a trailing question through markdown noise', () => {
  assert.ok(endsWithQuestion('Shall I go on?'));
  assert.ok(endsWithQuestion('Shall I go on? **\n'));
  assert.ok(!endsWithQuestion('Done. What changed: x?  Nothing else.'));
  assert.ok(!endsWithQuestion(undefined));
});

test('an offer in the last paragraph blocks even with a full stop; one earlier or absent does not', () => {
  assert.ok(endsWithOffer('Merged.\n\nIf you want, I can make the hook count docs/design files as docs.'));
  assert.ok(endsWithOffer("Timer stopped. Say \"resume checks\" and I'll start it again."));
  assert.ok(endsWithOffer('Done.\n\nLet me know if you want the rest.'));
  assert.ok(endsWithOffer('Stopped. Say “resume checks” and I’ll start it again.'));
  assert.ok(!endsWithOffer('Done. The rule says what I should do next time.'));
  assert.ok(!endsWithOffer('If you want the details, they are in the note.\n\nreleased: nothing left running.'));
  assert.ok(!endsWithOffer('All done.'));
  assert.equal(decide({ last_assistant_message: "Say 'go' and I'll build it." }).decision, 'block');
});

test('an offer phrase quoted while explaining it is not an offer; a real one beside a quote still blocks', () => {
  assert.ok(!endsWithOffer('The hook looks for offers ("if you want, I can...", "say X and I\'ll...").\n\nNothing waits on you.'));
  assert.ok(!endsWithOffer('It matched “if you want, I can rerun it” in the quote.'));
  assert.ok(!endsWithOffer('The hook blocked on the phrase "if you want, I can..."'));
  assert.ok(endsWithOffer('A 5" screen. If you want, I can fix "it".'));
  assert.ok(endsWithOffer('The phrase `want me to` is in its list.'));
  assert.ok(endsWithOffer('The hook quoted "if you want, I can...".\n\nIf you want, I can fix it.'));
  assert.ok(endsWithOffer('Stopped. Say "resume checks" and I\'ll start it again.'));
});

test('Slice 35 item 23: single-quoted offers, a stray quote that must not eat the next span, and apostrophes', () => {
  assert.ok(!endsWithOffer("The hook looks for 'if you want, I can...' in the last paragraph."));
  assert.ok(!endsWithOffer('It matched ‘if you want, I can rerun it’ in the quote.'));
  assert.ok(!endsWithOffer('A 5" screen is the case; the phrase is "if you want, I can fix it".'));
  assert.ok(!endsWithOffer('It said ‘if you want, I can say it isn’t so’ in the quote.'));
  assert.ok(endsWithOffer("Don't worry. If you want, I can fix it."));
  assert.ok(endsWithOffer("It's done. Say 'go' and I'll build it."));
  // Medium check 1 #1: the closer of a non-offer pair must not open a span that hides the real offer.
  assert.ok(endsWithOffer('The key is "go" if you want, I can say "x"'));
});

test('Slice 35 item 23: the block reason says it is for Claude, names both triggers and what to do instead', () => {
  const { decision, reason } = decide({ last_assistant_message: 'Want me to rerun it?' });
  assert.equal(decision, 'block');
  assert.match(reason, /^Note to Claude from the question-stop hook \(nothing for the user to do\)/);
  assert.match(reason, /question or an offer/);
  assert.match(reason, /Waiting for your answer/);
  assert.match(reason, /do the work instead of asking\.$/);
});

test('a promised fix without a slice number blocks; naming the slice passes (Slice 22)', () => {
  assert.ok(promisesFixWithoutSlice("That will be fixed. The fix isn't built yet."));
  assert.ok(promisesFixWithoutSlice('The bug will be fixed in the next wave.'));
  assert.ok(!promisesFixWithoutSlice('It will be fixed in AgentPipeline Slice 22 (planned, per origin/main).'));
  assert.ok(!promisesFixWithoutSlice('The typo will be fixed by the PR I just opened.')); // a bare "will be fixed" is no promise (#7)
  assert.ok(promisesFixWithoutSlice("I'll fix it in the next slice."));
  assert.ok(promisesFixWithoutSlice('A follow-up slice will fix it.'));
  assert.ok(promisesFixWithoutSlice("I'll fix this tomorrow."));
  assert.ok(!promisesFixWithoutSlice('Slices 22 and 23 will fix it later.')); // named (#8)
  assert.ok(!promisesFixWithoutSlice('S22 will be fixed later.'));
  assert.ok(!promisesFixWithoutSlice('All done, nothing to fix.'));
  assert.ok(!promisesFixWithoutSlice('The fix is done and merged.'));
  assert.equal(decide({ last_assistant_message: "The fix isn't built yet." }, () => []).decision, 'block');
  assert.equal(decide({ last_assistant_message: "Slice 22 will be fixed there." }, () => []), null);
});

test('a strong offer above the last paragraph blocks; a broad phrase there does not', () => {
  assert.ok(endsWithOffer('Blocked by the merge gate.\n\nIf you want, I can make the hook count docs/design as docs.\n\nStatus: wave 1 still running.'));
  assert.ok(endsWithOffer("Timer stopped. Say 'resume checks' and I'll restart it.\n\nreleased: nothing."));
  assert.ok(endsWithOffer('Do you want me to fix it?\n\nStatus: done.'));
  assert.ok(endsWithOffer("Let me know if you'd like me to rerun it.\n\nStatus: done."));
  assert.ok(!endsWithOffer('If you want the details, they are in the note.\n\nStatus: done.'));
  assert.ok(!endsWithOffer('If you like, the log is at x.\n\nreleased: nothing.'));
});

test('blocks once: stop_hook_active passes', () => {
  assert.equal(decide({ last_assistant_message: 'ok?' }).decision, 'block');
  assert.equal(decide({ stop_hook_active: true, last_assistant_message: 'ok?' }), null);
  assert.equal(decide({ last_assistant_message: 'All done.' }, () => []), null);
});

test('trailing code spans, code blocks and URLs are not questions', () => {
  assert.ok(!endsWithQuestion('Fixed. See `what changed?`'));
  assert.ok(!endsWithQuestion('Fixed. See https://example.com/page?'));
  assert.ok(!endsWithQuestion('Fixed.\n```\nwhy?\n```\n'));
  assert.ok(endsWithQuestion('Did `x` work?'));
});

test('no last_assistant_message passes (no transcript guessing)', () => {
  assert.equal(decide({ transcript_path: 'nope.jsonl' }, () => []), null);
});

// The spawned hook reads mirror-due markers from CLAUDE_CONFIG_DIR: always a temp folder, never the real ~/.claude.
const tempConfigEnv = () => ({ ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'question-stop-cfg-')) });

test('script prints block JSON for a question and nothing otherwise', () => {
  const env = tempConfigEnv();
  const run = msg => spawnSync('node', [HOOK], { input: JSON.stringify({ last_assistant_message: msg }), encoding: 'utf8', env });
  assert.equal(JSON.parse(run('Want me to?').stdout).decision, 'block');
  assert.equal(run('Done.').stdout, '');
  assert.equal(spawnSync('node', [HOOK], { input: 'garbage', encoding: 'utf8', env }).status, 0);
});

test('full-width and Arabic question marks count as questions', () => {
  assert.ok(endsWithQuestion('Continue\uFF1F'));
  assert.ok(endsWithQuestion('Continue \u061F'));
});

test('the hook runs when called through a linked skills folder, as installed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'question-stop-'));
  const link = path.join(dir, 'feedback-loop');
  try {
    fs.symlinkSync(path.dirname(HOOK), link, 'junction');
    const run = spawnSync(process.execPath, [path.join(link, 'question-stop.mjs')], { input: JSON.stringify({ last_assistant_message: 'Want me to?' }), encoding: 'utf8', env: tempConfigEnv() });
    assert.equal(run.status, 0);
    assert.equal(JSON.parse(run.stdout).decision, 'block');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('a failed realpath falls back to the plain path and says why, instead of turning the hook off', () => {
  const missing = path.join(os.tmpdir(), 'question-stop-missing', 'x.mjs');
  assert.equal(isEntryPoint(missing, pathToFileURL(missing).href), true);
  assert.equal(isEntryPoint(missing, pathToFileURL(path.join(os.tmpdir(), 'elsewhere', 'y.mjs')).href), false);
});

test('a bad hook input fails open with a reason on stderr', () => {
  const run = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env: tempConfigEnv() });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /question-stop: failed open/);
});

test('Slice 21: a turn ending on an offer to run a check is blocked and asked to run it', () => {
  const none = () => [];
  const sentence = 'The number is 4.2. I can rerun that calculation with the cap reading if useful. I haven\'t run that yet.';
  const verdict = decide({ last_assistant_message: sentence }, none);
  assert.equal(verdict.decision, 'block');
  assert.match(verdict.reason, /run it now/);
  assert.equal(decide({ last_assistant_message: 'I ran the calculation: 4.2.' }, none), null);
});

test('Slice 21: an honest "not run, and why" statement is not blocked', () => {
  const none = () => [];
  for (const msg of [
    'The device run is not run yet by design: it needs the test phone.',
    'I did not run that on a device; it needs the phone.',
    'Tests: 12 pass. I have not verified it on iOS (needs Mac).',
    'I can check the logs.',
    'I can rerun that on the device if useful, but it needs the phone, which is not here.',
  ]) assert.equal(decide({ last_assistant_message: msg }, none), null, msg);
});

test('Slice 21: the mirror reminder fires only in the marker repo, once per session, and expires after 24 hours', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'question-stop-due-'));
  const repo = path.join(dir, 'myrepo');
  fs.mkdirSync(repo);
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  mark('owner/myrepo', 'abcdef1234567890', path.join(dir, 'state'), Date.now() - 20 * 60 * 1000);
  const forSession = (input) => dueForSession(input, path.join(dir, 'state'));
  assert.deepEqual(forSession({ session_id: 's1', cwd: dir }), []);
  assert.equal(forSession({ session_id: 's1', cwd: repo }).length, 1);
  assert.deepEqual(forSession({ session_id: 's1', cwd: repo }), []);
  assert.equal(forSession({ session_id: 's2', cwd: repo }).length, 1);
  mark('owner/myrepo', 'abcdef1234567890', path.join(dir, 'state'), Date.now() - 25 * 60 * 60 * 1000);
  assert.deepEqual(forSession({ session_id: 's3', cwd: repo }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Slice 21 review: a Stop input with no last_assistant_message neither blocks nor spends the mirror reminder', () => {
  let calls = 0;
  const due = () => { calls++; return [{ repo: 'owner/repo', sha: 'abcdef1234567890', at: 0 }]; };
  assert.equal(decide({ transcript_path: 'x.jsonl' }, due), null);
  assert.equal(decide({ last_assistant_message: 42 }, due), null);
  assert.equal(calls, 0);
  assert.equal(decide({ last_assistant_message: 'Merged.' }, due).decision, 'block');
  assert.equal(calls, 1);
});

test('the Mirror due check is skipped when the mirror-to-drive agent is not installed', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'question-stop-agents-'));
  try {
    assert.equal(mirrorAgentInstalled({ CLAUDE_CONFIG_DIR: cfg }), false);
    assert.deepEqual(dueWhenMirrorInstalled({ session_id: 's' }, { CLAUDE_CONFIG_DIR: cfg }), []);
    fs.mkdirSync(path.join(cfg, 'agents'));
    fs.writeFileSync(path.join(cfg, 'agents', 'mirror-to-drive.md'), 'x');
    assert.equal(mirrorAgentInstalled({ CLAUDE_CONFIG_DIR: cfg }), true);
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
});

test('Slice 21: an unmirrored marker older than 10 minutes blocks the stop once and names the repo', () => {
  const due = () => [{ repo: 'owner/repo', sha: 'abcdef1234567890', at: 0 }];
  const verdict = decide({ last_assistant_message: 'Merged.' }, due);
  assert.equal(verdict.decision, 'block');
  assert.match(verdict.reason, /owner\/repo @ abcdef12/);
  assert.equal(decide({ stop_hook_active: true, last_assistant_message: 'Merged.' }, due), null);
  assert.equal(decide({ last_assistant_message: 'Merged.' }, () => []), null);
});

test('Slice 23 item 6: status sentences and a device name are not promises of a fix', () => {
  assert.ok(!promisesFixWithoutSlice("The fix isn't done in the old path, but it is merged."));
  assert.ok(!promisesFixWithoutSlice('The fix has not been made to the docs.'.replace('has not been made', "isn't made")));
  assert.ok(promisesFixWithoutSlice("The fix isn't built yet. Checked on the test phone phone."));
  assert.ok(!promisesFixWithoutSlice("The fix isn't built yet, see S23."));
});

// --- Slice 29 items 6, 7, 19, 27, 33, 44, 49, 50
import { holdsForReview, hasPlaceholderLink, admitsUnchecked, claimsUnnamedHolder, offersOverrule, whyWithoutCause, clickPathAfterDenial, transcriptFacts, findReviewHolds, findSettledQuestions, lintDocs } from './question-stop.mjs';

test('a final turn holding for the owner\'s review is blocked once; a quoted phrase is not', () => {
  assert.ok(holdsForReview('Slice 40 waits for your review before the build.'));
  assert.ok(holdsForReview('Held until you\'ve reviewed the mock.'));
  assert.ok(!holdsForReview('The hook refuses "waits for your review" in a body file.'));
  assert.equal(decide({ last_assistant_message: 'It waits for the owner\'s review.' }, () => []).decision, 'block');
  assert.equal(decide({ stop_hook_active: true, last_assistant_message: 'It waits for the owner\'s review.' }, () => []), null);
});

test('a placeholder link or value in a final turn is blocked (item 33)', () => {
  assert.ok(hasPlaceholderLink('Open [setup](<board address>/#/setup) and paste it.'));
  assert.ok(hasPlaceholderLink('Set AGENT_BOARD_URL=<your board address> first.'));
  assert.ok(hasPlaceholderLink('Go to https://<host>/setup now.'));
  assert.ok(!hasPlaceholderLink('Open https://example.com/setup now.'));
  assert.ok(!hasPlaceholderLink('```\nnode x.mjs <repo>/file\n```'));
});

test('"I haven\'t checked" and "I expect" are blocked once with a check-it-now reason (item 44)', () => {
  assert.ok(admitsUnchecked("I haven't checked whether the PR merged."));
  assert.ok(!admitsUnchecked('Checked: the PR merged.'));
  const verdict = decide({ last_assistant_message: "I haven't confirmed the deploy." }, () => []);
  assert.equal(verdict.decision, 'block');
  assert.match(verdict.reason, /check it now/);
  assert.equal(decide({ stop_hook_active: true, last_assistant_message: "I haven't confirmed the deploy." }, () => []), null);
});

test('an unnamed holder of a worktree is blocked; a named one passes (item 44)', () => {
  assert.ok(claimsUnnamedHolder('The removal failed: a process still holds it.'));
  assert.ok(claimsUnnamedHolder('My shell was still inside it.'));
  assert.ok(!claimsUnnamedHolder('A process still holds it: pid 4321 (node.exe).'));
});

test('"you can overrule" points are blocked (item 49)', () => {
  assert.ok(offersOverrule('Four defaults the owner can overrule: 1. tabs.'));
  assert.ok(!offersOverrule('Slice 40 stands.'));
  assert.equal(decide({ last_assistant_message: 'Defaults you can overrule: x.' }, () => []).decision, 'block');
});

test('a why question needs the cause in the first line (item 50)', () => {
  assert.ok(whyWithoutCause('why did you only show my machine', '1. Set the label\n2. Reload\n\nI made a mistake: no label.'));
  assert.ok(whyWithoutCause('Why did Claude skip it? Explain.\nThanks', '1. Set the label'));
  assert.ok(!whyWithoutCause('why did you only show my machine', 'I made a mistake: I never set the label.\n\n1. Reload'));
  assert.ok(!whyWithoutCause('Why did it fail', 'It failed because the token expired.'));
  assert.ok(!whyWithoutCause('fix the label', '1. Set the label'));
});

test('fix pass 2 #1: "why did the build fail?" never fires the why-check', () => {
  assert.ok(!whyWithoutCause('why did the build fail?', 'The build failed: missing env var.'));
  assert.ok(!whyWithoutCause('why do I still see this', '1. Reload'));
  assert.ok(whyWithoutCause('Why would you do that', '1. Reload'));
});

test('fix pass 2 #2: the reason may sit in the same paragraph, not only the sentence', () => {
  assert.ok(!admitsUnchecked("I haven't checked your phone. Because only you can reach it."));
  assert.ok(admitsUnchecked("I haven't checked your phone.\n\nBecause only you can reach it."));
});

test('fix pass 2 #3: a bare <x>/#... is not a placeholder link; one in a markdown link is', () => {
  assert.ok(!hasPlaceholderLink('Use <b>/#a here.'));
  assert.ok(!hasPlaceholderLink('Open <board address>/#/setup and paste it.'));
  assert.ok(hasPlaceholderLink('See [setup](<board address>/#/setup).'));
});

test('fix pass 2 #5: a failed ssh "Permission denied" is not a harness denial', () => {
  const file = writeTranscript([userMsg('go'), errorResult('Permission denied (publickey).')]);
  assert.equal(transcriptFacts(file).denied, false);
});

test('fix pass 2 #6: system-reminder and interrupt entries are not the user\'s message', () => {
  const file = writeTranscript([userMsg('why did you skip it?'), userMsg('<system-reminder>x</system-reminder>'), userMsg('[Request interrupted by user]'), { type: 'user', isMeta: true, message: { content: 'meta text' } }]);
  assert.equal(transcriptFacts(file).lastUserText, 'why did you skip it?');
  assert.equal(decide({ transcript_path: file, last_assistant_message: '1. Do this' }, () => []).decision, 'block');
});

test('an arrow click path after a denied call is flagged only after a denial (item 7)', () => {
  const text = 'Open /plugin -> agent-board -> Configure options -> Read plan cap.';
  assert.ok(clickPathAfterDenial(text, true));
  assert.ok(!clickPathAfterDenial(text, false));
  assert.ok(!clickPathAfterDenial('Done, the rule would allow it.', true));
});

function writeTranscript(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return file;
}
const userMsg = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const toolResult = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: text }] } });
const errorResult = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: text }] } });

test('transcriptFacts reads the last user message and a denial after it', () => {
  const file = writeTranscript([{ type: 'assistant', message: {} }, userMsg('why did it stop'), errorResult('Permission to use Bash has been denied.')]);
  const turn = { editedPaths: [], commands: [], assistantText: '' };
  assert.deepEqual(transcriptFacts(file), { lastUserText: 'why did it stop', denied: true, toolCalls: false, ...turn });
  const file2 = writeTranscript([errorResult('Permission to use Bash has been denied.'), userMsg('next')]);
  assert.deepEqual(transcriptFacts(file2), { lastUserText: 'next', denied: false, toolCalls: false, ...turn });
  assert.deepEqual(transcriptFacts('/no/such/file.jsonl'), { lastUserText: '', denied: false, toolCalls: false, ...turn });
});

test('fix pass 3 #1: "I didn\'t notice" and "I missed" are cause phrases', () => {
  assert.ok(!whyWithoutCause('why did you merge it?', "I didn't notice the gate was red."));
  assert.ok(!whyWithoutCause('why did you merge it?', 'I missed the red gate.'));
  assert.ok(whyWithoutCause('why did you merge it?', '1. The gate was red.'));
});

test('fix pass 3 #2: the assistant\'s own review pass is not a review hold', () => {
  assert.ok(!holdsForReview('Merged. Now waiting for my review pass to finish.'));
  assert.ok(holdsForReview('Now waiting for your review.'));
});

test('fix pass 3 #3: an API route placeholder in prose is not a placeholder link', () => {
  assert.ok(!hasPlaceholderLink('Calls GET https://api.github.com/repos/<owner>/<repo>/pulls to list them.'));
  assert.ok(hasPlaceholderLink('Open https://<host>/setup now.'));
});

test('fix pass 3 #5: a denial is cleared by a later successful tool call', () => {
  const file = writeTranscript([userMsg('go'), errorResult('Permission to use Bash has been denied.'), toolResult('ok')]);
  assert.equal(transcriptFacts(file).denied, false);
});

test('fix pass 3 #6: task-notification and command-echo entries are not the user\'s message', () => {
  const file = writeTranscript([userMsg('why did you skip it?'), userMsg('<task-notification>done</task-notification>'), userMsg('<command-name>/clear</command-name>'), userMsg('<local-command-stdout>x</local-command-stdout>')]);
  assert.equal(transcriptFacts(file).lastUserText, 'why did you skip it?');
});

test('decide blocks a why answer that opens on a step list, via the transcript', () => {
  const file = writeTranscript([userMsg('why didn\'t you do it yourself?')]);
  const verdict = decide({ transcript_path: file, last_assistant_message: '1. Do this\n2. Do that' }, () => []);
  assert.equal(verdict.decision, 'block');
  assert.match(verdict.reason, /cause/);
  assert.equal(decide({ transcript_path: file, last_assistant_message: 'I didn\'t check the tool list.\n\n1. Now done' }, () => []), null);
});

test('docs lint refuses a review hold and a settled Waiting question; a quoted user message passes', () => {
  assert.equal(findReviewHolds('Slice 40 waits for the owner\'s review.\nDone.').length, 1);
  assert.equal(findReviewHolds('Slice 40 waits; the user said "wait for my review" today.').length, 0);
  assert.equal(findReviewHolds('The owner asked "wait for your review".').length, 0);
  const doc = '## Waiting on the user\n- Keep the tab bar on top or bottom?\n- Which of the 18 findings to build\n\n## Next\n- tab bar is fine here\n';
  const found = findSettledQuestions(doc);
  assert.deepEqual(found.map((f) => f.line), [2, 3]);
  const body = 'Where it\'s live: x\nSlice 41 waits for your review.\n';
  const problems = lintDocs(['a.md', 'b.md'], (f) => (f === 'b.md' ? body : 'fine'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^b\.md:2:/);
});

test('--lint-docs exits 1 naming the file and line, 0 on a clean file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-lint-'));
  const bad = path.join(dir, 'status.md');
  const good = path.join(dir, 'ok.md');
  fs.writeFileSync(bad, 'Live.\nSlice 41 waits for your review.\n');
  fs.writeFileSync(good, 'Live.\n');
  const refused = spawnSync(process.execPath, [HOOK, '--lint-docs', bad], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /status\.md:2:/);
  assert.equal(spawnSync(process.execPath, [HOOK, '--lint-docs', good], { encoding: 'utf8' }).status, 0);
});

// --- Slice 29 fix pass 1: every false-block case from the high review passes
test('fix pass 1 #1: a placeholder path in inline code or a plain path is not a placeholder link', () => {
  assert.ok(!hasPlaceholderLink('Done. I put the file at `<worktree>/reviews/x.md`'));
  assert.ok(!hasPlaceholderLink('Done. I put the file at <worktree>/reviews/x.md'));
  assert.ok(!hasPlaceholderLink('Open `https://<host>/setup` later.'));
  assert.ok(hasPlaceholderLink('See [the board](<board address>/setup).'));
  assert.equal(decide({ last_assistant_message: 'Done. I put the file at `<worktree>/reviews/x.md`' }, () => []), null);
});

test('fix pass 1 #2 and #10: a flow, or a denial word in a normal result, does not block; a real denial plus a click path does', () => {
  assert.ok(!clickPathAfterDenial('Flow: main -> branch -> PR -> merge\n\nAll merged.', true));
  assert.ok(!clickPathAfterDenial('Branch flow: feature -> main -> deploy', true));
  assert.ok(clickPathAfterDenial('Blocked.\n\nOpen /plugin -> agent-board -> Configure options.', true));
  const okResult = writeTranscript([userMsg('summarise'), toolResult('docs say: access denied pages are logged; permission denied handling')]);
  assert.equal(transcriptFacts(okResult).denied, false);
  const notError = writeTranscript([userMsg('go'), { type: 'user', message: { content: [{ type: 'tool_result', is_error: false, content: 'Permission to use Bash has been denied.' }] } }]);
  assert.equal(transcriptFacts(notError).denied, false);
  const flow = 'Flow: main -> branch -> PR -> merge\n\nDone.';
  assert.equal(decide({ transcript_path: okResult, last_assistant_message: flow }, () => []), null);
});

test('fix pass 1 #3: a technical why, a long task and a why followed by tool calls are not blocked', () => {
  const none = () => [];
  const tech = writeTranscript([userMsg('why does this test fail?')]);
  assert.equal(decide({ transcript_path: tech, last_assistant_message: 'The test fails since X is null.' }, none), null);
  assert.equal(decide({ transcript_path: tech, last_assistant_message: 'It breaks. Fix below.' }, none), null);
  const task = writeTranscript([userMsg('Why is X broken? fix it and open the PR\nthen run the checks')]);
  assert.equal(decide({ transcript_path: task, last_assistant_message: 'Fixed. PR #3 merged.' }, none), null);
  const build = writeTranscript([userMsg('why did the build fail?')]);
  assert.equal(decide({ transcript_path: build, last_assistant_message: 'The build failed: missing env var.' }, none), null);
  const worked = writeTranscript([userMsg('why did you skip it?'), { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }]);
  assert.equal(decide({ transcript_path: worked, last_assistant_message: 'Fixed. PR #3 merged.' }, none), null);
  assert.ok(!whyWithoutCause('why did you skip it?', 'Due to a typo I skipped it.'));
});

test('fix pass 1 #4: "I expect" and a reasoned "I haven\'t checked" are not blocked', () => {
  assert.ok(!admitsUnchecked('I expect the build to take two minutes. Merged.'));
  assert.ok(!admitsUnchecked("I haven't checked your phone, because only you can."));
  assert.ok(admitsUnchecked("I haven't checked the deploy. Merged."));
});

test('fix pass 1 #5: a real owner step with a link or store review is not a settled question', () => {
  const doc = '## Waiting on the user\n- Submit v1.2 for App Store review: https://appstoreconnect.apple.com/apps/1/distribution\n- Approve the store review for the listing\n- Keep the tab bar on top or bottom?\n';
  assert.deepEqual(findSettledQuestions(doc).map((f) => f.line), [4]);
  assert.deepEqual(findSettledQuestions('## Waiting on the user\n- Check the mock colours on the phone: https://x.example/a\n'), []);
});

test('fix pass 1 #6: a quoted "review" does not hide a real hold', () => {
  assert.equal(findReviewHolds('Slice 5 waits for your review of the "review" card').length, 1);
  assert.equal(findReviewHolds('The user said "wait for my review".').length, 0);
});

test('fix pass 1 #7: --lint-docs with no files or a missing file exits 2', () => {
  const none = spawnSync(process.execPath, [HOOK, '--lint-docs'], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no files/);
  const missing = spawnSync(process.execPath, [HOOK, '--lint-docs', '/no/such/file.md'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /file\.md/);
});

test('fix pass 1 #8: a transcript larger than the tail is read from its end only', () => {
  const filler = { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(2000) }] } };
  const file = writeTranscript([userMsg('old question'), ...Array(400).fill(filler), userMsg('recent')]);
  assert.equal(transcriptFacts(file).lastUserText, 'recent');
});

const bgSleep = (id) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 600', run_in_background: true, timeout: 660000 } }] } });
const toolResultFor = (id, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const bgStarted = (id, task) => toolResultFor(id, `Command running in background with ID: ${task}. Output is being written to x`);
const notification = (task, status) => userMsg(`<task-notification><task-id>${task}</task-id><status>${status}</status></task-notification>`);

test('a promised timed check is detected in prose only', () => {
  for (const s of ['Next check at 03:17 UTC.', 'next check in 10 minutes', "I'll check again at 4pm.", 'I will check back in an hour.', 'Will check back at noon.']) assert.ok(promisesTimedCheck(s), s);
  assert.ok(!promisesTimedCheck('The hook says "next check at 03:17" when it is blocked.'));
  assert.ok(!promisesTimedCheck('Checked the build; it passed.'));
});

test('timerRunningIn: background sleep until its notification, or a wakeup after the last user message', () => {
  assert.equal(timerRunningIn([userMsg('go')]), false);
  assert.equal(timerRunningIn([userMsg('go'), bgSleep('t1'), bgStarted('t1', 'bq1x9')]), true);
  assert.equal(timerRunningIn([userMsg('go'), bgSleep('t1'), bgStarted('t1', 'bq1x9'), notification('bq1x9', 'completed')]), false);
  assert.equal(timerRunningIn([bgSleep('t1'), bgStarted('t1', 'bq1x9'), userMsg('next question')]), true);
  const notBg = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'sleep 5' } }] } };
  assert.equal(timerRunningIn([userMsg('go'), notBg, toolResultFor('t2', 'done')]), false);
  const wake = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w', name: 'ScheduleWakeup', input: {} }] } };
  assert.equal(timerRunningIn([userMsg('go'), wake]), true);
  assert.equal(timerRunningIn([wake, userMsg('later')]), false);
});

test('decide blocks a timed-check promise with no timer and passes with one', () => {
  const none = () => [];
  const text = 'Merged. Next check at 03:17 UTC.';
  const bare = writeTranscript([userMsg('go'), { type: 'assistant', message: { content: [{ type: 'text', text }] } }]);
  assert.match(decide({ transcript_path: bare, last_assistant_message: text }, none).reason, /no timer is running/);
  const timed = writeTranscript([userMsg('go'), bgSleep('t1'), bgStarted('t1', 'bq1x9')]);
  assert.equal(decide({ transcript_path: timed, last_assistant_message: text }, none), null);
  const done = writeTranscript([userMsg('go'), bgSleep('t1'), bgStarted('t1', 'bq1x9'), notification('bq1x9', 'completed')]);
  assert.ok(decide({ transcript_path: done, last_assistant_message: text }, none));
});

// FL-0852 items 4, 6, 26: warn-only checks (a systemMessage, never a block).
const toolUse = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `u-${name}`, name, input }] } });
const say = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('item 6: a user step with no link or reason warns; with a link or a reason it does not', () => {
  assert.match(userStepWithoutLink('Done.\n\nYou: restart Claude Code so the style loads.'), /no link/);
  assert.match(userStepWithoutLink('Done.\n\n1. check that the toast appears'), /no link/);
  assert.equal(userStepWithoutLink('You: press Submit at https://example.com/submit'), null);
  assert.equal(userStepWithoutLink('You: restart, because only you can restart your session.'), null);
  assert.equal(userStepWithoutLink('All checks passed.'), null);
});

test('item 26: a CI-state claim warns unless gh workflow list ran this turn', () => {
  assert.match(ciClaimUnchecked('Linux CI already tests the web app.', []), /gh workflow list/);
  assert.equal(ciClaimUnchecked('Linux CI already tests the web app.', ['gh workflow list --all']), null);
  assert.equal(ciClaimUnchecked('The build passed.', []), null);
});

test('item 4: edits to files the user did not name warn, unless a goal line was stated', () => {
  assert.match(editsBeyondAsk('edit settings.json and notes/a.md', ['D:/r/settings.json', 'D:/r/setup-x.ps1']), /setup-x\.ps1/);
  assert.equal(editsBeyondAsk('edit settings.json', ['D:/r/config/settings.json']), null);
  assert.equal(editsBeyondAsk('edit settings.json', ['D:/r/setup-x.ps1'], 'The goal is a settings edit; also touching the installer.'), null);
  assert.equal(editsBeyondAsk('make it faster', ['D:/r/setup-x.ps1']), null);
});

test('item 4 review: trailing dot, "e.g." and a named folder do not cause a false warning', () => {
  assert.equal(editsBeyondAsk('fix question-stop.mjs.', ['D:/r/skills/feedback-loop/question-stop.mjs']), null);
  assert.equal(editsBeyondAsk('fix the hook, e.g. when it fails', ['D:/r/skills/a.mjs']), null);
  assert.equal(editsBeyondAsk('edit skills/feedback-loop', ['D:/r/skills/feedback-loop/a.mjs']), null);
});

test('item 26 review: "CI checks are green" is not a claim about what CI covers', () => {
  assert.equal(ciClaimUnchecked('CI checks are green and the runs finished.', []), null);
});

test('item 26 review pass 2: "CI is on" warns, "CI tests passed" does not', () => {
  assert.match(ciClaimUnchecked('CI is on for this repo.', []), /gh workflow list/);
  assert.match(ciClaimUnchecked('The workflows are disabled until December.', []), /gh workflow list/);
  assert.equal(ciClaimUnchecked('Linux CI tests passed after the fix.', []), null);
});

test('warnings(): reads the turn from the transcript and the hook prints systemMessage without blocking', () => {
  const t = writeTranscript([userMsg('change settings.json'), toolUse('Edit', { file_path: 'D:/r/setup-x.ps1' }), toolUse('Bash', { command: 'ls' })]);
  const out = warnings({ transcript_path: t, last_assistant_message: 'Done. Linux CI already tests it.' });
  assert.match(out, /gh workflow list/);
  assert.match(out, /setup-x\.ps1/);
  const run = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ transcript_path: t, last_assistant_message: 'Done. Linux CI already tests it.' }), encoding: 'utf8' });
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.decision, undefined);
  assert.match(parsed.systemMessage, /nothing blocked/);
  const ran = writeTranscript([userMsg('go'), say('The goal is X.'), toolUse('Bash', { command: 'gh workflow list --all' })]);
  assert.equal(warnings({ transcript_path: ran, last_assistant_message: 'Linux CI already tests it.' }), null);
});
