import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, newRootEntries } from './drive-root-guard.mjs';

const existing = new Set([
  'D:\\', 'C:\\', 'D:\\ReadTheStupidText', 'D:\\ReadTheStupidText-worktrees', 'D:\\AgentPipeline', 'C:\\Users',
]);
const exists = (p) => existing.has(p);
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const denied = (v) => v?.hookSpecificOutput?.permissionDecision === 'deny';
const run = (input, platform = 'win32') => decide(input, exists, platform);
const allDenied = (commands) => commands.forEach((c) => assert.ok(denied(run(bash(c))), `should deny: ${c}`));
const allPassed = (commands) => commands.forEach((c) => assert.equal(run(bash(c)), null, `should pass: ${c}`));

test('denies mkdir of a new drive-root folder (Windows and POSIX forms)', () => {
  allDenied(['mkdir -p D:\\scratch-mirror-hk1', 'mkdir -p /d/scratch-mirror-hk1/plan', 'New-Item -ItemType Directory "C:\\gs"']);
});

test('denies a Write of a new file or folder at a drive root', () => {
  assert.ok(denied(run({ tool_name: 'Write', tool_input: { file_path: 'D:\\notes.md' } })));
  assert.ok(denied(run({ tool_name: 'Write', tool_input: { file_path: 'D:/stage/x.md' } })));
});

test('Edit and NotebookEdit are no-ops (they change an existing file)', () => {
  assert.equal(run({ tool_name: 'Edit', tool_input: { file_path: 'D:\\notes.md' } }), null);
  assert.equal(run({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'D:\\n.ipynb' } }), null);
});

test('passes paths under an existing top-level folder', () => {
  allPassed(['mkdir -p D:\\ReadTheStupidText-worktrees\\fl\\x', 'cp a /d/ReadTheStupidText/tmp/b']);
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: 'C:\\Users\\a\\x.md' } }), null);
});

test('passes commands that only read drive-root paths', () => {
  allPassed(['ls /d/scratch-mirror-hk1', 'cat D:\\nothere.txt']);
});

test('newRootEntries ignores relative and URL-like paths', () => {
  assert.deepEqual(newRootEntries('mkdir out/d/x https://example.com/a', exists), []);
});

test('a redirect counts only when its target is a new drive-root path', () => {
  assert.ok(denied(run(bash('echo hi > /d/stray.txt'))));
  allPassed(['ls /d/missing 2>&1', 'echo hi > /d/ReadTheStupidText/x.txt']);
});

test('finding 1: wrapped and prefixed creators are denied', () => {
  allDenied([
    'powershell -NoProfile -Command "New-Item -ItemType Directory D:\\zz1"',
    'pwsh -c \'mkdir D:\\zz1\'',
    'cmd /c mkdir D:\\zz1',
    'bash -c "mkdir /d/zz1"',
    '$null = New-Item -ItemType Directory D:\\zz1',
    '   mkdir D:\\zz1',
    'FOO=1 mkdir /d/zz1',
    'echo ok && (mkdir /d/zz1)',
  ]);
});

test('finding 2: junction, symlink, move, clone, tee and download verbs are denied', () => {
  allDenied([
    'cmd /c mklink /J C:\\gs D:\\x',
    'ln -s /d/ReadTheStupidText /d/zz1',
    'mv a /d/zz1',
    'Move-Item a D:\\zz1',
    'git worktree add D:\\zz1',
    'git worktree add /d/zz1 -b x',
    'git clone https://x/y.git /d/zz1',
    'echo hi | tee /d/zz1/a.txt',
    'Add-Content D:\\zz1.txt hi',
    'curl -o /d/zz1.bin https://example.com/a',
    'rclone copy x D:\\zz1',
    'tar -C D:\\zz1 -xf a.tar',
  ]);
});

test('a new top-level name ending in -worktrees is allowed', () => {
  allPassed(['mkdir -p /d/NewRepo-worktrees/x', 'git worktree add D:\\Other-Worktrees\\s']);
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: 'D:\\New-worktrees\\a.md' } }), null);
});

test('finding 3: only the creator segment is scanned', () => {
  allPassed([
    'cp D:\\AgentPipeline\\a D:\\AgentPipeline\\b; Get-Content D:\\gone.txt',
    'mkdir /d/AgentPipeline/x && cat /d/typo.txt',
    'touch x; npm run build -- --prefix=D:\\foo',
    'mkdir out; ls /d/zz1',
    'git status; git worktree list /d/zz1',
  ]);
});

test('finding 4: quoted, heredoc and markdown ">" are not redirects', () => {
  allPassed([
    'echo "a > /d/zz1"',
    'gh pr create --body "see -> D:\\x and > D:\\x"',
    'git commit -F - <<\'EOF\'\nnotes > D:\\x\nmkdir /d/zz1\nEOF',
    'echo a -> D:\\x',
  ]);
  assert.ok(denied(run(bash('cat > "D:\\zz1.txt" <<EOF\nhi\nEOF'))));
});

test('finding 5: unexpanded variables and wildcards are skipped', () => {
  allPassed(['mkdir -p /d/$REPO-worktrees/slug', 'mkdir D:\\*', 'mkdir %TEMP%\\x', 'New-Item D:\\$env:X\\y', 'touch D:\\{a,b}']);
});

test('finding 6: dot segments are resolved and drive-relative paths count', () => {
  allDenied(['touch /d/AgentPipeline/../zz1', 'mkdir D:zz1', 'mkdir D:\\AgentPipeline\\..\\zz1']);
  allPassed(['mkdir D:\\zz1\\..\\AgentPipeline\\x', 'mkdir D:\\.']);
});

test('finding 7: the opt-out marker allows a deliberate new project folder', () => {
  allPassed(['mkdir -p /d/NewRepo-worktrees/x # drive-root-ok', 'mkdir D:\\NewRepo #drive-root-ok']);
  assert.match(run(bash('mkdir D:\\zz1')).hookSpecificOutput.permissionDecisionReason, /drive-root-ok/);
});

test('finding 8: nothing is denied off Windows', () => {
  assert.equal(run(bash('mkdir -p /a/b'), 'linux'), null);
  assert.equal(run(bash('mkdir D:\\zz1'), 'darwin'), null);
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: 'D:\\n.md' } }, 'linux'), null);
});

test('review 1: only the destination counts, never sources, URL query values or flag values', () => {
  allPassed([
    'curl -s -o out.txt "https://x.com/?p=/d/e/"',
    'robocopy src dst /E /XD /d/zz',
    'robocopy src dst /XF /d/zz /d/yy /E',
    'Set-Content -Path a.txt -Value "Note A:b"',
    'cp (Get-Item /d/Q/x) y',
    'mv /d/foo.txt ./',
    'cp /d/zz1/a D:\\AgentPipeline\\b',
  ]);
  allDenied(['robocopy src /d/zz1 /E', 'cp a b /d/zz1', 'Copy-Item -Destination D:\\zz1 -Path a', 'curl --output=/d/zz1 http://x']);
});

test('review 2: comments and here-string bodies are not scanned', () => {
  allPassed(['cp foo.txt bar.txt # moved from /d/old', 'tee out.txt <<< "see /d/foo"', 'mkdir x #D:\\zz1']);
  allDenied(['mkdir x # note\nmkdir /d/zz1', 'mkdir "/d/zz1" # ok']);
});

test('review 5: drive-relative text counts only when that drive exists', () => {
  allPassed(['Add-Content log.txt "A:ok"', 'New-Item -Value "B:c"', 'mkdir Q:zz1', 'mkdir Q:\\zz1', 'mkdir /q/zz1']);
});

test('review 4: maskQuotes stays fast on a long command with many quoted strings', () => {
  const body = Array.from({ length: 20000 }, (_, i) => `"line ${i}"`).join(' ');
  const started = Date.now();
  assert.equal(run(bash(`gh pr create --body ${body}`)), null);
  assert.ok(Date.now() - started < 2000);
});
