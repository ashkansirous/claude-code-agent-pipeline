import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findControlChars, isBinary } from './control-chars.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'control-chars.mjs');

test('tab, CR and LF are allowed', () => {
  assert.deepEqual(findControlChars('a\tb\r\nc\n'), []);
});

test('a CR in the middle of a line is found; a CRLF ending is not', () => {
  assert.deepEqual(findControlChars('ok\r\nD:/x/\rreviews/a.md\n'), [{ line: 2, column: 6, code: 0x0d }]);
});

test('a DEL byte is found', () => {
  assert.deepEqual(findControlChars('a\x7fb\n'), [{ line: 1, column: 2, code: 0x7f }]);
});

test('a form feed is found with its line and column', () => {
  assert.deepEqual(findControlChars('ok\nD:\\x\fl-c\n'), [{ line: 2, column: 5, code: 0x0c }]);
});

test('a literal \\r or \\n at a line end is found; one mid-line is not', () => {
  const hits = findControlChars('---\\r\r\nname: x\\r\nok \\r here\ncode("\\n")\n');
  assert.deepEqual(hits.map((h) => [h.line, h.code]), [[1, -1], [2, -1]]);
});

test('a file with a NUL byte counts as binary', () => {
  assert.equal(isBinary(Buffer.from([0x41, 0x00, 0x42])), true);
  assert.equal(isBinary(Buffer.from('plain text')), false);
});

test('the script fails on a changed file with a control character and passes once fixed', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ctrl-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
    writeFileSync(join(repo, 'note.md'), 'path D:\\worktrees\fl-c\n');
    const bad = spawnSync('node', [SCRIPT, repo, 'main'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /note\.md:1:\d+: control character 0x0c/);
    writeFileSync(join(repo, 'note.md'), 'path D:\\worktrees\\fl-c\n');
    const good = spawnSync('node', [SCRIPT, repo, 'main'], { encoding: 'utf8' });
    assert.equal(good.status, 0, good.stdout + good.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('--all finds a control byte already committed, which the branch check skips', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ctrl-all-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'old.md'), 'path \u0007dhoc\n');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
    const branch = spawnSync('node', [SCRIPT, repo, 'main'], { encoding: 'utf8' });
    assert.equal(branch.status, 0, branch.stdout + branch.stderr);
    const all = spawnSync('node', [SCRIPT, repo, '--all'], { encoding: 'utf8' });
    assert.equal(all.status, 1, all.stdout + all.stderr);
    assert.match(all.stdout, /old\.md:1:6: control character 0x07/);
    writeFileSync(join(repo, 'ünï.md'), 'x\u0008y\n');
    const named = spawnSync('node', [SCRIPT, repo, '--all'], { encoding: 'utf8' });
    assert.match(named.stdout, /ünï\.md:1:2: control character 0x08/);
    assert.equal(spawnSync('node', [SCRIPT, repo, '--al'], { encoding: 'utf8' }).status, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
