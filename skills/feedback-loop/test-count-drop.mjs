#!/usr/bin/env node
// Slice 393 item 18: a test project whose total drops by more than 20% between a PR's before and after counts needs a one-line
// reason in the slice file (Slice 383: BeatCoverFactsTests went from 2,809 cases to 34 and DinoReader.Tests from 7,288 to 4,513,
// and nobody checked that the 34 still covered the rows that mattered).
// Usage: node test-count-drop.mjs <project> <before> <after> [<slice-file>]
//   Exit 0 when the drop is 20% or less (or the count grew), or when it is more and the slice file holds the reason line
//     `Test count drop: <project> <before> -> <after>: <reason>` (project name compared case-insensitively; any non-empty reason);
//   exit 1 with the line to write when it is more and no such line exists; exit 2 on usage.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_DROP = 0.2;

// A count as a test run prints it: "2,809", "2 809" and "2_809" are 2809.
// An empty or missing count is NaN (unparsed), never 0: Number('') is 0 and would pass as "no tests".
export function parseCount(text) {
  const digits = String(text ?? '').replace(/[,_\s]/g, '');
  return digits === '' ? NaN : Number(digits);
}

// The fraction of the before count that went away (0 when it grew or stayed).
export function dropFraction(before, after) {
  return before > 0 ? Math.max(0, (before - after) / before) : 0;
}

export function expectedLine(project, before, after) {
  return `Test count drop: ${project} ${before} -> ${after}: <one line: why the missing cases are not lost coverage>`;
}

// True when the slice text holds a reason line for the project with a non-empty reason after the second colon.
export function hasReasonLine(text, project) {
  const lines = String(text ?? '').split(/\r?\n/);
  const wanted = project.toLowerCase();
  return lines.some((line) => {
    const m = /Test count drop:\s*(.+?)\s+[\d,._]+\s*->[^:]*:\s*(\S.*)$/i.exec(line);
    return Boolean(m) && m[1].trim().toLowerCase() === wanted && m[2].trim().length > 0 && !/^<one line/i.test(m[2].trim());
  });
}

function isEntryPoint() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) {
  const [project, beforeText, afterText, sliceFile] = process.argv.slice(2);
  const before = parseCount(beforeText);
  const after = parseCount(afterText);
  if (!project || !Number.isFinite(before) || !Number.isFinite(after)) {
    process.stderr.write('usage: test-count-drop.mjs <project> <before> <after> [<slice-file>]\n');
    process.exit(2);
  }
  const drop = dropFraction(before, after);
  const percent = Math.round(drop * 1000) / 10;
  if (drop <= MAX_DROP) { process.stdout.write(`${project}: ${before} -> ${after} (${percent}% fewer): within 20%\n`); process.exit(0); }
  const covered = sliceFile && hasReasonLine(readFileSync(sliceFile, 'utf8'), project);
  if (covered) { process.stdout.write(`${project}: ${before} -> ${after} (${percent}% fewer): reason recorded in ${sliceFile}\n`); process.exit(0); }
  process.stdout.write(`${project}: ${before} -> ${after} is ${percent}% fewer cases (more than 20%): write this line in the slice file:\n    ${expectedLine(project, before, after)}\n`);
  process.exit(1);
}
