---
name: unattended-device-run
description: Run a whole list of device checks on a real phone (or emulator/VM) while the user is away or asleep, from the coordinating session - one checklist from every "Not yet verified" line, phone pre-flight, device lease, scripted device-test agents, bugs become planned slices, one report at the end. Load when the user is leaving or going to sleep, "you can use the phone", "you have my computer/phone to run the checks", "run the remaining checks", "test what's left in the plan", or hands over a device.
---

The job is: **run every check on the list, write each bug down as a planned slice, be done.** No fixing
during a device run: the devices and the time are for checks only (user, 2026-11-08, after two 3-hour runs
spent mostly building and reviewing fixes while 180 device checks stayed unrun: when the owner hands over the
computer or phone to run the checks, run only the checks; fixing the bugs is planned and done in slices). The user is
not there to answer. Nothing below is a reason to stop and ask, except the pre-flight in step 2, which
happens while the user is still there. (2026-10-29, ReadTheStupidText test phone night: a PIN lock nobody checked,
a brief that banned UI taps, a deleted voice pack, two scripts on one phone, and a session that stopped to
ask a sleeping user two questions. The owner's ruling: the job is to test whatever the plan says, report
the bugs and be done; if anything is stopping the run, a simple reset should fix it.)

## 1. Build the checklist (before the user leaves)

- Collect every *Not yet verified* line from `docs/plan/unverified.md` and the slice files it links (an old-layout
  repo with no such file: `plan.md` *Outstanding work* instead; read `origin/main`, not the primary checkout). One row each: the check, its slice, the device it needs
  (Android phone, emulator, Windows VM, iPhone, a human ear), and whether it needs the app on screen, the
  network, or a changed setting.
- A line's tag (`[phone]`, `[chrome]`, `[session]`, `[cloud]`, `[chat]`, `[owner]`, see `update-docs`) says who runs it:
  every `[phone]` line, including a web page opened in the phone's browser, is in this checklist and runs under the
  lease; the test phone is never asked for (Slice 31). The driver's
  `live-checks` session runs the same lines after each release.
- Mark what truly can't run here (no Mac for iOS, a by-ear listen, the user's login) now, with the reason,
  so it is never discovered at 3 am.
- **Order** so state one item changes doesn't block another: read-only checks first, downloads before the
  checks that need the pack, language/voice switches last and each one switched back. Forcing a download
  means moving the pack aside and restoring it, never deleting it.

## 2. Pre-flight, the same minute the user says they're going

Run the repo's pre-flight (in ReadTheStupidText `tools/phone/preflight.ps1`; elsewhere check by hand):
connected (USB first, else wireless), **charging**, **screen lock None or Swipe**, stay-awake on, free space, dev installs
present. A PIN, pattern or password lock is the one thing to ask about now: the app has to be on screen to
start a download, open a screen or play a book, and a PIN blocks that all night. Ask once, in one message,
for everything the pre-flight found (plug in, lock off), then wait for the GO. After that, never ask again.

Remind the user in the final report to restore their PIN. Write the phone's stay-awake value
(`settings get global stay_on_while_plugged_in`) into the night folder before the pre-flight changes
it, and set it back at the end of the run: it is a setting the run changed, not the user's (2026-11-01:
the screen stayed on after a run, and nobody knew what the old value had been).

## 3. Hold the device

Take the device lease (ReadTheStupidText `tools/phone/lease.ps1 -Take -Owner <session>`) and pass the owner
to every agent (`RTST_PHONE_OWNER`). One harness script per device at a time: run device agents on one
phone **one after another**, never two at once. If another session holds the lease, run the emulator/VM
items meanwhile and message that session; never take the phone from under it.

## 4. Brief device-test agents (the brief is what goes wrong)

If the repo has a check runner (ReadTheStupidText `tools/phone/run-checks.ps1`), the brief only
names its checks; never write per-item time caps, builds or comparison runs into a brief. Anything
the runner can't check yet goes in the brief as one item, and becomes a runner check afterwards.

Every brief says, in so many words:

- **Allowed:** clearing and reinstalling the `.dbg` dev install, `run-as` edits of its own settings, moving
  its packs aside, and **driving the app's own UI by script** (`tools/phone/tap.ps1 -Text ...`, or
  `uiautomator dump` then `input tap` at the element's bounds, then dump again). A missing test hook is never
  a reason to skip a setting the app has. Only screenshot-guessed taps are banned.
- **Forbidden:** buying anything, clearing or uninstalling a store install (installing or updating the app under test from Play to read its logs is allowed, user 2026-11-14), every other app on the phone, settings other than stay-awake, live production
  state, and **any whole-device network cut** (Wi-Fi, mobile data, airplane mode): over wireless adb it cuts the
  link the run is driven over, so nothing can turn it back on, and a USB run may fall back to wireless. An offline check blocks only the
  app (`cmd netpolicy add restrict-background-blacklist <uid>`, undone by a device-side restore) from a
  check script that starts that restore first, or runs on an emulator. The `phone-network-guard.mjs` hook
  refuses these forms: an adb or Maestro network cut, and a typed `device_config put|override`,
  `am compat enable|disable`, `setprop`, `content insert|update` on `content://settings`, `cmd netpolicy`,
  `cmd platform_compat`, `cmd settings`, or `settings put global|secure|system` (only
  `stay_on_while_plugged_in`, which the pre-flight sets, and network-on values are excepted). It judges
  each adb invocation on its own, also inside a quoted chain: one is allowed only if that same invocation
  names an emulator serial (`emulator-NNNN`; a bare `adb shell` or a `$serial` variable is refused, so
  type the literal emulator serial). A typed command on the phone is never the allowed form: only a check
  script that starts its own device-side restore first may change device-wide state. A cut inside a script
  it calls is not seen, so the brief still says it. (2026-10-31: a check ran
  `svc wifi disable` on the test phone and left it offline.)
- **Device-wide state a check changes** (`device_config put`, `am compat enable`, `settings put global`,
  `cmd netpolicy`): allowed only for the dev install's own test, only when the check starts a device-side
  restore (a detached on-phone timer) **before** the change, and only after the same check has passed on an
  emulator. A check script that has never run on an emulator does not run on the user's phone: before its
  first phone run, grep it and what it sources for those commands, and if any appear, prove it on the
  emulator first or record it as not run. (2026-10-31: the test phone was left with a device-wide dataSync limit and
  a compat flag after a never-run check lost the link.)
- **On a broken state** (crash loop, stuck setting, lost pack): record the bug with its evidence, run the
  reset ladder (`tools/phone/reset-dev-app.ps1 -Level auto`: restore the setting, then clear data, then
  reinstall), and go on with the next item. Never report an item "not run" because an earlier one broke the app.
- The 10-minute cap per run still holds; split a long checklist across several runs on the same device in
  sequence, never in parallel.
- **The app comes from the check, not from the last build:** look each check up in the runner's catalogue
  (ReadTheStupidText `tools/phone/checks/_lib.ps1`, `$script:Catalogue`, `Apps`) and name that app's
  cached build in the brief, building it first with `run-checks.ps1 -Build -App <app>`. The night's
  first run-checks passes `-Reinstall`, so a dev install the runner did not place never SKIPs the whole run.
  (2026-10-31: a Dino check briefed with the RTST build spent its run building; two runs SKIPPED as
  `installed variant unknown`.)

## 5. A bug found is a planned slice, not work for this run

For each bug: write a **planned** slice file with the evidence (the check, steps, expected vs seen, log lines,
the device and build) and the likely cause if a device agent already named one; then go straight on with the
next check. Do not implement, review or ship the fix during the run, and do not send the devices to verify a
fix: building, reviewing and device-checking fixes happens later in the slices (run-wave or run-all-waves).
Reading code or logs to tell an app bug from a stale check is allowed only as far as it takes to write the
slice; the device keeps running checks meanwhile. Open all the planned slices in one plan PR at the end of
the run. If a check is broken itself (stale flow, wrong text), record it as a check bug in the same way and
move on. A permission prompt that blocks a check is the only thing to surface; everything else keeps going.

## 6. Keep it moving

- The 10-minute check on every background agent applies, and it reads the device (newest app log line by pid,
  `dumpsys power`/`battery`, a download file growing), not the agent's claims.
- A stuck agent gets one message, then `TaskStop` and a re-dispatch.

## 7. One report at the end

Verdict first, then each check as pass/fail with one line of evidence, bugs found and the planned slice
each one went to (with the plan PR), what didn't run and exactly why (device missing, not "blocked"), what you changed on the phone, and
the reminder to restore the screen lock. Release the lease and everything you started.

## Real Android phone rules (moved from ~/.claude/CLAUDE.md, "Real Android phone")

- The test phone is left for you to test with; the user isn't using it, so **never ask for it**. Order: (1) `adb devices` shows a USB serial: use it over USB. (2) Otherwise look for wireless: `adb mdns services`, `adb devices`, an `<ip>:<port>` (`adb connect`). (3) On neither, say so in one line; asking for the IP:port and 6-digit pairing code (*Developer options > Wireless debugging*) is the last resort.
- **Never cut the whole device's network** (Wi-Fi, data, airplane mode): over wireless adb it drops the link; over USB it doesn't, but the ban stands because the run may fall back to wireless.
- **A test run runs checks only.** Every bug found becomes a planned slice, fixed later, never during the run. A broken state is recorded, the dev install reset, and the run goes on. Briefs allow resetting the dev install, installing or updating the app under test from Google Play on the test phone and opening it to read its logs (user, 2026-11-14), and driving the app's UI by script, and in the Sonos app adding, testing and removing our own Sonos services (user, 2026-11-19); they forbid buying anything, clearing or uninstalling a store install, and every other app on the phone. When the user is leaving or asleep and hands over a device, load this skill before they go.
- **`mcp__mobile__*` tools are off limits** unless the user is explicitly testing with them (they pick the user's real phone); drive emulators with `adb -s <serial>`.
