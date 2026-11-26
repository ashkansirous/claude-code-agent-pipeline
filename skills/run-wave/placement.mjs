#!/usr/bin/env node
// Placement of one slice in a run-wave: `cloud` (a Claude Code cloud session writes the code)
// or `local` (a worktree agent on this machine). Usage: node placement.mjs <slice file>
// Prints "<cloud|local>: <reason>" and exits 0. Default is local; unsure is local.
// Slice 06 (the size line is written there).
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PLACEMENT = { cloud: 'cloud', local: 'local' };
export const CLOUD_MIN_CODE_FILES = 4;

const CODE_EXT = /\.(?:mjs|cjs|js|jsx|ts|tsx|py|go|rs|rb|java|cs|sh)$/i;
const LOCAL_PATH = /\.(?:ps1|psm1|csproj|sln|xaml|props|targets|kt|swift|plist|gradle)$|(?:^|\/)(?:windows|desktop|android|ios|maui|tools\/desktop-vm|\.maestro|maestro|flows)(?:\/|$)/i;
const DEVICE_WORDS = /\b(?:devices?|emulators?|phones?|maestro|adb|hyper-v|windows|desktop vm|simulators?|testflight)\b|\bVM\b/i;
// The value must be exactly `cloud` or `local` (case-insensitive, backticks allowed); anything else is no line.
const EXPLICIT = /^[ \t]*\*\*Placement:\*\*[ \t]*`?(cloud|local)`?[ \t]*$/im;
const VERIFICATION_LINE = /^\s*(?:[-*]\s*)?\*{0,2}Verification\b/i;
const TOUCHES = /^\s*\*\*Touches:\*\*[ \t]*(.*)$/im;

export function touchesOf(text) {
  const line = text.match(TOUCHES)?.[1] ?? '';
  return [...line.matchAll(/`([^`]+)`/g)].map(m => m[1].trim().replace(/\\/g, '/'));
}

function verificationOf(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^#{1,4}\s*Verification\b/i.test(l));
  const section = start < 0 ? [] : sectionAfter(lines.slice(start + 1));
  // Slice files also write "- Verification: ..." bullets and "*Verification run:*" lines.
  const bullets = lines.filter(l => !/^#{1,4}\s/.test(l) && VERIFICATION_LINE.test(l));
  return [...section, ...bullets].join('\n');
}

function sectionAfter(rest) {
  const end = rest.findIndex(l => /^#{1,3}\s/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

function result(placement, reason) {
  return { placement, reason };
}

export function placementOf(text) {
  const explicit = text.match(EXPLICIT)?.[1].toLowerCase();
  if (explicit) return result(PLACEMENT[explicit], 'explicit **Placement:** line');
  const touches = touchesOf(text);
  if (!touches.length) return result(PLACEMENT.local, 'no Touches line');
  const localPath = touches.find(p => LOCAL_PATH.test(p));
  if (localPath) return result(PLACEMENT.local, `device, Windows or PowerShell path: ${localPath}`);
  if (DEVICE_WORDS.test(verificationOf(text))) return result(PLACEMENT.local, 'Verification names a device, emulator or Windows');
  const code = touches.filter(p => CODE_EXT.test(p));
  if (code.length < CLOUD_MIN_CODE_FILES) {
    return result(PLACEMENT.local, `${code.length} code file(s) in Touches, the line is ${CLOUD_MIN_CODE_FILES}`);
  }
  return result(PLACEMENT.cloud, `${code.length} code files in Touches, no device or Windows part`);
}

function main(path) {
  if (!path) throw new Error('usage: placement.mjs <slice file>');
  const { placement, reason } = placementOf(readFileSync(path, 'utf8'));
  process.stdout.write(`${placement}: ${reason}\n`);
}

// argv[1] keeps a symlinked or junctioned path (~/.claude/skills/...), import.meta.url is the real one.
export function isEntryPoint(argv1, metaUrl) {
  try { return Boolean(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl)); } catch { return false; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try { main(process.argv[2]); } catch (err) {
    process.stderr.write(`placement: ${err.message}\n`);
    process.stdout.write('local: placement could not be read, defaulting to local\n');
  }
}
