// node --test skills/run-wave/primary-checkout-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decide } from './primary-checkout-guard.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pcg-'));
const run = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
const input = (command, cwd) => ({ tool_name: 'Bash', cwd, tool_input: { command } });
const denied = (verdict) => verdict?.hookSpecificOutput?.permissionDecision === 'deny';

function repo(withWorktree) {
  const root = path.join(tmp(), 'main-repo');
  fs.mkdirSync(root);
  run(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'x');
  const worktree = path.join(tmp(), 'wt');
  if (withWorktree) run(root, 'worktree', 'add', '-q', '-b', 'feat/x', worktree);
  return { root, worktree };
}

test('checkout, switch, reset, stash push, pull, restore and clean are denied in a primary checkout with worktrees', () => {
  const { root } = repo(true);
  for (const sub of ['checkout --detach', 'switch -c y', 'reset --hard', 'stash', 'stash push', 'pull', 'restore a.txt', 'clean -fd']) {
    assert.ok(denied(decide(input(`git ${sub}`, root))), sub);
  }
  assert.ok(denied(decide(input(`git -C ${root} checkout other`, os.tmpdir()))));
  assert.ok(denied(decide(input(`cd ${root} && git checkout --detach`, os.tmpdir()))));
});

test('a worktree created inside a primary checkout is denied; one next to it passes', () => {
  const { root } = repo(false);
  assert.ok(denied(decide(input(`git -C ${root} worktree add -b feat/y wt-y origin/main`, os.tmpdir()))));
  assert.ok(denied(decide(input('git worktree add sub/wt', root))));
  assert.ok(denied(decide(input(`git worktree add ${path.join(root, 'inner')}`, os.tmpdir()))));
  const next = path.join(path.dirname(root), 'main-repo-worktrees', 'y');
  assert.equal(decide(input(`git -C ${root} worktree add -b feat/y ${next} main`, os.tmpdir())), null);
  assert.equal(decide(input(`git -C ${root} worktree list`, os.tmpdir())), null);
});

test('git worktree add --orphan does not swallow the next word as a value', () => {
  const { root } = repo(false);
  const next = path.join(path.dirname(root), 'main-repo-worktrees', 'o');
  assert.equal(decide(input(`git -C ${root} worktree add --orphan -b nb ${next}`, os.tmpdir())), null);
});

test('worktrees, read-only git, stash list/show and a repo without worktrees are not touched', () => {
  const { root, worktree } = repo(true);
  assert.equal(decide(input('git checkout main', worktree)), null);
  assert.equal(decide(input(`git -C ${worktree} reset --hard`, root)), null);
  assert.equal(decide(input('git status', root)), null);
  assert.equal(decide(input('git diff HEAD', root)), null);
  assert.equal(decide(input('git show main:a.txt', root)), null);
  assert.equal(decide(input('git stash list', root)), null);
  assert.equal(decide(input('git stash show', root)), null);
  assert.equal(decide(input('git commit -m "git checkout x"', root)), null);
  assert.equal(decide(input('git checkout -b y', repo(false).root)), null);
});

test('pull --ff-only on main is allowed, on another branch or without --ff-only it is denied', () => {
  const { root } = repo(true);
  assert.equal(decide(input(`git -C ${root} pull --ff-only`, os.tmpdir())), null);
  assert.ok(denied(decide(input(`git -C ${root} pull`, os.tmpdir()))));
  run(root, 'checkout', '-q', '-b', 'other');
  assert.ok(denied(decide(input(`git -C ${root} pull --ff-only`, os.tmpdir()))));
});

test('redirections after an allowed pull do not count as a refspec', () => {
  const { root } = repo(true);
  for (const tail of ['2>&1', '2>&1 | tail -2', '> pull.log', '2>/dev/null', '>> log.txt 2>&1']) {
    assert.equal(decide(input(`git -C ${root} pull --ff-only origin main ${tail}`, os.tmpdir())), null, tail);
  }
  assert.ok(denied(decide(input(`git -C ${root} pull --ff-only origin feat/x 2>&1`, os.tmpdir()))));
  assert.ok(denied(decide(input(`git -C ${root} pull --ff-only > log origin feat/x`, os.tmpdir()))));
  assert.ok(denied(decide(input(`git -C ${root} pull --ff-only 2>&1 origin feat/x`, os.tmpdir()))));
  assert.ok(denied(decide(input(`git -C ${root} pull --ff-only *>&1 origin feat/x`, os.tmpdir()))));
  assert.ok(denied(decide(input(`git -C ${root} pull > --ff-only`, os.tmpdir()))));
  assert.equal(decide(input(`git -C ${root} pull --ff-only origin main &> pull.log`, os.tmpdir())), null);
  assert.equal(decide(input(`git -C ${root} pull --ff-only origin main *>&1`, os.tmpdir())), null);
  run(root, 'checkout', '-q', '-b', 'other');
  assert.equal(decide(input(`git -C ${root} checkout main 2>&1`, os.tmpdir())), null);
});

test('pull --ff-only on main is denied while the primary has uncommitted or untracked changes', () => {
  const { root } = repo(true);
  fs.writeFileSync(path.join(root, 'new.txt'), 'n');
  assert.ok(denied(decide(input(`git -C ${root} pull --ff-only`, os.tmpdir()))));
  fs.rmSync(path.join(root, 'new.txt'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed');
  assert.ok(denied(decide(input(`git -C ${root} pull --ff-only`, os.tmpdir()))));
});

test('pull --ff-only on main allows no refspec or exactly origin main, any other refspec is denied', () => {
  const { root } = repo(true);
  assert.equal(decide(input(`git -C ${root} pull --ff-only origin main`, os.tmpdir())), null);
  assert.ok(denied(decide(input(`git -C ${root} pull --ff-only origin feat/x`, os.tmpdir()))));
  assert.ok(denied(decide(input(`git -C ${root} pull --ff-only other main`, os.tmpdir()))));
  assert.ok(denied(decide(input(`git -C ${root} pull --ff-only origin`, os.tmpdir()))));
});

test('merge, rebase, cherry-pick, revert, am, commit --amend and branch -f are denied in a primary; plain commit and branch are not', () => {
  const { root, worktree } = repo(true);
  for (const sub of ['merge feat/x', 'rebase main', 'cherry-pick abc', 'revert abc', 'am x.patch', 'commit --amend -m x', 'branch -f main abc', 'branch --force main abc', 'branch -fd x']) {
    assert.ok(denied(decide(input(`git ${sub}`, root))), sub);
    assert.equal(decide(input(`git ${sub}`, worktree)), null, `${sub} in a worktree`);
  }
  assert.equal(decide(input('git commit -m x', root)), null);
  assert.equal(decide(input('git branch', root)), null);
  assert.equal(decide(input('git branch newone', root)), null);
});

test('other ways to aim at a primary checkout are caught', () => {
  const { root, worktree } = repo(true);
  const elsewhere = os.tmpdir();
  const forms = [
    `Push-Location ${root}; git checkout x`,
    `Set-Location -Path ${root}; git checkout x`,
    `Set-Location -LiteralPath ${root}\ngit reset --hard`,
    `cd /d ${root} && git checkout x`,
    `(cd ${root} && git checkout x)`,
    `pushd ${root} && git clean -fd`,
    `git --git-dir=${root}/.git checkout x`,
    `git --git-dir ${root}/.git checkout x`,
    `git --work-tree=${root} checkout x`,
    `GIT_DIR=${root}/.git git checkout x`,
    `FOO=1 BAR=2 git -C ${root} checkout x`,
    `env GIT_WORK_TREE=${root} git reset --hard`,
  ];
  for (const form of forms) assert.ok(denied(decide(input(form, elsewhere))), form);
  assert.equal(decide(input(`(cd ${root} && git status); git checkout x`, worktree)), null);
  assert.equal(decide(input(`Push-Location ${worktree}; git checkout x`, root)), null);
});

test('heredoc and here-string bodies are text, not commands', () => {
  const { root } = repo(true);
  const heredoc = `git commit -F - <<'EOF'\ngit checkout is forbidden\ngit reset --hard\nEOF`;
  assert.equal(decide(input(heredoc, root)), null);
  const hereString = `git commit -m @'\ngit checkout x\n'@`;
  assert.equal(decide(input(hereString, root)), null);
  assert.ok(denied(decide(input(`cat <<EOF\nbody\nEOF\ngit checkout x`, root))));
  assert.ok(denied(decide(input('echo a << b\ngit checkout x', root))));
});

test('checkout main and switch main repair a primary left off the trunk; other targets stay denied', () => {
  const { root } = repo(true);
  run(root, 'checkout', '-q', '--detach');
  assert.equal(decide(input(`git -C ${root} checkout main`, os.tmpdir())), null);
  assert.equal(decide(input('git switch main', root)), null);
  assert.ok(denied(decide(input('git checkout main -- a.txt', root))));
  assert.ok(denied(decide(input('git checkout other', root))));
  assert.ok(denied(decide(input('git switch -c main', root))));
});

test('other tools and a non-repo directory pass; an unreadable dir fails open', () => {
  assert.equal(decide({ tool_name: 'Read', tool_input: {} }), null);
  assert.equal(decide(input('git checkout x', tmp())), null);
  assert.equal(decide(input('git checkout x', path.join(tmp(), 'missing'))), null);
});

test('dotnet build-server shutdown is refused in any directory, other dotnet build-server calls pass', () => {
  assert.ok(denied(decide(input('dotnet build-server shutdown', os.tmpdir()))));
  assert.ok(denied(decide(input('cd /tmp && dotnet.exe build-server shutdown --vbcscompiler', os.tmpdir()))));
  assert.equal(decide(input('dotnet build --disable-build-servers', os.tmpdir())), null);
  assert.equal(decide(input('git commit -m "never run dotnet build-server shutdown"', os.tmpdir())), null);
});

// A backslash is a path separator only on Windows; on Linux the path names a different, nonexistent folder.
test('a Windows backslash path to the primary checkout is judged as that path', { skip: process.platform !== 'win32' }, () => {
  const { root } = repo(true);
  const winRoot = root.replace(/\//g, '\\');
  assert.ok(denied(decide(input('git -C ' + winRoot + ' merge x', os.tmpdir()))));
  assert.ok(denied(decide(input('git -C "' + winRoot + '" merge x', os.tmpdir()))));
  assert.ok(denied(decide(input('cd ' + winRoot + ' && git merge x', os.tmpdir()))));
});

// The discard rule is advisory (two strikes): it warns with additionalContext and never carries a permissionDecision.
const warned = (verdict) => verdict?.hookSpecificOutput?.permissionDecision === undefined && /discard guard/.test(verdict?.hookSpecificOutput?.additionalContext ?? '');

test('Slice 315: a restore with an explicit source warns only when the file has uncommitted changes', () => {
  const { worktree } = repo(true);
  const sourced = ['checkout origin/main -- a.txt', 'checkout HEAD -- a.txt', 'restore --source=HEAD a.txt', 'restore -s HEAD a.txt', 'restore --source HEAD --worktree a.txt'];
  for (const sub of sourced) assert.equal(decide(input(`git ${sub}`, worktree)), null, `clean: ${sub}`);
  fs.writeFileSync(path.join(worktree, 'a.txt'), 'edited');
  for (const sub of sourced) {
    const verdict = decide(input(`git ${sub}`, worktree));
    assert.ok(warned(verdict), sub);
    assert.match(verdict.hookSpecificOutput.additionalContext, /explicit source overwrites uncommitted changes in a\.txt/);
  }
  assert.ok(warned(decide(input(`git -C ${worktree} checkout origin/main -- a.txt`, os.tmpdir()))));
  // Finding 9: no `--` between the source and the path still warns; a single word (a branch) does not.
  assert.ok(warned(decide(input('git checkout HEAD a.txt', worktree))));
  assert.equal(decide(input('git checkout HEAD other.txt', worktree)), null);
  for (const sub of ['checkout --theirs -- a.txt', 'restore -p -s HEAD a.txt', 'restore --staged --source=HEAD a.txt', 'checkout origin/main -- other.txt']) {
    assert.equal(decide(input(`git ${sub}`, worktree)), null, sub);
  }
});

test('Slice 307: a primary-checkout deny still wins when the same command also has a discard', () => {
  const { root, worktree } = repo(true);
  const verdict = decide(input(`git -C ${worktree} restore a.txt && git -C ${root} merge x`, os.tmpdir()));
  assert.ok(denied(verdict));
  assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /primary checkout guard/);
});

test('Slice 307: git checkout -- <path> and git restore <path> only warn in a worktree; unstaging passes', () => {
  const { worktree } = repo(true);
  for (const sub of ['checkout -- a.txt', 'checkout -f -- a.txt', 'restore a.txt', 'restore --worktree a.txt', 'restore --staged --worktree a.txt']) {
    assert.ok(warned(decide(input(`git ${sub}`, worktree))), sub);
  }
  assert.ok(warned(decide(input(`git -C ${worktree} checkout -- a.txt`, os.tmpdir()))));
  assert.equal(decide(input(`git -C ${worktree} checkout HEAD -- plan.md`, os.tmpdir())), null);
  for (const sub of ['restore -SW a.txt', 'restore -WS a.txt']) assert.ok(warned(decide(input(`git ${sub}`, worktree))), sub);
  for (const sub of ['restore -Ss HEAD a.txt', 'restore -sS HEAD a.txt', 'restore -p a.txt', 'restore -pS a.txt', 'checkout -fp -- a.txt', 'restore -S a.txt']) {
    assert.equal(decide(input(`git ${sub}`, worktree)), null, sub);
  }
  for (const sub of ['checkout HEAD -- a.txt', 'checkout origin/main -- a.txt', 'checkout --theirs -- a.txt', 'restore --source=HEAD~1 a.txt', 'restore -s HEAD a.txt', 'restore -S a.txt', 'restore --staged a.txt', 'status', 'checkout -b feat/z', 'show HEAD:a.txt', 'diff -- a.txt']) {
    assert.equal(decide(input(`git ${sub}`, worktree)), null, sub);
  }
});
