// node --test skills/run-wave/folder-holders.test.mjs (Windows only: Restart Manager and WMI; skipped elsewhere)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./folder-holders.ps1', import.meta.url));
const skip = process.platform === 'win32' ? false : 'Windows only';
const holders = (folder) => spawnSync('pwsh', ['-NoProfile', '-File', SCRIPT, '-Path', folder], { encoding: 'utf8' });

// A child that keeps `file` open until its stdin closes; resolves once it says it holds the file.
function holdFile(file) {
  const child = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(file)}, 'r'); console.log('held'); process.stdin.resume();`], { stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve) => child.stdout.once('data', () => resolve(child)));
}

test('a process with a file open under the folder is named; after it exits none is', { skip }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'fh-open-'));
  const file = join(folder, 'held.txt');
  writeFileSync(file, 'x');
  const child = await holdFile(file);
  try {
    const found = holders(folder);
    assert.equal(found.status, 1, found.stdout + found.stderr);
    assert.match(found.stdout, new RegExp(`^${child.pid}\\t\\S+\\t.*open file`, 'm'));
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
  }
  const after = holders(folder);
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.match(after.stdout, /no process found holding/);
});

test('a process started with the folder in its command line is named', { skip }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'fh-cmd-'));
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()', folder], { stdio: ['pipe', 'ignore', 'inherit'] });
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const found = holders(folder);
    assert.equal(found.status, 1, found.stdout + found.stderr);
    assert.match(found.stdout, new RegExp(`^${child.pid}\\t\\S+\\t.*command line`, 'm'));
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('a process whose command line names a sibling with the same prefix is not named', { skip }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'fh-pre-'));
  const folder = join(parent, 's30');
  const sibling = join(parent, 's307');
  mkdirSync(folder);
  mkdirSync(sibling);
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()', sibling], { stdio: ['pipe', 'ignore', 'inherit'] });
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const found = holders(folder);
    assert.equal(found.status, 0, found.stdout + found.stderr);
    assert.match(found.stdout, /no process found holding/);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('a holder past the first batch of files is found, and a file cap reports a partial check', { skip }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'fh-many-'));
  for (let i = 0; i < 12; i++) writeFileSync(join(folder, `f${String(i).padStart(2, '0')}.txt`), 'x');
  const file = join(folder, 'zz-held.txt');
  writeFileSync(file, 'x');
  const child = await holdFile(file);
  try {
    const batched = spawnSync('pwsh', ['-NoProfile', '-File', SCRIPT, '-Path', folder, '-BatchSize', '5'], { encoding: 'utf8' });
    assert.equal(batched.status, 1, batched.stdout + batched.stderr);
    assert.match(batched.stdout, new RegExp(`^${child.pid}\\t`, 'm'));
    const capped = spawnSync('pwsh', ['-NoProfile', '-File', SCRIPT, '-Path', folder, '-MaxFiles', '3'], { encoding: 'utf8' });
    assert.equal(capped.status, 3, capped.stdout + capped.stderr);
    assert.match(capped.stdout, /PARTIAL/);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('a missing folder exits 2', { skip }, () => {
  const found = holders(join(tmpdir(), 'fh-does-not-exist-307'));
  assert.equal(found.status, 2);
  assert.match(found.stderr, /not a folder/);
});
