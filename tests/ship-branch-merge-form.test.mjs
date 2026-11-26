// node --test tests/ship-branch-merge-form.test.mjs
// Slice 33 item 62: one merge rule (agents/ship-branch.md M4): `gh pr merge` always carries --repo and never follows a `cd` in the same
// command (the merge gate cannot tell the repo after a directory change, and the auto-mode classifier denied the cd form on
// print-the-damn-book #72). No agent file may hold a `cd ... && gh pr merge` line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents');
const CD_THEN_MERGE = /\bcd\s[^\n`]*?(?:&&|;|\|\|)[^\n`]*?\bgh\s+pr\s+merge\b/;

export const mergeFormViolations = (files) => files.flatMap(({ name, text }) => text.split(/\r?\n/)
  .map((line, i) => ({ name, line: i + 1, text: line })).filter((l) => CD_THEN_MERGE.test(l.text)));

test('the matcher flags a cd chain before gh pr merge and nothing else', () => {
  const bad = (text) => mergeFormViolations([{ name: 'x.md', text }]).length;
  assert.equal(bad('run `cd <worktree> && gh pr checks 5 && gh pr merge 5 --merge`'), 1);
  assert.equal(bad('cd /d/repo; gh pr merge 5'), 1);
  assert.equal(bad('gh pr checks 5 --repo o/r --watch && gh pr merge 5 --repo o/r --merge'), 0);
  assert.equal(bad('merge run after a directory change was denied'), 0);
});

test('no agents/*.md line runs gh pr merge after a cd', () => {
  const files = fs.readdirSync(AGENTS).filter((n) => n.endsWith('.md'))
    .map((name) => ({ name, text: fs.readFileSync(path.join(AGENTS, name), 'utf8') }));
  assert.ok(files.length > 0);
  assert.deepEqual(mergeFormViolations(files), []);
});
