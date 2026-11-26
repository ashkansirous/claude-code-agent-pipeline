import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNote, joinPrefixLines, candidatePaths, parseArgs, refsOf } from './note-claims.mjs';

const OTHERS = { AgentPipeline: 'D:\\AgentPipeline' };

// Stubbed gh and git: states by `<dir>|<number>`; tracked files by `<dir>` (every ref lists the same files).
function stub({ prs = {}, issues = {}, files = {} }) {
  return (command, args, cwd) => {
    if (command === 'git') return { status: 0, stdout: (files[cwd] ?? []).join('\n') };
    const [kind, , number] = args;
    const table = kind === 'pr' ? prs : issues;
    const state = table[`${cwd}|${number}`];
    return state ? { status: 0, stdout: `${state}\n` } : { status: 1, stdout: '' };
  };
}

const problems = (rows) => rows.filter((r) => r.problem).map((r) => `${r.what}: ${r.problem}`);
const prs = (table) => stub({ prs: table });

test('"merged" next to an open PR is a problem; next to a merged one it is fine', () => {
  const runner = prs({ 'repo|5': 'OPEN', 'repo|6': 'MERGED' });
  assert.deepEqual(problems(checkNote('PR #5 merged cleanly.', 'repo', {}, runner)), ['own #5: says merged, PR is open']);
  assert.deepEqual(problems(checkNote('PR #6 merged cleanly.', 'repo', {}, runner)), []);
});

test('"open" next to a merged PR is a problem', () => {
  const runner = prs({ 'repo|7': 'MERGED' });
  assert.deepEqual(problems(checkNote('PR #7 is still open.', 'repo', {}, runner)), ['own #7: says open, PR is merged']);
});

test('a negation within three words flips merged/open', () => {
  const runner = prs({ 'repo|1': 'OPEN', 'repo|2': 'MERGED' });
  assert.deepEqual(problems(checkNote('#1 is not merged yet.', 'repo', {}, runner)), []);
  assert.deepEqual(problems(checkNote('#1 was never merged.', 'repo', {}, runner)), []);
  assert.deepEqual(problems(checkNote('#1 stays un-merged.', 'repo', {}, runner)), []);
  assert.deepEqual(problems(checkNote('#2 is not merged.', 'repo', {}, runner)), ['own #2: says not merged, PR is merged']);
  assert.deepEqual(problems(checkNote('#2 is no longer open.', 'repo', {}, runner)), []);
});

test('the nearest ref wins and a word in another sentence does not count', () => {
  const runner = prs({ 'repo|649': 'MERGED', 'repo|650': 'OPEN', 'repo|12': 'MERGED' });
  assert.deepEqual(problems(checkNote('Merged #649 and still-open #650.', 'repo', {}, runner)), []);
  assert.deepEqual(problems(checkNote('An open question about #12.', 'repo', {}, runner)), []);
  assert.deepEqual(problems(checkNote('Everything is open. See #12.', 'repo', {}, runner)), []);
});

test('a "AgentPipeline #N" ref is looked up in the other repo; a bare one in the own repo', () => {
  const runner = prs({ 'repo|3': 'OPEN', 'D:\\AgentPipeline|3': 'MERGED' });
  const rows = checkNote('AgentPipeline #3 merged. #3 is open.', 'repo', OTHERS, runner);
  assert.deepEqual(rows.map((r) => [r.what, r.state]), [['AgentPipeline #3', 'merged'], ['own #3', 'open']]);
  assert.deepEqual(problems(rows), []);
});

test('Slice 29 item 38: a repo name ending the line before a #N prefixes it', () => {
  const runner = stub({ prs: { 'D:\\AgentPipeline|361': 'OPEN', 'repo|361': 'MERGED' } });
  assert.deepEqual(problems(checkNote('Merge AgentPipeline\n#361 is merged.', 'repo', OTHERS, runner)), ['AgentPipeline #361: says merged, PR is open']);
  assert.deepEqual(problems(checkNote('Merge AgentPipeline PR\n  #361 is merged.', 'repo', OTHERS, runner)), ['AgentPipeline #361: says merged, PR is open']);
  assert.deepEqual(problems(checkNote('Merge AgentPipeline\n#361 is merged.', 'repo', {}, runner)), []);
  // a name that does not end its line, or a number that does not start the next, joins nothing
  assert.deepEqual(problems(checkNote('Merge AgentPipeline now\n#361 is merged.', 'repo', OTHERS, runner)), []);
  // a sentence that ends with the name does not prefix the next line's number, and a colon is kept
  assert.deepEqual(problems(checkNote('Follow-up filed in AgentPipeline.\n#361 is merged.', 'repo', OTHERS, runner)), []);
  assert.equal(joinPrefixLines('Merge AgentPipeline:\n#361 is merged.', OTHERS), 'Merge AgentPipeline: #361 is merged.');
});

test('a repo prefix carries over to the following numbers of a list', () => {
  const runner = prs({ 'D:\\AgentPipeline|109': 'MERGED', 'D:\\AgentPipeline|110': 'MERGED', 'D:\\AgentPipeline|111': 'MERGED', 'repo|111': 'OPEN' });
  const rows = checkNote('AgentPipeline #109, #110 and #111 merged. Own #111 is open.', 'repo', OTHERS, runner);
  assert.deepEqual(rows.map((r) => r.what), ['AgentPipeline #109', 'AgentPipeline #110', 'AgentPipeline #111', 'own #111']);
});

test('each ref uses its own words, not the whole sentence', () => {
  const runner = prs({ 'repo|1': 'MERGED', 'repo|2': 'OPEN' });
  assert.deepEqual(problems(checkNote('Merged #1, open #2.', 'repo', {}, runner)), []);
});

test('an issue is listed with its state and never trips the merged check; an unknown number is reported', () => {
  const runner = stub({ issues: { 'repo|9': 'CLOSED' } });
  const rows = checkNote('Issue #9 merged into the plan. Also #99.', 'repo', {}, runner);
  assert.deepEqual(rows.map((r) => [r.what, r.kind, r.state]), [['own #9', 'issue', 'closed'], ['own #99', '?', 'not found']]);
  assert.deepEqual(problems(rows), ['own #99: not found by gh']);
});

test('only backticked tokens with a slash and a file extension or trailing slash are paths', () => {
  const text = 'See `skills/a/SKILL.md`, `docs\\b.md`, `docs/a.md:12`, `skills/run/`; not `upload.py`, `status.json`, `System.IO`, '
    + '`chore/feedback-loop-x`, `node x.mjs`, `D:\\x\\y.md`, `--flag`, `src/*.cs`.';
  assert.deepEqual(candidatePaths(text), ['skills/a/SKILL.md', 'docs/b.md', 'docs/a.md', 'skills/run/']);
});

test('a path is found in the own repo, an --other repo, or by suffix; a missing one is a problem', () => {
  const runner = stub({ files: { repo: ['src/a.cs', 'skills/branch-sweep/SKILL.md'], 'D:\\AgentPipeline': ['skills/run-wave/merge-gate.mjs'] } });
  const text = 'Files `src/a.cs`, `skills/run-wave/merge-gate.mjs`, `branch-sweep/SKILL.md`, `skills/gone.mjs`.';
  assert.deepEqual(problems(checkNote(text, 'repo', OTHERS, runner)), ['skills/gone.mjs: not in any repo or the current branch']);
});

test('a folder token counts only when its top folder exists somewhere; a Drive folder is ignored', () => {
  const runner = stub({ files: { repo: ['docs/plan/a.md'] } });
  assert.deepEqual(problems(checkNote('`docs/plan/` and `_context/rules/` and `docs/missing/`', 'repo', {}, runner)), ['docs/missing/: not in any repo or the current branch']);
});

test('arguments: two positionals and optional --other pairs', () => {
  assert.deepEqual(parseArgs(['n.md', 'r', '--other', 'AgentPipeline=D:\\AgentPipeline']), { note: 'n.md', repo: 'r', others: { AgentPipeline: 'D:\\AgentPipeline' } });
  assert.equal(parseArgs(['n.md']), null);
  assert.equal(parseArgs(['n.md', 'r', '--other', 'bad']), null);
});

test('a preceding word that is not a configured repo name is just text', () => {
  assert.equal(refsOf('PR #4', OTHERS)[0].repoName, null);
});

test('"<Name> PR #N" carries the repo name', () => {
  assert.equal(refsOf('AgentPipeline PR #144 merged', OTHERS)[0].repoName, 'AgentPipeline');
  assert.equal(refsOf('AgentPipeline pull request #3', OTHERS)[0].repoName, 'AgentPipeline');
  assert.equal(refsOf('AgentPipeline pr #5', OTHERS)[0].repoName, 'AgentPipeline');
  assert.equal(refsOf('AgentPipeline PRs #6 and #7', OTHERS)[1].repoName, 'AgentPipeline');
});

test('a bare #N the note also writes with an --other prefix is ambiguous, even when it is an own PR', () => {
  const runner = prs({ 'repo|144': 'MERGED', 'D:\\AgentPipeline|144': 'MERGED' });
  const rows = checkNote('Fixed in AgentPipeline PR #144.\n#144 first gave the wrong cause.', 'repo', OTHERS, runner);
  assert.equal(rows[0].warning, null);
  assert.equal(rows[1].warning, 'ambiguous: own pr / AgentPipeline PR');
});

test('a bare #N that is an own issue but a PR in an --other repo is ambiguous', () => {
  const runner = stub({ issues: { 'repo|8': 'OPEN' }, prs: { 'D:\\AgentPipeline|8': 'MERGED', 'repo|9': 'OPEN', 'D:\\AgentPipeline|9': 'MERGED' } });
  const rows = checkNote('See #8.', 'repo', OTHERS, runner);
  assert.deepEqual(problems(rows), []);
  assert.equal(rows[0].warning, 'ambiguous: own issue / AgentPipeline PR');
  assert.deepEqual(problems(checkNote('See #9.', 'repo', OTHERS, runner)), []);
  assert.deepEqual(problems(checkNote('See AgentPipeline #8.', 'repo', OTHERS, runner)), []);
  assert.deepEqual(problems(checkNote('See #8.', 'repo', {}, runner)), []);
});

test('Slice 307: "merged" inside the parenthesis after a ref belongs to that ref, not the next one in the list', () => {
  const runner = prs({ 'repo|113': 'MERGED', 'repo|114': 'OPEN' });
  assert.deepEqual(problems(checkNote('Done: #113 (the guard, merged), #114 (the test).', 'repo', {}, runner)), []);
  assert.deepEqual(problems(checkNote('Done: #113 (the guard, merged), #114 (the test, merged).', 'repo', {}, runner)), ['own #114: says merged, PR is open']);
  assert.deepEqual(problems(checkNote('Still open: #114 (the test, open), #113 (the guard, merged).', 'repo', {}, runner)), []);
  assert.deepEqual(refsOf('#113 (fix, merged), #114 (x)', {}).map((r) => r.claims.length), [1, 0]);
  assert.deepEqual(refsOf('#113 (superseded by #114, merged)', {}).map((r) => r.claims.length), [0, 1]);
  assert.deepEqual(refsOf('#120 (follow-up to #113, merged)', {}).map((r) => r.claims.length), [0, 1]);
});

test('Slice 307: a backticked %VAR% example is not a path', () => {
  assert.deepEqual(candidatePaths('Set `%USERPROFILE%/.claude/x.json` and read `skills/a/b.mjs`.'), ['skills/a/b.mjs']);
  assert.deepEqual(candidatePaths('`%TEMP%\\run\\log.txt`'), []);
});
