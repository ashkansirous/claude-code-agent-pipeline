// node --test skills/run-wave/batch-release.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, cpSync, rmSync, existsSync, symlinkSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseOn, wouldRunOnPush, globToRegExp, repoSlug, workerFilesChanged, realHookUrl, realPostHook } from './batch-release.mjs';

// Slice 30 item K: the machine-wide git config (LFS filters, credential manager, autocrlf) is read by every git call and costs about a
// third of its time on Windows; the fixture repos need none of it.
process.env.GIT_CONFIG_NOSYSTEM = '1';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');
const PUSH_MAIN = 'on:\n  push:\n    branches: [main]\n';
const NOT_FOUND = 'not found';

let base;
before(() => { base = mkdtempSync(join(tmpdir(), 'batch-release-')); });
after(() => rmSync(base, { recursive: true, force: true }));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

// A repo named `name` with a bare origin on a github-looking URL (rewritten with url.insteadOf), main holding `files`.
// Slice 30 item K: most tests start from one of a few file sets, so the first repo built for a file set is kept as a template and
// every later one is a folder copy (six git calls saved) plus one `remote set-url`.
const templates = new Map();

function makeRepo(name, files) {
  const key = JSON.stringify(files);
  if (!templates.has(key)) templates.set(key, buildRepo(`template-${templates.size}`, files));
  const template = templates.get(key);
  const origin = join(base, `${name}-origin.git`);
  const repo = join(base, name);
  cpSync(template.origin, origin, { recursive: true });
  cpSync(template.repo, repo, { recursive: true });
  git(repo, 'remote', 'set-url', 'origin', origin);
  return { repo, origin, state: join(base, `${name}-worktrees`, 'batch-release.json') };
}

function buildRepo(name, files) {
  const origin = join(base, `${name}-origin.git`);
  const repo = join(base, name);
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFiles(repo, files);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  return { repo, origin, state: join(base, `${name}-worktrees`, 'batch-release.json') };
}

function writeFiles(repo, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

function merge(setup, files) {
  writeFiles(setup.repo, files);
  git(setup.repo, 'add', '.');
  git(setup.repo, 'commit', '-qm', 'merge');
  git(setup.repo, 'push', '-q', 'origin', 'main');
}

// Real git, except the remote URL, which is faked so owner/name can be read.
function realGitWithSlug(repo, args) {
  if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/o/r.git';
  return git(repo, ...args);
}

// A fake gh recording every call. runStdout is what `gh workflow run` prints.
function fakeGh({ runStdout = (f) => `https://github.com/o/r/actions/runs/${f.length}\n`, view = {}, watchStatus = 0, watchSpawnError = false, watchStderr = '', list = [], gone = [], repoReachable = true } = {}) {
  const calls = [];
  const gh = (args, options) => {
    calls.push(args);
    if (args[0] === 'workflow') return { status: 0, stdout: runStdout(args[2]), stderr: '' };
    if (args[0] === 'run' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(list), stderr: '' };
    if (args[0] === 'run' && args[1] === 'watch') return { status: watchStatus, stdout: '', stderr: watchStatus === null && watchSpawnError ? 'spawn gh ENOENT' : watchStderr, timedOut: watchStatus === null && !watchSpawnError };
    if (args[0] === 'api') return { status: repoReachable ? 0 : 1, stdout: 'o/r\n', stderr: repoReachable ? '' : 'HTTP 404: Not Found' };
    if (args[0] === 'run' && args[1] === 'view' && gone.includes(args[2])) return { status: 1, stdout: '', stderr: 'failed to get run: HTTP 404: Not Found' };
    if (args[0] === 'run' && args[1] === 'view') return { status: 0, stdout: JSON.stringify(view[args[2]] ?? { status: 'completed', conclusion: 'success', jobs: [{}] }), stderr: '' };
    return { status: 1, stdout: '', stderr: NOT_FOUND };
  };
  return { gh, calls };
}

async function run(argv, deps = {}) {
  const lines = [];
  // Never a real deploy hook or wrangler call from a test: no hook URL unless a test gives one.
  const code = await main(argv, { git: realGitWithSlug, sleep: async () => {}, out: (l) => lines.push(l), hookUrl: () => null, postHook: async () => { throw new Error('a test posted a real hook'); }, ...deps });
  return { code, lines };
}

const workflows = (map) => Object.fromEntries(Object.entries(map).map(([name, text]) => [`.github/workflows/${name}`, text]));

// ---- parsing the on: block, on the real files ----

test('real RTST release.yml: push to main with a path list, dispatch, ignores Dino content', () => {
  const parsed = parseOn(fixture('rtst-release.yml'));
  assert.equal(parsed.dispatch, true);
  assert.ok(wouldRunOnPush(parsed, ['src/App.cs']));
  assert.ok(!wouldRunOnPush(parsed, ['content/dino/book/page.md']));
  assert.ok(wouldRunOnPush(parsed, ['content/dino/book/page.md', 'README.md']));
});

test('real RTST dino-store.yml: only its paths start it, schedule is not a push', () => {
  const parsed = parseOn(fixture('rtst-dino-store.yml'));
  assert.equal(parsed.dispatch, true);
  assert.ok(wouldRunOnPush(parsed, ['content/dino/x.md']));
  assert.ok(!wouldRunOnPush(parsed, ['src/App.cs']));
});

test('real print-the-damn-book files: ci runs on every push, site only for site/**, release is tags-only', () => {
  const ci = parseOn(fixture('ptdb-ci.yml'));
  assert.ok(wouldRunOnPush(ci, ['anything.txt']));
  assert.equal(ci.dispatch, false);
  assert.ok(wouldRunOnPush(parseOn(fixture('ptdb-site.yml')), ['site/index.html']));
  assert.ok(!wouldRunOnPush(parseOn(fixture('ptdb-site.yml')), ['src/a.cs']));
  assert.ok(!wouldRunOnPush(parseOn(fixture('ptdb-release.yml')), ['src/a.cs']));
});

test('real ExampleApp release.yml: runs on a push to main and has no workflow_dispatch', () => {
  const parsed = parseOn(fixture('example-release.yml'));
  assert.equal(parsed.dispatch, false);
  assert.ok(wouldRunOnPush(parsed, ['worker/a.ts']));
});

test('on: forms: scalar, list, paths-ignore, branches-ignore, other branch, unreadable', () => {
  assert.ok(wouldRunOnPush(parseOn('on: push\n'), ['a']));
  assert.ok(wouldRunOnPush(parseOn('on: [push, pull_request]\n'), ['a']));
  assert.ok(!wouldRunOnPush(parseOn('on:\n  pull_request:\n'), ['a']));
  const ignore = parseOn(`${PUSH_MAIN}    paths-ignore:\n      - 'docs/**'\n      - '*.md'\n`);
  assert.ok(!wouldRunOnPush(ignore, ['docs/a/b.txt', 'README.md']));
  assert.ok(wouldRunOnPush(ignore, ['docs/a.txt', 'src/x.cs']));
  assert.ok(!wouldRunOnPush(parseOn('on:\n  push:\n    branches-ignore: [main]\n'), ['a']));
  assert.ok(!wouldRunOnPush(parseOn('on:\n  push:\n    branches:\n      - develop\n'), ['a']));
  assert.ok(wouldRunOnPush(parseOn('name: x\n'), ['a']));
  assert.ok(wouldRunOnPush(parseOn("'on':\n  push:\n    branches: [main]\n  workflow_dispatch:\n"), ['a']));
});

test('globs: ** crosses folders, * does not, ! removes', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.cs'));
  assert.ok(globToRegExp('**/*.md').test('a/b/c.md'));
  assert.ok(globToRegExp('**/*.md').test('c.md'));
  assert.ok(!globToRegExp('*.md').test('a/c.md'));
});

test('workerFilesChanged: ! globs remove files, later globs win', () => {
  const paths = ['worker/**', '!worker/**/*.md', 'site/**'];
  assert.deepEqual(workerFilesChanged(['worker/CLAUDE.md', 'worker/index.ts', 'site/a.md', 'docs/x.ts'], paths), ['worker/index.ts', 'site/a.md']);
  assert.deepEqual(workerFilesChanged(['worker/CLAUDE.md'], paths), []);
  assert.deepEqual(workerFilesChanged(['worker/CLAUDE.md'], ['worker/**']), ['worker/CLAUDE.md']);
});

test('repoSlug reads https and ssh remotes', () => {
  assert.equal(repoSlug('https://github.com/o/r.git\n'), 'o/r');
  assert.equal(repoSlug('git@github.com:o/r.git'), 'o/r');
});

// ---- start / due / release / watch ----

test('start records origin/main once and keeps an open batch', async () => {
  const setup = makeRepo('start', workflows({ 'ci.yml': PUSH_MAIN }));
  const first = await run(['start', setup.repo]);
  const sha = git(setup.repo, 'rev-parse', 'origin/main');
  assert.equal(JSON.parse(readFileSync(setup.state, 'utf8')).baseSha, sha);
  merge(setup, { 'a.txt': 'x' });
  const second = await run(['start', setup.repo]);
  assert.equal(JSON.parse(readFileSync(setup.state, 'utf8')).baseSha, sha);
  assert.match(second.lines[0], /already open/);
  assert.equal(first.code, 0);
});

test('due: not due before the limit, due after it, counted from the last release', async () => {
  const setup = makeRepo('due', workflows({ 'ci.yml': PUSH_MAIN }));
  assert.equal((await run(['due', setup.repo, '--hours', '6'])).code, 1);
  await run(['start', setup.repo], { now: () => new Date('2026-11-06T00:00:00Z') });
  assert.equal((await run(['due', setup.repo, '--hours', '6'], { now: () => new Date('2026-11-06T05:59:00Z') })).code, 1);
  assert.equal((await run(['due', setup.repo, '--hours', '6'], { now: () => new Date('2026-11-06T06:01:00Z') })).code, 0);
  writeFileSync(setup.state, JSON.stringify({ startedAt: '2026-11-06T00:00:00Z', lastReleaseAt: '2026-11-06T06:00:00Z' }));
  assert.equal((await run(['due', setup.repo, '--hours', '6'], { now: () => new Date('2026-11-06T07:00:00Z') })).code, 1);
});

test('release with nothing merged since the base dispatches nothing', async () => {
  const setup = makeRepo('nothing', workflows({ 'ci.yml': PUSH_MAIN + '  workflow_dispatch:\n' }));
  await run(['start', setup.repo]);
  const { gh, calls } = fakeGh();
  const result = await run(['release', setup.repo], { gh });
  assert.equal(result.code, 0);
  assert.match(result.lines[0], /nothing merged/);
  assert.equal(calls.length, 0);
});

test('release dispatches only workflows whose push filters match the changed files, records run ids, clears the base', async () => {
  const setup = makeRepo('rtst', workflows({
    'release.yml': fixture('rtst-release.yml'), 'dino-store.yml': fixture('rtst-dino-store.yml'), 'ptdb-release.yml': fixture('ptdb-release.yml'),
  }));
  await run(['start', setup.repo]);
  merge(setup, { 'content/dino/book/page.md': 'x' });
  const { gh, calls } = fakeGh();
  const result = await run(['release', setup.repo], { gh });
  assert.equal(result.code, 0);
  const dispatched = calls.filter((c) => c[0] === 'workflow').map((c) => c[2]);
  assert.deepEqual(dispatched, ['dino-store.yml']);
  assert.ok(calls[0].includes('--ref') && calls[0].includes('main') && calls[0].includes('o/r'));
  const state = JSON.parse(readFileSync(setup.state, 'utf8'));
  assert.equal(state.baseSha, null);
  assert.equal(state.lastReleasedSha, git(setup.repo, 'rev-parse', 'origin/main'));
  assert.deepEqual(state.runs, [{ workflow: 'dino-store.yml', runId: String('dino-store.yml'.length) }]);
  assert.equal(JSON.parse(result.lines[0]).released, true);
});

const WORKER_CONFIG = { '.claude/merge-gate.json': JSON.stringify({ workerPaths: ['worker/**', 'site/**', 'wrangler*.jsonc'] }) };

test('release reports "Worker not deployed" when the batch changed a Worker watch path, and again when nothing new merged', async () => {
  const setup = makeRepo('worker', { ...workflows({ 'ci.yml': PUSH_MAIN + '  workflow_dispatch:\n' }), ...WORKER_CONFIG });
  await run(['start', setup.repo]);
  merge(setup, { 'worker/index.ts': 'x', 'docs/a.md': 'y' });
  const first = JSON.parse((await run(['release', setup.repo], { gh: fakeGh().gh })).lines[0]);
  assert.equal(first.workerNotDeployed, true);
  assert.deepEqual(first.workerFiles, ['worker/index.ts']);
  assert.match(first.workerNote, /^Worker not deployed/);
  assert.deepEqual(JSON.parse(readFileSync(setup.state, 'utf8')).workerNotDeployed.files, ['worker/index.ts']);
  const second = JSON.parse((await run(['release', setup.repo], { gh: fakeGh().gh })).lines[0]);
  assert.equal(second.released, false);
  assert.equal(second.workerNotDeployed, true);
  // A later release that merged only non-Worker files still reports it (same fields as the nothing-merged branch) until cleared.
  await run(['start', setup.repo]);
  merge(setup, { 'docs/b.md': 'z' });
  const third = JSON.parse((await run(['release', setup.repo], { gh: fakeGh().gh })).lines[0]);
  assert.equal(third.released, true);
  assert.equal(third.workerNotDeployed, true);
  assert.deepEqual(third.workerFiles, ['worker/index.ts']);
  // Finding 7: a second Worker release adds its files; the first release's file stays listed.
  await run(['start', setup.repo]);
  merge(setup, { 'worker/other.ts': 'q' });
  const fourth = JSON.parse((await run(['release', setup.repo], { gh: fakeGh().gh })).lines[0]);
  assert.deepEqual([...fourth.workerFiles].sort(), ['worker/index.ts', 'worker/other.ts']);
  const cleared = await run(['worker-deployed', setup.repo]);
  assert.match(cleared.lines[0], /deployed/);
  assert.equal(JSON.parse(readFileSync(setup.state, 'utf8')).workerNotDeployed, undefined);
  const after = JSON.parse((await run(['release', setup.repo], { gh: fakeGh().gh })).lines[0]);
  assert.equal(after.workerNotDeployed, undefined);
});

// Slice 29 item 29: after a deploy the plan.md lines that still promise "the next batched release" are listed for the caller to rewrite.
test('worker-deployed lists the plan.md lines that still say "with the next batched release"', async () => {
  const plan = '# Plan\n| 34 | goes live with the next batched release |\n| 35 | built |\nSlice 36 ships With The Next Batched Release.\n';
  const setup = makeRepo('staleplan', { 'plan.md': plan, ...workflows({ 'ci.yml': PUSH_MAIN }) });
  const at = new Date('2026-11-19T10:00:00Z');
  const result = await run(['worker-deployed', setup.repo], { now: () => at });
  assert.equal(result.lines[0], 'worker marked deployed');
  assert.deepEqual(result.lines.slice(1), [
    'check, then rewrite with "deployed 2026-11-19T10:00:00.000Z" if the Worker change shipped it: origin/main plan.md 2: | 34 | goes live with the next batched release |',
    'check, then rewrite with "deployed 2026-11-19T10:00:00.000Z" if the Worker change shipped it: origin/main plan.md 4: Slice 36 ships With The Next Batched Release.',
  ]);
});

test('worker-deployed prints only its own line when plan.md holds no such line', async () => {
  const setup = makeRepo('cleanplan', { 'plan.md': '# Plan\nall live\n', ...workflows({ 'ci.yml': PUSH_MAIN }) });
  const result = await run(['worker-deployed', setup.repo]);
  assert.deepEqual(result.lines, ['worker marked deployed']);
});

// RTST Slice 354 item 18 / Slice 377 item 1: the deploy hook is called for a batch with a Worker change, and `watch` only prints the recorded hook outcome once (the reader confirms the deploy in Cloudflare).
const HOOK_URL = 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/secret-id';

async function workerBatch(name) {
  const setup = makeRepo(name, { ...workflows({ 'ci.yml': PUSH_MAIN + '  workflow_dispatch:\n' }), ...WORKER_CONFIG });
  await run(['start', setup.repo]);
  merge(setup, { 'worker/index.ts': 'x' });
  return setup;
}

test('a batch with a worker/ change posts the deploy hook; watch prints the outcome once and keeps the warning', async () => {
  const setup = await workerBatch('hookok');
  const posted = [];
  const hookAt = new Date('2026-11-14T10:00:00Z');
  const deps = { gh: fakeGh().gh, hookUrl: () => HOOK_URL, postHook: async (url) => { posted.push(url); return { ok: true, status: 200, buildUuid: 'b-1' }; }, now: () => hookAt };
  const released = JSON.parse((await run(['release', setup.repo], deps)).lines[0]);
  assert.deepEqual(posted, [HOOK_URL]);
  assert.equal(released.workerNotDeployed, true);
  assert.equal(released.workerHook, 'started');
  assert.ok(!JSON.stringify(released).includes('secret-id'), 'the hook URL is never printed');
  const watched = await run(['watch', setup.repo], { gh: fakeGh().gh, now: () => new Date('2026-11-14T10:01:00Z') });
  assert.equal(watched.code, 0);
  assert.match(watched.lines.join('\n'), /Worker deploy hook called at 2026-11-14T10:00:00.000Z: Workers Builds started; confirm the deployment in Cloudflare/);
  assert.equal(JSON.parse(readFileSync(setup.state, 'utf8')).workerNotDeployed.files[0], 'worker/index.ts', 'watch never clears the warning');
  const again = await run(['watch', setup.repo], { gh: fakeGh().gh });
  assert.ok(!again.lines.join('\n').includes('Worker deploy hook'), 'the hook outcome is printed once');
});

test('no hook URL or a failing hook keeps the warning and says so, in release and in watch', async () => {
  const noUrl = await workerBatch('hooknourl');
  const first = JSON.parse((await run(['release', noUrl.repo], { gh: fakeGh().gh })).lines[0]);
  assert.equal(first.workerHook, 'no hook url');
  const watchedNoUrl = await run(['watch', noUrl.repo], { gh: fakeGh().gh });
  assert.equal(watchedNoUrl.code, 0, 'a missing hook URL is a warning in release, not a watch failure');
  const failing = await workerBatch('hookfail');
  const second = JSON.parse((await run(['release', failing.repo], { gh: fakeGh().gh, hookUrl: () => HOOK_URL, postHook: async () => ({ ok: false, status: 401 }) })).lines[0]);
  assert.equal(second.workerHook, 'failed');
  assert.match(second.workerHookError, /HTTP 401/);
  assert.equal(second.workerNotDeployed, true);
});

test('a hook step that throws is recorded as failed and the dispatched runs are saved first', async () => {
  const setup = await workerBatch('hookthrow');
  const out = await run(['release', setup.repo], { gh: fakeGh().gh, hookUrl: () => { throw new Error('EACCES: secrets.env https://hooks.example/secret-id'); } });
  const report = JSON.parse(out.lines[0]);
  assert.equal(report.workerHook, 'failed');
  assert.ok(!JSON.stringify(report).includes('secret-id'));
  const state = readFileSync(setup.state, 'utf8');
  assert.ok(JSON.parse(state).runs.length > 0, 'the dispatched runs are in the state');
});

test('a retry release for the same head does not post the hook again once it started', async () => {
  const setup = await workerBatch('hookretry');
  const posted = [];
  const deps = { gh: fakeGh().gh, hookUrl: () => HOOK_URL, postHook: async (url) => { posted.push(url); return { ok: true, status: 200 }; } };
  const first = await run(['release', setup.repo], { ...deps, gh: fakeGh({ runStdout: () => 'no run id' }).gh });
  assert.equal(first.code, 2, 'the first release has a dispatch error, so its base is kept');
  const second = JSON.parse((await run(['release', setup.repo], deps)).lines[0]);
  assert.equal(second.released, true);
  assert.equal(second.workerHook, 'started');
  assert.equal(posted.length, 1);
});

test('a failed hook is reported by watch as a warning, exit 0, and the hook error never carries the URL', async () => {
  const setup = await workerBatch('hookfail2');
  const out = JSON.parse((await run(['release', setup.repo], { gh: fakeGh().gh, hookUrl: () => HOOK_URL, postHook: async () => ({ ok: false, status: 0, error: 'the deploy hook request failed (TypeError; the URL is not shown)' }) })).lines[0]);
  assert.ok(!JSON.stringify(out).includes('secret-id'));
  const watched = await run(['watch', setup.repo], { gh: fakeGh().gh });
  assert.equal(watched.code, 0);
  assert.match(watched.lines.join('\n'), /hook failed/);
});

test('the hook URL reader handles quotes, an export prefix and a BOM', () => {
  const dir = mkdtempSync(join(base, 'secrets-q-'));
  mkdirSync(join(dir, 'myrepo'));
  const file = join(dir, 'myrepo', 'secrets.env');
  for (const line of [`CF_WORKER_DEPLOY_HOOK_URL="${HOOK_URL}"`, `export CF_WORKER_DEPLOY_HOOK_URL='${HOOK_URL}'`, `﻿CF_WORKER_DEPLOY_HOOK_URL=${HOOK_URL}`]) {
    writeFileSync(file, `${line}\r\n`);
    assert.equal(realHookUrl({ name: 'MyRepo' }, { SECRETS_DIR: dir }), HOOK_URL, line);
  }
});

test('a malformed hook URL never appears in the error realPostHook returns', async () => {
  const result = await realPostHook('"https://example.invalid/secret-id"');
  assert.equal(result.ok, false);
  assert.ok(!result.error.includes('secret-id'));
});

test('a batch with no Worker change never posts the hook', async () => {
  const setup = makeRepo('hooknone', { ...workflows({ 'ci.yml': PUSH_MAIN + '  workflow_dispatch:\n' }), ...WORKER_CONFIG });
  await run(['start', setup.repo]);
  merge(setup, { 'docs/a.md': 'y' });
  const out = JSON.parse((await run(['release', setup.repo], { gh: fakeGh().gh, hookUrl: () => HOOK_URL })).lines[0]);
  assert.equal(out.workerHook, undefined);
});

test('the hook URL comes from the environment, else from the secrets store file of the repo', () => {
  const dir = mkdtempSync(join(base, 'secrets-'));
  mkdirSync(join(dir, 'myrepo'));
  writeFileSync(join(dir, 'myrepo', 'secrets.env'), `# note\nOTHER=1\nCF_WORKER_DEPLOY_HOOK_URL=${HOOK_URL}\n`);
  const ctx = { name: 'MyRepo' };
  assert.equal(realHookUrl(ctx, { SECRETS_DIR: dir }), HOOK_URL);
  assert.equal(realHookUrl(ctx, { CF_WORKER_DEPLOY_HOOK_URL: 'https://env/hook', SECRETS_DIR: dir }), 'https://env/hook');
  assert.equal(realHookUrl({ name: 'Other' }, { SECRETS_DIR: dir }), null);
});

test('a repo that declares no workerPaths gets no Worker warning, even for site/** and package.json changes', async () => {
  const setup = makeRepo('noconfig', workflows({ 'ci.yml': PUSH_MAIN + '  workflow_dispatch:\n' }));
  await run(['start', setup.repo]);
  merge(setup, { 'site/index.html': 'x', 'package.json': '{}', 'worker/index.ts': 'y' });
  const out = JSON.parse((await run(['release', setup.repo], { gh: fakeGh().gh })).lines[0]);
  assert.equal(out.workerNotDeployed, undefined);
});

test('every start resets batchStartedAt (the age merge-gate reads), a new batch or an open one', async () => {
  const setup = makeRepo('age', workflows({ 'ci.yml': PUSH_MAIN + '  workflow_dispatch:\n' }));
  await run(['start', setup.repo], { now: () => new Date('2026-11-01T00:00:00Z') });
  assert.equal(JSON.parse(readFileSync(setup.state, 'utf8')).batchStartedAt, '2026-11-01T00:00:00.000Z');
  await run(['start', setup.repo], { now: () => new Date('2026-11-08T00:00:00Z') });
  const state = JSON.parse(readFileSync(setup.state, 'utf8'));
  assert.equal(state.batchStartedAt, '2026-11-08T00:00:00.000Z');
  assert.equal(state.startedAt, '2026-11-01T00:00:00.000Z');
});

test('release says nothing about the Worker when the batch touched no Worker path', async () => {
  const setup = makeRepo('noworker', { ...workflows({ 'ci.yml': PUSH_MAIN + '  workflow_dispatch:\n' }), ...WORKER_CONFIG });
  await run(['start', setup.repo]);
  merge(setup, { 'docs/a.md': 'y', 'src/worker/x.cs': 'z' });
  const out = JSON.parse((await run(['release', setup.repo], { gh: fakeGh().gh })).lines[0]);
  assert.equal(out.workerNotDeployed, undefined);
});

test('a matching workflow without workflow_dispatch is an error naming the file; the others still run', async () => {
  const setup = makeRepo('nodispatch', workflows({ 'ci.yml': fixture('ptdb-ci.yml'), 'site.yml': fixture('ptdb-site.yml') }));
  await run(['start', setup.repo]);
  merge(setup, { 'site/index.html': 'x' });
  const { gh, calls } = fakeGh();
  const result = await run(['release', setup.repo], { gh });
  assert.equal(result.code, 2);
  const out = JSON.parse(result.lines[0]);
  assert.match(out.errors[0], /ci\.yml.*no workflow_dispatch/);
  assert.deepEqual(calls.filter((c) => c[0] === 'workflow').map((c) => c[2]), ['site.yml']);
});

test('the run id comes from gh run list when gh prints no URL', async () => {
  const setup = makeRepo('listid', workflows({ 'ci.yml': PUSH_MAIN + '  workflow_dispatch:\n' }));
  await run(['start', setup.repo]);
  merge(setup, { 'a.txt': 'x' });
  const now = new Date('2026-11-06T10:00:00Z');
  const { gh } = fakeGh({ runStdout: () => 'Created workflow_dispatch event\n', list: [{ databaseId: 41, createdAt: '2026-11-06T09:59:50Z' }, { databaseId: 40, createdAt: '2026-11-05T01:00:00Z' }] });
  await run(['release', setup.repo], { gh, now: () => now });
  assert.equal(JSON.parse(readFileSync(setup.state, 'utf8')).runs[0].runId, '41');
});

test('release run in a repo whose crashed earlier batch is still open covers the older merges too', async () => {
  const setup = makeRepo('crashed', workflows({ 'ci.yml': PUSH_MAIN + '  workflow_dispatch:\n    \n' }));
  await run(['start', setup.repo]);
  merge(setup, { 'a.txt': '1' });
  await run(['start', setup.repo]);
  merge(setup, { 'b.txt': '2' });
  const { gh, calls } = fakeGh();
  await run(['release', setup.repo], { gh });
  assert.equal(calls.filter((c) => c[0] === 'workflow').length, 1);
});

test('watch prints each conclusion and exits 0 when all succeeded', async () => {
  const setup = makeRepo('watch-ok', workflows({ 'ci.yml': PUSH_MAIN }));
  mkdirSync(dirname(setup.state), { recursive: true });
  writeFileSync(setup.state, JSON.stringify({ runs: [{ workflow: 'release.yml', runId: '7' }] }));
  const { gh } = fakeGh();
  const result = await run(['watch', setup.repo], { gh });
  assert.equal(result.code, 0);
  assert.match(result.lines[0], /release\.yml run 7: conclusion success/);
  assert.deepEqual(JSON.parse(readFileSync(setup.state, 'utf8')).runs, []);
});

test('runs nobody watched yet stay on the list when the next release adds its own', async () => {
  const setup = makeRepo('keep-runs', workflows({ 'ci.yml': PUSH_MAIN + '  workflow_dispatch:\n' }));
  await run(['start', setup.repo]);
  merge(setup, { 'a.txt': '1' });
  const { gh } = fakeGh({ runStdout: () => 'https://github.com/o/r/actions/runs/11\n' });
  await run(['release', setup.repo], { gh });
  await run(['start', setup.repo]);
  merge(setup, { 'b.txt': '2' });
  const second = fakeGh({ runStdout: () => 'https://github.com/o/r/actions/runs/12\n' });
  await run(['release', setup.repo], { gh: second.gh });
  const ids = JSON.parse(readFileSync(setup.state, 'utf8')).runs.map((r) => r.runId);
  assert.deepEqual(ids, ['11', '12']);
});

test('watch calls a failure with no jobs "main is broken" and exits 1', async () => {
  const setup = makeRepo('watch-bad', workflows({ 'ci.yml': PUSH_MAIN }));
  mkdirSync(dirname(setup.state), { recursive: true });
  writeFileSync(setup.state, JSON.stringify({ runs: [{ workflow: 'release.yml', runId: '7' }, { workflow: 'b.yml', runId: '8' }] }));
  const { gh } = fakeGh({ watchStatus: 1, view: { 7: { status: 'completed', conclusion: 'startup_failure', jobs: [] }, 8: { status: 'completed', conclusion: 'failure', jobs: [{}] } } });
  const result = await run(['watch', setup.repo], { gh });
  assert.equal(result.code, 1);
  assert.match(result.lines[0], /conclusion startup_failure - main is broken/);
  assert.doesNotMatch(result.lines[1], /broken/);
});

test('watch past --max-minutes reports the run as still running and exits 3', async () => {
  const setup = makeRepo('watch-slow', workflows({ 'ci.yml': PUSH_MAIN }));
  mkdirSync(dirname(setup.state), { recursive: true });
  writeFileSync(setup.state, JSON.stringify({ runs: [{ workflow: 'release.yml', runId: '7' }] }));
  const { gh } = fakeGh({ watchStatus: null, view: { 7: { status: 'in_progress', conclusion: null, jobs: [{}] } } });
  const result = await run(['watch', setup.repo, '--max-minutes', '5'], { gh });
  assert.equal(result.code, 3);
  assert.match(result.lines.join('\n'), /conclusion in_progress/);
  assert.match(result.lines.join('\n'), /still running after 5 minutes/);
  assert.ok(existsSync(setup.state));
});

// ---- review fixes ----

const DISPATCHABLE = PUSH_MAIN + '  workflow_dispatch:\n';
const readState = (setup) => JSON.parse(readFileSync(setup.state, 'utf8'));

test('a dispatch whose run id cannot be found is an error naming the workflow, is not stored, and watch never sees null', async () => {
  const setup = makeRepo('noid', workflows({ 'ci.yml': DISPATCHABLE }));
  await run(['start', setup.repo]);
  merge(setup, { 'a.txt': 'x' });
  const { gh } = fakeGh({ runStdout: () => 'Created workflow_dispatch event\n', list: [] });
  const result = await run(['release', setup.repo], { gh });
  assert.equal(result.code, 2);
  assert.match(JSON.parse(result.lines[0]).errors[0], /ci\.yml.*run id/);
  assert.deepEqual(readState(setup).runs, []);
  assert.equal((await run(['watch', setup.repo], { gh })).code, 0);
});

test('a failed dispatch keeps the base; the next release retries only what is missing, then clears', async () => {
  const setup = makeRepo('retry', workflows({ 'a.yml': DISPATCHABLE, 'b.yml': DISPATCHABLE }));
  await run(['start', setup.repo]);
  const base = readState(setup).baseSha;
  merge(setup, { 'x.txt': '1' });
  const flaky = fakeGh();
  const failB = (args, o) => (args[0] === 'workflow' && args[2] === 'b.yml' ? { status: 1, stdout: '', stderr: 'HTTP 502' } : flaky.gh(args, o));
  const first = await run(['release', setup.repo], { gh: failB });
  assert.equal(first.code, 2);
  assert.equal(readState(setup).baseSha, base);
  const second = fakeGh();
  const result = await run(['release', setup.repo], { gh: second.gh });
  assert.equal(result.code, 0);
  assert.deepEqual(second.calls.filter((c) => c[0] === 'workflow').map((c) => c[2]), ['b.yml']);
  assert.equal(readState(setup).baseSha, null);
  assert.deepEqual(readState(setup).runs.map((r) => r.workflow).sort(), ['a.yml', 'b.yml']);
});

test('a workflow without workflow_dispatch keeps the base so it is reported again, not forgotten', async () => {
  const setup = makeRepo('keepbase', workflows({ 'ci.yml': fixture('ptdb-ci.yml') }));
  await run(['start', setup.repo]);
  merge(setup, { 'a.txt': 'x' });
  const result = await run(['release', setup.repo], { gh: fakeGh().gh });
  assert.equal(result.code, 2);
  assert.ok(readState(setup).baseSha);
  assert.equal((await run(['release', setup.repo], { gh: fakeGh().gh })).code, 2);
});

test('release with no base falls back to lastReleasedSha, and says nothing merged only when main did not move', async () => {
  const setup = makeRepo('nobase', workflows({ 'ci.yml': DISPATCHABLE }));
  const head = git(setup.repo, 'rev-parse', 'origin/main');
  mkdirSync(dirname(setup.state), { recursive: true });
  writeFileSync(setup.state, JSON.stringify({ lastReleasedSha: head }));
  assert.match((await run(['release', setup.repo], { gh: fakeGh().gh })).lines[0], /nothing merged/);
  merge(setup, { 'a.txt': 'x' });
  const { gh, calls } = fakeGh();
  const result = await run(['release', setup.repo], { gh });
  assert.equal(JSON.parse(result.lines[0]).released, true);
  assert.equal(calls.filter((c) => c[0] === 'workflow').length, 1);
});

test('release with neither base nor lastReleasedSha treats every push workflow as matching and says so', async () => {
  const setup = makeRepo('neither', workflows({ 'site.yml': fixture('ptdb-site.yml') + '  workflow_dispatch:\n', 'dispatch-only.yml': 'on:\n  workflow_dispatch:\n' }));
  merge(setup, { 'other.txt': 'x' });
  const { gh, calls } = fakeGh();
  const result = await run(['release', setup.repo], { gh });
  const out = JSON.parse(result.lines[0]);
  assert.equal(out.released, true);
  assert.match(out.note, /no base recorded/);
  assert.deepEqual(calls.filter((c) => c[0] === 'workflow').map((c) => c[2]), ['site.yml']);
});

test('on: block as a dash list or an inline map is read (list) or counted as would-run (map)', () => {
  assert.deepEqual(parseOn('on:\n  - push\n  - workflow_dispatch\n'), { push: {}, dispatch: true });
  assert.ok(!wouldRunOnPush(parseOn('on:\n  - pull_request\n'), ['a']));
  assert.ok(wouldRunOnPush(parseOn('on: { push: { branches: [main] }, workflow_dispatch: {} }\n'), ['a']));
});

test('globs: ? and + and character classes follow GitHub filter patterns, a bad pattern never throws', () => {
  assert.ok(globToRegExp('file?.txt').test('file.txt'));
  assert.ok(globToRegExp('file?.txt').test('fil.txt'));
  assert.ok(!globToRegExp('file?.txt').test('fileA.txt'));
  assert.ok(globToRegExp('ab+c').test('abbbc'));
  assert.ok(globToRegExp('[ab]x').test('ax'));
  assert.ok(globToRegExp('[unclosed').test('anything'));
});

test('due counts from the later of the last release and the start of this run, not an older night', async () => {
  const setup = makeRepo('runstart', workflows({ 'ci.yml': PUSH_MAIN }));
  mkdirSync(dirname(setup.state), { recursive: true });
  writeFileSync(setup.state, JSON.stringify({ startedAt: '2026-11-01T00:00:00Z', lastReleaseAt: '2026-11-02T00:00:00Z', baseSha: 'abc' }));
  const now = () => new Date('2026-11-06T01:00:00Z');
  assert.equal((await run(['due', setup.repo, '--hours', '6'], { now })).code, 0);
  await run(['start', setup.repo, '--run-start'], { now });
  assert.equal((await run(['due', setup.repo, '--hours', '6'], { now: () => new Date('2026-11-06T05:00:00Z') })).code, 1);
  assert.equal((await run(['due', setup.repo, '--hours', '6'], { now: () => new Date('2026-11-06T07:30:00Z') })).code, 0);
});

test('watch with no recorded runs is a no-op that exits 0', async () => {
  const setup = makeRepo('watch-none', workflows({ 'ci.yml': PUSH_MAIN }));
  const result = await run(['watch', setup.repo], { gh: fakeGh().gh });
  assert.equal(result.code, 0);
  assert.match(result.lines[0], /no runs to watch/);
});

test('a worktree path uses the primary checkout state file', async () => {
  const setup = makeRepo('wt', workflows({ 'ci.yml': PUSH_MAIN }));
  const tree = join(base, 'wt-tree');
  git(setup.repo, 'worktree', 'add', '-q', '-b', 'side', tree);
  await run(['start', tree]);
  assert.ok(existsSync(setup.state));
  assert.ok(!existsSync(join(base, 'wt-tree-worktrees')));
  assert.ok(readState(setup).baseSha);
});

// ---- medium review fixes ----

test('after an error, new merges (a newer head) dispatch every matching workflow again, including ones that ran before', async () => {
  const setup = makeRepo('newhead', workflows({ 'a.yml': DISPATCHABLE, 'b.yml': fixture('ptdb-ci.yml') }));
  await run(['start', setup.repo]);
  merge(setup, { 'x.txt': '1' });
  const first = fakeGh();
  assert.equal((await run(['release', setup.repo], { gh: first.gh })).code, 2);
  assert.deepEqual(first.calls.filter((c) => c[0] === 'workflow').map((c) => c[2]), ['a.yml']);
  const same = fakeGh();
  await run(['release', setup.repo], { gh: same.gh });
  assert.equal(same.calls.filter((c) => c[0] === 'workflow').length, 0);
  merge(setup, { 'y.txt': '2' });
  const later = fakeGh();
  await run(['release', setup.repo], { gh: later.gh });
  assert.deepEqual(later.calls.filter((c) => c[0] === 'workflow').map((c) => c[2]), ['a.yml']);
});

test('a failed run stays in the state after watch, so the next watch still reports it; a green one leaves', async () => {
  const setup = makeRepo('watch-keep', workflows({ 'ci.yml': PUSH_MAIN }));
  mkdirSync(dirname(setup.state), { recursive: true });
  writeFileSync(setup.state, JSON.stringify({ runs: [{ workflow: 'bad.yml', runId: '7' }, { workflow: 'good.yml', runId: '8' }] }));
  const { gh } = fakeGh({ watchStatus: 1, view: { 7: { status: 'completed', conclusion: 'failure', jobs: [{}] } } });
  assert.equal((await run(['watch', setup.repo], { gh })).code, 1);
  assert.deepEqual(readState(setup).runs, [{ workflow: 'bad.yml', runId: '7' }]);
  const again = await run(['watch', setup.repo], { gh });
  assert.equal(again.code, 1);
  assert.match(again.lines[0], /bad\.yml run 7: conclusion failure/);
});

test('watch --clear-failed reports every run, then drops finished runs (failed included) and keeps unfinished ones', async () => {
  const setup = makeRepo('watch-clear', workflows({ 'ci.yml': PUSH_MAIN }));
  mkdirSync(dirname(setup.state), { recursive: true });
  writeFileSync(setup.state, JSON.stringify({ runs: [{ workflow: 'bad.yml', runId: '7' }, { workflow: 'good.yml', runId: '8' }, { workflow: 'slow.yml', runId: '9' }] }));
  const { gh } = fakeGh({ watchStatus: 1, view: { 7: { status: 'completed', conclusion: 'failure', jobs: [{}] }, 9: { status: 'in_progress', conclusion: null, jobs: [{}] } } });
  const first = await run(['watch', setup.repo, '--clear-failed'], { gh });
  assert.equal(first.code, 1);
  assert.ok(first.lines.some((l) => /bad\.yml run 7: conclusion failure/.test(l)), first.lines.join(' | '));
  assert.deepEqual(readState(setup).runs, [{ workflow: 'slow.yml', runId: '9' }]);
});

test('gh failing to run (null status, no timeout) is a failed watch, not "still running"; the run stays listed', async () => {
  const setup = makeRepo('watch-spawn', workflows({ 'ci.yml': PUSH_MAIN }));
  mkdirSync(dirname(setup.state), { recursive: true });
  writeFileSync(setup.state, JSON.stringify({ runs: [{ workflow: 'release.yml', runId: '7' }] }));
  const { gh } = fakeGh({ watchStatus: null, watchSpawnError: true, view: { 7: { status: 'completed', conclusion: 'success', jobs: [{}] } } });
  const result = await run(['watch', setup.repo], { gh });
  assert.equal(result.code, 1);
  assert.match(result.lines.join('\n'), /watch failed: spawn gh ENOENT/);
  assert.doesNotMatch(result.lines.join('\n'), /still running/);
  assert.equal(readState(setup).runs.length, 1);
});

test('a non-zero gh run watch exit with no conclusion (auth, network, not found) is a watch error, not a failed workflow; the run stays listed', async () => {
  const setup = makeRepo('watch-auth', workflows({ 'ci.yml': PUSH_MAIN }));
  mkdirSync(dirname(setup.state), { recursive: true });
  writeFileSync(setup.state, JSON.stringify({ runs: [{ workflow: 'release.yml', runId: '7' }] }));
  const { gh } = fakeGh({ watchStatus: 4, watchStderr: 'HTTP 401: bad credentials', view: { 7: { status: 'in_progress', conclusion: null, jobs: [{}] } } });
  const result = await run(['watch', setup.repo, '--clear-failed'], { gh });
  assert.equal(result.code, 1);
  assert.match(result.lines.join('\n'), /watch failed: HTTP 401/);
  assert.equal(readState(setup).runs.length, 1);
});

test('a run GitHub no longer has (HTTP 404) is reported once and dropped; a failed run stays', async () => {
  const setup = makeRepo('watch-gone', workflows({ 'ci.yml': PUSH_MAIN }));
  mkdirSync(dirname(setup.state), { recursive: true });
  writeFileSync(setup.state, JSON.stringify({ runs: [{ workflow: 'release.yml', runId: '7' }, { workflow: 'bad.yml', runId: '8' }] }));
  const { gh } = fakeGh({ watchStatus: 1, watchStderr: 'failed to get run: HTTP 404: Not Found', gone: ['7'], view: { 8: { status: 'completed', conclusion: 'failure', jobs: [{}] } } });
  const first = await run(['watch', setup.repo], { gh });
  assert.equal(first.code, 1);
  assert.match(first.lines.join('\n'), /release\.yml run 7: .*no longer exists on GitHub, dropped/);
  assert.deepEqual(readState(setup).runs, [{ workflow: 'bad.yml', runId: '8' }]);
});

test('a 404 while the repo itself is unreachable (auth, scope, wrong slug) keeps the run listed', async () => {
  const setup = makeRepo('watch-gone-auth', workflows({ 'ci.yml': PUSH_MAIN }));
  mkdirSync(dirname(setup.state), { recursive: true });
  writeFileSync(setup.state, JSON.stringify({ runs: [{ workflow: 'release.yml', runId: '7' }] }));
  const { gh } = fakeGh({ watchStatus: 1, watchStderr: 'failed to get run: HTTP 404: Not Found', gone: ['7'], repoReachable: false });
  const result = await run(['watch', setup.repo, '--clear-failed'], { gh });
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.lines.join('\n'), /dropped/);
  assert.equal(readState(setup).runs.length, 1);
});

test('a release with a dispatch error does not set lastReleaseAt; a clean one does', async () => {
  const setup = makeRepo('release-at', workflows({ 'ci.yml': fixture('ptdb-ci.yml') }));
  await run(['start', setup.repo]);
  merge(setup, { 'a.txt': 'x' });
  assert.equal((await run(['release', setup.repo], { gh: fakeGh().gh })).code, 2);
  assert.equal(readState(setup).lastReleaseAt, undefined);
  const clean = makeRepo('release-at-ok', workflows({ 'ci.yml': DISPATCHABLE }));
  await run(['start', clean.repo]);
  merge(clean, { 'a.txt': 'x' });
  assert.equal((await run(['release', clean.repo], { gh: fakeGh().gh })).code, 0);
  assert.ok(readState(clean).lastReleaseAt);
});

test('invalid --hours / --max-minutes values exit 2 with the usage message', async () => {
  const setup = makeRepo('bad-numbers', workflows({ 'ci.yml': DISPATCHABLE }));
  for (const argv of [['due', setup.repo, '--hours', 'abc'], ['due', setup.repo, '--hours'], ['watch', setup.repo, '--max-minutes', 'x'], ['watch', setup.repo, '--max-minutes', '0']]) {
    const result = await run(argv, { gh: fakeGh().gh });
    assert.equal(result.code, 2, argv.join(' '));
    assert.match(result.lines[0], /^usage:/);
  }
});

test('the repo is the first non-flag argument, wherever the flags sit, and an unknown command is a usage error before any git call', async () => {
  const setup = makeRepo('arg-order', workflows({ 'ci.yml': DISPATCHABLE }));
  const result = await run(['watch', '--clear-failed', '--max-minutes', '5', setup.repo], { gh: fakeGh().gh });
  assert.equal(result.code, 0);
  assert.match(result.lines[0], /no runs to watch/);
  const calls = [];
  const bad = await run(['bogus', '--flag'], { gh: fakeGh().gh, git: (...a) => { calls.push(a); return ''; } });
  assert.equal(bad.code, 2);
  assert.equal(calls.length, 0);
});

test('started through a link to its folder, the script still runs its main block', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'batch-link-'));
  const link = join(base, 'run-wave-link');
  try {
    try { symlinkSync(dirname(fileURLToPath(import.meta.url)), link, 'junction'); } catch (error) { t.skip(`no link: ${error.message}`); return; }
    const run = spawnSync('node', [join(link, 'batch-release.mjs'), 'bogus'], { encoding: 'utf8' });
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stdout, /usage: batch-release\.mjs/);
  } finally {
    // Remove the link itself first, so the recursive delete can never walk into the folder it points at.
    try { unlinkSync(link); } catch { try { rmdirSync(link); } catch { /* no link was made */ } }
    if (!existsSync(link)) rmSync(base, { recursive: true, force: true });
  }
});
