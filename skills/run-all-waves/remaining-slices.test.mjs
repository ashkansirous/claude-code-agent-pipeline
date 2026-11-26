import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { remaining, openRows } from './remaining-slices.mjs';

const SCRIPT = fileURLToPath(new URL('./remaining-slices.mjs', import.meta.url));

const PLAN = `# Plan

Intro text | with a pipe that is not a table.

## Status

| # | Slice | Status | PR | Story | File |
| --- | --- | --- | --- | --- | --- |
| 154 | Vowel marks | in progress | #470 | | [x](a.md) |
| 193 | German listings | drafted; apply waits for the user | | | [x](b.md) |
| 205 | Reading speed row | planned | | | [x](c.md) |
| 208 | Paused downloads | Planned (after 205) | | | [x](d.md) |
| 210 | Kokoro line | parked: needs the user's listening verdict | | | [x](e.md) |

| # | Status |
| --- | --- |
| 999 | planned |
`;

test('only rows whose status starts with planned are remaining', () => {
  assert.deepEqual(remaining(PLAN).planned, ['205', '208']);
});

test('reads only the first status table', () => {
  assert.equal(openRows(PLAN).length, 5);
});

test('parked, in progress and drafted rows are open but not remaining', () => {
  const statuses = openRows(PLAN).map((r) => r.status);
  assert.ok(statuses.includes('parked: needs the user\'s listening verdict'));
  assert.ok(!remaining(PLAN).planned.includes('210'));
});

test('a plan without a status table throws instead of reporting nothing remaining', () => {
  assert.throws(() => remaining('# Plan\n\nNo table here.\n'), /no recognised status table/);
});

test('"Slice number" counts as the slice column', () => {
  const plan = '| Slice number | Title | Status |\n| --- | --- | --- |\n| 7 | x | planned |\n';
  assert.deepEqual(remaining(plan).planned, ['7']);
});

test('bold, code and emoji around planned still count', () => {
  const plan = '| # | Status |\n| --- | --- |\n| 1 | **planned** |\n| 2 | `planned` |\n| 3 | \u{1F7E1} planned |\n';
  assert.deepEqual(remaining(plan).planned, ['1', '2', '3']);
});

test('an escaped pipe or a pipe in backticks does not shift the Status cell', () => {
  const plan = '| # | Title | Status |\n| --- | --- | --- |\n| 1 | a \\| b | planned |\n| 2 | `a|b` | planned |\n';
  assert.deepEqual(remaining(plan).planned, ['1', '2']);
});

test('CRLF line endings parse the same', () => {
  assert.deepEqual(remaining(PLAN.replace(/\n/g, '\r\n')).planned, ['205', '208']);
});

test('a "planned" word inside another status does not count', () => {
  const plan = '| # | Status |\n| --- | --- |\n| 1 | not planned yet |\n| 2 | unplanned |\n';
  assert.deepEqual(remaining(plan).planned, []);
});

test('several matching tables and no Status heading is ambiguous', () => {
  const plan = '# Plan\n\n## Open\n\n| # | Status |\n| --- | --- |\n| 1 | planned |\n\n## Blockers\n\n| # | Status |\n| --- | --- |\n| 9 | planned |\n';
  assert.throws(() => remaining(plan), /several tables/);
});

test('a single matching table without a Status heading is used', () => {
  const plan = '# Plan\n\n## Open\n\n| # | Status |\n| --- | --- |\n| 1 | planned |\n';
  assert.deepEqual(remaining(plan).planned, ['1']);
});

test('the table under the Status heading wins over an earlier matching table', () => {
  const plan = '# Plan\n\n## Blockers\n\n| # | Status |\n| --- | --- |\n| 9 | planned |\n\n## Status\n\n| # | Status |\n| --- | --- |\n| 1 | planned |\n';
  assert.deepEqual(remaining(plan).planned, ['1']);
});

test('one table per product under sub-headings of the Status section are all read', () => {
  const plan = '# Plan\n\n## Status\n\nIntro.\n\n### RTST\n\n| # | Status |\n| --- | --- |\n| 1 | planned |\n\n### Dino\n\n| # | Status |\n| --- | --- |\n| 2 | planned |\n| 3 | parked |\n\n### Shared\n\n| # | Status |\n| --- | --- |\n| 4 | planned |\n\n## Outstanding work\n\n| # | Status |\n| --- | --- |\n| 9 | planned |\n';
  assert.deepEqual(remaining(plan).planned, ['1', '2', '4']);
  assert.equal(openRows(plan).length, 4);
});

test('with product sub-headings, a table directly under Status or under another sub-heading is ignored; long names work', () => {
  const plan = '# Plan\n\n## Status\n\n| # | Status |\n| --- | --- |\n| 8 | planned |\n\n### Read The Stupid Text\n\n| # | Status |\n| --- | --- |\n| 1 | planned |\n\n### Dino Reader\n\n| # | Status |\n| --- | --- |\n| 2 | planned |\n\n### Notes\n\n| # | Status |\n| --- | --- |\n| 7 | planned |\n';
  assert.deepEqual(remaining(plan).planned, ['1', '2']);
});

test('without a product sub-heading the first table under Status is read as before', () => {
  const plan = '# Plan\n\n## Status\n\n| # | Status |\n| --- | --- |\n| 8 | planned |\n\n### Notes\n\n| # | Status |\n| --- | --- |\n| 7 | planned |\n';
  assert.deepEqual(remaining(plan).planned, ['8']);
});

test('prints the planned slices when called through a linked skills folder, as installed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remaining-slices-'));
  const link = path.join(dir, 'run-all-waves');
  const plan = path.join(dir, 'plan.md');
  try {
    fs.writeFileSync(plan, PLAN);
    fs.symlinkSync(path.dirname(SCRIPT), link, 'junction');
    const run = spawnSync(process.execPath, [path.join(link, 'remaining-slices.mjs'), '--file', plan], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.deepEqual(JSON.parse(run.stdout).planned, ['205', '208']);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
