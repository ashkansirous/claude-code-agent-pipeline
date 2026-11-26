// Slice 35 (406 item 14): `path.resolve('D:/R/s1')` is a relative path on Linux, so a test passing a drive-letter literal to
// resolve passes on a Windows host and fails only on CI's Linux job. This check flags the literal in every *.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git']);
// resolve( or path.resolve( / posix-less aliases, first argument a quoted literal starting with a drive letter.
// `win32.resolve(...)` is platform-independent and skipped; a line carrying OPT_OUT is skipped too (a fixture string).
// Not caught: a drive-letter constant passed to resolve (it needs data-flow reading).
const DRIVE_RESOLVE = /\b(?:\w+\.)?(?<!win32\.)resolve\(\s*(['"`])[A-Za-z]:[\\/]/g;
const OPT_OUT = 'drive-letter-resolve-ok';

export function driveLetterResolves(source) {
  const lines = source.split('\n');
  return [...source.matchAll(DRIVE_RESOLVE)]
    .map((m) => source.slice(0, m.index).split('\n').length)
    .filter((line) => !lines[line - 1].includes(OPT_OUT));
}

function testFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

test('the check flags the old form: a drive-letter literal passed to path.resolve', () => {
  assert.deepEqual(driveLetterResolves("const r = path.resolve('D:/R/s1');"), [1]);
  assert.deepEqual(driveLetterResolves('x\nconst r = resolve("C:\\\\work");'), [2]);
  assert.deepEqual(driveLetterResolves("path.resolve(root, 'D:/x')"), []);
  assert.deepEqual(driveLetterResolves("path.resolve('/tmp/x')"), []);
  assert.deepEqual(driveLetterResolves("path.win32.resolve('D:/x')"), []);
  assert.deepEqual(driveLetterResolves("const s = \"path.resolve('D:/x')\"; // drive-letter-resolve-ok"), []);
});

test('no *.test.mjs passes a drive-letter literal to path.resolve', () => {
  const hits = [];
  for (const file of testFiles(ROOT)) {
    if (file === fileURLToPath(import.meta.url)) continue;
    for (const line of driveLetterResolves(readFileSync(file, 'utf8'))) hits.push(`${relative(ROOT, file)}:${line}`);
  }
  assert.deepEqual(hits, [], 'drive-letter path.resolve literals are relative on Linux; build the path with path.join(os.tmpdir(), ...) or a stubbed platform');
});
