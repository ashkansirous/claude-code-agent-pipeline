// node --test skills/plan-cleanup-check/user-says.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mungeRepoPath, userText, matches, collect, isRepoFolder, parseArgs } from './user-says.mjs';

test('a leading injected block is dropped but the words typed after it are kept', () => {
  const reminder = '<system-reminder>ctx</system-reminder>';
  assert.equal(userText({ type: 'user', message: { content: [{ type: 'text', text: reminder }, { type: 'text', text: 'I played sonos' }] } }), 'I played sonos');
  assert.equal(userText({ type: 'user', message: { content: `${reminder}\nI played sonos` } }), 'I played sonos');
  assert.equal(userText({ type: 'user', message: { content: [{ type: 'text', text: reminder }] } }), null);
});

test('sidechain, headless and interrupted records are not the user', () => {
  const message = { content: 'run the sonos self test' };
  assert.equal(userText({ type: 'user', isSidechain: true, message }), null);
  assert.equal(userText({ type: 'user', entrypoint: 'sdk-cli', message }), null);
  assert.equal(userText({ type: 'user', entrypoint: 'cli', message }), 'run the sonos self test');
  assert.equal(userText({ type: 'user', message: { content: '[Request interrupted by user for tool use]' } }), null);
});

test('a project folder matches by exact name or a worktree suffix, never a longer repo name', () => {
  assert.equal(isRepoFolder('D--ReadTheStupidText', 'D--ReadTheStupidText'), true);
  assert.equal(isRepoFolder('d--readthestupidtext-worktrees-s1', 'D--ReadTheStupidText'), true);
  assert.equal(isRepoFolder('D--ReadTheStupidTextOld', 'D--ReadTheStupidText'), false);
  assert.equal(isRepoFolder('D--Lets', 'D--L'), false);
  assert.equal(isRepoFolder('D--ReadTheStupidText-Old', 'D--ReadTheStupidText'), false);
  assert.equal(isRepoFolder('D--ReadTheStupidText.old', 'D--ReadTheStupidText'), false);
});

test('injected blocks are stripped anywhere, but a message that starts with pasted markup is kept', () => {
  const reminder = '<system-reminder>Sonos extension tested</system-reminder>';
  assert.equal(userText({ type: 'user', message: { content: `ok next\n${reminder}` } }), 'ok next');
  assert.equal(userText({ type: 'user', message: { content: [{ type: 'text', text: `a ${reminder} b` }] } }), 'a  b');
  assert.equal(matches(userText({ type: 'user', message: { content: `ok next ${reminder}` } }), ['sonos'], false), false);
  assert.equal(userText({ type: 'user', message: { content: '<div>sonos broke</div>' } }), '<div>sonos broke</div>');
});

test('every harness wrapper is stripped, an unclosed one to the end of the text', () => {
  const say = (content) => userText({ type: 'user', message: { content } });
  assert.equal(say('<bash-stdout>sonos</bash-stdout>'), null);
  assert.equal(say('<bash-stderr>sonos</bash-stderr>'), null);
  assert.equal(say('<bash-input>ls sonos</bash-input>'), null);
  assert.equal(say('<teammate-message from="a" id="1">sonos</teammate-message>'), null);
  assert.equal(say('<agent-message>sonos</agent-message>'), null);
  assert.equal(say('<system-reminder>sonos never closed'), null);
  assert.equal(say('the <command-name> tag broke sonos'), 'the <command-name> tag broke sonos');
});

test('project folders: hash suffix and harness worktrees match, ".old" and "-Old" do not', () => {
  const base = 'D--ReadTheStupidText';
  assert.equal(isRepoFolder('D--ReadTheStupidText.d790e94fce959970', base), true);
  assert.equal(isRepoFolder('D--ReadTheStupidText--claude-worktrees-abc', base), true);
  assert.equal(isRepoFolder('D--ReadTheStupidText.old', base), false);
  assert.equal(isRepoFolder('D--ReadTheStupidText.', base), false);
  assert.equal(isRepoFolder('D--ReadTheStupidText.dead', base), false);
  assert.equal(isRepoFolder('D--ReadTheStupidText-Old', base), false);
});

test('phrases match across line breaks and double spaces', () => {
  assert.equal(matches('the self\ntest  passed', ['self test'], false), true);
  assert.equal(matches('the self test passed', ['Self  Test'], false), true);
});

test('--since must be a real date', () => {
  for (const bad of ['2026-13-45', '2026-02-31', '2026-11-00']) assert.throws(() => parseArgs(['--since', bad]), /real date/, bad);
  assert.equal(parseArgs(['--since', '2026-11-05T10:00:00Z']).since, '2026-11-05T10:00:00Z');
});

test('unknown flags and stray positionals are rejected', () => {
  assert.throws(() => parseArgs(['--sinse', '2026-11-05']), /unknown argument/);
  assert.throws(() => parseArgs(['--terms', 'sonos', 'self', 'test']), /unknown argument/);
});

test('arguments are validated', () => {
  assert.equal(parseArgs(['--repo', 'x', '--terms', 'a,b', '--limit', '5', '--since', '2026-11-05']).limit, 5);
  for (const bad of [['--limit', '0'], ['--limit', 'abc'], ['--since', '2026-11-5'], ['--terms'], ['--since', '--all']]) {
    assert.throws(() => parseArgs(bad), undefined, bad.join(' '));
  }
});

test('an unreadable session file is skipped, the others are still read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-says-'));
  fs.mkdirSync(path.join(dir, 'broken.jsonl'));
  fs.writeFileSync(path.join(dir, 'ok.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-11-24T10:00:00Z', message: { content: 'sonos ok' } }));
  const found = collect([dir], { terms: ['sonos'], all: false, since: null });
  assert.deepEqual(found.map((m) => m.text), ['sonos ok']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('repo path is munged the way Claude Code names its project folder', () => {
  const munged = mungeRepoPath(process.platform === 'win32' ? 'D:\\ReadTheStupidText' : '/home/a/ReadTheStupidText');
  assert.match(munged, /^[A-Za-z0-9-]+$/);
  assert.ok(munged.endsWith('-ReadTheStupidText'));
});

test('only text the user typed counts', () => {
  assert.equal(userText({ type: 'user', message: { content: 'I tested the sonos extension' } }), 'I tested the sonos extension');
  assert.equal(userText({ type: 'user', message: { content: [{ type: 'text', text: 'it works' }] } }), 'it works');
  assert.equal(userText({ type: 'user', message: { content: [{ type: 'tool_result', content: 'sonos' }] } }), null);
  assert.equal(userText({ type: 'user', isMeta: true, message: { content: 'sonos' } }), null);
  assert.equal(userText({ type: 'user', message: { content: '<system-reminder>sonos</system-reminder>' } }), null);
  assert.equal(userText({ type: 'user', message: { content: 'This session is being continued ... sonos' } }), null);
  assert.equal(userText({ type: 'assistant', message: { content: 'sonos' } }), null);
});

test('any term matches by default, every term with --all', () => {
  assert.equal(matches('I played it on Sonos', ['sonos', 'alexa'], false), true);
  assert.equal(matches('I played it on Sonos', ['sonos', 'alexa'], true), false);
  assert.equal(matches('nothing here', ['sonos'], false), false);
});

test('collect reads every session, honours --since, sorts oldest first and drops repeats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-says-'));
  const line = (when, text) => JSON.stringify({ type: 'user', timestamp: when, message: { content: text } });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), [line('2026-11-24T19:58:00Z', 'sonos works for free books'), 'not json', ''].join('\n'));
  fs.writeFileSync(path.join(dir, 'b.jsonl'), [line('2026-11-10T10:00:00Z', 'old sonos note'), line('2026-11-24T19:58:00Z', 'sonos works for free books')].join('\n'));
  const all = collect([dir], { terms: ['sonos'], all: false, since: null });
  assert.deepEqual(all.map((m) => m.text), ['old sonos note', 'sonos works for free books']);
  const recent = collect([dir], { terms: ['sonos'], all: false, since: '2026-11-20' });
  assert.equal(recent.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
