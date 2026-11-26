import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dropFraction, hasReasonLine, expectedLine, parseCount } from './test-count-drop.mjs';

const SCRIPT = join(import.meta.dirname, 'test-count-drop.mjs');
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('the drop is the share of the before count that went away; growth is no drop', () => {
  assert.equal(dropFraction(100, 80), 0.2);
  assert.equal(dropFraction(100, 120), 0);
  assert.equal(dropFraction(0, 0), 0);
  assert.ok(dropFraction(2809, 34) > 0.98);
});

test('exactly 20% passes; 20.1% fails with the line to write', () => {
  assert.equal(run('Dino.Tests', '1000', '800').status, 0);
  const over = run('Dino.Tests', '1000', '799');
  assert.equal(over.status, 1);
  assert.match(over.stdout, /Test count drop: Dino\.Tests 1000 -> 799: </);
});

test('a reason line for that project in the slice file lets a bigger drop through; the placeholder or another project does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tcd-'));
  const file = join(dir, 's.md');
  writeFileSync(file, 'x\nTest count drop: DinoReader.Tests 7288 -> 4513: the 2,775 removed rows were duplicates of the generated matrix.\n');
  assert.equal(run('DinoReader.Tests', '7288', '4513', file).status, 0);
  assert.equal(run('Other.Tests', '7288', '4513', file).status, 1);
  writeFileSync(file, `${expectedLine('DinoReader.Tests', 7288, 4513)}\n`);
  assert.equal(run('DinoReader.Tests', '7288', '4513', file).status, 1);
  assert.equal(hasReasonLine('Test count drop: A.Tests 10 -> 1:', 'A.Tests'), false);
});

test('cs393-check3-medium: an empty or missing count is unparsed, not 0', () => {
  assert.ok(Number.isNaN(parseCount('')));
  assert.ok(Number.isNaN(parseCount(undefined)));
  assert.ok(Number.isNaN(parseCount('  ')));
  assert.equal(parseCount('2,809'), 2809);
  assert.equal(parseCount('0'), 0);
  assert.equal(run('P', '', '5').status, 2);
  assert.equal(run('P', '100', '').status, 2);
});

test('bad arguments exit 2', () => {
  assert.equal(run().status, 2);
  assert.equal(run('P', 'a', 'b').status, 2);
});

test('review finding 9: counts with thousands separators parse, and a project name with spaces matches its reason line', () => {
  assert.equal(parseCount('2,809'), 2809);
  assert.equal(run('X', '2,809', '34').status, 1);
  assert.equal(run('X', '2,809', '2,800').status, 0);
  assert.equal(hasReasonLine('Test count drop: Shared Tests 2,809 -> 34: rows were duplicates.', 'Shared Tests'), true);
  assert.equal(hasReasonLine('Test count drop: Shared Tests 2,809 -> 34: rows were duplicates.', 'Other Tests'), false);
});
