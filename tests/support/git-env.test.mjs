import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const decoy = mkdtempSync(join(tmpdir(), 'decoy-'));
execFileSync('git', ['init', '-q', '-b', 'main', decoy]);
process.env.GIT_DIR = join(decoy, '.git');
process.env.GIT_WORK_TREE = decoy;
const { cleanGitEnv, localEnvNames } = await import('./git-env.mjs');

test('importing the helper removes inherited repo variables from process.env', () => {
  assert.equal(process.env.GIT_DIR, undefined);
  assert.ok(localEnvNames().includes('GIT_DIR'));
});

test('cleanGitEnv drops GIT_DIR so a fixture git call never touches a decoy repo', () => {
  const before = readdirSync(join(decoy, '.git')).sort();
  const fixture = mkdtempSync(join(tmpdir(), 'fixture-'));
  try {
    const env = cleanGitEnv({ ...process.env, GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy });
    assert.equal(env.GIT_DIR, undefined);
    execFileSync('git', ['-C', fixture, 'init', '-q', '-b', 'main'], { env });
    execFileSync('git', ['-C', fixture, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'x'], { env });
    assert.deepEqual(readdirSync(join(decoy, '.git')).sort(), before);
    assert.match(execFileSync('git', ['-C', fixture, 'log', '--format=%s'], { env, encoding: 'utf8' }), /x/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});
