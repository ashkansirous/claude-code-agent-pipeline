// node --test skills/run-wave/placement.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint, placementOf, touchesOf } from './placement.mjs';

const SCRIPT = fileURLToPath(new URL('./placement.mjs', import.meta.url));
const FOUR = '`src/a.ts`, `src/a.test.ts`, `src/b.ts`, `src/b.test.ts`';
const slice = (touches, extra = '') => `### Slice 1\n\n**Touches:** ${touches}\n\n${extra}`;

const cases = [
  ['four code files with no device part is cloud', slice(FOUR), 'cloud'],
  ['three code files is local (below the size line)', slice('`a.mjs`, `a.test.mjs`, `b.mjs`'), 'local'],
  ['docs and Markdown only is local', slice('`docs/a.md`, `README.md`, `skills/x/SKILL.md`, `~/.claude/CLAUDE.md`, `x.json`'), 'local'],
  ['no Touches line is local', '### Slice 1\n\nno touches here', 'local'],
  ['a .ps1 in Touches is local', slice(FOUR + ', `tools/run.ps1`'), 'local'],
  ['a csproj in Touches is local', slice(FOUR + ', `App/App.csproj`'), 'local'],
  ['a windows folder is local', slice(FOUR + ', `src/windows/x.ts`'), 'local'],
  ['a Maestro flow folder is local', slice(FOUR + ', `.maestro/a.yaml`'), 'local'],
  ['Verification naming an emulator is local', slice(FOUR, '## Verification\n\n- Run it on the emulator.\n'), 'local'],
  ['Verification naming a phone is local', slice(FOUR, '## Verification\n\n- Check on the phone.\n'), 'local'],
  ['Verification naming only unit tests stays cloud', slice(FOUR, '## Verification\n\n- `node --test` passes.\n'), 'cloud'],
  ['a device word outside Verification does not count', slice(FOUR, 'Why: the phone doc says so.\n\n## Verification\n\n- tests pass\n'), 'cloud'],
  ['explicit cloud wins over a small slice', '**Placement:** cloud\n' + slice('`a.md`'), 'cloud'],
  ['explicit local wins over a big slice', '**Placement:** `local`\n' + slice(FOUR), 'local'],
  ['explicit line is case-insensitive', '**Placement:** Cloud\n' + slice('`a.md`'), 'cloud'],
  ['explicit value with a suffix is no line', '**Placement:** cloudless\n' + slice('`a.md`'), 'local'],
  ['explicit cloud|local doc line is no line', '**Placement:** cloud|local\n' + slice(FOUR), 'cloud'],
  ['explicit cloud|local doc line does not force cloud', '**Placement:** cloud|local\n' + slice('`a.md`'), 'local'],
  ['a Verification bullet naming a device is local', slice(FOUR, '- Verification: run it on the emulator.\n'), 'local'],
  ['a *Verification run:* line naming a phone is local', slice(FOUR, '*Verification run:* checked on the phone.\n'), 'local'],
  ['CRLF slice file is read', slice(FOUR).replace(/\n/g, '\r\n'), 'cloud'],
  ['backslash paths are normalised', slice('`src\\a.ts`, `src\\a.test.ts`, `src\\b.ts`, `src\\b.test.ts`, `src\\windows\\c.ts`'), 'local'],
];

for (const [name, text, expected] of cases) {
  test(name, () => assert.equal(placementOf(text).placement, expected));
}

test('touchesOf gives no paths for an empty Touches line', () => {
  assert.deepEqual(touchesOf('**Touches:**\n`next/line.ts`'), []);
});

test('touchesOf reads the backticked paths of the Touches line only', () => {
  assert.deepEqual(touchesOf('x `no`\n**Touches:** `a.ts`, `b/c.ts`\nmore `no`'), ['a.ts', 'b/c.ts']);
});

test('the reason names the rule', () => {
  assert.match(placementOf(slice('`a.md`')).reason, /0 code file/);
  assert.match(placementOf(slice(FOUR + ', `x.ps1`')).reason, /x\.ps1/);
});

test('the CLI prints placement and reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'placement-'));
  try {
    const file = join(dir, 's.md');
    writeFileSync(file, slice(FOUR));
    const out = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /^cloud: 4 code files/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isEntryPoint resolves a junctioned path to the real script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'placement-link-'));
  try {
    const link = join(dir, 'linked');
    symlinkSync(dirname(SCRIPT), link, 'junction');
    assert.equal(isEntryPoint(join(link, 'placement.mjs'), import.meta.url.replace('placement.test.mjs', 'placement.mjs')), true);
    assert.equal(isEntryPoint(join(link, 'placement.test.mjs'), import.meta.url.replace('placement.test.mjs', 'placement.mjs')), false);
    assert.equal(isEntryPoint(undefined, import.meta.url), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI prints its result when run through a junctioned folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'placement-cli-'));
  try {
    const link = join(dir, 'linked');
    symlinkSync(dirname(SCRIPT), link, 'junction');
    const file = join(dir, 's.md');
    writeFileSync(file, slice(FOUR));
    const out = spawnSync(process.execPath, [join(link, 'placement.mjs'), file], { encoding: 'utf8' });
    assert.match(out.stdout, /^cloud: 4 code files/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Slice 29 item 3: the cloud section names per-repo worker routines and re-reads the prompt before run', () => {
  const text = readFileSync(join(dirname(SCRIPT), 'SKILL.md'), 'utf8');
  assert.match(text, /run-wave-<repo>-worker-1/);
  assert.doesNotMatch(text, /`run-wave-worker-\d`|"run-wave-worker-\d"/);
  assert.match(text, /`get` the routine and compare its stored prompt/);
});

test('the CLI defaults to local with exit 0 when the file is unreadable', () => {
  const out = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), 'no-such-slice-file.md')], { encoding: 'utf8' });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^local:/);
});
