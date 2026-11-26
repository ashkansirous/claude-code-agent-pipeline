// node --test skills/feedback-loop/git-help-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide } from './git-help-guard.mjs';

const SCRIPT = fileURLToPath(new URL('./git-help-guard.mjs', import.meta.url));
const run = (command, tool = 'Bash') => decide({ tool_name: tool, tool_input: { command } });
const denied = (command, tool) => run(command, tool)?.hookSpecificOutput?.permissionDecision === 'deny';

test('git long help forms that open the browser are denied', () => {
  for (const command of [
    'git checkout --help', 'git checkout --help >/dev/null 2>&1', 'cd x && git checkout --help', 'git help checkout',
    'git help', 'git --help', 'git -C D:/repo log --help', 'git.exe worktree add --help', '/usr/bin/git rebase --help',
    'echo a; git status --help', 'git log --pretty=format:%h --help', 'GIT checkout --help',
  ]) {
    assert.ok(denied(command), command);
  }
  assert.ok(denied('git checkout --help', 'PowerShell'));
});

test('global options before the subcommand are skipped', () => {
  for (const command of [
    'git --no-pager help checkout', 'git --paginate help', 'git -p help log', 'git --git-dir=x help log',
    'git --git-dir=x checkout --help', 'git -C "D:/my repo" help x', "git -C 'D:/my repo' log --help",
    'git -c x=y help log', 'git -c x=y checkout --help', 'git --work-tree=w --namespace=n --bare help x',
    'git --git-dir x help y',
  ]) {
    assert.ok(denied(command), command);
  }
});

test('quoted and PowerShell call-operator forms are denied', () => {
  for (const command of [
    '& "C:\\Program Files\\Git\\cmd\\git.exe" help x', '"git" help', "& 'git' checkout --help", 'git "help" log',
    'git checkout "--help"', '& git help x', '"C:\\Program Files\\Git\\cmd\\git.exe" checkout --help',
  ]) {
    assert.ok(denied(command, 'PowerShell'), command);
  }
});

test('separators and subshells around the form are seen', () => {
  for (const command of ['git help|cat', 'git help;', '(git help)', 'git help && echo x', 'v=$(git help x)', '(git checkout --help)']) {
    assert.ok(denied(command), command);
  }
});

test('text that merely mentions the form passes: commit messages, PR bodies, heredocs, echo', () => {
  for (const command of [
    'git commit -m "docs: explain --help handling"', 'git commit -m "fix git checkout --help"',
    'git commit -m "x; git help checkout"', "git commit -m \"$(cat <<'EOF'\nfix: git checkout --help guard\nEOF\n)\"",
    'gh pr create --body "denies git log --help on windows"', 'echo git help', 'dotnet run --project git --help',
    'git log -1 # see --help', "cat <<'EOF'\ngit checkout --help\nEOF",
  ]) {
    assert.equal(run(command), null, command);
  }
});

test('whole-word --help only, and not past a standalone --', () => {
  for (const command of ['git status --help-me', 'git diff --help-x', 'git log --help-ish', 'git grep -- --help', 'git grep "--helper"', 'git log $(foo --help)']) {
    assert.equal(run(command), null, command);
  }
  assert.ok(denied('git grep --help foo'));
});

test('help forms that print in the terminal pass', () => {
  for (const command of ['git help -a', 'git help --all', 'git help -g', 'git help --guides', 'git help -c', 'git help --config', 'git --no-pager help -a']) {
    assert.equal(run(command), null, command);
  }
});

test('lines are not mixed together', () => {
  for (const command of ['git status\necho --help', 'git status\nfoo --help', 'git status\nnode tool.mjs --help']) {
    assert.equal(run(command), null, command);
  }
  assert.ok(denied('git status\ngit checkout --help'));
  assert.ok(denied('git log --format=%H \\\n  --help'));
});

test('ordinary git commands and the short -h form pass', () => {
  for (const command of [
    'git checkout -h', 'git status', 'git log --oneline -5', 'git commit -m "help the user"', 'git worktree add -b help/x ../w origin/main',
    'gh pr view --help', 'node script.mjs --help', 'echo git', 'dotnet test --help', 'git grep -n "--helper" origin/main',
    'git checkout help', 'git log help..main', 'git', 'git -C',
  ]) {
    assert.equal(run(command), null, command);
  }
  assert.equal(decide({}), null);
});

const hook = (stdin) => spawnSync(process.execPath, [SCRIPT], { input: stdin, encoding: 'utf8' });

test('as a hook: stdin JSON in, deny JSON out', () => {
  const result = hook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git checkout --help' } }));
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('as a hook: an allowed command prints nothing', () => {
  const result = hook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('as a hook: bad JSON fails open with a note on stderr', () => {
  const result = hook('not json');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /git-help-guard: let the call through/);
});
