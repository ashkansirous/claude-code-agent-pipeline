#!/usr/bin/env node
// Checks the claims in a feedback-loop note against live state before it ships: every #N with its state
// from gh (a bare #N is the note's own repo; `<Name> #N` is the repo given with --other Name=path, carried
// over to the following numbers of a list), and every backticked path (has a `/` and a file extension or a
// trailing `/`) against the own repo, any --other repo and the current branch's tree. A bare #N that is no PR
// in the own repo but is one in an --other repo, or that the note also writes as `<Name> #N`, is flagged
// "ambiguous" in the table and on stderr as a warning;
// it never changes the exit code (issue and PR numbers overlap across repos all the time).
// Usage: node note-claims.mjs <note.md> <repo dir> [--other AgentPipeline=<path to that repo>]
// Prints a table. Exit 1 when a sentence says "merged" next to a PR that is not merged, "open" next to
// one that is merged (a negation within three words flips it), or a path is missing; exit 2 on usage.
// (Every round's notes of 2026-10-31 carried false claims: wrong PR states, counts and paths.)
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// "<Name> #N", also with "PR", "pull request" or "issue" between ("AgentPipeline PR #144").
const REF = /(?:\b([A-Za-z][\w.-]*)\s+(?:(?:PRs?|pull requests?|issues?)\s+)?)?#(\d+)\b/gi;
const BACKTICKED = /`([^`\n]+)`/g;
const SENTENCE_END = /(?<=[.!?])\s+|\n+/;
const NOT_A_PATH = /^(?:\/|~|[A-Za-z]:|https?:|--?\w|<|\.\.)|[\s*<>${}|;=&%]/;
const HAS_FILE_EXTENSION = /\.[A-Za-z0-9]{1,6}$/;
const LINE_SUFFIX = /(?::\d+(?:-\d+)?|#L?\d+)$/;
const STATE_WORD = /\b(un-?)?(merged|open)\b(?!\s+(?:question|questions|item|items|decision|decisions|point|points|problem|problems|finding|findings|thread|threads|work)\b)/gi;
const NEGATION = /\b(?:not|never|no|cannot)\b|n't\b/i;
const NEGATION_WINDOW_WORDS = 3;
const LIST_GAP = /^[\s,]*(?:(?:and|or|&)[\s,]*)?$/i;
const SEARCHED_REFS = ['origin/main', 'HEAD'];

export function run(command, args, cwd) {
  const out = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: out.status ?? 1, stdout: out.stdout ?? '' };
}

export function parseArgs(argv) {
  const others = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--other') { rest.push(argv[i]); continue; }
    const [name, ...path] = String(argv[++i] ?? '').split('=');
    if (!name || !path.length) return null;
    others[name] = path.join('=');
  }
  return rest.length === 2 ? { note: rest[0], repo: rest[1], others } : null;
}

// Refs in one sentence. A repo prefix carries over to the next numbers of a list ("AgentPipeline #1, #2 and #3").
// Each "merged"/"open" word goes to the nearest ref (the earlier one on a tie), flipped by a negation
// ("not", "never", "un-") within three words before it; the { word, negated } entries are in `claims`.
export function refsOf(sentence, others) {
  const found = [];
  for (const m of sentence.matchAll(REF)) {
    const named = m[1] && m[1] in others ? m[1] : null;
    const previous = found[found.length - 1];
    const carried = !named && previous && LIST_GAP.test(sentence.slice(previous.end, m.index)) ? previous.repoName : null;
    found.push({ repoName: named ?? carried, number: m[2], start: m.index, end: m.index + m[0].length, claims: [] });
  }
  for (const claim of stateClaims(sentence)) {
    const nearest = nearestRef(found, claim, sentence);
    if (nearest) nearest.claims.push(claim);
  }
  return found;
}

function stateClaims(sentence) {
  return [...sentence.matchAll(STATE_WORD)].map((m) => {
    const words = sentence.slice(0, m.index).split(/\s+/).filter(Boolean).slice(-NEGATION_WINDOW_WORDS).join(' ');
    return { word: m[2].toLowerCase(), negated: Boolean(m[1]) || NEGATION.test(words), start: m.index, end: m.index + m[0].length };
  });
}

// The start of the unclosed `(` before `index`, or -1: "#113 (fix, merged), #114 (..." has `merged` inside the first group.
function openParenBefore(sentence, index) {
  const open = [];
  for (let i = 0; i < index; i++) {
    if (sentence[i] === '(') open.push(i);
    else if (sentence[i] === ')') open.pop();
  }
  return open.length ? open[open.length - 1] : -1;
}

// A claim inside a parenthesis that directly follows a ref ("#113 (..., merged)") belongs to that ref, however
// close the next ref in the list is (Slice 307: the word went to "#114").
function refOwningGroup(refs, sentence, claim) {
  const paren = openParenBefore(sentence, claim.start);
  if (paren < 0) return null;
  // A ref named inside the group before the word ("#113 (superseded by #114, merged)") is what the word describes.
  const inside = refs.filter((ref) => ref.start > paren && ref.end <= claim.start);
  if (inside.length) return inside[inside.length - 1];
  return refs.find((ref) => ref.end <= paren && sentence.slice(ref.end, paren).trim() === '') ?? null;
}

function nearestRef(refs, claim, sentence) {
  const owner = refOwningGroup(refs, sentence, claim);
  if (owner) return owner;
  const distance = (ref) => (ref.end <= claim.start ? claim.start - ref.end : ref.start - claim.end);
  let best = null;
  for (const ref of refs) if (!best || distance(ref) < distance(best)) best = ref;
  return best;
}

export function liveState(number, cwd, runner) {
  for (const kind of ['pr', 'issue']) {
    const got = runner('gh', [kind, 'view', number, '--json', 'state', '--jq', '.state'], cwd);
    if (got.status === 0 && got.stdout.trim()) return { kind, state: got.stdout.trim().toLowerCase() };
  }
  return { kind: '?', state: 'not found' };
}

function claimProblem(kind, state, { word, negated }) {
  if (kind !== 'pr') return null;
  if (word === 'merged') {
    if (negated) return state === 'merged' ? 'says not merged, PR is merged' : null;
    return state !== 'merged' ? `says merged, PR is ${state}` : null;
  }
  if (negated) return state === 'open' ? 'says not open, PR is open' : null;
  return state === 'merged' ? 'says open, PR is merged' : null;
}

function mismatch(kind, state, claims) {
  for (const claim of claims) {
    const problem = claimProblem(kind, state, claim);
    if (problem) return problem;
  }
  return null;
}

// The name of an --other repo where a bare #N is a PR, though in the own repo it is not (an issue, or nothing).
function otherPrWithNumber(number, others, cache, runner) {
  for (const [name, dir] of Object.entries(others)) {
    const key = `${dir}#${number}`;
    if (!cache.has(key)) cache.set(key, liveState(number, dir, runner));
    if (cache.get(key).kind === 'pr') return name;
  }
  return null;
}

// Each --other repo name with the numbers the note writes with that name's prefix somewhere.
function namedNumbers(sentences, others) {
  const named = new Map();
  for (const sentence of sentences) {
    for (const ref of refsOf(sentence, others)) {
      if (ref.repoName) named.set(ref.number, ref.repoName);
    }
  }
  return named;
}

// Why a bare #N may mean another repo: it is no own PR but an --other PR, or the note names
// the same number with an --other prefix elsewhere (2026-11-01: "AgentPipeline PR #144" in a heading,
// then a bare "#144" below it, was checked against the own repo's PR #144).
function clashFor(ref, kind, named, others, cache, runner) {
  if (ref.repoName) return null;
  if (named.has(ref.number)) return named.get(ref.number);
  return kind !== 'pr' ? otherPrWithNumber(ref.number, others, cache, runner) : null;
}

// Slice 29 item 38: a repo name (and "PR"/"issue") that ends a line prefixes the `#N` that starts the next line ("AgentPipeline\n#361"):
// the two lines are joined, so the number is read as that repo's, not the note's own (board PR #175 merged with note-claims at exit 1 for that).
export function joinPrefixLines(text, others) {
  const names = Object.keys(others).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!names.length) return text;
  const prefix = new RegExp(`\\b(${names.join('|')})((?:[ \\t]+(?:PRs?|pull requests?|issues?))?)[ \\t]*(:?)[ \\t]*\\r?\\n[ \\t]*(?=#\\d)`, 'gi');
  return text.replace(prefix, '$1$2$3 ');
}

export function checkRefs(text, repoDir, others, runner) {
  const cache = new Map();
  const rows = [];
  const sentences = joinPrefixLines(text, others).split(SENTENCE_END);
  const named = namedNumbers(sentences, others);
  for (const sentence of sentences) {
    for (const ref of refsOf(sentence, others)) {
      const dir = ref.repoName ? others[ref.repoName] : repoDir;
      const key = `${dir}#${ref.number}`;
      if (!cache.has(key)) cache.set(key, liveState(ref.number, dir, runner));
      const { kind, state } = cache.get(key);
      const clash = clashFor(ref, kind, named, others, cache, runner);
      const problem = mismatch(kind, state, ref.claims) ?? (kind === '?' ? 'not found by gh' : null);
      const warning = clash ? `ambiguous: own ${kind === '?' ? 'ref' : kind} / ${clash} PR` : null;
      rows.push({ what: `${ref.repoName ?? 'own'} #${ref.number}`, kind, state, problem, warning });
    }
  }
  return rows;
}

function isPathShaped(path) {
  return path.includes('/') && (path.endsWith('/') || HAS_FILE_EXTENSION.test(path));
}

export function candidatePaths(text) {
  const tokens = [...text.matchAll(BACKTICKED)].map((m) => m[1].trim().replace(LINE_SUFFIX, ''));
  const paths = tokens.filter((t) => t && !NOT_A_PATH.test(t)).map((t) => t.replaceAll('\\', '/'));
  return [...new Set(paths.filter(isPathShaped))];
}

// Every tracked file name of a repo at a ref, or an empty list when git cannot list it.
function trackedFiles(dir, ref, runner, cache) {
  const key = `${dir}@${ref}`;
  if (!cache.has(key)) {
    const out = runner('git', ['-C', dir, 'ls-tree', '-r', '--name-only', ref], dir);
    cache.set(key, out.status === 0 ? out.stdout.split(/\r?\n/).filter(Boolean) : []);
  }
  return cache.get(key);
}

function matchesTracked(path, files) {
  if (path.endsWith('/')) return files.some((f) => f.startsWith(path) || f.includes(`/${path}`));
  return files.some((f) => f === path || f.endsWith(`/${path}`));
}

function topFolderExists(path, lists) {
  const top = `${path.split('/')[0]}/`;
  return lists.some((files) => files.some((f) => f.startsWith(top)));
}

// A path counts as found in the own repo, any --other repo, or the current branch's tree. A folder token
// whose top folder exists in none of them (a Drive folder such as `_context/rules/`) is not a repo path.
export function checkPaths(text, repoDir, runner, others = {}) {
  const cache = new Map();
  const dirs = [repoDir, ...Object.values(others)];
  const lists = dirs.flatMap((dir) => SEARCHED_REFS.map((ref) => trackedFiles(dir, ref, runner, cache)));
  const rows = [];
  for (const path of candidatePaths(text)) {
    if (lists.some((files) => matchesTracked(path, files))) {
      rows.push({ what: path, kind: 'path', state: 'found', problem: null });
    } else if (!path.endsWith('/') || topFolderExists(path, lists)) {
      rows.push({ what: path, kind: 'path', state: 'missing', problem: 'not in any repo or the current branch' });
    }
  }
  return rows;
}

export function checkNote(text, repoDir, others, runner = run) {
  return [...checkRefs(text, repoDir, others, runner), ...checkPaths(text, repoDir, runner, others)];
}

export function formatRows(rows) {
  return rows.map((r) => `${r.what}\t${r.kind}\t${r.state}\t${r.problem ?? r.warning ?? 'ok'}`).join('\n');
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write('usage: node note-claims.mjs <note.md> <repo dir> [--other Name=path]\n');
    return 2;
  }
  for (const dir of [args.repo, ...Object.values(args.others)]) run('git', ['-C', dir, 'fetch', '--quiet', 'origin', 'main'], dir);
  const rows = checkNote(readFileSync(args.note, 'utf8'), args.repo, args.others);
  process.stdout.write(formatRows(rows) + '\n');
  const warned = rows.filter((r) => r.warning);
  if (warned.length) process.stderr.write(`${warned.length} warning(s): ${warned.map((r) => `${r.what} (${r.warning})`).join('; ')}\n`);
  const bad = rows.filter((r) => r.problem);
  if (bad.length) process.stderr.write(`${bad.length} claim(s) to fix: ${bad.map((r) => `${r.what} (${r.problem})`).join('; ')}\n`);
  return bad.length ? 1 : 0;
}

export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) process.exit(main(process.argv.slice(2)));
