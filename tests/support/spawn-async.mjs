// An asynchronous twin of spawnSync for test files that run slow child processes side by side (Slice 30 items J and K):
// spawnSync blocks the one event loop, so tests started with a concurrency above 1 would never overlap. Same result fields
// as spawnSync (status, stdout, stderr); a spawn failure resolves with status null and the error text instead of throwing.
import { spawn } from 'node:child_process';

export function spawnAsync(cmd, args, options) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => resolve({ status: null, stdout, stderr: stderr + String(error), error }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    // A failed spawn can leave stdin destroyed; its error is reported through the 'error' event above, never thrown here.
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}
