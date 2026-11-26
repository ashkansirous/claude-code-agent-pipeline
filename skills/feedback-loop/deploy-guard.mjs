#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell: refuses a direct production deploy from the agent's shell. Production
// changes go only through the repo's build and release pipeline (a merge to main that its CI or Cloudflare Workers
// Builds deploys). On 2026-11-13 (ReadTheStupidText) the night's batched skip-CI merges skipped Workers Builds, and
// the session twice asked the user for an OK to run `wrangler deploy` from main. The user: "why do you need an ok for
// deployment? we have build/release pipelines for this. never directly to production".
//
// Design: reuses the line walker of stdin-interpreter-guard.mjs (continued lines joined, heredoc bodies skipped,
// split on `; && || |`, prefixes stripped). Separators inside quotes are masked first (as git-help-guard.mjs does) and
// an unquoted `{` or `}` also splits, so `if ($?) { wrangler deploy }` is seen. A segment is denied when it starts with
// a deploy command (a tool name with an optional path, .cmd/.exe suffix and version, optionally behind npx, npm exec,
// pnpm dlx, bunx or yarn, with global flags before the subcommand). The inner string of `powershell -Command "..."`,
// `bash -c "..."`, `cmd /c "..."` and `iex "..."` is scanned the same way. Passes: a `--dry-run` or `--help` token
// outside quotes; npm scripts `deploy:dry-run|local|dev|staging|preview|test`; `pnpm deploy` (its packaging command).
// Text that only mentions a deploy (a commit message, an echo) is not at a segment start, so it passes.
// Out of scope: d1 and secret writes, `npm publish`. Fail open on an internal error.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commandLines, segmentsOf } from './stdin-interpreter-guard.mjs';

const REASON =
  'Production is changed only through the build and release pipeline: merge to main and let its CI or Cloudflare ' +
  'Workers Builds deploy, then confirm that run. Never deploy from a shell and never ask the user for an OK to. If ' +
  "a pipeline run was skipped (a skip-CI batch merge), start the pipeline's own run (its retry, deploy hook or " +
  '`gh workflow run`) and record the gap as tooling work. `--dry-run`, `--help`, `terraform plan` and the npm scripts ' +
  '`deploy:dry-run|local|dev|staging|preview|test` are allowed; `terraform apply` is denied from a shell.';

const SAFE_SCRIPT_SUFFIXES = new Set(['dry-run', 'local', 'dev', 'staging', 'preview', 'test']);
const MAX_DEPTH = 4;

const START = String.raw`^\s*(?:&\s*)?`;
const exe = (name) => String.raw`(?:\S*[\\/])?${name}(?:\.cmd|\.exe|\.ps1|\.js)?`;
const TOOL = (name) => `${exe(name)}(?:@\\S+)?`;
// Global flags between the tool and its subcommand: value flags with their value, any other flag alone.
const FLAGS = String.raw`(?:\s+(?:(?:-c|--config|-e|--env|--cwd|--project|--prefix|-w|--workspace|-C|--dir|--filter|-F|--profile)(?:\s+|=)\S+|-\S+))*`;
const RUNNER =
  String.raw`(?:(?:${exe('npx')}|${exe('bunx')})(?:\s+(?:--yes|-y|--no-install|--|-p\s+\S+))*\s+|` +
  String.raw`(?:${exe('npm')}|${exe('pnpm')}|${exe('yarn')}|${exe('bun')})\s+(?:exec|dlx|x)(?:\s+--)?\s+|` +
  String.raw`(?:${exe('pnpm')}|${exe('yarn')})\s+|node(?:\.exe)?\s+)?`;
const tool = (name, rest) => new RegExp(`${START}${RUNNER}${TOOL(name)}${FLAGS}${rest}`, 'i');

const DEPLOY_COMMANDS = [
  tool('wrangler', String.raw`\s+(?:deploy|publish|rollback|versions\s+deploy|pages\s+deploy|triggers\s+deploy)\b`),
  tool('firebase', String.raw`\s+deploy\b`),
  tool('vercel', String.raw`(?:\s+deploy)?(?:\s+(?:[.~]\S*|\S*[\\/]\S*))?(?:\s+-\S+)*?\s+--prod\b`),
  tool('netlify', String.raw`\s+deploy\b.*--prod\b`),
  new RegExp(`${START}${exe('fly(?:ctl)?')}${FLAGS}\\s+deploy\\b`, 'i'),
  new RegExp(`${START}${exe('gcloud')}${FLAGS}\\s+(?:app|run|functions)\\s+deploy\\b`, 'i'),
  new RegExp(`${START}${exe('az')}${FLAGS}\\s+(?:webapp|functionapp|staticwebapp)\\s+(?:deploy|deployment)\\b`, 'i'),
  tool('(?:serverless|sls|cdk)', String.raw`\s+deploy\b`),
  new RegExp(`${START}${exe('(?:terraform|tofu)')}${FLAGS}\\s+apply\\b`, 'i'),
  new RegExp(`${START}${exe('pulumi')}${FLAGS}\\s+up\\b`, 'i'),
];
const SCRIPT_SUFFIX = String.raw`(?::(?<suffix>[\w-]+))?(?=\s|$)`;
const NPM_DEPLOY = new RegExp(
  `${START}(?<pm>${exe('npm')}|${exe('pnpm')}|${exe('yarn')}|${exe('bun')})${FLAGS}\\s+(?:(?<run>run-script|run)${FLAGS}\\s+)?deploy${SCRIPT_SUFFIX}`, 'i');
const YARN_WORKSPACE_DEPLOY = new RegExp(`${START}${exe('yarn')}\\s+workspace\\s+\\S+\\s+(?:run\\s+)?deploy${SCRIPT_SUFFIX}`, 'i');

const WRAPPERS = [
  /^(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s+(?:-\S+\s+)*?-(?:c|command)\s+(?<inner>.+)$/i,
  /^(?:\S*[\\/])?(?:bash|sh|zsh|dash)(?:\.exe)?\s+(?:-\S+\s+)*?-\w*c\s+(?<inner>.+)$/i,
  /^(?:\S*[\\/])?cmd(?:\.exe)?\s+(?:\/\S+\s+)*?\/[ck]\s+(?<inner>.+)$/i,
  /^(?:invoke-expression|iex)\s+(?<inner>.+)$/i,
];
const WRAPPER_PREFIX = /^(?:time|sudo|nohup|xargs(?:\s+-\S+)*)\s+/i;
const QUOTED_PATH = /^(?:&\s*)?(["'])([^"']*)\1(?=\s|$)/;
const MASK = { ';': '', '&': '', '|': '' };
const UNMASK = Object.fromEntries(Object.entries(MASK).map(([plain, mask]) => [mask, plain]));

// Masks `; & |` inside quotes so the walker cannot split there; an unquoted `{` or `}` becomes a separator.
function maskLine(line) {
  let quote = '';
  let out = '';
  for (const ch of line) {
    if (quote) {
      out += MASK[ch] ?? ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else {
      out += ch === '{' || ch === '}' ? ';' : ch;
    }
  }
  return out;
}

const unmask = (text) => text.replace(/[-]/g, (ch) => UNMASK[ch]);

// A quoted program path with spaces becomes its bare file name; wrapper words (`time`, `sudo`, `xargs`) are dropped.
function normalize(command) {
  let rest = command.trim();
  const quoted = QUOTED_PATH.exec(rest);
  if (quoted && (/[\\/]/.test(quoted[2]) || /\.(?:cmd|exe|ps1)$/i.test(quoted[2]))) {
    rest = quoted[2].split(/[\\/]/).pop() + rest.slice(quoted[0].length);
  }
  for (let match = WRAPPER_PREFIX.exec(rest); match; match = WRAPPER_PREFIX.exec(rest)) rest = rest.slice(match[0].length);
  return rest;
}

// The text inside `powershell -Command "..."`, `bash -c "..."`, `cmd /c "..."`, `iex "..."`, or null.
function innerCommand(command) {
  for (const pattern of WRAPPERS) {
    const inner = pattern.exec(command)?.groups.inner.trim();
    if (inner === undefined) continue;
    const quoted = /^(["'])([\s\S]*)\1$/.exec(inner);
    return quoted ? quoted[2].replace(/\\"/g, '"') : inner;
  }
  // `cmd /c` is stripped by the shared walker, which leaves the quoted string as the whole segment.
  const whole = /^(["'])([^"']*\s[^"']*)\1$/.exec(command);
  return whole ? whole[2] : null;
}

const DEPLOY_WORDS = new Set(['deploy', 'publish', 'rollback', 'apply', 'up']);
const VALUE_FLAGS = new Set(['-m', '--message', '-e', '--env', '-c', '--config', '--name', '--tag', '--branch', '--commit-message', '--outdir', '--cwd', '--project']);
const OFF_VALUES = new Set(['false', '0', 'no']);

// `--dry-run` or `--help` as a token of its own outside quotes, in this segment, after the deploy subcommand and not
// the value of another flag; `-h` and `-help` only as the first token after the subcommand.
function isHarmless(command) {
  const tokens = command.replace(/"[^"]*"|'[^']*'/g, ' "" ').split(/\s+/).filter(Boolean);
  const deployAt = tokens.findIndex((token) => DEPLOY_WORDS.has(token.toLowerCase()));
  return tokens.some((token, index) => {
    if (index <= deployAt) return false;
    if (VALUE_FLAGS.has(tokens[index - 1]?.toLowerCase())) return false;
    if (token === '--dry-run') return !OFF_VALUES.has(tokens[index + 1]?.toLowerCase());
    if (token === '--help') return true;
    return deployAt >= 0 && index === deployAt + 1 && (token === '-h' || token === '-help');
  });
}

function isScriptDeploy(command) {
  const match = NPM_DEPLOY.exec(command) ?? YARN_WORKSPACE_DEPLOY.exec(command);
  if (!match) return false;
  const { suffix, run, pm } = match.groups;
  if (suffix && SAFE_SCRIPT_SUFFIXES.has(suffix.toLowerCase())) return false;
  return !(pm && /pnpm/i.test(pm) && !run && !suffix);
}

function isDeploy(command) {
  if (isHarmless(command)) return false;
  return isScriptDeploy(command) || DEPLOY_COMMANDS.some((pattern) => pattern.test(command));
}

function segmentDenied(segment, depth) {
  const command = normalize(unmask(segment.command));
  const inner = innerCommand(command);
  if (inner !== null && scan(inner, depth + 1)) return true;
  return isDeploy(command);
}

const HEREDOC_START = /^<<-?\s*(['"]?)([\w.-]+)\1/;
const NEWLINES = /\r?\n/g;

// Index just past the closing `quote` after `from`, or -1 when the string never closes.
const closeOf = (raw, quote, from) => {
  const at = raw.indexOf(quote, from);
  return at < 0 ? -1 : at + 1;
};

// One quoted string (or PowerShell here-string) copied as a single line: newlines become `;` (masked later as quoted
// separators) and a here-string's quotes become plain ones. Returns [text, nextIndex].
function foldQuoted(raw, at) {
  const quote = raw[at];
  const hereString = raw[at - 1] === '@' && /^\r?\n/.test(raw.slice(at + 1)) && at > 0;
  if (hereString) {
    const end = new RegExp(`\\r?\\n${quote}@`).exec(raw.slice(at + 1));
    if (end) {
      const body = raw.slice(at + 1, at + 1 + end.index);
      return [`${quote}${body.replace(NEWLINES, ';').replace(/['"]/g, ' ')}${quote}`, at + 1 + end.index + end[0].length];
    }
  }
  const close = closeOf(raw, quote, at + 1);
  if (close < 0) return [raw.slice(at), raw.length];
  return [raw.slice(at, close).replace(NEWLINES, ';'), close];
}

// The command with every multi-line quoted string, here-string and comment folded or kept whole, so quote state
// carries across lines; heredoc bodies are copied untouched (their apostrophes are not quotes).
function foldQuotes(raw) {
  let out = '';
  let heredoc = null;
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i];
    if (ch === '\n' && heredoc) {
      const body = new RegExp(`\\n(?:[^\\n]*\\n)*?[ \\t]*${heredoc}[ \\t]*(?=\\r?\\n|$)`).exec(raw.slice(i));
      const end = body ? i + body[0].length : raw.length;
      out += raw.slice(i, end);
      i = end;
      heredoc = null;
    } else if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
      const end = raw.indexOf('\n', i);
      const stop = end < 0 ? raw.length : end;
      out += raw.slice(i, stop);
      i = stop;
    } else if (ch === '"' || ch === "'") {
      const [text, next] = foldQuoted(raw, i);
      out += text;
      i = next;
    } else {
      const start = ch === '<' && raw[i - 1] !== '<' ? HEREDOC_START.exec(raw.slice(i)) : null;
      if (start) heredoc = start[2];
      out += start ? start[0] : ch;
      i += start ? start[0].length : 1;
    }
  }
  return out;
}

function scan(raw, depth) {
  if (depth > MAX_DEPTH) return false;
  return commandLines(foldQuotes(raw)).some((line) => segmentsOf(maskLine(line)).some((segment) => segmentDenied(segment, depth)));
}

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

export function decide(input) {
  const raw = String(input?.tool_input?.command ?? '');
  return scan(raw, 0) ? deny(REASON) : null;
}

// Compares real paths: ~/.claude/skills/<name> is a symlink into the repo (see entry-points.test.mjs).
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try {
    return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch (error) {
    process.stderr.write(`deploy-guard: realpath failed (${error.message}); comparing plain paths\n`);
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`deploy-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
