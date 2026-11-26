// Tests for the SessionStart sync hook (Slice 16 part D): the gate, the off switch and the detached start.
// Nothing here starts a real run or touches the network: the spawn function is a stub.
// Run: node --test skills/run-wave/session-sync.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { RETRY_GAP_MS, SYNC_GAP_MS, requestSync, runSync } from './session-sync.mjs';

const roots = [];
let root;
let started;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-sync-'));
  roots.push(root);
  started = [];
});

after(() => {
  for (const folder of roots) rmSync(folder, { recursive: true, force: true });
});

const env = () => ({ AGENT_BOARD_SESSION_ROOT: root });
const stubs = (extra = {}) => ({
  now: 10 * SYNC_GAP_MS,
  spawnFn: (command, args) => { started.push(args); return { unref() {}, on() {} }; },
  repoFn: () => 'D:/repo',
  projectFn: () => 'demo-app',
  ...extra,
});

function fakePlugin() {
  const configDir = mkdtempSync(join(tmpdir(), 'session-sync-config-'));
  const plugin = join(configDir, 'plugins', 'cache', 'agent-board');
  roots.push(configDir);
  mkdirSync(join(plugin, 'scripts'), { recursive: true });
  writeFileSync(join(plugin, 'scripts', 'sync-docs.mjs'), 'export async function main() { return { synced: true }; }\n');
  writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'agent-board@agent-progress-board': [{ scope: 'user', installPath: plugin }] } }));
  return { configDir, plugin };
}

describe('requestSync', () => {
  test('starts a detached run and writes no gate itself: a run that fails leaves the next session free to retry (finding 7)', () => {
    const first = requestSync({ cwd: 'D:/repo' }, env(), stubs());
    assert.deepEqual(first, { started: true, project: 'demo-app' });
    assert.deepEqual(started[0].slice(1), ['--run', 'D:/repo', 'demo-app']);
    assert.equal(existsSync(join(root, 'sync-demo-app.gate')), false);
    assert.equal(requestSync({ cwd: 'D:/repo' }, env(), stubs()).started, true);
  });

  test('a gate written by a successful run holds for an hour', () => {
    writeFileSync(join(root, 'sync-demo-app.gate'), String(10 * SYNC_GAP_MS));
    assert.equal(requestSync({ cwd: 'D:/repo' }, env(), stubs({ now: 11 * SYNC_GAP_MS - 1 })).skipped, 'gate');
    assert.equal(requestSync({ cwd: 'D:/repo' }, env(), stubs({ now: 11 * SYNC_GAP_MS })).started, true);
  });

  test('each repo has its own gate', () => {
    writeFileSync(join(root, 'sync-demo-app.gate'), String(10 * SYNC_GAP_MS));
    const other = requestSync({ cwd: 'b' }, env(), stubs({ projectFn: () => 'other-app' }));
    assert.equal(other.started, true);
  });

  test('AGENT_BOARD_PROJECT naming another project does nothing; naming this repo\'s own project syncs (finding 8)', () => {
    assert.equal(requestSync({ cwd: 'x' }, { ...env(), AGENT_BOARD_PROJECT: 'Other App' }, stubs()).skipped, 'other project');
    assert.equal(started.length, 0);
    assert.equal(requestSync({ cwd: 'x' }, { ...env(), AGENT_BOARD_PROJECT: 'demo-app' }, stubs()).started, true);
  });

  test('a failed fetch skips the sync and writes no gate (finding 6)', async () => {
    const lonely = mkdtempSync(join(tmpdir(), 'session-sync-nogit-'));
    roots.push(lonely);
    execFileSync('git', ['init', '-q', lonely]);
    assert.equal(await runSync(lonely, 'demo-app', { ...env(), CLAUDE_CONFIG_DIR: fakePlugin().configDir }, 5), false, 'no origin: the fetch fails');
    assert.equal(existsSync(join(root, 'sync-demo-app.gate')), false);
  });

  test('a failed run leaves a 10-minute retry backoff, not the hourly gate (review #1)', async () => {
    const lonely = mkdtempSync(join(tmpdir(), 'session-sync-nogit-'));
    roots.push(lonely);
    execFileSync('git', ['init', '-q', lonely]);
    const at = 10 * SYNC_GAP_MS;
    assert.equal(await runSync(lonely, 'demo-app', { ...env(), CLAUDE_CONFIG_DIR: fakePlugin().configDir }, at), false);
    assert.equal(existsSync(join(root, 'sync-demo-app.gate')), false);
    assert.equal(requestSync({ cwd: 'D:/repo' }, env(), stubs({ now: at + RETRY_GAP_MS - 1 })).skipped, 'retry backoff');
    assert.equal(requestSync({ cwd: 'D:/repo' }, env(), stubs({ now: at + RETRY_GAP_MS })).started, true);
  });

  test('AGENT_BOARD_USAGE=off and a folder outside a repo start nothing and write no gate', () => {
    assert.equal(requestSync({ cwd: 'x' }, { ...env(), AGENT_BOARD_USAGE: 'off' }, stubs()).skipped, 'off');
    assert.equal(requestSync({ cwd: 'x' }, env(), stubs({ repoFn: () => '' })).skipped, 'not a repo');
    assert.equal(started.length, 0);
    assert.equal(existsSync(join(root, 'sync-demo-app.gate')), false);
  });

  test('an unreadable gate counts as due, and a failing spawn is fail-open', () => {
    writeFileSync(join(root, 'sync-demo-app.gate'), 'not a number');
    const result = requestSync({ cwd: 'x' }, env(), stubs({ spawnFn: () => { throw new Error('no spawn'); } }));
    assert.deepEqual(result, { skipped: 'no start' });
  });
});

describe('runSync with the agent-board plugin (Slice 20)', () => {
  function repoWithOrigin() {
    const origin = mkdtempSync(join(tmpdir(), 'session-sync-origin-'));
    const clone = mkdtempSync(join(tmpdir(), 'session-sync-clone-'));
    roots.push(origin, clone);
    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' });
    return clone;
  }

  test('without the plugin the sync is skipped and a retry backoff is written', async () => {
    const clone = repoWithOrigin();
    const empty = mkdtempSync(join(tmpdir(), 'session-sync-config-'));
    roots.push(empty);
    const at = 10 * SYNC_GAP_MS;
    assert.equal(await runSync(clone, 'demo-app', { ...env(), CLAUDE_CONFIG_DIR: empty }, at), false);
    assert.equal(existsSync(join(root, 'sync-demo-app.retry')), true);
    assert.equal(existsSync(join(root, 'sync-demo-app.gate')), false);
  });

  test('the plugin is checked before the fetch: no plugin and no origin reports the plugin, never a failed fetch (review #4)', async () => {
    const lonely = mkdtempSync(join(tmpdir(), 'session-sync-nogit-'));
    roots.push(lonely);
    execFileSync('git', ['init', '-q', lonely]);
    const empty = mkdtempSync(join(tmpdir(), 'session-sync-config-'));
    roots.push(empty);
    const written = [];
    const realWrite = process.stderr.write;
    process.stderr.write = (text) => { written.push(String(text)); return true; };
    try {
      assert.equal(await runSync(lonely, 'demo-app', { ...env(), CLAUDE_CONFIG_DIR: empty }, 5), false);
    } finally { process.stderr.write = realWrite; }
    assert.ok(written.some(t => t.includes('plugin not installed')));
    assert.ok(!written.some(t => t.includes('fetch failed')), 'the fetch never ran');
  });

  test('a plugin main that throws, or an import that fails, leaves the retry backoff, not the gate (review #3)', async () => {
    const clone = repoWithOrigin();
    const { configDir } = fakePlugin();
    const at = 10 * SYNC_GAP_MS;
    const throwing = async () => ({ main: async () => { throw new Error('git failed'); } });
    assert.equal(await runSync(clone, 'demo-app', { ...env(), CLAUDE_CONFIG_DIR: configDir }, at, throwing), false);
    assert.equal(existsSync(join(root, 'sync-demo-app.retry')), true);
    rmSync(join(root, 'sync-demo-app.retry'));
    const noImport = async () => { throw new Error('cannot import'); };
    assert.equal(await runSync(clone, 'demo-app', { ...env(), CLAUDE_CONFIG_DIR: configDir }, at, noImport), false);
    assert.equal(existsSync(join(root, 'sync-demo-app.retry')), true);
    assert.equal(existsSync(join(root, 'sync-demo-app.gate')), false);
  });

  test('with the plugin it runs the plugin\'s sync-docs main and writes the hourly gate', async () => {
    const clone = repoWithOrigin();
    const { configDir, plugin } = fakePlugin();
    const imported = [];
    const importFn = async (url) => { imported.push(url); return { main: async () => ({ synced: true }) }; };
    const at = 10 * SYNC_GAP_MS;
    assert.equal(await runSync(clone, 'demo-app', { ...env(), CLAUDE_CONFIG_DIR: configDir }, at, importFn), true);
    assert.match(imported[0], /sync-docs\.mjs$/);
    assert.ok(decodeURIComponent(imported[0]).replace(/\\/g, '/').includes(plugin.replace(/\\/g, '/')), 'imported from the plugin folder');
    assert.equal(existsSync(join(root, 'sync-demo-app.gate')), true);
  });
});
