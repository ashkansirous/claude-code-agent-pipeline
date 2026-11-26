---
name: run-all-waves
description: Run wave after wave in one repo until no planned slice is left, unattended (overnight) - each wave a fresh headless session plus a housekeeping session, then one plan cleanup and one feedback loop at the end. Use on "run all waves", "run until everything is done", "build everything overnight", "nightly orchestrator", "loop run-wave until no slices are left", or /run-all-waves. Its wave and housekeeping modes are run by run-all-waves.ps1, not by hand.
---

The user starts this in a repo session and leaves. The loop runs until `plan.md` has no
`planned` row. `/feedback-loop` runs once, at the end of all waves, over every wave and
housekeeping session of the run. (User, 2026-11-01: per-round loops took 4.5 of 11 hours; one loop at the end.) A `/plan-cleanup all` session runs once just before it, after the live checks, only when the waves ended normally (no planned slice left, or the no-progress stop); an error, disk-low, fast-failure or stop-file end skips it and the driver log says why (user, 2026-11-25). Its PR branch follows the skill (`chore/plan-cleanup-<yyyymmdd-hhmm>`) and does not count as slice progress. The rules from `run-wave`,
`unattended-device-run`, `feedback-loop` and `~/.claude/CLAUDE.md` all still apply; this skill
only adds the loop and what changes when nobody can answer.

**Why fresh sessions:** a session cannot `/compact` itself (no tool, hook or skill triggers it), and
one session over many waves ran out of context twice (2026-10-29, 2026-10-30). So
`run-all-waves.ps1` starts every wave and every housekeeping pass as a new `claude -p` session;
the wave ledger, the slice files and `plan.md` on `origin/main` carry everything the next one needs.
What they don't carry (the mistakes, retries and leftovers) is read by the one feedback loop at the end.

Pick the mode from the arguments: none → **Start**; `wave <n> ...` → **Wave**;
`housekeeping <n> ...` → **Housekeeping**.

## Start (interactive, before the user leaves)

Everything that needs the user happens now, in one batch, because nothing after it can ask.

1. Do this Start mode with the user while they are present. **When the user's message asked to run** ("do /run-all-waves", "if nothing is missing, run all waves", "start the night run"), launch the driver as soon as steps 2-4 are done and their answers are merged: that message is the go, conditional or not, and the user never has to say "leaving" or ask again (2026-11-07: a conditional run request was held 66 minutes behind a "tell me when you're leaving" question; 2026-11-06: 1.5 h lost the same way). Wait for "leaving or going to sleep" only when the user asked for the preparation alone. The run is unattended, and the driver's feedback loop waits for this session's own subagents. If they want to watch and keep working, use `run-wave` from this session instead and say so. The driver starts hidden (its console is created with ShowWindow 0); tell the user at launch that it should open no window, and that this is proven only for a simple child process so far (`docs/plan/unverified.md`, Slice 17), so a window that does open is a bug to report. Launch with `start-detached.ps1` from this interactive session: pass this session's own id (`-StarterSessionId $env:CLAUDE_CODE_SESSION_ID`, exported in the shell tool; that is PowerShell syntax, so from the Bash tool pass the id itself, `-StarterSessionId "$CLAUDE_CODE_SESSION_ID"`; a value that is not letters, digits, `-` and `_` is ignored with a warning); it is recorded and handed to the driver as `-StarterSessionId`. Without it the script takes the newest interactive record of the repo's Claude projects folder and skips `claude -p` records (`"entrypoint":"sdk-cli"`), since a probe run minutes earlier otherwise becomes the starter (night 2026-11-16-2043).
2. Check the repo: run `node ~/.claude/skills/run-all-waves/remaining-slices.mjs <repo>` after a
   `git fetch`. It prints the `planned` rows of `plan.md` on `origin/main`. None: say so and stop.
   **A run covers one repo's plan, and the start says which.** `<repo>` is the repo whose plan this run builds.
   When the session has other repos as working directories (a `CLAUDE.local.md` or `--add-dir` names them), or
   the work it planned spans another repo, run the same command for each of them too and tell the user, before
   the launch and in the step 7 lines: which repo this run covers, and for every other repo its `planned` rows by
   number and title with "not in this run". Never give "the other repo waits on this one" as the reason unless
   every one of its planned rows does; a row that waits on nothing gets its own run started right after this
   launch (a second `start-detached.ps1` for that repo), or the user is told plainly that it will not run.
   (2026-11-16: a run started from the board repo covered only the board's plan; the config repo's Slice 06
   waited on nothing, nobody said it would not run, and the user asked hours later why it was not built.)
   **One night run per host at a time.** Before a second `start-detached.ps1`, read the other repo's newest
   night `status.json` (`current` not `done`/`stopped` and its driver pid alive) and free memory: while another run
   is live, start the second run only after it ends (say so in the step 7 lines with the expected order), never
   both at once (2026-11-18: the board and config runs ran together, the check timer was killed twice for low
   memory and the config run's suites took over an hour, so it merged nothing until 22:12; board note
   2026-11-19-0441).
3. One `ground-in-code` agent (model pinned) reads every planned slice file and lists, per slice:
   decisions the slice leaves to the user, outward-facing steps (store, console, live data; never a deploy: the pipeline deploys and a skipped run is started through the pipeline,
   their login), and the devices its checks need (emulator, Windows VM, the user's phone, iPhone,
   a human ear). Headless wave sessions have no Artifact tool, so a slice whose work is a listening page or
   any other Artifact page (`voice-pick`) cannot run at night: this Start session runs those itself (before or
   while the night runs) or tells the user they wait for an interactive session; never launch a night whose
   planned rows are mostly such slices without saying so (2026-11-08, night 2026-11-08-1703: 14 of 16 planned
   slices were listening pages, wave 1 parked all 14 while this session was already publishing them). Before
   publishing any listening page the agent also lists, per such slice, whether each question is **already
   answered** (the slice file's *Decisions (user, <date>)*, an earlier page's answers) or **measurable** by a
   tool (silence, clipping, length, loudness: ffmpeg); those go on no page (`voice-pick` step 0; the pages for
   Slices 334 and 335 came back after the user had answered them, Slice 393 item 6). Also
   list every `in progress` or claimed row (a draft PR, a worktree) and check its owner is alive (a transcript
   or commit in the last 30 minutes) before treating it as busy; a dead claim is taken over or set back to
   `planned` in the step 4 docs PR (2026-11-08: Slices 320-322 sat behind a draft claim of a session that had
   died at 15:49, and Slice 325 parts A and C were held behind them for about 2 h 45). Check each outward step against live state first.
   **Collect every owner step of the planned slices now** (a variable to set, a console click, a label): list each as
   `**You:** <short action> | <steps with the direct link>` in the same batch, so the owner is asked for them when the
   build is requested and never in the middle of the night's work (owner, 2026-11-18: the owner asked that such steps be named when the build is requested; Slice 29 item 9).
4. Ask the user everything from step 3 in **one** batch. Each question first says in lay words the
   situation, what it affects and what each option does, and drops any premise the user already
   removed (2026-11-05: a question about a dropped slice, asked with no explanation, had to be re-asked). Write every answer into the slice's file
   the same turn (docs PR via `update-docs` + `ship-branch`, merged), so the wave sessions read it.
   A slice whose question stays unanswered will be parked by the wave that meets it.
   A question that blocks only some slices (or another repo's run) never holds the launch: once the
   batch is asked, launch the driver for the slices with no open question at once; an answer that comes
   later is written into its slice file and the next wave picks it up (2026-11-18, print-the-damn-book:
   Slice 23 had no open question, yet the night waited 40 minutes on an answer about Slice 24 and another repo).
   In the same batch, list each action a slice's build or checks need that auto mode denies at night
   (a run against a VM, phone or console other repos share, a settings change; never a production deploy,
   which only the build and release pipeline does, so it is never an allow line to ask for) and
   ask the user to add the allow line (an `autoMode.environment` entry or an allow rule; you cannot add
   it yourself, it is classed as self-modification) before the start. Read each candidate against the
   `autoMode` lists in `~/.claude/settings.json`; anything that touches state other repos or people share
   and isn't named there counts as denied. A credential that **can** do it is not a permission to do it:
   creating a cloud resource (`wrangler d1 create`, `d1 execute --remote`), writing a secret
   (`wrangler secret put`, `gh secret set`) count as denied unless named there,
   however wide the login's scopes; never tell the user "nothing waits on you" for such a step (2026-11-08:
   "my Cloudflare login can create the database and set the secret" was said from `wrangler whoami`
   scopes, then the night denied both and Slice 287's setup waited). Before saying a credential is
   **missing**, check the CLI's own login too (`wrangler whoami`, `gh auth status`), not only the
   secrets store (2026-11-08: the owner pointed out that stored Cloudflare tokens already existed). Write the answer into the slice file with the others.
   The exact line to paste goes **at the top of the final message of the turn**, with the file opened at
   its place (`code -g <file>:<line>`), never in text between tool calls, which the user does not see
   (2026-11-01, night 2026-11-01-2355: the user asked twice for the line before going to sleep).
   (2026-11-01, print-the-damn-book:
   Slice 21's first run on the shared test VM was denied as Modify Shared Resources and the slice parked,
   with the user at the desk the whole time.)
   Run every *Not yet verified* check a `device-test` agent can run (host desktop, emulator, the shared
   VM) before the batch, in one scripted run per device under the usual 10-minute cap (what doesn't fit
   stays in `unverified.md` for the night, not a question); only what needs paper, a human, an account or a device you don't have is a
   question. (2026-11-01: 11 runnable checks were listed as "waiting on you"; the user asked that they be tried.)
   A device-test brief states only approvals the user actually gave in this session, quoted; it never writes
   "the user approved host windows" from the skill's own instruction (2026-11-18, print-the-damn-book: a brief
   claimed an approval the user never gave).
   Write each run's results into `unverified.md` (passes removed, failures named) in a docs PR merged
   as soon as that run reports, never batched to "after the other run". A start that resumes after a
   crash or machine restart first digests the earlier interactive session's tail
   (`node ~/.claude/skills/feedback-loop/transcript-digest.mjs <earlier.jsonl>`, last 30 entries) and
   finishes the step it cut, instead of inferring from folders what happened. (2026-11-05,
   ReadTheStupidText: a restart cut the session while it wrote both pre-night runs' results; the
   restarted session said the emulator run "never finished", but it had reported at 16:35, and
   neither run's results reached the plan until the night's feedback loop.)
5. If any slice needs the phone, run the `unattended-device-run` pre-flight (step 2 there:
   connected (USB first, else wireless), charging, screen lock None or Swipe) and fix what it finds with the user now.
6. (Waiting in this session: the harness refuses a foreground `sleep N && ...`; wait with a background
   `sleep 600` timer or a Monitor until-loop, never a foreground sleep. 2026-11-01: refused three times.)
   **Never ask which permission mode to use.** The night sessions run in the mode of this session, the
   thread the user started `/run-all-waves` from: pass it as `-PermissionMode` (a system reminder saying
   auto mode is active means `-PermissionMode auto`). If this session's mode can't be read, pass `auto`.
   (User, 2026-11-05: the owner decides the permission mode on the thread and expects the run to use it, after every start since the skill was written had asked.) The driver adds
   `--add-dir` for `<repo>-worktrees` and the AgentPipeline repo, so worktree edits are inside the allowed
   directories. Then start the driver **detached**, never as this session's background command:

   ```
   pwsh -NoProfile -File ~/.claude/skills/run-all-waves/start-detached.ps1 -Repo <repo> [-PermissionMode <mode>] [-Model <model>]
   ```

   From the Bash tool write the repo path with forward slashes (`-Repo D:/my-app`) or quote it:
   an unquoted `D:\my-app` loses its backslash and the launch fails (2026-11-01, the first start).

   It creates `run-all-waves.ps1` through WMI, so no Claude Code session owns it, and prints its pid
   and `driver-<time>.log` (stdout; the driver's own trace is `driver-<night>.trace.log`). A driver started with `run_in_background` is this session's child: when
   memory ran low, Claude Code killed this session's background commands, and the driver and its wave
   session died with them (2026-10-30, 23:35; four slices left half built).

   Before launching, if step 5 ran, write `<repo>-worktrees/run-all-waves/preflight.md`: the time,
   the phone's serial and the result. The driver moves it into the night folder
   (`<repo>-worktrees/run-all-waves/<yyyy-MM-dd-HHmm>/`), so the waves know the phone may be used.
   No file means no phone tonight.
7. Tell the user, in three lines, starting with this exact template: "Run started: N planned slices in total,
   at most 4 per wave, so about ceil(N/4) rounds. Waves run in separate headless sessions, so their subagents
   do not show in this chat. I check every 10 minutes." A chain of slices that each need the one before (their
   Decisions or `parallel-check` CONFLICT say so) counts one round per slice in N's estimate, never ceil(N/4)
   (board night 2026-11-25-1729: "about 3 rounds" for a chain of five that took 6). Never relay a notification that needs no action (an old
   agent's timer ending) as a status line. The three lines: the log folder, how to stop it (create
   `<repo>-worktrees/run-all-waves/run-all-waves.stop`; the current round's housekeeping and
   the feedback loop still run), and that every permission prompt is auto-denied
   (`--permission-prompts none`), so a denied step parks its slice instead of waiting.
   Never state what a wave will build, or in what order, before the wave session has written it
   (wave ledger, `wave-*-notes.md`): say "the wave decides" or "recommended: ...", and correct it
   in the next check if the wave chose otherwise (2026-11-01: the user was told "17, then 18, then
   19"; the wave ran them in parallel).
8. **The 10-minute check** (`~/.claude/CLAUDE.md`, *Background agents get a 10-minute check*):
   run `node ~/.claude/skills/run-wave/board.mjs usage-tick --force` once (token usage to the board, Slice 11 part A; fails
   open, exit 0, never wait on it), then read `status.json` (current session, its id, `killedIdle` flags, `stopReason`) and report it. The
   driver owns the watchdog: every 10 minutes it looks at the session's transcript, log, process
   tree (CPU) and live child processes (a `gh --watch`, adb, build or device script counts as activity;
   a plain `sleep`/`timeout` does not), and after three idle checks in a row (30 minutes) it kills that session's process tree,
   marks it `killedIdle` and goes on; the next housekeeping session closes the open ledger wave and
   parks the unmerged claims. Wave, housekeeping and plan-cleanup sessions have no wall-clock cap (only the idle watchdog); the final feedback-loop session
   is killed after 30 minutes (`killedTimeout`: counted as failed, its sessions stay unaudited and are carried to the next night).
   `skippedFeedbackLoop` means the loop never started because the starter session still had subagents running after the wait
   ceiling; the sessions stay unaudited. While the driver waits for the starter, `status.json` shows `current: waiting-for-main-session`
   and `waitingForMain` (since-time, pending agent descriptions). While any session runs, the driver also checks the starter's
   transcript at every watchdog tick (`starter-silent.mjs`, read-only, only the tail of the transcript recorded as `starterSessionId`,
   never another transcript): no assistant entry for over 25 minutes (`-StarterSilentMinutes`)
   sets `starterSilentSince` in `status.json` (cleared when the starter speaks again; a failed check keeps the old value); it never kills anything. A starter turn ended
   by an API error looks exactly like this, so on reading it the starter session answers the user at once. A starter that is only
   waiting on a long timer or tool call can also trip it: on reading it, check the starter's own live timer and subagents first.
   **The starter takes over parked in-scope work as soon as a wave or housekeeping parks it** (a slice parked for a fixable reason,
   a leftover item inside the literal ask): it takes it over at once, without waiting for the end of the run, through the usual agents and gate: `implement-slice` or
   `fix-review-findings` in a worktree, then the full review gate, staying inside the slice file's lines (never wider than the literal ask)
   (Slice 377 item 6: 375 was parked at 09:56 and the starter took 55 more minutes to pick it up). If the user has come back, one line per check;
   if not, say nothing until the end. If `status.json` itself stops updating while the driver's pid
   (in it) is alive and no session is running, tell the user.
   **A test that fails twice is read in that check**: when a wave's log or ledger shows the same test file failing
   twice by name, or a suite summary `incomplete` twice, the starter reads that test and its failing lines in the
   same check and says whether it is the code or the host, never "busy machine" before reading it and never
   "for the end-of-run feedback loop" (2026-11-18: a real race in a config-repo test was guessed as load and
   found 3 hours later; board note 2026-11-19-0441). Before saying no slice owns a failing test, grep the open
   slice files and the diffs of the open PRs for its path (`gh pr diff <n> --name-only`) (board night
   2026-11-25-1729: the starter said a `usageTools.test.ts` failure was in no slice while Slice 49's open PR fixed it).
   **A timer the harness kills (low memory) is re-armed in the same turn**, whatever the harness notice
   says about not starting it again: the user's go for the run covers its checks. Never end the turn with
   no live timer while the driver's pid is alive (2026-11-01: the 12:15 timer was killed, the turn ended on
   "say keep checking and I'll restart it", and nobody checked for 3 h 20 min until the user asked).
   When the timer is killed a second time in one run, stop using a background `sleep`: schedule the check
   with `CronCreate` (`*/10 * * * *`, recurring, a prompt that names the night folder and says to delete the
   job when the driver has ended). It is not a background command, so the low-memory stop does not reach it;
   tell the user it lives only as long as the session, and `CronDelete` it in step 9 (2026-11-16: the timer was
   killed three times in 90 minutes while free memory fell to 0.4 GB).
   **Only the session that ran `start-detached.ps1` supervises the run.** Another interactive session
   asked about it reads `status.json` and the night folder, answers, and says which session owns the run;
   it arms no timers and never says it started or stopped watching the run (2026-11-01: a second session
   apologised for "stopping its timers" on a run it never started, and that wrong cause went into memory).
   Each check also reads the night folder's files changed since the last check (`preflight.md`,
   `wave-*-notes.md`, `wave-*.md`, `parked.md`): a device incident written there (phone offline, a setting
   left changed, NO-GO) goes to the user in that check's line, and a user question about a device is
   answered from those files and the device itself, never from a guess. (2026-10-31: the phone went
   offline at 13:57 and preflight.md said so at 14:05; three checks reported only PRs, and the user
   found it on their own at 14:29.)
   A message the user sends while you work ("why is wave 1 taking so long") is answered in the next
   line with its cause, read from the night folder and the session's log, never skipped (2026-11-01: that
   question got no answer). Before handing an outward step to the user, try the tools meant for it
   (the Chrome tools, the repo's own scripts). A permission block is never routed around: once a step is
   blocked, stop and tell the user it was
   blocked and which allow rule would permit it, never a click path for them (2026-11-01: the Reporting
   API Enable click was handed over before Chrome was tried).
   In these lines, name a slice by number and plain title; never put a status word (paused, held, parked,
   blocked) in a slice's shorthand, which the user reads as its state (2026-11-01: "233 (paused notice)"
   made the user ask why 233 was paused). Before putting any console or store step to the user mid-run,
   read its live state first (read-only, Chrome tools or CLI), never from a plan or slice sentence; report
   it as done when it is (2026-11-01: a "submit the Play Data safety change" step was handed over for
   a change both apps had already published).
   **Before asking the owner about Chrome** (the Chrome tools hung or time out; Slice 29 item 32: seven hangs, and the owner was asked each time),
   read the local state first and put it in the ask: `list_connected_browsers` first; whether `chrome.exe` runs and answers (`Get-Process chrome`
   and one tool call), free memory (`Get-CimInstance Win32_OperatingSystem`); the extension's "Site access" setting in the Chrome profile's
   `Preferences`; a second known site (`example.com`) tried before blaming the first (in 2026-11-19's board night it hung the same way, so the fault
   was the extension's link to the browser, not the domain). The other route is tried before any ask: the Playwright MCP, or an Access service token
   from the secrets store. A cause read from one source (an unauthenticated `curl`) is written as "likely". An ask that remains says what was tried
   and what the owner would see (never "bring the Chrome window up"), and links `chrome://extensions/?id=<the extension id>`.
   **The driver died** (its pid is gone and `status.json` has no `stopReason`, or a notice says it was
   killed): first check that no `claude` process with its last session's id is alive (an orphaned wave
   session would run twice), and stop one if it is. Copy the dead night's `preflight.md` back to
   `<repo>-worktrees/run-all-waves/` and its `parked.md` lines into a `parked.md` there (the driver moves
   both into the new night folder). Then start it again with `start-detached.ps1`, same arguments, and
   tell the user afterwards in one line. One restart per death: a driver that dies again within 10
   minutes of a restart is reported, not restarted. The user's go for the run covers the restart, whatever a harness notice says
   about asking first; never end the turn waiting for them (2026-10-31: the run sat dead until the user
   came back). Its first wave resumes the open ledger wave (below).
   The restarted driver reads the most recent earlier night folder's `status.json`; if that night's final
   loop did not finish, its sessions that are not in `audited` become `carriedUnaudited` (id + night folder)
   in the new `status.json`. The final feedback-loop prompt names them with their night
   folder, and they move to `audited` once a loop exits 0, so a killed wave session is still audited.
   Two files per launch: the
   launcher's stdout/stderr go to `driver-<time>.log` (`cmd >>` holds it open, so the driver cannot write there), and
   the driver appends timestamped lines to its own `driver-<night>.trace.log` at start, at each session start and end
   (label, id, exit code), on stop, and in its `finally` block (with the exception message), so a death leaves a trace.
9. When the driver exits, read `status.json` and every `wave-*.md` / `housekeeping-*.md` report in
   the night folder (a `liveChecks` entry whose `chromeConfig` is `missing` or `not-ignored` gets one line: `.claude/live-checks.local.json` is missing or not gitignored, so no Chrome checks ran), and reply: waves run, slices merged, slices parked and why, what waits on the
   user, the feedback-loop note link, and `released: ...`. Every count
   equals the list printed next to it (2026-10-31: "10 slices", then 11 listed). When a note
   found that something this session told the user earlier was wrong (a guard "refuses", a restore
   "undoes" ...), say so in this reply, in one line each: the claim and what is true.
   Each `**You:**` step carries its link inline (an http(s) URL in the line itself, never "the link is in my message
   above"): build each with `checkin-line.mjs --you-line "<step with its link>"`, which refuses one with no URL (night
   2026-11-17-1657: the owner could not find the referenced message; Slice 18). It also refuses a `<placeholder>` or a bare domain instead of the real
   link (`--public-repo yes` keeps a placeholder for a public repo's file, and the report to the owner resolves it from private
   memory or config; Slice 22). Claims about visible windows ("your board window should be gone now") are read, never
   assumed: quote the `Get-VisibleConsoleWindowCount` line `start-detached.ps1` prints. Every status read of two runs is
   labelled with its repo.

**A wave report never writes "nothing waits on you" from memory.** Fetch `origin/main` and copy the *Waiting on the user* lines of `plan.md`
and the owner steps of *Outstanding work* (an open test chat, a parked slice such as 19) into the report as they stand; write "nothing
waits on you" only when that section is empty after the fetch (night 2026-11-17-1826: wave 2's report said it while an owner step and
a parked slice were open).

**A question goes to the user only if their answer changes what we do next and no one else can settle it.**
Every *Waiting on the user* item (wave and housekeeping reports, the feedback-loop note, this final reply)
names what it blocks. An obvious product choice a wave already took (keep the safer existing behaviour,
discard on Back from an unsaved edit) is recorded as a decision in the slice file, never asked. A question
about a past event that later merges or runs made moot (did an old store run also submit another app) is
dropped after checking the live state, never asked. (User, 2026-11-01: both kinds of question were unwanted.)
**Build every check-in line with `checkin-line.mjs`** (Slice 17 part E): `node ~/.claude/skills/run-all-waves/checkin-line.mjs --night <night folder> [--question "<text>"] [--user-step "<step> tried: <tool or API and why it cannot do it>"] [--you-line "<final-report step with its link>"] [--public-repo yes] [--merge-check <repo folder>]`. `--public-repo yes` (a public repo's files) lets a `You:` line use a `<placeholder>` host followed by a path (`<board address>/#/setup`); it still refuses a line with no link or "link above". Each printed line starts with `Time HH:MM | `.
It prints the real clock time it ran ("Time HH:MM") and the night's status line; copy that time into "Check at ...", never type one (Slice 22: "Check at 14:41" was typed at 14:34). It keeps the questions it printed in `<night folder>/checkin-state.json`: the third time the
same question would be printed it is refused with "record a default instead" (take the obvious choice, say what you chose, and
drop the question; night 2026-11-17-1216: "restart both runs hidden, or leave them?" was asked at about 11 check-ins in 2 hours).
When the user answers or pushes back on a question, the next reply answers it
or records the default and drops it: run it with `--user-replied "<question>"`, then `--record-answer "<question>" --answer "<text>"`;
a question the user replied to is not printed again before that. **Before a step goes on the user's list, name the tool or API you
tried and why it cannot do it** (the `tried:` field; the script refuses a user step without it): a console step is tried through
its API with a stored token first, and when only the user's signed-in browser can do it, ask once to use it
(night 2026-11-17-1216: a "create the deploy hook" step sat on the user's list for 2 hours and took
2 minutes once the user allowed the assistant to do it). `--merge-check <repo folder>` adds whether a merge without the skip-CI
marker would be denied right now (`node ~/.claude/skills/run-wave/merge-gate.mjs --explain <repo folder>`): run it before
recommending any merge shape, never recommend one it prints "denied" for.
**When the user asks "do you need anything from me" or says they are leaving,** answer from the files, never from
memory: read every *Waiting on the user* line in the slice files and every owner-only line in `docs/plan/unverified.md`
on `origin/main`, and name each step only they can do (their login, a console), with its direct link, even when it
blocks nothing tonight. "Nothing" is an answer only after that read found none. (2026-11-16, agent-progress-board: the
user was told "nothing needed" three times while a connector step only they could do was open.) **Every owner step goes on the board, not only in chat:** the moment a step only the owner can do is named (a claude.ai setting, a console click), in Start, a wave, housekeeping or step 9, write it in the same turn into the slice's block of `docs/plan/unverified.md` as a line that starts with `**You:**` followed by the step and its direct link; the doc sync shows a line as the owner's only when it starts with `**You`, so a step kept only in chat never reaches "Waiting for you" (Slice 19; night 2026-11-17-1216: two owner steps were only in chat). The rule lives in the Wave and Housekeeping sections below, which the driver's prompts load.
**Say how this repo deploys before the run starts and in every check-in.** Read it (`.claude/merge-gate.json`
`workerPaths`, the repo's workflows, a deploy hook in the secrets store): if the batched release can start nothing here,
say "wave merges will not go live until the night's batch release or a deploy hook runs" instead of
"each merge goes live" or "the driver releases". Never recommend merging a PR without the skip marker during a night:
`skills/run-wave/merge-gate.mjs` denies that while the run's `batch-release.json` is open (2026-11-17, agent-progress-board:
an owner answer to merge housekeeping without the marker could not be carried out). The routes are the deploy hook in the
secrets store or `workerPaths` in `.claude/merge-gate.json`, so the batched release starts the deploy. (2026-11-16: "each merge goes live" and "the driver releases"
were both said, and the user then asked why the new pages were not on the board). When a page or
screen goes live whose data comes from a client that is not sending yet, say so in the same sentence ("live, and empty
until <what> reports"), never "reload to see it" (same night: said for the usage page, which had no reports).
**In an unattended report, a non-blocking item is never listed as waiting on the user** (a phone setting, when to promote a release, a check the
user cannot do), and every report **re-reads live state** (PR, run, store, `gh`) just before it names an item, dropping
one that has since been done or made moot. A *Waiting on the user* line repeated after the user said not to ask counts as
a mistake of the report, not a reminder (2026-11-14: the lines at 08:29 and 10:52 repeated until the user asked what was still needed from them).

## Wave (headless, started by the driver)

Run **exactly one wave** with the `run-wave` skill, with these changes:

- **Orchestrator, no card (Slice 24):** the wave and housekeeping sessions, and the interactive coordinator, are orchestrators: each runs `node ~/.claude/skills/run-wave/board.mjs report-progress --orchestrator` once at its start (fails open) and opens no board card of its own; the slices it builds are reported on their own slice cards as step trees, and every helper brief carries `Board parent:` and `Board step:` (run-wave section 2). The driver's wave and housekeeping prompts say so.

- **Owner steps are written, not only said:** a step only the owner can do (a claude.ai setting, a console click) goes into the slice's block of `docs/plan/unverified.md` as a `**You:** <short action> | <steps with the direct link>` line in the same turn it is named (Start section, *Every owner step goes on the board*; the card reads "slice XXX: <short action> ...", so the title comes first; Slice 29 item 9).
- **No questions.** No `AskUserQuestion`, no turn ending on a question. A slice that needs a user
  decision or an outward step its file doesn't already answer is **not claimed**: add it to
  `<night folder>/parked.md` (`- Slice N: <what it waits for>`) and pick another. A product choice
  with an obvious answer: take it and write why in the slice file. **A planned slice is approved work** (`~/.claude/CLAUDE.md`,
  *What the user accepted is settled*): a wave never parks or re-asks it for a choice the slice file or the plan already
  settles. **Before any park for "no credential"**, check the repo's own CI secrets and the stored ones: `gh secret list`
  (repo and environment), the secrets store, `wrangler whoami` / `gh auth status`; a release workflow that already holds the
  secret can run the step itself (2026-11-14: wave 1 parked Slice 343 and the Microsoft Store part of 374 on "no credential",
  and #1115 then built the step with the release's own secrets). Name each place checked in the park line. **A park note for a slice whose PR is
  already open** (why it stopped, what it waits for) goes only into `parked.md`, so the housekeeping index
  pass writes it into the slice file on `main`; a wave never pushes it to the PR's branch (night 2026-11-03-2349: that push made PR #792 conflict
  with `main`; Slice 307). **Exception: when the open PR itself edits that slice file** (`gh pr diff <n> --name-only`), the index pass
  writes the note into the plan row and *Outstanding work* only, never the slice file, and after its own merge reads `mergeable` on every
  open slice PR before it writes "merge #N" anywhere (night 2026-11-17-1526: housekeeping 2's park note in Slice 18's file made PR #307
  `CONFLICTING`, and two later sessions still wrote "rerun the suite, then merge").
- **Ledger wave:** the highest `## Wave <n>` in the wave ledger plus one; open it before the first
  claim (the `wave-gate` hook requires that). Close it at the end.
  **Resume, don't restart:** if the highest wave is still `(open)`, the ledger changed in the last 24 h,
  no live session holds it, and its claims' PRs are still open
  (an earlier wave session died: a killed driver or a crash), that is this session's wave. Finish those
  claims from their worktrees and branches (read each slice file and the worktree's diff to see how far
  it got) through the same gate, claim nothing new past four, and close it at the end. This is not the driver's `<n>`
  (the round counter in `wave <n>`), which names the report and the housekeeping branch.
- **Already merged is not planned:** before claiming, check `gh pr list --state merged --search <slice>`;
  a slice whose PR already merged is never re-claimed, even if `plan.md` still says `planned`.
- **A slice that fails** (red check twice, `run-wave`'s two strikes, a finding it can't fix, a code
  conflict) goes to `parked.md` with the failing step, so no later wave retries it.
- **A dead session's claims are unverified:** its "fixes applied" or "review done" does not count. Before
  recording or merging, check each claimed finding against the diff, or rerun the pass (2026-10-31, Slice 205: a
  dead session's brief listed findings 1, 2, 4, 5, 7, 8 and 10 as applied; high 4 was still open on main).
- **Permission denied** (prompts are auto-denied): record the denied tool and step in the slice file
  and `parked.md`, park that slice, keep the rest of the wave going. Never retry the same call, with one
  exception: an auto-mode classifier denial of `gh pr merge` on a PR that passed the gate and is green is
  retried once, as `gh pr checks <n> --watch --fail-fast && gh pr merge <n> --merge --repo <owner>/<repo>`, in the
  same session, after a line naming the standing merge authorization (`~/.claude/CLAUDE.md`, *Commit and push
  defaults*) and the PR's `## Review` files. Before the retry, re-read the PR (`gh pr view <n> --json body,statusCheckRollup`)
  and check that every listed review file exists; if a file is missing, or the denial names a missing review or
  check, it is a gate gap, fixed as the `merge-gate.mjs` line below says, never retried. Park only after the retry
  is denied too. Copy each denial's reason verbatim (e.g. "CI Bypass", "Merge Without Review") into the
  slice file and `parked.md`; the morning report gives the user the allow rule to add, never a claim that it is
  the only cause. The session the user talks to next (the starter or the final feedback loop) retries a
  night-denied merge of a gated, green PR once, with the same command, before it lists it as waiting on the
  user; never "click Merge" while that retry has not run (night 2026-11-04-1441: PR #792 was handed to the
  user, then merged fine with the same command hours later). (2026-11-04: PR #792 was denied twice, in wave 4 and in the final feedback loop, with
  different reasons, while waves 1-3 merged with the same command.)
  **A `merge-gate.mjs` denial is not a permission block:** its reason names what is missing. Edit the PR body
  (`gh pr edit <n> --body-file <file>`) to list the review files, or run the missing review or check pass. A denial is fixed by editing the body or running the
  missing pass, never by parking; only when the missing pass cannot run (a second incomplete pass, `run-wave`'s review-gate rule) is the slice parked.
- **The driver owns releases; a wave never releases.** Every merge of the night (slice PRs and
  the housekeeping index PR) carries `batch release: yes` in its `ship-branch` brief, so it starts no push
  workflow, and nothing replaces a dispatched run in its concurrency group. The wave session runs
  `node ~/.claude/skills/run-wave/batch-release.mjs start <repo>` and never `release` or `watch`; the
  driver releases when 6 hours have passed since the last batched release (or the start) and once more on
  the way out. A `workflow_dispatch` the user approved (e.g. a `force_all` store run) may be started by
  hand during the night.
- **Devices:** emulator and Windows VM as `run-wave` says. The user's phone only if
  `<night folder>/preflight.md` says the pre-flight passed; then follow `unattended-device-run`
  (lease, reset ladder, no questions). Checks it can't run go to *Not yet verified* (`docs/plan/unverified.md` after the merge).
- **No `/compact`, no second wave, no `/feedback-loop`.** This session ends after the wave closes; skip
  `run-wave`'s compaction and end-of-wave feedback-loop steps (the driver runs one feedback loop at the end of all waves). Leave `archive-docs` and the plan clean-up to housekeeping, but do the index
  pass after each merge as `run-wave` says.
- Close the wave (`run-wave` section 7) and release everything you started.
- Write `<night folder>/wave-<n>.md` (driver `<n>`): each slice with PR and merged / parked (why), the bugs a device
  run found, what you chose for the user and why. The final reply is the same text in at most 15 lines.

## Housekeeping (headless, after each wave)

`plan.md` must describe tonight's state before the next wave reads it. **No questions** (same as the
wave): skip `branch-sweep`'s remote-branch deletion and `archive-docs`' confirmations, and list what
they would have asked in `housekeeping-<n>.md`. Every step only the owner can do that the night named goes into the slice's `unverified.md` block as a `**You:** <short action> | <steps with the direct link>` line (Start section). If the prompt says the wave session was killed or
failed, close the open ledger wave and park its claimed-but-unmerged slices with that reason first.
On a fresh `chore/docs-index-<night folder name>-w<n>` worktree from `origin/main` (main guard and `branch-sweep` first;
if an index PR is already open, use its branch instead; if `gh pr list --state all --head <branch>` shows a merged
or closed PR with that name, add a letter (`-w7b`), since an open-only search cannot see it: night 2026-11-14-1547
housekeeping 7 reused #1171's merged branch name):

1. First reconcile **every** `planned` row against merged PRs (the slice number in the PR title or head
   branch: `gh pr list --state merged --search "<slice number>"`) and mark each merged one `built`, so no
   merged slice stays `planned` (the driver would count it as still to build). Then reread every prose
   sentence in `plan.md`'s summary that lists slices ("Every slice except 12, 13 and 22 is built") against the
   table's open rows and fix any difference; "already clean" is said only after that compare (2026-11-18,
   print-the-damn-book: housekeeping called the plan clean while that sentence left out parked Slice 24). Also find slices with
   **no row at all**: every `docs/plan/slices/*.md` whose number is in neither `plan.md`'s table nor
   `docs/plan/notes/slices-done.md` (or whose status line still says "PR pending"); for each one with a
   merged PR, index it as `built` in the same pass (row in slices-done, status line, Not-yet-verified
   lines to unverified.md). (2026-11-08, night 2026-11-08-0106: Slice 313 merged as #915 with no row and
   two housekeeping passes said "no merged slice is still planned".) A row whose status is not `planned` but whose
   own text says work is left for the waves (`in progress (part A merged; parts B-D planned)`) is set to `planned`
   for what is left in this same pass, unless the slice file says the rest is parked or waits on the user (then it gets
   that `parked:` status); never report such a mismatch onward "for the feedback loop" (night
   2026-11-13-1149: three housekeeping passes reported Slice 375's row so, and nothing built parts B-D). Then dispatch `update-docs`
   in **index** mode with:
   - the slices merged since the last index pass (compare the status table with `gh pr list --state merged`);
   - every slice in `<night folder>/parked.md`, after re-reading its slice file at `origin/main` HEAD (an
     interactive session may have done the parked work during the night: 2026-11-08, Slices 331-333 were
     answered and closed and 334, 335, 341 held new fix items, yet housekeeping parked all of them as "needs
     the user's ear"); a slice whose wait is gone is indexed as it now stands; the rest get status `parked: <what it waits for>` and a line under
     *Outstanding work*, *Waiting on the user* (the driver counts only `planned` rows, so parking is
     what stops the next wave from retrying it);
   - the clean-up: move every row that is not open (built, verified, merged) to
     `docs/plan/notes/slices-done.md`; move paragraphs about finished batches or waves to a notes file,
     verbatim, with a link; drop *Outstanding work* lines the night closed and remove the `docs/plan/unverified.md` lines the night
     verified (drop empty blocks, update the count line), after recording that in their slice files; if
     *Outstanding work* still holds Not-yet-verified bullets (old layout), move them to unverified.md.
2. Run `node ~/.claude/skills/archive-docs/doc-budget.mjs <worktree>` (the one place the budget is written, in bytes:
   `plan.md` 50,000, root `CLAUDE.md` 20,000; Slice 393 item 9). Exit 1 (over): run `archive-docs` on the same
   branch (between waves is when it is allowed), then run the check again and quote its bytes in the report.
3. `ship-branch`: commit (docs-only, no gate), PR with a `## Test plan` (`- [x] docs only`; tick a
   link check only if one ran), merge when every check is green, then fast-forward the primary with
   `node ~/.claude/skills/run-wave/ff-primary.mjs <primary>` (a dirty primary is no reason to skip it). Then your docs mirror (optional), with a `_STATUS.md` body file
   you wrote (run-wave section 6). The brief names no script path and no start time: say "clear the marker as your instructions say" (the agent's own file gives the `mirror-due.mjs` path, and `clear` with no start time uses the marker's mark time; night 2026-11-17-2355: a brief named a path that does not exist).
   **Board doc sync:** after that merge (the index pass is on `origin/main`), run `git -C <repo> fetch origin` and
   `node ~/.claude/skills/run-wave/board.mjs sync-docs --repo <repo> --parked <night folder>/parked.md` once, and
   once more if it printed a skip line; it fails open (exit 0), so a board outage never fails housekeeping
   (the `agent-board` plugin's skill). Its output line goes into `housekeeping-<n>.md`.
4. Remove the worktree (after leaving the folder in an **earlier** tool call (`cd <repo root>` on its own, then `git -C <repo root> worktree remove <path>` in the next call): a session whose last call ended inside the folder holds it, and the removal fails with "Permission denied", even when the same command `cd`s out first (2026-10-31: four times in two nights; `cd` and remove in one command failed, a separate `cd` call first worked; cause likely, not proven)), and every `left: ...` item in the wave's report that is still on disk under
   `<repo>-worktrees` (scratch folders, run logs); if a delete is denied, name the path in the report.
   Exception to that removal: keep any folder a slice file on `origin/main` cites (`git grep -n <folder name> origin/main -- docs/`)
   and anything under `<repo>-worktrees/reviews/`: the feedback loop reads it and deletes it after its note
   merges. (2026-11-01: housekeeping deleted `reviews/slice-20-desktop-run/`, which Slice 20's file cites.)
   A problem the wave's report names that a skill already says to fix without asking (a stale
   mirror copy: re-mirror it) is fixed in this
   session, not logged for the feedback loop. (2026-10-31: housekeeping saw a duplicate mirror folder
   and only wrote it down.)
   If the prompt says a batched release was dispatched after the previous wave, watch it:
   `node ~/.claude/skills/run-wave/batch-release.mjs watch <repo> --max-minutes 240` (without `--clear-failed`: the final watch clears), write each run's
   `conclusion` in `housekeeping-<n>.md`, and turn a failure (or `startup_failure` with no jobs, "main is
   broken") into an item under *Outstanding work* in the index PR. Merges of the night start no release
   of their own, so a missing push run after a merge is expected, not a broken deploy.
   Read the repo's newest deploy/release run (`gh run list --workflow <release>.yml --limit 3`). If one is
   `pending` with no jobs, find the `in_progress` run of that workflow, its current step and that step's age
   against the last successful run (`gh run view <id> --json jobs`); a step past twice its normal time is
   stuck: name it under *Waiting on the user* with the run id and what it blocks, never "pending, not stuck
   yet". (Night 2026-11-01-2355: a signed iOS build hung from 08:30Z and held every release until the end.)
   Write `<night folder>/housekeeping-<n>.md` (PR, rows moved, slices parked,
   sizes of `plan.md` and `CLAUDE.md`) and reply with the same in at most 8 lines.

## The driver (`run-all-waves.ps1`)

- Loop: `remaining-slices.mjs` on `origin/main` → wave session → housekeeping session (also after a
  stop request) → again. No feedback loop runs between rounds.
  Stops when no row is `planned`, on the stop file (one older than the run is
  deleted), after two rounds with no progress (planned list unchanged and no slice PR merged: PRs from
  `chore/docs-index*`, `chore/plan-cleanup*` and `chore/feedback-loop*` branches don't count, so a slice that keeps failing can't
  loop forever), when a session exits non-zero within 2 minutes (the first
  log line is the reason), or when `plan.md` has no recognised status table, or several and no `## Status` heading (the parser
  exits 2; with a `## Status` heading it reads every table under it, including one per `### <product>` sub-heading). A housekeeping session that is killed or
  exits non-zero is retried once at once; a second failure stops the loop.
  The reason is in `status.json`. Then the one `/feedback-loop` session, even when the loop failed. It never starts while the interactive session that started the run still has its own subagents in flight (`main-busy.mjs` reads its transcript: an `Agent` call with no completion yet; its check-timer `sleep`s and Monitor do not count): the driver re-checks every minute, logs the pending agents in the trace log, and past 4 hours skips the loop, records `skippedFeedbackLoop` in `status.json` and leaves the sessions unaudited (`current` then reads `skipped-feedback-loop`, or `stopped` after a stop file, not `feedback-loop`). The starter is the session id recorded at launch (`starterSessionId` in `status.json`; a restarted driver keeps the earlier night's value); only when none was recorded does it use the newest transcript of the project folder, and the trace log says which. It is killed after 30 minutes (`-FeedbackLoopMaxMinutes`; `killedTimeout` in `status.json`, counted as failed, sessions stay unaudited), and its prompt states that budget (stop new passes at 25 minutes). It reads, over
  every wave, housekeeping and plan-cleanup session of the run, the interactive session that started the run and any
  earlier night's carried sessions. Tooling fixes are done; a product finding becomes a slice with status
  `planned`, never parked for a review the owner did not ask for (decision recorded in Slice 29 item 14); every PR it opens uses a
  `chore/feedback-loop-<night>` branch and writes its note to `docs/plan/notes/<night>-feedback-loop.md`.
  **As part of that docs PR the night's last loop moves every `parked:` row in `plan.md` back to
  `planned`** (the park reason stays as a note line in the slice file), so the next night retries them; only
  rows whose park reason contains the words `interactive session`, since a night
  would only park them again (the literal words `interactive session` alone decide; a plain "waits for the user", or any reason that only names the user, still goes back). (User answer, 2026-11-01: yes, move
  parked slices back to planned at the end of a night.)
  The loop's own merges carry `batch release: yes` too (its prompt says so); the driver runs one more `release` after the loop ends (no watch; it says "nothing merged" when the loop merged nothing), also in the `finally`. **That post-loop release is not watched**: its runs stay in the state file, and the next run's first housekeeping watches them (the driver reads the state file at start and adds the watch note to the housekeeping prompt when runs are listed). The same holds for a stop file, a crash or an abort (an error caught in the wave loop still watches): the driver still runs `release` but skips the final `watch` (the lock must not be held for hours), and `status.json` has `finalRelease.watched: false`.
- Batched release: at the start of the run the driver calls
  `batch-release.mjs start`; after a wave and its housekeeping it calls `due --hours 6` (`-BatchReleaseHours`) and,
  when due, `release` (never in the middle of a wave), then re-opens the batch; the next housekeeping prompt asks
  that session to watch the run. On the way out it releases once more, in the `finally` (normal end, stop file,
  crash), and always runs `watch --max-minutes 240 --clear-failed` (`-BatchWatchMaxMinutes`; `--clear-failed` drops every finished run, failed included, once reported, so the failure reaches *Outstanding work* through the feedback loop / index pass and is not re-reported by the next run's watch; it covers every dispatched run nobody watched yet, none is a no-op) **before** the feedback loop. The first `start` of a run passes `--run-start`, so `due` counts from the later of the last release and this run's start. Every call is
  recorded in `status.json` (`batchReleases`, `finalRelease`) and the final result goes into the feedback-loop
  prompt. A failing or missing `batch-release.mjs` never stops the run. The state is
  `<repo>-worktrees/batch-release.json`. The wave and housekeeping prompts say the driver owns releases.
- **Live checks (Slice 31).** Every open line of `docs/plan/unverified.md`
  starts with a tag (`[chrome]`, `[session]`, `[phone]`, `[cloud]`, `[chat]`, `[owner]`; `live-checks.mjs --lint` refuses a new untagged line).
  After a batched release whose `release` call printed `released: true` (the wave's `due` release), and once more after the final release and watch,
  before the feedback loop (not after a stop file or a fast failure), the driver counts the open lines tagged chrome, session, phone or cloud
  (`live-checks.mjs <repo> --count`) and, when there are any, starts a headless session labelled `live-checks-after-wave-<n>` or `live-checks-final`
  (log `<night folder>/<label>.log`, capped by `-LiveChecksMaxMinutes`, 60; its prompt says to stop 5 minutes before). It lists its work with `--todo`,
  runs each line itself (Chrome only on the domains of the repo's untracked `.claude/live-checks.local.json`; a missing file means no Chrome checks and one line
  saying so; phone checks through `device-test` under the lease, test phone then emulator), removes each pass and updates the count line in one docs PR on a
  `chore/docs-index-live-checks-<night>-<reason>` branch (so its merge is not slice progress), turns each failure into a planned slice, and writes why on a line it cannot reach.
  Only `[owner]` and `[chat]` lines go to the owner, in the step 9 report with a direct link; `[chat]` lines are asked once as one yes for Chrome on claude.ai.
  The result is `liveChecks` in `status.json` (reason, open lines, `chromeConfig`: ok, missing or not-ignored, exit code); a failed or killed session never stops the run. A release that did not go live starts no session after its wave. `released: true` only means the deploy runs were dispatched: the driver does not watch mid-night, so the session first reads each dispatched run's conclusion (`gh run list`) and skips a line whose release is not `success` yet, never testing the old build (only the final session of the night writes `(live check YYYY-MM-DD: release not live)` on it). A line that did not pass keeps one marker at its end, `(live check YYYY-MM-DD: <result>)`, result `unreachable: <why>`, `release not live` or `failed, Slice N` (`failed, follow-up in Slice N`); a new marker replaces the old one. `--count` and `--todo` leave a line out only when its marker's date is the night's UTC date (`--today`, the driver passes it); an older marker is ignored, so the line is tried again the next night, and a failed line that names its slice is updated in that slice, never filed again. The session runs `count-unverified.mjs` on its own worktree and reads the Chrome config by its absolute path in the primary checkout; a fast failure of the session (`Get-FastFailure`) is only logged, as `fastFailure` on its `liveChecks` entry, and never stops the run (unlike other sessions). The count and the list are read from `origin/main` after a `git fetch` (`--origin`); a failed count (-1) starts no session and is recorded in `status.json`. Each session works on its own branch, `chore/docs-index-live-checks-<night>-<reason>` (reason: `after-wave-<n>` or `final`). A missing or not-gitignored `.claude/live-checks.local.json` is named in the step 9 report (one line). The `live-checks-*` labels leave `Test-FinalLoopComplete` (it keys on `feedback-loop`) alone.
- Prompts carry no double quotes: through a `.cmd` shim, Windows cuts the argument at the first one.
- Each session: `claude -p --session-id <uuid> --add-dir <dirs> --permission-prompts none`, run from the
  repo's primary checkout in a thread job the watchdog supervises, with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` so it waits for its background agents
  however long they run. Output goes to `<night folder>/<label>.log`.
- A lock file, created atomically (pid; stale when the pid is gone or started after the lock was written),
  stops a second driver in the same repo.
- Without `-PermissionMode` the driver writes a `warning` into `status.json` and the first line of every
  session log: edits and Bash are denied unless the user's default mode allows them. It still runs.
- **Temp builds are deleted after every wave and on the way out.** After each wave's housekeeping, and in its
  `finally` (normal end, stop file, crash), the driver runs
  `clean-temp-builds.mjs` on the temp folder (`-TempBuildsDir`, default the user's `%TEMP%`): every app package
  (`.apk`, `.apks`, `.aab`, `.ipa`, `.msix`, `.msixbundle`, `.appx`, `.appxbundle`) directly in it and older than
  `-TempBuildMinAgeMinutes` (120, so a build a live test is installing stays) is deleted; subfolders are left alone.
  A file counts as young by the newer of its modified and birth time (a copy keeps the old modified time). The node
  run is killed after `-TempCleanupTimeoutSeconds` (120; `tempCleanup` is then `timeout`); a missing folder deletes
  nothing and a drive root is refused (exit 2). The result is `tempCleanup` in `status.json`, an object with
  `exitCode`. (User, 2026-11-07: 1,402 leftover `tmp*.apk` copies, 124.5 GB,
  filled C: and stopped a run mid-wave. The next run left 16 GB more in
  8 hours, hence the per-wave pass; `tempCleanup` holds the final pass and `tempCleanupWaves` one result per wave pass,
  skipped for a wave that ended in a stop.)
- **Anything older than 24 hours is deleted, on both drives (`clean-stale.mjs`).** (User, 2026-11-08: at the end of
  every run, clean up cached builds and gone worktrees older than 24 hours, in both the C: temp folder and the D: build and worktree folders; D: hit 0 bytes with
  35 GB of `_builds` entries since 2026-10-28, because the build cache prunes only the building worktree's own entries.)
  - Principle: when in doubt, keep. Unknown age, a held folder (`folder-holders.ps1` exit anything but a clean 0, so exit 3
    "partial" counts as held), a capped scan or a failed backup all mean the thing stays.
  - What each mode deletes, backs up and skips, with its limits and timeouts, is documented in the header of
    `clean-stale.mjs`; the driver, not the wave session, acts on it.
  - The cleanup runs after the lock is released on purpose: a kill during it leaves no stale lock.
  - After every wave (next to the temp pass) the driver runs `clean-stale.mjs --wave <worktrees> --ledger`: the slice
    numbers of the highest wave in `wave-ledger.md` (ignored, and nothing deleted, when the ledger was last written over
    24 h ago) decide which worktrees belong to the wave (folder name exactly `s320`, or the worktree's own branch from
    `git worktree list --porcelain` is `*/320-*` or `*/320`; a bare `320-` folder prefix, a number inside another name or
    a date never matches, nor does `s3200`); only `_builds` entries whose `build.json` records such a worktree
    are deleted, whatever their age, and never one held by a live process (the build or its worktree), `packs` or a
    `.building-*` entry. Other sessions' worktrees are untouched. Result: `waveCleanups` in `status.json`, one item per wave.
  - In the `finally`, after the temp pass, it runs `clean-stale.mjs --stale <worktrees> --temp <temp> --hours 24`
    (`--hours` is at least 1; the worktrees dir must be named `<repo>-worktrees`; both else exit 2):
    (a) `git worktree prune`; (b) `_builds/*` entries whose own time, top-level files' times (build.json, logs) or recorded build time are all older than 24 h (no deep scan: cache entries are written once and big builds must age out), except `packs`,
    `.building-*` and held ones; (c) git worktrees idle 24 h (newest of folder, index, HEAD commit time and every
    modified or untracked file), never the primary checkout, a held one, one under a `_*`, `.*`, `reviews` or
    `run-all-waves` folder, a detached HEAD whose commits are on no branch, or one mid merge/rebase/cherry-pick; first
    `git diff HEAD --binary` goes to `<repo>/.git/worktree-backups/<name>-<yyyymmddHHmmss>-<random hex>/changes.patch`
    (a new folder every time, never overwritten; the folder and its `README.txt` are written whenever anything was
    skipped, even with nothing else to copy; a backup over 500 MB in total, or one that would leave under 5 GB free on
    the backup drive, keeps the worktree and is counted as `keptBackupTooBig` in the result, not as `failed`) and every
    untracked non-ignored file is copied to `.../untracked/`, and git-ignored files that are not build output (not under
    bin, obj, node_modules, .artifacts, .gradle, .vs; not .apk/.msix; not over 20 MB) to `.../ignored/` (`.env`,
    `.dev.vars`, signing files), the skipped ones listed in the backup's `README.txt`; a failed backup means no removal; removed with
    `git -c core.longpaths=true worktree remove --force`, the branch stays; (d) other top-level folders of the worktrees
    dir idle 24 h by their deep newest time (scratch), except `_*`, `.*` (tool-owned: `_desktop-vm`, `.phone`, `.tools`),
    `run-all-waves`, **`reviews`** (merge-gate.mjs needs the findings files on disk), held folders and any folder
    containing a `.git` (a worktree or repo) or a registered worktree; files such as `wave-ledger.md` stay; (e) top-level
    entries of the temp dir idle 24 h (deep newest time, birth time counts; a deep scan over its file cap keeps the
    entry), except `claude` (live sessions); temp entries (folders and files) are judged by their timestamps only, with no
    holder check and no rename probe, and a delete that fails (in use) is `skipped`, never retried or forced. A locked
    entry elsewhere is counted in `failed`, never stops the run. Drive roots are refused (exit 2);
    `--dry-run` lists instead of deleting. Killed after `-StaleCleanupTimeoutSeconds` (900; the whole process tree is
    killed with `taskkill /T /F`, so the holder-check `pwsh` dies too); result: `staleCleanup` in
    `status.json` (counts and `freedBytes` per category). Params: `-StaleCleanupScript`, `-StaleCleanupHours`.
- **Disk preflight and a trace of why it ended.** Before every wave the driver reads the free space of the temp and worktree
  drives (`disk-free.mjs`, `-DiskFreeScript`; per drive, Slice 317: `-MinFreeGbTemp` 5 for the temp drive, `-MinFreeGbWorktrees` 5 for the worktree drive, the old `-MinFreeGb` name sets both; `-EstimateGbWorktrees` 24, a wave of four app builds being estimated at about 24 GB, only logs and records `diskEstimate` (`freeGb` next to `needGb`) and never stops a night; the logged disk-free line prints each drive's `freeGb` next to its `needGb`); under a stop threshold, it runs the temp cleanup, rereads, and stops with
  `stopReason` `disk space low: ...` (the feedback loop still runs) instead of claiming slices onto a full disk. The trace file
  `<run folder>/driver-<night>.trace.log` gets a `phase:` line per phase; a driver that ends before `done`/`failed` without an error (a stop signal, an exit)
  writes `current: stopped` and `driver ended early without an error while current was <phase>` into `status.json` (an exception is `failed`, written by the catch block; Slice 317 item 7: there is no `died` status, the old branch for it could never run); the next driver prints, and records as
  `previousEnd`, how the newest earlier night ended, and names one whose pid is gone with no end status as killed.
- **Cloud placement (Slice 08).** Before each wave the driver runs `run-wave/placement.mjs`
  (`-PlacementScript`) on each planned slice's file as it is on `origin/main` and puts one line in the wave prompt:
  `Placement: 07 local, 08 cloud ... Cloud slices left tonight: <n> of <cap>`. No script can read the weekly usage, so the usage
  stop is the fixed `-MaxCloudSlices` (4; 0 = cloud off): the line lists each slice's placement as `placement.mjs` gives it, the wave session sends at most `<n>` cloud slices and builds the rest locally, with `<n>` 0 the line says every slice is local,
  and a failing `placement.mjs` makes that slice `local`. The driver reads `wave-ledger.md` (slice lines of waves
  after the highest one at run start that say `stage: cloud running`, `cloud: pushed` or `cloud: failed`) and only ever adds those slice numbers to `cloudSlices` in
  `status.json` (`cloudSlicesUsed` is its count, `ledgerWaveAtStart` the wave it started after); a restarted driver carries the list from the newest unfinished earlier night. Dispatch itself is `RemoteTrigger`, done by the wave session (`run-wave` section 3), never `--cloud`. The trace
  log's memory line is `memory: free <x> GB of <total> GB; claude: <n> processes, <y> GB; top: ...` (`claude` counts processes named claude or whose command line names the claude CLI).
- Tests: `node --test skills/run-all-waves/*.test.mjs` (the driver test runs it against a fake `claude`; each driver run is
  killed after 240 s so one stalled fake-claude run fails instead of stalling the suite).
