---
name: production-only-analytics
description: Make sure analytics, usage counts, telemetry, crash or performance reporting only record real users of a production build, never tests, CI, emulators, store test robots (Play pre-launch, Firebase Test Lab), automated browsers, dev builds or staging. Load when changing analytics/telemetry/crash code or its endpoint, writing tests or CI that run such an app, reviewing such a diff, or reading analytics data; also "counts for a version I haven't released", "exclude test devices from analytics", "audit analytics for test traffic".
---

# Production-only analytics

**The rule (every project, no exceptions):** analytics record only real people using a
production build. Nothing a test, a pipeline, a robot or a developer does may ever reach
the production analytics store. A count from a test is not "noise to filter later": it
skews every decision made from the data, and most analytics stores (Cloudflare Analytics
Engine, GA4, App Store/Play vitals) cannot delete rows.

**Why:** 2026-10-27, ReadTheStupidText: on the first day of usage counts, every row in
`dino_usage` and `rtst_usage` came from Google Play's pre-launch robot (US, x64
emulators, versions not yet rolled out) and our own emulator device tests (version
`1.0`, unstamped local builds). Zero real users, and nothing in the apps stopped it.

## What counts as "not production" - exclude every one

| Source | How the app or server tells |
| --- | --- |
| Debug / development builds | compile-time flag (`#if DEBUG`, `import.meta.env.DEV`, `__DEV__`, `NODE_ENV !== 'production'`) |
| Local or unstamped builds | version is the project's default (`1.0`, `0.0.0`, `dev`) because only CI stamps the real one; or a build-time `IS_RELEASE`/channel constant CI sets |
| Emulators and simulators | MAUI `DeviceInfo.DeviceType == DeviceType.Virtual`; Android `Build.FINGERPRINT`/`Build.HARDWARE` (`goldfish`, `ranchu`); iOS `#if targetEnvironment(simulator)` |
| Store test robots | Android: system setting `firebase.test.lab` == `"true"` (Play pre-launch report and Firebase Test Lab); confirm the current check in Google's docs |
| CI and build pipelines | env `CI=true`, `GITHUB_ACTIONS`, `TF_BUILD`, etc. at build *and* at run time; CI jobs build with analytics compiled out or pointed at nothing |
| Automated browsers (Playwright, Selenium, Puppeteer) | `navigator.webdriver === true` in the page; tests also block the analytics host with `page.route(..., r => r.abort())` |
| Unit / integration tests | the analytics sender is an interface; tests inject a fake; no test constructs the real HTTP sender |
| Staging, preview and localhost hosts | client: send only when the page's host is the production host; server: a non-production deployment has no binding/key for the production dataset |
| Internal testers (TestFlight, Play internal track, staff) | real people, but not users: say explicitly in the plan whether they count. If not, tag or skip by version/channel, since the device often can't tell |

## How to build it

1. **One pure decision, unit-tested.** A function takes the facts (is debug, version,
   is virtual device, is test lab, is CI, is webdriver, host) and returns counted / not
   counted plus a reason enum. Each platform gathers the facts once at start; one gate
   in the shared sender applies it. Android and iOS get the same gate in the same slice.
2. **Errors never turn sending on.** Any fact that says "test" wins over the others. A
   fact whose absence is normal on real devices (the Test Lab setting is missing on
   every real phone) reads as "not a test" when missing; an exception in the gate
   itself means not counted.
3. **Dry run, not silence.** In a test build the sender still builds the batch and writes
   it to the debug log, marked `not sent: <reason>`, so device tests can check the
   payload without anything leaving the device.
4. **Server side too.** The endpoint drops what it can recognise (a request with no
   production version, a known test user agent) and non-production deployments have no
   production binding. The client gate is the main line; the server is the backstop.
5. **Privacy text** may say test and development builds send nothing; keep it true.
6. **Rows already stored:** reports and dashboards filter known test rows (default
   version, emulator architecture, pre-release versions) and say so in their header.

## Tests, device tests and CI must never send

- Device and desktop tests run builds the app already excludes (debug, unstamped,
  emulator). If the app under test has no exclusion yet, the test must not run with
  analytics on: say so in the report as a finding, and never flip a live remote switch
  to make a test pass.
- E2E browser tests block the analytics endpoint at the network layer, even when the
  app also checks `navigator.webdriver`.
- CI workflows never hold production analytics keys; a pipeline that needs a key for a
  build step uses a separate non-production one.

## Audit mode (an existing repo)

(To answer a question from the data rather than audit it, query the analytics store's read API directly.)

Asked to audit, or before relying on a repo's analytics:

1. Find every place analytics are recorded or sent (grep for the SDK, the endpoint path,
   `track`, `logEvent`, `writeDataPoint`, usage/telemetry classes).
2. For each source in the table, say **excluded** (file:line), **not excluded**, or
   **not applicable**.
3. If a read-only analytics credential is available (kept outside the repo), query
   the last few days and report how many rows look like tests (default version, emulator
   architecture, versions newer than the live store release, CI/test countries) - with
   the evidence, and say plainly which rows are inference rather than proof.
4. Report the gaps as a short numbered list; fixing them is a planned slice, not part of
   the audit.

## Review checklist (code-review agents)

A diff that adds or changes analytics recording or sending is a finding unless it either
keeps every source in the table excluded, or names the ones it deliberately keeps (e.g.
internal testers) in the slice file.

## Rules moved from ~/.claude/CLAUDE.md

Analytics, usage counts, telemetry and crash reporting record only real people on a production build: never tests, CI, emulators, store test robots, automated browsers, debug or local builds, or staging. Stored rows are filtered in reports, never trusted. "What do the logs say" means what the apps already send (`analytics-query`, crash store), never reading the user's device.
