// node --test skills/run-wave/released-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parentLabel, liveSleeps, isSleep, namesFolder, leftRunning, namedNotCounted, selfAndParents, shorten, noneLeftMessage } from './released-check.mjs';

const WORKTREE = 'D:/AgentPipeline-worktrees/s09';
const list = [
  { pid: 10, parent: 1, name: 'bash.exe', commandLine: 'bash -c "cd D:\\AgentPipeline-worktrees\\s09 && tail -f log"' },
  { pid: 11, parent: 1, name: 'node.exe', commandLine: 'node D:/AgentPipeline-worktrees/s09/watch.mjs' },
  { pid: 12, parent: 1, name: 'node.exe', commandLine: 'node D:/AgentPipeline-worktrees/s09-other/watch.mjs' },
  { pid: 13, parent: 1, name: 'pwsh.exe', commandLine: 'pwsh -File d:\\agentpipeline-worktrees\\S09\\x.ps1' },
  { pid: 14, parent: 1, name: 'node.exe', commandLine: null },
  { pid: 15, parent: 1, name: 'node.exe', commandLine: 'node D:/AgentPipeline-worktrees/s10/a.mjs' },
];

test('a command line naming the worktree matches, in either slash direction and any case', () => {
  assert.equal(namesFolder(list[0].commandLine, WORKTREE), true);
  assert.equal(namesFolder(list[1].commandLine, WORKTREE), true);
  assert.equal(namesFolder(list[3].commandLine, WORKTREE), true);
});

test('a sibling folder with the same prefix, an empty command line and another worktree do not match', () => {
  assert.equal(namesFolder(list[2].commandLine, WORKTREE), false);
  assert.equal(namesFolder(list[4].commandLine, WORKTREE), false);
  assert.equal(namesFolder(list[5].commandLine, WORKTREE), false);
});

test('leftRunning lists the live holders from a fake process list and skips the ignored pids', () => {
  assert.deepEqual(leftRunning(WORKTREE, list).map((p) => p.pid), [10, 11, 13]);
  assert.deepEqual(leftRunning(WORKTREE, list, [10, 13]).map((p) => p.pid), [11]);
});

test('an empty result means nothing is left', () => {
  assert.deepEqual(leftRunning('D:/AgentPipeline-worktrees/s99', list), []);
});

test('finding 1: the MSYS form /d/... matches, in any case, and an MSYS argument is not resolved against the cwd', () => {
  assert.equal(namesFolder('bash -c "cd /d/AgentPipeline-worktrees/s09 && tail -f x"', WORKTREE), true);
  assert.equal(namesFolder('node /D/AGENTPIPELINE-WORKTREES/S09/w.mjs', WORKTREE), true);
  assert.equal(namesFolder('node /d/AgentPipeline-worktrees/s09-other/w.mjs', WORKTREE), false);
  assert.equal(namesFolder('node D:\\AgentPipeline-worktrees\\s09\\w.mjs', '/d/AgentPipeline-worktrees/s09'), true);
  assert.equal(namesFolder('node /d/AgentPipeline-worktrees/s09/w.mjs', '/d/agentpipeline-worktrees/s09/'), true);
});

test('finding 2: a claude session or an editor that names the path is named, not counted', () => {
  const procs = [
    { pid: 20, parent: 1, name: 'claude.exe', commandLine: 'claude -p "work in D:/AgentPipeline-worktrees/s09"' },
    { pid: 21, parent: 1, name: 'Code.exe', commandLine: 'Code.exe -g D:/AgentPipeline-worktrees/s09/a.md' },
    { pid: 22, parent: 1, name: 'node.exe', commandLine: 'node D:/AgentPipeline-worktrees/s09/watch.mjs' },
  ];
  assert.deepEqual(leftRunning(WORKTREE, procs).map((p) => p.pid), [22]);
  assert.deepEqual(namedNotCounted(WORKTREE, procs).map((p) => p.pid), [20, 21]);
  assert.equal(leftRunning(WORKTREE, procs.slice(0, 2)).length, 0);
});

test('selfAndParents returns the process and its ancestors', () => {
  const tree = [{ pid: 1, parent: 0 }, { pid: 2, parent: 1 }, { pid: 3, parent: 2 }];
  assert.deepEqual(selfAndParents(tree, 3), [3, 2, 1]);
});

test('review 4: doubled or JSON-escaped backslashes still match the folder', () => {
  assert.equal(namesFolder('node D:\\AgentPipeline-worktrees\\s09\\w.mjs', WORKTREE), true);
  assert.equal(namesFolder('node D://AgentPipeline-worktrees//s09/w.mjs', WORKTREE), true);
});

test('review 6: the match ends at a path boundary and starts at a path start', () => {
  assert.equal(namesFolder('node D:/AgentPipeline-worktrees/s091/w.mjs', WORKTREE), false);
  assert.equal(namesFolder('node D:/AgentPipeline-worktrees/s09', WORKTREE), true);
  assert.equal(namesFolder('node "D:/AgentPipeline-worktrees/s09"', WORKTREE), true);
  assert.equal(namesFolder('node c:/other/d/agentpipeline-worktrees/s09/w.mjs', WORKTREE), false);
  assert.equal(namesFolder('node xd:/agentpipeline-worktrees/s09/w.mjs', WORKTREE), false);
});

test('review 5: the last line never says no process names it when a named one was printed', () => {
  assert.match(noneLeftMessage(WORKTREE, 2), /none counted; 2 named/);
  assert.doesNotMatch(noneLeftMessage(WORKTREE, 2), /no live process/);
  assert.match(noneLeftMessage(WORKTREE, 0), /no live process names/);
});

test('review 4: with no cwd, a sleep counts only when its own or an ancestor command line names the worktree', () => {
  const wt = 'D:/AgentPipeline-worktrees/s09';
  const procs = [
    { pid: 1, parent: 0, name: 'pwsh', commandLine: `pwsh -Command cd ${wt}` },
    { pid: 2, parent: 1, name: 'bash', commandLine: 'bash' },
    { pid: 20, parent: 2, name: 'sleep', commandLine: 'sleep 95' },
    { pid: 30, parent: 0, name: 'sleep', commandLine: 'sleep 600' },
    { pid: 31, parent: 0, name: 'sleep', commandLine: `sleep 5 ${wt}` },
  ];
  const { counted, unknown } = liveSleeps(wt, procs, [], () => null);
  assert.deepEqual(counted.map((p) => p.pid), [20, 31]);
  assert.deepEqual(unknown.map((p) => p.pid), [30]);
});

test('review 2: a non-shell ancestor naming the worktree (claude --add-dir) never ties a sleep to it', () => {
  const wt = 'D:/AgentPipeline-worktrees/s09';
  const procs = [
    { pid: 1, parent: 0, name: 'claude.exe', commandLine: `claude -p --add-dir ${wt}` },
    { pid: 2, parent: 1, name: 'bash', commandLine: 'bash' },
    { pid: 20, parent: 2, name: 'sleep', commandLine: 'sleep 600' },
    { pid: 3, parent: 0, name: 'bash', commandLine: `bash -c "cd ${wt}"` },
    { pid: 21, parent: 3, name: 'sleep', commandLine: 'sleep 95' },
  ];
  const { counted, unknown } = liveSleeps(wt, procs, [], () => null);
  assert.deepEqual(counted.map((p) => p.pid), [21]);
  assert.deepEqual(unknown.map((p) => p.pid), [20]);
});

test('review medium #3: a shell running a script file inside the worktree ties a sleep to it; an interactive one does not', () => {
  const wt = 'D:/AgentPipeline-worktrees/s09';
  const procs = [
    { pid: 1, parent: 0, name: 'pwsh', commandLine: `pwsh -NoProfile -File ${wt}/run.ps1` },
    { pid: 20, parent: 1, name: 'sleep', commandLine: 'sleep 95' },
    { pid: 2, parent: 0, name: 'bash', commandLine: `bash ${wt}/run.sh` },
    { pid: 21, parent: 2, name: 'sleep', commandLine: 'sleep 95' },
    { pid: 3, parent: 0, name: 'pwsh', commandLine: 'pwsh -NoLogo' },
    { pid: 22, parent: 3, name: 'sleep', commandLine: 'sleep 95' },
  ];
  const { counted, unknown } = liveSleeps(wt, procs, [], () => null);
  assert.deepEqual(counted.map((p) => p.pid), [20, 21]);
  assert.deepEqual(unknown.map((p) => p.pid), [22]);
});

test('review 3: only a real sleep process counts as a sleep', () => {
  assert.equal(isSleep({ name: 'sleep.exe', commandLine: 'sleep 5' }), true);
  assert.equal(isSleep({ name: 'bash', commandLine: 'bash -c "sleep 600"' }), true);
  assert.equal(isSleep({ name: 'pwsh', commandLine: 'pwsh -NoProfile -Command Start-Sleep -Seconds 95' }), true);
  assert.equal(isSleep({ name: 'pwsh', commandLine: 'pwsh -File poll.ps1 # Start-Sleep 5' }), false);
  assert.equal(isSleep({ name: 'pwsh', commandLine: 'pwsh -Command "while ($true) { Start-Sleep 5; poll }"' }), false);
  assert.equal(isSleep({ name: 'node', commandLine: 'node sleep 5' }), false);
});

test('review 3: isEntryPoint follows symlinks, so a skills/ link to the repo still runs main', async () => {
  const { isEntryPoint } = await import('./released-check.mjs');
  const real = fileURLToPath(new URL('./released-check.mjs', import.meta.url));
  assert.equal(isEntryPoint(real, new URL('./released-check.mjs', import.meta.url).href), true);
  assert.equal(isEntryPoint(`${real}.other`, new URL('./released-check.mjs', import.meta.url).href), false);
  assert.equal(isEntryPoint(undefined, import.meta.url), false);
});

test('review 5: an unknown-folder sleep keeps the last line from saying no process names the worktree', () => {
  assert.match(noneLeftMessage('/w', 0 + 1), /none counted/);
});

test('review 7: a long command line is cut to about 200 characters', () => {
  const cut = shorten(`claude -p "${'x'.repeat(5000)}"`);
  assert.ok(cut.length < 260);
  assert.equal(shorten('short'), 'short');
});

test('Slice 18: a live sleep whose folder is the worktree counts; an unknown folder is only listed', () => {
  const procs = [
    { pid: 20, parent: 1, name: 'sleep', commandLine: 'sleep 95' },
    { pid: 21, parent: 1, name: 'sleep', commandLine: 'sleep 600' },
    { pid: 22, parent: 1, name: 'sleep', commandLine: 'sleep 30' },
    { pid: 23, parent: 1, name: 'node', commandLine: 'node sleeper.mjs' },
  ];
  const cwds = { 20: '/d/AgentPipeline-worktrees/s09/src', 21: '/d/other', 22: null };
  const { counted, unknown } = liveSleeps('/d/AgentPipeline-worktrees/s09', procs, [], (pid) => cwds[pid]);
  assert.deepEqual(counted.map((p) => p.pid), [20]);
  assert.deepEqual(unknown.map((p) => p.pid), [22]);
  assert.equal(isSleep(procs[3]), false);
  assert.equal(isSleep({ name: 'pwsh.exe', commandLine: 'pwsh -Command Start-Sleep -Seconds 95' }), true);
});

test('Slice 23 item 2: a bare call prints usage and exits 2, never 0', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./released-check.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage/);
});

test('Slice 23 item 2: a live sleep is named by its parent session', () => {
  const procs = [{ pid: 5, parent: 4, name: 'sleep', commandLine: 'sleep 9' }, { pid: 4, parent: 1, name: 'C:\\x\\claude.exe', commandLine: 'claude' }];
  assert.equal(parentLabel(procs, 5), 'parent 4 claude.exe');
  assert.equal(parentLabel(procs, 4), 'parent unknown');
});

test('Slice 23 item 6: a sleep under a user terminal that names the worktree is not counted; under a `bash -c` it is', () => {
  const wt = 'D:/AgentPipeline-worktrees/s09';
  const mk = (shellLine) => [
    { pid: 1, parent: 0, name: 'bash.exe', commandLine: shellLine },
    { pid: 2, parent: 1, name: 'sleep.exe', commandLine: 'sleep 600' },
  ];
  const none = () => null;
  assert.deepEqual(liveSleeps(wt, mk('C:/Git/bin/bash.exe --login -i D:/AgentPipeline-worktrees/s09'), [], none).counted, []);
  assert.deepEqual(liveSleeps(wt, mk('bash -c "cd D:/AgentPipeline-worktrees/s09 && sleep 600"'), [], none).counted.map((p) => p.pid), [2]);
  for (const line of ['bash -ic "cd D:/AgentPipeline-worktrees/s09 && sleep 600"', 'bash -li -c "cd D:/AgentPipeline-worktrees/s09"', 'bash -lc "cd D:/AgentPipeline-worktrees/s09"', 'pwsh -NoExit -Command cd D:/AgentPipeline-worktrees/s09']) {
    assert.deepEqual(liveSleeps(wt, mk(line), [], none).counted, [], line);
  }
});
