import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, isAbsolute } from 'node:path';
import {
  WINDOWS_TESTS, REPO_SCANNING_TESTS, windowsTests, linuxTests, dependencyClosure, affectedWindowsTests, selectAffected,
} from './select-tests.mjs';

const FILES = [
  'skills/run-wave/folder-holders.test.mjs', 'skills/run-wave/folder-holders.ps1', 'skills/run-wave/settings.json', 'skills/run-wave/board-paths.test.mjs',
  'skills/run-all-waves/run-all-waves.test.mjs', 'skills/run-all-waves/run-all-waves.ps1',
  'skills/run-wave/merge-gate.test.mjs', 'skills/run-wave/merge-gate.mjs', 'skills/run-wave/helper.mjs',
  'skills/run-wave/primary-checkout-guard.test.mjs',
  'skills/feedback-loop/control-chars.test.mjs', 'README.md',
];
const SOURCES = {
  'skills/run-wave/folder-holders.test.mjs': "spawn('skills/run-wave/folder-holders.ps1'); read('settings.json')",
  'skills/run-all-waves/run-all-waves.test.mjs': "run('run-all-waves.ps1')",
  'skills/run-wave/merge-gate.test.mjs': "import { x } from './merge-gate.mjs';",
  'skills/run-wave/merge-gate.mjs': "import('./helper.mjs')",
};
const read = (f) => SOURCES[f] ?? '';
const SCRIPT = fileURLToPath(new URL('./select-tests.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function runCli(args) {
  const out = execFileSync('node', [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean);
}

test('a changed import dependency selects its test', () => {
  assert.deepEqual(affectedWindowsTests(['skills/run-wave/merge-gate.mjs'], FILES, read), ['skills/run-wave/merge-gate.test.mjs']);
});

test('a spawned script selects the test that names it', () => {
  assert.deepEqual(affectedWindowsTests(['skills/run-wave/folder-holders.ps1'], FILES, read), ['skills/run-wave/folder-holders.test.mjs']);
  assert.deepEqual(affectedWindowsTests(['skills/run-wave/settings.json'], FILES, read), ['skills/run-wave/folder-holders.test.mjs']);
});

test('a transitive dependency selects the test', () => {
  assert.ok(dependencyClosure('skills/run-wave/merge-gate.test.mjs', FILES, read).has('skills/run-wave/helper.mjs'));
  assert.deepEqual(affectedWindowsTests(['skills/run-wave/helper.mjs'], FILES, read), ['skills/run-wave/merge-gate.test.mjs']);
});

test('an unrelated change selects nothing', () => {
  assert.deepEqual(affectedWindowsTests(['README.md', 'skills/feedback-loop/control-chars.test.mjs'], FILES, read), []);
});

test('a change under .github selects every Windows test', () => {
  assert.deepEqual(affectedWindowsTests(['.github/workflows/x.yml'], FILES, read), windowsTests(FILES));
  assert.equal(windowsTests(FILES).length, 4);
});

test('a deleted file still selects the tests that name it', () => {
  assert.deepEqual(affectedWindowsTests(['skills/run-wave/gone.mjs'], FILES, (f) => (f === 'skills/run-wave/helper.mjs' ? "x('gone.mjs')" : read(f))), ['skills/run-wave/merge-gate.test.mjs']);
  assert.deepEqual(affectedWindowsTests(['skills/run-wave/gone.mjs'], FILES, read), []);
});

test('the Windows list globs resolve against tracked files', () => {
  assert.ok(WINDOWS_TESTS.length > 0);
  assert.ok(windowsTests(FILES).includes('skills/run-all-waves/run-all-waves.test.mjs'));
});

test('selectAffected names the changed file behind each pick, and a .github change runs everything', () => {
  const one = selectAffected(['skills/run-wave/helper.mjs'], FILES, read);
  assert.equal(one.all, false);
  assert.deepEqual(one.picks, [{ file: 'skills/run-wave/board-paths.test.mjs', reason: 'scans the whole repo' }, { file: 'skills/run-wave/merge-gate.test.mjs', reason: 'depends on skills/run-wave/helper.mjs' }]);
  assert.deepEqual(selectAffected(['skills/run-wave/board-paths.test.mjs'], FILES, read).picks, [{ file: 'skills/run-wave/board-paths.test.mjs', reason: 'its own file changed' }]);
  assert.deepEqual(selectAffected(['zzz.txt'], FILES, read), { all: false, picks: [{ file: 'skills/run-wave/board-paths.test.mjs', reason: 'scans the whole repo' }] });
  assert.deepEqual(selectAffected([], FILES, read), { all: false, picks: [] });
  const all = selectAffected(['.github/scripts/run-suite.mjs'], FILES, read);
  assert.equal(all.all, true);
  assert.equal(all.picks.length, FILES.filter((f) => f.endsWith('.test.mjs')).length);
});

test('any change selects the tests that scan the whole repo, even when no import or name reaches them', () => {
  const files = [...FILES, 'tests/frontmatter.test.mjs', 'skills/feedback-loop/entry-points.test.mjs', 'agents/x.md', 'skills/y/new.mjs'];
  for (const changed of [['agents/x.md'], ['skills/y/new.mjs']]) {
    const names = selectAffected(changed, files, read).picks.map((p) => p.file);
    assert.ok(names.includes('tests/frontmatter.test.mjs'), changed.join());
    assert.ok(names.includes('skills/feedback-loop/entry-points.test.mjs'), changed.join());
    assert.ok(names.includes('skills/run-wave/board-paths.test.mjs'), changed.join());
  }
});

test('--linux excludes the Windows tests', () => {
  assert.deepEqual(linuxTests(FILES), ['skills/run-wave/board-paths.test.mjs', 'skills/feedback-loop/control-chars.test.mjs']);
  const out = runCli(['--linux']);
  assert.ok(out.includes('skills/feedback-loop/control-chars.test.mjs'));
  assert.ok(!out.includes('skills/run-wave/folder-holders.test.mjs'));
  assert.ok(!out.some((f) => f.startsWith('skills/run-all-waves/')));
});

test('--windows reads the changed-files file and prints the affected tests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'select-tests-'));
  const changed = join(dir, 'changed.txt');
  writeFileSync(changed, 'skills/run-wave/folder-holders.test.mjs\n');
  try {
    assert.deepEqual(runCli(['--windows', changed]), ['skills/run-wave/folder-holders.test.mjs']);
    writeFileSync(changed, 'unrelated-zzz-notes.txt\n');
    assert.deepEqual(runCli(['--windows', changed]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Slice 30 item L: REPO_SCANNING_TESTS is kept by hand, so these checks keep it true.
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));

// Tracked files that still exist on disk plus untracked ones that git does not ignore (a new test file is checked before it is
// added), read from the repo this file lives in whatever the process cwd is. Never throws: a missing git gives an empty list.
function listRepoFiles() {
  const git = (args) => {
    try { return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean); } catch { return []; }
  };
  return [...new Set([...git(['ls-files']), ...git(['ls-files', '-o', '--exclude-standard'])])].filter((f) => existsSync(join(REPO, f)));
}
const REAL_FILES = listRepoFiles();

// Shapes that mean a test reads the repo as a whole: git ls-files, git grep, a walk from the repo root or a recursive folder helper.
const SCAN_SHAPES = [
  /['"]ls-files['"]/,
  /\[[^\]]*['"]grep['"]/,
  /readdirSync\(\s*(?:path\.)?(?:join\()?\s*(?:REPO|REPO_ROOT|ROOT|repoRoot)\b/,
  /readdirSync\(dir\)\.flatMap/,
];

function scansTheRepo(file) {
  const source = readFileSync(isAbsolute(file) ? file : join(REPO, file), 'utf8');
  return SCAN_SHAPES.some((shape) => shape.test(source));
}

test('every name in REPO_SCANNING_TESTS is a tracked test file and is picked for an unrelated change', () => {
  const picked = selectAffected(['unrelated-zzz-notes.txt'], REAL_FILES, () => '').picks.map((p) => p.file);
  assert.ok(REPO_SCANNING_TESTS.length > 0);
  for (const name of REPO_SCANNING_TESTS) {
    assert.ok(REAL_FILES.includes(name), `${name} is not a tracked file`);
    assert.ok(name.endsWith('.test.mjs'), `${name} is not a test file`);
    assert.ok(picked.includes(name), `${name} is not picked for an unrelated change`);
  }
});

test('every test file that scans the repo is on the REPO_SCANNING_TESTS list', () => {
  const missing = REAL_FILES.filter((f) => f.endsWith('.test.mjs') && basename(f) !== SELF && scansTheRepo(f) && !REPO_SCANNING_TESTS.includes(f));
  assert.deepEqual(missing, [], 'these tests scan the repo (git ls-files, git grep or a walk from the root) but are not in REPO_SCANNING_TESTS');
});

test('the scan check recognises each shape it looks for', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-shapes-'));
  const probe = (text) => { const f = join(dir, 'probe.mjs'); writeFileSync(f, text); return scansTheRepo(f); };
  try {
    assert.equal(probe("git(['ls-files', '-o'])"), true);
    assert.equal(probe("execFileSync('git', ['-C', r, 'grep', 'x'])"), true);
    assert.equal(probe('fs.readdirSync(path.join(ROOT, dir))'), true);
    assert.equal(probe("readdirSync(join(REPO, 'home'))"), true);
    assert.equal(probe('return readdirSync(dir).flatMap((n) => n)'), true);
    assert.equal(probe("git(['status'])\nreaddirSync(tmp)"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
