// node --test skills/run-all-waves/start-detached.test.mjs (Windows only: it uses WMI)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnAsync } from '../../tests/support/spawn-async.mjs';

const SCRIPT = fileURLToPath(new URL('./start-detached.ps1', import.meta.url));
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
const WAIT_ATTEMPTS = 50;
const WAIT_MS = 200;
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isAlive = pid => spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).stdout.includes(` ${pid} `);
// Kill the started tree and wait until it has exited, so its cwd (inside the temp repo) no longer locks the folder.
function stopTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
  for (let i = 0; i < WAIT_ATTEMPTS && isAlive(pid); i++) sleep(WAIT_MS);
}
const pwsh = args => spawnSync('pwsh', ['-NoProfile', ...args], { encoding: 'utf8' });
// Slice 30 item K: every launch waits 5 s inside start-detached.ps1 (it counts console windows before and after), so the launch tests run
// side by side; this is the asynchronous twin of pwsh, with the same result fields.
const pwshAsync = args => spawnAsync('pwsh', ['-NoProfile', ...args]);
const parsePid = stdout => Number(/started pid (\d+)/.exec(stdout)?.[1]) || undefined;
const output = started => `stdout: ${started.stdout}\nstderr: ${started.stderr}`;
// Cleanup runs even when the test failed; a cleanup error is thrown only when the test body passed, so it never hides the real failure.
function cleanup(bodyFailed, pid, folders) {
  try {
    stopTree(pid);
    for (const folder of folders) fs.rmSync(folder, REMOVE_OPTIONS);
  } catch (error) {
    if (!bodyFailed) throw error;
    console.error(`cleanup failed: ${error.message}`);
  }
}

// None of these launch tests looks at the console-window warning, so they overlap (4 at a time); the test that does (the real children,
// below) runs on its own after them, so no other launch can open a window while it counts.
describe('launches', { concurrency: 4 }, () => {
test('the launch records the newest transcript of the repo project folder as the starter session', { skip: process.platform !== 'win32' }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'detached-starter-'));
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'detached-projects-'));
  const runDir = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`);
  const folder = path.join(projects, fs.realpathSync.native(repo).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'older-session.jsonl'), '');
  fs.utimesSync(path.join(folder, 'older-session.jsonl'), new Date(Date.now() - 3600000), new Date(Date.now() - 3600000));
  fs.writeFileSync(path.join(folder, 'launching-session.jsonl'), '');
  let pid;
  let bodyFailed = true;
  try {
    const started = await pwshAsync(['-File', SCRIPT, '-Repo', repo, '-ProjectsDir', projects, '-Command', 'cmd.exe /c ping -n 20 127.0.0.1 > nul']);
    pid = parsePid(started.stdout);
    assert.equal(started.status, 0, output(started));
    assert.match(started.stdout, /starter session launching-session/, output(started));
    bodyFailed = false;
  } finally {
    cleanup(bodyFailed, pid, [repo, projects, runDir]);
  }
});

function starterFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'detached-starter-'));
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'detached-projects-'));
  const runDir = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`);
  const folder = path.join(projects, fs.realpathSync.native(repo).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  const old = new Date(Date.now() - 3600000);
  fs.writeFileSync(path.join(folder, 'real-session.jsonl'), '{"entrypoint":"cli"}\n');
  fs.utimesSync(path.join(folder, 'real-session.jsonl'), old, old);
  fs.writeFileSync(path.join(folder, 'probe-session.jsonl'), '{"type":"x","entrypoint":"sdk-cli"}\n');
  return { repo, projects, runDir };
}

async function startWith(extraArgs) {
  const { repo, projects, runDir } = starterFixture();
  let pid;
  let bodyFailed = true;
  try {
    const started = await pwshAsync(['-File', SCRIPT, '-Repo', repo, '-ProjectsDir', projects, ...extraArgs, '-Command', 'cmd.exe /c ping -n 20 127.0.0.1 > nul']);
    pid = parsePid(started.stdout);
    assert.equal(started.status, 0, output(started));
    bodyFailed = false;
    return started;
  } finally {
    cleanup(bodyFailed, pid, [repo, projects, runDir]);
  }
}

test('a newer probe record does not replace the starter id that was given', { skip: process.platform !== 'win32' }, async () => {
  const started = await startWith(['-StarterSessionId', 'given-session']);
  assert.match(started.stdout, /starter session given-session/, output(started));
});

test('a starter id that is not a session id (bash-mangled or with a space) is ignored and the folder scan is used', { skip: process.platform !== 'win32' }, async () => {
  const started = await startWith(['-StarterSessionId', ':CLAUDE_CODE_SESSION_ID']);
  assert.match(started.stdout, /starter session real-session/, output(started));
});

test('without an id given, a newer claude -p record is skipped', { skip: process.platform !== 'win32' }, async () => {
  const started = await startWith([]);
  assert.match(started.stdout, /starter session real-session/, output(started));
});

test('the started process is not a child of the caller, so killing the caller leaves it running', { skip: process.platform !== 'win32' }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'detached-repo-'));
  const runDir = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`);
  let pid;
  let bodyFailed = true;
  try {
    const started = await pwshAsync(['-File', SCRIPT, '-Repo', repo, '-Command', 'cmd.exe /c ping -n 20 127.0.0.1 > nul']);
    pid = parsePid(started.stdout);
    assert.equal(started.status, 0, output(started));
    assert.ok(pid, output(started));
    const parent = pwsh(['-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`]);
    const parentName = pwsh(['-Command', `(Get-Process -Id ${parent.stdout.trim()}).ProcessName`]).stdout.trim();
    assert.match(parentName, /^WmiPrvSE$/i);
    bodyFailed = false;
  } finally {
    cleanup(bodyFailed, pid, [repo, runDir]);
  }
});
});

test('the Create call carries startup information with ShowWindow 0 so the console stays hidden', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /New-CimInstance -ClassName Win32_ProcessStartup[^\r\n]*ShowWindow = \[uint16\]0/);
  assert.match(source, /ProcessStartupInformation = New-CimInstance/);
});

test('a failing New-CimInstance falls back to a normal start with a warning, and the launch counts console windows', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /catch \{\s*Write-Warning "could not build the hidden start information/);
  assert.match(source, /\$windowsAfter -gt \$windowsBefore\) \{ Write-Warning "a console window appeared/);
});

// Slice 17 part F: children of the hidden start really run (the source-text test above cannot show that).
test('the hidden start runs real cmd, node and git children to completion and opens no new console window', { skip: process.platform !== 'win32' }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'detached-children-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'detached-work-'));
  const runDir = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`);
  const markers = { cmd: path.join(work, 'cmd.txt'), node: path.join(work, 'node.txt'), git: path.join(work, 'git.txt') };
  const child = path.join(work, 'child.js');
  fs.writeFileSync(child, `require('node:fs').writeFileSync(${JSON.stringify(markers.node)}, 'ran');\n`);
  const batch = path.join(work, 'children.cmd');
  fs.writeFileSync(batch, [
    '@echo off',
    `echo ran> "${markers.cmd}"`,
    `"${process.execPath}" "${child}"`,
    `git --version > "${markers.git}"`,
    'ping -n 20 127.0.0.1 > nul',
    '',
  ].join('\r\n'));
  let pid;
  let bodyFailed = true;
  try {
    const started = pwsh(['-File', SCRIPT, '-Repo', repo, '-Command', `cmd.exe /c "${batch}"`]);
    pid = parsePid(started.stdout);
    assert.equal(started.status, 0, output(started));
    for (let i = 0; i < WAIT_ATTEMPTS && !Object.values(markers).every((file) => fs.existsSync(file)); i++) sleep(WAIT_MS);
    for (const [name, file] of Object.entries(markers)) assert.ok(fs.existsSync(file), `${name} child did not run: ${output(started)}`);
    assert.match(fs.readFileSync(markers.git, 'utf8'), /git version/);
    assert.doesNotMatch(`${started.stdout}${started.stderr}`, /a console window appeared/, 'a console window opened');
    bodyFailed = false;
  } finally {
    cleanup(bodyFailed, pid, [repo, work, runDir]);
  }
});
