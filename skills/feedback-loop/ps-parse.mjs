#!/usr/bin/env node
// Parses PowerShell files without running them, in pwsh and (where it exists) Windows PowerShell 5.1.
// Usage: node ps-parse.mjs <file.ps1> [...]
// Exit 0: every file parses in every shell. Exit 1: a parse error (file:line:column message printed).
// Exit 2: usage, missing file, or no PowerShell found.
// Why: `pwsh -Command "<ParseFile script>" run-all-waves.ps1` appends the path to the command text, so the
// script was EXECUTED (2026-11-06: a real overnight driver run started). Paths go only after -File.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PARSE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ps-parse.ps1');
const SHELLS = [
  { name: 'pwsh', exe: 'pwsh', required: true },
  { name: 'powershell 5.1', exe: 'powershell', required: false },
];
const SHELL_ARGS = ['-NoProfile', '-NonInteractive', '-File', PARSE_SCRIPT];
const EXIT_OK = 0;
const EXIT_PARSE_ERROR = 1;
const EXIT_USAGE = 2;

function parseWith(shell, files) {
  const run = spawnSync(shell.exe, [...SHELL_ARGS, ...files], { encoding: 'utf8' });
  const ranOk = !run.error && (run.status === EXIT_OK || run.status === EXIT_PARSE_ERROR);
  if (!ranOk) {
    const why = run.error ? (run.error.code ?? run.error.message) : `status ${run.status}, signal ${run.signal}`;
    process.stdout.write(`[${shell.name}] NOT RUN (${why})\n${run.stderr ?? ''}`);
    return shell.required ? EXIT_USAGE : EXIT_OK;
  }
  process.stdout.write(`[${shell.name}]\n${run.stdout ?? ''}${run.stderr ?? ''}`);
  return run.status;
}

function main(argv) {
  if (argv.length === 0) {
    console.error('Usage: node ps-parse.mjs <file.ps1> [...]');
    return EXIT_USAGE;
  }
  const files = argv.map((f) => resolve(f));
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    console.error(`No such file: ${missing.join(', ')}`);
    return EXIT_USAGE;
  }
  const codes = SHELLS.map((s) => parseWith(s, files));
  if (codes.includes(EXIT_PARSE_ERROR)) return EXIT_PARSE_ERROR;
  return codes.includes(EXIT_USAGE) ? EXIT_USAGE : EXIT_OK;
}

process.exit(main(process.argv.slice(2)));
