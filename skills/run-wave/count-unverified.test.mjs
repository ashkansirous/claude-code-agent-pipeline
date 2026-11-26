import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countUnverified, countByProduct, applyCount, currentCount, main } from './count-unverified.mjs';

const FILE = `# Not yet tried on a device

- an intro bullet that is not a check

### Slice 1: One ([slice](slices/1.md))
- a
- b

### Slice 2: Two
- c
### Slice 3: Empty

### Slice 4: Four
- d
  - a nested line is part of d
`;
const PLAN = (n, m) => `# Plan\r\n- **Not yet tried on a device:** ${n} checks across ${m} slices, in [docs/plan/unverified.md](docs/plan/unverified.md).\r\nother\r\n`;

test('counts top-level bullets under slice headings, not the intro or nested lines; empty blocks are no slice', () => {
  assert.deepEqual(countUnverified(FILE), { checks: 4, slices: 3 });
  assert.deepEqual(countUnverified(FILE.replace(/\n/g, '\r\n')), { checks: 4, slices: 3 });
});

test('applyCount rewrites only the count line and keeps CRLF and the tail', () => {
  const { text, found } = applyCount(PLAN(469, 188), { checks: 468, slices: 188 });
  assert.equal(found, true);
  assert.equal(text, PLAN(468, 188));
  assert.deepEqual(currentCount(text), { checks: 468, slices: 188, split: '' });
  assert.equal(applyCount('no line here', { checks: 1, slices: 1 }).found, false);
});

test('a product split after "slices" is counted from the ## headings and rewritten', () => {
  const file = '# T\n\n## Read The Stupid Text\n\n### Slice 1: a\n- x\n- y\n\n## Dino Reader\n\n### Slice 2: b\n- z\n';
  assert.deepEqual(countByProduct(file), { 'Read The Stupid Text': 2, 'Dino Reader': 1 });
  assert.deepEqual(countByProduct(FILE), {});
  const { text } = applyCount(PLAN(9, 9).replace('slices,', 'slices (Read The Stupid Text 9, Dino Reader 9),'), { checks: 3, slices: 2 }, countByProduct(file));
  assert.equal(text, PLAN(3, 2).replace('slices,', 'slices (Read The Stupid Text 2, Dino Reader 1),'));
});

test('a non-product ## heading is not a product', () => {
  const file = '# T\n\n## Notes\n\n### Slice 1: a\n- x\n\n## Dino Reader\n\n### Slice 2: b\n- z\n\n## Notes\n- y\n';
  assert.deepEqual(countByProduct(file), { 'Dino Reader': 1 });
  assert.deepEqual(countByProduct('## Notes\n### Slice 1: a\n- x\n'), {});
});

test('a parenthetical that is not a product split is kept', () => {
  const plan = PLAN(1, 1).replace('slices,', 'slices (see unverified.md),');
  assert.equal(applyCount(plan, { checks: 2, slices: 1 }).text, PLAN(2, 1).replace('slices,', 'slices (see unverified.md),'));
  const split = applyCount(plan, { checks: 2, slices: 1 }, { Shared: 2 }).text;
  assert.equal(split, PLAN(2, 1).replace('slices,', 'slices (Shared 2) (see unverified.md),'));
});

test('short product names count as products, a repeated heading adds on, and keep the first name used', () => {
  const file = '## RTST\n### Slice 1: a\n- x\n\n## Dino\n### Slice 2: b\n- y\n\n## Read The Stupid Text\n### Slice 3: c\n- z\n- w\n';
  assert.deepEqual(countByProduct(file), { RTST: 3, Dino: 1 });
  assert.deepEqual(countByProduct('## Dino Reader\n### Slice 1: a\n- x\n## Notes\n## Dino Reader\n### Slice 2: b\n- y\n'), { 'Dino Reader': 2 });
});

test('the split regex consumes only known product lists: "(Android 3)" is kept, "(RTST 1, Dino 2)" is replaced', () => {
  const keep = PLAN(1, 1).replace('slices,', 'slices (Android 3),');
  assert.equal(applyCount(keep, { checks: 2, slices: 1 }).text, PLAN(2, 1).replace('slices,', 'slices (Android 3),'));
  const old = PLAN(1, 1).replace('slices,', 'slices (RTST 1, Dino 2),');
  assert.equal(applyCount(old, { checks: 3, slices: 1 }, { Dino: 3 }).text, PLAN(3, 1).replace('slices,', 'slices (Dino 3),'));
});

const PRODUCT_FILE ='# T\n\n## Dino Reader\n\n### Slice 1: a\n- x\n- y\n\n## Shared\n\n### Slice 2: b\n- z\n';

test('main: --check fails when only the product split is stale, --write with products fixes it', () => {
  const dir = repo(PLAN(3, 2).replace('slices,', 'slices (Dino Reader 1, Shared 2),'), PRODUCT_FILE);
  const lines = [];
  assert.equal(main([dir, '--check'], (t) => lines.push(t)), 1);
  assert.match(lines.join('\n'), /plan\.md says 3 checks across 2 slices \(Dino Reader 1, Shared 2\)/);
  assert.equal(main([dir, '--write'], () => {}), 0);
  assert.equal(readFileSync(join(dir, 'plan.md'), 'utf8'), PLAN(3, 2).replace('slices,', 'slices (Dino Reader 2, Shared 1),'));
  assert.equal(main([dir, '--check'], () => {}), 0);
});

function repo(plan, unverified = FILE) {
  const dir = mkdtempSync(join(tmpdir(), 'count-unv-'));
  mkdirSync(join(dir, 'docs', 'plan'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'plan', 'unverified.md'), unverified);
  writeFileSync(join(dir, 'plan.md'), plan);
  return dir;
}

test('main: --check fails on a drifted plan.md, --write fixes it, then --check passes', () => {
  const dir = repo(PLAN(469, 3));
  const lines = [];
  assert.equal(main([dir, '--check'], (t) => lines.push(t)), 1);
  assert.match(lines.join('\n'), /plan\.md says 469 checks across 3 slices/);
  assert.equal(main([dir, '--write'], () => {}), 0);
  assert.equal(readFileSync(join(dir, 'plan.md'), 'utf8'), PLAN(4, 3));
  assert.equal(main([dir, '--check'], () => {}), 0);
});

test('main: usage errors exit 2', () => {
  assert.equal(main([], () => {}), 2);
  assert.equal(main([mkdtempSync(join(tmpdir(), 'count-unv-empty-'))], () => {}), 2);
});

test('Slice 23 item 12: a pointer line is not counted as a check', () => {
  const text = '### Slice 1\n- Open the app.\n- Item F moved to Slice 16\n- See Slice 17.\n- Check the real sync moved to the phone.\n';
  assert.deepEqual(countUnverified(text), { checks: 2, slices: 1 });
  const checks = '### Slice 1\n- See the offline banner on the test phone after Slice 12\n- Merged build still shows the old badge, Slice 4\n- Now in Slice 9\n- Tracked in Slice 3.\n';
  assert.deepEqual(countUnverified(checks), { checks: 2, slices: 1 });
});
