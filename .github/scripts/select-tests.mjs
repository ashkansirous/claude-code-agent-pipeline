#!/usr/bin/env node
// Picks which *.test.mjs files a CI job runs, to keep CI minutes low.
//   --linux                       every tracked test that is not Windows-only (the full suite, one billed minute)
//   --windows <changed-files>     the Windows-only tests affected by the files listed (one path per line) in that file
//   --windows-all                 every Windows-only test (the workflow's fallback when --windows picks none)
// A Windows test is affected when a changed file is the test itself or one of its dependencies, found
// transitively from relative import specifiers and from any tracked file whose basename appears in the
// source (this catches spawned scripts such as the Windows driver scripts; never name a script in this source: every importer would depend on it). A change under .github/ selects all of them.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_SUFFIX = '.test.mjs';

// A new Windows-only test goes here (a * matches within one folder level). Each name is written without its suffix: a full
// file name in this source would make every importer of this module (the merge gate, run-suite.mjs) depend on that test,
// because a source that names a tracked file's basename counts as depending on it (Slice 30).
export const WINDOWS_TESTS = [
  `skills/run-all-waves/*${TEST_SUFFIX}`,
  `skills/run-wave/primary-checkout-guard${TEST_SUFFIX}`,
  `skills/run-wave/merge-gate${TEST_SUFFIX}`,
  `skills/run-wave/folder-holders${TEST_SUFFIX}`,
];
// Tests that scan the whole repo (every SKILL.md, every skills/**/*.mjs, every skill folder) name none of the
// files a change touches, so no import or basename match ever picks them: any change selects them. Written without the
// full file names for the same reason as WINDOWS_TESTS.
export const REPO_SCANNING_TESTS = [
  `tests/frontmatter${TEST_SUFFIX}`,
  `skills/feedback-loop/entry-points${TEST_SUFFIX}`,
  `skills/run-wave/board-paths${TEST_SUFFIX}`,
  `.github/scripts/select-tests${TEST_SUFFIX}`,
];
const GITHUB_DIR = '.github/';
const SOURCE_EXTENSIONS = /\.(mjs|js|ps1|sh|json)$/i;
const IMPORT_SPECIFIER = /(?:from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

export function listTracked() {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split(/\r?\n/).filter(Boolean);
}

function patternToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

export function windowsTests(files) {
  const patterns = WINDOWS_TESTS.map(patternToRegex);
  return files.filter((f) => f.endsWith(TEST_SUFFIX) && patterns.some((p) => p.test(f)));
}

export function linuxTests(files) {
  const windows = new Set(windowsTests(files));
  return files.filter((f) => f.endsWith(TEST_SUFFIX) && !windows.has(f));
}

function relativeImports(file, source, tracked) {
  const found = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const target = posix.normalize(posix.join(posix.dirname(file), match[1]));
    if (tracked.has(target)) found.push(target);
  }
  return found;
}

function spawnedFiles(file, source, files) {
  return files.filter((f) => f !== file && source.includes(basename(f)));
}

function directDependencies(file, files, tracked, read) {
  if (!SOURCE_EXTENSIONS.test(file)) return [];
  const source = read(file);
  return [...relativeImports(file, source, tracked), ...spawnedFiles(file, source, files)];
}

export function dependencyClosure(test, files, read) {
  const tracked = new Set(files);
  const seen = new Set([test]);
  const queue = [test];
  while (queue.length) {
    for (const dep of directDependencies(queue.shift(), files, tracked, read)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}

// A changed path that is no longer tracked (deleted or renamed) cannot be found by the closure, so a test is
// also affected when any file in its closure names that path's basename.
function mentionsGone(closure, gone, read) {
  return [...closure].some((d) => SOURCE_EXTENSIONS.test(d) && gone.some((g) => read(d).includes(basename(g))));
}

export function affectedWindowsTests(changed, files, read) {
  const tests = windowsTests(files);
  if (changed.some((f) => f.startsWith(GITHUB_DIR))) return tests;
  const changedSet = new Set(changed);
  const tracked = new Set(files);
  const gone = changed.filter((f) => !tracked.has(f));
  return tests.filter((t) => {
    const closure = dependencyClosure(t, files, read);
    return [...closure].some((d) => changedSet.has(d)) || mentionsGone(closure, gone, read);
  });
}

// Slice 30 item F: the tests (Windows-only or not) a diff affects, each with the changed file that picked it.
// `all` is true when the diff touches .github/ (the runner and shared scripts): the caller then runs everything.
export function selectAffected(changed, files, read) {
  const tests = files.filter((f) => f.endsWith(TEST_SUFFIX));
  if (changed.some((f) => f.startsWith(GITHUB_DIR))) return { all: true, picks: tests.map((file) => ({ file, reason: 'run all (.github/ changed)' })) };
  const changedSet = new Set(changed);
  const tracked = new Set(files);
  const gone = changed.filter((f) => !tracked.has(f));
  const picks = [];
  for (const file of tests) {
    const closure = dependencyClosure(file, files, read);
    const hit = [...closure].find((d) => changedSet.has(d));
    if (!hit && changed.length && REPO_SCANNING_TESTS.includes(file)) picks.push({ file, reason: 'scans the whole repo' });
    else if (hit) picks.push({ file, reason: hit === file ? 'its own file changed' : `depends on ${hit}` });
    else if (mentionsGone(closure, gone, read)) picks.push({ file, reason: 'names a deleted or renamed file' });
  }
  return { all: false, picks };
}

function readLines(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function select(argv) {
  const files = listTracked();
  const read = (f) => readFileSync(f, 'utf8');
  if (argv[0] === '--linux') return linuxTests(files);
  if (argv[0] === '--windows-all') return windowsTests(files);
  if (argv[0] === '--windows' && argv[1]) return affectedWindowsTests(readLines(argv[1]), files, read);
  throw new Error('usage: select-tests.mjs --linux | --windows-all | --windows <changed-files-file>');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const selected = select(process.argv.slice(2));
    if (selected.length) console.log(selected.join('\n'));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
