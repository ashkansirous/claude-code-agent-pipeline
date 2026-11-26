import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ps-parse.mjs');
const hasPwsh = !spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).error;
const skip = hasPwsh ? false : 'pwsh not installed';

function run(...files) {
  return spawnSync(process.execPath, [SCRIPT, ...files], { encoding: 'utf8' });
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ps-parse-'));
}

test('a good file parses', { skip }, () => {
  const dir = tempDir();
  const file = join(dir, 'good.ps1');
  writeFileSync(file, 'Write-Output "hi"\n');
  const r = run(file);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /parse ok /);
});

test('a broken file exits 1 and names the line', { skip }, () => {
  const dir = tempDir();
  const file = join(dir, 'bad.ps1');
  writeFileSync(file, 'Write-Output "ok"\nif ($true {\n  1\n}\n');
  const r = run(file);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /bad\.ps1:2:/);
});

test('a bad file after a good one still fails', { skip }, () => {
  const dir = tempDir();
  const good = join(dir, 'good.ps1');
  const bad = join(dir, 'bad.ps1');
  writeFileSync(good, 'Write-Output "hi"\n');
  writeFileSync(bad, 'if ($x {\n  1\n}\n');
  const r = run(good, bad);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /parse ok .*good\.ps1/);
  assert.match(r.stdout, /bad\.ps1:1:/);
});

test('a decoy script is parsed, never executed', { skip }, () => {
  const dir = tempDir();
  const sentinel = join(dir, 'sentinel.txt');
  const file = join(dir, 'decoy.ps1');
  writeFileSync(file, `Set-Content -LiteralPath '${sentinel}' -Value ran\n`);
  const r = run(file);
  const ran = existsSync(sentinel);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(ran, false);
});

test('no arguments is a usage error', () => {
  assert.equal(run().status, 2);
});
