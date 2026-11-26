#!/usr/bin/env node
// Lists the slices still to build in a repo: the rows of plan.md's status table whose Status
// cell starts with "planned". Reads plan.md from origin/main (the primary checkout may be stale),
// so the caller fetches first. Prints JSON: { planned: ["205", ...], open: [{ slice, status }] }.
// Used by run-all-waves.ps1 to decide whether another wave is needed and whether the last one moved.
// Exit 2 (message on stderr) when plan.md has no recognised status table, or several and no
// "## Status" heading, so a parse failure never looks like "nothing left to build".
//   node remaining-slices.mjs <repo path> [--file <plan.md>]   (--file reads a local file instead)
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalProduct } from '../run-wave/products.mjs';

const NO_TABLE_EXIT = 2;
const NO_TABLE_MESSAGE = 'plan.md has no recognised status table (needs a slice-number column and a Status column)';
const AMBIGUOUS_MESSAGE = 'plan.md has several tables with a slice-number and a Status column and no "## Status" heading to say which one lists the open slices';
const STATUS_HEADING = /^status\b/i;
const PLANNED = /^planned\b/i;
const SLICE_HEADER = /^(#|slice(\s*(#|no\.?|number))?|no\.?|number)$/i;
const STATUS_HEADER = /^status$/i;

// Splits on `|` except an escaped `\|` or one inside backticks.
function cellsOf(line) {
  const cells = [];
  let cell = '';
  let inCode = false;
  const text = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cell.trim()); cell = ''; continue; }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

// "**planned**", "`planned`" and an emoji before planned all mean planned.
function plainStatus(cell) {
  return cell.replace(/[*_`]/g, '').replace(/^[^\p{L}]+/u, '').trim();
}

function isSeparator(cells) {
  return cells.every((c) => /^:?-{3,}:?$/.test(c));
}

// Every table whose header has both a slice-number column and a Status column, with the heading
// level and text of the section it sits under ("## Status" gives { level: 2, text: "Status" }).
function findTables(lines) {
  const tables = [];
  let heading = { level: 0, text: '' };
  let statusLevel = 0; // level of the open "Status" heading, 0 when outside that section
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const isRow = lines[i].trim().startsWith('|');
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (match) {
      heading = { level: match[1].length, text: match[2].trim() };
      if (STATUS_HEADING.test(heading.text)) statusLevel = heading.level;
      else if (heading.level <= statusLevel) statusLevel = 0;
    }
    if (!isRow) { inTable = false; continue; }
    if (inTable) continue;
    inTable = true;
    const header = cellsOf(lines[i]);
    const slice = header.findIndex((c) => SLICE_HEADER.test(c));
    const status = header.findIndex((c) => STATUS_HEADER.test(c));
    const product = statusLevel > 0 && heading.level > statusLevel && canonicalProduct(heading.text) !== null;
    if (slice >= 0 && status >= 0) tables.push({ start: i + 1, slice, status, heading, product });
  }
  return tables;
}

// The table under a "## Status" heading when there is one; otherwise the only matching table.
// Several matching tables and no Status heading is ambiguous, so it fails rather than guesses.
// A Status section that keeps one table per product (`### <product>` sub-headings, long or short name)
// lists the open slices in those tables only: a table directly under `## Status` or under another
// sub-heading such as `### Notes` is ignored.
export function findStatusTables(lines) {
  const tables = findTables(lines);
  const perProduct = tables.filter((t) => t.product);
  if (perProduct.length > 0) return perProduct;
  const underStatus = tables.find((t) => STATUS_HEADING.test(t.heading.text));
  if (underStatus) return [underStatus];
  if (tables.length > 1) throw new Error(AMBIGUOUS_MESSAGE);
  return tables.slice(0, 1);
}

function rowsOf(lines, table) {
  const rows = [];
  for (let i = table.start; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    const cells = cellsOf(lines[i]);
    if (isSeparator(cells)) continue;
    rows.push({ slice: cells[table.slice] ?? '', status: cells[table.status] ?? '' });
  }
  return rows;
}

export function openRows(planText) {
  const lines = planText.split(/\r?\n/);
  const tables = findStatusTables(lines);
  if (tables.length === 0) return null;
  return tables.flatMap((table) => rowsOf(lines, table));
}

export function remaining(planText) {
  const open = openRows(planText);
  if (!open) throw new Error(NO_TABLE_MESSAGE);
  const planned = open.filter((r) => PLANNED.test(plainStatus(r.status))).map((r) => r.slice);
  return { planned, open };
}

function readPlan(argv) {
  const fileFlag = argv.indexOf('--file');
  if (fileFlag >= 0) return readFileSync(argv[fileFlag + 1], 'utf8');
  return execFileSync('git', ['-C', argv[0] ?? '.', 'show', 'origin/main:plan.md'], { encoding: 'utf8' });
}

function main() {
  try {
    process.stdout.write(JSON.stringify(remaining(readPlan(process.argv.slice(2)))) + '\n');
  } catch (error) {
    if (error.message !== NO_TABLE_MESSAGE && error.message !== AMBIGUOUS_MESSAGE) throw error;
    process.stderr.write(error.message + '\n');
    process.exitCode = NO_TABLE_EXIT;
  }
}

// Compares real paths: ~/.claude/skills/<name> is a symlink, so argv[1] is the link path while
// import.meta.url is the resolved one, and a plain === never matched (the script printed nothing).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) main();
