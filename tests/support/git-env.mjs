// Shared by every test that builds a fixture git repo. Run from inside a git hook (pre-commit, pre-push),
// git exports GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and friends; a fixture `git init` or `git commit` then
// hits the REAL repo instead of the temp one. Importing this file first (`import '../../tests/support/git-env.mjs'`)
// removes those names from process.env, so the test's own git calls, the hook scripts under test and any
// child process all start clean. (2026-11-01, ReadTheStupidText: tests that create git repos had no such guard.)
import { execFileSync } from 'node:child_process';

// Used only when `git rev-parse --local-env-vars` cannot run.
const FALLBACK_NAMES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_PARAMETERS'];

export function localEnvNames() {
  try {
    const names = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split(/\r?\n/).map((n) => n.trim()).filter(Boolean);
    return names.length ? names : FALLBACK_NAMES;
  } catch {
    return FALLBACK_NAMES;
  }
}

export function cleanGitEnv(env = process.env) {
  const clean = { ...env };
  for (const name of localEnvNames()) delete clean[name];
  return clean;
}

function scrubProcessEnv() {
  for (const name of localEnvNames()) delete process.env[name];
}

scrubProcessEnv();
