import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, appendFileSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fastForward, changedTracked, isPhantom } from './ff-primary.mjs';

const g = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
const quiet = () => {};
const CR_CONTENT = 'x\r\ny\r\n';

// origin with a.txt (a CR-bearing blob under eol=lf, so the clone shows it modified) and b.txt; a clone as "primary".
// Slice 30 item K: the repos are built by git once and every test gets a folder copy (about a dozen git calls saved per test),
// with the clone's remote pointed at the copy of origin.
let template;

function setup() {
  template ??= buildSetup();
  const root = mkdtempSync(join(tmpdir(), 'ffp-'));
  cpSync(join(template, 'origin'), join(root, 'origin'), { recursive: true });
  cpSync(join(template, 'primary'), join(root, 'primary'), { recursive: true });
  g(join(root, 'primary'), 'remote', 'set-url', 'origin', join(root, 'origin'));
  return { origin: join(root, 'origin'), primary: join(root, 'primary') };
}

function buildSetup() {
  const root = mkdtempSync(join(tmpdir(), 'ffp-template-'));
  const origin = join(root, 'origin');
  const primary = join(root, 'primary');
  execFileSync('git', ['init', '-q', '-b', 'main', origin]);
  g(origin, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(origin, '.gitattributes'), '* text eol=lf\n');
  writeFileSync(join(origin, 'b.txt'), 'b\n');
  g(origin, 'add', '.gitattributes', 'b.txt');
  const blob = execFileSync('git', ['-C', origin, 'hash-object', '-w', '--no-filters', '--stdin'], { input: CR_CONTENT, encoding: 'utf8' }).trim();
  g(origin, 'update-index', '--add', '--cacheinfo', `100644,${blob},a.txt`);
  g(origin, 'commit', '-q', '-m', 'one');
  execFileSync('git', ['clone', '-q', origin, primary]);
  g(primary, 'config', 'core.autocrlf', 'false');
  return root;
}

function advance(origin, file, content) {
  writeFileSync(join(origin, file), content);
  g(origin, 'add', file);
  g(origin, 'commit', '-q', '-m', `change ${file}`);
}

test('clean primary fast-forwards', () => {
  const { origin, primary } = setup();
  advance(origin, 'b.txt', 'b2\n');
  assert.equal(fastForward(primary, quiet), 0);
  assert.equal(readFileSync(join(primary, 'b.txt'), 'utf8'), 'b2\n');
});

test('untracked files and a phantom-modified file that the incoming commit changes do not block', () => {
  const { origin, primary } = setup();
  writeFileSync(join(primary, 'junk.zip'), 'z');
  const changed = changedTracked(primary);
  assert.ok(changed.length > 0, 'the CR blob should show as modified');
  assert.ok(changed.every((e) => isPhantom(primary, e)));
  advance(origin, 'a.txt', 'new\n');
  assert.equal(fastForward(primary, quiet), 0);
  assert.equal(readFileSync(join(primary, 'a.txt'), 'utf8'), 'new\n');
  assert.ok(existsSync(join(primary, 'junk.zip')));
});

test('a real edit to a file the incoming commits change blocks, saves a backup and keeps the edit', () => {
  const { origin, primary } = setup();
  writeFileSync(join(primary, 'b.txt'), 'my edit\n');
  advance(origin, 'b.txt', 'b2\n');
  const lines = [];
  assert.equal(fastForward(primary, (t) => lines.push(t)), 1);
  assert.match(lines.join('\n'), /b\.txt/);
  assert.equal(readFileSync(join(primary, 'b.txt'), 'utf8'), 'my edit\n');
  assert.equal(readdirSync(join(primary, '.git', 'ff-primary-backups')).length, 1);
});

// A fake ~/.claude/projects with one transcript line per [project, id, timestamp offset from now in ms, text].
function fakeProjects(lines) {
  const projects = mkdtempSync(join(tmpdir(), 'ffp-proj-'));
  for (const [project, id, offset, text] of lines) {
    mkdirSync(join(projects, project), { recursive: true });
    const entry = { type: 'assistant', timestamp: new Date(Date.now() + offset).toISOString(), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: text } }] } };
    appendFileSync(join(projects, project, `${id}.jsonl`), `${JSON.stringify(entry)}\n`);
  }
  return projects;
}

test('Slice 09 item 5: BLOCKED names the session whose transcript mentions the file just before it was saved', () => {
  const { origin, primary } = setup();
  const projects = fakeProjects([
    ['D--Other', 'aaaa-1111', -5 * 60 * 1000, 'code -g "D:/AgentPipeline/b.txt:3"'],
    ['D--Other', 'bbbb-2222', -3 * 60 * 60 * 1000, 'code -g "D:/AgentPipeline/b.txt:3"'],
    ['D--Other', 'cccc-3333', -5 * 60 * 1000, 'ls somewhere-else'],
  ]);
  writeFileSync(join(primary, 'b.txt'), 'my edit\n');
  advance(origin, 'b.txt', 'b2\n');
  const lines = [];
  assert.equal(fastForward(primary, (t) => lines.push(t), projects), 1);
  const text = lines.join('\n');
  assert.match(text, /D--Other\/aaaa-1111 \(named it at /);
  assert.ok(!text.includes('bbbb-2222'), 'a mention three hours before the save is not the edit');
  assert.ok(!text.includes('cccc-3333'), 'a transcript that never names the file is not named');
});

test('Slice 09 item 5: with no transcript naming the file, BLOCKED says to look for a hand edit', () => {
  const { origin, primary } = setup();
  writeFileSync(join(primary, 'b.txt'), 'my edit\n');
  advance(origin, 'b.txt', 'b2\n');
  const lines = [];
  assert.equal(fastForward(primary, (t) => lines.push(t), fakeProjects([])), 1);
  assert.match(lines.join('\n'), /look for a hand edit/);
});

function blockedRun(projects, scanOptions) {
  const { origin, primary } = setup();
  writeFileSync(join(primary, 'b.txt'), 'my edit\n');
  advance(origin, 'b.txt', 'b2\n');
  const lines = [];
  assert.equal(fastForward(primary, (t) => lines.push(t), projects, scanOptions), 1);
  return lines.join('\n');
}

test('findings 4+5: a transcript over the size cap is skipped and BLOCKED says not all transcripts were read', () => {
  const projects = fakeProjects([['D--Other', 'aaaa-1111', -60 * 1000, 'code -g "D:/AgentPipeline/b.txt:3"']]);
  const text = blockedRun(projects, { maxFileBytes: 10 });
  assert.match(text, /Not all transcripts were read/);
  assert.ok(!text.includes('No session transcript names it'), 'a skipped file is not "no session names it"');
});

test('findings 4+5: more candidate transcripts than the file cap reads only the cap and says so', () => {
  const projects = fakeProjects([
    ['D--Other', 'aaaa-1111', -60 * 1000, 'code -g "D:/AgentPipeline/b.txt:3"'],
    ['D--Other', 'bbbb-2222', -60 * 1000, 'ls somewhere-else'],
  ]);
  const text = blockedRun(projects, { maxFiles: 1 });
  assert.match(text, /Not all transcripts were read/);
});

test('findings 4+5: a line over the line cap is skipped, the rest of the file is still read, and the result is incomplete', () => {
  const projects = fakeProjects([
    ['D--Other', 'aaaa-1111', -60 * 1000, `ls ${'x'.repeat(5000)}`],
    ['D--Other', 'aaaa-1111', -50 * 1000, 'code -g "D:/AgentPipeline/b.txt:3"'],
  ]);
  const text = blockedRun(projects, { maxLineChars: 1000 });
  assert.match(text, /D--Other\/aaaa-1111 \(named it at /);
  assert.match(text, /Not all transcripts were read/);
});

test('findings 4+5: a spent time budget stops the scan with the incomplete note', () => {
  const projects = fakeProjects([['D--Other', 'aaaa-1111', -60 * 1000, 'code -g "D:/AgentPipeline/b.txt:3"']]);
  assert.match(blockedRun(projects, { budgetMs: -1 }), /Not all transcripts were read/);
});

test('findings 4+5: a full read says nothing about skipped transcripts', () => {
  const projects = fakeProjects([['D--Other', 'aaaa-1111', -60 * 1000, 'code -g "D:/AgentPipeline/b.txt:3"']]);
  assert.ok(!blockedRun(projects, {}).includes('Not all transcripts were read'));
});

test('review 1: a transcript last written 30 minutes before the save is still read (same window as the line filter)', () => {
  const projects = fakeProjects([['D--Other', 'aaaa-1111', -30 * 60 * 1000, 'code -g "D:/AgentPipeline/b.txt:3"']]);
  const old = new Date(Date.now() - 30 * 60 * 1000);
  utimesSync(join(projects, 'D--Other', 'aaaa-1111.jsonl'), old, old);
  const text = blockedRun(projects, {});
  assert.match(text, /D--Other\/aaaa-1111 \(named it at /);
  assert.ok(!text.includes('look for a hand edit.'), 'the session was found');
});

test('review 9: the backup is saved and the block reported when the transcript folder is unreadable or the budget is spent', () => {
  const unreadable = join(mkdtempSync(join(tmpdir(), 'ffp-file-')), 'not-a-folder');
  writeFileSync(unreadable, 'x');
  const cases = [[unreadable, {}], [fakeProjects([['D--Other', 'a-1', -60 * 1000, 'ls']]), { budgetMs: -1 }]];
  for (const [projects, options] of cases) {
    const { origin, primary } = setup();
    writeFileSync(join(primary, 'b.txt'), 'my edit\n');
    advance(origin, 'b.txt', 'b2\n');
    const lines = [];
    assert.equal(fastForward(primary, (t) => lines.push(t), projects, options), 1);
    assert.match(lines.join('\n'), /BLOCKED by a real edit to b\.txt/);
    assert.equal(readdirSync(join(primary, '.git', 'ff-primary-backups')).length, 1);
  }
});

test('a real edit to an unrelated file does not block', () => {
  const { origin, primary } = setup();
  writeFileSync(join(primary, 'b.txt'), 'my edit\n');
  advance(origin, 'c.txt', 'c\n');
  assert.equal(fastForward(primary, quiet), 0);
  assert.equal(readFileSync(join(primary, 'b.txt'), 'utf8'), 'my edit\n');
});

test('an untracked file that an incoming file would overwrite blocks and names it', () => {
  const { origin, primary } = setup();
  writeFileSync(join(primary, 'new.txt'), 'mine');
  advance(origin, 'new.txt', 'theirs');
  const lines = [];
  assert.equal(fastForward(primary, (t) => lines.push(t)), 1);
  assert.match(lines.join('\n'), /new\.txt/);
  assert.equal(readFileSync(join(primary, 'new.txt'), 'utf8'), 'mine');
});

test('not on main does nothing', () => {
  const { primary } = setup();
  g(primary, 'checkout', '-q', '-b', 'other');
  assert.equal(fastForward(primary, quiet), 2);
});

test('a phantom file removed before a refused merge is put back', () => {
  const { origin, primary } = setup();
  writeFileSync(join(primary, 'new.txt'), 'mine');
  writeFileSync(join(origin, 'new.txt'), 'theirs');
  advance(origin, 'a.txt', 'new\n');
  g(origin, 'add', 'new.txt');
  g(origin, 'commit', '-q', '-m', 'add new');
  assert.equal(fastForward(primary, quiet), 1);
  assert.equal(readFileSync(join(primary, 'a.txt'), 'utf8'), CR_CONTENT);
});
