// node --test skills/feedback-loop/line-endings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { problemOf, checkRef, endingKind, repoRelative } from './line-endings.mjs';

test('all LF, all CRLF and binary text pass', () => {
  assert.equal(problemOf('a\nb\n'), null);
  assert.equal(problemOf('a\r\nb\r\n'), null);
  assert.equal(problemOf('a\0\r\r\n'), null);
});

test('a doubled CR or mixed endings is reported', () => {
  assert.match(problemOf('a\r\r\nb\r\n'), /doubled CR on 1/);
  assert.match(problemOf('a\r\nb\n'), /mixed endings: 1 CRLF, 1 LF/);
});

test('a lone CR inside a line is reported', () => {
  assert.match(problemOf("& '..\reset-dev-app.ps1'\r\nb\r\n"), /lone CR .* 1 time/);
  assert.match(problemOf('a\rb\nc\n'), /lone CR/);
});

test('a CR as the very last byte is not reported, and the message does not assert a cause', () => {
  assert.equal(problemOf('a\nb\r'), null);
  assert.equal(problemOf('a\r\nb\r'), null);
  assert.doesNotMatch(problemOf('a\rb\nc\n'), /path/);
});

test('the command exits 1 and names the bad file, 0 when all are fine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'le-'));
  const good = path.join(dir, 'good.yaml');
  const bad = path.join(dir, 'bad.yaml');
  fs.writeFileSync(good, 'a\r\nb\r\n');
  fs.writeFileSync(bad, 'a\r\r\nb\r\n');
  const script = new URL('./line-endings.mjs', import.meta.url);
  const node = (files) => { try { execFileSync('node', [fs.realpathSync(script), ...files], { encoding: 'utf8' }); return 0; } catch (e) { return { code: e.status, out: e.stdout }; } };
  assert.equal(node([good, path.join(dir, 'missing.txt')]), 0);
  const result = node([good, bad]);
  assert.equal(result.code, 1);
  assert.match(result.out, /bad\.yaml: doubled CR/);
});

test('--ref reports LF for a blob committed as LF even when the working copy is CRLF (core.autocrlf)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'le-ref-'));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.md'), 'one\ntwo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'lf');
  fs.writeFileSync(path.join(dir, 'a.md'), 'one\r\ntwo\r\n');
  const script = fs.realpathSync(new URL('./line-endings.mjs', import.meta.url));
  const out = execFileSync('node', [script, '--ref', 'main', 'a.md'], { cwd: dir, encoding: 'utf8' }).split('\n');
  assert.equal(checkRef(['a.md'], 'main', (ref, file) => git('show', `${ref}:${file}`)).lines[0], 'a.md@main: LF');
  assert.equal(out[0], 'a.md@main: LF', 'the committed blob is LF whatever the checkout holds');
  assert.equal(endingKind('a\r\nb\r\n'), 'CRLF');
});

test('--ref exits 1 and names a file missing at the ref', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'le-ref2-'));
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  const script = fs.realpathSync(new URL('./line-endings.mjs', import.meta.url));
  assert.throws(() => execFileSync('node', [script, '--ref', 'main', 'gone.md'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }), (e) => e.status === 1 && /gone\.md@main: missing/.test(e.stdout));
});

test('--ref names a file outside the repo as "outside the repo", not "missing at that ref"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'le-ref3-'));
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  const script = fs.realpathSync(new URL('./line-endings.mjs', import.meta.url));
  const outside = path.join(os.tmpdir(), 'le-outside.txt');
  assert.throws(() => execFileSync('node', [script, '--ref', 'main', outside], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }), (e) => e.status === 1 && /: outside the repo/.test(e.stdout) && !/missing/.test(e.stdout));
});

test('repoRelative turns absolute, ./ and backslash paths into repo-root-relative forward-slash paths', () => {
  const top = path.resolve(os.tmpdir(), 'le-top');
  const sub = path.join(top, 'sub');
  assert.equal(repoRelative(path.join(top, 'a', 'b.md'), sub, top), 'a/b.md');
  assert.equal(repoRelative('./x.md', sub, top), 'sub/x.md');
  assert.equal(repoRelative('..\\y.md', sub, top), 'y.md');
});
