#!/usr/bin/env node
// Counts the open checks in docs/plan/unverified.md (one `- ` bullet under each `### Slice` heading) and the slices that
// have one, and keeps plan.md's count line equal to that: "- **Not yet tried on a device:** <N> checks across <M> slices, in [...]".
// The line was kept by arithmetic and drifted (469 in plan.md, 468 bullets; Slice 315 item 6).
//
// Usage: node count-unverified.mjs <repo root> [--write | --check]
//   (none)   print the count line
//   --check  exit 1 when plan.md's count line differs (prints both)
//   --write  rewrite plan.md's count line in place (keeps the file's line endings); exit 0
// update-docs index mode runs `--write` after it edits unverified.md.
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalProduct, PRODUCT_PATTERN } from './products.mjs';

const UNVERIFIED = join('docs', 'plan', 'unverified.md');
const SLICE_HEADING = /^###\s/;
const BULLET_START = /^- \S/;
// A short bullet that only points elsewhere ("Item F moved to Slice 16") is not a check (Slice 23 item 12).
// Only a bullet that is just a pointer: "[Item F] moved/folded to Slice N", "now in Slice N", "tracked in Slice N", "see Slice N".
// "See the banner on the test phone after Slice 12" or "Merged build shows the old badge, Slice 4" are checks and still count.
const POINTER = /^- (?:\*\*)?(?:item\s+\S+\s+)?(?:(?:moved|folded|merged)\s+(?:in)?to|now in|tracked in|see)\s+(?:`?[\w./-]+`?\s+){0,2}?slice\s+\d+\w*[.)]?(?:\*\*)?$/i;
export const BULLET = { test: (line) => BULLET_START.test(line) && !POINTER.test(line.trim()) };
const PRODUCT_HEADING = /^##\s+(\S.*?)\s*$/;
// Only `## ` headings naming a known product (long or short name) are products; any other (Notes, ...) is not.
// The optional "(Product n, Product m)" split after "slices" is rewritten with the totals; any other
// parenthetical there, such as "(see unverified.md)" or "(Android 3)", is kept.
const SPLIT_ITEM = String.raw`(?:${PRODUCT_PATTERN}) \d+`;
const SPLIT = String.raw` \(${SPLIT_ITEM}(?:, ${SPLIT_ITEM})*\)`;
const COUNT_LINE = new RegExp(String.raw`^(- \*\*Not yet tried on a device:\*\* )\d+( checks across )\d+( slices\b)(${SPLIT})?(.*)$`);
const CURRENT_LINE = new RegExp(String.raw`^- \*\*Not yet tried on a device:\*\* (\d+) checks across (\d+) slices\b(${SPLIT})?`);
const EXIT_MISMATCH = 1;
const EXIT_USAGE = 2;

// { checks, slices }: a slice counts once it has at least one bullet; bullets before the first heading are intro text.
export function countUnverified(text) {
  let checks = 0;
  let slices = 0;
  let current = -1;
  for (const line of String(text).split(/\r?\n/)) {
    if (SLICE_HEADING.test(line)) { current = 0; continue; }
    if (current < 0 || !BULLET.test(line)) continue;
    checks++;
    if (current++ === 0) slices++;
  }
  return { checks, slices };
}

// Checks per `## <product>` heading, in file order; {} when the file has no such heading (one product).
export function countByProduct(text) {
  const products = {};
  const names = {};
  let product = null;
  let inBlock = false;
  for (const line of String(text).split(/\r?\n/)) {
    const heading = PRODUCT_HEADING.exec(line);
    if (heading && !line.startsWith('###')) {
      const canonical = canonicalProduct(heading[1]);
      // Counted under the name the file's first heading for that product used ("RTST" stays "RTST"); a repeat adds on.
      if (canonical !== null) names[canonical] ??= heading[1];
      product = canonical === null ? null : names[canonical];
      if (product !== null) products[product] ??= 0;
      inBlock = false;
      continue;
    }
    if (SLICE_HEADING.test(line)) { inBlock = true; continue; }
    if (product !== null && inBlock && BULLET.test(line)) products[product]++;
  }
  return products;
}

function splitText(products) {
  const names = Object.keys(products);
  return names.length ? ` (${names.map((n) => `${n} ${products[n]}`).join(', ')})` : '';
}

export function applyCount(planText, { checks, slices }, products = {}) {
  let found = false;
  const out = String(planText).split(/(\r?\n)/).map((part) => {
    const match = COUNT_LINE.exec(part);
    if (!match) return part;
    found = true;
    return `${match[1]}${checks}${match[2]}${slices}${match[3]}${splitText(products)}${match[5]}`;
  }).join('');
  return { text: out, found };
}

export function currentCount(planText) {
  for (const line of String(planText).split(/\r?\n/)) {
    const m = CURRENT_LINE.exec(line);
    if (m) return { checks: Number(m[1]), slices: Number(m[2]), split: m[3] ?? '' };
  }
  return null;
}

export function main(argv, out = console.log) {
  const [root, mode] = argv;
  if (!root) { out('usage: node count-unverified.mjs <repo root> [--write | --check]'); return EXIT_USAGE; }
  const file = join(resolve(root), UNVERIFIED);
  if (!existsSync(file)) { out(`no ${UNVERIFIED} in ${root}`); return EXIT_USAGE; }
  const fileText = readFileSync(file, 'utf8');
  const counted = countUnverified(fileText);
  const products = countByProduct(fileText);
  out(`${counted.checks} checks across ${counted.slices} slices${splitText(products)}`);
  if (!mode) return 0;
  const planPath = join(resolve(root), 'plan.md');
  const plan = readFileSync(planPath, 'utf8');
  if (mode === '--check') {
    const have = currentCount(plan);
    const same = have && have.checks === counted.checks && have.slices === counted.slices && have.split === splitText(products);
    if (!same) out(`plan.md says ${have ? `${have.checks} checks across ${have.slices} slices${have.split}` : 'nothing'}`);
    return same ? 0 : EXIT_MISMATCH;
  }
  if (mode !== '--write') return EXIT_USAGE;
  const { text, found } = applyCount(plan, counted, products);
  if (!found) { out('plan.md has no "Not yet tried on a device" count line'); return EXIT_USAGE; }
  writeFileSync(planPath, text);
  return 0;
}

// Real paths: ~/.claude/skills/<name> is a symlink into the repo, so a plain compare would silently do nothing.
function isEntryPoint() {
  try { return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) process.exit(main(process.argv.slice(2)));
