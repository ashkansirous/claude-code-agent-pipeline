// Shared by the heuristic hooks that are ADVISORY (Slice 307, "Design (two strikes): advisory hooks"): they never
// deny and never decide. The output carries NO permissionDecision: a hook "allow" skips the user's permission prompt
// (Claude Code hooks reference, PreToolUse decision control: `"allow"` skips the permission prompt), so an advisory
// hook leaves the normal prompt flow alone and only adds `additionalContext` (same page: "String added to Claude's
// context alongside the tool result"; the Agent SDK type has `permissionDecision?` optional). One line also goes to
// the advisory log so a later slice can promote a hook to deny from evidence.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const LOG_ENV = 'ADVISORY_HOOKS_LOG';

export function logPath() {
  return process.env[LOG_ENV] || join(homedir(), '.claude', 'logs', 'advisory-hooks.log');
}

// The PreToolUse output that shows `reason` to the model and decides nothing about permission.
export function advisory(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `Hook warning (the call was allowed): ${reason}`,
    },
  };
}

// One tab-separated line: time, hook, cwd, reason. A log failure never blocks the call.
export function logAdvisory(hook, cwd, reason, now = new Date()) {
  const clean = (text) => String(text ?? '').replace(/[\t\r\n]+/g, ' ');
  try {
    const file = logPath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${now.toISOString()}\t${hook}\t${clean(cwd)}\t${clean(reason)}\n`);
  } catch (error) {
    process.stderr.write(`${hook}: could not write the advisory log (${error.message})\n`);
  }
}

// Runs a hook's `decide`: prints the verdict and logs it when it carries a warning.
export function emit(hook, verdict, cwd) {
  if (!verdict) return;
  logAdvisory(hook, cwd, verdict.hookSpecificOutput.additionalContext);
  process.stdout.write(JSON.stringify(verdict));
}
