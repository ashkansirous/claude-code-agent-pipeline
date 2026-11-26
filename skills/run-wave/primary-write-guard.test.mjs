// node --test skills/run-wave/primary-write-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, primaryWithWorktrees } from './primary-write-guard.mjs';

const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path } });

test('a write into a primary with worktrees asks; other writes pass', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pwg-')));
  try {
    const primary = join(root, 'repo');
    const linked = join(root, 'repo-worktrees', 'slice');
    mkdirSync(linked, { recursive: true });
    mkdirSync(join(primary, '.git', 'worktrees', 'slice'), { recursive: true });
    writeFileSync(join(primary, '.git', 'worktrees', 'slice', 'gitdir'), join(linked, '.git') + '\n');
    mkdirSync(join(primary, 'src'));
    const lone = join(root, 'lone');
    mkdirSync(join(lone, '.git'), { recursive: true });
    writeFileSync(join(linked, '.git'), 'gitdir: x/.git/worktrees/slice\n');

    assert.equal(decide(write(join(primary, 'src', 'a.cs'))).hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(decide(write(join(primary, '.git', 'info', 'exclude'))), null);
    assert.equal(decide(write(join(lone, 'a.md'))), null);
    assert.equal(decide(write(join(linked, 'a.cs'))), null);
    assert.equal(decide(write(join(root, 'scratch.txt'))), null);
    assert.equal(primaryWithWorktrees(join(primary, 'src', 'new', 'b.cs')), primary);
    assert.equal(decide({}), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stale worktree entry (its folder is gone) does not make a primary', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pwg-')));
  try {
    const stale = join(root, 'stale');
    mkdirSync(join(stale, '.git', 'worktrees', 'gone'), { recursive: true });
    writeFileSync(join(stale, '.git', 'worktrees', 'gone', 'gitdir'), join(root, 'missing', '.git') + '\n');
    assert.equal(decide(write(join(stale, 'a.md'))), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a write through a symlink into a primary is judged by its real location', (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pwg-')));
  try {
    const primary = join(root, 'repo');
    const linked = join(root, 'wt');
    mkdirSync(linked);
    writeFileSync(join(linked, '.git'), 'gitdir: x\n');
    mkdirSync(join(primary, '.git', 'worktrees', 'slice'), { recursive: true });
    writeFileSync(join(primary, '.git', 'worktrees', 'slice', 'gitdir'), join(linked, '.git') + '\n');
    try {
      symlinkSync(primary, join(root, 'link'), 'junction');
    } catch (error) {
      t.skip(`cannot create a link: ${error.message}`);
      return;
    }
    assert.equal(decide(write(join(root, 'link', 'new', 'a.md'))).hookSpecificOutput.permissionDecision, 'ask');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
