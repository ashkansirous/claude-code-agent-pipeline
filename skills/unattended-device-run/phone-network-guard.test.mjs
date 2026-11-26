// node --test skills/unattended-device-run/phone-network-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cutsWirelessLink, decide } from './phone-network-guard.mjs';

const HOOK = fileURLToPath(new URL('./phone-network-guard.mjs', import.meta.url));
const PHONE = '192.0.2.10:39125';

test('refuses Wi-Fi, data and airplane cuts over an ip:port serial', () => {
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell svc wifi disable`), true);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell svc data disable`), true);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell cmd connectivity airplane-mode enable`), true);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell settings put global airplane_mode_on 1`), true);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell cmd wifi set-wifi-enabled disabled`), true);
});

test('refuses typed device-wide changes on a phone; allows undo, stay-awake and the emulator', () => {
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell device_config put activity_manager data_sync_fgs_timeout_duration 30000`), true);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell am compat enable FGS_INTRODUCE_TIME_LIMITS uk.x.dbg`), true);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell settings put global animator_duration_scale 0`), true);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell device_config delete activity_manager data_sync_fgs_timeout_duration`), false);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell am compat reset FGS_INTRODUCE_TIME_LIMITS uk.x.dbg`), false);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell settings put global stay_on_while_plugged_in 7`), false);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell settings put global wifi_on 1`), false);
  assert.equal(cutsWirelessLink('adb -s emulator-5554 shell device_config put activity_manager x 1'), false);
});

test('refuses the other device-wide spellings and keeps the near-misses refused', () => {
  const shell = (cmd) => `adb -s ${PHONE} shell ${cmd}`;
  assert.equal(cutsWirelessLink(shell('settings put secure foo 1')), true);
  assert.equal(cutsWirelessLink(shell('settings put system font_scale 2')), true);
  assert.equal(cutsWirelessLink(shell('settings --user 0 put global foo 1')), true);
  assert.equal(cutsWirelessLink(shell('cmd device_config put ns k v')), true);
  assert.equal(cutsWirelessLink(shell('device_config override ns k v')), true);
  assert.equal(cutsWirelessLink(shell('device_config set_sync_disabled_for_tests persistent')), true);
  assert.equal(cutsWirelessLink(shell('cmd platform_compat enable X pkg')), true);
  assert.equal(cutsWirelessLink(shell('am compat disable X pkg')), true);
  assert.equal(cutsWirelessLink(shell('settings put global stay_on_while_plugged_in_foo 1')), true);
  assert.equal(cutsWirelessLink(shell('settings put global wifi_on 10')), true);
  assert.equal(cutsWirelessLink(shell('settings put global airplane_mode_on 0')), false);
  assert.equal(cutsWirelessLink(shell('settings put global mobile_data 1')), false);
});

test('judges a quoted multi-command shell string as a whole', () => {
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell 'settings put global stay_on_while_plugged_in 7; device_config put a b c'`), true);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell "settings put global stay_on_while_plugged_in 7; settings put global foo 1"`), true);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell 'settings put global stay_on_while_plugged_in 7; dumpsys battery'`), false);
});

test('refuses over an mDNS serial', () => {
  assert.equal(cutsWirelessLink('adb -s adb-R5CT123-xYz._adb-tls-connect._tcp shell svc wifi disable'), true);
});

test('allows the emulator, turning the network back on, and per-app blocks', () => {
  assert.equal(cutsWirelessLink('adb -s emulator-5554 shell svc wifi disable'), false);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell svc wifi enable`), false);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell dumpsys battery`), false);
});

test('judges each adb invocation on its own serial, also inside a quoted chain', () => {
  const chain = (inner) => `adb -s emulator-5554 shell 'ls; ${inner}'`;
  assert.equal(cutsWirelessLink(chain(`adb -s ${PHONE} shell svc wifi disable`)), true);
  assert.equal(cutsWirelessLink(chain('adb shell svc wifi disable')), true);
  assert.equal(cutsWirelessLink(`bash -c "adb -s emulator-5554 shell ls; adb -s ${PHONE} shell svc data disable"`), true);
  assert.equal(cutsWirelessLink(chain('adb -s emulator-5556 shell svc wifi disable')), false);
  assert.equal(cutsWirelessLink(`adb -s emulator-5554 shell 'svc wifi disable; svc data disable'`), false);
});

test('only the pre-flight setting stays allowed under settings put', () => {
  const shell = (cmd) => `adb -s ${PHONE} shell ${cmd}`;
  assert.equal(cutsWirelessLink(shell('settings put global stay_on_while_plugged_in 7')), false);
  assert.equal(cutsWirelessLink(shell('settings put system screen_off_timeout 600000')), true);
  assert.equal(cutsWirelessLink(shell('settings put global window_animation_scale 0')), true);
  assert.equal(cutsWirelessLink(shell('settings put secure location_mode 0')), true);
});

test('refuses setprop, content settings writes, cmd netpolicy, cmd settings and any platform_compat', () => {
  const shell = (cmd) => `adb -s ${PHONE} shell ${cmd}`;
  assert.equal(cutsWirelessLink(shell('setprop persist.sys.x 1')), true);
  assert.equal(cutsWirelessLink(shell('content insert --uri content://settings/global --bind name:s:x --bind value:s:1')), true);
  assert.equal(cutsWirelessLink(shell('content update --uri content://settings/system --bind value:s:1 --where "name=\'x\'"')), true);
  assert.equal(cutsWirelessLink(shell('content query --uri content://settings/global')), false);
  assert.equal(cutsWirelessLink(shell('cmd netpolicy add restrict-background-blacklist 10234')), true);
  assert.equal(cutsWirelessLink(shell('cmd settings put global x 1')), true);
  assert.equal(cutsWirelessLink(shell('cmd platform_compat reset X pkg')), true);
  assert.equal(cutsWirelessLink('adb -s emulator-5554 shell setprop a b'), false);
});

test('refuses a maestro run on a wireless device whose flow toggles airplane mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  try {
    const airplane = path.join(dir, 'offline.yaml');
    const plain = path.join(dir, 'plain.yaml');
    fs.writeFileSync(airplane, 'appId: x\n---\n- launchApp\n- toggleAirplaneMode\n');
    fs.writeFileSync(plain, 'appId: x\n---\n- launchApp\n');
    assert.equal(cutsWirelessLink(`maestro --device ${PHONE} test ${airplane}`), true);
    assert.equal(cutsWirelessLink(`maestro --device ${PHONE} test ${plain}`), false);
    assert.equal(cutsWirelessLink(`maestro --device emulator-5554 test ${airplane}`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only Bash and PowerShell calls are judged', () => {
  assert.equal(decide({ tool_name: 'Read', tool_input: { command: `adb -s ${PHONE} shell svc wifi disable` } }), null);
  assert.equal(decide({ tool_name: 'PowerShell', tool_input: { command: `adb -s ${PHONE} shell svc wifi disable` } }).hookSpecificOutput.permissionDecision, 'deny');
});

test('the script denies on stdin and fails open on garbage', () => {
  const run = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });
  const denied = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: `adb -s ${PHONE} shell svc wifi disable` } }));
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })).stdout, '');
  assert.equal(run('garbage').status, 0);
});

test('refuses a cut with no serial, a variable serial or ANDROID_SERIAL', () => {
  assert.equal(cutsWirelessLink('adb shell svc wifi disable'), true);
  assert.equal(cutsWirelessLink('adb -s $PHONE shell svc data disable'), true);
  assert.equal(cutsWirelessLink(`ANDROID_SERIAL=${PHONE} adb shell svc wifi disable`), true);
  // Per statement: connecting the phone, then cutting only the emulator, is fine.
  assert.equal(cutsWirelessLink(`adb connect ${PHONE}; adb -s emulator-5554 shell svc wifi disable`), false);
});

test('refuses the settings and interface forms', () => {
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell settings put global wifi_on 0`), true);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell settings put global mobile_data 0`), true);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell su -c ifconfig wlan0 down`), true);
  assert.equal(cutsWirelessLink(`adb -s ${PHONE} shell ip link set wlan0 down`), true);
});

test('does not fire on text that only mentions the command', () => {
  assert.equal(cutsWirelessLink(`git commit -m "never run svc wifi disable on ${PHONE}"`), false);
  assert.equal(cutsWirelessLink('echo svc wifi disable'), false);
});

test('scans a flow folder named to maestro', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-dir-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'offline.yaml'), 'appId: x\n---\n- toggleAirplaneMode\n');
    assert.equal(cutsWirelessLink(`maestro --device ${PHONE} test ${dir}`), true);
    assert.equal(cutsWirelessLink(`maestro --device emulator-5554 test ${dir}`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('judges each statement on its own', () => {
  assert.equal(cutsWirelessLink('adb -s emulator-5554 shell ls; adb shell svc wifi disable'), true);
  assert.equal(cutsWirelessLink('adb -s emulator-5554 shell svc wifi disable && adb -s emulator-5554 shell svc wifi enable'), false);
  assert.equal(cutsWirelessLink(`& $script:Adb -s ${PHONE} shell svc wifi disable`), true);
});

test('a grep or comment mentioning adb and the command passes', () => {
  assert.equal(cutsWirelessLink('grep -rn "svc wifi disable" tools # adb'), false);
  assert.equal(cutsWirelessLink(`git commit -m "adb -s ${PHONE} shell svc wifi disable broke it"`), false);
});

test('maestro paths after flags are scanned; a broad path stays quick', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-flags-'));
  try {
    fs.writeFileSync(path.join(dir, 'offline.yaml'), 'appId: x\n---\n- setAirplaneMode: enabled\n');
    assert.equal(cutsWirelessLink(`maestro test --device ${PHONE} ${dir}`), true);
    const started = Date.now();
    cutsWirelessLink(`maestro --device ${PHONE} test ${os.homedir()}`);
    assert.ok(Date.now() - started < 3000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a grep pattern with an escaped pipe and a maestro word is not read as a maestro statement', () => {
  assert.equal(cutsWirelessLink('git grep -c -i "x\\|force-stop.*maestro" origin/main -- tools .maestro'), false);
  assert.equal(cutsWirelessLink('git grep -c -i "x\\|svc wifi disable.*adb" origin/main -- tools'), false);
  assert.equal(cutsWirelessLink('bash -c "true; adb shell svc wifi disable"'), true);
});
