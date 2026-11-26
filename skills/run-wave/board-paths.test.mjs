// Slice 20: nothing in this repo points at the retired skills/report-progress/ scripts (the agent-board plugin carries
// them now), every `node ~/.claude/skills/run-wave/board.mjs <script>` call names a script the plugin ships, and every
// step list a caller names exists. docs/ (slice and note files record history) and plan.md (the index pass owns it) are left out.
// Run: node --test skills/run-wave/board-paths.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const RETIRED = ['skills', 'report-progress'].join('/') + '/';
const SELF = 'skills/run-wave/board-paths.test.mjs';
const LEFT_OUT = (file) => file.startsWith('docs/') || file === 'plan.md' || file === SELF;
// Files that may name the retired folder on purpose (a list of retired hook paths to remove from a settings.json).
const REMOVES_RETIRED_HOOKS = new Set([]);
const PLUGIN_SCRIPTS = new Set(['report-progress', 'sync-docs', 'usage-tick', 'usage-report', 'cap-reading',
  'hooks/session-done', 'hooks/session-waiting', 'hooks/goal-reminder', 'hooks/background-agents']);
const BOARD_CALL = /node ~\/\.claude\/skills\/run-wave\/board\.mjs ((?:hooks\/)?[a-z-]+)/g;
const STEPS_FLAG = /--steps-file ([A-Za-z0-9_-]+)(?![A-Za-z0-9_./-])/g;

function repoFiles() {
  const listed = execFileSync('git', ['-C', REPO, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return listed.split(/\r?\n/).filter((file) => file && !LEFT_OUT(file) && existsSync(join(REPO, file)) && /\.(md|mjs|js|json|ps1|sh|yml|yaml)$/.test(file));
}

function hitsOf(pattern) {
  const hits = [];
  for (const file of repoFiles()) {
    const text = readFileSync(join(REPO, file), 'utf8');
    for (const match of text.matchAll(pattern)) hits.push({ file, match });
  }
  return hits;
}

test('no file in the repo mentions the retired skills/report-progress/ folder', () => {
  const hits = repoFiles().filter((file) => !REMOVES_RETIRED_HOOKS.has(file) && readFileSync(join(REPO, file), 'utf8').includes(RETIRED));
  assert.deepEqual(hits, []);
});

test('the retired folder is gone', () => {
  assert.equal(existsSync(join(REPO, 'skills', 'report-progress')), false);
});

test('every board.mjs call in the docs names a script the plugin ships', () => {
  const unknown = hitsOf(BOARD_CALL).filter(({ match }) => !PLUGIN_SCRIPTS.has(match[1])).map(({ file, match }) => `${file}: ${match[1]}`);
  assert.deepEqual(unknown, []);
  assert.ok(hitsOf(BOARD_CALL).length >= 8, 'the callers use board.mjs (a rename must not leave this test checking nothing)');
});

test('every --steps-file name a caller writes has a list in skills/run-wave/steps/', () => {
  const missing = hitsOf(STEPS_FLAG).filter(({ file }) => file.endsWith('.md')).filter(({ match }) => !existsSync(join(REPO, 'skills', 'run-wave', 'steps', `${match[1]}.json`))).map(({ file, match }) => `${file}: ${match[1]}`);
  assert.deepEqual(missing, []);
});
