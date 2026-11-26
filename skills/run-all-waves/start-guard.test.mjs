// node --test skills/run-all-waves/start-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, isQuestion, lastHumanMessage, hasEarlierStart, startsDetachedRun } from './start-guard.mjs';

const HOOK = fileURLToPath(new URL('./start-guard.mjs', import.meta.url));
const START = 'pwsh -NoProfile -File ~/.claude/skills/run-all-waves/start-detached.ps1 -Repo D:\\ReadTheStupidText';
const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const userBlocks = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const toolResult = (id = 'a', isError = false) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } });
const meta = JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'run the waves now' } });
const startCall = (id) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'PowerShell', input: { command: START } }] } });
const transcriptOf = (...lines) => lines.join('\n');
const run = (command, transcript, tool = 'PowerShell') => decide({ tool_name: tool, transcript_path: 't', tool_input: { command } }, () => transcript, () => {});
// Advisory (Slice 307, two strikes): a match is an allow that carries a warning, never a deny.
const isWarned = (verdict) => verdict?.hookSpecificOutput !== undefined && !('permissionDecision' in verdict.hookSpecificOutput) && Boolean(verdict.hookSpecificOutput.additionalContext);

test('d75d7cfc: "any reason not to run the waves?" is a question, so the start is warned about', () => {
  for (const message of ['any reason not to run the waves?', 'Should I run the waves tonight', 'can you run the waves?', 'what if we launch the driver? ', 'is it ok to start "the night run"?']) {
    const transcript = user(message.endsWith('?') || message.endsWith('? ') ? message : `${message}?`);
    assert.ok(isWarned(run(START, transcript)), message);
  }
  assert.match(run(START, user('any reason not to run the waves?')).hookSpecificOutput.additionalContext, /not a go/);
});

test('an answer, a list of answers, a go, a slash command or no typed message lets the start through', () => {
  for (const message of ['yes', 'A, B, yes', '1', 'ok', 'run the waves', 'go', "I'm leaving, you can start", 'restart the driver', '/run-all-waves D:\\repo what is left?']) {
    assert.equal(run(START, user(message)), null, message);
  }
  assert.equal(run(START, userBlocks('run all waves')), null);
  assert.equal(run(START, ''), null);
  const slash = JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/run-all-waves</command-name>\n<command-args>why?</command-args>' } });
  assert.equal(run(START, transcriptOf(user('any reason?'), slash)), null);
});

test('only the LAST human message counts; tool results, meta notes and system tags are skipped', () => {
  const transcript = transcriptOf(user('run the waves'), startCall('s1'), user('any reason not to run the waves?'), toolResult(), meta, user('<system-reminder>go</system-reminder>'));
  assert.equal(lastHumanMessage(transcript), 'any reason not to run the waves?');
  assert.equal(lastHumanMessage(''), null);
  assert.equal(lastHumanMessage('not json\n' + user('go')), 'go');
  assert.ok(isWarned(run(START, transcriptOf(user('go'), user('why so late?'), toolResult()))));
});

test('a restart passes when this session already started the run successfully, even if the last message is a question', () => {
  const transcript = transcriptOf(user('run the waves'), startCall('s1'), toolResult('s1'), user('did it die?'));
  assert.ok(hasEarlierStart(transcript));
  assert.equal(run(START, transcript), null);
  assert.equal(hasEarlierStart(transcriptOf(user('hi'))), false);
});

test('a retry after a failed call (error result, or none) with a question still warned about', () => {
  const denied = transcriptOf(user('any reason not to run the waves?'), startCall('s1'), toolResult('s1', true), user('and now? '), user('so?'));
  assert.equal(hasEarlierStart(denied), false);
  assert.ok(isWarned(run(START, denied)));
  const noResult = transcriptOf(user('any reason not to run the waves?'), startCall('s1'));
  assert.ok(isWarned(run(START, noResult)));
});

test('isQuestion: trailing question mark, quotes allowed; slash commands and statements are not', () => {
  for (const text of ['why?', 'why? ', '"why?"', 'ok (right?)']) assert.ok(isQuestion(text), text);
  for (const text of ['yes', '', null, '/run-all-waves why?', 'run it.']) assert.equal(isQuestion(text), false, String(text));
});

test('only a real start-detached.ps1 call is judged; mentions, other commands and other tools pass', () => {
  const question = user('any reason not to run the waves?');
  assert.ok(startsDetachedRun(START));
  assert.ok(startsDetachedRun('& ~/.claude/skills/run-all-waves/start-detached.ps1 -Repo x'));
  assert.ok(startsDetachedRun('cd x; pwsh -File "C:\\s\\start-detached.ps1" -Repo y'));
  for (const command of ['git commit -m "docs: start-detached.ps1 needs a go"', 'git commit -m "run pwsh -File skills/run-all-waves/start-detached.ps1 -Repo x"', 'echo start-detached.ps1', 'cat skills/run-all-waves/start-detached.ps1', 'node --test skills/run-all-waves/start-detached.test.mjs', 'ls']) {
    assert.equal(run(command, question), null, command);
  }
  assert.equal(run(START, question, 'Edit'), null);
  assert.equal(decide({}), null);
});

test('no transcript_path lets the call through with a note; the hook runs from the command line', () => {
  const notes = [];
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: START } }, () => '', (t) => notes.push(t)), null);
  assert.match(notes[0], /no transcript_path/);
  const file = join(mkdtempSync(join(tmpdir(), 'sg-')), 't.jsonl');
  writeFileSync(file, user('any reason not to run the waves?') + '\n');
  const log = join(mkdtempSync(join(tmpdir(), 'sg-log-')), 'advisory-hooks.log');
  const spawn = (stdin) => spawnSync('node', [HOOK], { input: stdin, encoding: 'utf8', env: { ...process.env, ADVISORY_HOOKS_LOG: log } });
  const warned = spawn(JSON.stringify({ tool_name: 'Bash', transcript_path: file, tool_input: { command: START } })).stdout;
  assert.doesNotMatch(warned, /permissionDecision/);
  assert.match(warned, /additionalContext/);
  assert.doesNotMatch(warned, /deny/);
  assert.match(readFileSync(log, 'utf8'), /^\S+\tstart-guard\t.*\tHook warning/);
  writeFileSync(file, user('go') + '\n');
  assert.equal(spawn(JSON.stringify({ tool_name: 'Bash', transcript_path: file, tool_input: { command: START } })).stdout, '');
  const garbage = spawn('garbage');
  assert.equal(garbage.status, 0);
  assert.match(garbage.stderr, /start-guard/);
});

test('Slice 307: with advisory.mjs missing (a partial install) the hook fails open with a note', async () => {
  const fs = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'sg-partial-'));
  fs.mkdirSync(join(root, 'run-all-waves'));
  fs.copyFileSync(HOOK, join(root, 'run-all-waves', 'start-guard.mjs'));
  const file = join(root, 't.jsonl');
  writeFileSync(file, user('any reason not to run the waves?') + '\n');
  const run = spawnSync('node', [join(root, 'run-all-waves', 'start-guard.mjs')], { input: JSON.stringify({ tool_name: 'Bash', transcript_path: file, tool_input: { command: START } }), encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /advisory\.mjs unavailable/);
});
