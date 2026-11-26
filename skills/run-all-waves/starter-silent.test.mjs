// node --test skills/run-all-waves/starter-silent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, lastAssistantAt, readTail, DEFAULT_SILENT_MINUTES } from './starter-silent.mjs';

const NOW = Date.parse('2026-11-14T10:00:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();
const line = (o) => JSON.stringify(o);
const assistant = (minutesAgo, extra = {}) => line({ type: 'assistant', timestamp: at(minutesAgo), message: { content: [] }, ...extra });
const user = (minutesAgo) => line({ type: 'user', timestamp: at(minutesAgo), message: { content: 'hi' } });

test('an assistant entry 26 minutes ago is silent, 24 minutes ago is not (default 25)', () => {
  assert.equal(DEFAULT_SILENT_MINUTES, 25);
  assert.equal(analyze(assistant(26), NOW).silent, true);
  assert.equal(analyze(assistant(24), NOW).silent, false);
});

test('readTail returns only the tail of a big file and drops the cut first line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-silent-'));
  try {
    const file = path.join(dir, 't.jsonl');
    const filler = `${line({ type: 'user', timestamp: at(500), message: { content: 'x'.repeat(100) } })}\n`.repeat(100);
    fs.writeFileSync(file, `${assistant(500)}\n${filler}${assistant(3)}\n`);
    const tail = readTail(file, 2000);
    assert.equal(lastAssistantAt(tail), at(3));
    assert.ok(tail.split('\n').filter(Boolean).every((l) => { JSON.parse(l); return true; }));
    assert.equal(readTail(file, 10 * 1024 * 1024).split('\n').filter(Boolean).length, 102);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('newer user or system entries do not count as the starter speaking', () => {
  const result = analyze([assistant(30), user(2)].join('\n'), NOW);
  assert.equal(result.silent, true);
  assert.equal(result.lastAssistantAt, at(30));
});

test('subagent (sidechain) entries are ignored', () => {
  const result = analyze([assistant(30), assistant(1, { isSidechain: true })].join('\n'), NOW);
  assert.equal(result.silent, true);
});

test('no assistant entry, an empty file or junk lines are not silent', () => {
  assert.deepEqual(analyze('', NOW), { silent: false, lastAssistantAt: null });
  assert.equal(analyze([user(60), 'not json'].join('\n'), NOW).silent, false);
  assert.equal(lastAssistantAt(line({ type: 'assistant', message: {} })), null);
});

test('the threshold is a parameter', () => {
  assert.equal(analyze(assistant(5), NOW, 3).silent, true);
  assert.equal(analyze(assistant(5), NOW, 6).silent, false);
});
