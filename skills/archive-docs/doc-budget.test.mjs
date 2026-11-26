import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { budgetReport, formatLine, PLAN_MAX_BYTES, CLAUDE_MAX_BYTES } from './doc-budget.mjs';

const SCRIPT = join(import.meta.dirname, 'doc-budget.mjs');
const repo = (planBytes, claudeBytes) => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-budget-'));
  writeFileSync(join(dir, 'plan.md'), 'x'.repeat(planBytes));
  writeFileSync(join(dir, 'CLAUDE.md'), 'x'.repeat(claudeBytes));
  return dir;
};

test('the budget is 50,000 bytes for plan.md and 20,000 for CLAUDE.md', () => {
  assert.equal(PLAN_MAX_BYTES, 50_000);
  assert.equal(CLAUDE_MAX_BYTES, 20_000);
});

test('a file exactly at the budget is ok, one byte over is OVER by 1', () => {
  const [plan] = budgetReport(repo(PLAN_MAX_BYTES, 10));
  assert.equal(formatLine(plan), 'plan.md: 50,000 bytes (budget 50,000): ok');
  const [over] = budgetReport(repo(PLAN_MAX_BYTES + 1, 10));
  assert.equal(formatLine(over), 'plan.md: 50,001 bytes (budget 50,000): OVER by 1');
});

test('the command exits 1 naming the bytes when plan.md is over, 0 when both are within budget, 2 with no folder', () => {
  const over = spawnSync(process.execPath, [SCRIPT, repo(50_207, 100)], { encoding: 'utf8' });
  assert.equal(over.status, 1);
  assert.match(over.stdout, /plan\.md: 50,207 bytes \(budget 50,000\): OVER by 207/);
  assert.equal(spawnSync(process.execPath, [SCRIPT, repo(100, 100)], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
});
