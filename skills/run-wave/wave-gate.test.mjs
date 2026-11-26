// node --test skills/run-wave/wave-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = fileURLToPath(new URL('./wave-gate.mjs', import.meta.url));

function makeRepo(ledger) {
  const root = mkdtempSync(join(tmpdir(), 'wave-gate-'));
  const repo = join(root, 'demo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  if (ledger !== undefined) {
    mkdirSync(join(root, 'demo-worktrees'));
    writeFileSync(join(root, 'demo-worktrees', 'wave-ledger.md'), ledger);
  }
  return { root, repo };
}

function runWithTranscript(repo, toolInput, transcript) {
  const file = join(repo, '..', 'transcript.jsonl');
  writeFileSync(file, transcript);
  const input = JSON.stringify({ tool_name: 'Agent', cwd: repo, transcript_path: file, tool_input: toolInput });
  const out = spawnSync(process.execPath, [GATE], { input, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return decisionOf(out.stdout);
}

const plainSession = '{"type":"user","message":{"content":"implement slice 9. See ~/.claude/skills/run-wave/board.mjs and /run-all-waves wave N."}}\n'
  + '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"new_string":"\\"skill\\":\\"run-wave\\" <command-name>/run-wave</command-name>"}}]}}\n'
  + '{"type":"user","message":{"content":[{"type":"tool_result","content":"Base directory for this skill: C:\\\\skills\\\\run-wave"}]}}\n';
const waveSessions = [
  ['Skill tool call', '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"run-wave"}}]}}\n'],
  ['slash command', '{"type":"user","message":{"content":"<command-name>/run-all-waves</command-name>"}}\n'],
  ['skill base directory', '{"type":"user","message":{"content":"Base directory for this skill: C:\\\\Users\\\\a\\\\.claude\\\\skills\\\\run-wave\\n"}}\n'],
];

for (const [ledger, label] of [['## Wave 3 (open)\n- Slice 1 x\n', 'open'], ['## Wave 3 (closed)\n- Slice 1 x\n', 'closed'], ['## Wave 3 (open)\n- Slice 1 a\n- Slice 2 b\n- Slice 3 c\n- Slice 4 d\n- Slice 5 e\n', 'over-full']]) {
  test(`2026-11-25: a session that never loaded run-wave claims a slice outside another session's ${label} wave`, () => {
    const { root, repo } = makeRepo(ledger);
    try { assert.equal(runWithTranscript(repo, { subagent_type: 'ship-branch', prompt: 'Claim mode. Slice 9' }, plainSession), 'none'); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const [label, transcript] of waveSessions) {
  test(`2026-11-25: a wave session found by its ${label} is still refused an unlisted slice`, () => {
    const { root, repo } = makeRepo('## Wave 3 (open)\n- Slice 1 x\n');
    try { assert.equal(runWithTranscript(repo, { subagent_type: 'ship-branch', prompt: 'Claim mode. Slice 9' }, transcript), 'deny'); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const [id, expected] of [['sess-abc', 'deny'], ['sess-other', 'none']]) {
  test(`2026-11-25: session id ${id} against the Opened line's session id gives ${expected} on a transcript with no markers`, () => {
    const { root, repo } = makeRepo('## Wave 3 (open)\nOpened 10:00Z 2000-01-01 session sess-abc\n- Slice 1 x\n');
    try {
      const file = join(root, 'transcript.jsonl');
      writeFileSync(file, plainSession);
      const input = JSON.stringify({ tool_name: 'Agent', cwd: repo, session_id: id, transcript_path: file, tool_input: { subagent_type: 'ship-branch', prompt: 'Claim mode. Slice 9' } });
      const out = spawnSync(process.execPath, [GATE], { input, encoding: 'utf8' });
      assert.equal(decisionOf(out.stdout), expected);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const [label, parent, expected] of [['a wave', waveSessions[0][1], 'deny'], ['a plain', plainSession, 'none']]) {
  test(`2026-11-25 review: a subagent's own transcript is read with its parent session's, so a subagent of ${label} session gives ${expected}`, () => {
    const { root, repo } = makeRepo('## Wave 3 (open)\n- Slice 1 x\n');
    try {
      mkdirSync(join(root, 'sess-1', 'subagents'), { recursive: true });
      writeFileSync(join(root, 'sess-1.jsonl'), parent);
      const file = join(root, 'sess-1', 'subagents', 'agent-a1.jsonl');
      writeFileSync(file, plainSession);
      const input = JSON.stringify({ tool_name: 'Agent', cwd: repo, agent_id: 'a1', transcript_path: file, tool_input: { subagent_type: 'ship-branch', prompt: 'Claim mode. Slice 9' } });
      const out = spawnSync(process.execPath, [GATE], { input, encoding: 'utf8' });
      assert.equal(decisionOf(out.stdout), expected);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('2026-11-25: an unreadable transcript keeps the full gate', () => {
  const { root, repo } = makeRepo('## Wave 3 (open)\n- Slice 1 x\n');
  try {
    const input = JSON.stringify({ tool_name: 'Agent', cwd: repo, transcript_path: join(root, 'missing.jsonl'), tool_input: { subagent_type: 'ship-branch', prompt: 'Claim mode. Slice 9' } });
    const out = spawnSync(process.execPath, [GATE], { input, encoding: 'utf8' });
    assert.equal(decisionOf(out.stdout), 'deny');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function decisionOf(stdout) {
  if (!stdout) return 'none';
  const json = JSON.parse(stdout);
  return json.systemMessage ? 'warn' : json.hookSpecificOutput.permissionDecision;
}

function run(repo, toolInput, toolName = 'Agent') {
  const input = JSON.stringify({ tool_name: toolName, cwd: repo, tool_input: toolInput });
  const out = spawnSync(process.execPath, [GATE], { input, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return decisionOf(out.stdout);
}

test('Slice 21 review: when realpath fails the entry-point check falls back instead of switching the hook off', async () => {
  const { isEntryPoint } = await import('./wave-gate.mjs');
  const url = new URL('./wave-gate.mjs', import.meta.url).href;
  assert.equal(isEntryPoint(GATE, url), true);
  assert.equal(isEntryPoint(join(tmpdir(), 'no-such-dir', 'wave-gate.mjs'), url), true);
  assert.equal(isEntryPoint(join(tmpdir(), 'no-such-dir', 'wave-gate.test.mjs'), url), false);
  assert.equal(isEntryPoint(undefined, url), false);
});

const claim = n =>({ subagent_type: 'ship-branch', prompt: `Claim mode. Slice ${n}: do it.` });
const wave = (state, ...n) => `# Ledger\n\n## Wave 1 (closed)\n- Slice 1 old\n\n## Wave 2 (${state})\n${n.map(s => `- Slice ${s} x`).join('\n')}\n`;

const cases = [
  ['no ledger allows', undefined, claim(7), 'none'],
  ['ledger with no wave heading allows', '# notes\n', claim(7), 'none'],
  ['listed slice in open wave allows', wave('open', 7, 8), claim(7), 'none'],
  ['unlisted slice denies', wave('open', 7, 8), claim(9), 'deny'],
  ['closed wave denies', wave('closed', 7), claim(7), 'deny'],
  ['five slices deny', wave('open', 1, 2, 3, 4, 5), claim(1), 'deny'],
  ['CRLF ledger is read', wave('open', 7).replace(/\n/g, '\r\n'), claim(7), 'none'],
  ['other agents pass', wave('closed', 7), { subagent_type: 'run-checks', prompt: 'Slice 7 claim' }, 'none'],
  ['claim-like brief without the marker passes', wave('closed', 7), { subagent_type: 'ship-branch', prompt: 'Open a draft claim PR for Slice 9.' }, 'none'],
  ['marker is case-insensitive with leading whitespace', wave('closed', 7), { subagent_type: 'ship-branch', prompt: '\n  claim mode. Slice 9' }, 'deny'],
  ['bold ledger lines count', '## Wave 3 (open)\n- **Slice 9** x\n', claim(9), 'none'],
  ['closes in heading text is not closed', '## Wave 3 (open), closes Friday\n- Slice 9 x\n', claim(9), 'none'],
  ['ship-branch commit passes', wave('closed', 7), { subagent_type: 'ship-branch', prompt: 'Commit mode, Slice 7, claim body kept.' }, 'none'],
  ['ship-branch merge passes', wave('closed', 7), { subagent_type: 'ship-branch', prompt: 'Merge mode, Slice 7. Keep the Touches line from the claim body.' }, 'none'],
];

cases.push(
  ['table-row ledger lines count', '## Wave 3 (open)\n| Slice 9 | x |\n', claim(9), 'none'],
  ['claim with no slice number in a closed wave denies', wave('closed', 7), { subagent_type: 'ship-branch', prompt: 'Claim mode. Open the draft PR.' }, 'deny'],
  ['claim with no slice number in an open wave allows', wave('open', 7), { subagent_type: 'ship-branch', prompt: 'Claim mode. Open the draft PR.' }, 'none'],
  ['ship mode with draft PR wording passes', wave('closed', 7), { subagent_type: 'ship-branch', prompt: 'Ship mode, Slice 12. Open a normal PR, not a draft PR.' }, 'none'],
  ['ship mode with no claim needed passes', wave('closed', 7), { subagent_type: 'ship-branch', prompt: 'Ship mode Slice 12; no claim needed, single-slice work.' }, 'none'],
  ['hyphenated commit-mode passes', wave('closed', 7), { subagent_type: 'ship-branch', prompt: 'commit-mode for Slice 7. Update the draft PR body and mark ready.' }, 'none'],
  ['Mode: merge passes', wave('closed', 7), { subagent_type: 'ship-branch', prompt: 'Mode: merge. Merge PR #5 for Slice 7 (claimed earlier).' }, 'none'],
  ['claim brief naming two slices checks both', wave('open', 7), { subagent_type: 'ship-branch', prompt: 'Claim mode. Slice 7 and Slice 9' }, 'deny'],
  ['claim brief naming two listed slices allows', wave('open', 7, 9), { subagent_type: 'ship-branch', prompt: 'Claim mode. Slices 7, 9' }, 'none'],
  ['status word without parentheses is read', '## Wave 1 closed\n- Slice 7 x\n', claim(7), 'deny'],
  ['heading with a date suffix is read', '## Wave 1 - 2026-10-30 (closed)\n', claim(7), 'deny'],
  ['highest wave number wins over file order', '## Wave 5 (open)\n- Slice 9 x\n\n## Wave 2 (closed)\n- Slice 1 x\n', claim(9), 'none'],
  ['wave prepended above an older one is read', '## Wave 3 (closed)\n- Slice 1 x\n\n## Wave 2 (open)\n- Slice 9 x\n', claim(9), 'deny'],
  ['heading with no token counts as open: unlisted slice denies', '## Wave 3\n- Slice 1 x\n', claim(9), 'deny'],
  ['heading with no token counts as open: listed slice warns', '## Wave 3\n- Slice 1 x\n', claim(1), 'warn'],
  ['heading with a colon and no token counts as open', '## Wave 3: foo\n- Slice 1 x\n', claim(9), 'deny'],
  ['token after other words is read', '## Wave 3 notes (closed)\n- Slice 1 x\n', claim(9), 'deny'],
  ['slice named on a later line is checked', wave('open', 7), { subagent_type: 'ship-branch', prompt: 'Claim mode.\nOpen the draft PR for Slice 9.' }, 'deny'],
  ['slice named on a later line, listed, allows', wave('open', 7), { subagent_type: 'ship-branch', prompt: 'Claim mode.\nOpen the draft PR for Slice 7.' }, 'none'],
  ['first line wins over a later slice mention', wave('open', 7), { subagent_type: 'ship-branch', prompt: 'Claim mode. Slice 7\nTouches overlap with Slice 9.' }, 'none'],
  ['### and # wave headings do not count', '### Wave 4 (closed)\n# Wave 5 (closed)\n## Wave 2 (open)\n- Slice 9 x\n', claim(9), 'none'],
  ['### heading inside a wave does not end it', '## Wave 2 (open)\n### Notes\n- Slice 9 x\n', claim(9), 'none'],
  ['zero-padded ledger matches an unpadded brief', '## Wave 2 (open)\n- Slice 020 x\n', claim(20), 'none'],
  ['unpadded ledger matches a zero-padded brief', '## Wave 2 (open)\n- Slice 20 x\n', claim('020'), 'none'],
  ['zero-padded ledger still denies another slice', '## Wave 2 (open)\n- Slice 020 x\n', claim(21), 'deny'],
);

const building = '## Wave 2 (open)\n- Slice 7 x - draft PR #5 (claimed 00:00Z) - stage: building\n- Slice 8 y - stage: review 2\n';
const ship = (mode, n) => ({ subagent_type: 'ship-branch', prompt: `${mode}. Slice ${n}.` });
cases.push(
  ['commit mode for a slice still on stage: building denies', building, ship('Commit mode', 7), 'deny'],
  ['merge mode for a slice still on stage: building denies', building, ship('Merge mode', 7), 'deny'],
  ['merge mode for a slice on review 2 passes', building, ship('Merge mode', 8), 'none'],
  ['merge mode for a slice with no stage text passes', wave('open', 7), ship('Merge mode', 7), 'none'],
  ['claim mode is not a commit call even with stage: building', building, claim(7), 'none'],
  ['history text "(was stage: building)" after the current stage does not deny', '## Wave 2 (open)\n- Slice 7 x - stage: review 1 (was stage: building)\n', ship('Merge mode', 7), 'none'],
  ['a merge brief for Slice 8 that also names the building Slice 7 passes', building, { subagent_type: 'ship-branch', prompt: 'Merge mode. Slice 8.\nSlice 7 is still building.' }, 'none'],
  ['numbers after plan-not-needed: are ignored, so the one named slice denies', building, { subagent_type: 'ship-branch', prompt: 'Merge mode. Slice 7. plan-not-needed: Slice 900' }, 'deny'],
  ['a brief naming no slice passes', building, { subagent_type: 'ship-branch', prompt: 'Merge mode.' }, 'none'],
  ['an older building line is overridden by the newest line of the slice', '## Wave 2 (open)\n- Slice 7 x - stage: building\n- Slice 7 x - stage: review 2\n', ship('Merge mode', 7), 'none'],
);

for (const [name, ledger, toolInput, expected] of cases) {
  test(name, () => {
    const { root, repo } = makeRepo(ledger);
    try { assert.equal(run(repo, toolInput), expected); } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('non-Agent tools pass', () => {
  const { root, repo } = makeRepo(wave('closed', 7));
  try { assert.equal(run(repo, claim(7), 'Bash'), 'none'); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a ledger untouched for 24 h no longer blocks', () => {
  const { root, repo } = makeRepo(wave('closed', 7));
  try {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(join(root, 'demo-worktrees', 'wave-ledger.md'), old, old);
    assert.equal(run(repo, claim(7)), 'none');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a linked-worktree cwd finds the main repo ledger', () => {
  const { root, repo } = makeRepo(wave('closed', 7));
  try {
    const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
    git('commit', '--allow-empty', '-m', 'init');
    const linked = join(root, 'demo-worktrees', 'linked');
    git('worktree', 'add', '-b', 'x', linked);
    assert.equal(run(linked, claim(7)), 'deny');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fail-open: a claim outside any git repo passes with a visible warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wave-gate-nogit-'));
  try { assert.equal(run(dir, claim(7)), 'warn'); } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Cloud slices count as live work (Slice 06): a "cloud running" ledger line blocks a re-claim of
// that slice and a claim of a slice whose Touches overlap it.
function addSlices(repo, files) {
  const dir = join(repo, 'docs', 'plan', 'slices');
  mkdirSync(dir, { recursive: true });
  for (const [name, touches] of Object.entries(files)) writeFileSync(join(dir, name), `### Slice\n\n**Touches:** ${touches}\n`);
}

const cloudCases = [
  ['claiming a slice that is running in the cloud denies', '## Wave 2 (open)\n- Slice 7 x stage: cloud running cse_1\n- Slice 8 y\n', claim(7), {}, 'deny'],
  ['a cloud slice that is pushed does not block', '## Wave 2 (open)\n- Slice 7 x cloud: pushed\n- Slice 8 y\n', claim(7), {}, 'none'],
  ['a local slice with "running" alone does not block', '## Wave 2 (open)\n- Slice 7 x running locally\n- Slice 8 y\n', claim(7), {}, 'none'],
  ['overlapping Touches with a running cloud slice denies', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`skills/run-wave/x.mjs`', '08-b.md': '`skills/run-wave/x.mjs`, `skills/run-wave/y.mjs`' }, 'deny'],
  ['a directory prefix overlaps its files', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`src/api`', '08-b.md': '`src/api/a.ts`' }, 'deny'],
  ['disjoint Touches with a running cloud slice allows', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`src/a.ts`', '08-b.md': '`src/b.ts`, `docs/x.md`' }, 'none'],
  ['a trailing-slash directory overlaps its files', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`src/api/`', '08-b.md': '`src/api/a.ts`' }, 'deny'],
  ['a ./ prefix still overlaps', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`./src/a.ts`', '08-b.md': '`src/a.ts`' }, 'deny'],
  ['the same glob in both slices is not an overlap', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`skills/*/a.mjs`', '08-b.md': '`skills/*/a.mjs`' }, 'none'],
  ['a ** glob later segments are not checked', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`src/**/a.ts`', '08-b.md': '`src/b/c.ts`' }, 'none'],
  ['a leading ** glob does not overlap', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`**/*.test.mjs`', '08-b.md': '`docs/x.txt`' }, 'none'],
  ['a glob against a literal path does not overlap', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`src/*.ts`', '08-b.md': '`src/a.ts`' }, 'none'],
  ['? and [ glob characters never overlap', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`src/a?.ts`, `src/[ab].ts`', '08-b.md': '`src/a1.ts`, `src/a.ts`' }, 'none'],
  ['two globs with the same ends do not overlap', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`src/a*b*c.ts`', '08-b.md': '`src/a*z*c.ts`, `src/foo-*`' }, 'none'],
  ['a dot or empty token never overlaps', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`.`, `./`, `/`', '08-b.md': '`.`, `./`, `src/a.ts`' }, 'none'],
  ['the same Markdown file is not an overlap', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`skills/run-wave/SKILL.md`, `docs/plan/slices/x.md`', '08-b.md': '`skills/run-wave/SKILL.md`, `docs/plan/slices/x.md`' }, 'none'],
  ['an absolute path is not an overlap', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`/etc/hosts`, `C:/Users/a/x.ts`', '08-b.md': '`/etc/hosts`, `C:/Users/a/x.ts`' }, 'none'],
  ['a path outside the repo is not an overlap', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`../other/x.ts`, `~/x.ts`', '08-b.md': '`../other/x.ts`, `~/x.ts`' }, 'none'],
  ['backslash paths normalise and overlap', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`src\\api`', '08-b.md': '`src/api/a.ts`' }, 'deny'],
  ['a cloud line that failed after running does not block', '## Wave 2 (open)\n- Slice 7 x stage: failed (was cloud running)\n- Slice 8 y\n', claim(7), {}, 'none'],
  ['"cloud running" without the stage text does not block', '## Wave 2 (open)\n- Slice 7 x cloud running\n- Slice 8 y\n', claim(7), {}, 'none'],
  ['a ledger line with cloud and running apart does not block', '## Wave 2 (open)\n- Slice 7 cloud handoff, builder running locally\n- Slice 8 y\n', claim(7), {}, 'none'],
  ['a failed cloud line mentioning running does not block', '## Wave 2 (open)\n- Slice 7 x cloud: failed, tests still running\n- Slice 8 y\n', claim(7), {}, 'none'],
  ['an empty Touches line does not read the next line', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8),
    { '07-a.md': '\n`src/a.ts`', '08-b.md': '`src/a.ts`' }, 'none'],
  ['a missing slice file claims no overlap', '## Wave 2 (open)\n- Slice 7 x stage: cloud running\n- Slice 8 y\n', claim(8), { '07-a.md': '`src/a.ts`' }, 'none'],
  ['a pushed cloud slice no longer blocks an overlap', '## Wave 2 (open)\n- Slice 7 x cloud: pushed\n- Slice 8 y\n', claim(8),
    { '07-a.md': '`src/a.ts`', '08-b.md': '`src/a.ts`' }, 'none'],
];

for (const [name, ledger, toolInput, slices, expected] of cloudCases) {
  test(name, () => {
    const { root, repo } = makeRepo(ledger);
    try {
      addSlices(repo, slices);
      assert.equal(run(repo, toolInput), expected);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('fail-open: unreadable input passes with a visible warning', () => {
  const out = spawnSync(process.execPath, [GATE], { input: 'not json', encoding: 'utf8' });
  assert.equal(out.status, 0);
  assert.equal(decisionOf(out.stdout), 'warn');
});

test('Slice 23 item 4: a ledger time later than the clock is refused at a claim; one from before midnight is not', async () => {
  const { futureLedgerTimes } = await import('./wave-gate.mjs');
  const now = new Date('2026-11-18T10:00:00Z');
  const opened = 'Opened 08:00Z 2026-11-18';
  assert.deepEqual(futureLedgerTimes([opened, '- Slice 1 x ... claimed 10:30Z'], now), ['10:30Z']);
  assert.deepEqual(futureLedgerTimes([opened, '- Slice 1 x ... 09:59Z, 10:03Z'], now), []);
  assert.deepEqual(futureLedgerTimes([opened, '- Slice 1 x ... claimed 16:01Z'], now), ['16:01Z']);
  assert.deepEqual(futureLedgerTimes([opened, '- Slice 1 x ... ETA 10:40Z, next check 10:30Z, cap resets by 11:00Z'], now), []);
  // wave opened yesterday, stamp 05:30Z, now 01:00Z: never checked
  assert.deepEqual(futureLedgerTimes(['Opened 23:50Z 2026-11-17', '- Slice 1 x ... claimed 05:30Z'], new Date('2026-11-18T01:00:00Z')), []);
  // wave opened today 16:03Z, stamp 18:00Z, now 16:30Z: refused
  assert.deepEqual(futureLedgerTimes(['Opened 16:03Z 2026-11-18', '- Slice 1 x ... claimed 18:00Z'], new Date('2026-11-18T16:30:00Z')), ['18:00Z']);
  // no Opened line, or an Opened time after now: never checked
  assert.deepEqual(futureLedgerTimes(['- Slice 1 x ... claimed 18:00Z'], new Date('2026-11-18T16:30:00Z')), []);
  assert.deepEqual(futureLedgerTimes(['Opened 17:00Z 2026-11-18', '- Slice 1 x ... claimed 18:00Z'], new Date('2026-11-18T16:30:00Z')), []);
  const clock = new Date();
  const future = new Date(clock.getTime() + 30 * 60 * 1000);
  if (future.getUTCDate() === clock.getUTCDate()) {
    const time = `${String(future.getUTCHours()).padStart(2, '0')}:${String(future.getUTCMinutes()).padStart(2, '0')}Z`;
    const { repo } = makeRepo(`## Wave 1 (open)\nOpened 00:00Z ${clock.toISOString().slice(0, 10)}\n- Slice 7 demo ... stage: building, claimed ${time}\n`);
    assert.equal(run(repo, claim(7)), 'deny');
  }
});

test('Slice 32 item D: a commit or merge call is denied only when the slice stamp of this wave names a step before review 1', async () => {
  const { unreportedSlices, stepReportPath } = await import('./wave-gate.mjs');
  const shipFor = (tree) => ({ subagent_type: 'ship-branch', prompt: `Commit mode, Slice 7. Worktree ${tree} is the slice's checkout.` });
  const outside = { subagent_type: 'ship-branch', prompt: 'Commit mode, Slice 24 docs fix.' };
  const ledger = '## Wave 1 (open)\nOpened 08:00Z 2026-11-18\n- Slice 7 demo ... stage: review 1\n- Slice 8 other\n';
  const a = makeRepo(ledger);
  const ship = shipFor(a.repo);
  try {
    const path = join(a.root, 'demo-worktrees', 'wave-ledger.md');
    const git = (...args) => execFileSync('git', ['-C', a.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
    writeFileSync(join(a.repo, 'README.md'), 'x\n');
    git('add', '.'); git('commit', '-q', '-m', 'base'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    // unknown or docs-only branch: allowed even with a stamp at Build
    mkdirSync(join(a.root, 'demo-worktrees', 'step-reports'), { recursive: true });
    writeFileSync(stepReportPath(path, 7), '2026-11-18T08:30:00.000Z\nBuild the slice\n');
    assert.equal(run(a.repo, ship), 'none');
    writeFileSync(join(a.repo, 'notes.md'), 'y\n');
    git('add', '.'); git('commit', '-q', '-m', 'docs');
    assert.equal(run(a.repo, ship), 'none');
    // a branch that changed a code file: the stamp counts
    writeFileSync(join(a.repo, 'code.mjs'), 'z\n');
    git('add', '.'); git('commit', '-q', '-m', 'code');
    rmSync(stepReportPath(path, 7));
    // a stamp-less slice is allowed, also when another slice's stamp and the folder exist
    assert.equal(run(a.repo, ship), 'none');
    writeFileSync(stepReportPath(path, 8), '2026-11-18T09:00:00.000Z\nBuild the slice\n');
    assert.deepEqual(unreportedSlices(path, ['7']), []);
    assert.equal(run(a.repo, ship), 'none');
    // a stamp of this wave at Build: denied
    writeFileSync(stepReportPath(path, 7), '2026-11-18T08:30:00.000Z\nBuild the slice\n');
    assert.deepEqual(unreportedSlices(path, ['7']), ['7']);
    assert.equal(run(a.repo, ship), 'deny');
    // the brief names no worktree: unknown, allowed
    assert.equal(run(a.repo, { subagent_type: 'ship-branch', prompt: 'Commit mode, Slice 7.' }), 'none');
    // a docs-only slice worktree named in the brief while cwd is the code branch: allowed
    const docs = makeRepo();
    try {
      const dgit = (...args) => execFileSync('git', ['-C', docs.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
      writeFileSync(join(docs.repo, 'README.md'), 'x\n');
      dgit('add', '.'); dgit('commit', '-q', '-m', 'base'); dgit('update-ref', 'refs/remotes/origin/main', 'HEAD');
      writeFileSync(join(docs.repo, 'notes.md'), 'y\n');
      dgit('add', '.'); dgit('commit', '-q', '-m', 'docs');
      assert.equal(run(a.repo, shipFor(docs.repo)), 'none');
    } finally { rmSync(docs.root, { recursive: true, force: true }); }
    // a stamp at review 1 or later is allowed
    writeFileSync(stepReportPath(path, 7), '2026-11-18T08:30:00.000Z\nReview pass 1 (high)\n');
    assert.deepEqual(unreportedSlices(path, ['7']), []);
    assert.equal(run(a.repo, ship), 'none');
    // a stamp from before the wave, an old-format stamp (time only), an unknown label and garbage are allowed
    for (const text of ['2026-11-18T07:00:00.000Z\nBuild the slice\n', '2026-11-18T08:30:00.000Z\n', '2026-11-18T08:30:00.000Z\nCheck: x\n', 'garbage']) {
      writeFileSync(stepReportPath(path, 7), text);
      assert.deepEqual(unreportedSlices(path, ['7']), [], text);
    }
    // a slice outside the open wave is never refused
    writeFileSync(stepReportPath(path, 24), '2026-11-18T08:30:00.000Z\nBuild the slice\n');
    assert.deepEqual(unreportedSlices(path, ['24']), []);
    assert.equal(run(a.repo, outside), 'none');
  } finally { rmSync(a.root, { recursive: true, force: true }); }
  // a missing ledger fails open
  assert.deepEqual(unreportedSlices(join(tmpdir(), 'no-such-dir', 'wave-ledger.md'), ['7']), []);
});

test('Slice 33 item 8: a docs-only worktree named in the brief passes the stage check with a building ledger line; a code branch still denies', () => {
  const a = makeRepo('## Wave 1 (open)\n- Slice 7 demo ... stage: building\n');
  try {
    const git = (...args) => execFileSync('git', ['-C', a.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
    writeFileSync(join(a.repo, 'README.md'), 'x\n');
    git('add', '.'); git('commit', '-q', '-m', 'base'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const ship = { subagent_type: 'ship-branch', prompt: `Commit mode, Slice 7. Worktree ${a.repo} is the checkout.` };
    writeFileSync(join(a.repo, 'notes.md'), 'y\n');
    git('add', '.'); git('commit', '-q', '-m', 'docs');
    assert.equal(run(a.repo, ship), 'none');
    writeFileSync(join(a.repo, 'code.mjs'), 'z\n');
    git('add', '.'); git('commit', '-q', '-m', 'code');
    assert.equal(run(a.repo, ship), 'deny');
  } finally { rmSync(a.root, { recursive: true, force: true }); }
});

test('Slice 33 item 8: code merged to origin/main after the docs branch started does not make the branch look like code', () => {
  const a = makeRepo('## Wave 1 (open)\n- Slice 7 demo ... stage: building\n');
  try {
    const git = (...args) => execFileSync('git', ['-C', a.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
    writeFileSync(join(a.repo, 'README.md'), 'x\n');
    git('add', '.'); git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'main-advanced');
    writeFileSync(join(a.repo, 'later.mjs'), 'z\n');
    git('add', '.'); git('commit', '-q', '-m', 'code on main'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', '-'); // back to the branch cut before the code commit
    writeFileSync(join(a.repo, 'notes.md'), 'y\n');
    git('add', '.'); git('commit', '-q', '-m', 'docs');
    const ship = { subagent_type: 'ship-branch', prompt: `Commit mode, Slice 7. Worktree ${a.repo} is the checkout.` };
    assert.equal(run(a.repo, ship), 'none');
  } finally { rmSync(a.root, { recursive: true, force: true }); }
});

test('Slice 33 item 8: an empty diff, uncommitted code or a bad worktree path keeps the stage denial; uncommitted docs pass', () => {
  const a = makeRepo('## Wave 1 (open)\n- Slice 7 demo ... stage: building\n');
  try {
    const git = (...args) => execFileSync('git', ['-C', a.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
    writeFileSync(join(a.repo, 'README.md'), 'x\n');
    git('add', '.'); git('commit', '-q', '-m', 'base'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const ship = { subagent_type: 'ship-branch', prompt: `Commit mode, Slice 7. Worktree ${a.repo} is the checkout.` };
    assert.equal(run(a.repo, ship), 'deny'); // empty diff
    writeFileSync(join(a.repo, 'code.mjs'), 'z\n');
    assert.equal(run(a.repo, ship), 'deny'); // uncommitted code
    rmSync(join(a.repo, 'code.mjs'));
    writeFileSync(join(a.repo, 'notes.md'), 'y\n');
    assert.equal(run(a.repo, ship), 'none'); // uncommitted docs only
    const bad = { subagent_type: 'ship-branch', prompt: `Commit mode, Slice 7. Worktree ${join(a.root, 'no-such-dir')} is the checkout.` };
    assert.equal(run(a.repo, bad), 'deny'); // unreadable worktree
  } finally { rmSync(a.root, { recursive: true, force: true }); }
});
