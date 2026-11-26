import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { worktreePath, codeCommand, parseArgs, uniqueSlug } from './paste-worktree.mjs';

const SCRIPT = join(import.meta.dirname, 'paste-worktree.mjs');

test('the worktree is the sibling <repo>-worktrees folder, never the repo itself', () => {
  assert.equal(worktreePath('D:/AgentPipeline', 'paste'), 'D:/AgentPipeline-worktrees/paste');
  assert.equal(worktreePath('D:\\AgentPipeline', 'p1'), 'D:/AgentPipeline-worktrees/p1');
});

test('the code command opens the worktree copy at the line, with forward slashes', () => {
  assert.equal(codeCommand('D:/AgentPipeline-worktrees/paste', 'config\\settings.json', '42'), 'code -g D:/AgentPipeline-worktrees/paste/config/settings.json:42');
});

test('arguments need a repo, a file, a numeric line and a safe slug', () => {
  assert.ok(parseArgs(['D:/R', 'config/settings.json', '5']));
  assert.equal(parseArgs(['D:/R', 'f', 'x']), null);
  assert.equal(parseArgs(['D:/R', 'f', '5', '--slug', '../x']), null);
  assert.equal(parseArgs(['D:/R']), null);
});

test('review finding 7: each paste gets its own slug unless one is given', () => {
  const a = parseArgs(['D:/R', 'f', '5']).slug;
  assert.match(a, /^paste-\d{8}-\d{6}$/);
  assert.notEqual(uniqueSlug(new Date('2026-11-18T10:00:00Z')), uniqueSlug(new Date('2026-11-18T10:00:01Z')));
  assert.equal(parseArgs(['D:/R', 'f', '5', '--slug', 'mine']).slug, 'mine');
});

test('a dry run on a missing worktree prints what it would do and the command, and creates nothing', () => {
  const run = spawnSync(process.execPath, [SCRIPT, 'D:/NoSuchRepo-393', 'config/settings.json', '7', '--slug', 'dry393', '--dry-run'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /would run: git -C D:\/NoSuchRepo-393 fetch origin/);
  assert.match(run.stdout, /code -g D:\/NoSuchRepo-393-worktrees\/dry393\/config\/settings\.json:7/);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
});
