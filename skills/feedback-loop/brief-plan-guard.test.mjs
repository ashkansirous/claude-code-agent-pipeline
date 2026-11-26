// node --test skills/feedback-loop/brief-plan-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, sliceNumbers, hint } from './brief-plan-guard.mjs';

const agent = (prompt, subagent_type = 'general-purpose') => ({ tool_name: 'Agent', cwd: 'D:/none', tool_input: { prompt, subagent_type } });
const noFiles = () => [];
const denied = (verdict) => verdict?.hookSpecificOutput?.permissionDecision === 'deny';
const reason = (verdict) => verdict.hookSpecificOutput.permissionDecisionReason;

test('a brief naming a slice without its file is denied, with the file named', () => {
  const verdict = decide(agent('Run Slice 350 part A: copy page 5 from the old picture.'), () => ['350-dino-high-res-pictures.md']);
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /docs\/plan\/slices\/350-dino-high-res-pictures\.md/);
});

test('a brief pointing at the slice file passes', () => {
  assert.equal(decide(agent('Run Slice 350 part A. Read docs/plan/slices/350-dino-high-res-pictures.md and follow every line.'), noFiles), null);
  assert.equal(decide(agent('Slice 7: read D:\\repo\\docs\\plan\\slices\\07-thing.md'), noFiles), null);
  assert.equal(decide(agent('Slice 350 part B: docs/plan/slices/350a-guard.md'), noFiles), null);
});

test('counts, dates and other numbers after a single slice are not slices', () => {
  assert.deepEqual(sliceNumbers('Slice 350, 2026-11-12, 5 pages and 12 other files'), [350]);
  assert.equal(decide(agent('Slice 350, 5 pages. Read docs/plan/slices/350-x.md'), noFiles), null);
});

test('lists and ranges after "Slices" count every slice', () => {
  assert.deepEqual(sliceNumbers('Slices 351, 352 and 353'), [351, 352, 353]);
  assert.deepEqual(sliceNumbers('Slices 351-355'), [351, 352, 353, 354, 355]);
  assert.deepEqual(sliceNumbers('Slices 351\u2013352'), [351, 352]);
  const verdict = decide(agent('Slices 351-352, read docs/plan/slices/351-usage.md'), noFiles);
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /Slice 352/);
});

test('dates in a plural list are not slices; a trailing word keeps the list', () => {
  assert.deepEqual(sliceNumbers('Slices 350, 2026-11-12'), [350]);
  assert.deepEqual(sliceNumbers('Slices 351 and 352 merged'), [351, 352]);
  assert.deepEqual(sliceNumbers('Slice 350 part A'), [350]);
});

test('wide ranges and "Slice A to B" count every slice; lower-case prose does not', () => {
  assert.equal(sliceNumbers('Slices 300-340').length, 41);
  assert.deepEqual(sliceNumbers('Slice 350 to 352'), [350, 351, 352]);
  assert.deepEqual(sliceNumbers('take slice 2 of the array'), []);
});

test('plan-not-needed does not reach numbers on later lines', () => {
  assert.ok(denied(decide(agent('plan-not-needed: 349\n350 is next. Slice 350 now.'), noFiles)));
});

test('a slice file for a longer number does not count for a shorter one', () => {
  assert.ok(denied(decide(agent('Slice 35: read docs/plan/slices/350-x.md'), noFiles)));
});

test('plan-not-needed exempts only the slices it lists', () => {
  assert.equal(decide(agent('Status: Slice 349 merged as #1015. plan-not-needed: 349'), noFiles), null);
  assert.ok(denied(decide(agent('Slices 349 and 350. plan-not-needed: 349'), noFiles)));
  assert.ok(denied(decide(agent('Slice 350, plan-not-needed'), noFiles)));
});

test('mechanical agents and other tools are not checked', () => {
  assert.equal(decide(agent('Open the PR for Slice 350', 'ship-branch'), noFiles), null);
  assert.equal(decide(agent('Review the Slice 350 diff', 'code-review-pass'), noFiles), null);
  assert.equal(decide(agent('Review the Slice 350 diff', 'code-review-high'), noFiles), null);
  assert.equal(decide(agent('Review the Slice 350 diff', 'code-review-medium'), noFiles), null);
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'echo Slice 350' } }, noFiles), null);
});

test('the hint says the file was not found instead of naming a placeholder file', () => {
  assert.match(hint(12, []), /not found .* docs\/plan\/slices\/12-\*\.md/);
  assert.doesNotMatch(hint(12, []), /<slug>/);
});

test('list forms and a hash after "Slices" are read: "Slices 350, 351", "350 and 351", "350 & 351", "350; 351", "#350"', () => {
  for (const text of ['Slices 350, 351', 'Slices 350 and 351', 'Slices 350 & 351', 'Slices 350; 351', 'Slices #350, #351']) {
    assert.deepEqual(sliceNumbers(text), [350, 351], text);
  }
  assert.deepEqual(sliceNumbers('Slice #350'), [350]);
  assert.ok(denied(decide(agent('Slices 350; 351. Read docs/plan/slices/350-x.md'), noFiles)));
  assert.equal(decide(agent('Slices 350 & 351: docs/plan/slices/350-x.md docs/plan/slices/351-y.md'), noFiles), null);
});

test('a singular "Slice N" is one slice: a later number is a count or a PR, not a slice', () => {
  assert.deepEqual(sliceNumbers('Slice 354, 100 files'), [354]);
  assert.deepEqual(sliceNumbers('Slice 354; 377 lines'), [354]);
  assert.deepEqual(sliceNumbers('Slice 354 & 355 other PRs'), [354]);
  assert.deepEqual(sliceNumbers('Slice 350, #351'), [350]);
  assert.deepEqual(sliceNumbers('Slice 350 and 351'), [350]);
  assert.equal(decide(agent('Slice 354, 100 files. Read docs/plan/slices/354-x.md'), noFiles), null);
});

test('another repo\'s slice ("<repo> Slice N") passes, a bare "Slice N" is still denied', () => {
  assert.equal(decide(agent('Record agent-progress-board Slice 13 in the index.'), noFiles), null);
  assert.equal(decide(agent('Index pass for example-owner/agent-progress-board Slices 13 and 14.'), noFiles), null);
  assert.equal(decide(agent("agent-progress-board's Slice 13 is the board side."), noFiles), null);
  assert.ok(denied(decide(agent('Record Slice 13 in the index.'), noFiles)));
  assert.ok(denied(decide(agent('Record the Slice 13 in the index.'), noFiles)));
});

test('an ordinary compound word before "Slice N" is not a repo name', () => {
  for (const word of ['follow-up', 'end-to-end', 'non-mechanical', 'ReportProgress']) {
    assert.ok(denied(decide(agent(`Record the ${word} Slice 13 in the index.`), noFiles)), word);
  }
});

test('a slice of this repo is still checked when named with the repo name, and the foreign one beside it is not', () => {
  const own = { tool_name: 'Agent', cwd: 'D:/AgentPipeline-worktrees/s17', tool_input: { prompt: 'AgentPipeline Slice 17 and agent-progress-board Slice 13', subagent_type: 'general-purpose' } };
  const verdict = decide(own, () => ['17-fl-1216-tooling.md']);
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /Slice 17 /);
  assert.doesNotMatch(reason(verdict), /Slice 13 /);
});

test('a SendMessage is not checked (the hook is wired on Agent only)', () => {
  const send = { tool_name: 'SendMessage', cwd: 'D:/none', tool_input: { to: 'code-review-2', message: 'Slice 350 item 8 done' } };
  assert.equal(decide(send, noFiles), null);
});

test('Slice 18: "Slice N" inside a quoted sample title is not planned work, a bare one still is', () => {
  assert.equal(decide(agent('The title field takes text like "Slice 3D viewer" or `Slice 12 (draft)`.'), noFiles), null);
  assert.equal(decide(agent('Seed three items titled \u201cSlice 7 mock\u201d.'), noFiles), null);
  assert.ok(denied(decide(agent('The title "Slice 3D viewer" is a sample. Build Slice 13.'), noFiles)));
  assert.ok(denied(decide(agent('Read the "docs" Slice 13 and implement it'), noFiles)));
  assert.ok(denied(decide(agent('Build `Slice 13` now'), noFiles)));
  assert.ok(denied(decide(agent('Record Slice 13 in the index.'), noFiles)));
});

test('Slice 21: a ledger sibling or parked slice is context once the brief names its own slice file', () => {
  const ctx = () => new Set([351, 19]);
  const brief = 'Run Slice 350. Read docs/plan/slices/350-thing.md. Slice 351 runs in parallel; Slice 19 is parked.';
  assert.equal(decide(agent(brief), noFiles, ctx), null);
});

test('Slice 21: an unknown slice is still denied, and so is a brief with no slice file of its own', () => {
  const ctx = () => new Set([351]);
  assert.ok(denied(decide(agent('Run Slice 350. Read docs/plan/slices/350-thing.md. Also Slice 777.'), noFiles, ctx)));
  assert.ok(denied(decide(agent('Run Slice 777 part A.'), noFiles, ctx)));
});

test('Slice 21: a ledger slice named with no slice file of its own is denied (it may be the one being built)', () => {
  const ctx = () => new Set([351, 350]);
  assert.ok(denied(decide(agent('Run Slice 351 part A.'), noFiles, ctx, () => new Set())));
  assert.ok(denied(decide(agent('Build Slice 351 (see docs/plan/slices/350-x.md).'), noFiles, ctx, () => new Set())));
});

test('Slice 35 (406 item 24): a parked slice named as context passes with no slice file; an unlisted one beside it is denied', () => {
  const none = () => new Set();
  const parked = () => new Set([19]);
  assert.equal(decide(agent('Slice 19 is parked; leave it alone.'), noFiles, none, parked), null);
  assert.ok(denied(decide(agent('Slice 19 is parked; build Slice 777.'), noFiles, none, parked)));
  assert.ok(denied(decide(agent('Run Slice 351 part A; Slice 19 is parked.'), noFiles, () => new Set([351]), parked)));
});

test('Slice 21: a context slice does not exempt an unlisted slice named next to it', () => {
  const own = () => new Set([351]);
  assert.ok(denied(decide(agent('Build Slice 351 and Slice 352. Read docs/plan/slices/350-x.md.'), noFiles, own)));
  assert.equal(decide(agent('Build Slice 352 (docs/plan/slices/352-y.md) next to Slice 351.'), noFiles, own), null);
});

test('Slice 21: a briefed slice that is itself in the open ledger still exempts its siblings', () => {
  const ctx = () => new Set([350, 351]);
  assert.equal(decide(agent('Run Slice 350. Read docs/plan/slices/350-thing.md. Slice 351 runs in parallel.'), noFiles, ctx), null);
});

test('Slice 21: the context is read only when a named slice lacks its file', () => {
  let reads = 0;
  const ctx = () => { reads++; return new Set(); };
  assert.equal(decide(agent('Build Slice 350. Read docs/plan/slices/350-thing.md.'), noFiles, ctx), null);
  assert.equal(decide(agent('Fix the typo in the README.'), noFiles, ctx), null);
  assert.equal(reads, 0);
});
