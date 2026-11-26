// Tests for board.mjs (Slice 20): finding the agent-board plugin, filling its environment, fail-open behaviour.
// A temp config folder holds a fake installed_plugins.json and a fake plugin; nothing touches the real profile or the network.
// Run: node --test skills/run-wave/board.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ID, childEnv, pluginDataPath, pluginInstallPath, rewriteArgs, samePath, runBoard, scriptPath, withoutModelForUnderStep } from './board.mjs';

const BOARD = fileURLToPath(new URL('./board.mjs', import.meta.url));
const STEPS_DIR = fileURLToPath(new URL('./steps', import.meta.url));
const roots = [];
let configDir;
let secretsFile;

function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'board-test-'));
  roots.push(dir);
  return dir;
}

function installPlugin(entries) {
  mkdirSync(join(configDir, 'plugins'), { recursive: true });
  writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: entries } }));
}

function fakePluginFolder(name, scriptSource) {
  const plugin = join(configDir, 'plugins', 'cache', name);
  mkdirSync(join(plugin, 'scripts', 'hooks'), { recursive: true });
  writeFileSync(join(plugin, 'scripts', 'report-progress.mjs'), scriptSource);
  writeFileSync(join(plugin, 'scripts', 'hooks', 'session-done.mjs'), scriptSource);
  return plugin;
}

// A stand-in for the plugin's report-progress.mjs with its two exported readers; it echoes only when run as the script.
const FAKE_PLUGIN_WITH_READERS = `import { readFileSync } from 'node:fs';
export function readTouchesFile(path) { return path ? readFileSync(path, 'utf8') : ''; }
export function loadStepList(value, touches = '') {
  const file = JSON.parse(readFileSync(value, 'utf8'));
  const steps = file.steps.filter((step) => !step.needsTouch || step.needsTouch.some((word) => touches.includes(word))).map((step) => ({ label: step.label.trim() }));
  return { agent: file.agent || '', steps };
}
if (process.argv[1].endsWith('report-progress.mjs')) {
  const modelKeys = Object.keys(process.env).filter((key) => key.toUpperCase() === 'AGENT_BOARD_MODEL');
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), modelKeys }));
}
`;
const env = (extra = {}) => ({ CLAUDE_CONFIG_DIR: configDir, AGENT_BOARD_SECRETS_FILE: secretsFile, AGENT_BOARD_URL: 'http://localhost:1', ...extra });
const ECHO_ENV = 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), url: process.env.AGENT_BOARD_URL, token: process.env.AGENT_BOARD_TOKEN, data: process.env.CLAUDE_PLUGIN_DATA, root: process.env.CLAUDE_PLUGIN_ROOT }));';

beforeEach(() => {
  configDir = folder();
  secretsFile = join(folder(), 'secrets.env');
  writeFileSync(secretsFile, 'OTHER=1\nBOARD_WRITE_TOKEN=secret-token-value\n');
});

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('pluginInstallPath', () => {
  test('reads the install folder of the plugin from installed_plugins.json', () => {
    const one = folder();
    installPlugin([{ scope: 'user', installPath: one }]);
    assert.equal(pluginInstallPath(env()), one);
  });

  test('picks the newest entry by lastUpdated when several are recorded, else the last one', () => {
    const [fresh, old] = [folder(), folder()];
    installPlugin([
      { installPath: fresh, lastUpdated: '2026-11-17T10:00:00Z' },
      { installPath: old, lastUpdated: '2026-11-01T10:00:00Z' },
    ]);
    assert.equal(pluginInstallPath(env()), fresh);
    installPlugin([{ installPath: old }, { installPath: fresh }]);
    assert.equal(pluginInstallPath(env()), fresh);
  });

  test('prefers a user-scope install over a newer project-scope one (review #10)', () => {
    const [user, project] = [folder(), folder()];
    installPlugin([
      { scope: 'project', installPath: project, lastUpdated: '2026-11-17T10:00:00Z' },
      { scope: 'user', installPath: user, lastUpdated: '2026-11-01T10:00:00Z' },
    ]);
    assert.equal(pluginInstallPath(env()), user);
  });

  test('skips an entry whose folder is gone and falls back to the next one (review #10)', () => {
    const live = folder();
    installPlugin([
      { scope: 'user', installPath: join(configDir, 'gone'), lastUpdated: '2026-11-17T10:00:00Z' },
      { scope: 'project', installPath: live, lastUpdated: '2026-11-01T10:00:00Z' },
    ]);
    assert.equal(pluginInstallPath(env()), live);
    installPlugin([{ scope: 'user', installPath: join(configDir, 'gone') }]);
    assert.equal(pluginInstallPath(env()), '');
  });

  test('is empty with no file, bad JSON, no record of the plugin or an entry with no path', () => {
    assert.equal(pluginInstallPath(env()), '');
    mkdirSync(join(configDir, 'plugins'), { recursive: true });
    writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), '{not json');
    assert.equal(pluginInstallPath(env()), '');
    installPlugin([{ scope: 'user' }]);
    assert.equal(pluginInstallPath(env()), '');
  });
});

describe('scriptPath', () => {
  test('maps a script name and hooks/<name> into the plugin\'s scripts folder', () => {
    assert.equal(scriptPath('/p', 'report-progress'), join('/p', 'scripts', 'report-progress.mjs'));
    assert.equal(scriptPath('/p', 'hooks/session-done'), join('/p', 'scripts', 'hooks', 'session-done.mjs'));
  });

  test('refuses a name that could leave the scripts folder', () => {
    for (const bad of ['../x', 'a/b', 'hooks/../x', 'hooks/a/b', 'x.mjs', '']) assert.equal(scriptPath('/p', bad), '', bad);
  });
});

describe('childEnv', () => {
  test('fills the write token from the secrets store when an address is set', () => {
    const filled = childEnv(env({ AGENT_BOARD_URL: 'http://localhost:1' }));
    assert.equal(filled.AGENT_BOARD_URL, 'http://localhost:1');
    assert.equal(filled.AGENT_BOARD_TOKEN, 'secret-token-value');
  });

  test('with no address there is no default and the token is not read', () => {
    const filled = childEnv(env({ AGENT_BOARD_URL: '' }));
    assert.ok(!filled.AGENT_BOARD_URL);
    assert.equal(filled.AGENT_BOARD_TOKEN, undefined);
  });

  test('runBoard skips and never starts the plugin when AGENT_BOARD_URL is unset', async () => {
    installPlugin([{ installPath: fakePluginFolder('1.0.0', ECHO_ENV) }]);
    let started = false;
    const result = await runBoard(['report-progress', '--slice', '3'], env({ AGENT_BOARD_URL: '' }), () => { started = true; return { status: 0 }; });
    assert.equal(result.ok, false);
    assert.match(result.reason, /AGENT_BOARD_URL not set/);
    assert.equal(started, false);
  });

  test('keeps an address and a token the caller already set', () => {
    const filled = childEnv(env({ AGENT_BOARD_URL: 'http://localhost:1', AGENT_BOARD_TOKEN: 'mine' }));
    assert.equal(filled.AGENT_BOARD_URL, 'http://localhost:1');
    assert.equal(filled.AGENT_BOARD_TOKEN, 'mine');
  });

  test('sets the plugin root and data folder as Claude Code does for the plugin\'s hooks (review #2)', () => {
    const filled = childEnv(env(), '/cache/agent-board/1.0.0');
    assert.equal(filled.CLAUDE_PLUGIN_ROOT, '/cache/agent-board/1.0.0');
    assert.equal(filled.CLAUDE_PLUGIN_DATA, join(configDir, 'plugins', 'data', 'agent-board-agent-progress-board'));
    assert.equal(pluginDataPath(env()), filled.CLAUDE_PLUGIN_DATA);
    assert.equal(childEnv(env({ CLAUDE_PLUGIN_DATA: '/mine' }), '/p').CLAUDE_PLUGIN_DATA, '/mine');
    assert.equal(childEnv(env()).CLAUDE_PLUGIN_DATA, undefined);
  });

  test('the plugin\'s own root in another spelling keeps its data path; another plugin\'s root is replaced (review medium #1)', () => {
    const own = childEnv(env({ CLAUDE_PLUGIN_ROOT: '/cache/agent-board/1.0.0/', CLAUDE_PLUGIN_DATA: '/mine' }), '/cache/agent-board/1.0.0');
    assert.equal(own.CLAUDE_PLUGIN_DATA, '/mine');
    assert.equal(samePath('C:\\Cache\\Board\\', 'c:/cache/board', 'win32'), true);
    assert.equal(samePath('/Cache/board', '/cache/board', 'linux'), false);
    const other = childEnv(env({ CLAUDE_PLUGIN_ROOT: '/cache/other/2.0.0', CLAUDE_PLUGIN_DATA: '/theirs' }), '/cache/agent-board/1.0.0');
    assert.equal(other.CLAUDE_PLUGIN_ROOT, '/cache/agent-board/1.0.0');
    assert.equal(other.CLAUDE_PLUGIN_DATA, pluginDataPath(env()));
  });

  test('leaves the token out when the secrets file is missing', () => {
    assert.equal(childEnv(env({ AGENT_BOARD_SECRETS_FILE: join(configDir, 'none.env') })).AGENT_BOARD_TOKEN, undefined);
  });
});

describe('rewriteArgs', () => {
  test('turns a bare --steps-file name into our step list path, keeps a path and other args', () => {
    assert.deepEqual(rewriteArgs(['--slice', '3', '--steps-file', 'run-wave', '--step-active', 'Build']),
      ['--slice', '3', '--steps-file', join(STEPS_DIR, 'run-wave.json'), '--step-active', 'Build']);
    assert.deepEqual(rewriteArgs(['--steps-file', 'sub/own.json']), ['--steps-file', 'sub/own.json']);
    assert.deepEqual(rewriteArgs(['--steps-file']), ['--steps-file']);
  });

  test('every step list the callers name exists as a file', () => {
    for (const name of ['run-wave', 'implement-slice', 'fix-review-findings', 'code-review-pass', 'device-test']) {
      const [, path] = rewriteArgs(['--steps-file', name]);
      assert.ok(existsSync(path), `${name}: ${path}`);
    }
  });
});

describe('runBoard', () => {
  test('runs the plugin script with the args, the filled environment and the rewritten step list', () => {
    const plugin = fakePluginFolder('1.0.0', ECHO_ENV);
    installPlugin([{ installPath: plugin }]);
    const out = spawnSync(process.execPath, [BOARD, 'report-progress', '--slice', '3', '--steps-file', 'run-wave'],
      { encoding: 'utf8', cwd: folder(), env: { ...process.env, ...env(), AGENT_BOARD_URL: 'http://localhost:1', AGENT_BOARD_TOKEN: '' } });
    assert.equal(out.status, 0, out.stderr);
    const seen = JSON.parse(out.stdout);
    assert.deepEqual(seen.args, ['--slice', '3', '--steps-file', join(STEPS_DIR, 'run-wave.json')]);
    assert.equal(seen.url, 'http://localhost:1');
    assert.equal(seen.token, 'secret-token-value');
    assert.equal(seen.root, plugin);
    assert.equal(seen.data, pluginDataPath(env()), 'the state folder is the plugin\'s data folder, where its hooks look');
    assert.ok(!out.stderr.includes('secret-token-value') && !out.stdout.includes('"args":["secret'), 'the token is not on the command line');
  });

  test('runs a hook script through hooks/<name>', () => {
    const plugin = fakePluginFolder('1.0.0', ECHO_ENV);
    installPlugin([{ installPath: plugin }]);
    const out = spawnSync(process.execPath, [BOARD, 'hooks/session-done'], { encoding: 'utf8', env: { ...process.env, ...env() } });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout).args, []);
  });

  test('fails open with one skipped line: plugin not installed, script missing, non-zero exit, unknown name', () => {
    const run = (args) => spawnSync(process.execPath, [BOARD, ...args], { encoding: 'utf8', env: { ...process.env, ...env() } });
    let out = run(['report-progress']);
    assert.equal(out.status, 0);
    assert.match(out.stderr, /^board: skipped \(agent-board plugin not installed\)\r?\n$/);
    const plugin = fakePluginFolder('1.0.0', 'process.exit(3);');
    installPlugin([{ installPath: plugin }]);
    out = run(['sync-docs']);
    assert.equal(out.status, 0);
    assert.match(out.stderr, /board: skipped \(sync-docs not found in the plugin\)/);
    out = run(['report-progress']);
    assert.equal(out.status, 0);
    assert.match(out.stderr, /board: skipped \(report-progress exited 3\)/);
    out = run(['../evil']);
    assert.equal(out.status, 0);
    assert.match(out.stderr, /board: skipped \(unknown script/);
    out = run([]);
    assert.equal(out.status, 0);
    assert.match(out.stderr, /board: skipped \(no script named\)/);
  });

  test('--under-step and --orchestrator reach the reporter unchanged; a reporter that rejects them still fails open (Slice 24)', () => {
    const run = (args) => spawnSync(process.execPath, [BOARD, ...args], { encoding: 'utf8', env: { ...process.env, ...env() } });
    installPlugin([{ installPath: fakePluginFolder('2.0.0', ECHO_ENV) }]);
    const under = run(['report-progress', '--key', 'p/slice-24', '--under-step', 'Build the slice', '--steps', 'A|B']);
    assert.equal(under.status, 0);
    assert.deepEqual(JSON.parse(under.stdout).args, ['--key', 'p/slice-24', '--under-step', 'Build the slice', '--steps', 'A|B']);
    assert.equal(JSON.parse(run(['report-progress', '--orchestrator']).stdout).args[0], '--orchestrator');
    installPlugin([{ installPath: fakePluginFolder('1.0.0', 'process.stderr.write("unknown flag"); process.exit(2);') }]);
    const old = run(['report-progress', '--orchestrator']);
    assert.equal(old.status, 0);
    assert.match(old.stderr, /board: skipped \(report-progress exited 2\)/);
  });

  test('--started-at / --done-at reach the reporter unchanged, also on an --under-step rewrite; an old reporter that ignores them still sends and says so (Slice 32 C)', () => {
    const run = (args) => spawnSync(process.execPath, [BOARD, ...args], { encoding: 'utf8', env: { ...process.env, ...env() } });
    installPlugin([{ installPath: fakePluginFolder('2.0.0', ECHO_ENV) }]);
    const times = ['--started-at', '2026-11-19T09:02:00Z', '--done-at', '2026-11-19T09:19:00Z'];
    const plain = run(['report-progress', '--key', 'p/slice-24', '--steps', 'A|B', '--step-done', 'A', ...times]);
    assert.deepEqual(JSON.parse(plain.stdout).args, ['--key', 'p/slice-24', '--steps', 'A|B', '--step-done', 'A', ...times]);
    const under = run(['report-progress', '--key', 'p/slice-24', '--under-step', 'Build the slice', '--steps', 'A|B', '--step-done', 'A', ...times]);
    assert.deepEqual(JSON.parse(under.stdout).args, ['--key', 'p/slice-24', '--under-step', 'Build the slice', '--steps', 'A|B', '--step-done', 'A', ...times]);
    assert.match(plain.stderr, /board: note \(the installed agent-board plugin predates/, 'a plugin source without the flag gets the note');
    installPlugin([{ installPath: fakePluginFolder('3.0.0', `// reads --started-at and --done-at\n${ECHO_ENV}`) }]);
    assert.doesNotMatch(run(['report-progress', '--key', 'k', '--step-done', 'A', ...times]).stderr, /board: note/);
    assert.doesNotMatch(run(['report-progress', '--key', 'k', '--step-done', 'A']).stderr, /board: note/);
  });

  // The real reporter script, through board.mjs, against a fake board address. The plugin's folder comes from AGENT_BOARD_PLUGIN_SRC
  // (its `plugin` folder), else the sibling agent-progress-board checkout; with none that knows the flags the test is skipped.
  // The sibling is looked up beside the primary checkout (the parent of `git rev-parse --git-common-dir`'s repo), since a worktree has no sibling.
  function primaryParent() {
    try {
      const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', cwd: dirname(BOARD) }).stdout.trim();
      return common ? dirname(dirname(common)) : '';
    } catch { return ''; }
  }
  const PLUGIN_SRC = process.env.AGENT_BOARD_PLUGIN_SRC || join(primaryParent(), 'agent-progress-board', 'plugin');
  const realReporter = join(PLUGIN_SRC, 'scripts', 'report-progress.mjs');
  const hasTimeFlags = existsSync(realReporter) && readFileSync(realReporter, 'utf8').includes('--started-at');
  test('the real report-progress.mjs gets --started-at/--done-at through board.mjs and sends the times to the board (Slice 32 C)', { skip: hasTimeFlags ? false : 'no agent-board plugin with --started-at (set AGENT_BOARD_PLUGIN_SRC)' }, async () => {
    const { createServer } = await import('node:http');
    const bodies = [];
    const server = createServer((req, res) => {
      let text = '';
      req.on('data', (chunk) => { text += chunk; });
      req.on('end', () => {
        bodies.push(JSON.parse(text));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      installPlugin([{ installPath: PLUGIN_SRC }]);
      const url = `http://127.0.0.1:${server.address().port}`;
      const state = folder();
      const args = [BOARD, 'report-progress', '--key', 'demo/slice-24', '--title', 'Demo slice', '--steps', 'Plan|Build|Ship', '--step-done', 'Build', '--started-at', '2026-11-19T09:02:00Z', '--done-at', '2026-11-19T09:19:00Z'];
      const childEnv = { ...process.env, ...env({ AGENT_BOARD_URL: url, AGENT_BOARD_TOKEN: 'test-token', AGENT_BOARD_SESSION_ROOT: state, AGENT_BOARD_PROJECT: 'demo' }) };
      // Async spawn: the fake board lives in this process, so a blocking spawnSync would never let it answer.
      const out = await new Promise((resolve) => {
        const child = spawn(process.execPath, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (status) => resolve({ status, stderr }));
      });
      assert.equal(out.status, 0, out.stderr);
      assert.doesNotMatch(out.stderr, /board: (skipped|note)/);
      const steps = bodies[0].params.arguments.steps;
      assert.deepEqual(steps[1], { label: 'Build', state: 'done', started_at: '2026-11-19T09:02:00.000Z', done_at: '2026-11-19T09:19:00.000Z' });
      assert.equal(steps[2].started_at, '2026-11-19T09:19:00.000Z', 'the step that becomes active starts when the done one ended');
    } finally {
      server.close();
    }
  });

  test('--under-step removes AGENT_BOARD_MODEL from the reporter environment; other reports keep it (Slice 24)', () => {
    const echoModel = 'process.stdout.write(JSON.stringify({ model: process.env.AGENT_BOARD_MODEL === undefined ? null : process.env.AGENT_BOARD_MODEL }));';
    installPlugin([{ installPath: fakePluginFolder('2.0.0', echoModel) }]);
    const run = (args) => spawnSync(process.execPath, [BOARD, ...args], { encoding: 'utf8', env: { ...process.env, ...env({ AGENT_BOARD_MODEL: 'opus' }) } });
    assert.equal(JSON.parse(run(['report-progress', '--key', 'p/slice-24', '--under-step', 'Build the slice', '--steps', 'A|B']).stdout).model, null);
    assert.equal(JSON.parse(run(['report-progress', '--key', 'p/slice-24', '--under-step=Build the slice', '--steps', 'A|B']).stdout).model, null);
    assert.equal(JSON.parse(run(['report-progress', '--key', 'p/slice-24', '--steps', 'A|B']).stdout).model, 'opus');
  });

  test('--under-step drops AGENT_BOARD_MODEL whatever its letter case (Slice 24)', () => {
    const seen = withoutModelForUnderStep({ Agent_Board_Model: 'opus', KEEP: '1', AGENT_BOARD_MODEL: 'x' }, ['--under-step', 'S']);
    assert.deepEqual(seen, { KEEP: '1' });
    assert.deepEqual(withoutModelForUnderStep({ Agent_Board_Model: 'opus' }, ['--key', 'k']), { Agent_Board_Model: 'opus' });
  });

  test('--under-step sends the step labels inline, trimmed to Touches, and drops --agent and the file flags (Slice 24)', () => {
    const plugin = fakePluginFolder('3.0.0', FAKE_PLUGIN_WITH_READERS);
    installPlugin([{ installPath: plugin }]);
    const dir = folder();
    const stepsFile = join(dir, 'steps.json');
    writeFileSync(stepsFile, JSON.stringify({ agent: 'implement-slice', steps: [{ label: ' Read the plan ' }, { label: 'Android build', needsTouch: ['.kt'] }, { label: 'Report back' }] }));
    const sliceFile = join(dir, 'slice.md');
    writeFileSync(sliceFile, '**Touches:** docs only\n');
    const run = (args) => JSON.parse(spawnSync(process.execPath, [BOARD, ...args], { encoding: 'utf8', env: { ...process.env, ...env({ Agent_Board_Model: 'opus' }) } }).stdout);
    const seen = run(['report-progress', '--key', 'p/slice-24', '--under-step', 'Build the slice', '--agent', 'implement-slice', '--steps-file', stepsFile, '--touches-file', sliceFile, '--step-active', 'Read the plan']);
    assert.deepEqual(seen.args, ['--key', 'p/slice-24', '--under-step', 'Build the slice', '--step-active', 'Read the plan', '--steps', 'Read the plan|Report back']);
    assert.deepEqual(seen.modelKeys, []);
    const kept = run(['report-progress', '--key', 'p/slice-24', '--under-step=Build the slice', `--steps-file=${stepsFile}`, '--touches', 'a.kt']);
    assert.deepEqual(kept.args, ['--key', 'p/slice-24', '--under-step=Build the slice', '--steps', 'Read the plan|Android build|Report back']);
    const plain = run(['report-progress', '--key', 'p/slice-24', '--agent', 'implement-slice', '--steps-file', stepsFile]);
    assert.deepEqual(plain.args, ['--key', 'p/slice-24', '--agent', 'implement-slice', '--steps-file', stepsFile], 'a report without --under-step is unchanged');
  });

  test('--under-step sends each kept step\'s process key as --step-process before the caller\'s flags, so the caller\'s own wins; --counts passes through (Slice 34 B, C)', () => {
    installPlugin([{ installPath: fakePluginFolder('3.0.0', FAKE_PLUGIN_WITH_READERS) }]);
    const stepsFile = join(folder(), 'steps.json');
    writeFileSync(stepsFile, JSON.stringify({ agent: 'x', steps: [{ label: 'Read', process: 'review/read' }, { label: 'Write the findings', process: 'review/pass-1' }, { label: 'Plain' }] }));
    const run = (args) => JSON.parse(spawnSync(process.execPath, [BOARD, ...args], { encoding: 'utf8', env: { ...process.env, ...env() } }).stdout);
    const seen = run(['report-progress', '--key', 'p/slice-34', '--under-step', 'Review pass 2', '--steps-file', stepsFile, '--step-process', 'Write the findings|review/pass-2', '--step-done', 'Write the findings', '--counts', 'findings=3']);
    assert.deepEqual(seen.args, [
      '--step-process', 'Read|review/read', '--step-process', 'Write the findings|review/pass-1',
      '--key', 'p/slice-34', '--under-step', 'Review pass 2', '--step-process', 'Write the findings|review/pass-2', '--step-done', 'Write the findings', '--counts', 'findings=3',
      '--steps', 'Read|Write the findings|Plain',
    ]);
  });

  test('every step in skills/run-wave/steps/*.json has a process key that fits the board rule (Slice 34 B)', () => {
    const rule = /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;
    for (const name of readdirSync(STEPS_DIR)) {
      for (const step of JSON.parse(readFileSync(join(STEPS_DIR, name), 'utf8')).steps) {
        assert.ok(typeof step.process === 'string' && step.process.length <= 80 && rule.test(step.process), `${name}: "${step.label}" needs a valid process key`);
      }
    }
  });

  test('--under-step with a plugin that lacks the exports falls back to the file labels, untrimmed, and still fails open (Slice 24)', () => {
    installPlugin([{ installPath: fakePluginFolder('1.0.0', `if (process.argv[1].endsWith('report-progress.mjs')) { ${ECHO_ENV} }`) }]);
    const dir = folder();
    const stepsFile = join(dir, 'steps.json');
    writeFileSync(stepsFile, JSON.stringify({ steps: [{ label: ' A ' }, { label: 'B' }] }));
    const out = spawnSync(process.execPath, [BOARD, 'report-progress', '--key', 'k', '--under-step', 'S', '--steps-file', stepsFile], { encoding: 'utf8', env: { ...process.env, ...env() } });
    assert.equal(out.status, 0);
    assert.deepEqual(JSON.parse(out.stdout).args, ['--key', 'k', '--under-step', 'S', '--steps', ' A |B']);
  });

  test('a spawn that cannot start is reported, never thrown', async () => {
    const plugin = fakePluginFolder('1.0.0', ECHO_ENV);
    installPlugin([{ installPath: plugin }]);
    const result = await runBoard(['report-progress'], env(), () => ({ error: new Error('no node') }));
    assert.equal(result.ok, false);
  });
});

describe('Slice 32 open checks as steps', () => {
  const UNVERIFIED = '# Not yet verified\n\n### Slice 31: Night runs ([slice](x.md))\n\n- [session] A real night ends with a log.\n\n### Slice 24: Board tree ([slice](y.md))\n\n- The live board shows the layout. Needs the installed agent-board plugin updated to a version with `--under-step`.\n- Plain check.\n\n### Slice 2: Other\n\n- not ours\n';

  test('openChecksOf reads one slice block, exact number only', async () => {
    const { openChecksOf } = await import('./board.mjs');
    assert.equal(openChecksOf(UNVERIFIED, '24').length, 2);
    assert.deepEqual(openChecksOf(UNVERIFIED, '2'), ['not ours']);
    assert.deepEqual(openChecksOf(UNVERIFIED, '99'), []);
  });

  test('openChecksOf joins a wrapped bullet and skips [x] lines', async () => {
    const { openChecksOf } = await import('./board.mjs');
    const text = '### Slice 5: x\n\n- [session] First line\n  continues here. Needs the owner.\n- [x] Closed one\n  wrapped closed\n- Open two\n\n### Slice 6: y\n';
    assert.deepEqual(openChecksOf(text, '5'), ['[session] First line continues here. Needs the owner.', 'Open two']);
  });

  test('checkStep labels the check; only an explicit wait is pending with a "waits on: " note, never blocked', async () => {
    const { checkStep } = await import('./board.mjs');
    const waiting = checkStep('The live board shows the layout. Needs the owner to update the plugin.');
    assert.ok(waiting.label.startsWith('Check: '));
    assert.ok(waiting.note.startsWith('waits on: '));
    assert.equal(waiting.state, undefined);
    assert.ok(checkStep('[chrome] Waits on Slice 51 being live.').note);
    assert.ok(checkStep('**You:** press the button').note);
    assert.equal(checkStep('Plain check.').note, undefined);
    assert.equal(checkStep('[session] Run twice: the second run needs the first run\'s log').note, undefined);
    assert.ok(checkStep('x'.repeat(300)).label.length <= 80);
  });

  test('checkStep drops a trailing live-check marker so the label stays the same', async () => {
    const { checkStep } = await import('./board.mjs');
    const base = checkStep('[phone] Import works on the phone.').label;
    assert.equal(checkStep('[phone] Import works on the phone. (live check 2026-11-26: passed)').label, base);
    assert.equal(checkStep('Import works on the phone. (live check 2026-11-26: failed)').label, base);
  });

  test('checkStep accepts any whitespace after the tag and a ")" inside the marker reason', async () => {
    const { checkStep } = await import('./board.mjs');
    const base = checkStep('Import works on the phone.').label;
    assert.equal(checkStep('[phone]  Import works on the phone.').label, base);
    assert.equal(checkStep('[phone]\tImport works on the phone.').label, base);
    assert.equal(checkStep('Import works on the phone. (live check 2026-11-26: unreachable: Chrome stopped (Access sign-in))').label, base);
  });

  test('checkStep strips only the writer\'s exact marker and tag, and keeps a marker-only bullet', async () => {
    const { checkStep } = await import('./board.mjs');
    assert.equal(checkStep('X. (live check 2026-11-26: failed) (see Slice 5)').label, 'Check: X. (live check 2026-11-26: failed) (see Slice 5)');
    assert.equal(checkStep('[chat](http://a) review').label, 'Check: [chat](http://a) review');
    assert.equal(checkStep('(live check 2026-11-26: failed)').label, 'Check: (live check 2026-11-26: failed)');
    assert.equal(checkStep('[owner] **You:** press it (live check 2026-11-26: failed)').note, 'waits on: owner: **You:** press it'.replace(/\*\*/g, ''));
    assert.equal(checkStep('[phone] X (live check 2026-11-26: unreachable: waiting on the phone)').note, undefined);
  });

  test('stepsWithChecks keeps a marked check\'s collision label free of the marker', async () => {
    const { stepsWithChecks } = await import('./board.mjs');
    const out = stepsWithChecks([], ['X', 'X (live check 2026-11-26: failed)']);
    assert.deepEqual(out.map((s) => s.label), ['Check: X', 'Check: X (2)']);
  });

  test('stepsWithChecks appends after the static list without duplicates', async () => {
    const { stepsWithChecks } = await import('./board.mjs');
    const base = [{ label: 'Index pass' }];
    const out = stepsWithChecks(base, ['Plain check.', 'Plain check.']);
    assert.deepEqual(out.map((s) => s.label), ['Index pass', 'Check: Plain check.']);
    assert.equal(stepsWithChecks(base, []), base);
  });

  test('stepsWithChecks keeps labels at 80, distinct after the cut, and the total within 30 with a "+N more" last step', async () => {
    const { stepsWithChecks } = await import('./board.mjs');
    const prefix = '[session] The live-checks prompt has never run against a real night so ';
    const checks = Array.from({ length: 40 }, (_, i) => `${prefix}check number ${i}`);
    const base = Array.from({ length: 14 }, (_, i) => ({ label: `s${i}` }));
    const out = stepsWithChecks(base, checks);
    assert.equal(out.length, 30);
    assert.equal(new Set(out.map((s) => s.label)).size, 30);
    assert.ok(out.every((s) => s.label.length <= 80));
    assert.match(out.at(-1).label, /^\+25 more checks/);
  });

  test('stepsWithChecks puts a check that left unverified.md first, as a label the plugin marks done', async () => {
    const { stepsWithChecks } = await import('./board.mjs');
    const out = stepsWithChecks([{ label: 'Index pass' }], ['Open one.'], ['Check: Gone one.']);
    assert.deepEqual(out.map((s) => s.label), ['Check: Gone one.', 'Index pass', 'Check: Open one.']);
  });

  function repoWithChecks() {
    const root = folder();
    const repo = join(root, 'demo');
    mkdirSync(join(repo, 'docs', 'plan'), { recursive: true });
    spawnSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'docs', 'plan', 'unverified.md'), UNVERIFIED);
    mkdirSync(join(root, 'demo-worktrees'));
    writeFileSync(join(root, 'demo-worktrees', 'wave-ledger.md'), '## Wave 1 (open)\nOpened 08:00Z 2026-11-19\n- Slice 24 x\n');
    return { repo, ledger: join(root, 'demo-worktrees'), stamp: join(root, 'demo-worktrees', 'step-reports', 'slice-24.txt') };
  }

  // A report the plugin accepted: withOpenChecks, then the stamp writes it queued (runBoard runs them after exit 0).
  async function sentOk(args, repo) {
    const { withOpenChecks } = await import('./board.mjs');
    const commits = [];
    const out = withOpenChecks(args, repo, [], commits);
    for (const commit of commits) commit();
    return out;
  }

  test('withOpenChecks writes the list under step-reports, returns it for deletion and leaves other reports alone', async () => {
    const { withOpenChecks } = await import('./board.mjs');
    const { repo, ledger } = repoWithChecks();
    const stepsFile = join(STEPS_DIR, 'run-wave.json');
    const made = [];
    const out = withOpenChecks(['--slice', '24', '--steps-file', stepsFile, '--step-active', 'Index pass'], repo, made);
    assert.equal(made.length, 1);
    assert.ok(made[0].startsWith(join(ledger, 'step-reports')));
    const list = JSON.parse(readFileSync(out[3], 'utf8')).steps;
    assert.equal(list.at(-1).label, 'Check: Plain check.');
    assert.equal(list.at(-3).label, 'Index pass');
    const none = ['--slice', '99', '--steps-file', stepsFile];
    assert.deepEqual(withOpenChecks(none, repo), none);
    const noSlice = ['--steps-file', stepsFile];
    assert.deepEqual(withOpenChecks(noSlice, repo), noSlice);
  });

  test('the Index-pass-done report still sends the checks, so the plugin makes the first open check active', async () => {
    const { withOpenChecks } = await import('./board.mjs');
    const { repo } = repoWithChecks();
    const args = ['--slice', '24', '--steps-file', join(STEPS_DIR, 'run-wave.json'), '--step-done', 'Index pass'];
    const labels = JSON.parse(readFileSync(withOpenChecks(args, repo)[3], 'utf8')).steps.map((s) => s.label);
    assert.equal(labels.at(-1), 'Check: Plain check.');
  });

  test('withOpenChecks adds no checks to a --part or --under-step report', async () => {
    const { withOpenChecks } = await import('./board.mjs');
    const { repo } = repoWithChecks();
    const stepsFile = join(STEPS_DIR, 'run-wave.json');
    for (const extra of [['--part', 'b', '--step-active', 'Index pass'], ['--under-step', 'Build the slice']]) {
      const args = ['--slice', '24', '--steps-file', stepsFile, ...extra];
      assert.deepEqual(withOpenChecks(args, repo), args);
    }
  });

  test('a check that left unverified.md since the last stamp is sent first (done) on the next report', async () => {
    const { withOpenChecks, noteStepReport } = await import('./board.mjs');
    const { repo, stamp } = repoWithChecks();
    const stepsFile = join(STEPS_DIR, 'run-wave.json');
    const args = ['--slice', '24', '--steps-file', stepsFile, '--step-active', 'Index pass'];
    noteStepReport(args, repo);
    await sentOk(args, repo);
    assert.match(readFileSync(stamp, 'utf8'), /check: Check: Plain check\./);
    writeFileSync(join(repo, 'docs', 'plan', 'unverified.md'), '### Slice 24: x\n\n- Plain check. still\n');
    const out = await sentOk(args, repo);
    const labels = JSON.parse(readFileSync(out[3], 'utf8')).steps.map((s) => s.label);
    assert.equal(labels[0].startsWith('Check: The live board shows'), true);
    assert.ok(labels.includes('Check: Plain check.'));
    assert.ok(labels.includes('Check: Plain check. still'));
  });

  test('review 2: withOpenChecks makes no folder or steps file without a live ledger (finding 2)', async () => {
    const { withOpenChecks } = await import('./board.mjs');
    const { repo, ledger } = repoWithChecks();
    rmSync(join(ledger, 'wave-ledger.md'));
    const args = ['--slice', '24', '--steps-file', join(STEPS_DIR, 'run-wave.json'), '--step-active', 'Index pass'];
    assert.deepEqual(withOpenChecks(args, repo), args);
    assert.equal(existsSync(join(ledger, 'step-reports')), false);
  });

  test('review 2: runBoard deletes the steps file when the plugin call throws (finding 2)', async () => {
    const { repo, ledger } = repoWithChecks();
    installPlugin([{ installPath: fakePluginFolder('1.0.0', ECHO_ENV) }]);
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      await assert.rejects(runBoard(['report-progress', '--slice', '24', '--steps-file', 'run-wave', '--step-active', 'Index pass'], env(), () => { throw new Error('boom'); }));
    } finally { process.chdir(cwd); }
    assert.deepEqual(readdirSync(join(ledger, 'step-reports')).filter((f) => f.startsWith('steps-slice-')), []);
  });

  test('review 2: the stamp lists only labels sent in this report; a vanished one is sent as done once (finding 3)', async () => {
    const { withOpenChecks, noteStepReport } = await import('./board.mjs');
    const { repo, stamp } = repoWithChecks();
    const args = ['--slice', '24', '--steps-file', join(STEPS_DIR, 'run-wave.json'), '--step-active', 'Index pass'];
    noteStepReport(args, repo);
    await sentOk(args, repo);
    writeFileSync(join(repo, 'docs', 'plan', 'unverified.md'), '### Slice 24: x\n\n- Plain check. still\n');
    const second = JSON.parse(readFileSync((await sentOk(args, repo))[3], 'utf8')).steps.map((s) => s.label);
    assert.ok(second.includes('Check: Plain check.'));
    assert.equal(readFileSync(stamp, 'utf8').includes('check: Check: Plain check.\n'), false);
    const third = JSON.parse(readFileSync((await sentOk(args, repo))[3], 'utf8')).steps.map((s) => s.label);
    assert.equal(third.includes('Check: Plain check.'), false);
  });

  test('review 2: a capped check is not recorded as sent (finding 3)', async () => {
    const { withOpenChecks, noteStepReport } = await import('./board.mjs');
    const { repo, stamp } = repoWithChecks();
    const many = Array.from({ length: 40 }, (_, i) => `- Check number ${i}`).join('\n');
    writeFileSync(join(repo, 'docs', 'plan', 'unverified.md'), `### Slice 24: x\n\n${many}\n`);
    const args = ['--slice', '24', '--steps-file', join(STEPS_DIR, 'run-wave.json'), '--step-active', 'Index pass'];
    noteStepReport(args, repo);
    const sent = JSON.parse(readFileSync((await sentOk(args, repo))[3], 'utf8')).steps.map((s) => s.label);
    const recorded = readFileSync(stamp, 'utf8').split('\n').filter((l) => l.startsWith('check: ')).map((l) => l.slice(7));
    assert.deepEqual(recorded, sent.filter((l) => l.startsWith('Check: ')));
    assert.ok(recorded.length < 40);
  });

  test('review 2: "waits on nothing" is not waiting; [owner] and **You:** are (finding 4)', async () => {
    const { checkStep } = await import('./board.mjs');
    assert.equal(checkStep('Run it; waits on nothing else.').note, undefined);
    assert.equal(checkStep('Not waiting on no one.').note, undefined);
    assert.ok(checkStep('[owner] Press the button in the console.').note.startsWith('waits on: '));
    assert.ok(checkStep('Waiting on Slice 51.').note);
  });

  test('review 2: a check continues after a blank line while indented; numbered bullets count (finding 6)', async () => {
    const { openChecksOf } = await import('./board.mjs');
    const text = '### Slice 5: x\n\n- First line\n\n  second paragraph\n  - sub bullet\n1. Numbered one\n2) Numbered two\n\nUnindented prose.\n  stray indent\n';
    assert.deepEqual(openChecksOf(text, '5'), ['First line second paragraph - sub bullet', 'Numbered one', 'Numbered two']);
  });

  test('noteStepReport stamps time and step label while a live ledger exists, only for a slice step move', async () => {
    const { noteStepReport } = await import('./board.mjs');
    const { repo, stamp } = repoWithChecks();
    noteStepReport(['--slice', '24', '--status', 'in_progress'], repo);
    assert.equal(existsSync(stamp), false);
    noteStepReport(['--slice', '24', '--part', 'b', '--step-active', 'Build the slice'], repo);
    noteStepReport(['--slice', '24', '--under-step', 'x', '--step-active', 'Build the slice'], repo);
    assert.equal(existsSync(stamp), false);
    noteStepReport(['--slice', '24', '--step-active', 'Build the slice'], repo, new Date('2026-11-19T10:00:00Z'));
    assert.deepEqual(readFileSync(stamp, 'utf8').split('\n').slice(0, 2), ['2026-11-19T10:00:00.000Z', 'Build the slice']);
    noteStepReport(['--step-active', 'Build'], join(folder(), 'nowhere'));
  });

  test('noteStepReport writes nothing and creates no folder without a wave ledger', async () => {
    const { noteStepReport } = await import('./board.mjs');
    const root = folder();
    const repo = join(root, 'demo');
    mkdirSync(repo);
    spawnSync('git', ['init', '-q', repo]);
    noteStepReport(['--slice', '3', '--step-active', 'Build the slice'], repo);
    assert.equal(existsSync(join(root, 'demo-worktrees')), false);
  });

  test('review pass 2 #3 and #7: the check list reaches the stamp only after the plugin exits 0; runBoard takes cwd and now', async () => {
    const { repo, stamp } = repoWithChecks();
    const argv = ['report-progress', '--slice', '24', '--steps-file', 'run-wave', '--step-active', 'Index pass'];
    const options = { cwd: repo, now: new Date('2026-11-19T10:00:00Z') };
    installPlugin([{ installPath: fakePluginFolder('1.0.0', 'process.exit(1);') }]);
    assert.equal((await runBoard(argv, env(), spawnSync, options)).ok, false);
    assert.deepEqual(readFileSync(stamp, 'utf8').split('\n').slice(0, 2), ['2026-11-19T10:00:00.000Z', 'Index pass']);
    assert.equal(readFileSync(stamp, 'utf8').includes('check: '), false);
    installPlugin([{ installPath: fakePluginFolder('1.0.1', 'process.exit(0);') }]);
    assert.equal((await runBoard(argv, env(), spawnSync, options)).ok, true);
    assert.match(readFileSync(stamp, 'utf8'), /check: Check: Plain check\./);
  });

  test('review pass 2 #5: "waits on" mid-sentence is not waiting; at the start or after a colon or dash it is', async () => {
    const { checkStep } = await import('./board.mjs');
    assert.equal(checkStep('The banner is hidden while the page waits on the CDN.').note, undefined);
    assert.ok(checkStep('Run it. Blocked: waits on Slice 51.').note);
    assert.ok(checkStep('Run it - waiting on the owner.').note);
    assert.ok(checkStep('Waits on Slice 51 being live.').note);
  });

  test('runBoard stamps before the plugin-not-installed skip', async () => {
    const { repo, stamp } = repoWithChecks();
    installPlugin([]);
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      const result = await runBoard(['report-progress', '--slice', '24', '--step-active', 'Fast checks'], env());
      assert.equal(result.ok, false);
    } finally { process.chdir(cwd); }
    assert.equal(readFileSync(stamp, 'utf8').split('\n')[1], 'Fast checks');
  });
});
