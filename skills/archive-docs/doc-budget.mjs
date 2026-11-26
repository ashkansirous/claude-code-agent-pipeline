#!/usr/bin/env node
// The one place the docs size budget is written, in bytes (Slice 393 item 9: 49.7 KB, 50.9 KB and 50,207 bytes were all reported
// for the same plan.md). plan.md: 50,000 bytes. The root CLAUDE.md: 20,000 bytes.
// Usage: node doc-budget.mjs <repo-or-worktree>   prints one line per file: `<file>: <bytes> bytes (budget <n>): ok|OVER by <n>`.
// Exit 0 when both are within budget (a missing file counts as 0 bytes), 1 when either is over (run `archive-docs`), 2 on usage.
import { statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAN_MAX_BYTES = 50_000;
export const CLAUDE_MAX_BYTES = 20_000;
const BUDGETS = [['plan.md', PLAN_MAX_BYTES], ['CLAUDE.md', CLAUDE_MAX_BYTES]];

const sizeOf = (path) => { try { return statSync(path).size; } catch { return 0; } };

// [{ file, bytes, budget, over }] for the budgeted files of a repo folder.
export function budgetReport(root) {
  return BUDGETS.map(([file, budget]) => {
    const bytes = sizeOf(join(root, file));
    return { file, bytes, budget, over: Math.max(0, bytes - budget) };
  });
}

export function formatLine({ file, bytes, budget, over }) {
  return `${file}: ${bytes.toLocaleString('en-US')} bytes (budget ${budget.toLocaleString('en-US')}): ${over ? `OVER by ${over.toLocaleString('en-US')}` : 'ok'}`;
}

function isEntryPoint() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) {
  const root = process.argv[2];
  if (!root) { process.stderr.write('usage: doc-budget.mjs <repo-or-worktree>\n'); process.exit(2); }
  const report = budgetReport(resolve(root));
  for (const row of report) process.stdout.write(`${formatLine(row)}\n`);
  process.exit(report.some((r) => r.over) ? 1 : 0);
}
