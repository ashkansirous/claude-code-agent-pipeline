// node --test tests/home-budget.test.mjs
// CLAUDE.md.example is the shared rules file: it loads into every session and subagent once installed as ~/.claude/CLAUDE.md,
// so its size is a per-session cost. Budget (bytes, line endings counted as LF so a Windows checkout reads the same as CI):
// 20,480 (20 KB). Over budget: move the procedure into the skill that runs at that moment and keep the heading,
// the one-sentence hard constraint and a pointer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME_CLAUDE_MAX_BYTES = 20 * 1024;

function lfBytes(file) {
  return Buffer.byteLength(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), 'utf8');
}

test('CLAUDE.md.example stays within its budget', () => {
  const bytes = lfBytes(path.join(ROOT, 'CLAUDE.md.example'));
  assert.ok(bytes <= HOME_CLAUDE_MAX_BYTES, `CLAUDE.md.example is ${bytes} bytes, budget ${HOME_CLAUDE_MAX_BYTES}: move a procedure into its skill`);
});
