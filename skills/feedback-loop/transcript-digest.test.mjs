import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { digest, digestFiles, slowStretches, isEntryPoint, projectFolder, userPrompts, parseArgs } from './transcript-digest.mjs';

const line = o => JSON.stringify(o);

test('keeps user, assistant text, agent briefs and compaction summaries', () => {
  const jsonl = [
    line({ type: 'user', timestamp: '2026-10-30T10:00:00Z', message: { role: 'user', content: 'audit the session' } }),
    line({ type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'secret' },
      { type: 'text', text: 'Say "audit" and I will check.' },
      { type: 'tool_use', name: 'Agent', input: { subagent_type: 'ground-in-code', description: 'check', prompt: 'Read X' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'List files' } },
    ] } }),
    line({ type: 'user', isCompactSummary: true, message: { content: 'Summary: slice 215 planned' } }),
  ].join('\n');
  const out = digest(jsonl);
  assert.match(out, /^\[1 2026-10-30T10:00\] USER: audit the session$/m);
  assert.match(out, /ASSISTANT: Say "audit" and I will check\./);
  assert.match(out, /AGENT ground-in-code "check": Read X/);
  assert.match(out, /TOOL Bash: List files/);
  assert.match(out, /COMPACT SUMMARY: Summary: slice 215 planned/);
  assert.doesNotMatch(out, /secret/);
});

test('drops ordinary tool results, meta entries, sidechains and local command noise', () => {
  const jsonl = [
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'huge output' }] } }),
    line({ type: 'user', isMeta: true, message: { content: 'meta' } }),
    line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'side' }] } }),
    line({ type: 'user', message: { content: '<local-command-caveat>x</local-command-caveat>' } }),
    'not json',
  ].join('\n');
  assert.equal(digest(jsonl), '--- slow stretches (over 10 min)\nnone');
});

test('clips long agent prompts and task notifications', () => {
  const jsonl = [
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { prompt: 'a'.repeat(5000) } }] } }),
    line({ type: 'user', message: { content: `<task-notification>${'b'.repeat(5000)}` } }),
  ].join('\n');
  const out = digest(jsonl);
  assert.ok(out.length < 2500);
  assert.match(out, /\[\.\.\.\]/);
});

test('maps a project folder the way Claude Code names it', () => {
  assert.match(projectFolder('D:\\ReadTheStupidText'), /projects[\\/]D--ReadTheStupidText$/);
  assert.match(projectFolder('D:\\my repo\\under_score'), /projects[\\/]D--my-repo-under-score$/);
});

test('userPrompts returns only what the user typed', () => {
  const jsonl = [
    line({ type: 'user', message: { content: 'run the feedback loop' } }),
    line({ type: 'user', message: { content: '<task-notification>done' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n');
  assert.deepEqual(userPrompts(jsonl), ['run the feedback loop']);
});

test('digestFiles joins several sessions under their own headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
  const a = path.join(dir, 'aaa.jsonl'), b = path.join(dir, 'bbb.jsonl');
  fs.writeFileSync(a, line({ type: 'user', message: { content: 'first session' } }));
  fs.writeFileSync(b, line({ type: 'user', message: { content: 'second session' } }));
  const out = digestFiles([a, b]);
  fs.rmSync(dir, { recursive: true });
  assert.match(out, /=== session aaa\n.*first session.*=== session bbb\n.*second session/s);
});

test('runs main when started through a linked folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-'));
  const real = path.join(dir, 'real'), link = path.join(dir, 'link');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'x.mjs'), '');
  fs.symlinkSync(real, link, 'junction');
  const viaLink = isEntryPoint(path.join(link, 'x.mjs'), pathToFileURL(path.join(real, 'x.mjs')).href);
  const other = isEntryPoint(path.join(dir, 'other.mjs'), pathToFileURL(path.join(real, 'x.mjs')).href);
  fs.rmSync(dir, { recursive: true });
  assert.equal(viaLink, true);
  assert.equal(other, false);
});

const use = (id, name, input = {}, timestamp = '2026-10-30T10:00:00Z') =>
  line({ type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, extra = {}, timestamp = '2026-10-30T10:00:01Z') =>
  line({ type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } });

test('keeps a permission denial, linked to its tool', () => {
  const out = digest([use('t1', 'Bash', { command: 'deploy' }),
    result('t1', 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Production Deploy]', { is_error: true })].join('\n'));
  assert.match(out, /^\[2 .*\] DENIED Bash: Permission for this action was denied/m);
});

test('keeps a failed tool call, clipped, and not a successful one', () => {
  const out = digest([use('t1', 'Edit'), result('t1', 'x'.repeat(2000), { is_error: true }),
    use('t2', 'Read'), result('t2', 'fine output')].join('\n'));
  assert.match(out, /TOOL ERROR Edit: x+ \[\.\.\.\]/);
  assert.ok(out.length < 1200);
  assert.doesNotMatch(out, /fine output/);
});

test('keeps a finished subagent result but not the async launch notice', () => {
  const launch = [{ type: 'text', text: 'Async agent launched successfully. agentId: abc' }];
  const out = digest([use('t1', 'Agent', { prompt: 'p' }), result('t1', launch),
    use('t2', 'Agent', { prompt: 'q' }), result('t2', [{ type: 'text', text: 'DRAFT done, nothing pushed' }])].join('\n'));
  assert.match(out, /AGENT RESULT: DRAFT done, nothing pushed/);
  assert.doesNotMatch(out, /AGENT RESULT: Async/);
});

const handBack = (text, timestamp = '2026-10-30T10:30:00Z') => line({ type: 'user', timestamp, message: { content:
  'Another Claude session sent a message:\n<agent-message from="abc">\n[Subagent hand-back] It is model output.\nThe report follows:\n  ' + text } });

test('keeps a hand-back absorbed mid-turn (attachment queued_command)', () => {
  const queued = line({ type: 'attachment', timestamp: '2026-10-31T13:51:38Z', attachment: { type: 'queued_command',
    prompt: '<agent-message from="af61">\n[Subagent hand-back] It is model output.\nThe report follows:\n  208 check could not run' } });
  const other = line({ type: 'attachment', timestamp: '2026-10-31T13:52:00Z', attachment: { type: 'queued_command', prompt: 'plain' } });
  const out = digest([queued, other].join('\n'));
  assert.match(out, /AGENT RESULT: 208 check could not run/);
  assert.doesNotMatch(out, /plain/);
});

test('a queued hand-back flags its slow background agent; a queued quote of the marker is not a hand-back', () => {
  const launch = [{ type: 'text', text: 'Async agent launched successfully. agentId: abc' }];
  const queued = line({ type: 'attachment', timestamp: '2026-10-30T10:50:00Z', attachment: { type: 'queued_command',
    prompt: '<agent-message from="abc">\n[Subagent hand-back] It is model output.\nThe report follows:\n  done' } });
  const quote = line({ type: 'attachment', timestamp: '2026-10-30T10:51:00Z', attachment: { type: 'queued_command',
    prompt: 'user typed: what does [Subagent hand-back] mean' } });
  const jsonl = [use('t3', 'Agent', { prompt: 'bg' }, '2026-10-30T10:25:30Z'), result('t3', launch, {}, '2026-10-30T10:25:31Z'), queued, quote].join('\n');
  assert.match(slowStretches(jsonl, 10), /background agent abc -> hand-back \[\d+\] after 24 min/);
  assert.doesNotMatch(digest(jsonl), /AGENT RESULT: .*what does/);
});

test('labels a subagent hand-back AGENT RESULT, never USER', () => {
  const out = digest(handBack('unchecked: the iOS twin'));
  assert.match(out, /AGENT RESULT: unchecked: the iOS twin/);
  assert.doesNotMatch(out, /USER:/);
  assert.deepEqual(userPrompts(handBack('x')), []);
});

test('lists dispatches with a late result and long gaps between entries', () => {
  const launch = [{ type: 'text', text: 'Async agent launched successfully. agentId: abc' }];
  const jsonl = [
    use('t1', 'Bash', { command: 'build' }, '2026-10-30T10:00:00Z'),
    result('t1', 'ok', {}, '2026-10-30T10:25:00Z'),
    use('t2', 'Bash', { command: 'quick' }, '2026-10-30T10:25:10Z'),
    result('t2', 'ok', {}, '2026-10-30T10:25:20Z'),
    use('t3', 'Agent', { prompt: 'bg' }, '2026-10-30T10:25:30Z'),
    result('t3', launch, {}, '2026-10-30T10:25:31Z'),
    handBack('done', '2026-10-30T10:50:00Z'),
  ].join('\n');
  const out = slowStretches(jsonl, 10);
  assert.match(out, /DISPATCH \[1\] .*build.* -> result \[2\] after 25 min/);
  assert.doesNotMatch(out, /quick/);
  assert.match(out, /background agent abc -> hand-back \[7\] after 24 min/);
  assert.doesNotMatch(out, /GAP/);
  assert.match(slowStretches(jsonl, 60), /none/);
});

test('reads the hand-back stored as a meta entry with an origin', () => {
  const entry = line({ type: 'user', isMeta: true, origin: { kind: 'peer', from: 'abc', handback: true, handbackReportText: 'DRAFT done, from memory' },
    message: { content: 'Another Claude session sent a message:' } });
  const out = digest(entry);
  assert.match(out, /AGENT RESULT: DRAFT done, from memory/);
  assert.doesNotMatch(out, /USER:/);
});

const NONE = '--- slow stretches (over 10 min)\nnone';

test('keeps a denial only when the call failed, not when a result merely quotes the marker', () => {
  const quoted = 'Permission for this action was denied is a marker in transcript-digest.mjs';
  const out = digest([use('t1', 'Read'), result('t1', quoted),
    use('t2', 'Bash'), result('t2', quoted, { is_error: true })].join('\n'));
  assert.doesNotMatch(out, /DENIED Read/);
  assert.match(out, /DENIED Bash/);
});

test('keeps the head and the tail of a long agent result', () => {
  const report = `HEAD-START ${'m'.repeat(4000)} Not verified: the iOS twin`;
  const out = digest([use('t1', 'Agent', { prompt: 'p' }), result('t1', [{ type: 'text', text: report }])].join('\n'));
  assert.match(out, /AGENT RESULT: HEAD-START m+ \[\.\.\.\] m+ Not verified: the iOS twin/);
  assert.ok(out.length < 2300);
});

test('pairs a background task with its task notification by tool-use-id', () => {
  const jsonl = [
    use('b1', 'Bash', { command: 'long build', run_in_background: true }, '2026-10-30T10:00:00Z'),
    result('b1', 'Command running in background', {}, '2026-10-30T10:00:01Z'),
    line({ type: 'user', timestamp: '2026-10-30T10:55:00Z', message: { content: '<task-notification><tool-use-id>b1</tool-use-id>done' } }),
  ].join('\n');
  const out = slowStretches(jsonl, 10);
  assert.match(out, /DISPATCH \[1\] .*long build.* -> task notification \[3\] after 55 min/);
  assert.doesNotMatch(out, /GAP/);
});

test('leaves out the user idle time and gaps a dispatch already explains', () => {
  const jsonl = [
    use('t1', 'Bash', { command: 'build' }, '2026-10-30T10:00:00Z'),
    result('t1', 'ok', {}, '2026-10-30T10:25:00Z'),
    line({ type: 'user', timestamp: '2026-10-30T18:00:00Z', message: { content: 'good morning' } }),
    use('t2', 'Bash', { command: 'next' }, '2026-10-30T18:00:05Z'),
    line({ type: 'assistant', timestamp: '2026-10-30T18:30:00Z', message: { content: [{ type: 'text', text: 'slow thinking' }] } }),
  ].join('\n');
  const out = slowStretches(jsonl, 10);
  assert.match(out, /DISPATCH \[1\] .* after 25 min/);
  assert.doesNotMatch(out, /GAP \[1\]/);
  assert.doesNotMatch(out, /GAP \[2\] -> \[3\]/);
  assert.match(out, /GAP \[4\] -> \[5\] 30 min/);
});

test('recognises a hand-back stored as text blocks and with a hyphenated id, not a user quoting the frame', () => {
  const frame = 'Another Claude session sent a message:\n<agent-message from="a1-b2">\n[Subagent hand-back] x\nThe report follows:\n  array form report';
  const blocks = line({ type: 'user', message: { content: [{ type: 'text', text: frame }] } });
  assert.match(digest(blocks), /AGENT RESULT: array form report/);
  const quoting = line({ type: 'user', origin: { kind: 'human' }, message: { content: 'why does it say [Subagent hand-back] here?' } });
  assert.match(digest(quoting), /USER: why does it say/);
  const launch = [{ type: 'text', text: 'Async agent launched successfully. agentId: a1-b2' }];
  const slow = [use('t3', 'Agent', { prompt: 'bg' }, '2026-10-30T10:00:00Z'), result('t3', launch, {}, '2026-10-30T10:00:01Z'),
    line({ type: 'user', timestamp: '2026-10-30T10:40:00Z', message: { content: frame } })].join('\n');
  assert.match(slowStretches(slow, 10), /background agent a1-b2 -> hand-back \[3\] after 40 min/);
});

test('keeps the user slash command and its args, skips command output', () => {
  const jsonl = [
    line({ type: 'user', message: { content: '<command-name>/RefineScope</command-name>\n<command-message>RefineScope</command-message>\n<command-args>plan the thing</command-args>' } }),
    line({ type: 'user', message: { content: [{ type: 'text', text: '<local-command-stdout>Reloaded 5 skills</local-command-stdout>' }] } }),
    line({ type: 'user', message: { content: 'please fix /permissions' } }),
  ].join('\n');
  assert.equal(digest(jsonl), `[1 ] USER COMMAND: /RefineScope plan the thing\n[3 ] USER: please fix /permissions\n${NONE}`);
  assert.deepEqual(userPrompts(jsonl), ['/RefineScope plan the thing', 'please fix /permissions']);
});

test('a text block without a string text does not abort the digest', () => {
  const jsonl = line({ type: 'user', message: { content: [{ type: 'text' }, { type: 'text', text: null }, { type: 'text', text: 'ok' }] } });
  assert.equal(digest(jsonl), `[1 ] USER: ok\n${NONE}`);
});

test('lists a background task that never got a notification as NO RESULT', () => {
  const jsonl = [
    use('b1', 'Bash', { command: 'npm run long', run_in_background: true }, '2026-10-30T10:00:00Z'),
    result('b1', 'Command running in background', {}, '2026-10-30T10:00:01Z'),
  ].join('\n');
  assert.match(slowStretches(jsonl, 10), /DISPATCH \[1\] .* -> NO RESULT by the end of the transcript/);
});

test('rejects an empty or non-positive --gaps value', () => {
  const script = fileURLToPath(new URL('./transcript-digest.mjs', import.meta.url));
  for (const bad of ['', '0', '-3', 'abc']) {
    const r = spawnSync(process.execPath, [script, 'x.jsonl', '--out', 'o.txt', `--gaps=${bad}`], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, `--gaps=${bad}`);
    assert.match(r.stderr, /--gaps needs a positive number/);
  }
});

test('parseArgs accepts spaced and = flags and never treats a flag as a file', () => {
  assert.deepEqual(parseArgs(['a.jsonl', '--gaps=15', '--out', 'o.txt']), { flags: { '--gaps': '15', '--out': 'o.txt' }, files: ['a.jsonl'] });
  assert.deepEqual(parseArgs(['--out=o.txt', 'a.jsonl', 'b.jsonl']).files, ['a.jsonl', 'b.jsonl']);
  assert.throws(() => parseArgs(['a.jsonl', '--gaps', '--out', 'x']), /--gaps needs a value/);
  assert.throws(() => parseArgs(['a.jsonl', '--gap=3']), /unknown flag/);
});

test('numbers entries by file line even after an unparsable line', () => {
  const jsonl = ['not json', line({ type: 'user', message: { content: 'second line' } })].join('\n');
  assert.match(digest(jsonl), /^\[2 \] USER: second line$/m);
});

test('ignores a background sleep timer and the wait before a resumed session summary', () => {
  const jsonl = [
    use('s1', 'Bash', { command: 'sleep 600', run_in_background: true }, '2026-10-30T10:00:00Z'),
    result('s1', 'Command running in background', {}, '2026-10-30T10:00:01Z'),
    line({ type: 'user', timestamp: '2026-10-30T10:05:00Z', message: { content: '<task-notification><tool-use-id>s1</tool-use-id>done' } }),
    line({ type: 'user', isCompactSummary: true, timestamp: '2026-10-30T20:00:00Z', message: { content: 'Summary: resumed' } }),
  ].join('\n');
  assert.equal(slowStretches(jsonl, 10), '--- slow stretches (over 10 min)\nnone');
});

test('labels a user bang command and skips its output, also in session prompts', () => {
  const jsonl = [
    line({ type: 'user', message: { content: 'real prompt' } }),
    line({ type: 'user', message: { content: '<bash-input>git status</bash-input>' } }),
    line({ type: 'user', message: { content: '<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>' } }),
  ].join('\n');
  const out = digest(jsonl);
  assert.match(out, /USER SHELL: git status/);
  assert.doesNotMatch(out, /clean/);
  assert.deepEqual(userPrompts(jsonl), ['real prompt']);
});

test('clips a long bang command and drops trailing output when the closing tag is missing', () => {
  const long = 'echo ' + 'x'.repeat(2000);
  const out = digest(line({ type: 'user', message: { content: `<bash-input>${long}<bash-stdout>SECRETOUT</bash-stdout>` } }));
  assert.match(out, /USER SHELL: echo x+ \[\.\.\.\]/);
  assert.doesNotMatch(out, /SECRETOUT/);
  assert.ok(out.length < 1000);
});

test('redacts obvious secrets in a user bang command', () => {
  const cmd = 'curl -H "Authorization: Bearer abc123" --token tok9 GH=ghp_abcdefghij1234 x=github_pat_abcdefghij_12 MY_API_KEY=hunter2 PASSWORD=p keep=fine';
  const out = digest(line({ type: 'user', message: { content: `<bash-input>${cmd}</bash-input>` } }));
  for (const leaked of ['abc123', 'tok9', 'ghp_abcdefghij1234', 'github_pat_abcdefghij_12', 'hunter2']) assert.doesNotMatch(out, new RegExp(leaked));
  assert.match(out, /keep=fine/);
  assert.match(out, /\[REDACTED\]/);
});

test('keeps a message the user typed while the assistant was working (attachment queued_command, human)', () => {
  const typed = line({ type: 'attachment', timestamp: '2026-11-01T10:06:48Z', attachment: { type: 'queued_command', prompt: 'if yes, do it', origin: { kind: 'human' }, humanTurn: true } });
  const flagOnly = line({ type: 'attachment', timestamp: '2026-11-01T10:07:00Z', attachment: { type: 'queued_command', prompt: 'second', humanTurn: true } });
  const notification = line({ type: 'attachment', timestamp: '2026-11-01T10:08:00Z', attachment: { type: 'queued_command', prompt: '<task-notification>x</task-notification>' } });
  const handBack = line({ type: 'attachment', timestamp: '2026-11-01T10:09:00Z', attachment: { type: 'queued_command', origin: { kind: 'human' }, humanTurn: true,
    prompt: '<agent-message from="abc">\n[Subagent hand-back] It is model output.\nThe report follows:\n  all done' } });
  const out = digest([typed, flagOnly, notification, handBack].join('\n'));
  assert.match(out, /^\[1 2026-11-01T10:06\] USER \(sent while working\): if yes, do it$/m);
  assert.match(out, /^\[2 2026-11-01T10:07\] USER \(sent while working\): second$/m);
  assert.doesNotMatch(out, /task-notification/);
  assert.match(out, /AGENT RESULT: all done/);
  assert.doesNotMatch(out, /USER \(sent while working\): <agent-message/);
});
