import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { cleanTempBuilds, isBuildFile, isFilesystemRoot } from './clean-temp-builds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOURS_AGO_3 = (Date.now() - 3 * 3_600_000) / 1000;

function makeFile(dir, name, old) {
  const path = join(dir, name);
  writeFileSync(path, 'x'.repeat(10));
  if (old) utimesSync(path, HOURS_AGO_3, HOURS_AGO_3);
  return path;
}

test('isBuildFile matches app packages, any case, and nothing else', () => {
  for (const name of ['tmp123.apk', 'App.AAB', 'x.ipa', 'p.msix', 'p.msixbundle', 'p.appx', 's.apks']) assert.ok(isBuildFile(name), name);
  for (const name of ['notes.txt', 'apk', 'x.apk.log', 'build.zip']) assert.ok(!isBuildFile(name), name);
});

test('a copy with an old mtime but a new birth time is young and stays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctb-birth-'));
  try {
    const copy = makeFile(dir, 'tmp9.apk', true);
    const result = cleanTempBuilds(dir, 120);
    assert.equal(result.deleted, 0);
    assert.ok(existsSync(copy));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deletes only build files at the top level once they are old; keeps other files and subfolders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctb-'));
  try {
    const oldApk = makeFile(dir, 'tmp1.apk', true);
    const oldMsix = makeFile(dir, 'pkg.msix', true);
    const oldText = makeFile(dir, 'keep.txt', true);
    mkdirSync(join(dir, 'sub'));
    const nested = makeFile(join(dir, 'sub'), 'inner.apk', true);
    const later = Date.now() + 3 * 3_600_000;
    const result = cleanTempBuilds(dir, 120, later);
    assert.equal(result.deleted, 2);
    assert.equal(result.freedBytes, 20);
    assert.equal(result.failed, 0);
    assert.ok(!existsSync(oldApk) && !existsSync(oldMsix));
    assert.ok(existsSync(oldText) && existsSync(nested));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing directory deletes nothing and does not throw', () => {
  const dir = join(tmpdir(), `ctb-missing-${process.pid}-${Date.now()}`);
  const result = cleanTempBuilds(dir, 0);
  assert.equal(result.deleted, 0);
  assert.equal(result.error, undefined);
});

test('a drive or filesystem root is refused, in the function and with exit code 2 from the CLI', () => {
  const root = parse(tmpdir()).root;
  assert.ok(isFilesystemRoot(root));
  assert.ok(cleanTempBuilds(root, 0).error);
  const run = spawnSync('node', [join(HERE, 'clean-temp-builds.mjs'), root, '--min-age-minutes', '0'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.ok(JSON.parse(run.stdout.trim()).error);
});

test('the CLI prints one JSON line and honours --min-age-minutes 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctb-cli-'));
  try {
    makeFile(dir, 'fresh.apk', false);
    const out = execFileSync('node', [join(HERE, 'clean-temp-builds.mjs'), dir, '--min-age-minutes', '0'], { encoding: 'utf8' });
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.deleted, 1);
    assert.equal(parsed.minAgeMinutes, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI answers a missing directory argument or a bad age with a JSON error and exit 2', () => {
  const missing = spawnSync('node', [join(HERE, 'clean-temp-builds.mjs')], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.ok(JSON.parse(missing.stdout.trim()).error);
  const badAge = spawnSync('node', [join(HERE, 'clean-temp-builds.mjs'), tmpdir(), '--min-age-minutes', 'abc'], { encoding: 'utf8' });
  assert.equal(badAge.status, 2);
  assert.match(JSON.parse(badAge.stdout.trim()).error, /min-age-minutes/);
});
