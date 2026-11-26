// node --test skills/branch-sweep/branch-delete-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, hasMergedPr, parseDelete } from './branch-delete-guard.mjs';

const merged = new Set(['feat/done']);
const fakeGh = (args) => JSON.stringify(merged.has(args[args.indexOf('--head') + 1]) ? [{ number: 7 }] : []);
const quiet = () => {};
const run = (command, gh = fakeGh) => decide({ cwd: '/r', tool_input: { command } }, gh, quiet);
const ABS = process.platform === 'win32' ? 'C:/repo/sub' : '/repo/sub';
const denied =(verdict) => verdict?.hookSpecificOutput?.permissionDecision === 'deny';

test('an unmerged branch is denied, a merged PR head is allowed', () => {
  assert.ok(denied(run('git branch -d chore/issues')));
  assert.ok(denied(run('git branch -D chore/issues')));
  assert.ok(denied(run(`git -C ${ABS} branch --delete chore/issues`)));
  assert.ok(denied(run('git branch -df chore/issues feat/done')));
  assert.ok(denied(run('git branch -D --force feat/unmerged')));
  assert.ok(denied(run('git branch -D feat/unmerged')));
  assert.ok(denied(run('  git branch -D feat/unmerged feat/unmerged  \n')));
  assert.equal(run('git branch -d feat/done'), null);
  assert.equal(run('git branch -D feat/done'), null);
});

test('anything but the one exact shape is allowed untouched', () => {
  const cases = [
    'git branch', 'git branch new-branch', 'git branch -r -d origin/x', 'git branch -d -r origin/x',
    'git commit -m "git branch -d chore/issues"',
    'git branch --merged origin/main | xargs -r git branch -D', 'git branch -D "$b"', 'git branch -D $b', 'git branch -D `x`',
    'git branch -D chore/issues; echo hi', 'git branch -D chore/issues && echo hi', 'cd /other && git branch -d chore/issues',
    'cd /other\ngit branch -d chore/issues', 'git branch -d chore/issues\ngit branch -d feat/x', 'Set-Location /other\ngit branch -d chore/issues',
    'git branch -D chore/*', 'git branch -D ~x', 'git branch -D -x', 'git branch -D --force-x a', 'git branch -D a -f',
    'git branch -D a 2>&1', 'git branch -D a > out', 'git branch -D "a b"', "git branch -D 'a'", 'GIT_DIR=x git branch -D a',
    'git --git-dir=x branch -D a', 'git --work-tree=x branch -D a', 'git -c a=b branch -D a', 'FOO=1 git branch -D a',
    'bash -c "git branch -D a"', 'xargs git branch -D', 'git -C sub branch -d chore/issues', 'git -C /d/x branch -d chore/issues',
    `git -C "${ABS}" branch -d chore/issues`, `git -C ${ABS}$x branch -d chore/issues`, 'git branch -D a\\b',
    `git branch -D ${Array.from({ length: 11 }, (_, i) => `b${i}`).join(' ')}`,
  ];
  for (const command of cases) assert.equal(run(command), null, command);
});

test('review 1, 2, 4, 7: former false denials are now allowed', () => {
  assert.equal(run('git branch -D chore/issues 2>&1'), null);
  assert.equal(run('git branch -D chore/issues > /dev/null'), null);
  assert.equal(run('cd /other && git branch -d chore/issues'), null);
  assert.equal(run('git -C /d/x branch -d chore/issues'), null);
  assert.equal(decide({ tool_input: { command: 'git branch -d chore/issues' } }, fakeGh, quiet), null);
});

test('parseDelete reads names, dedupes, and takes the -C path', () => {
  assert.deepEqual(parseDelete('git branch -D a b a'), { dir: null, names: ['a', 'b'] });
  assert.deepEqual(parseDelete(`git -C ${ABS} branch --delete feat/x.y_z-1`), { dir: ABS, names: ['feat/x.y_z-1'] });
  assert.equal(parseDelete('git branch -D'), null);
});

test('review 1: a merged PR does not cover a branch tip it did not merge', () => {
  const gh = () => JSON.stringify([{ number: 7, headRefOid: 'aaa' }]);
  const gitWith = (tip, inMain) => (args) => {
    if (args[0] === 'rev-parse') return `${tip}\n`;
    if (inMain === 'error') throw new Error('no origin/main');
    if (!inMain) throw Object.assign(new Error('not ancestor'), { status: 1 });
    return '';
  };
  const go = (git) => decide({ cwd: '/r', tool_input: { command: 'git branch -D fix/x' } }, gh, quiet, git);
  assert.equal(go(gitWith('aaa', false)), null);
  assert.equal(go(gitWith('bbb', true)), null);
  assert.ok(denied(go(gitWith('bbb', false))));
  assert.equal(go(gitWith('bbb', 'error')), null);
  assert.equal(go(() => { throw new Error('no such ref'); }), null);
});

test('fails open when gh fails or answers nonsense', () => {
  assert.equal(run('git branch -D chore/issues', () => { throw new Error('403'); }), null);
  assert.equal(run('git branch -D chore/issues', () => 'not json'), null);
  assert.equal(run('git branch -D chore/issues', () => '{}'), null);
  assert.throws(() => hasMergedPr('x', '/r', () => '{}'));
});

test('Slice 23 item 6: several branches in one call fetch at most once, and a failed fetch keeps the first answer', () => {
  let fetches = 0;
  const git = (args) => {
    if (args[0] === 'rev-parse') return 'tip1\n';
    if (args[0] === 'fetch') { fetches++; throw new Error('offline'); }
    throw Object.assign(new Error('no'), { status: 1 });
  };
  const gh = () => JSON.stringify([{ number: 7, headRefOid: 'older' }]);
  const out = decide({ cwd: '/r', tool_input: { command: 'git branch -D a b c' } }, gh, () => {}, git);
  assert.equal(fetches, 1);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('Slice 23 item 6: a tip missing from a stale origin/main is looked for again after one fetch', () => {
  const calls = [];
  let fetched = false;
  const git = (args) => {
    calls.push(args[0]);
    if (args[0] === 'rev-parse') return 'tip1\n';
    if (args[0] === 'fetch') { fetched = true; return ''; }
    if (!fetched) throw Object.assign(new Error('no'), { status: 1 });
    return '';
  };
  const gh = () => JSON.stringify([{ number: 7, headRefOid: 'older' }]);
  assert.equal(hasMergedPr('feat/x', '/r', gh, git), true);
  assert.deepEqual(calls, ['rev-parse', 'merge-base', 'fetch', 'merge-base']);
  const stillOut = (args) => { if (args[0] === 'rev-parse') return 'tip1'; if (args[0] === 'merge-base') throw Object.assign(new Error('no'), { status: 1 }); return ''; };
  assert.equal(hasMergedPr('feat/x', '/r', gh, stillOut), false);
});
