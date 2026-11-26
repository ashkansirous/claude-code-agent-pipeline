---
name: device-test-pipeline
description: Build an app's device and desktop test pipeline the fast way from day one - Debug-only test hooks and log markers, scripted headless flows, one cached build per input hash, emulator/VM/phone limits. Load when scaffolding any app with a UI, adding a project's first emulator/VM/phone test, setting up CI path filters for a multi-app repo, or when device checks are slow, flaky or take over the screen.
---

The reference implementation is ReadTheStupidText (a public repo): `tools/emulator/`,
`tools/desktop-vm/`, `tools/phone/`, `tools/test-targets.ps1`, `.github/scripts/ship-targets.mjs`,
`.maestro/`, and the Debug hooks (`TestMarkers`, `TestHookLog`). Copy and adapt those rather than
inventing new shapes. Build these pieces in the project's **first UI slice**, not after tests get slow.
(2026-10-28: retrofitting them took a full day; a Dino-only pass went from 15-25 min to 6 min 45 s,
a rerun to about 3 min.)

## 1. The app is drivable without taps (Debug builds only)

- **Test hooks:** a Debug-only entry point (Android broadcast `<app id>-test.TEST_HOOK` and a
  `<app>-test://` URL scheme for iOS) that runs named actions: `skip-first-run`, `read text=...`,
  `open-book id= page=`, etc. Release builds don't contain it (`#if DEBUG`).
  Include a hook for every setting a check has to switch after first run (UI language, voice, translate
  on/off), not only at first run. Until one exists, flows switch it through the app's own Settings by
  uiautomator taps, never skip it. (2026-10-29: `skip-first-run lang=` was the only language switch, so
  every non-English phone check was skipped.)
- **Log markers:** one tag (e.g. `RTST-TEST`) with fixed lines a script can wait on: `HOOKS installed`,
  `HOOK <action> ok`, `READ_START`, `CHUNK n`, `READ_END`, timing lines. Every runtime branch a fix adds
  (timeout, retry, resume, fallback) gets its own Debug line (`PACKDL stall ...`), so a device run can
  prove which path ran.
- A wrong hook name must fail loudly: the script waits for `HOOK ... ok` and names the action it sent.
- **Analytics:** test and debug builds never send (`production-only-analytics`); the log says
  `not sent: DebugBuild` so a run can confirm it.
- Android and iOS get the same hooks in the same slice.

## 2. Scripted, headless, never on the user's screen

- Android: a headless x86_64 AVD (`-no-window -no-audio -no-boot-anim`), cold boot (snapshots broke
  flows), kept warm and reused. Flows are Maestro files under `.maestro/` asserting on UI text and
  log markers; each new screen in a slice adds its flow.
- Windows desktop: a headless Hyper-V VM with a `clean` checkpoint restored before every run, never the
  host desktop. Refresh the image with an update-only path (`-UpdateOnly`, minutes), never a full rebuild
  (an hour), and never delete the last good checkpoint before its replacement works.
  **One test VM per machine, shared by every repo:** before planning or building a VM, run `Get-VM`
  and reuse the one there (today `rtst-desktop-test`, under `<repo>-worktrees\_desktop-vm`,
  used by ReadTheStupidText, Dino Reader and print-the-damn-book) under its shared lock, restoring
  `clean` before and after. With no VM on the machine, ask before building one; a second VM only when
  the user asks for one. (2026-11-01, print-the-damn-book:
  a plan said "own VM, never touch the shared one", nobody had asked, and the user was asked where to
  put a VM that should never have existed.)
- Real phone: USB if `adb devices` shows it, else wireless adb; never asked for; the dev build installs as a separate package (`<app id>.dbg`) beside
  the store install, never over it.
- Logic checks are unit tests, not device steps.

## 3. Test only what the change touches

- One script maps changed paths to targets for CI (path filters) and has a `--local` mode that diffs the
  worktree (committed, uncommitted, untracked; `git -z`, run in the repo root, never the caller's cwd)
  against the merge base. `test-targets` turns that into device runs (`app-android`, `app-windows`, ...).
- Fail safe: anything it can't place, or any error, means **test more**, never fewer. "No app touched"
  prints as a skip, never a pass. A caller may add an app, never silently drop one.
- Device scripts take `-App auto` and print what they skip and why.

## 4. Build once per input, reuse everywhere

- Build key = hash of the build inputs (`src/`, root build files, props/targets, global.json, .editorconfig,
  the solution), plus ABI/RID, configuration and AOT in the cache name, so an emulator x86_64 APK never
  reaches a phone and vice versa.
- Outputs go to `<worktrees>/_builds/<app>-<platform>-<variant>-<key>/`; a temp folder renamed into place;
  a per-key and per-checkout build lock; the key recomputed after the lock; prune per exact prefix (keep the
  newest few) and stale `*.building-*` folders. `-Rebuild` forces a build.
- Builds run at BelowNormal priority and **outside** the device locks: an agent holds a device only to
  install and test. (At 100% CPU a parallel build made the emulator's System UI stop responding.)
- Keeping .NET build servers bought nothing measurable; keep `--disable-build-servers` in worktrees.
- **Nobody remembers to build the store-like variant, so the runner builds every variant itself, in
  parallel** (for .NET mobile: plain Debug and Debug with AOT). Each variant gets its own
  `--artifacts-path` (short folder names: Android's aapt2 hits the path limit) and its own lock, so two
  builds of one checkout never share `obj/`. Checks start on whichever build is ready first, preferring
  the store-like one; a check that needs it (cold start, any timing) declares that, waits for it saying
  what it waits for, and fails with the build's last log lines if it fails or stalls, never skips or falls
  back. At most one variant swap per run. Every build and check writes a status file updated every 30 s,
  so the coordinator's 10-minute check sees a failed or stuck build. (2026-10-30, ReadTheStupidText
  Slice 213: Debug 2:49 and AOT 4:58 side by side, about 5 min total, against 1-2 plus 6-7 one after the
  other; a run that needed AOT nobody had built took 20 minutes for one check of four.)

## 5. Parallel devices with measured, enforced limits

- Emulator scripts take `-Instance 1|2|any`; each instance has its own AVD, port, state file, lock,
  Maestro home (`-Duser.home`) and output folder; a second AVD is scripted (config copy, not a disk copy).
- An activity registry enforces what the machine can carry, measured on it (on a 16-thread, 32 GB laptop:
  one emulator plus the VM, or two emulators without the VM). Waits print what they wait for.
  Default to **one emulator running flows at a time**; a second is opt-in, only where it was measured
  not to starve the machine. (2026-10-30: two emulators running flows overloaded the PC.)
- **Every device gets a lease, not just a start/stop lock:** emulator, phone and VM. A flow or timing
  script takes the device's lease for its whole run (owner, pid, expiry in a file, under a mutex) and
  waits while another holds it, printing who. One lease implementation, keyed by device kind and serial.
  (2026-10-30: two agents ran flows on one emulator, and one's `clearState` wiped the other's data.)
- **A flow lint that needs no device**, run first by the flow runner, in CI and as a fast check: every
  command is in the tool's command list, string escapes are valid, and a state-wiping command
  (`clearState`) carries a comment saying what it wipes and why that's fine. (2026-10-30: an unknown
  command, a bad YAML escape and a `clearState` that wiped the voice pack each cost a device run.)
- **A preflight for every device**, not only the phone: before a run, check network, the packs the
  check declares it needs (`# needs: network, voice-pack`), and the dev install; NO-GO within a
  minute instead of a useless run.
- The touched-targets script also prints the **fast-check commands** for the change (a build per
  touched app, a test run per reached test project), so shared code is never checked for one app only.
- Android and Windows checks of one change run as two agents at once.
- Timing runs take an exclusive quiet-machine lock (no emulator, VM or build running).
- Flows detect and clear an "isn't responding" dialog before and after, or fail naming it.
- **A CI device job has a time budget sized from its flows, written in the workflow before the first run:** a per-flow
  kill limit, plus a job `timeout-minutes` of (flow count x measured flow time) + build + boot, with margin. Work with
  different budgets (store screenshots and preview recordings, phone and tablet) goes in separate jobs, never one job
  whose first part can use up the time of the rest. Each job writes what it finished as it goes, so a rerun resumes
  only the missing items. (2026-11-24, ReadTheStupidText Slice 433: shots and clips shared one job; the shots used the
  budget and no clip was recorded.)
- **A device job fails fast, not only at its time limit:** when the first 2 flows it really attempts (kept results
  from a resumed run don't count) have all failed, with their retries, and none succeeded, the job stops that device at
  once with one error line naming why, and skips the rest. A time budget caps the cost of a slow device; only fail fast
  caps the cost of a broken one. (2026-11-24, ReadTheStupidText Slice 433: the iPad failed every shot at the same
  first step and spent most of an hour per run, twice, for 0 shots.)
- **Flows that run in a sequence reset what an earlier flow changed** (language, account, open book) in their own
  setup, by a test hook, never by trusting a launch argument; find elements by id, not by text in one language. Run the
  whole sequence once in order before calling a flow set working. (2026-11-24, Slice 433: the Spanish clip left the app
  in Spanish and the next two clips waited for an English title; cause likely, being confirmed.)

## 6. Never wait in silence

- Every wait prints what it waits for and has a limit: first app log line within 60 s, a download file not
  growing for 2 min, no new app log line for 2 min, every adb call with a timeout. Fail with the last line seen.
- **One fresh app process per run.** Before every run (each rate, each rerun, with or without a skip-install
  flag) force-stop the dev package only, clear logcat, launch, and read only the new pid's lines. Two pids in
  one run is a failure that names both. (2026-10-28: a rerun's hooks went to the previous run's process,
  still reading, and the timing table showed negative times.)
- Real phone: print charge and wake state first; on battery keep it awake (`KEYCODE_WAKEUP` every 15 s) and
  ask for a charger, because Doze freezes the app. Anything that uses the network needs the phone unlocked
  once with the dev app in the foreground: behind a PIN lock screen Android blocks a background app's network.
- Self-test scripts (`tools/**/test-*.ps1` in the reference repo) fail with `if ($failed) { exit 1 }` and end with an explicit `exit 0` as the last line, after that check: CI runs
  `pwsh -command ". 'file'"`, which leaks the last native exit code, while `-File` locally hides it.
- Scripts run from `pwsh -NoProfile -File`; keep them Windows PowerShell 5.1-safe too (no
  `ProcessStartInfo.ArgumentList`).
- **The phone harness ships four helpers with its first script**, so an unattended run never improvises
  (ReadTheStupidText Slice 206, `tools/phone/`): `preflight` (adb, charging, screen lock None or Swipe,
  stay-awake, space, dev install; last line GO or NO-GO), `lease` (one owner per device, expiring file
  lock; every harness script checks it), `tap` (uiautomator dump, find by text/id/desc, tap the bounds'
  centre, dump again; `-List`), and `reset-dev-app` (a ladder that touches only the dev package: restore
  the setting, then clear data with packs moved aside and back, then reinstall from the build cache).
  Unattended runs themselves follow `unattended-device-run`. (2026-10-29: each agent of a test-phone night
  improvised these, and one deleted a voice pack.)

## 7. Record the numbers

Each pipeline change records wall-clock times against targets in its slice file (cold pass, cache-hit
rerun, two-device run). Targets to start from: a single-app cold pass under 10 min, a rerun with no build
step, the VM restoring `clean` with a cached package.

**Clips are judged with the helper `media-review.mjs` in this folder** (a review agent of your own can drive it): when the picture really
changes, what moves, and whether the cut window contains it. Never by file count or the first seconds. (2026-11-25,
ReadTheStupidText: a page turn at 194 s was reported as "never turns".)

## 8. iOS simulator in CI (Maestro)

- **Hierarchy checks hang while the app animates** (XCTest waits for idle). Fix: with the simulator shut down, write
  `ReduceMotionEnabled=1` into `data/Library/Preferences/com.apple.Accessibility.plist` with PlistBuddy, reboot, read
  back with `xcrun simctl spawn <udid> defaults read com.apple.Accessibility ReduceMotionEnabled`.
- **`swipe` reports COMPLETED but moves nothing** on iOS 27.2 / Maestro 2.12.0. Fix: drive motion through the app's
  own Debug test-link hooks (section 1).
- **A custom URL scheme raises an "Open in <app>?" alert.** Fix: pre-approve the scheme in the simulator before boot,
  then keep the Open-in wait short.
- **iPad landscape screenshots come out as a portrait buffer.** Fix: rotate only when the app's own log says it laid
  out landscape.
- **`simctl io recordVideo` has no sound and writes frames only when the screen changes** (variable frame rate).
- **Maestro takes 30-200 s from `recordVideo` start to the flow's first step**, varying per run. Fix: cut each clip
  from a mark taken from Maestro's own output, never a fixed lead-in.
- **Print the app's test-hook lines after passing attempts too**, so a pass can be told from a lucky one.
- `launchApp` can hang: every flow runs under a time limit and the job fails fast (section 5, the bullets on the CI time
  budget and fail fast).
