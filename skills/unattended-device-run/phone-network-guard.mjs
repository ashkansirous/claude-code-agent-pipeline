#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell: refuses an adb or Maestro statement that turns off a device's
// Wi-Fi, mobile data or airplane mode unless that statement targets only an emulator by name
// (`emulator-NNNN`). On a phone driven over wireless adb (USB first is the rule, but a run may fall back
// to wireless, so the ban holds for USB too), cutting the network cuts the adb link itself,
// so the step that would turn it back on never reaches the phone and it stays offline. A statement with
// no serial, a serial in a variable or ANDROID_SERIAL, or an ip:port / mDNS serial is refused: cut one
// app's network instead from a check script that starts a device-side restore first (a typed `cmd
// netpolicy` is refused too), or name the emulator. Each adb invocation is judged on its own serial, also
// when nested in a quoted chain. A Maestro statement is judged the same way when a flow file or folder
// it names toggles airplane mode. Each statement (split on ; && || | and new lines) is judged on its own,
// and only statements that run adb or maestro count, so a commit message or grep that mentions the
// command passes. Best effort: a cut hidden in a script the command calls is not seen (tools/phone checks
// carry their own guard). An internal error lets the call through (fail open), with a note on stderr.
// (2026-10-31, ReadTheStupidText: a Slice 208 phone check ran `svc wifi disable` on the test phone over
// wireless adb and left it offline with its test settings changed.)
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NETWORK_CUT = [
  /\bsvc\s+(wifi|data)\s+disable\b/i,
  /\bcmd\s+(-w\s+)?wifi\s+set-wifi-enabled\s+disabled\b/i,
  /\bcmd\s+connectivity\s+airplane-mode\s+enable\b/i,
  /\bsettings\s+(--user\s+\S+\s+)?put\s+global\s+(airplane_mode_on\s+1|wifi_on\s+0|mobile_data\s+0)\b/i,
  /\bam\s+broadcast\b[\s\S]*\bAIRPLANE_MODE\b/i,
  /\bifconfig\s+(wlan|rmnet)\w*\s+down\b/i,
  /\bip\s+link\s+set\s+(dev\s+)?(wlan|rmnet)\w*\s+down\b/i,
];
// Device-wide settings a typed command must not change on a real phone: they affect every app and
// the user's own use, and a typed command has no device-side restore. Undo forms (`device_config
// delete`, `am compat reset`) and the settings the phone pre-flight itself sets (only
// stay_on_while_plugged_in) or network-on stay allowed. (2026-10-31: the
// test phone was left with a device-wide dataSync limit and a compat flag.)
const DEVICE_WIDE = [
  /\bdevice_config\s+(put|override|set_sync_disabled_for_tests)\b/i,
  /\bam\s+compat\s+(enable|disable)\b/i,
  /\bplatform_compat\b/i,
  /\bcmd\s+netpolicy\b/i,
  /\bcmd\s+settings\b/i,
  /\bsetprop\b/i,
  /\bcontent\s+(insert|update)\b[\s\S]*content:\/\/settings/i,
  /\bsettings\s+(--user\s+\S+\s+)?put\s+(global|secure|system)\s+(?!(stay_on_while_plugged_in|airplane_mode_on\s+0|wifi_on\s+1|mobile_data\s+1)\b)\S+/i,
];
// A statement runs adb or maestro when that is its command word (after env assignments, `&`, a path or a variable such as $script:Adb).
// The word before adb/maestro may only be a path or variable (no `*`, so a regex such as `force-stop.*maestro"` cut out of a quoted grep pattern by the naive split is not a command).
const DEVICE_STATEMENT = /^\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:&\s*)?["']?[\w.\\/:$~{}()-]*\b(adb|maestro)(\.exe|\.cmd|\.bat)?["']?(\s|$)/i;
const MAESTRO_STATEMENT = /^\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:&\s*)?["']?[\w.\\/:$~{}()-]*\bmaestro(\.cmd|\.bat)?["']?(\s|$)/i;
const ADB_INVOCATION = /(?=\badb(?:\.exe|\.cmd|\.bat)?(?:\s|["']|$))/i;
const STATEMENT_SPLIT = /\r?\n|;|&&|\|\||\|/;
const EMULATOR_SERIAL = /\bemulator-\d+\b/i;
const WIRELESS_SERIAL = /\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b|_adb-tls-connect\._tcp/i;
const TOKEN = /"[^"]*"|'[^']*'|\S+/g;
const AIRPLANE_STEP = /^\s*-\s*(toggleAirplaneMode|setAirplaneMode)\b/im;
const SKIPPED_FOLDERS = new Set(['node_modules', '.git', 'bin', 'obj']);
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 6;
const REASON = 'phone network guard: this adb/Maestro statement changes device-wide state (device_config put, am compat enable, settings put global/secure) or turns off Wi-Fi, mobile data or airplane mode without naming only an emulator (adb -s emulator-NNNN, maestro --device emulator-NNNN). A network cut over wireless adb cuts the adb link itself and strands the phone offline; a device-wide setting changes every app on the user\'s phone and a typed command has no device-side restore. Run it on the emulator, or in a check script that starts a device-side restore first (a typed cmd netpolicy, cmd settings, setprop or content update is refused too).';

function commandOf(input) {
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return null;
  return String(input.tool_input?.command ?? '');
}

// Yaml files under a path, bounded so a broad path (a repo root, a drive) stays quick.
function flowFiles(root) {
  const found = [];
  const pending = [{ path: root, depth: 0 }];
  for (let seen = 0; pending.length && seen < MAX_ENTRIES; seen++) {
    const { path, depth } = pending.pop();
    let info;
    try { info = statSync(path, { throwIfNoEntry: false }); } catch { continue; }
    if (info?.isFile() && /\.ya?ml$/i.test(path)) found.push(path);
    if (!info?.isDirectory() || depth >= MAX_DEPTH) continue;
    let names = [];
    try { names = readdirSync(path); } catch { continue; } // a folder Windows will not list is skipped
    for (const name of names) {
      if (!SKIPPED_FOLDERS.has(name)) pending.push({ path: join(path, name), depth: depth + 1 });
    }
  }
  return found;
}

function flowTogglesAirplane(statement) {
  const paths = (statement.match(TOKEN) ?? []).map((t) => t.replace(/^['"]|['"]$/g, '')).filter((t) => !t.startsWith('-') && existsSync(t));
  return paths.some((p) => flowFiles(p).some((file) => AIRPLANE_STEP.test(readFileSync(file, 'utf8'))));
}

function invocationCuts(text) {
  return NETWORK_CUT.some((pattern) => pattern.test(text)) || DEVICE_WIDE.some((pattern) => pattern.test(text));
}

function targetsOnlyEmulator(text) {
  return EMULATOR_SERIAL.test(text) && !WIRELESS_SERIAL.test(text);
}

// Each adb invocation inside the statement (also one nested in a quoted chain) is judged on its own serial.
function statementCutsLink(statement) {
  if (!DEVICE_STATEMENT.test(statement)) return false;
  if (MAESTRO_STATEMENT.test(statement)) {
    return (invocationCuts(statement) || flowTogglesAirplane(statement)) && !targetsOnlyEmulator(statement);
  }
  return statement.split(ADB_INVOCATION).some((part) => invocationCuts(part) && !targetsOnlyEmulator(part));
}

// Splits on the statement separators that sit outside quotes, so a quoted `adb shell '...; ...'` chain stays whole.
function splitOutsideQuotes(command) {
  const statements = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/[\n;|&]/.test(ch)) {
      statements.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  statements.push(current);
  return statements;
}

// Both views are judged: the plain split sees a statement inside `bash -c "..."`, the quote-aware one sees a whole quoted chain.
export function cutsWirelessLink(command) {
  if (!command) return false;
  return command.split(STATEMENT_SPLIT).some(statementCutsLink) || splitOutsideQuotes(command).some(statementCutsLink);
}

export function decide(input) {
  if (!cutsWirelessLink(commandOf(input))) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON } };
}

// Compares real paths: ~/.claude/skills/<name> is a copy of, or a symlink to, the AgentPipeline repo.
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch (error) {
    process.stderr.write(`phone-network-guard: let the call through after an internal error: ${error.message}\n`);
  }
}
