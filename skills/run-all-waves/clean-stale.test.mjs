import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  selectWaveBuilds, selectStaleEntries, selectStaleWorktrees, selectStaleFolders, selectStaleTempEntries,
  isToolOwnedName, isUnderToolFolder, backupName, repoNameFromWorktreesDir, parseWorktreeList, parseArgs, runCli, cleanWave, cleanStale,
  heldFromExit, parseLedgerSlices, matchesSlice, deepScan, listTempEntries, worktreesDirError,
  selectIgnoredBackups, parseHoldLines, checkHeldBatch, ledgerSlices, BACKUP_MAX_BYTES,
  newBackupDir, assertBackupFits, BackupTooBigError, HOLDERS_TIMEOUT_MS,
} from './clean-stale.mjs';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const HOUR = 3_600_000;
const ago = (hours) => NOW - hours * HOUR;
const notHeld = () => false;

test('selectWaveBuilds takes the wave worktrees builds by name or slice number, never packs or .building-*', () => {
  const entries = [
    { name: 'a', worktree: 's1' }, { name: 'b', worktree: 's2' }, { name: 'c', worktree: null },
    { name: 'd', worktree: 'D:/x-worktrees/s320' }, { name: 'e', worktree: 'bar' }, { name: 'f', worktree: 's3200' },
    { name: 'packs', worktree: 's1' }, { name: '.building-x', worktree: 's1' },
  ];
  assert.deepEqual(selectWaveBuilds(entries, ['s1']).map((e) => e.name), ['a']);
  assert.deepEqual(selectWaveBuilds(entries, []), []);
  const branches = new Map([['bar', 'refs/heads/feat/321-foo']]);
  assert.deepEqual(selectWaveBuilds(entries, [], ['320', '321'], branches).map((e) => e.name), ['d', 'e']);
  assert.deepEqual(selectWaveBuilds(entries, [], ['320', '321']).map((e) => e.name), ['d'], 'no branch known: only the s<N> folder matches');
});

test('item 6: matchesSlice takes the folder s<N> or the worktree branch */N-* or */N; a bare N- folder prefix or a number in another name never matches', () => {
  assert.ok(matchesSlice('s320', ['320']));
  for (const branch of ['feat/320-x', 'feat/320', 'refs/heads/fix/320-y']) assert.ok(matchesSlice('anything', ['320'], branch), branch);
  for (const name of ['320-foo', '11-docs', 's3200', 's1320', 'chore-docs-index-2026-11-08', 'docs-320', 'x320', 'feat/320', '3200-x', 'a-320-b']) assert.ok(!matchesSlice(name, ['320', '11']), name);
  for (const branch of ['feat/s320', 'fix/1320-x', 'feat/3200', 'chore-docs-index-2026-11-08', 'main', '320-x']) assert.ok(!matchesSlice('anything', ['320'], branch), branch);
  assert.ok(!matchesSlice('s320', ['abc']));
  assert.ok(!matchesSlice('chore-docs-index-2026-11-08', ['11', '8', '2026']));
});

test('item 6: cleanWave reads each worktree branch from git worktree list, so feat/321-x selects its build and 11-docs does not', () => {
  const { base, repo, root } = makeRepo('cs-branch-');
  try {
    addWorktree(repo, root, 'plain', 'feat/321-x');
    addWorktree(repo, root, '11-docs', 'chore/docs');
    makeBuild(root, 'b-plain', 'plain', 0.1);
    makeBuild(root, 'b-docs', '11-docs', 0.1);
    const result = cleanWave(root, [], { slices: ['321', '11'], isHeld: notHeld });
    assert.equal(result.builds.deleted, 1, JSON.stringify(result));
    assert.ok(!existsSync(join(root, '_builds', 'b-plain')));
    assert.ok(existsSync(join(root, '_builds', 'b-docs')));
  } finally { cleanup(base, repo); }
});

test('parseLedgerSlices takes the highest wave', () => {
  const ledger = '# Ledger\n\n## Wave 1 (closed)\n- Slice 100 a\n\n## Wave 3 (open)\n- Slice 320 x\r\n- Slice 321 y\n\n## Wave 2 (closed)\n- Slice 200 z\n';
  assert.deepEqual(parseLedgerSlices(ledger), ['320', '321']);
  assert.deepEqual(parseLedgerSlices('nothing'), []);
});

test('selectStaleEntries uses a 24 h cutoff on the newest time; unknown, capped times, packs and .building- stay (item 9)', () => {
  const entries = [{ name: 'old', newestMs: ago(25) }, { name: 'young', newestMs: ago(23) }, { name: 'edge', newestMs: ago(24) }, { name: 'nan', newestMs: NaN },
    { name: 'capped', newestMs: Infinity }, { name: 'packs', newestMs: ago(99) }, { name: '.building-k', newestMs: ago(99) }];
  assert.deepEqual(selectStaleEntries(entries, NOW, 24).map((e) => e.name), ['old']);
});

test('selectStaleWorktrees never picks the primary, held, tool-folder, unsafe, young or unknown worktrees', () => {
  const base = { primary: false, held: false, toolOwned: false, unsafe: null };
  const wts = [
    { ...base, path: 'p', primary: true, activityMs: ago(99) },
    { ...base, path: 'held', held: true, activityMs: ago(99) },
    { ...base, path: 'tool', toolOwned: true, activityMs: ago(99) },
    { ...base, path: 'unsafe', unsafe: 'MERGE_HEAD in progress', activityMs: ago(99) },
    { ...base, path: 'young', activityMs: ago(2) },
    { ...base, path: 'unknown', activityMs: NaN },
    { ...base, path: 'old', activityMs: ago(30) },
  ];
  assert.deepEqual(selectStaleWorktrees(wts, NOW, 24).map((w) => w.path), ['old']);
});

test('item 11: tool-owned names are _*, .*, run-all-waves and reviews', () => {
  for (const name of ['_builds', '_desktop-vm', '.phone', '.tools', 'run-all-waves', 'reviews']) assert.ok(isToolOwnedName(name), name);
  for (const name of ['scratch', 'slice-1']) assert.ok(!isToolOwnedName(name), name);
});

test('item 10: a worktree under a tool folder is recognised', () => {
  const dir = join(tmpdir(), 'r-worktrees');
  assert.ok(isUnderToolFolder(join(dir, '_desktop-vm', 'x'), dir));
  assert.ok(isUnderToolFolder(join(dir, '.tools', 'x'), dir));
  assert.ok(isUnderToolFolder(join(dir, 'run-all-waves', 'x'), dir));
  assert.ok(!isUnderToolFolder(join(dir, 's1'), dir));
});

test('selectStaleFolders skips tool folders, worktrees, repos (.git), parents of worktrees and young folders; reviews stays (items 7, 11)', () => {
  const folders = [
    { name: 'reviews', newestMs: ago(30) }, { name: '_builds', newestMs: ago(99) }, { name: 'run-all-waves', newestMs: ago(99) },
    { name: 'wt', newestMs: ago(99), isWorktree: true }, { name: 'listed', newestMs: ago(99) }, { name: 'fresh', newestMs: ago(1) },
    { name: 'repo', newestMs: ago(99), hasGit: true }, { name: 'group', newestMs: ago(99), holdsWorktree: true }, { name: 'scratch', newestMs: ago(99) },
    { name: 'capped', newestMs: Infinity },
  ];
  assert.deepEqual(selectStaleFolders(folders, ['listed'], NOW, 24).map((f) => f.name), ['scratch']);
});

test('selectStaleTempEntries keeps claude, any case, and young entries', () => {
  const entries = [{ name: 'claude', newestMs: ago(99) }, { name: 'Claude', newestMs: ago(99) }, { name: 'x.tmp', newestMs: ago(25) }, { name: 'new', newestMs: ago(1) }];
  assert.deepEqual(selectStaleTempEntries(entries, NOW, 24).map((e) => e.name), ['x.tmp']);
});

test('Slice 376 item 7: an old mirror-to-drive staging folder (mirror-rtst-*) is swept, a young one stays', () => {
  const entries = [{ name: 'mirror-rtst-02Us', newestMs: ago(26) }, { name: 'mirror-x', newestMs: ago(49) }, { name: 'mirror-new', newestMs: ago(2) }];
  assert.deepEqual(selectStaleTempEntries(entries, NOW, 24).map((e) => e.name), ['mirror-rtst-02Us', 'mirror-x']);
});

test('Slice 376 item 7: cleanStale deletes a real old mirror-x folder in the temp dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'cs-mirror-'));
  try {
    const worktrees = join(root, 'repo-worktrees');
    const temp = join(root, 'temp');
    mkdirSync(worktrees);
    mkdirSync(join(temp, 'mirror-x', 'plan'), { recursive: true });
    writeFileSync(join(temp, 'mirror-x', 'plan', 'plan.md'), 'x');
    const old = new Date(NOW - 49 * HOUR);
    for (const p of [join(temp, 'mirror-x', 'plan', 'plan.md'), join(temp, 'mirror-x', 'plan'), join(temp, 'mirror-x')]) utimesSync(p, old, old);
    const result = cleanStale(worktrees, temp, { now: NOW, hours: 24, isHeld: notHeld, useBirth: false });
    assert.equal(result.tempEntries.deleted, 1);
    assert.equal(existsSync(join(temp, 'mirror-x')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('item 3: only a clean exit 0 from folder-holders means not held', () => {
  assert.equal(heldFromExit(0), false);
  for (const status of [1, 2, 3, 99, null]) assert.equal(heldFromExit(status), true, String(status));
});

test('backupName, repoNameFromWorktreesDir and parseWorktreeList (detached, head)', () => {
  assert.equal(backupName('s1', new Date(2026, 10, 8, 9, 5, 7)), 's1-20261108090507');
  assert.equal(backupName('s1', new Date(2026, 10, 8, 9, 5, 7), 'ab12'), 's1-20261108090507-ab12');
  assert.equal(repoNameFromWorktreesDir('D:/Repo-worktrees'), 'Repo');
  assert.equal(repoNameFromWorktreesDir('D:/other'), null);
  const list = parseWorktreeList('worktree D:/r\nHEAD abc\nbranch refs/heads/main\n\nworktree D:/r-worktrees/s1\nHEAD def\ndetached\n');
  assert.equal(list.length, 2);
  assert.ok(list[0].primary && !list[1].primary);
  assert.equal(list[1].path, 'D:/r-worktrees/s1');
  assert.ok(list[1].detached && !list[0].detached);
  assert.equal(list[1].head, 'def');
});

test('parseArgs reads both modes, lists in commas or spaces, and rejects bad input (item 8)', () => {
  assert.deepEqual(parseArgs(['--wave', 'W', '--worktrees', 'a,b', 'c', '--dry-run']),
    { mode: 'wave', dir: 'W', names: ['a', 'b', 'c'], slices: [], ledger: false, tempDir: null, dryRun: true });
  const ledgerArgs = parseArgs(['--wave', 'W', '--ledger', '--slices', '1,2']);
  assert.ok(ledgerArgs.ledger);
  assert.deepEqual(ledgerArgs.slices, ['1', '2']);
  assert.equal(parseArgs(['--stale', 'W', '--temp', 'T']).hours, 24);
  assert.equal(parseArgs(['--stale', 'W', '--temp', 'T', '--hours', '1']).hours, 1);
  assert.throws(() => parseArgs(['--stale', 'W']));
  for (const bad of [['--hours', 'x'], ['--hours', '0'], ['--hours', '0.5'], ['--hours', '-3'], ['--hours'], ['--hours', '']]) {
    assert.throws(() => parseArgs(['--stale', 'W', '--temp', 'T', ...bad]), /bad --hours/, bad.join(' '));
  }
  assert.throws(() => parseArgs([]));
});

test('item 8: drive roots and folders not named <repo>-worktrees are refused with an error result', () => {
  const root = parse(tmpdir()).root;
  assert.ok(runCli(['--wave', root, '--worktrees', 'a']).error);
  assert.ok(runCli(['--stale', root, '--temp', tmpdir()]).error);
  assert.ok(runCli(['--stale', tmpdir(), '--temp', root]).error);
  assert.match(runCli(['--stale', tmpdir(), '--temp', tmpdir()]).error, /-worktrees/);
  assert.match(runCli(['--wave', tmpdir(), '--worktrees', 'a']).error, /-worktrees/);
  assert.match(worktreesDirError('D:/Users/me'), /-worktrees/);
  assert.ok(runCli([]).error);
  const base = mkdtempSync(join(tmpdir(), 'cs-hours-'));
  try {
    const dir = join(base, 'norepo-worktrees');
    mkdirSync(dir);
    assert.match(cleanStale(dir, base, { hours: 0 }).error, /bad --hours/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

function setAge(path, hours) {
  const t = (Date.now() - hours * HOUR) / 1000;
  utimesSync(path, t, t);
}

function makeBuild(root, name, worktree, hours) {
  const dir = join(root, '_builds', name);
  mkdirSync(dir, { recursive: true });
  const meta = join(dir, 'build.json');
  writeFileSync(meta, JSON.stringify({ worktree, built: new Date(Date.now() - hours * HOUR).toISOString() }));
  writeFileSync(join(dir, 'app.apk'), 'x'.repeat(100));
  for (const p of [meta, join(dir, 'app.apk'), dir]) setAge(p, hours);
}

function makeBase(prefix) {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const root = join(base, 'proj-worktrees');
  const temp = join(base, 'temp');
  mkdirSync(root); mkdirSync(temp);
  return { base, root, temp };
}

test('cleanWave deletes the wave worktrees builds by name whatever their age and keeps others', () => {
  const { base, root } = makeBase('cs-wave-');
  try {
    makeBuild(root, 'dino-1', 's1', 0.1);
    makeBuild(root, 'dino-2', 's2', 0.1);
    const result = cleanWave(root, ['s1'], { isHeld: notHeld });
    assert.equal(result.builds.deleted, 1);
    assert.ok(result.builds.freedBytes >= 100);
    assert.ok(!existsSync(join(root, '_builds', 'dino-1')));
    assert.ok(existsSync(join(root, '_builds', 'dino-2')));
    assert.equal(cleanWave(root, ['s2'], { dryRun: true, isHeld: notHeld }).builds.deleted, 1);
    assert.ok(existsSync(join(root, '_builds', 'dino-2')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('item 4: --ledger limits the wave deletion to the highest wave slices, spares held builds, packs and other worktrees', () => {
  const { base, root } = makeBase('cs-ledger-');
  try {
    writeFileSync(join(root, 'wave-ledger.md'), '## Wave 1 (closed)\n- Slice 100 old\n## Wave 2 (open)\n- Slice 320 a\n- Slice 321 b\n');
    makeBuild(root, 'in-wave', 's320', 0.1);
    makeBuild(root, 'in-wave-held', 's321', 0.1);
    makeBuild(root, 'other-session', 's555', 0.1);
    makeBuild(root, 'old-wave', 's100', 0.1);
    makeBuild(root, 'packs', 's320', 0.1);
    mkdirSync(join(root, 's320'));
    const result = cleanWave(root, [], { ledger: true, isHeld: (p) => p.endsWith('in-wave-held') });
    assert.equal(result.builds.deleted, 1);
    assert.equal(result.builds.skippedHeld, 1);
    assert.deepEqual(readdirSync(join(root, '_builds')).sort(), ['in-wave-held', 'old-wave', 'other-session', 'packs']);
    const noLedger = cleanWave(join(base, 'x-worktrees'), [], { ledger: true, isHeld: notHeld });
    assert.equal(noLedger.builds.deleted, 0);
    const held = cleanWave(root, [], { slices: ['555'], isHeld: (p) => p === join(root, 's555') });
    assert.equal(held.builds.deleted, 1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('cleanStale on plain folders: old builds, folders and temp entries go; tool folders, reviews, packs and claude stay', () => {
  const { base, root, temp } = makeBase('cs-stale-');
  try {
    makeBuild(root, 'old', 's1', 30);
    makeBuild(root, 'new', 's1', 1);
    makeBuild(root, 'packs', null, 90);
    makeBuild(root, '.building-k', null, 90);
    for (const name of ['reviews', '_desktop-vm', 'run-all-waves', '.phone']) { mkdirSync(join(root, name)); setAge(join(root, name), 40); }
    mkdirSync(join(root, 'scratch')); setAge(join(root, 'scratch'), 40);
    writeFileSync(join(root, 'wave-ledger.md'), 'keep'); setAge(join(root, 'wave-ledger.md'), 40);
    mkdirSync(join(temp, 'claude')); setAge(join(temp, 'claude'), 40);
    mkdirSync(join(temp, 'olddir')); writeFileSync(join(temp, 'olddir', 'f'), 'x'); setAge(join(temp, 'olddir', 'f'), 40); setAge(join(temp, 'olddir'), 40);
    writeFileSync(join(temp, 'old.tmp'), 'x'); setAge(join(temp, 'old.tmp'), 40);
    writeFileSync(join(temp, 'new.tmp'), 'x');
    const result = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: notHeld });
    assert.equal(result.error, undefined);
    assert.equal(result.builds.deleted, 1);
    assert.deepEqual(readdirSync(join(root, '_builds')).sort(), ['.building-k', 'new', 'packs']);
    assert.ok(!existsSync(join(root, 'scratch')));
    for (const keep of ['reviews', '_desktop-vm', 'run-all-waves', '.phone', 'wave-ledger.md']) assert.ok(existsSync(join(root, keep)), keep);
    assert.equal(result.tempEntries.deleted, 2);
    assert.deepEqual(readdirSync(temp).sort(), ['claude', 'new.tmp']);
    assert.equal(result.failed, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('item 9: a build with a fresh file inside, or a held one, is kept', () => {
  const { base, root, temp } = makeBase('cs-builds-');
  try {
    makeBuild(root, 'fresh-inside', 's1', 40);
    writeFileSync(join(root, '_builds', 'fresh-inside', 'late.log'), 'x');
    makeBuild(root, 'held', 's1', 40);
    makeBuild(root, 'gone', 's1', 40);
    const result = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: (p) => p.endsWith('held') });
    assert.deepEqual(readdirSync(join(root, '_builds')).sort(), ['fresh-inside', 'held']);
    assert.equal(result.builds.skippedHeld, 1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('item 5: temp entries count birth time by default (a fresh copy with an old mtime stays)', () => {
  const { base, temp } = makeBase('cs-birth-');
  try {
    writeFileSync(join(temp, 'copied.zip'), 'x'); setAge(join(temp, 'copied.zip'), 40);
    const entry = listTempEntries(temp)[0];
    assert.ok(entry.newestMs > Date.now() - 2 * HOUR, 'birth time counted');
    const nobirth = listTempEntries(temp, false)[0];
    assert.ok(nobirth.newestMs < Date.now() - 30 * HOUR);
    const result = cleanStale(join(base, 'proj-worktrees'), temp, { hours: 24, isHeld: notHeld });
    assert.equal(result.tempEntries.deleted, 0);
    assert.ok(existsSync(join(temp, 'copied.zip')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('items 5, 6: temp entries use the deep newest time and are judged by timestamps only (no holder check, no rename)', () => {
  const { base, root, temp } = makeBase('cs-temp-');
  try {
    mkdirSync(join(temp, 'deep', 'a', 'b'), { recursive: true });
    writeFileSync(join(temp, 'deep', 'a', 'b', 'live.lock'), 'x');
    for (const p of [join(temp, 'deep', 'a', 'b'), join(temp, 'deep', 'a'), join(temp, 'deep')]) setAge(p, 40);
    mkdirSync(join(temp, 'stale')); setAge(join(temp, 'stale'), 40);
    const asked = [];
    const result = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: (p) => { asked.push(p); return false; } });
    assert.deepEqual(readdirSync(temp).sort(), ['deep']);
    assert.equal(result.tempEntries.failed, 0);
    assert.ok(!asked.some((p) => p.startsWith(temp)), 'the holder check never saw a temp entry');
    const big = join(temp, 'deep');
    assert.equal(deepScan(big, { maxFiles: 2 }).newestMs, Infinity);
    assert.ok(Number.isFinite(deepScan(big).newestMs) && deepScan(big).newestMs > Date.now() - HOUR);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('item 3: a build ages by its own top-level times, so a big build with old top-level files goes; a fresh top-level file keeps it', () => {
  const { base, root, temp } = makeBase('cs-buildage-');
  try {
    makeBuild(root, 'big', 's1', 40);
    mkdirSync(join(root, '_builds', 'big', 'sub', 'deeper'), { recursive: true });
    writeFileSync(join(root, '_builds', 'big', 'sub', 'deeper', 'f.bin'), 'x'); // fresh, but deeper than the top level
    setAge(join(root, '_builds', 'big', 'sub'), 40); setAge(join(root, '_builds', 'big'), 40);
    const result = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: notHeld });
    assert.equal(result.builds.deleted, 1);
    assert.ok(!existsSync(join(root, '_builds', 'big')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('ledger age: --ledger ignores a wave ledger last written over 24 h ago and deletes nothing', () => {
  const { base, root } = makeBase('cs-ledgerage-');
  try {
    const ledger = join(root, 'wave-ledger.md');
    writeFileSync(ledger, '## Wave 1 (open)\n- Slice 320 a\n');
    makeBuild(root, 'in-wave', 's320', 0.1);
    assert.deepEqual(ledgerSlices(root), ['320']);
    setAge(ledger, 25);
    assert.deepEqual(ledgerSlices(root), []);
    assert.equal(cleanWave(root, [], { ledger: true, isHeld: notHeld }).builds.deleted, 0);
    assert.ok(existsSync(join(root, '_builds', 'in-wave')));
    setAge(ledger, 23);
    assert.equal(cleanWave(root, [], { ledger: true, isHeld: notHeld }).builds.deleted, 1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('item 1: folder-holders.ps1 -ListFile result lines parse; a folder checked clean is not held, anything else (or unreported) is', () => {
  const held = parseHoldLines('HOLD\t0\tD:\\a\nHOLD\t1\tD:\\b\nHOLD\t3\tD:\\c\nnoise\nHOLD\t2\tD:\\d\r\n');
  assert.deepEqual([...held], [['D:\\a', false], ['D:\\b', true], ['D:\\c', true], ['D:\\d', true]]);
  assert.equal(parseHoldLines(undefined).size, 0);
  assert.equal(checkHeldBatch([]).size, 0);
});

test('item 1: one real pwsh call checks several folders; a missing one counts as held', { skip: process.platform === 'win32' ? false : 'Windows only' }, () => {
  const { base } = makeBase('cs-batch-');
  try {
    const a = join(base, 'a'); const b = join(base, 'b,with comma');
    mkdirSync(a); mkdirSync(b);
    const found = checkHeldBatch([a, b, join(base, 'missing')]);
    assert.equal(found.get(a), false);
    assert.equal(found.get(b), false);
    assert.equal(found.get(join(base, 'missing')), true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('item 7: ignored files are backed up except build output, packages and files over 20 MB', () => {
  const sizes = { '.env': 10, '.dev.vars': 10, 'bin/x.dll': 10, 'src/obj/y.cs': 10, 'a/node_modules/m/i.js': 10, 'app.apk': 10, 'B.MSIX': 10, 'big.dat': BACKUP_MAX_BYTES + 1, 'keystore/up.jks': 10, 'bin.txt': 10 };
  const picked = selectIgnoredBackups(Object.keys(sizes), (rel) => sizes[rel]);
  assert.deepEqual(picked.copy, ['.env', '.dev.vars', 'keystore/up.jks', 'bin.txt']);
  assert.deepEqual(picked.skipped.map((s) => s.rel).sort(), ['B.MSIX', 'a/node_modules/m/i.js', 'app.apk', 'big.dat', 'bin/x.dll', 'src/obj/y.cs']);
});

test('item 7: leftover folders keep a deep fresh file, a held folder, a repo (.git) and the parent of a nested worktree', () => {
  const { base, root, temp } = makeBase('cs-folders-');
  try {
    mkdirSync(join(root, 'reviews-copy', 'slug'), { recursive: true });
    writeFileSync(join(root, 'reviews-copy', 'slug', 'findings.md'), 'edited');
    setAge(join(root, 'reviews-copy', 'slug'), 40); setAge(join(root, 'reviews-copy'), 40);
    mkdirSync(join(root, 'heldone')); setAge(join(root, 'heldone'), 40);
    mkdirSync(join(root, 'aclone', '.git'), { recursive: true });
    for (const p of [join(root, 'aclone', '.git'), join(root, 'aclone')]) setAge(p, 40);
    mkdirSync(join(root, 'plain')); setAge(join(root, 'plain'), 40);
    const result = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: (p) => p.endsWith('heldone') });
    assert.deepEqual(readdirSync(root).sort(), ['aclone', 'heldone', 'reviews-copy']);
    assert.equal(result.folders.deleted, 1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

function makeRepo(prefix) {
  const { base, root, temp } = makeBase(prefix);
  const repo = join(base, 'proj');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' } });
  return { base, repo, root, temp };
}

function addWorktree(repo, root, relPath, branch) {
  git(repo, 'worktree', 'add', ...(branch ? ['-b', branch] : ['--detach']), join(root, relPath));
}

function ageWorktree(wtPath, files = ['a.txt']) {
  const index = execFileSync('git', ['-C', wtPath, 'rev-parse', '--git-path', 'index'], { encoding: 'utf8' }).trim();
  for (const p of [wtPath, join(wtPath, '.git'), index.startsWith('/') || /^[A-Za-z]:/.test(index) ? index : join(wtPath, index), ...files.map((f) => join(wtPath, f))]) setAge(p, 60);
}

function cleanup(base, repo) {
  try { git(repo, 'worktree', 'prune'); } catch { /* temp repo may be gone */ }
  rmSync(base, { recursive: true, force: true });
}

test('cleanStale removes an idle git worktree after backing it up, keeps the branch, skips a held one (items 1, 3)', () => {
  const { base, repo, root, temp } = makeRepo('cs-git-');
  try {
    addWorktree(repo, root, 'idle', 'feat/idle');
    addWorktree(repo, root, 'held', 'feat/held');
    writeFileSync(join(root, 'idle', 'a.txt'), 'two\n');
    for (const name of ['idle', 'held']) ageWorktree(join(root, name));
    const result = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: (path) => path.endsWith('held') });
    assert.equal(result.error, undefined);
    assert.equal(result.worktrees.skippedHeld, 1, JSON.stringify(result));
    assert.equal(result.worktrees.deleted, 1, JSON.stringify(result));
    assert.ok(!existsSync(join(root, 'idle')));
    assert.ok(existsSync(join(root, 'held')));
    assert.equal(result.worktrees.backups.length, 1);
    assert.match(readFileSync(join(result.worktrees.backups[0], 'changes.patch'), 'utf8'), /\+two/);
    assert.match(git(repo, 'branch', '--list', 'feat/idle'), /feat\/idle/);
  } finally { cleanup(base, repo); }
});

test('item 1: untracked files and binary changes are backed up before removal; a failed backup keeps the worktree', () => {
  const { base, repo, root, temp } = makeRepo('cs-backup-');
  try {
    addWorktree(repo, root, 'dirty', 'feat/dirty');
    addWorktree(repo, root, 'nobackup', 'feat/nobackup');
    for (const name of ['dirty', 'nobackup']) {
      mkdirSync(join(root, name, 'sub'));
      writeFileSync(join(root, name, 'sub', 'new.txt'), 'brand new\n');
      ageWorktree(join(root, name), ['a.txt', 'sub/new.txt', 'sub']);
    }
    writeFileSync(join(repo, '.git', 'worktree-backups'), 'a file where the folder should be');
    const failed = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: notHeld });
    assert.equal(failed.worktrees.failed, 2);
    assert.ok(existsSync(join(root, 'dirty', 'sub', 'new.txt')) && existsSync(join(root, 'nobackup')));
    rmSync(join(repo, '.git', 'worktree-backups'));
    for (const name of ['dirty', 'nobackup']) ageWorktree(join(root, name), ['a.txt', 'sub/new.txt', 'sub']); // git diff refreshed the index
    const result = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: notHeld });
    assert.equal(result.worktrees.deleted, 2, JSON.stringify(result));
    assert.ok(!existsSync(join(root, 'dirty')));
    const backup = result.worktrees.backups.find((b) => b.includes('dirty'));
    assert.equal(readFileSync(join(backup, 'untracked', 'sub', 'new.txt'), 'utf8'), 'brand new\n');
  } finally { cleanup(base, repo); }
});

test('item 7: the worktree backup keeps git-ignored .env and lists the skipped build output in README.txt', () => {
  const { base, repo, root, temp } = makeRepo('cs-ignored-');
  try {
    addWorktree(repo, root, 'secrets', 'feat/secrets');
    const wt = join(root, 'secrets');
    writeFileSync(join(wt, '.gitignore'), '.env\nbin/\n');
    writeFileSync(join(wt, '.env'), 'KEY=1\n');
    mkdirSync(join(wt, 'bin'));
    writeFileSync(join(wt, 'bin', 'x.dll'), 'binary');
    ageWorktree(wt, ['a.txt', '.gitignore', '.env', 'bin/x.dll', 'bin']);
    const result = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: notHeld });
    assert.equal(result.worktrees.deleted, 1, JSON.stringify(result));
    const backup = result.worktrees.backups[0];
    assert.equal(readFileSync(join(backup, 'ignored', '.env'), 'utf8'), 'KEY=1\n');
    assert.ok(!existsSync(join(backup, 'ignored', 'bin')));
    assert.match(readFileSync(join(backup, 'README.txt'), 'utf8'), /bin[\\/]x\.dll/);
  } finally { cleanup(base, repo); }
});

test('item 2: an unstaged edit or an untracked file newer than the cutoff keeps the worktree', () => {
  const { base, repo, root, temp } = makeRepo('cs-activity-');
  try {
    addWorktree(repo, root, 'edited', 'feat/edited');
    addWorktree(repo, root, 'newfile', 'feat/newfile');
    addWorktree(repo, root, 'quiet', 'feat/quiet');
    writeFileSync(join(root, 'edited', 'a.txt'), 'changed\n');
    writeFileSync(join(root, 'newfile', 'draft.md'), 'wip\n');
    for (const name of ['edited', 'newfile', 'quiet']) ageWorktree(join(root, name), []);
    const result = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: notHeld });
    assert.ok(existsSync(join(root, 'edited')) && existsSync(join(root, 'newfile')));
    assert.ok(!existsSync(join(root, 'quiet')));
    assert.equal(result.worktrees.deleted, 1);
  } finally { cleanup(base, repo); }
});

test('item 10: an idle worktree under a _* folder is kept', () => {
  const { base, repo, root, temp } = makeRepo('cs-toolwt-');
  try {
    mkdirSync(join(root, '_desktop-vm'));
    addWorktree(repo, root, '_desktop-vm/vm1', 'feat/vm1');
    ageWorktree(join(root, '_desktop-vm', 'vm1'));
    const result = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: notHeld });
    assert.ok(existsSync(join(root, '_desktop-vm', 'vm1')));
    assert.equal(result.worktrees.deleted, 0);
  } finally { cleanup(base, repo); }
});

test('item 12: a detached HEAD on no branch, and a worktree mid-merge, are kept; a detached HEAD on a branch goes', () => {
  const { base, repo, root, temp } = makeRepo('cs-unsafe-');
  try {
    addWorktree(repo, root, 'onbranch');
    addWorktree(repo, root, 'orphan');
    addWorktree(repo, root, 'merging', 'feat/merging');
    writeFileSync(join(root, 'orphan', 'new.txt'), 'only here\n');
    git(join(root, 'orphan'), 'add', '.');
    git(join(root, 'orphan'), 'commit', '-m', 'orphan commit');
    const mergeHead = execFileSync('git', ['-C', join(root, 'merging'), 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
    writeFileSync(join(mergeHead, 'MERGE_HEAD'), `${git(repo, 'rev-parse', 'HEAD').trim()}\n`);
    for (const name of ['onbranch', 'orphan', 'merging']) ageWorktree(join(root, name), ['a.txt']);
    for (const p of [join(root, 'orphan', 'new.txt')]) setAge(p, 60);
    execFileSync('git', ['-C', join(root, 'orphan'), 'commit', '--amend', '--no-edit', '--date=2020-01-01T00:00:00Z'], { env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    ageWorktree(join(root, 'orphan'), ['a.txt', 'new.txt']);
    const result = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: notHeld });
    assert.ok(existsSync(join(root, 'orphan')) && existsSync(join(root, 'merging')), JSON.stringify(result));
    assert.ok(!existsSync(join(root, 'onbranch')), JSON.stringify(result));
    assert.equal(result.worktrees.skippedUnsafe, 2);
  } finally { cleanup(base, repo); }
});

test('item 3: a worktree whose only extra files were skipped (build output) still gets a backup folder with README.txt', () => {
  const { base, repo, root, temp } = makeRepo('cs-readme-');
  try {
    addWorktree(repo, root, 'onlyskipped', 'feat/onlyskipped');
    const wt = join(root, 'onlyskipped');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'bin/\n'); // ignored without a new commit or an untracked .gitignore
    mkdirSync(join(wt, 'bin'));
    writeFileSync(join(wt, 'bin', 'x.dll'), 'binary');
    ageWorktree(wt, ['a.txt', 'bin/x.dll', 'bin']);
    const result = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: notHeld });
    assert.equal(result.worktrees.deleted, 1, JSON.stringify(result));
    assert.equal(result.worktrees.backups.length, 1);
    assert.match(readFileSync(join(result.worktrees.backups[0], 'README.txt'), 'utf8'), /bin[\\/]x\.dll/);
  } finally { cleanup(base, repo); }
});

test('item 4: a backup over the total cap, or one that leaves too little free space, keeps the worktree as kept-backup-too-big', () => {
  const { base, repo, root, temp } = makeRepo('cs-toobig-');
  try {
    for (const name of ['big', 'tight']) {
      addWorktree(repo, root, name, `feat/${name}`);
      writeFileSync(join(root, name, 'new.txt'), 'x'.repeat(2000));
      ageWorktree(join(root, name), ['a.txt', 'new.txt']);
    }
    const capped = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: notHeld, backupMaxBytes: 1000, freeBytes: () => 1e12 });
    assert.equal(capped.worktrees.keptBackupTooBig, 2, JSON.stringify(capped));
    assert.equal(capped.worktrees.deleted, 0);
    assert.equal(capped.failed, 0);
    assert.ok(existsSync(join(root, 'big', 'new.txt')));
    assert.deepEqual(readdirSync(join(repo, '.git', 'worktree-backups')), [], 'no partial backup left');
    for (const name of ['big', 'tight']) ageWorktree(join(root, name), ['a.txt', 'new.txt']);
    const tight = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: notHeld, backupMinFreeBytes: 5000, freeBytes: () => 6000 });
    assert.equal(tight.worktrees.keptBackupTooBig, 2, JSON.stringify(tight));
    for (const name of ['big', 'tight']) ageWorktree(join(root, name), ['a.txt', 'new.txt']);
    const roomy = cleanStale(root, temp, { hours: 24, useBirth: false, isHeld: notHeld, freeBytes: () => 1e12 });
    assert.equal(roomy.worktrees.deleted, 2, JSON.stringify(roomy));
  } finally { cleanup(base, repo); }
});

test('item 4: assertBackupFits throws BackupTooBigError over the cap or under the minimum free space', () => {
  const limits = { maxBytes: 100, minFreeBytes: 1000 };
  assertBackupFits(100, 1100, limits);
  assert.throws(() => assertBackupFits(101, 1e9, limits), BackupTooBigError);
  assert.throws(() => assertBackupFits(100, 1099, limits), BackupTooBigError);
});

test('item 5: backup folders carry seconds and a random suffix and an existing one is never reused', () => {
  const parent = mkdtempSync(join(tmpdir(), 'cs-stamp-'));
  try {
    const date = new Date(2026, 10, 8, 9, 5, 7);
    const names = new Set();
    for (let i = 0; i < 20; i++) {
      const dir = newBackupDir(parent, 's1', date);
      assert.ok(!existsSync(dir));
      mkdirSync(dir);
      names.add(dir);
    }
    assert.equal(names.size, 20);
    for (const dir of names) assert.match(dir, /s1-20261108090507-[0-9a-f]{6}$/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('item 7: the holder-check cap is below the driver kill timeout (run-all-waves.ps1 -StaleCleanupTimeoutSeconds)', () => {
  const script = readFileSync(new URL('./run-all-waves.ps1', import.meta.url), 'utf8');
  const seconds = Number(/\[int\]\$StaleCleanupTimeoutSeconds = (\d+)/.exec(script)?.[1]);
  assert.ok(Number.isFinite(seconds));
  assert.ok(HOLDERS_TIMEOUT_MS < seconds * 1000, `${HOLDERS_TIMEOUT_MS} must be below ${seconds * 1000}`);
});
