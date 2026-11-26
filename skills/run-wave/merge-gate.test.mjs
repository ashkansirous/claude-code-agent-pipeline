// node --test skills/run-wave/merge-gate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/support/git-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decide as gate, mergeTarget, reviewPaths, reviewedFiles, isDocPath, globToRegExp, tooYoungForChecks, rawMergeInCommandPosition, repoSlug, codeTreeHash, explainMerge } from './merge-gate.mjs';

// Slice 29 item 46: an allowed docs merge writes a pending-mirror marker; never into the real profile.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-gate-profile-'));

const SHA = 'a'.repeat(40);
const STUB_GIT = () => SHA;
const decide = (input, gh, warn, git = STUB_GIT) => gate(input, gh, warn, git);

function reviewFile(dir, name, content = `findings

Reviewed files:
src/a.cs ${SHA}
`, ownContent = true) {
  // ownContent: prefix a per-file line so the files differ, as real passes do (the gate does not compare contents)
  const folder = path.join(dir, 'reviews');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, name);
  fs.writeFileSync(file, ownContent ? `Review file ${name}\n${content}` : content);
  return file;
}

const input = (command = 'gh pr merge 12 --merge', cwd = os.tmpdir()) => ({ tool_name: 'Bash', cwd, tool_input: { command } });
const view = (pr) => () => JSON.stringify({ files: [{ path: 'src/a.cs' }], body: '', number: 12, headRefOid: 'f'.repeat(40), ...pr });
const denied = (verdict) => verdict?.hookSpecificOutput?.permissionDecision === 'deny';
const reason = (verdict) => verdict.hookSpecificOutput.permissionDecisionReason;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'merge-gate-'));

test('a code PR with no Review section is denied', () => {
  const verdict = decide(input(), view({ body: '## Summary\nx' }));
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /no `## Review` section/);
  assert.match(reason(verdict), /as its own command first/);
});

test('a high and a medium review file allow the merge, whatever their age', () => {
  const dir = tmp();
  const high = reviewFile(dir, 'x-high.md');
  const medium = reviewFile(dir, 'x-medium.md');
  const body = `## Summary\nx\n\n## Review\n- high: \`${high}\`\n- medium: ${medium}\n\n## Test plan\n- [x] ok`;
  assert.equal(decide(input(), view({ body })), null);
  const passes = `## Review\n${reviewFile(dir, 'pass-1.md')}\n${reviewFile(dir, 'pass-2.md')}`;
  assert.equal(decide(input(), view({ body: passes })), null);
});

test('a pass keyword inside a slug word does not count', () => {
  const dir = tmp();
  const high = reviewFile(dir, 'highlight-fix-high.md');
  const medium = reviewFile(dir, 'highlight-fix-medium.md');
  assert.equal(decide(input(), view({ body: `## Review\n${high}\n${medium}` })), null);
  const fake = reviewFile(dir, 'highlight-fix.md');
  assert.ok(denied(decide(input(), view({ body: `## Review\n${fake}\n${medium}` }))));
});

test('a review round number after high or medium still counts', () => {
  const dir = tmp();
  const high = reviewFile(dir, 's375bd-high6.md');
  const medium = reviewFile(dir, 's375bd-medium6.md');
  assert.equal(decide(input(), view({ body: `## Review\n${high}\n${medium}` })), null);
  const slug = reviewFile(dir, 'highway6-fix.md');
  assert.ok(denied(decide(input(), view({ body: `## Review\n${slug}\n${medium}` }))));
});

test('backslash paths with round-numbered names pass (Windows)', { skip: process.platform !== 'win32' && 'backslash paths are Windows paths' }, () => {
  const dir = tmp();
  const high = reviewFile(dir, 's375bd-high6.md');
  const medium = reviewFile(dir, 's375bd-medium6.md');
  const backslashed = (file) => file.replace(/\//g, '\\');
  assert.equal(decide(input(), view({ body: `## Review\n- ${backslashed(high)}\n- \`${backslashed(medium)}\`` })), null);
});

test('the denial for a body with mangled paths names forward slashes and the round suffix', () => {
  const dir = tmp();
  assert.match(reason(decide(input(), view({ body: '## Review\nD:AgentPipeline-worktreesreviewss375bd-high6.md' }))), /forward slashes.*`high<round>` such as `high6`, or `pass-1`/);
});

test('a missing file, one file, the same file twice, or no high/medium pair is denied', () => {
  const dir = tmp();
  const high = reviewFile(dir, 'high.md');
  const medium = reviewFile(dir, 'medium.md');
  const other = reviewFile(dir, 'extra.md');
  const ghost = path.join(dir, 'reviews', 'ghost.md');
  assert.match(reason(decide(input(), view({ body: `## Review\n${high}\n${ghost}` }))), /ghost\.md is not on disk/);
  assert.ok(denied(decide(input(), view({ body: `## Review\n${high}` }))));
  const twice = `## Review\n${high}\n${path.join(dir, 'reviews', '..', 'reviews', 'high.md')}`;
  assert.ok(denied(decide(input(), view({ body: twice }))));
  assert.match(reason(decide(input(), view({ body: `## Review\n${high}\n${other}` }))), /named for the high pass/);
  assert.match(reason(decide(input(), view({ body: `## Review\n${medium}\n${other}` }))), /named for the high pass/);
});

test('a relative path resolves against the hook cwd, and a Git Bash /d/ path is converted', () => {
  const dir = tmp();
  reviewFile(dir, 'high.md');
  reviewFile(dir, 'medium.md');
  assert.equal(decide(input('gh pr merge 12', dir), view({ body: '## Review\nreviews/high.md\n./reviews/medium.md' })), null);
  const bash = dir.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
  const body = `## Review\n${bash}/reviews/high.md\n${bash}/reviews/medium.md`;
  assert.equal(decide(input(), view({ body })), null);
});

test('a file named for both passes does not stand in for either', () => {
  const dir = tmp();
  const both = reviewFile(dir, 'high-and-medium.md');
  const medium = reviewFile(dir, 'extra-medium.md');
  assert.match(reason(decide(input(), view({ body: `## Review\n${both}\n${medium}` }))), /named for the high pass/);
});

test('a relative path is found from the worktree root and its parent reviews/ folder', () => {
  const dir = tmp();
  const worktree = path.join(dir, 'wt');
  fs.mkdirSync(path.join(worktree, 'sub'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: worktree });
  reviewFile(dir, 'x-high.md');
  reviewFile(dir, 'x-medium.md');
  const body = '## Review\nreviews/x-high.md\nreviews/x-medium.md';
  assert.equal(decide(input('gh pr merge 12', path.join(worktree, 'sub')), view({ body })), null);
});

test('a merge with no number checks the current branch PR', () => {
  const seen = [];
  const gh = (target) => { seen.push(target); return JSON.stringify({ files: [{ path: 'README.md' }], number: 3 }); };
  assert.equal(decide(input('gh pr merge --merge'), gh), null);
  assert.equal(seen[0].selector, undefined);
});

test('a docs-only PR (skill .md files included) is allowed without a Review section', () => {
  const files = [{ path: 'README.md' }, { path: 'skills/run-wave/SKILL.md' }];
  assert.equal(decide(input(), view({ files, body: '' })), null);
});

test('a PR of Markdown plus Claude Design mocks under docs/design/ is docs-only; code beside them is not', () => {
  const files = [{ path: 'docs/design/Story Text.dc.html' }, { path: 'docs/design/icons/app.svg' }, { path: 'plan.md' }];
  assert.equal(decide(input(), view({ files, body: '' })), null);
  assert.ok(denied(decide(input(), view({ files: [...files, { path: 'src/App.cs' }], body: '' }))));
  assert.ok(denied(decide(input(), view({ files: [{ path: 'src/docs/designer.cs' }], body: '' }))));
});

test('isDocPath: Markdown anywhere and anything under a docs/design folder, either slash', () => {
  for (const p of ['README.md', 'docs/design/a.dc.html', 'docs\\design\\x.jsx', 'apps/web/docs/design/s.css']) assert.equal(isDocPath(p), true, p);
  for (const p of ['src/a.cs', 'docs/designs/a.html', 'docs/design.html', 'mydocs/design/a.html', '']) assert.equal(isDocPath(p), false, p);
});

test('a parse error or gh failure fails open with a reason on stderr', () => {
  const notes = [];
  assert.equal(decide(input(), () => 'not json', (t) => notes.push(t)), null);
  assert.equal(decide(input(), () => { throw new Error('gh: no network'); }, (t) => notes.push(t)), null);
  assert.equal(notes.length, 2);
  assert.match(notes[1], /gh: no network/);
});

test('other commands, other tools and quoted text are not gated', () => {
  assert.equal(decide(input('git status'), view({})), null);
  assert.equal(decide(input('git commit -m "gh pr merge 5"'), view({})), null);
  assert.equal(decide({ tool_name: 'Read', tool_input: {} }, view({})), null);
});

test('target parsing: flag order, URL, quoted number, -R before or after, no number', () => {
  assert.deepEqual(mergeTarget('gh pr checks 9 --watch && gh pr merge 9 --merge'), { number: '9', selector: '9', repo: undefined });
  assert.equal(mergeTarget('gh pr merge --repo o/r 4 --merge').repo, 'o/r');
  assert.equal(mergeTarget('gh pr merge --merge 12').number, '12');
  assert.equal(mergeTarget('gh pr merge "5"').number, '5');
  assert.deepEqual(mergeTarget('gh -R o/r pr merge 7'), { number: '7', selector: '7', repo: 'o/r' });
  const url = mergeTarget('gh pr merge --auto --merge https://github.com/o/r/pull/31');
  assert.deepEqual([url.number, url.repo], ['31', 'o/r']);
  assert.deepEqual(mergeTarget('echo "-R a/b" && gh pr merge 8 -R c/d'), { number: '8', selector: '8', repo: 'c/d' });
  assert.deepEqual(mergeTarget('gh pr merge --merge'), { number: undefined, selector: undefined, repo: undefined });
  assert.equal(mergeTarget('gh pr view 5'), null);
});

test('review path parsing', () => {
  const body = '## Review\n- `D:\\w\\reviews\\a.md`, and D:/w/reviews/b.md.\n- docs/notes/c.md\n## Test plan\nreviews/d.md';
  assert.deepEqual(reviewPaths(body), ['D:\\w\\reviews\\a.md', 'D:/w/reviews/b.md']);
});

// Coverage of the final code: real git in a temp repo, real gh JSON shape.
function repoWith(files) {
  const repo = tmp();
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'x');
  return { repo, git, head: git('rev-parse', 'HEAD'), blob: (name) => git('hash-object', name) };
}

const realView = (repo, head, paths) => () => JSON.stringify({ files: paths.map((p) => ({ path: p })), number: 5, headRefOid: head, body: '' });

function coverageCase(blockLines, dir = tmp(), heading = 'Reviewed files:') {
  const block = blockLines === null ? 'no block here' : `${heading}
${blockLines.join('\n')}\n`;
  const high = reviewFile(dir, 'x-high.md', `findings
${block}`);
  const medium = reviewFile(dir, 'x-medium.md', `findings
${block}`);
  return `## Review
${high}
${medium}`;
}

test('review blocks whose blobs match the PR head are allowed (also for files reviewed uncommitted)', () => {
  const r = repoWith({ 'src/a.cs': 'one', 'src/b.cs': 'two', 'README.md': 'doc' });
  const body = coverageCase([`src/a.cs ${r.blob('src/a.cs')}`, `src/b.cs ${r.blob('src/b.cs')}`]);
  const view = () => JSON.stringify({ files: [{ path: 'src/a.cs' }, { path: 'src/b.cs' }, { path: 'README.md' }], number: 5, headRefOid: r.head, body });
  assert.equal(gate(input('gh pr merge 5', r.repo), view, undefined), null);
});

test('a file changed after the review is denied with the paths', () => {
  const r = repoWith({ 'src/a.cs': 'one', 'src/b.cs': 'two' });
  const body = coverageCase([`src/a.cs ${r.blob('src/a.cs')}`, `src/b.cs ${SHA}`]);
  const view = () => JSON.stringify({ files: [{ path: 'src/a.cs' }, { path: 'src/b.cs' }], number: 5, headRefOid: r.head, body });
  const verdict = gate(input('gh pr merge 5', r.repo), view);
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /code changed after the last review: src\/b\.cs; run a check pass and list it/);
  assert.match(reason(verdict), /gh pr edit <n> --body-file/);
});

test('a changed file missing from the block, and a review with no block, are denied', () => {
  const r = repoWith({ 'src/a.cs': 'one', 'src/b.cs': 'two' });
  const files = [{ path: 'src/a.cs' }, { path: 'src/b.cs' }];
  const missing = coverageCase([`src/a.cs ${r.blob('src/a.cs')}`]);
  assert.match(reason(gate(input('gh pr merge 5', r.repo), () => JSON.stringify({ files, number: 5, headRefOid: r.head, body: missing }))), /src\/b\.cs/);
  const none = coverageCase(null);
  assert.match(reason(gate(input('gh pr merge 5', r.repo), () => JSON.stringify({ files, number: 5, headRefOid: r.head, body: none }))), /code changed after the last review/);
});

test('any listed review covers a file, whatever the file times: one stale block does not hide a matching one', () => {
  const r = repoWith({ 'src/a.cs': 'one', 'src/b.cs': 'two' });
  const dir = tmp();
  const high = reviewFile(dir, 'x-high.md', `Reviewed files:
src/a.cs ${r.blob('src/a.cs')}
`);
  const medium = reviewFile(dir, 'x-medium.md', `Reviewed files:
src/a.cs ${SHA}
src/b.cs ${r.blob('src/b.cs')}
`);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(medium, later, later);
  const body = `## Review
${high}
${medium}`;
  const files = [{ path: 'src/a.cs' }, { path: 'src/b.cs' }];
  assert.equal(gate(input('gh pr merge 5', r.repo), () => JSON.stringify({ files, number: 5, headRefOid: r.head, body })), null);
  const more = [...files, { path: 'src/c.cs' }];
  assert.match(reason(gate(input('gh pr merge 5', r.repo), () => JSON.stringify({ files: more, number: 5, headRefOid: r.head, body }))), /src\/c\.cs/);
});

test('the Reviewed files heading may carry # marks or ** and the last block wins', () => {
  const r = repoWith({ 'src/a.cs': 'one' });
  const files = [{ path: 'src/a.cs' }];
  const blob = r.blob('src/a.cs');
  for (const heading of ['## Reviewed files:', '**Reviewed files:**', '**Reviewed files**:', '### **Reviewed files:**']) {
    const body = coverageCase([`src/a.cs ${blob}`], tmp(), heading);
    assert.equal(gate(input('gh pr merge 5', r.repo), () => JSON.stringify({ files, number: 5, headRefOid: r.head, body })), null, heading);
  }
  const quoted = reviewFile(tmp(), 'q-high.md', `Reviewed files:
src/a.cs ${SHA}

later

Reviewed files:
src/a.cs ${blob}
`);
  assert.equal(reviewedFiles(fs.readFileSync(quoted, 'utf8')).get('src/a.cs'), blob);
});

test('a denial for a review with no parseable block says so', () => {
  const r = repoWith({ 'src/a.cs': 'one' });
  const body = coverageCase(null);
  const verdict = gate(input('gh pr merge 5', r.repo), () => JSON.stringify({ files: [{ path: 'src/a.cs' }], number: 5, headRefOid: r.head, body }));
  assert.match(reason(verdict), /no listed review file has a parseable `Reviewed files:` block/);
});

test('merging main into the branch after the review does not deny; a later own commit does', () => {
  const r = repoWith({ 'src/a.cs': 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n' });
  const file = path.join(r.repo, 'src/a.cs');
  r.git('branch', '-M', 'main');
  r.git('checkout', '-q', '-b', 'feat');
  fs.writeFileSync(file, 'L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n');
  r.git('commit', '-q', '-am', 'branch edit');
  const reviewed = r.blob('src/a.cs');
  r.git('checkout', '-q', 'main');
  fs.writeFileSync(file, 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nL8\n');
  r.git('commit', '-q', '-am', 'main edit');
  r.git('checkout', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'main');
  const head = r.git('rev-parse', 'HEAD');
  assert.notEqual(r.git('rev-parse', 'HEAD:src/a.cs'), reviewed);
  const body = coverageCase([`src/a.cs ${reviewed}`]);
  const files = [{ path: 'src/a.cs' }];
  assert.equal(gate(input('gh pr merge 5', r.repo), () => JSON.stringify({ files, number: 5, headRefOid: head, body })), null);
  fs.appendFileSync(file, 'l9\n');
  r.git('commit', '-q', '-am', 'after review');
  const after = r.git('rev-parse', 'HEAD');
  assert.ok(denied(gate(input('gh pr merge 5', r.repo), () => JSON.stringify({ files, number: 5, headRefOid: after, body }))));
});

// A fake `gh api`: contents routes answer from `blobs` (path -> sha) or `at[ref][path]`; the PR's commit list
// (`pulls/<n>/commits`) answers `own` (the last own commit sha, or '').
const apiError = (stderr) => Object.assign(new Error(`Command failed: gh api repos/o/404.html`), { stderr });
const fakeApi = ({ blobs = {}, own = '', at = {}, asked = [] } = {}) => (args) => {
  asked.push(args[0]);
  const contents = /\/contents\/([^?]+)\?ref=(\w+)/.exec(args[0]);
  if (contents) {
    const file = decodeURIComponent(contents[1]);
    const sha = at[contents[2]]?.[file] ?? blobs[file];
    if (!sha) throw apiError('gh: Not Found (HTTP 404)');
    return `${sha}\n`;
  }
  return /\/pulls\/\d+\/commits$/.test(args[0]) ? `${own}\n` : '';
};

test('a --repo merge of another repo\'s PR is checked through per-path API calls: an uncovered changed file is denied', () => {
  const r = repoWith({ 'src/a.cs': 'one' });
  r.git('remote', 'add', 'origin', 'https://github.com/me/mine.git');
  const body = coverageCase([`src/a.cs ${SHA}`]);
  const view = () => JSON.stringify({ files: [{ path: 'src/a.cs' }], number: 5, headRefOid: r.head, body });
  const asked = [];
  const verdict = gate(input('gh pr merge 5 -R other/repo', r.repo), view, undefined, undefined, fakeApi({ blobs: { 'src/a.cs': 'b'.repeat(40) }, asked }));
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /code changed after the last review: src\/a\.cs/);
  assert.ok(asked.includes(`repos/other/repo/contents/src/a.cs?ref=${r.head}`));
  assert.equal(gate(input('gh pr merge 5 -R other/repo', r.repo), view, undefined, undefined, fakeApi({ blobs: { 'src/a.cs': SHA } })), null);
  assert.ok(denied(gate(input('gh pr merge 5 -R ME/mine', r.repo), view)));
});

test('the API path accepts the blob at the branch\'s last own commit, like the local path', () => {
  const r = repoWith({ 'src/a.cs': 'one' });
  r.git('remote', 'add', 'origin', 'https://github.com/me/mine.git');
  const own = 'c'.repeat(40);
  const body = coverageCase([`src/a.cs ${SHA}`]);
  const view = () => JSON.stringify({ files: [{ path: 'src/a.cs' }], number: 5, headRefOid: r.head, body });
  const api = fakeApi({ blobs: { 'src/a.cs': 'b'.repeat(40) }, own, at: { [own]: { 'src/a.cs': SHA } } });
  assert.equal(gate(input('gh pr merge 5 -R other/repo', r.repo), view, undefined, undefined, api), null);
});

test('a large repo is no obstacle: no tree listing is read, so truncation cannot occur', () => {
  const r = repoWith({ 'src/a.cs': 'one' });
  r.git('remote', 'add', 'origin', 'https://github.com/me/mine.git');
  const body = coverageCase([`src/a.cs ${SHA}`]);
  const view = () => JSON.stringify({ files: [{ path: 'src/a.cs' }], number: 5, headRefOid: r.head, body });
  const asked = [];
  assert.equal(gate(input('gh pr merge 5 -R other/repo', r.repo), view, undefined, undefined, fakeApi({ blobs: { 'src/a.cs': SHA }, asked })), null);
  assert.ok(asked.length && asked.every((a) => !/git\/trees/.test(a)));
});

test('a cross-repo PR whose API read fails fails open with a reason; a removed file matches deleted', () => {
  const r = repoWith({ 'src/a.cs': 'one' });
  r.git('remote', 'add', 'origin', 'https://github.com/me/mine.git');
  const view = (body, p) => () => JSON.stringify({ files: [{ path: p }], number: 5, headRefOid: r.head, body });
  const notes = [];
  const broken = () => { throw apiError('gh: HTTP 502'); };
  assert.equal(gate(input('gh pr merge 5 -R other/repo', r.repo), view(coverageCase([`src/a.cs ${SHA}`]), 'src/a.cs'), (t) => notes.push(t), undefined, broken), null);
  assert.match(notes.join(''), /let the call through/);
  assert.equal(gate(input('gh pr merge 5 -R other/repo', r.repo), view(coverageCase(['src/gone.cs deleted']), 'src/gone.cs'), undefined, undefined, fakeApi()), null);
});

test('only HTTP 404 on stderr means deleted: a 404 in the command line or another error fails open', () => {
  const r = repoWith({ 'src/a.cs': 'one' });
  r.git('remote', 'add', 'origin', 'https://github.com/me/mine.git');
  const view = () => JSON.stringify({ files: [{ path: 'src/404.html' }], number: 5, headRefOid: r.head, body: coverageCase(['src/404.html deleted']) });
  const notes = [];
  const flaky = () => { throw apiError('gh: HTTP 503 (Service Unavailable)'); };
  assert.equal(gate(input('gh pr merge 5 -R other/repo', r.repo), view, (t) => notes.push(t), undefined, flaky), null);
  assert.match(notes.join(''), /let the call through/);
  const notFound = () => { throw apiError('gh: Not Found (HTTP 404)'); };
  assert.equal(gate(input('gh pr merge 5 -R other/repo', r.repo), view, undefined, undefined, notFound), null);
});

test('the API own commit comes from the PR commit list, not a repo-wide path query', () => {
  const r = repoWith({ 'src/a.cs': 'one' });
  r.git('remote', 'add', 'origin', 'https://github.com/me/mine.git');
  const own = 'c'.repeat(40);
  const view = () => JSON.stringify({ files: [{ path: 'src/a.cs' }], number: 5, headRefOid: r.head, body: coverageCase([`src/a.cs ${SHA}`]) });
  const asked = [];
  gate(input('gh pr merge 5 -R other/repo', r.repo), view, undefined, undefined, fakeApi({ blobs: { 'src/a.cs': 'b'.repeat(40) }, own, at: { [own]: { 'src/a.cs': SHA } }, asked }));
  assert.ok(asked.includes('repos/other/repo/pulls/5/commits'));
  assert.ok(asked.every((a) => !/\/commits\?/.test(a)));
});

test('the repo slug is read from host and URL forms, for the cwd check and the API route', () => {
  assert.equal(repoSlug('o/r'), 'o/r');
  assert.equal(repoSlug('github.com/o/r'), 'o/r');
  assert.equal(repoSlug('https://github.com/o/r'), 'o/r');
  assert.equal(repoSlug('https://github.com/o/r.git'), 'o/r');
  assert.equal(repoSlug('git@github.com:o/r.git'), 'o/r');
  const r = repoWith({ 'src/a.cs': 'one' });
  r.git('remote', 'add', 'origin', 'https://github.com/me/mine.git');
  const body = coverageCase([`src/a.cs ${SHA}`]);
  const view = () => JSON.stringify({ files: [{ path: 'src/a.cs' }], number: 5, headRefOid: r.head, body });
  const asked = [];
  gate(input('gh pr merge 5 -R https://github.com/other/repo.git', r.repo), view, undefined, undefined, fakeApi({ blobs: { 'src/a.cs': SHA }, asked }));
  assert.ok(asked.includes(`repos/other/repo/contents/src/a.cs?ref=${r.head}`));
});

test('a merge the raw text shows in command position but the tokenizer lost is denied', () => {
  const docs = view({ files: [{ path: 'README.md' }] });
  for (const cmd of ["cat <<EOF\nit's odd\ngh pr merge 5 --merge", "echo 'oops\ngh -R o/r pr merge 5", "echo 'oops\nx && gh pr -R o/r merge 5", "echo 'oops\n(gh pr merge 5)", "echo 'oops\n$(gh  pr  merge 5)"]) {
    const verdict = gate(input(cmd), docs);
    assert.ok(denied(verdict), cmd);
    assert.match(reason(verdict), /could not parse it as a merge/);
    assert.match(reason(verdict), /gh pr checks <n> --watch --fail-fast && gh pr merge <n> --merge/);
  }
});

test('quoted << text, arithmetic shifts and prose naming a merge do not trip the raw scan', () => {
  const docs = view({ files: [{ path: 'README.md' }] });
  assert.equal(gate(input("git commit -m 'explain <<EOF handling'\ngh pr merge 5 --merge"), docs), null);
  assert.equal(gate(input('echo "<<EOF"\ngh pr merge 5 --merge'), docs), null);
  assert.equal(gate(input('x=$((a<<2))\ngh pr merge 5 --merge'), docs), null);
  assert.equal(gate(input('echo "use gh pr merge later"'), docs), null);
  assert.equal(gate(input("echo 'use gh pr merge later"), docs), null);
  assert.equal(gate(input('cat <<EOF\nnote\nEOF\ngh pr merge 5 --merge'), docs), null);
  assert.equal(gate(input('cat <<EOF\r\nnote\r\nEOF\r\ngh pr merge 5 --merge'), docs), null);
  assert.equal(gate(input('cat <<EOF\nonly data, no merge here'), docs), null);
});

test('the raw scan sees -R and --repo forms in command position only', () => {
  assert.equal(rawMergeInCommandPosition('gh --repo=o/r pr merge 5'), true);
  assert.equal(rawMergeInCommandPosition('a;gh pr merge 5'), true);
  assert.equal(rawMergeInCommandPosition('a | gh pr merge 5'), true);
  assert.equal(rawMergeInCommandPosition('echo gh pr merge 5'), false);
  assert.equal(rawMergeInCommandPosition('gh pr view 5'), false);
  assert.equal(rawMergeInCommandPosition('gh pr merge-queue 5'), false);
});

test('a deleted file matches a deleted entry', () => {
  const r = repoWith({ 'src/a.cs': 'one' });
  const body = coverageCase(['src/gone.cs deleted']);
  const view = () => JSON.stringify({ files: [{ path: 'src/gone.cs' }], number: 5, headRefOid: r.head, body });
  assert.equal(gate(input('gh pr merge 5', r.repo), view), null);
});

test('a dotted owner or repo in --repo is parsed, not thrown on', () => {
  const r = repoWith({ 'src/a.cs': 'one' });
  r.git('remote', 'add', 'origin', 'https://github.com/my.org/repo.name.git');
  const body = coverageCase([`src/a.cs ${SHA}`]);
  const view = () => JSON.stringify({ files: [{ path: 'src/a.cs' }], number: 5, headRefOid: r.head, body });
  const notes = [];
  assert.ok(denied(gate(input('gh pr merge 5 -R my.org/repo.name', r.repo), view, (t) => notes.push(t))));
  assert.ok(denied(gate(input('gh pr merge 5 -R github.com/my.org/repo.name', r.repo), view, (t) => notes.push(t))));
  assert.equal(notes.length, 0);
});

test('a git failure resolving a file blob is unknown (fail open), not deleted', () => {
  const r = repoWith({ 'src/a.cs': 'one' });
  const body = coverageCase(['src/a.cs deleted']);
  const view = () => JSON.stringify({ files: [{ path: 'src/a.cs' }], number: 5, headRefOid: r.head, body });
  const failing = (cwd, args) => {
    if (args[0] === 'ls-tree') throw new Error('fatal: shallow clone');
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  };
  const notes = [];
  assert.equal(gate(input('gh pr merge 5', r.repo), view, (t) => notes.push(t), failing), null);
  assert.match(notes.join(''), /let the call through/);
  assert.ok(denied(gate(input('gh pr merge 5', r.repo), view)), 'a stale deleted entry for an existing file is still denied with working git');
});

test('git that cannot resolve the head fails open with a reason', () => {
  const dir = tmp();
  const body = coverageCase([`src/a.cs ${SHA}`]);
  const notes = [];
  const view = () => JSON.stringify({ files: [{ path: 'src/a.cs' }], number: 5, headRefOid: 'd'.repeat(40), body });
  assert.equal(gate(input('gh pr merge 5', dir), view, (t) => notes.push(t)), null);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /let the call through/);
});

test('the Reviewed files block parser', () => {
  const sha = 'b'.repeat(40);
  const map = reviewedFiles(`x
Reviewed files:
src/a b.cs ${sha}
- \`src/c.cs\` ${sha}
old\\path.cs deleted

after`);
  assert.equal(map.get('src/a b.cs'), sha);
  assert.equal(map.get('src/c.cs'), sha);
  assert.equal(map.get('old/path.cs'), 'deleted');
  assert.equal(reviewedFiles('nothing'), null);
});

test('a merge with a pending or failed check is denied unless the command waits for checks first', () => {
  const files = [{ path: 'README.md' }];
  const pending = [{ name: 'tests', status: 'IN_PROGRESS', conclusion: '' }];
  const failed = [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }, { context: 'cf', state: 'SUCCESS' }];
  assert.ok(denied(decide(input(), view({ files, statusCheckRollup: pending }))));
  const verdict = decide(input('gh pr checks 12 --fail-fast | cat && gh pr merge 12 --merge'), view({ files, statusCheckRollup: failed }));
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /build \(FAILURE\)/);
  assert.doesNotMatch(reason(verdict), /cf \(/);
  assert.equal(decide(input('gh pr checks 12 --watch --fail-fast && gh pr merge 12 --merge'), view({ files, statusCheckRollup: pending })), null);
  assert.equal(decide(input('gh pr checks 12 --watch && echo ok && gh pr merge 12 --merge'), view({ files, statusCheckRollup: pending })), null);
  assert.ok(denied(decide(input('gh pr checks 12 --watch || gh pr merge 12 --merge'), view({ files, statusCheckRollup: pending }))));
  assert.equal(decide(input('gh pr merge 12 --auto --merge'), view({ files, statusCheckRollup: pending })), null);
  assert.equal(decide(input('gh pr merge 12 --disable-auto'), view({ files, statusCheckRollup: pending })), null);
});

test('green, skipped and neutral checks, or none, let a docs-only merge through', () => {
  const files = [{ path: 'README.md' }];
  const green = [{ name: 'a', conclusion: 'SUCCESS' }, { name: 'b', conclusion: 'SKIPPED' }, { name: 'c', conclusion: 'NEUTRAL' }];
  assert.equal(decide(input(), view({ files, statusCheckRollup: green })), null);
  assert.equal(decide(input(), view({ files, statusCheckRollup: [] })), null);
  const superseded = [{ name: 'old', conclusion: 'STALE' }];
  assert.equal(decide(input(), view({ files, statusCheckRollup: superseded })), null);
});

test('a cancelled check (for example an iOS job that got no runner) is denied and the message says to rerun it', () => {
  const files = [{ path: 'README.md' }];
  const verdict = decide(input(), view({ files, statusCheckRollup: [{ name: 'build-ios / build', conclusion: 'CANCELLED' }] }));
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /build-ios \/ build \(CANCELLED\)/);
  assert.match(reason(verdict), /rerun/);
});

const DOCS = view({ files: [{ path: 'a.md' }] });

test('a directory-changing word without --repo or a URL is denied and names --repo', () => {
  const words = ['cd', 'pushd', 'popd', 'chdir', 'Set-Location', 'sl', 'Push-Location', 'Pop-Location', 'CD'];
  const commands = words.flatMap((w) => [
    `${w} /d/x && gh pr merge 5 --merge`,
    `${w} D:\\x; gh pr merge 5`,
    `if true; then ${w} /d/x; fi; gh pr merge 5`,
    `for d in a b; do ${w} $d; gh pr merge 5; done`,
    `(${w} /d/x && gh pr merge 5)`,
    `$(${w} x) && gh pr merge 5`,
    `${w} /d/x || exit 1; gh pr merge 5`,
  ]);
  for (const command of commands) {
    const verdict = decide(input(command), DOCS);
    assert.ok(denied(verdict), command);
    assert.match(reason(verdict), /add --repo <owner>\/<repo> to gh pr merge/, command);
  }
});

test('a directory change is fine when the repo is pinned by --repo, -R or a PR URL', () => {
  for (const command of [
    'cd /d/x && gh pr merge 5 --repo o/r', 'cd /d/x && gh pr merge 5 -R o/r', 'cd ~ && gh -R o/r pr merge 5',
    'Set-Location D:\\x; gh pr merge https://github.com/o/r/pull/5', 'cd - && gh pr merge 5 --repo=o/r',
  ]) assert.equal(decide(input(command), DOCS), null, command);
});

test('a checks watch chained to the merge with no cd is allowed', () => {
  const rollup = [{ name: 'build', status: 'IN_PROGRESS' }];
  const command = 'gh pr checks 5 --watch --fail-fast && gh pr merge 5 --merge';
  assert.equal(decide(input(command), view({ files: [{ path: 'a.md' }], statusCheckRollup: rollup })), null);
});

test('words that merely contain cd are not a directory change', () => {
  assert.equal(decide(input('cdk deploy && gh pr merge 5'), DOCS), null);
  assert.equal(decide(input('gh pr merge 5 --body "fix cd bug"'), DOCS), null);
  assert.equal(decide(input('gh pr merge feature/cd-fix'), DOCS), null);
  assert.equal(decide(input('git -C /d/cd/x status; gh pr merge 5'), DOCS), null);
});

test('a grouped merge is parsed and only a grouped selector loses its closing bracket', () => {
  assert.equal(mergeTarget('(gh pr merge 5)').number, '5');
  assert.equal(mergeTarget('{ gh pr merge 5; }').number, '5');
  assert.equal(mergeTarget('$(gh pr merge 5)').number, '5');
  assert.equal(mergeTarget('(gh pr merge feature/x)').selector, 'feature/x');
});

test('a closing bracket is dropped from the selector and --repo wherever the merge sits', () => {
  assert.equal(mergeTarget('(gh pr checks 5 --watch && gh pr merge 5)').selector, '5');
  assert.equal(mergeTarget('(gh pr checks 5 --watch && gh pr merge 5)').number, '5');
  assert.equal(mergeTarget('(gh pr merge 5 --repo o/r)').repo, 'o/r');
  assert.equal(mergeTarget('echo $(gh pr merge 5)').number, '5');
});

test('cd.., cd\\, cd/d and \\cd are directory changes', () => {
  for (const cd of ['cd..', 'cd\\', 'cd/d D:\\x', '\\cd /x', 'cd../..', 'chdir..']) {
    assert.ok(denied(decide(input(`${cd} && gh pr merge 5`), DOCS)), cd);
    assert.ok(denied(decide(input(`${cd} ; gh pr merge 5`), DOCS)), cd);
  }
});

test('builtin cd, command cd and an env-prefixed cd are directory changes', () => {
  for (const cd of ['builtin cd /x', 'command cd /x', 'FOO=1 cd /x', 'A=1 B=2 pushd /x']) {
    assert.ok(denied(decide(input(`${cd} && gh pr merge 5`), DOCS)), cd);
  }
  assert.equal(decide(input('FOO=1 gh pr merge 5'), DOCS), null);
});

test('every merge of a command is gated, any deny denies the call', () => {
  const two = 'gh pr merge 1 --repo a/b; cd /x; gh pr merge 6';
  assert.ok(denied(decide(input(two), DOCS)));
  const calls = [];
  const gh = (target) => {
    calls.push(target.number);
    return target.number === '1' ? DOCS() : JSON.stringify({ files: [{ path: 'src/a.cs' }], body: '', number: 2 });
  };
  assert.ok(denied(decide(input('gh pr merge 1 --merge && gh pr merge 2 --merge'), gh)));
  assert.deepEqual(calls, ['1', '2']);
});

test('a variable selector after a cd is unresolvable and denied unless the repo is pinned', () => {
  for (const sel of ['$n', '${n}', '$(pick)']) {
    assert.ok(denied(decide(input(`cd /x && gh pr merge ${sel}`), DOCS)), sel);
    assert.equal(decide(input(`cd /x && gh pr merge ${sel} --repo o/r`), DOCS), null, sel);
  }
  assert.ok(denied(decide(input('for n in 5 6; do cd /x; gh pr merge $n; done'), DOCS)));
});

test('only a directory change before the merge counts', () => {
  assert.equal(decide(input('gh pr merge 5 --merge && cd /d/x && git pull --ff-only'), DOCS), null);
  assert.equal(decide(input('gh pr merge 5 --body-file - <<EOF\nwe cd here\ncd /x\nEOF'), DOCS), null);
  assert.equal(decide(input('git checkout cd && gh pr merge 5'), DOCS), null);
  assert.equal(decide(input('echo sl; gh pr merge 5'), DOCS), null);
  assert.ok(denied(decide(input('while true; do gh pr merge 5; cd /x; done'), DOCS)));
});

test('a pinned repo with cd keeps its behaviour for a code PR (checked in the session cwd)', () => {
  const code = view({ files: [{ path: 'src/a.cs' }], body: '' });
  const verdict = decide(input('cd /x && gh pr merge 5 --repo o/r'), code);
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /## Review|review/i);
  assert.equal(decide(input('cd /x && gh pr merge 5 --repo o/r'), DOCS), null);
});

test('documented limits: env -C and GH_REPO are not seen (let through); a wrapper string with a merge after && is denied', () => {
  for (const command of ['env -C /x gh pr merge 5', 'GH_REPO=o/r gh pr merge 5', 'bash -c "gh pr merge 5"']) {
    assert.equal(decide(input(command), DOCS), null, command);
  }
  assert.equal(mergeTarget('bash -c "cd /x && gh pr merge 5"'), null);
  assert.ok(denied(decide(input('bash -c "cd /x && gh pr merge 5"'), DOCS)));
});

test('contentPaths from .claude/merge-gate.json on the base branch make matching files count as docs', () => {
  const config = JSON.stringify({ contentPaths: ['content/dino/**'] });
  const git = (cwd, args) => (args[0] === 'show' && args[1] === 'origin/main:.claude/merge-gate.json' ? config : SHA);
  const files = [{ path: 'content/dino/book/book.json' }, { path: 'content/dino/book/pictures/1.png' }, { path: 'x.md' }];
  assert.equal(decide(input(), view({ files, body: '' }), undefined, git), null);
  assert.ok(denied(decide(input(), view({ files: [...files, { path: 'src/App.cs' }], body: '' }), undefined, git)));
  assert.ok(denied(decide(input(), view({ files, body: '' }))), 'no config: strict');
  const broken = (cwd, args) => (args[0] === 'show' ? '{not json' : SHA);
  assert.ok(denied(decide(input(), view({ files, body: '' }), undefined, broken)), 'bad config: strict');
});

test('globToRegExp: ** any depth, * within a folder', () => {
  assert.ok(globToRegExp('content/dino/**').test('content/dino/a/b.json'));
  assert.ok(!globToRegExp('content/dino/**').test('content/dinox/a.json'));
  assert.ok(globToRegExp('content/*.json').test('content/a.json'));
  assert.ok(!globToRegExp('content/*.json').test('content/a/b.json'));
});

test('contentPaths still apply when --repo names the hook cwd own repo, not for another repo', () => {
  const config = JSON.stringify({ contentPaths: ['content/dino/**'] });
  const git = (cwd, args) => (args[0] === 'show' ? config : args[0] === 'remote' ? 'https://github.com/o/r.git' : SHA);
  const files = [{ path: 'content/dino/book/book.json' }];
  assert.equal(decide(input('gh pr merge 12 --merge --repo o/r'), view({ files, body: '' }), undefined, git), null);
  assert.ok(denied(decide(input('gh pr merge 12 --merge --repo o/other'), view({ files, body: '' }), undefined, git)));
});

test('a PR opened under 90 s ago with no checks listed is denied unless the command waits', () => {
  const dir = tmp();
  const passes = `## Review\n${reviewFile(dir, 'y-high.md')}\n${reviewFile(dir, 'y-medium.md')}`;
  const fresh = view({ body: passes, createdAt: new Date().toISOString(), statusCheckRollup: [] });
  const old = view({ body: passes, createdAt: '2020-01-01T00:00:00Z', statusCheckRollup: [] });
  const freshDocs = view({ files: [{ path: 'README.md' }], createdAt: new Date().toISOString(), statusCheckRollup: [] });
  assert.equal(decide(input('gh pr merge 12 --merge'), freshDocs), null);
  assert.equal(decide(input('gh pr merge 12 --merge --auto'), fresh), null);
  assert.ok(denied(decide(input('gh pr merge 12 --merge'), fresh)));
  assert.equal(decide(input('gh pr checks 12 --watch --fail-fast && gh pr merge 12 --merge'), fresh), null);
  assert.equal(decide(input('gh pr merge 12 --merge'), old), null);
  assert.ok(!tooYoungForChecks({ createdAt: new Date().toISOString(), statusCheckRollup: [{ conclusion: 'SUCCESS' }] }));
});

test('the young-PR denial prints the seconds left', () => {
  const dir = tmp();
  const passes = `## Review\n${reviewFile(dir, 'z-high.md')}\n${reviewFile(dir, 'z-medium.md')}`;
  const created = new Date(Date.now() - 30 * 1000).toISOString();
  const fresh = view({ body: passes, createdAt: created, statusCheckRollup: [] });
  const reason = decide(input('gh pr merge 12 --merge'), fresh).hookSpecificOutput.permissionDecisionReason;
  const left = Number(/\((\d+) s left/.exec(reason)?.[1]);
  assert.ok(left >= 55 && left <= 60, reason);
  assert.match(reason, new RegExp(`after ${left} s`));
});

test('--subject and -t values carrying [skip ci] are not read as the selector (batch release merge)', () => {
  const subject = 'Merge pull request #5 from o/feat/x [skip ci]';
  for (const flag of ['--subject', '-t']) {
    const target = mergeTarget(`gh pr merge 5 --repo o/r --merge ${flag} "${subject}"`);
    assert.equal(target.selector, '5', flag);
    assert.equal(target.number, '5', flag);
    assert.equal(target.repo, 'o/r', flag);
  }
  assert.equal(mergeTarget(`gh pr merge --subject "${subject}" 5`).selector, '5');
});

// A real primary checkout with its worktrees folder, for the batch-open checks (batch-release.json sits next to the primary).
function batchRepo(state) {
  const parent = tmp();
  const repo = path.join(parent, 'proj');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  if (state) {
    fs.mkdirSync(path.join(parent, 'proj-worktrees'));
    fs.writeFileSync(path.join(parent, 'proj-worktrees', 'batch-release.json'), JSON.stringify(state));
  }
  return repo;
}
const realGit = (cwd, args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
const OPEN_BATCH = () => ({ baseSha: 'b'.repeat(40), batchStartedAt: new Date().toISOString() });
const SKIP_SUBJECT = '--subject "Merge pull request #12 from o/feat/x [skip ci]"';

test('while the repo batch is open a merge without a [skip ci] subject is denied, even for docs', () => {
  const repo = batchRepo(OPEN_BATCH());
  const verdict = gate(input('gh pr merge 12 --merge', repo), view({ files: [{ path: 'README.md' }] }), undefined, realGit);
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /batch release is open/);
  assert.match(reason(verdict), /\[skip ci\]/);
});

test('the open-batch denial names the file by its full path and when the batch started', () => {
  const state = OPEN_BATCH();
  const repo = batchRepo(state);
  const verdict = gate(input('gh pr merge 12 --merge', repo), view({ files: [{ path: 'README.md' }] }), undefined, realGit);
  const file = path.join(path.dirname(repo), 'proj-worktrees', 'batch-release.json');
  assert.ok(reason(verdict).includes(file) || reason(verdict).toLowerCase().includes(file.toLowerCase()), reason(verdict));
  assert.ok(reason(verdict).includes(state.batchStartedAt), reason(verdict));
});

test('while the batch is open a [skip ci] subject (--subject, -t, --subject=) passes', () => {
  const repo = batchRepo(OPEN_BATCH());
  const docs = view({ files: [{ path: 'README.md' }] });
  for (const flag of [SKIP_SUBJECT, '-t "x [skip ci]"', '--subject="x [skip ci]"']) {
    assert.equal(gate(input(`gh pr merge 12 --merge ${flag}`, repo), docs, undefined, realGit), null, flag);
  }
});

test('no batch file, a released batch (no base) or a stale one (older than 24 h) does not gate the subject', () => {
  const docs = view({ files: [{ path: 'README.md' }] });
  const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  for (const state of [null, { baseSha: null, batchStartedAt: new Date().toISOString() }, { baseSha: 'b'.repeat(40), batchStartedAt: old }]) {
    assert.equal(gate(input('gh pr merge 12 --merge', batchRepo(state)), docs, undefined, realGit), null);
  }
});

test('the age of an open batch comes from its own last start, not the first-ever startedAt or an old runStartedAt', () => {
  const docs = view({ files: [{ path: 'README.md' }] });
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const fresh = { baseSha: 'b'.repeat(40), startedAt: old, runStartedAt: old, batchStartedAt: new Date().toISOString() };
  assert.ok(denied(gate(input('gh pr merge 12 --merge', batchRepo(fresh)), docs, undefined, realGit)));
  const forgotten = { baseSha: 'b'.repeat(40), startedAt: new Date().toISOString(), runStartedAt: new Date().toISOString(), batchStartedAt: old };
  assert.equal(gate(input('gh pr merge 12 --merge', batchRepo(forgotten)), docs, undefined, realGit), null);
});

test('a merge into another repo (--repo) is not held to the open batch of the hook repo', () => {
  const repo = batchRepo(OPEN_BATCH());
  const docs = view({ files: [{ path: 'README.md' }] });
  const git = (cwd, args) => (args[0] === 'remote' ? 'https://github.com/o/r.git' : realGit(cwd, args));
  assert.equal(gate(input('gh pr merge 12 --repo other/repo --merge', repo), docs, undefined, git), null);
});

test('a merge after then/do/else/{ hidden by an unclosed quote is denied by the raw scan', () => {
  const docs = view({ files: [{ path: 'README.md' }] });
  for (const cmd of ["echo 'oops\nif x; then gh pr merge 5", "echo 'oops\nfor i in 1; do gh pr merge 5", "echo 'oops\nx && { gh pr merge 5", "echo 'oops\nif x; then :; else gh pr merge 5"]) {
    assert.ok(denied(gate(input(cmd), docs)), cmd);
  }
  assert.equal(rawMergeInCommandPosition('if x; then gh pr merge 5; fi'), true);
  assert.equal(rawMergeInCommandPosition('echo "what to do gh pr merge 5"'), false);
});

test('a read-only search whose quoted pattern holds a merge command is allowed (Slice 19: denied before)', () => {
  const docs = view({ files: [{ path: 'README.md' }] });
  for (const cmd of ['grep -n "&& gh pr merge" file | head', 'grep -n "; gh pr merge 5" file', "rg 'x | gh pr merge 5' docs", "grep 'a\ngh pr merge 5' f | head", 'cat f | grep -c "&& gh pr merge"', "grep -rn -e '; gh pr merge 5' skills", "grep -n 'a\\.b; gh pr merge' f", 'grep -n "&& gh pr merge" f 2>&1 | head', 'grep -n "&& gh pr merge" f >&2', 'grep -n "&& gh pr merge" f || true', 'grep -n "&& gh pr merge" f 2>/dev/null']) {
    assert.equal(rawMergeInCommandPosition(cmd), false, cmd);
    assert.equal(gate(input(cmd), docs), null, cmd);
  }
});

test('a real merge stays gated next to a search pattern, after an unclosed quote, or inside a quote that can run it', () => {
  const docs = view({ files: [{ path: 'README.md' }] });
  for (const cmd of ['grep -n "x" f ; gh pr merge 5', 'grep "&& gh pr merge" f && gh pr merge 5', 'grep "$(true; gh pr merge 5)" f', 'grep "&& gh pr merge" "$(true; gh pr merge 5)"','echo "&& gh pr merge 5" | cat', "grep 'x' f | head\ngh pr merge 5", "grep 'oops\ngh pr merge 5", 'echo hi\n# ; grep "\ngh pr merge 5 ; echo "x', 'grep "&& gh pr merge" f # note\ngh pr merge 5', 'grep "&& gh pr merge" f\ngh pr merge 5', 'grep "&& gh pr merge" f # c']) {
    assert.equal(rawMergeInCommandPosition(cmd), true, cmd);
  }
  assert.ok(denied(gate(input('grep "&& gh pr merge" f && gh pr merge 12 --merge'), view({ body: '' }))));
});

// Shapes dropped on purpose (git grep, ag) are denied too, but only as over-denial; the rest are real bypass attempts.
test('bypass shapes around a search pattern stay denied (Slice 19 review 1-5)', () => {
  const bypasses = [
    'grep \\" ; gh pr merge 5 ; echo \\"',
    "grep \\' ; gh pr merge 5 ; echo \\'",
    'grep x f & bash -c "echo; gh pr merge 5"',
    "grep x $(bash -c 'a; gh pr merge 5')",
    "grep x `bash -c 'a; gh pr merge 5'`",
    "grep x <(bash -c 'a; gh pr merge 5')",
    "git grep -O'sh -c \"x; gh pr merge 5\"' pat",
    "ag --pager 'sh -c \"x; gh pr merge 5\"' pat",
    "rg --pre 'sh -c \"x; gh pr merge 5\"' pat f",
    "grep -e 'a' -e 'b; gh pr merge 5' f",
    "grep x f\\\nbash -c 'a; gh pr merge 5'",
    "grep x f | bash -c 'a; gh pr merge 5'",
    "grep -n x f && bash -c 'a; gh pr merge 5'",
  ];
  for (const cmd of bypasses) {
    assert.equal(rawMergeInCommandPosition(cmd), true, cmd);
    assert.ok(denied(gate(input(cmd), view({ body: '' }))), cmd);
  }
});

test('a merge after then/do/{ that the tokenizer sees is gated like any merge', () => {
  assert.ok(denied(gate(input('if true; then gh pr merge 12 --merge; fi'), view({ body: '' }))));
  assert.ok(denied(gate(input('for i in 1; do gh pr merge 12 --merge; done'), view({ body: '' }))));
});

test('a quoted prose line starting gh pr merge is not denied; the same text after && inside a quote still is', () => {
  const docs = view({ files: [{ path: 'README.md' }] });
  assert.equal(gate(input('git commit -m "Fix the gate\ngh pr merge 5 is now checked\nmore"'), docs), null);
  assert.equal(gate(input("git commit -m 'Fix\n  gh pr merge docs\n'"), docs), null);
  assert.equal(rawMergeInCommandPosition('git commit -m "a\ngh pr merge 5"'), false);
  assert.equal(rawMergeInCommandPosition("echo 'oops\ngh pr merge 5"), true);
  assert.ok(denied(gate(input('bash -c "cd /x && gh pr merge 5"'), docs)));
});

test('a merge on its own line inside a wrapper string (bash -c, pwsh -Command, python -c) is still denied', () => {
  const docs = view({ files: [{ path: 'README.md' }] });
  for (const cmd of ['bash -c "set -e\ngh pr merge 5 --merge"', 'pwsh -Command "$x = 1\ngh pr merge 5"', "python -c 'import os\ngh pr merge 5'", 'sh -c "true\n  gh pr merge 5"']) {
    assert.equal(rawMergeInCommandPosition(cmd), true, cmd);
    assert.ok(denied(gate(input(cmd), docs)), cmd);
  }
});

test('a stray apostrophe before a commit message does not turn a wrapper merge into prose', () => {
  assert.equal(rawMergeInCommandPosition('echo it\'s done; bash -c "x\ngh pr merge 5"'), true);
  assert.equal(rawMergeInCommandPosition('git commit --message="a\ngh pr merge 5"'), false);
  assert.equal(rawMergeInCommandPosition('gh pr create --body "a\ngh pr merge 5"'), false);
});

test('the batch release merge command is gated like any merge: docs pass, a code PR without review is denied', () => {
  const command = 'gh pr checks 5 --repo o/r --watch --fail-fast && gh pr merge 5 --repo o/r --merge --subject "Merge pull request #5 from o/feat/x [skip ci]"';
  assert.equal(decide(input(command), DOCS), null);
  assert.ok(denied(decide(input(command), view({ body: '' }))));
});

const DOCS_ONLY = view({ files: [{ path: 'README.md' }] });

test('a merge after gh pr checks joined by a semicolon is denied with a reason naming &&', () => {
  const verdict = decide(input('gh pr checks 272 --watch --fail-fast ; gh pr merge 272 --merge'), DOCS_ONLY);
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /&&/);
});

test('a merge after gh pr checks on the next line is denied, also with a blank line between', () => {
  assert.ok(denied(decide(input('gh pr checks 272 --watch --fail-fast\ngh pr merge 272 --merge'), DOCS_ONLY)));
  assert.ok(denied(decide(input('gh pr checks 272 --watch\n\ngh pr merge 272 --merge'), DOCS_ONLY)));
});

test('a comment line between gh pr checks and the merge does not hide it; a non-gh "pr checks" is no checks call', () => {
  assert.ok(denied(decide(input('gh pr checks 272 --watch\n# merge now\ngh pr merge 272 --merge'), DOCS_ONLY)));
  assert.equal(decide(input('echo pr checks 272 ; gh pr merge 272 --merge'), DOCS_ONLY), null);
});

test('a merge after gh pr checks joined by && is allowed, and a merge after an unrelated semicolon is not touched', () => {
  assert.equal(decide(input('gh pr checks 272 --watch --fail-fast && gh pr merge 272 --merge'), DOCS_ONLY), null);
  assert.equal(decide(input('git status ; gh pr merge 272 --merge'), DOCS_ONLY), null);
});

test('a merge with --auto or --disable-auto after an unchained gh pr checks is allowed: GitHub waits for the checks', () => {
  assert.equal(decide(input('gh pr checks 272 --watch ; gh pr merge 272 --merge --auto'), DOCS_ONLY), null);
  assert.equal(decide(input('gh pr checks 272\ngh pr merge 272 --disable-auto'), DOCS_ONLY), null);
  assert.ok(denied(decide(input('gh pr checks 272 --watch ; gh pr merge 272 --merge'), DOCS_ONLY)));
});

test('gh pr checks as the condition of if, while or until, with the merge in the body, is allowed', () => {
  assert.equal(decide(input('if gh pr checks 272 --watch; then gh pr merge 272 --merge; fi'), DOCS_ONLY), null);
  assert.equal(decide(input('while gh pr checks 272; do gh pr merge 272 --merge; done'), DOCS_ONLY), null);
  assert.equal(decide(input('until gh pr checks 272; do sleep 5; done; gh pr merge 272 --merge'), DOCS_ONLY), null);
});

function skipCase(sliceText) {
  const r = repoWith({ 'src/a.cs': 'one', 'docs/plan/slices/99-x.md': sliceText });
  const body = coverageCase([`src/a.cs ${r.blob('src/a.cs')}`]);
  const files = [{ path: 'src/a.cs' }, { path: 'docs/plan/slices/99-x.md' }];
  const pr = () => JSON.stringify({ files, number: 5, headRefOid: r.head, body });
  return gate(input('gh pr merge 5', r.repo), pr);
}

test('a code PR whose slice file has a skip with no quoted reason from its findings file is denied', () => {
  const verdict = skipCase('# Slice\n\n**From review:**\n- Skipped #3 (`reviews/x-high.md`): "words that no findings file holds"\n');
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /check-review-skips\.mjs failed for docs\/plan\/slices\/99-x\.md/);
});

test('a code PR whose changed slice file has no From review section yet is not denied by the skip check', () => {
  assert.equal(skipCase('# Slice\n\nNo review notes yet.\n'), null);
});

test('a code PR whose slice file passes check-review-skips is allowed', () => {
  assert.equal(skipCase('# Slice\n\n**From review:** no findings skipped.\n'), null);
});

test('a slice file whose text at the head cannot be read lets the call through with a warning on stderr', () => {
  const r = repoWith({ 'src/a.cs': 'one', 'docs/plan/slices/99-x.md': '# Slice\n' });
  const body = coverageCase([`src/a.cs ${r.blob('src/a.cs')}`]);
  const files = [{ path: 'src/a.cs' }, { path: 'docs/plan/slices/99-x.md' }];
  const pr = () => JSON.stringify({ files, number: 5, headRefOid: r.head, body });
  const realGit = (cwd, args) => {
    if (args[0] === 'show' && String(args[1]).endsWith('99-x.md')) throw new Error('fatal: bad object');
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  };
  const notes = [];
  assert.equal(decide(input('gh pr merge 5', r.repo), pr, (t) => notes.push(t), realGit), null);
  assert.ok(notes.some((n) => /skip check of docs\/plan\/slices\/99-x\.md not run/.test(n) && /bad object/.test(n)));
});

test('searchRoots: a relative reviews/ path resolves from the primary checkout via <repo>-worktrees', async () => {
  const { searchRoots, resolveReviews } = await import('./merge-gate.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-roots-'));
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    const review = path.join(base, 'repo-worktrees', 'reviews', 'pr-1-high.md');
    fs.mkdirSync(path.dirname(review), { recursive: true });
    fs.writeFileSync(review, 'findings');
    const roots = searchRoots(repo);
    assert.ok(roots.includes(path.resolve(base, 'repo-worktrees')), roots.join(', '));
    const [found] = resolveReviews(['reviews/pr-1-high.md'], roots);
    assert.equal(fs.realpathSync(found.full), fs.realpathSync(review));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// Slice 17 part I: a listed review that says it did not run is no review.
test('a listed review file starting with REVIEW INCOMPLETE denies the merge', () => {
  const dir = tmp();
  const high = reviewFile(dir, 'x-high.md');
  const medium = reviewFile(dir, 'x-medium.md', 'REVIEW INCOMPLETE: fork not run\n', false);
  const verdict = decide(input(), view({ body: `## Review\n${high}\n${medium}` }));
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /x-medium\.md starts with REVIEW INCOMPLETE/);
  // the same two files with a real findings file pass
  const real = reviewFile(dir, 'y-medium.md');
  assert.equal(decide(input(), view({ body: `## Review\n${high}\n${real}` })), null);
});

// Slice 29 item 30: a findings file in which the reviewer says it did not check the diff against the slice is incomplete too.
test('a listed review file saying the diff was not checked against the slice denies the merge', () => {
  const dir = tmp();
  const high = reviewFile(dir, 'x-high.md');
  const medium = reviewFile(dir, 'x-medium.md', `findings\n\nI did not check the diff line by line against the slice's Work and Verification sections.\n\nReviewed files:\nsrc/a.cs ${SHA}\n`, false);
  const verdict = decide(input(), view({ body: `## Review\n${high}\n${medium}` }));
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /x-medium\.md says the reviewer did not check the diff against the slice/);
  const checked = reviewFile(dir, 'y-medium.md', `findings\n\nI checked the diff line by line against the slice.\n\nReviewed files:\nsrc/a.cs ${SHA}\n`, false);
  assert.equal(decide(input(), view({ body: `## Review\n${high}\n${checked}` })), null);
  // a numbered finding that says the builder did not check something is a finding, not the reviewer's admission
  const finding = reviewFile(dir, 'z-medium.md', `3. The builder did not check the new rule against the slice's Verification section.\n\nReviewed files:\nsrc/a.cs ${SHA}\n`, false);
  assert.equal(decide(input(), view({ body: `## Review\n${high}\n${finding}` })), null);
});

// Slice 29 item 26: `gh pr create` is checked for the `## Test plan` heading when the PR is opened.
const createDenied = (command, cwd = os.tmpdir()) => denied(decide(input(command, cwd), view({})));

test('Slice 29 item 26: a gh pr create whose literal body has no Test plan heading is denied; with the heading it passes', () => {
  assert.ok(createDenied('gh pr create --base main --title "x" --body "## Summary\n- a"'));
  assert.match(reason(decide(input('gh pr create --body "## Summary\nx"'), view({}))), /Test plan/);
  assert.ok(!createDenied('gh pr create --base main --title "x" --body "## Summary\n- a\n\n## Test plan\n- [x] docs only, no tests apply: text"'));
  assert.ok(createDenied('gh pr create -b "just words"'));
  assert.ok(createDenied('gh -R o/r pr create --body="## Summary"'));
  // inline code inside the text is shown text, not an unknown substitution
  assert.ok(createDenied("gh pr create --body 'Fix `foo`'"));
});

test('Slice 29 item 26: a draft claim PR, --fill, --web and a body the command does not show pass', () => {
  assert.ok(!createDenied('gh pr create --draft --title "claim" --body "claim only"'));
  assert.ok(!createDenied('gh pr create --fill'));
  assert.ok(!createDenied('gh pr create --web'));
  assert.ok(!createDenied('gh pr create --title "x"'));
  assert.ok(!createDenied('gh pr create --body "$BODY"'));
  assert.ok(!createDenied('gh pr create --body "$(cat body.md)"'));
  assert.ok(!createDenied('gh pr list --search "pr create"'));
});

test('Slice 29 item 26: a heredoc body and a body file are read', () => {
  const noHeading = 'gh pr create --title "x" --body "$(cat <<\'EOF\'\n## Summary\n- it\'s a change\nEOF\n)"';
  assert.ok(createDenied(noHeading));
  assert.ok(!createDenied(noHeading.replace('## Summary', '## Summary\n## Test plan')));
  assert.ok(createDenied('gh pr create --title x --body-file - <<\'EOF\'\n## Summary\nEOF\n'));
  assert.ok(!createDenied('gh pr create --title x --body-file - <<\'EOF\'\n## Test plan\n- [x] ok: 1\nEOF\n'));
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'body.md'), '## Summary\nx\n');
  assert.ok(createDenied('gh pr create --body-file body.md', dir));
  fs.writeFileSync(path.join(dir, 'body.md'), '## Summary\nx\n\n## Test plan\n- [x] ok: 1\n');
  assert.ok(!createDenied('gh pr create --body-file body.md', dir));
  assert.ok(!createDenied('gh pr create --body-file missing.md', dir));
  // a file the same command writes is not read: it may not hold the final body yet
  fs.writeFileSync(path.join(dir, 'new.md'), '## Summary\nstale\n');
  assert.ok(!createDenied('cat > new.md <<\'EOF\'\n## Test plan\nEOF\ngh pr create --body-file new.md', dir));
  // the same file in another spelling (`./new.md`) is the same file
  assert.ok(!createDenied('printf x > new.md && gh pr create --body-file ./new.md', dir));
});

test('Slice 29 item 26: prose that mentions gh pr create inside a heredoc is not a create', () => {
  assert.ok(!createDenied('cat > note.md <<\'EOF\'\ngh pr create --body "x"\nEOF\n'));
});

// Slice 29 item 37: a merge after a failed `gh pr checks` call of the session is refused.
function transcript(entries) {
  const file = path.join(tmp(), 'session.jsonl');
  const lines = [];
  entries.forEach(([command, text, isError], i) => {
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command } }] } }));
    if (text !== undefined) lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: isError, content: text }] } }));
  });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}
const mergeInput = (file, extra = {}, command = 'gh pr merge 12 --merge') => ({ ...input(command), transcript_path: file, ...extra });
const docsPr = view({ files: [{ path: 'notes/a.md' }] });

test('Slice 29 item 37: a merge after a failed gh pr checks call for that PR is denied', () => {
  const file = transcript([['gh pr checks 12 --watch --fail-fast', 'Exit code 1\nbuild\tfail\t1m', true]]);
  const verdict = decide(mergeInput(file), docsPr);
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /last `gh pr checks 12` call of this session failed/);
});

test('Slice 29 item 37: a later passing checks call, another PR, no-checks output, a chained watch or no transcript lets the merge through', () => {
  assert.equal(decide(mergeInput(transcript([['gh pr checks 12', 'Exit code 1\nfail', true], ['gh pr checks 12 --watch', 'all good', false]])), docsPr), null);
  assert.equal(decide(mergeInput(transcript([['gh pr checks 13', 'Exit code 1\nfail', true]])), docsPr), null);
  assert.equal(decide(mergeInput(transcript([['gh pr checks 12 --watch', "Exit code 1\nno checks reported on the 'x' branch", true]])), docsPr), null);
  const failed = transcript([['gh pr checks 12', 'Exit code 8\npending', true]]);
  assert.equal(decide(mergeInput(failed, {}, 'gh pr checks 12 --watch --fail-fast && gh pr merge 12 --merge'), docsPr), null);
  assert.equal(decide(mergeInput(failed, {}, 'gh pr merge 12 --merge --auto'), docsPr), null);
  assert.equal(decide({ ...input(), transcript_path: path.join(tmp(), 'gone.jsonl') }, docsPr), null);
  assert.equal(decide(input(), docsPr), null);
});

test('Slice 29 item 37 review fix: a green live rollup, a call for another repo, or a result older than the head commit lets the merge through', () => {
  const failed = transcript([['gh pr checks 12', 'Exit code 8\npending', true]]);
  const green = view({ files: [{ path: 'notes/a.md' }], statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  assert.equal(decide(mergeInput(failed), green), null);
  const other = transcript([['gh pr checks 12 -R other/repo', 'Exit code 1\nfail', true]]);
  assert.equal(decide(mergeInput(other), docsPr), null);
  const same = transcript([['gh pr checks 12 -R o/r', 'Exit code 1\nfail', true]]);
  assert.ok(denied(decide(mergeInput(same, {}, 'gh pr merge 12 --repo o/r --merge'), docsPr)));
  const old = transcript([['gh pr checks 12', 'Exit code 1\nfail', true]]);
  const stamped = fs.readFileSync(old, 'utf8').trim().split('\n').map((l, i) => JSON.stringify({ ...JSON.parse(l), timestamp: i ? '2026-11-19T10:00:00Z' : '2026-11-19T09:59:00Z' })).join('\n');
  fs.writeFileSync(old, `${stamped}\n`);
  const newerHead = (cwd, args) => (args[0] === 'show' && args[1] === '-s' ? '2026-11-19T11:00:00Z' : STUB_GIT(cwd, args));
  assert.equal(decide(mergeInput(old), docsPr, undefined, newerHead), null);
});

test('Slice 29 item 37: a subagent call reads the subagent\'s own transcript', () => {
  const dir = tmp();
  const session = path.join(dir, 'abc.jsonl');
  fs.writeFileSync(session, '');
  fs.mkdirSync(path.join(dir, 'abc', 'subagents'), { recursive: true });
  const own = transcript([['gh pr checks 12 --watch', 'Exit code 1\nfail', true]]);
  fs.copyFileSync(own, path.join(dir, 'abc', 'subagents', 'agent-ship1.jsonl'));
  assert.ok(denied(decide({ ...input(), transcript_path: session, agent_id: 'ship1' }, docsPr)));
  assert.equal(decide({ ...input(), transcript_path: session }, docsPr), null);
});

// Slice 29 item 46: any allowed merge of a PR that changed mirrored docs marks the mirror due.
test('Slice 29 item 46: an allowed merge of a docs PR records a mirror due, and a PR with no mirrored doc does not', () => {
  const calls = [];
  const markDue = (repo, sha, cwd) => calls.push({ repo, sha, cwd });
  const run = (files, command = 'gh pr merge 12 --merge') => gate(input(command), view({ files: files.map((p) => ({ path: p })) }), undefined, STUB_GIT, undefined, markDue);
  for (const file of ['plan.md', 'README.md', 'scope.md', 'CLAUDE.md', 'agents/CLAUDE.md', 'docs/plan/slices/01-x.md']) {
    calls.length = 0;
    assert.equal(run([file]), null, file);
    assert.equal(calls.length, 1, file);
    assert.equal(calls[0].sha, 'f'.repeat(40));
  }
  calls.length = 0;
  assert.equal(run(['docs/guide.md']), null);
  assert.equal(run(['plan.md'], 'gh pr merge 12 --disable-auto'), null);
  assert.ok(denied(run(['plan.md', 'src/a.cs'])));
  assert.equal(calls.length, 0);
});

test('Slice 29 item 46: the default marker names the repo from origin and writes the marker file', () => {
  const repo = tmp();
  execFileSync('git', ['init', '-q', repo]);
  const git = (cwd, args) => (args[0] === 'remote' ? 'https://github.com/o/r.git\n' : SHA);
  assert.equal(gate(input('gh pr merge 12 --merge', repo), view({ files: [{ path: 'plan.md' }] }), undefined, git), null);
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'state', 'mirror-due', 'o__r.json');
  const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(marker.repo, 'o/r');
  assert.equal(marker.sha, 'f'.repeat(40));
  // .native expands 8.3 short names (C:\Users\RUNNER~1) that the JS realpath keeps on Windows runners.
  assert.equal(fs.realpathSync.native(marker.root), fs.realpathSync.native(repo));
});

// Slice 17 part B: a suite summary must be of the PR head's code.
function committedRepo() {
  const repo = batchRepo(null);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.cs'), 'class A {}\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'docs\n');
  realGit(repo, ['add', '-A']);
  realGit(repo, ['commit', '-q', '-m', 'init']);
  return { repo, head: realGit(repo, ['rev-parse', 'HEAD']), blob: realGit(repo, ['rev-parse', 'HEAD:src/a.cs']) };
}

const FULL_SUITE = 'Files run: 3 of 3; failed: 0; files with skipped tests: 0\n\nAll files exited 0.\n';

function suiteBody(dir, blob, treeHash, tail = FULL_SUITE) {
  const block = `\nReviewed files:\nsrc/a.cs ${blob}\n`;
  const high = reviewFile(dir, 'x-high.md', block);
  const medium = reviewFile(dir, 'x-medium.md', block);
  const suite = reviewFile(dir, 'x-suite.md', `# Suite summary\n\nSuite code tree: ${treeHash}\n${tail}`, false);
  return `## Review\n${high}\n${medium}\n${suite}`;
}

test('a suite summary whose code tree differs from the PR head is denied, a matching one passes', () => {
  const { repo, head, blob } = committedRepo();
  const entries = realGit(repo, ['ls-tree', '-r', '--full-tree', head]).split('\n').map((l) => /^\S+ \S+ ([0-9a-f]+)\t(.*)$/.exec(l)).map((m) => [m[2], m[1]]);
  const good = codeTreeHash(entries);
  const pr = (body) => view({ body, headRefOid: head, files: [{ path: 'src/a.cs' }] });
  assert.equal(gate(input('gh pr merge 12 --merge', repo), pr(suiteBody(tmp(), blob, good)), undefined, realGit), null);
  // a Markdown change does not move the code hash
  assert.equal(codeTreeHash([...entries, ['NOTES.md', 'f'.repeat(40)]]), good);
  const verdict = gate(input('gh pr merge 12 --merge', repo), pr(suiteBody(tmp(), blob, 'e'.repeat(64))), undefined, realGit);
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /another code tree than the PR head/);
});

test('a suite summary that failed, is incomplete or ran a subset is denied even with the right tree', () => {
  const { repo, head, blob } = committedRepo();
  const entries = realGit(repo, ['ls-tree', '-r', '--full-tree', head]).split('\n').map((l) => /^\S+ \S+ ([0-9a-f]+)\t(.*)$/.exec(l)).map((m) => [m[2], m[1]]);
  const good = codeTreeHash(entries);
  const pr = (body) => view({ body, headRefOid: head, files: [{ path: 'src/a.cs' }] });
  const tails = [
    'Files run: 3 of 3; failed: 1; files with skipped tests: 0\n\nFAILED: x.test.mjs\n',
    'Files run: 2 of 3; failed: 0; files with skipped tests: 0\n\nINCOMPLETE: run again with --resume.\n',
    'Files run: 1 of 1; failed: 0; files with skipped tests: 0\nSubset run (--tests): not the whole suite\n\nAll files exited 0.\n',
  ];
  for (const tail of tails) {
    const verdict = gate(input('gh pr merge 12 --merge', repo), pr(suiteBody(tmp(), blob, good, tail)), undefined, realGit);
    assert.ok(denied(verdict), tail);
    assert.match(reason(verdict), /not a full passing suite run/);
  }
});

// Slice 30 item F: a `run-suite.mjs --changed` summary is the suite when it covers the selection for the PR's own diff.
function selectedRepo(extraChange) {
  const { repo } = committedRepo();
  fs.mkdirSync(path.join(repo, 't'));
  fs.writeFileSync(path.join(repo, 't', 'a.test.mjs'), "// checks a.cs\n");
  fs.writeFileSync(path.join(repo, 't', 'other.test.mjs'), "// checks nothing here\n");
  realGit(repo, ['add', '-A']);
  realGit(repo, ['commit', '-q', '-m', 'tests']);
  realGit(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'src', 'a.cs'), 'class A { int x; }\n');
  if (extraChange) { fs.mkdirSync(path.join(repo, '.github')); fs.writeFileSync(path.join(repo, '.github', 'x.yml'), 'x: 1\n'); }
  realGit(repo, ['add', '-A']);
  realGit(repo, ['commit', '-q', '-m', 'change']);
  const head = realGit(repo, ['rev-parse', 'HEAD']);
  const entries = realGit(repo, ['ls-tree', '-r', '--full-tree', head]).split('\n').map((l) => /^\S+ \S+ ([0-9a-f]+)\t(.*)$/.exec(l)).map((m) => [m[2], m[1]]);
  return { repo, head, blob: realGit(repo, ['rev-parse', 'HEAD:src/a.cs']), tree: codeTreeHash(entries) };
}

const selectedTail = (lines) => `Files run: ${lines.length} of ${lines.length}; failed: 0; files with skipped tests: 0\nSelected run (--changed) against origin/main: ${lines.length} file(s)\n\n${lines.map((f) => `exit 0  ${f}  (pass 1, fail 0, skipped 0, 1s)`).join('\n')}\n\nAll files exited 0.\n`;

test('a selected suite summary passes when it covers the PR selection, and is denied when it lacks a file or the PR changes .github/', () => {
  const run = (setup, tail) => {
    const { repo, head, blob, tree } = setup;
    const pr = view({ body: suiteBody(tmp(), blob, tree, tail), headRefOid: head, files: [{ path: 'src/a.cs' }] });
    return gate(input('gh pr merge 12 --merge', repo), pr, undefined, realGit);
  };
  assert.equal(run(selectedRepo(false), selectedTail(['t/a.test.mjs'])), null);
  const lacking = run(selectedRepo(false), selectedTail(['t/other.test.mjs']));
  assert.ok(denied(lacking));
  assert.match(reason(lacking), /selected run that lacks 1 file\(s\).*t\/a\.test\.mjs/);
  const runAll = run(selectedRepo(true), selectedTail(['t/a.test.mjs']));
  assert.ok(denied(runAll));
  assert.match(reason(runAll), /changes \.github\/.*run all/);
});

test('a selected suite summary is denied when the selection cannot be recomputed or it ran 0 files', () => {
  const run = (setup, tail) => {
    const { repo, head, blob, tree } = setup;
    const pr = view({ body: suiteBody(tmp(), blob, tree, tail), headRefOid: head, files: [{ path: 'src/a.cs' }] });
    return gate(input('gh pr merge 12 --merge', repo), pr, undefined, realGit);
  };
  const noBase = selectedRepo(false);
  realGit(noBase.repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
  const failedClosed = run(noBase, selectedTail(['t/a.test.mjs']));
  assert.ok(denied(failedClosed));
  assert.match(reason(failedClosed), /cannot recompute the selection.*run the full suite/);
  const empty = run(selectedRepo(false), selectedTail([]));
  assert.ok(denied(empty));
  assert.match(reason(empty), /ran 0 files/);
});

test('a copy of the gate with no .github folder still loads; only the selected-run check is lost', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-copy-'));
  try {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    for (const rel of ['run-wave/merge-gate.mjs', 'run-wave/wave-gate.mjs', 'feedback-loop/check-review-skips.mjs', 'feedback-loop/mirror-due.mjs']) {
      fs.mkdirSync(path.join(root, 'skills', path.dirname(rel)), { recursive: true });
      fs.copyFileSync(path.join(here, '..', rel), path.join(root, 'skills', rel));
    }
    const copy = await import(`file:///${path.join(root, 'skills', 'run-wave', 'merge-gate.mjs').replace(/\\/g, '/')}`);
    assert.equal(typeof copy.decide, 'function');
    assert.equal(copy.decide(input('git status', root), view({}), undefined, realGit), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('--explain says denied while a batch is open and allowed otherwise', () => {
  assert.match(explainMerge(batchRepo(OPEN_BATCH()), realGit), /^denied: a batch release is open/);
  assert.match(explainMerge(batchRepo(null), realGit), /^allowed: no open batch/);
});

test("Slice 23 item 14: a findings heredoc that mentions `gh pr merge` (with an apostrophe) is data, not a merge", () => {
  const write = "cat > reviews/x.md <<'EOF'\n- it doesn't stop a plain\ngh pr merge 5 --merge\n- done\nEOF\n";
  assert.equal(rawMergeInCommandPosition(write), false);
  // an opener that runs the body is not spared
  assert.equal(rawMergeInCommandPosition("bash <<'EOF'\ngh pr merge 5\nEOF\n"), true);
  assert.equal(rawMergeInCommandPosition("cat <<EOF\ngh pr merge 5\nEOF\n"), true);
  assert.equal(rawMergeInCommandPosition("cat > f <<'EOF'\nx\nEOF\ngh pr merge 5 --merge\n"), true);
});

test('Slice 29 item 2: a workflow file the PR did not change is out of the code tree hash, one it changed is in', () => {
  const entries = [['src/a.cs', 'a'.repeat(40)], ['.github/workflows/tests.yml', 'b'.repeat(40)]];
  const changed = [['src/a.cs', 'a'.repeat(40)], ['.github/workflows/tests.yml', 'c'.repeat(40)]];
  assert.equal(codeTreeHash(entries, [], new Set()), codeTreeHash(changed, [], new Set()), 'a foreign workflow edit does not move the hash');
  assert.notEqual(codeTreeHash(entries, [], new Set(['.github/workflows/tests.yml'])), codeTreeHash(changed, [], new Set(['.github/workflows/tests.yml'])));
  assert.notEqual(codeTreeHash(entries), codeTreeHash(changed), 'without a changed-file set every file counts, as before');
});

test('Slice 29 item 2: a suite summary run before a workflow-only change on main still matches the PR head', () => {
  const { repo, blob } = committedRepo();
  const entries = realGit(repo, ['ls-tree', '-r', '--full-tree', 'HEAD']).split('\n').map((l) => /^\S+ \S+ ([0-9a-f]+)\t(.*)$/.exec(l)).map((m) => [m[2], m[1]]);
  const good = codeTreeHash(entries, [], new Set());
  fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.github', 'workflows', 'tests.yml'), 'name: t\n');
  realGit(repo, ['add', '-A']);
  realGit(repo, ['commit', '-q', '-m', 'workflow only']);
  const head = realGit(repo, ['rev-parse', 'HEAD']);
  const pr = view({ body: suiteBody(tmp(), blob, good), headRefOid: head, files: [{ path: 'src/a.cs' }] });
  assert.equal(gate(input('gh pr merge 12 --merge', repo), pr, undefined, realGit), null);
});

test('Slice 29 item 45: a PR that is already MERGED is let through even with red checks; an open one is denied', () => {
  const red = [{ name: 'tests', conclusion: 'FAILURE' }];
  assert.equal(decide(input(), view({ state: 'MERGED', statusCheckRollup: red })), null);
  assert.ok(denied(decide(input(), view({ state: 'OPEN', statusCheckRollup: red }))));
});

test('Slice 29 item 45: the MERGED pass-through needs a PR named by number or URL, not a branch name or no selector', () => {
  const red = [{ name: 'tests', conclusion: 'FAILURE' }];
  const merged = view({ state: 'MERGED', statusCheckRollup: red });
  assert.equal(decide(input('gh pr merge https://github.com/o/r/pull/12 --merge'), merged), null);
  assert.ok(denied(decide(input('gh pr merge --merge'), merged)), 'no selector');
  assert.ok(denied(decide(input('gh pr merge my-branch --merge'), merged)), 'branch name');
  assert.ok(denied(decide(input('gh pr merge https://github.com/o/r/pull/99 --merge'), merged)), 'gh resolved another PR number than the one named');
});

test('Slice 29 item 48: a PR whose file list is missing or capped keeps workflow files in the head hash', () => {
  const { repo, head, blob } = committedRepo();
  const entries = realGit(repo, ['ls-tree', '-r', '--full-tree', head]).split('\n').map((l) => /^\S+ \S+ ([0-9a-f]+)\t(.*)$/.exec(l)).map((m) => [m[2], m[1]]);
  const body = suiteBody(tmp(), blob, codeTreeHash(entries, [], null));
  const pr = view({ body, headRefOid: head, statusCheckRollup: [], createdAt: '2020-01-01T00:00:00Z', files: undefined });
  assert.equal(gate(input('gh pr merge 12 --merge', repo), pr, undefined, realGit), null, 'absent files = unknown, counted like null');
});

test('Slice 29 item 48: a code PR with no checks and a valid suite summary merges', () => {
  const { repo, head, blob } = committedRepo();
  const entries = realGit(repo, ['ls-tree', '-r', '--full-tree', head]).split('\n').map((l) => /^\S+ \S+ ([0-9a-f]+)\t(.*)$/.exec(l)).map((m) => [m[2], m[1]]);
  const pr = view({ body: suiteBody(tmp(), blob, codeTreeHash(entries, [], new Set())), headRefOid: head, statusCheckRollup: [], createdAt: '2020-01-01T00:00:00Z', files: [{ path: 'src/a.cs' }] });
  assert.equal(gate(input('gh pr merge 12 --merge', repo), pr, undefined, realGit), null);
});

test('Slice 29 item 53: a heredoc with an apostrophe that closes before gh pr merge does not hide the merge', () => {
  const command = "gh pr edit 12 --body-file - <<'EOF'\n## Review\nit doesn't matter\nEOF\ngh pr merge 12 --merge\n";
  const verdict = decide(input(command), view({ body: '## Summary\nx' }));
  assert.ok(denied(verdict));
  assert.match(reason(verdict), /no `## Review` section/, 'the merge is parsed and gated, not refused as unparseable');
  assert.equal(decide(input(command), view({ state: 'MERGED' })), null);
});

// 2026-11-25: a plain session is not forced to [skip ci] by another session's open batch.
function sessionFile(lines) {
  const file = path.join(tmp(), 'session.jsonl');
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return file;
}
const plainSession = () => sessionFile([{ type: 'user', message: { content: 'build slice 409' } }]);
const waveSession = () => sessionFile([{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w', name: 'Skill', input: { skill: 'run-wave' } }] } }]);
const batchInput = (repo, transcript_path) => ({ ...input('gh pr merge 12 --merge', repo), transcript_path });
const docsView = view({ files: [{ path: 'README.md' }] });

test('open batch: a plain session merges without [skip ci]', () => {
  const repo = batchRepo(OPEN_BATCH());
  assert.equal(gate(batchInput(repo, plainSession()), docsView, undefined, realGit), null);
});

test('open batch: a session that loaded run-wave is still denied without [skip ci]', () => {
  const repo = batchRepo(OPEN_BATCH());
  assert.ok(denied(gate(batchInput(repo, waveSession()), docsView, undefined, realGit)));
});

test('open batch: an unreadable transcript keeps the rule (denied)', () => {
  const repo = batchRepo(OPEN_BATCH());
  const missing = path.join(tmp(), 'nope.jsonl');
  assert.ok(denied(gate(batchInput(repo, missing), docsView, undefined, realGit)));
});

function writeLedger(repo, text) {
  fs.writeFileSync(path.join(path.dirname(repo), 'proj-worktrees', 'wave-ledger.md'), text);
}
const OPEN_LEDGER = '## Wave 3 (open)\nOpened 10:00Z 2026-11-25 session sess-abc\n- Slice 1 x\n';

test('open batch: the session id on the open wave Opened line is the coordinator (denied even with a plain transcript)', () => {
  const repo = batchRepo(OPEN_BATCH());
  writeLedger(repo, OPEN_LEDGER);
  const withId = { ...batchInput(repo, plainSession()), session_id: 'sess-abc' };
  assert.ok(denied(gate(withId, docsView, undefined, realGit)));
  assert.match(reason(gate(withId, docsView, undefined, realGit)), /\[skip ci\]/);
});

test('open batch: a different session id with a readable plain transcript merges without [skip ci]', () => {
  const repo = batchRepo(OPEN_BATCH());
  writeLedger(repo, OPEN_LEDGER);
  const other = { ...batchInput(repo, plainSession()), session_id: 'sess-other' };
  assert.equal(gate(other, docsView, undefined, realGit), null);
});

test('open batch: a multi-merge command is denied when the coordinator session merges, allowed for a plain one', () => {
  const repo = batchRepo(OPEN_BATCH());
  writeLedger(repo, OPEN_LEDGER);
  const command = 'gh pr merge 12 --merge && gh pr merge 13 --merge';
  const coordinator = { ...input(command, repo), transcript_path: plainSession(), session_id: 'sess-abc' };
  assert.ok(denied(gate(coordinator, docsView, undefined, realGit)));
  const plain = { ...input(command, repo), transcript_path: plainSession(), session_id: 'sess-other' };
  assert.equal(gate(plain, docsView, undefined, realGit), null);
});

test('explain: a session that runs no wave is told allowed while a batch is open', () => {
  const repo = batchRepo(OPEN_BATCH());
  assert.match(explainMerge(repo, realGit, Date.now(), fs.readFileSync, { transcript_path: plainSession() }), /^allowed: .*no wave/);
  assert.match(explainMerge(repo, realGit, Date.now(), fs.readFileSync), /^denied/);
});
