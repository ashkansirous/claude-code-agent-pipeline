// node --test skills/run-all-waves/live-checks.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { parseLines, untaggedNew, todoLines, parseTagList, main, tagOf, markerOf, SESSION_TAGS } from './live-checks.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'live-checks.mjs');

const SAMPLE = `# Not yet verified

Intro bullet-free text.

### Slice 24: Board ([slice](slices/24.md))

- [chrome] The live board shows the card.
- [owner] Compare the mock with the page.
  It wraps onto a second line.
- Untagged old line.

### Slice 25: Cap

- [phone] Open the page in the test phone browser.
- Item F moved to Slice 16

- [session] The plugin reports a reading.
- [chat] Ask on claude.ai.
- [cloud] A cloud session sends a usage report.
`;

test('parseLines reads tags, wrapped lines and skips pointer bullets', () => {
  const lines = parseLines(SAMPLE);
  assert.deepEqual(lines.map((l) => l.tag), ['chrome', 'owner', null, 'phone', 'session', 'chat', 'cloud']);
  assert.match(lines[1].text, /second line/);
  assert.equal(lines[0].slice, 'Slice 24: Board ([slice](slices/24.md))');
});

test('tagOf needs the tag first and a space after it', () => {
  assert.equal(tagOf('- [chrome] x'), 'chrome');
  assert.equal(tagOf('- [bogus] x'), null);
  assert.equal(tagOf('- **You:** [chrome] x'), null);
  assert.equal(tagOf('- [chrome]x'), null);
});

test('untaggedNew refuses only lines missing from the base', () => {
  assert.equal(untaggedNew(SAMPLE, SAMPLE).length, 0);
  const added = `${SAMPLE}\n- Brand new untagged line.\n`;
  assert.deepEqual(untaggedNew(added, SAMPLE).map((l) => l.text), ['- Brand new untagged line.']);
  assert.equal(untaggedNew(SAMPLE, '').length, 1);
});

test('todoLines keeps only the asked tags', () => {
  assert.deepEqual(todoLines(SAMPLE).map((l) => l.tag), ['chrome', 'phone', 'session', 'cloud']);
  assert.deepEqual(todoLines(SAMPLE, ['owner', 'chat']).map((l) => l.tag), ['owner', 'chat']);
});

const CARD = '- [chrome] The live board shows the card.';
const withMarker = (marker) => SAMPLE.replace(CARD, `${CARD} ${marker}`);

test('a marker dated today leaves the line out of todo and count; yesterday\'s marker does not', () => {
  const marked = withMarker('(live check 2026-11-19: unreachable: no allowed domain)');
  assert.deepEqual(todoLines(marked, SESSION_TAGS, '2026-11-19').map((l) => l.tag), ['phone', 'session', 'cloud']);
  assert.equal(parseLines(marked).length, parseLines(SAMPLE).length);
  assert.deepEqual(todoLines(marked, SESSION_TAGS, '2026-11-20').map((l) => l.tag), ['chrome', 'phone', 'session', 'cloud']);
  assert.equal(todoLines(withMarker('unreachable soon'), SESSION_TAGS, '2026-11-19').length, 4);
});

test('a release-not-live marker is excluded only on its own night', () => {
  const marked = withMarker('(live check 2026-11-19: release not live)');
  assert.equal(todoLines(marked, SESSION_TAGS, '2026-11-19').length, 3);
  assert.equal(todoLines(marked, SESSION_TAGS, '2026-11-20').length, 4);
});

test('a failed marker naming a slice is retried the next night and routed to that slice', () => {
  const marked = withMarker('(live check 2026-11-18: failed, follow-up in Slice 77)');
  const [first] = todoLines(marked, SESSION_TAGS, '2026-11-19');
  assert.equal(first.tag, 'chrome');
  assert.equal(first.marker.failedSlice, 77);
  assert.equal(markerOf('x (live check 2026-11-18: failed, Slice 5)').failedSlice, 5);
  assert.equal(markerOf('x (live check 2026-11-18: unreachable: no domain)').failedSlice, null);
  const out = [];
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'docs', 'plan', 'unverified.md'), marked);
    main([root, '--todo', 'chrome', '--today', '2026-11-19'], (s) => out.push(s));
    assert.match(out[0], /update Slice 77, do not file a new slice/);
    assert.deepEqual(main([root, '--count', 'chrome', '--today', '2026-11-18'], (s) => out.push(s)), 0);
    assert.equal(out.at(-1), '0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a new marker replaces the old one: the last marker on a line counts', () => {
  const marked = withMarker('(live check 2026-11-18: release not live) (live check 2026-11-19: failed, Slice 9)');
  assert.deepEqual(markerOf(marked), { date: '2026-11-19', result: 'failed, Slice 9', failedSlice: 9 });
});

test('a ## heading resets the slice context', () => {
  const text = '### Slice 1: A\n\n- [chrome] one\n\n## Other product\n\n- [chrome] two\n';
  assert.deepEqual(parseLines(text).map((l) => l.slice), ['Slice 1: A']);
});

test('--origin with no unverified.md on origin/main counts 0; a missing origin/main still fails', () => {
  const remote = mkdtempSync(join(tmpdir(), 'live-checks-remote-'));
  const root = makeRepo();
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(root, 'README.md'), 'x');
    git('add', 'README.md'); git('commit', '-q', '-m', 'base');
    git('remote', 'add', 'origin', remote);
    const before = [];
    assert.equal(main([root, '--count', 'chrome', '--origin'], (s) => before.push(s)), 1);
    git('push', '-q', 'origin', 'main'); git('fetch', '-q', 'origin');
    const out = [];
    assert.equal(main([root, '--count', 'chrome', '--origin'], (s) => out.push(s)), 0);
    assert.deepEqual(out, ['0']);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(remote, { recursive: true, force: true }); }
});

test('--lint passes with a warning when the base cannot be read; --origin fails when origin/main is missing', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'docs', 'plan', 'unverified.md'), `${SAMPLE}\n- New untagged.\n`);
    execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
    const out = [];
    assert.equal(main([root, '--lint', '--base', 'origin/main'], (s) => out.push(s)), 0);
    assert.match(out[0], /^warning: cannot read origin\/main/);
    const origin = [];
    assert.equal(main([root, '--count', 'chrome', '--origin'], (s) => origin.push(s)), 1);
    assert.match(origin[0], /cannot read origin\/main/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('parseTagList rejects unknown or empty lists', () => {
  assert.deepEqual(parseTagList('chrome, phone'), ['chrome', 'phone']);
  assert.equal(parseTagList('chrome,nope'), null);
  assert.equal(parseTagList(undefined), null);
});

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'live-checks-'));
  mkdirSync(join(root, 'docs', 'plan'), { recursive: true });
  return root;
}

test('main --todo --json and --count read the repo file', () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, 'docs', 'plan', 'unverified.md'), SAMPLE);
    const out = [];
    assert.equal(main([root, '--todo', 'chrome,phone', '--json'], (s) => out.push(s)), 0);
    assert.equal(JSON.parse(out[0]).length, 2);
    const count = [];
    main([root, '--count', 'chrome,session,phone,cloud'], (s) => count.push(s));
    assert.deepEqual(count, ['4']);
    assert.equal(main([root, '--todo', 'zzz'], () => {}), 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a missing, flag or file repo root is a usage error (exit 2) with a usage line', () => {
  for (const argv of [[], ['--lint'], ['--count', '.'], ['--lint', 'docs/plan/unverified.md'], [join(tmpdir(), 'live-checks-no-such-folder'), '--count', 'chrome']]) {
    const out = [];
    assert.equal(main(argv, (s) => out.push(s)), 2, JSON.stringify(argv));
    assert.match(out[0], /^usage: node live-checks\.mjs <repo root/);
  }
});

test('main --count is 0 for a repo with no unverified.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'live-checks-'));
  try {
    const out = [];
    assert.equal(main([root, '--count', 'chrome'], (s) => out.push(s)), 0);
    assert.deepEqual(out, ['0']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--lint through a real git base: exit 1 for a new untagged line, 0 once tagged', () => {
  const root = makeRepo();
  try {
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    const file = join(root, 'docs', 'plan', 'unverified.md');
    writeFileSync(file, SAMPLE);
    git('add', '.'); git('commit', '-q', '-m', 'base');
    writeFileSync(file, `${SAMPLE}\n- New untagged.\n`);
    const bad = spawnSync('node', [SCRIPT, root, '--lint', '--base', 'HEAD'], { encoding: 'utf8' });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /untagged: .*New untagged/);
    writeFileSync(file, `${SAMPLE}\n- [chrome] New tagged.\n`);
    const good = spawnSync('node', [SCRIPT, root, '--lint', '--base', 'HEAD'], { encoding: 'utf8' });
    assert.equal(good.status, 0, good.stdout + good.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
