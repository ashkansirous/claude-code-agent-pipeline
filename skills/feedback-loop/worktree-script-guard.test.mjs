// node --test skills/feedback-loop/worktree-script-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, scriptArgument, FRESH_MS } from './worktree-script-guard.mjs';

const HOOK = fileURLToPath(new URL('./worktree-script-guard.mjs', import.meta.url));
const WRITER_JS = "import fs from 'node:fs';\nfs.writeFileSync('Usage.cs', 'x');\n";
const WRITER_PY = "from pathlib import Path\nPath('Usage.cs').write_text('x')\n";
const READER_JS = "import fs from 'node:fs';\nconsole.log(fs.readFileSync('a.txt', 'utf8'));\n";

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'wsg-'));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools', 'x.mjs'), WRITER_JS);
  writeFileSync(join(root, 'Usage.cs'), 'class Usage {}');
  git('add', '-A');
  git('commit', '-q', '-m', 'x');
  return { root, git };
}

const call = (root, command, now) => decide({ tool_name: 'Bash', cwd: root, tool_input: { command } }, now);
// Advisory (Slice 307, two strikes): a match is an allow that carries a warning, never a deny.
const isWarned = (verdict) => verdict?.hookSpecificOutput !== undefined && !('permissionDecision' in verdict.hookSpecificOutput) && Boolean(verdict.hookSpecificOutput.additionalContext);

test('a fresh untracked helper script that writes a file is warned about; a tracked tools script passes', () => {
  const { root } = repo();
  writeFileSync(join(root, 'tmp_fix.mjs'), WRITER_JS);
  writeFileSync(join(root, 'fix.py'), WRITER_PY);
  assert.ok(isWarned(call(root, 'node tmp_fix.mjs')));
  assert.ok(isWarned(call(root, 'python3 fix.py')));
  assert.ok(isWarned(call(root, 'py -3 -u fix.py')));
  assert.ok(isWarned(call(root, 'cd . && node tmp_fix.mjs')));
  assert.ok(isWarned(call(root, `node ${JSON.stringify(join(root, 'tmp_fix.mjs'))}`)));
  assert.ok(isWarned(call(tmpdir(), `cd ${JSON.stringify(root)} && node tmp_fix.mjs`)));
  assert.ok(isWarned(call(root, 'echo start; FOO=1 node --no-warnings tmp_fix.mjs | cat')));
  assert.match(call(root, 'node tmp_fix.mjs').hookSpecificOutput.additionalContext, /Edit or Write/);
  assert.equal(call(root, 'node tools/x.mjs'), null);
});

test('a staged or committed script, an old script and a script that only reads pass', () => {
  const { root, git } = repo();
  writeFileSync(join(root, 'tmp_fix.mjs'), WRITER_JS);
  writeFileSync(join(root, 'old.mjs'), WRITER_JS);
  writeFileSync(join(root, 'read.mjs'), READER_JS);
  assert.ok(isWarned(call(root, 'node old.mjs')));
  const old = new Date(Date.now() - FRESH_MS - 60_000);
  utimesSync(join(root, 'old.mjs'), old, old);
  assert.equal(call(root, 'node old.mjs'), null);
  assert.equal(call(root, 'node read.mjs'), null);
  git('add', 'tmp_fix.mjs');
  assert.equal(call(root, 'node tmp_fix.mjs'), null);
});

test('a tracked script of repo A run from repo B (absolute path, or cd into A) passes: tracked-ness is judged in the script own repo', () => {
  const a = repo();
  const b = repo();
  writeFileSync(join(a.root, 'tools', 'x.mjs'), WRITER_JS.replace('Usage.cs', 'tools/x.mjs'));
  const absolute = JSON.stringify(join(a.root, 'tools', 'x.mjs'));
  assert.equal(call(b.root, `node ${absolute}`), null);
  assert.equal(call(b.root, `cd ${JSON.stringify(a.root)} && node tools/x.mjs`), null);
  assert.equal(call(b.root, `node ${absolute} --changed | cat`), null);
  writeFileSync(join(a.root, 'tools', 'new.mjs'), WRITER_JS);
  assert.ok(isWarned(call(b.root, `node ${JSON.stringify(join(a.root, 'tools', 'new.mjs'))}`)));
});

test('a script naming a tracked file is warned about by relative or absolute path; tests and tmp/, temp and stdout writers pass', () => {
  const { root } = repo();
  const abs = join(root, 'Usage.cs').replaceAll('\\', '/');
  writeFileSync(join(root, 'abs.mjs'), `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(abs)}, 'x');\n`);
  writeFileSync(join(root, 'sub.mjs'), "import fs from 'node:fs';\nfs.writeFileSync('tools/x.mjs', 'x');\n");
  assert.ok(isWarned(call(root, 'node abs.mjs')));
  assert.ok(isWarned(call(root, 'node sub.mjs')));
  const tempWriter = "import fs from 'node:fs';\nimport os from 'node:os';\nfs.writeFileSync(os.tmpdir() + '/a.txt', 'x');\nfs.writeFileSync('tmp/out.txt', 'y');\n";
  writeFileSync(join(root, 'temp.mjs'), tempWriter);
  writeFileSync(join(root, 'zz.test.mjs'), WRITER_JS);
  writeFileSync(join(root, 'suite.mjs'), WRITER_JS);
  assert.equal(call(root, 'node temp.mjs'), null);
  assert.equal(call(root, 'node --test zz.test.mjs'), null);
  assert.equal(call(root, 'node zz.test.mjs'), null);
  assert.equal(call(root, 'node --test suite.mjs'), null);
  assert.deepEqual(scriptArgument('node --test suite.mjs'), { name: 'node', script: 'suite.mjs', test: true });
});

test('no script argument, -c / -e, stdin, a missing file, another tool and a script outside any repo pass', () => {
  const { root } = repo();
  writeFileSync(join(root, 'tmp_fix.mjs'), WRITER_JS);
  for (const command of ['node', 'node -e "1"', 'python3 -c "print(1)"', 'python3 - < in.txt', 'node missing.mjs', 'node --test', 'ls tmp_fix.mjs', 'cat tmp_fix.mjs', 'git add tmp_fix.mjs']) {
    assert.equal(call(root, command), null, command);
  }
  assert.equal(decide({ tool_name: 'Edit', cwd: root, tool_input: { command: 'node tmp_fix.mjs' } }), null);
  const outside = mkdtempSync(join(tmpdir(), 'wsg-out-'));
  writeFileSync(join(outside, 'w.mjs'), WRITER_JS);
  assert.equal(call(outside, 'node w.mjs'), null);
  assert.equal(decide({}), null);
});

test('scriptArgument finds the script after interpreter flags and skips code flags', () => {
  assert.deepEqual(scriptArgument('node a.mjs'), { name: 'node', script: 'a.mjs' });
  assert.deepEqual(scriptArgument('python3 -u -X dev b.py'), { name: 'python3', script: 'b.py' });
  assert.deepEqual(scriptArgument('FOO=1 "C:/x/node.exe" --require r.js c.mjs'), { name: 'node', script: 'c.mjs' });
  for (const text of ['node -e "1"', 'python3 -m unittest', 'python3 -', 'node --version', 'ls a.mjs', '']) assert.equal(scriptArgument(text), null, text);
});

test('the hook runs from the command line, warns on stdout and fails open on garbage', () => {
  const { root } = repo();
  writeFileSync(join(root, 'tmp_fix.mjs'), WRITER_JS);
  const log = join(root, 'tmp', 'logs', 'advisory-hooks.log');
  const run = (stdin) => spawnSync('node', [HOOK], { input: stdin, encoding: 'utf8', env: { ...process.env, ADVISORY_HOOKS_LOG: log } });
  const warning = run(JSON.stringify({ tool_name: 'Bash', cwd: root, tool_input: { command: 'node tmp_fix.mjs' } }));
  assert.doesNotMatch(warning.stdout, /permissionDecision/);
  assert.match(warning.stdout, /additionalContext/);
  assert.doesNotMatch(warning.stdout, /deny/);
  assert.match(readFileSync(log, 'utf8'), /^\S+\tworktree-script-guard\t.*\tHook warning/);
  assert.equal(run(JSON.stringify({ tool_name: 'Bash', cwd: root, tool_input: { command: 'node tools/x.mjs' } })).stdout, '');
  const garbage = run('garbage');
  assert.equal(garbage.status, 0);
  assert.match(garbage.stderr, /worktree-script-guard/);
});
