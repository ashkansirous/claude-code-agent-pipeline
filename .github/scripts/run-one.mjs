// Runs `node --test <file>` and, past the time cap, kills the whole process tree (the test's own children included),
// then exits TIMEOUT_EXIT. run-suite.mjs starts this; spawnSync's own timeout kills only the direct child, so on
// Windows the children of a test (run-all-waves.test.mjs spawns some) outlive the cap and hold the worktree.
// Usage: node run-one.mjs <root> <file> <timeoutMs>
import { spawn, spawnSync } from 'node:child_process';

export const TIMEOUT_EXIT = 124;

// Windows: taskkill walks the tree from the pid. Elsewhere the child leads its own process group (detached), so -pid reaches all.
function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

function main([root, file, timeoutText]) {
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: root, stdio: 'inherit', detached: process.platform !== 'win32' });
  const timer = setTimeout(() => { killTree(child); process.exit(TIMEOUT_EXIT); }, Number(timeoutText));
  child.on('exit', (code) => { clearTimeout(timer); process.exit(code ?? 1); });
}

if (process.argv[1] && process.argv[1].endsWith('run-one.mjs')) main(process.argv.slice(2));
