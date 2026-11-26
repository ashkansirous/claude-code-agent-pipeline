// node --test skills/feedback-loop/entry-points.test.mjs
// Every script under skills/ that runs a main block when started from the command line must decide that by
// comparing real paths: ~/.claude/skills/<name> is a symlink into this repo, and a plain
// `import.meta.url === pathToFileURL(process.argv[1]).href` never matches through it, so the script silently
// does nothing and exits 0 (2026-11-01: control-chars.mjs, after AgentPipeline #94 fixed two others).
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import { readdirSync, readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..');
// Also `=== fileURLToPath(import.meta.url)` (2026-11-07: batch-release.mjs escaped the narrower pattern and every
// driver call through the link was a silent no-op).
const URL_COMPARE = /import\.meta\.url\s*===|===\s*(?:fileURLToPath\()?\s*import\.meta\.url|fileURLToPath\(\s*import\.meta\.url\s*\)\s*===/;
const READS_ARGV1 = /process\.argv\[1\]/;

function scripts(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : scripts(path);
    return name.endsWith('.mjs') && !name.endsWith('.test.mjs') ? [path] : [];
  });
}

test('no skill script decides "am I the entry point" by a plain URL compare', () => {
  const bad = scripts(SKILLS).filter((file) => {
    const text = readFileSync(file, 'utf8');
    return READS_ARGV1.test(text) && URL_COMPARE.test(text);
  });
  assert.deepEqual(bad.map((f) => relative(SKILLS, f)), []);
});

test('control-chars.mjs run through a linked folder (as ~/.claude/skills is) still scans', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'entry-'));
  const link = join(base, 'skills-link');
  try {
    try { symlinkSync(join(SKILLS, 'feedback-loop'), link, 'junction'); } catch (error) { t.skip(`no link: ${error.message}`); return; }
    const repo = join(base, 'repo');
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'bad.md'), 'a\u0007b\n');
    const run = spawnSync('node', [join(link, 'control-chars.mjs'), repo, '--all'], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /bad\.md:1:2: control character 0x07/);
  } finally {
    // Remove the link itself first, so the recursive delete can never walk into the repo folder it points at.
    try { unlinkSync(link); } catch { try { rmdirSync(link); } catch { /* no link was made */ } }
    if (!existsSync(link)) rmSync(base, { recursive: true, force: true });
  }
});
