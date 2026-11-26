---
name: run-wave
description: Run several planned slices in parallel from one coordinator session - a wave of 3-4 non-overlapping slices, each claimed by a draft PR, built by implement-slice agents, reviewed in two passes, merged one at a time. Use when the user says "run a wave", "run these in parallel", "build slices X, Y and Z", "do the next few slices", or asks to work on several planned slices at once.
---

This session is the **coordinator**. It keeps the judgment (which slices, triaging
review findings, root causes, talking to the user) and hands everything mechanical
to model-pinned agents. The rules this skill applies are in `~/.claude/CLAUDE.md`,
*Parallel work*. Read the repo's `CLAUDE.md` first: its commands and constraints
outrank this skill's defaults.

## Keep the coordinator lean

Every tool result and report stays in this session's context for the whole wave.
So:

- **Never run builds, tests, emulator or desktop checks, merges, conflict resolution,
  CI polling or log reading yourself.** Each goes to an agent: `run-checks`,
  `device-test`, `ship-branch`, `resolve-merge-conflicts`, `fix-review-findings` or
  `ci-status`.
- **Don't message the user for each background notification.** Reply only at
  milestones: a slice merged, a blocker, a question for the user, or the wave's end.
  Ignore "waiting on its own background work" notices silently. A finished timer, a
  finished docs agent or a dispatched next step is not a milestone: act on it and end
  the turn without a status line. (2026-10-26: a status line after almost every
  notification flooded the user and the context.)
- **Never stop or hold running work on a guess.** If you are unsure whether something
  is in scope or the user's own lane, ask in one line and keep it running meanwhile.
  (2026-10-26: Farsi rewrites were stopped on a wrong guess, and finished PRs were held
  for a release run nobody asked to protect.)
- **One release per wave.** Merges of this skill carry the skip-CI marker in the merge subject, so no push
  workflow starts for them; `skills/run-wave/batch-release.mjs` starts those workflows by hand once, when
  the wave closes (see *Batched release* below and section 5). Right after the ledger lists the wave, run
  `node ~/.claude/skills/run-wave/batch-release.mjs start <repo>`. Every merge brief says `batch release: yes`.
  Never hold or time a merge for a release run. A session started by the `run-all-waves` driver does the
  `start` and writes the field, but never runs `release` or `watch`: the driver owns them.
  The merge gate enforces the marker only on the session that runs a wave (`runsWave` in `wave-gate.mjs`); a plain session's merge
  while a batch is open is not forced to `[skip ci]`, so its own release pipeline runs.
- **Keep a wave ledger** at `<repo>/../<repo>-worktrees/wave-ledger.md`, outside the
  repo, written **before the first claim**. It has CRLF endings: append and correct it only with Edit, never a heredoc,
  `sed -i` or `printf >>` (the shell-write guard denies them; board night 2026-11-25-1729: waves 2-4 were each denied first). At each milestone, update it with slice, PR,
  stage and next action, so a fresh session can resume from it. Every time written into it comes
  from `date -u +%H:%MZ` (or the PR's `mergedAt`) read in the same step, never an estimate
  (estimated times were off by up to 40 minutes); `wave-gate.mjs` denies a claim or ship call while the open wave holds a `HH:MMZ` more than 5 minutes later than `date -u`, checked only when the wave has a line `Opened HH:MMZ YYYY-MM-DD session <id>` (from `date -u +"%H:%MZ %Y-%m-%d"`; `<id>` is the coordinator's `CLAUDE_CODE_SESSION_ID`, which the shell exports) naming today; the gate also counts the session whose hook `session_id` equals that `<id>` as the wave's coordinator, even when its transcript shows no run-wave marker. Its shape is fixed,
  because a hook reads it: one `## Wave <n> (open)` heading per wave with one
  `- Slice N <title> ...` line per slice (the gate compares numbers, so `020` and `20` match) under it (at most 4), and the heading becomes
  `## Wave <n> (closed)` when the wave ends. The ledger's `<n>` counts waves across nights, so it is
  not the wave's name: under `run-all-waves` the board card title, the index worktree and branch names
  use the night's own wave number, the `N` in the `/run-all-waves wave N` prompt (the night folder's
  `wave-N.log`), never the ledger's (night 2026-11-17-1216: "Wave 7" for wave 1 of the night). The `wave-gate` hook
  (`skills/run-wave/wave-gate.mjs`, a PreToolUse hook on `Agent`) refuses a `ship-branch`
  claim (a brief starting `Claim mode.`; every other `ship-branch` call passes) for a slice
  that isn't listed in the open wave, a slice whose ledger line says `stage: cloud running` (section 3,
  *Cloud slices*) or whose Touches overlap one that does, any claim while the open wave lists more than 4, and
  any claim while the highest-numbered wave is closed. It reads the highest wave number, not
  the last in the file, and ignores a ledger untouched for 24 h. A refusal means: close the
  wave, compact, then open the next one. Never add a slice to an open wave to get past the
  gate. (2026-10-30: 16 slices ran as one wave in one context, although this skill said 3–4.)
  These wave limits bind only the coordinator: a session whose transcript never loaded `run-wave` or `run-all-waves`
  (a plain "implement slice N") is not part of anyone's wave and is refused only for a clash with a `stage: cloud running`
  slice (2026-11-25, ReadTheStupidText Slice 409 was refused because another session's Wave 74 was open).
- **Brief by pointer, not by prose.** Your own prompts stay in context too, and on
  2026-10-21 they were the largest share of a wave that reached 400k tokens over
  about 90 agent round-trips. Keep each brief to roughly 10 lines:
  - Name the worktree, the slice file and the files to read; never paste their content.
  - For review fixes, pass the reviewer's findings file and say which numbers to
    apply or skip, plus any one-line note that changes a fix. Never retype findings.
  - **One reason per skipped number.** Write the skip as `Skip: 4 (<why, one sentence>), 6 (<why>), 9 (<why>)`, never
    `Skip: 4, 6, 9 (no fix)`; "low, follow-up", "same as check #N" and "(coordinator's triage)" are not reasons.
    `check-review-skips.mjs` rejects an empty or placeholder reason (Slice 21; night 2026-11-17-1826: four triage briefs with no
    reasons, and `update-docs` filled in placeholders).
  - **A step an agent hands back is yours.** When an agent reports a command it could not run (a blocked `rmdir`, a sandbox
    refusal) and a tool can do it, run it yourself; never relay it to the owner (night 2026-11-17-1826: an `rmdir` reached the owner).
  - **Name doc sync by its script,** `node ~/.claude/skills/run-wave/board.mjs sync-docs --repo <repo>`, never as a "sync-docs skill"
    (no such skill exists; a brief once sent ship-branch looking for it).
  - For update-docs, list facts as short fragments; the agent writes the prose.
  - Repeat nothing the agent definition or the repo's CLAUDE.md already says.
  - Write every path with forward slashes (`D:/repo-worktrees/reviews/x.md`): an agent that
    copies `\r` or `\b` from a Windows path into a file writes a control byte (2026-11-01: a CR
    reached main this way in print-the-damn-book PR #35).
  - A PR's `## Test plan` lists only checks that ran and that you name; never template a
    "links checked" or "docs only" tick you didn't do (2026-11-01: PRs #33 and #37 said
    "links checked" with no link check).
  - Read update-docs' `review read:` lines; a partial read means the slice's *From review:* is
    not finished: send it back with the files to finish. Then run
    `node ~/.claude/skills/feedback-loop/check-review-skips.mjs --root <worktree parent> <slice file>` in the worktree
    (exit 0 required, before the slice goes to `ship-branch` and again in the index pass): each skipped finding in
    *From review:* must cite its findings file and quote a reason that file contains, e.g.
    `- Skipped #3 (`reviews/pr-12-high.md`): "the exact words of the finding"`. A flagged line goes back to
    `update-docs` to be rewritten from the findings file (Slices 222, 223, 231: skips written from briefs).
    A skip line whose reason (outside the quoted finding) says "by design", "as designed", "intentional" or
    "deliberate" must also cite `Decision <n>` or `user` followed by a quoted span (`user: "keep it"`), whatever the
    severity; a bare "user said" does not count, and a low finding skipped for being low must not call it "by design" (Slice 376).
- **Ask for short reports.** Agents cap reports at about 12 lines with no tables. If
  one comes back long, don't echo it to the user; reply in one or two lines.
- **Compact at milestones, not only between waves.** After each merge and its index
  pass, update the ledger and estimate how full the context is from the size of the session so far
  (never skip it). If it is past about 30% and the user is present, ask them to run `/compact` before the next slice (a
  session cannot compact itself); if the user is away, never end the turn on that request: finish the slice at a clean boundary, write the ledger as the resume point and stop there, and leave the next wave to a fresh session (`run-all-waves` starts one per wave). At the end of a hand-run wave, run `/feedback-loop`
  over the wave first, then compact or start a new session: compaction keeps only a summary, and the
  feedback loop needs the mistakes and leftovers while they are fresh. (User, 2026-10-30.)
- **Wave size: 3–4 slices.** Don't add slices mid-wave. A slice split off during
  the wave gets planned and waits for the next one. **"Until all is done" means several
  waves, never one big one:** split the planned slices into waves of 3–4 up front, and
  between waves write the ledger, run `/feedback-loop` over the wave (hand-run only; `run-all-waves` loops once at the end), then, if the user is present, ask
  them to `/compact` before claiming the next (if away, end at the ledger and leave the next wave to a fresh session). (2026-10-29: seven slices ran as one wave in one session and the context ran
  out before the end.) Unattended, wave after wave until nothing is planned, is the
  `run-all-waves` skill: it starts each wave in a fresh session.
- **Check running agents every 10 minutes** (`~/.claude/CLAUDE.md`, *Background agents get a
  10-minute check*): one `sleep 600` timer (background, `timeout: 660000`) for the whole wave, re-armed while any agent runs;
  a stuck agent gets one message, then `TaskStop`. Busy agents keep going however long they take.
  Each check also runs `node ~/.claude/skills/run-wave/board.mjs usage-tick --force` once (token usage to the board, Slice 11
  part A; fails open, exit 0: never wait on it or let it change what the wave does).
  The `cd <repo root>` goes in an earlier turn than the timer, never in the same block of tool calls: `timer-cwd-guard`
  denies the timer while the cd has not taken effect (2026-11-13: eight denials in one night).
  **Check commands use `git -C <worktree>` or absolute paths, never a bare `cd <worktree>`**: a shell left inside a worktree
  makes the next timer arm from there and `timer-cwd-guard.mjs` denies it (wave 1, three denials; Slice 33 item 17).
- **Briefs name older slices with `plan-not-needed: N`.** A slice number in a brief that is only context (an earlier
  slice, a parked leftover) goes in the first draft as `plan-not-needed: N`; otherwise `brief-plan-guard` denies the
  brief for naming a slice without its file (2026-11-13: eleven denials in waves 1-2). A slice of **another repo**
  named in a brief (an index or record brief that says "board Slice 13") counts too: write `plan-not-needed: 13` for it
  (2026-11-17: two denials in one wave). Since Slice 21 the guard also lets a slice of the current wave ledger or a parked `plan.md` row
  through as context once the brief names its own slice file, but keep writing `plan-not-needed: N` for them.
- **The first draft of a coordinator brief carries `plan-not-needed: N` for every slice number it names other than its own**
  (Slice 29 item 21; denials at wave entries 166, 632 and 650 each cost a round trip): write the line while drafting, never
  after `brief-plan-guard` denies the brief.
- **First-draft checklist for a brief: slice numbers.** Before sending, read the brief for every "Slice N": a sample title
  quoted in it ("Slice 3D viewer"), a made-up seed number in a device-test brief and a context slice each go in as
  `plan-not-needed: N` or are reworded; only this repo's planned work is named bare (night 2026-11-17-1216: five briefs denied).
- **Watch the merge queue.** If it hasn't moved in 30 minutes, dispatch `ci-status`
  for per-step CI timings before waiting longer.
- **Merge fast slices first.** Merge independent slices whose checks are fast before
  a slow check, so it doesn't block unrelated merges.

Keep a short ledger in your todo list: one item per slice with its worktree, branch,
draft PR, migration number and stage (claimed, building, review 1, review 2, ready,
merged, indexed). Write the stage on the ledger line (`stage: review 1`, ...) and send the board step report at every move; `wave-gate.mjs` refuses a `ship-branch` commit or merge call for a slice whose ledger line still says `stage: claiming` or `stage: building` (night 2026-11-16-2043: Slice 07 merged on `building`, with no step report after review 1 began).

## 1. Pick the wave

1. Run the `main` guard and the merged-branch sweep (`~/.claude/CLAUDE.md` for the guard, the `branch-sweep` skill for the sweep), from the
   primary checkout with read-only commands only. **The sweep is stamped, and the stamp is re-read before the first claim**
   (Slice 29 item 21): run `node ~/.claude/skills/branch-sweep/sweep-stamp.mjs write <repo>` right after the sweep and
   `node ~/.claude/skills/branch-sweep/sweep-stamp.mjs check <repo>` as the last command before step 2's first claim; a
   failed check means sweep again, so ship-branch claim mode never refuses a claim for a stamp that is hours old (night
   2026-11-19: refused twice, on stamps 297 and 524 minutes old).
2. Dispatch the `parallel-check` agent with the repo path and the candidates: the
   slices the user named, or every `planned` row in `plan.md`'s status table. Its brief puts no line
   cap on the script's `CONFLICT` and `UNKNOWN` lines (the 12-line cap is for the rest), and you compare
   each candidate pair's Touches lines yourself before picking (2026-11-01: a capped summary dropped
   229 x 230, which the script prints; the coordinator caught it only by reading the Touches lines).
3. Any candidate reported `UNKNOWN` needs a **Touches:** line. Write it from the slice
   text and a `ground-in-code` check of the files it names. The claim commit
   (step 2) adds it; once the claim is up, `parallel-check` reads claimed slices
   from their claim branch.
4. **Check each candidate's premises before claiming it.** One `ground-in-code` agent
   for the wave confirms that every screen, control, file, API and Touches path each
   slice assumes really exists, and that its stated dependencies are merged; every new value the slice sends to
   another system (a type, status or key form) is checked against that callee's enum or schema, with the callee's repo path in the brief; a schema the agent
   cannot read is reported "not checked", never as a pass (night
   2026-11-16-2043: Slice 14's `session` type passed the check, and the board has no such type). A new enum value, type or status
   is also checked against the schema's CHECK constraints and its migrations before "Migrations: none" is accepted (night
   2026-11-17-1216: Slice 14's new `items.type` hit a CHECK constraint and needed migration 0007; the builder stopped after 8 minutes). A "not checked" value
   is not claimed yet: the coordinator finds the schema's path itself (the callee's repo is a sibling folder of this
   repo, or named in the slice or the repo's `CLAUDE.md`; for the agent progress board, its `src/domain/` types), reads the
   enum there and dispatches the check again with that path; only when no path can be found does it leave the slice out
   of the wave and write "schema not checked: <value>, <callee>" on the slice's ledger line. For a setting
   or code path the slice changes, it also says which platforms run that code (a file
   named for one head is not the mobile path: Slice 209 aimed a mobile hook at
   `ReadAloudService`, which is Windows-only, and lost a builder round). Fix the
   slice text (or drop the slice) before building, never mid-build. (2026-10-26: Slice
   142 assumed a control-panel editor Windows doesn't have; several Touches lines named
   folders that don't exist; both cost extra rounds.) It also lists every file the slice's
   work items, mock and Decisions name that is missing from its Touches line; widen Touches
   before the claim (2026-11-01, Slice 228: Touches was widened twice mid-build, two builder resumes).
   It also lists every mechanism the slice relies on that `docs/plan/unverified.md` (or the slice's
   *Not yet verified*) still marks unproven: prove it with a throwaway probe on the cheapest device before
   the claim (one probe of at most 10 minutes, not the slice's device run, which still comes after both
   reviews); if no device is free or the probe is inconclusive, design around it and keep the line in
   *Not yet verified* (2026-11-01, Slice 233: a netpolicy network cut listed as "to prove first" was built on; it did not work
   on the test phone, about 50 minutes and two phone runs). For a bug inside a third-party library or model,
   one `web-research` search of its issue tracker comes before any design (2026-11-01, Slice 220: two
   designs failed before one search found sherpa-onnx #4086).
5. **Order by what each slice's decision rests on.** A slice that measures or
   investigates something (a spike, a benchmark, a "which works" test) merges before
   any slice whose default or design depends on its answer, even if the plan lists them
   in parallel. (2026-10-26: Slice 144 made `mana` the Farsi default before Slice 145
   measured that `mana` drops short words; words were skipped until Slice 149.)
6. **Outward steps first.** If finishing a slice needs an outward-facing action (a store
   or bucket upload, a console change; never a deploy: the pipeline deploys, see the batch-release step), ask the user for it before building
   the items that depend on it, not after they merge. (2026-10-26: six store-book
   version bumps merged while the upload stayed blocked, so `main` and the live store
   disagree.)
   **Ask every user question for the whole run now, in one batch**, while the user is
   there: outward steps, console or store declarations, which device to use (phone or
   emulator only), and any slice that needs a yes before it can merge. Don't wait for
   the user to say they are leaving. (2026-10-29: these came up only when the user
   announced they were leaving and had one minute to answer.)
7. **Design stateful slices before claiming them.** A slice whose state must survive a
   restart, a network loss, the app going to the background or a cancel (downloads,
   resumes, staged updates, sync, migrations) gets its design written into the slice
   file by you first: one owner of the state, the states, and what happens on each
   interrupt (killed, offline, cancelled, retried). The builder builds that design; it
   doesn't invent one. (2026-10-29: Slices 181, 182 and 183 each failed twice in the
   same area and needed a redesign mid-wave.)
8. Propose the wave: up to 4 slices from the safe list, in its order. Name every
   hub-file overlap you're accepting and why. If the user named the slices, just say
   which ones you're holding back and why, and go on.
   A pair `parallel-check` reports as **CONFLICT** (both slices change the same core file) is
   sequenced: the second is claimed only after the first merges. Running them side by side anyway
   needs a written reason on the wave ledger's slice line (`- Slice NNN ... parallel with MMM:
   <reason>`), and the wave report repeats it. (2026-11-01, print-the-damn-book: Slices 17, 18, 19
   ran side by side despite CONFLICT on `MainViewModel.Dino.cs`, with no reason written; Slice 18
   then needed a conflict fix and an extra check pass.)
   A CONFLICT with a **live PR** (a draft or a starter-session takeover, not a slice of this wave) means: read that
   PR's diff and slice before claiming, and leave out every item that fixes the same fault or edits the same script;
   write which items you left out on the ledger line. (Night 2026-11-14-1547 wave 2: Slice 376 built a Store retry
   script beside #1121's retry for the same fault, despite parallel-check's CONFLICT line; about an hour of review
   rounds, then the script was deleted.)

## 2. Claim each slice (draft PR)

**A planned row whose slice already has an open PR is resumed, never claimed again:** check `gh pr list --state open --search "Slice <N>"` and the row's PR column first; use that PR's worktree and branch, merge `origin/main` in (`resolve-merge-conflicts` for docs-only conflicts) and carry it from its recorded stage (night 2026-11-17-1526: Slice 18 went back to `planned` with PR #307 open).

**Disk first.** Before the first worktree of the wave run
`node ~/.claude/skills/run-all-waves/disk-free.mjs "<temp dir>=5" "<repo>-worktrees=5"` (the same stop thresholds as the driver's `-MinFreeGbTemp` / `-MinFreeGbWorktrees`; exit 1 = a drive under its need, printed next to each free value; the driver's `-EstimateGbWorktrees` 24 is only a warning, never a stop; the driver already refuses to start a wave then). Exit 1: run `clean-temp-builds.mjs <temp dir>`, recheck; still low: claim
nothing and report `disk space low` (2026-11-07: a wave claimed four slices with C: at 0 GB, and their reviews and commits failed).

For each slice in the wave:

1. `git -C <repo> worktree add -b <type>/<slug> <absolute path of <repo>-worktrees/<slug>> origin/main`.
   **A new branch name for every wave:** run `gh pr list --head <type>/<slug> --state all` first; a merged or closed PR listed means pick another
   name (an open PR is the slice's claim: resume it as the paragraph above says; a merged PR's branch is never reused: wave 4 reused `chore/s29c-fl-tooling` after PR #395 merged and the claim was refused).
   Always an absolute path: with `git -C <repo>` a relative one lands inside the repo, which the
   `primary-checkout-guard.mjs` hook now refuses (2026-11-01: two worktrees made inside the primary).
2. **The claim commit** touches only the slice's own docs:
   - If the slice still lives in `plan.md` and has no `docs/plan/slices/NN-*` file
     yet, copy it to its own file; never edit
     `plan.md` on the branch (parallel claims deleting adjacent sections conflict).
     Run `python -I ~/.claude/skills/archive-docs/archive_docs.py move plan.md <N> <worktree>`,
     then restore it with `git -C <worktree> checkout HEAD -- plan.md` and delete
     `plan.md.bak`. Until the merge, the slice file wins over the stale `plan.md`
     section. Leave its status-table row alone; the index pass removes the section
     and updates the row after merge.
   - Set status lines with the Edit tool, never `sed -i` (the shell-write guard denies it, and CRLF slice files break it; night
     2026-11-17-1657: three denials in one wave). In the slice file, set the status line to
     `*In progress (wave <YYYY-MM-DD>), draft PR.*`, add or fix its **Touches:**
     line, and add `**Migrations:** NNNN` if it adds a migration. Take numbers from
     parallel-check's "next free number", one per slice, counting up across the wave.
3. Hand it to `ship-branch` in **claim** mode. The brief's first line is exactly
   `Claim mode.` (the gate hook and `ship-branch` both key on it). **The title in the claim brief is the one you pass as `--title` in your own claim report**
   (the plan table's slice title verbatim), so the card is never re-reported under another name (Slice 33 item 32). Commit
   `docs(plan): claim Slice <N>`, push, open a **draft** PR whose body carries the
   Touches and Migrations lines (copied verbatim from the slice file, found by its `**Touches:**` label
   with Grep or `placement.mjs`'s `touchesOf`, never by a line number: the file changes while building;
   2026-11-18, print-the-damn-book PR #59 got the wrong line) and the closing references, then move the issues to
   In Progress. Commit messages carry no `Co-Authored-By` line (user, 2026-11-01).

The claim goes up before any code exists, so a second coordinator or a stray terminal
thread sees it in `gh pr list` and in parallel-check.

**Board report (every ledger milestone that moves a slice).** Right after the draft PR exists, report the
slice as claimed with `node ~/.claude/skills/run-wave/board.mjs report-progress --slice <N> --type slice --status in_progress --title "<plan table title>" --why claimed --source agent --link "PR|<draft PR url>"`
(from inside the repo; the plugin skill `agent-board` has the keys and the other transitions). It fails open: never wait on it or let it change what the wave does.

**Task steps (Slice 11 part C).** Every `in_progress` report from the coordinator also carries `--agent run-wave --model "<the model this session runs on>"` (the Active work page lists a task only with an agent or a steps list) and the step list: add `--steps-file run-wave --touches-file docs/plan/slices/<NN-slug>.md` (the script reads the slice's `**Touches:**` line itself; never put that line in double quotes, Git Bash runs its backticks) and the move, `--step-active "<label>"` for the step the slice is in now or `--step-done "<label>"` when one just finished (it marks that step done and the next one active). The list is `skills/run-wave/steps/run-wave.json`; the script drops the Android, iOS and Windows steps when the Touches line names none of that platform, and sends the whole list each time (steps before the named one done, the rest pending). The claim report uses `--step-active "Claim with a draft PR"`. Report each move with the same command line as the stage report (same `--slice`, `--type`, `--title`), for example `... --why "in review" --steps-file run-wave --touches-file docs/plan/slices/<NN-slug>.md --step-active "Review pass 1 (high)"`. A report with no step flag sends no list, so the board keeps the last one. The step labels used are exactly those in the file: Claim with a draft PR, Build the slice, Fast checks, Review pass 1 (high), Fix pass 1 findings, Review pass 2 (medium), Fix pass 2 findings, Android emulator check, iOS check, Windows desktop check, Run checks, Record the slice in its docs, Ship and merge, Index pass. `--step-done "Ship and merge"` makes "Index pass" the active step: the merge report is sent that way, and the index pass (section 6) sends `--step-done "Index pass"` for each slice it indexes with the same command line (that is what clears the active step; a slice marked done by `mark_done` needs nothing more). The script also writes the slice's task key and step for the token reports (`usage-tick.mjs`), under the session id from `CLAUDE_CODE_SESSION_ID` (the shell tool exports it; `--session <id>` overrides) and removes that file when the report has status done or is `mark_done`; with several slices in one session the newest report wins. A step label the file does not hold (or that the Touches line trimmed away) sends no list and writes no task file, never an error. A late or batched report adds `--started-at <ISO>` / `--done-at <ISO>` with times read from evidence (a review file's mtime, a PR's `mergedAt`), or sends no time (Slice 32 C). The format is `new Date(x).toISOString()` (a real date-time with a zone, not in the future; a bad one is dropped with a stderr line). `--done-at` goes on the `--step-done` step only; `--started-at` goes on the `--step-active` step, else on the `--step-done` step; with `--step-done` and `--done-at` but no `--started-at` the step that becomes active starts at that done time. Only the step a flag names gets a supplied time: the other steps one report flips to done, and a plugin that predates the flags (`board.mjs` prints a `board: note` line then), keep the board's own stamp, so send one report per step, oldest first.

**Open checks are steps (Slice 32).** While a wave ledger is live (touched in the last 24 hours), a report with `--slice <N>` and `--steps-file run-wave` also sends one step per open line of Slice N's block in `docs/plan/unverified.md`, after "Index pass", labelled `Check: <text>`; a check that waits on something else (its text says "waits on", "needs the owner" or "needs the user", or starts `**You:**`) is a `pending` step whose note starts `waits on: ` (never the step state `blocked`, which the plugin does not have yet). Labels stay within 80 characters and the list within the plugin's 30 steps (the last kept step says how many checks were cut); a check that left `unverified.md` since the last report is sent first, which the plugin marks done; any `--part` or `--under-step` report sends no checks (after `--step-done "Index pass"` the first open check is the active step). While a wave ledger is live, every slice report with a step flag writes the time and the step label into `<repo>-worktrees/step-reports/slice-<N>.txt`, and `wave-gate.mjs` refuses a `ship-branch` commit or merge call only for a slice in the open wave whose stamp of this wave names a step before "Review pass 1 (high)".

**Process keys and counts (Slice 34).** The step files carry a `process` key per step; `board.mjs` sends it (a steps-file report: the plugin reads it; an `--under-step` report: as `--step-process "<label>|<key>"`). A coordinator that finishes a review pass or a fix round on its own card sends the pass's yield on the step it marks done: `--step-done "Review pass 1 (high)" --counts "findings=<N>"`, and `--step-done "Fix pass 1 findings" --counts "fixed=<n>,skipped=<m>"` (the numbers from the findings file's `## Outcome` block). `--counts` is `name=whole-number` pairs, up to 10, names `a-z0-9_`. A helper agent already sends its own counts (`code-review-pass`: `findings`; `fix-review-findings`: `fixed`, `skipped`), so a coordinator that reports under a step id sends no counts for the same pass twice.

**One part of a slice (Slice 11 part D).** When a wave's task is one lettered part of a slice (a slice file's "**B. Title**" group), report on the part, not the slice: add `--part <letter>` to the same command line (with `--slice <N>`, never `--key`). The key becomes `<project>/slice-<N>/part-<letter>`, the type `part` and `parent_key` the slice's key; every step flag above works unchanged and the part's steps are its own. For example: `node ~/.claude/skills/run-wave/board.mjs report-progress --slice <N> --part <letter> --status in_progress --title "<part title>" --why "in review" --agent run-wave --model "<model>" --steps-file run-wave --touches-file docs/plan/slices/<NN-slug>.md --step-active "Build the slice"`. Close it with `board.mjs report-progress --tool mark_done --slice <N> --part <letter> --note merged`. The slice's own tile keeps its stored status; doc sync marks a part done when all its checkboxes are ticked. A bad letter or a missing `--slice` sends nothing.

**Helper agents report under the slice (Slice 16 part C).** Every brief to `implement-slice`, `fix-review-findings`, `code-review-pass` and `device-test` carries one line, `Board parent: <project>/slice-<N>` (the slice's key, no leading zero; the part's key `.../part-<letter>` for a part), so the helper puts its steps under the slice's card (the plugin skill `agent-board`, *Helper agents report under their caller*). The same line goes in main-thread briefs for a task with a card. A brief with no such line reports nothing. **Each brief also carries `Board step: <step id>` (Slice 24)**, the id of the slice-card step the helper works under. The board makes a top-level step's id from its label, so the id is the exact label from `skills/run-wave/steps/run-wave.json`: `implement-slice` under `Build the slice`, `code-review-pass` under `Review pass 1 (high)` or `Review pass 2 (medium)`, `fix-review-findings` under `Fix pass 1 findings` or `Fix pass 2 findings`, `device-test` under `Android emulator check`, `iOS check` or `Windows desktop check`, merge work under `Ship and merge`. A `ship-branch` claim brief carries no `Board step:` line: the coordinator reports the `Claim with a draft PR` step itself. A `Board step:` names only a step present in the slice's reported (trimmed) list: the Android, iOS and Windows steps are dropped when Touches names none of that platform, so for such a slice use `Run checks` or omit the line. The coordinator sends the step report that makes a step active BEFORE it dispatches that step's helper, so the parent step is stored when the helper reports. One helper per step at a time: an `--under-step` report replaces all of that step's children, so a second helper on the same step (a check pass) waits or goes under the next step. The helper reports its own steps with `--under-step "<that id>"`, never into the slice's whole list (the board refuses `under_step` without a step list); each helper agent is then a child of its step on the board.

**This coordinator is an orchestrator (Slice 24).** At its start it runs `node ~/.claude/skills/run-wave/board.mjs report-progress --orchestrator` once (sends nothing, fails open: an installed plugin without the flag prints one skip line, or, when it predates the flag, `report-progress: no key` with exit 0; both mean the same and the wave goes on) and opens no card for the wave session; the plugin's hooks then open none either. Each slice is reported on its own slice card, as the *Task steps* paragraph above says, and the steps are the slice's list in `steps/run-wave.json` (Claim, Build, Review pass 1, Fix, Review pass 2, Fix, device checks, Merge among them), with each step's helper agents as its children.

## 3. Build in parallel

Dispatch one `implement-slice` agent per slice, all in one message so they run at once.
Each prompt gives: the worktree path, the slice file path, its Touches line, its
migration number, and this instruction: "Edit only within Touches. If the work needs a
file outside it, stop and report which and why." When one reports a file outside
Touches, re-run `parallel-check` before allowing it. **Build-tool work** (csproj, props, targets, MSBuild conditions,
workflow build flags): dispatch `library-docs` first and put its answer in the builder's brief; the builder reports a library id
for it, and the reviews flag a diff whose report says `context7: none` (Slice 305: conditions written from memory).
Every builder brief, not only build-tool ones, carries the line "query context7 before writing code against any library
API" (2026-11-13: a brief without it got MAUI animation and geometry code written first and checked after).

**Briefed agents start no background forks of their own.** Every brief to an agent that reports back says: do not start a background fork or background agent
whose report would reach you after your own report (a fork the skill you run mandates, such as `code-review-pass`'s review fork and its timer, is
not that: it still runs and the agent waits for it; and tool processes you wait on yourself, such as a logcat or emulator process, are fine); do the work in the foreground and send one report.
A fork still running when the agent reports makes the report arrive again (2026-11-14, ReadTheStupidText: agents re-sent their reports 3-4 times while background forks were still running; Slice 35 item 3).

**Cloud slices (Slice 06).** Before dispatching, run
`node ~/.claude/skills/run-wave/placement.mjs <slice file>` for each slice: it prints `cloud: <reason>` or
`local: <reason>`. (Under `run-all-waves` the prompt's `Placement:` line replaces that run, and its `Cloud slices left tonight: <n> of <cap>` is a cap: dispatch at most `<n>` of the wave's `cloud` slices to the cloud and build the rest locally with `implement-slice`; with `<n>` 0 the line says every slice is local.) An explicit `**Placement:** cloud|local` line on the slice wins; with none, a slice is `local`
unless its Touches line has at least 4 code files (tests count) and no `.ps1`, device, Windows or desktop path,
and its *Verification* names no device, emulator or Windows. Text, docs and config edits are never `cloud`. A
`local` slice goes to `implement-slice` as above. A `cloud` slice only has its **code written** in the cloud;
the claim (section 2), both review passes, the fixes, device tests, merge and docs stay with you:

1. The claim comes first and is local: the claim branch with its draft PR is already pushed, so the cloud
   session never makes a first push (the claim PR exists; the cloud session cannot call GraphQL).
2. Dispatch is the `RemoteTrigger` tool, never `claude --cloud` and never the browser. Keep a fixed pool of
   worker routines named `run-wave-<repo>-worker-1`, `run-wave-<repo>-worker-2`, ... (`<repo>` is the repository name, one
   pool per repo, one routine per cloud slice running at once; two repos' nights sharing one repo-less worker name overwrote each
   other's stored prompt, Slice 29 item 3; an existing repo-less `run-wave-worker-N` is never reused or updated: create the `run-wave-<repo>-worker-N` once):
   `RemoteTrigger list` first; create a missing one once (Default environment, model `claude-sonnet-5-5`, the
   repo's GitHub URL as source, no connectors) and **keep it**: routines cannot be deleted through the API, so
   never create a throwaway one, and never leave the user a routine to remove. Per slice: `update` the worker's
   `job_config` prompt with `cloud-brief.md` filled in (slice file, claim branch, claim PR number, owner/repo),
   then `get` the routine and compare its stored prompt with what you sent: on a mismatch (another night updated it in
   between) stop, do not `run`, and `update` again or use another worker; only then `run` it (a `run` body does not replace the stored prompt). **Create recipe (worked first time, night 2026-11-17):**
   `RemoteTrigger create` with the body `{name: "run-wave-<repo>-worker-1", enabled: true, clear_mcp_connections: true,
   job_config: {ccr: {environment_id: "<id>", session_context: {model: "claude-sonnet-5-5", sources: [{git_repository:
   {url: "https://github.com/<owner>/<repo>"}}], allowed_tools: [...]}, events: [{data: {type: "user", uuid: "<new uuid>",
   session_id: "", parent_tool_use_id: null, message: {role: "user", content: "<cloud-brief.md filled in>"}}}]}}}`.
   Read the environment id from an existing routine with `RemoteTrigger list` (its `job_config.ccr.environment_id`); there
   is no other lookup. Slices 14 and 16 were built locally on "no worker routine exists" and "not created blind": the
   coordinator runs `create` once, and when it fails writes the exact error on the slice's ledger line (a cloud-placed slice
   ends with a run id or the quoted error, never a bare "no routine"). If no `RemoteTrigger` tool is available
   (a headless `claude -p` session may lack it), every slice of that session is `local`.
3. Write the ledger line as `- Slice N <title> ... stage: cloud running <session id> <run link> worker <n>` (exactly `stage: cloud running`; the
   `wave-gate` hook then refuses a second claim of that slice and a claim of a slice whose Touches overlap it).
   Poll with `RemoteTrigger list_runs` and `get_run_log`: done is the run's last line `CLOUD DONE <sha> pushed=yes`
   plus `git ls-remote origin <branch>` showing that sha. Then change the line to `cloud: pushed <sha> run <session id>` (keep the session id: the feedback loop reads the run with `get_run_log`). Every later rewrite of the line (review, fixes, merge) keeps `cloud: ... run <session id>` as its own field; the driver counts a slice as cloud from `stage: cloud running` or `cloud: pushed`/`cloud: failed`, so write those exact tokens and never `cloud: ` in a reason text.
   `CLOUD DONE <sha> pushed=yes checks=failing <what>` (pushed, a check fails): change the line to
   `cloud: pushed <sha> run <session id> checks failing <what>` and let the local fixer or `run-checks` take it from there.
   `CLOUD BLOCKED ...`, a failed run, or no push after the run ends: change it to `cloud: failed <why> run <session id>` and
   build that slice locally with `implement-slice` (or park it).
4. Before section 4: fetch the branch, check its commits (`git log origin/<branch> --format=%B`) for a
   `Co-Authored-By` line or a session link (the brief forbids both; if one is there, name the commit in the wave
   report for the user, never rewrite the pushed history yourself), and read `git diff --name-only origin/main...origin/<branch>` (three dots: only what the branch changed) against
   the Touches line (the slice's own file is always allowed: the brief lets the cloud session tick its items). Then the slice goes through the gate like any other (it has no review files from the cloud).
5. Waiting (Slice 07): the script cannot call `RemoteTrigger`, so write what each poll of `list_runs` / `get_run_log` returns to a run file
   (JSON `{ "status": "<run status>", "lastLine": "<last log line>" }`, in the job tmp folder) and run
   `node ~/.claude/skills/run-wave/cloud-wait.mjs <claim PR number> --run-file <path> --max-minutes 120`. Start it as a background command and keep polling `RemoteTrigger` yourself, rewriting the run file at every poll (the script only re-reads it, so a foreground run or a stale file ends `failed no result`).
   If item 6 sends you to a local build, `TaskStop` it first so its output cannot race with the local build or the merge. It re-reads the file, checks the branch head with `git ls-remote`, then runs
   `gh pr checks <n> --watch --fail-fast`, then reads `gh pr checks <n> --json name,bucket` once for the verdict (red = any bucket `fail` or `cancel`; `no checks reported` is re-polled for `--no-checks-grace-minutes`, default 3, before it counts as green: a docs-only PR has no checks); its last line is `done`, `failed <why>`, `cancelled` (PR closed), `superseded` (new pushes after done, or `superseded PR merged`) or `checks-failing <sha> <what>` (exit 5), exit code 0 only for `done`. On `superseded`, re-read the PR (`gh pr view <n>`) and the branch before any rebuild: a merged PR or a newer push is work that already landed.
   `done` means item 3's `cloud: pushed <sha> run <session id>`; `checks-failing` means item 3's `cloud: pushed <sha> run <session id> checks failing <what>` (keep the branch, fix locally, no rebuild); `failed` means `cloud: failed <why> run <session id>` and a local build, except a `failed` that names `gh` (`gh pr view failed ...`, `gh pr checks failed ...`), or one that names `git` (`git failed 5 times in a row ...`), which is a gh, git or network fault: fix that and rerun the wait. A cloud slice has no review files: both review passes run locally on the fetched branch,
   `device-test` runs from a local worktree of it (only the checks the slice touches), and you never merge on the cloud session's word.
6. Stuck run: at each 10-minute check read the claim PR's newest commit time and its check status. Nothing changed for 3 checks in a row: send one nudge, then change the line from `stage: cloud running` to `cloud: failed stuck run <session id>`, build the slice locally with `implement-slice` and say so in one line.

**One e2e run per repo at a time.** A brief that runs a repo's e2e suite (`npm run test:e2e` or the like) names the other
live worktrees of that repo, and only one e2e run per repo is live at once unless the repo takes its port per worktree: with
a fixed port and `reuseExistingServer`, one suite runs against another worktree's page (night 2026-11-17-1216: Slice 16's
suite ran against Slice 15's page, 179 false failures; agent-progress-board's own fix is its Slice 17).

The builder runs only the fast checks after each build (typecheck, lint, unit tests,
integration tests needing no emulator, VM or phone) and runs nothing on a device
(`implement-slice` step 4). Device runs come after both review passes (section 4), on
the reviewed code (user, 2026-10-29: review fixes made earlier device runs worthless).
For the device stage:
Each emulator is one shared device: never let two agents use the same one at once; queue them. Keep
a headless emulator warm for the whole wave and have every brief say "headless, scripted" (rules in
`agents/device-test.md`, *Fast, headless, scripted*); nothing may take over the user's screen. Where
the repo has them (a touched-targets script and `-App auto`; the repo's device-tooling rules file names the flags), device
briefs test only the touched apps, build once and reuse the cached build, and run a slice's Android
and Windows checks as two agents at once; two slices can each take an emulator, within the limit the
scripts enforce (one emulator plus the VM, or two emulators without it).
**Free memory first.** Before starting the Hyper-V VM or a device build, read free memory:
`(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB` (GB). Start the VM only above 8 GB free;
below that, run the emulator-only checks and put the VM checks under the slice's *Not yet verified* with the
free-memory figure. (2026-10-31: low memory killed a session's background work.)
**Phone runs build before the budget starts:** a `device-test` agent briefed as build-only (no lease, no timed
run; not the coordinator or the `run-checks` agent) runs `tools/phone/run-checks.ps1 -Build -App <app>` for the app each check runs in (the catalogue's
`Apps`, not the slice's product) before dispatching the timed phone run, and the brief names that
cached build. (2026-10-31: three timed test phone runs spent most of their 10 minutes building; one check
took 25 s after a 10-minute build.) **The same for emulator and VM runs, every slice, tooling slices too:**
where the repo has a build-only command (e.g. ReadTheStupidText's `install-debug.ps1 -BuildOnly`), the build-only
agent builds every app the timed runs install and the brief names each cache key; a repo with none has the brief name
the build to reuse, or say that none exists. (2026-11-01 wave 4: 225's emulator run spent
about 5 of its 10 minutes building Dino, and its test phone check found no cached RTST build; the three product slices
had been prebuilt.) A second emulator needs the same free-memory reading as above; say the figure in the brief (2026-11-01: a second emulator was forced on the evening the session's timers
were killed four times for low memory).

**A brief step the hand-back leaves unanswered is chased, not dropped** (Slice 29 item 22: wave 1's `run-checks` brief asked for a
read-only timing run, the report did not answer it and the wave wrote "was not run"). Compare every hand-back with the brief's
numbered steps; for each step with no answer, send one `SendMessage` to that agent naming the step, and only then write "not run".
**A failed check is re-run alone after its fix.** The fixer's hand-back names the failed check's script (the one the run
printed), and that check alone is re-run once the fix is in, even when unit tests cover it; never close it on unit tests
while the script exists (night 2026-11-17-1216: a failed browser history-wording check was fixed and covered only by unit
tests, though its 7.5-minute script existed).

**Read the log before briefing a fixer.** A failed device run's fixer brief quotes the log lines that
decide the failure (from the run's saved log), never a guessed cause (2026-11-06, ReadTheStupidText
wave 1: a guessed brief made the flow worse; about three emulator runs lost).

**Two strikes, then design.** A review or check-pass finding that reopens a function or classifier an
earlier fix round already changed counts as a strike too, even when that fix passed its tests
(2026-11-01, print-the-damn-book Slice 20: error classification changed three times over four check
passes). When a slice fails a device check twice in the same area,
stop dispatching patches. First turn on the platform's own diagnostics for that failure (WinUI
`DebugSettings.LayoutCycleTracingLevel` / `LayoutCycleDebugBreakLevel` for a layout cycle, Android StrictMode,
iOS zombies, a native crash's tombstone) and read what they name; a park that has not tried them is not
finished (night 2026-11-04-1441: Slice 264's `LayoutCycleException` was parked after two nights of guessed
fixes without the WinUI trace). Read the code yourself, write down why it breaks and the
design that can't break that way (e.g. "the read starts with the exact head that was
prepared", not "compute the head twice and hope the keys match"), then hand that one
design to a single fixer. (2026-10-26: Slice 139's cache-key mismatch was patched three
times before the by-construction design; the slice took almost five hours.) The same applies to review
rounds: when check passes raise the same area twice (a layout offset, a restore rule), stop and write the one
design, and at claim time a value that depends on more than one measured input (sizes, an aspect, a page) is
named in the design note as one pure, unit-tested function. (2026-11-01 wave 4: Slice 232's tablet row offset
took high, medium and four check passes before it became `LandscapeLayout.TextCardLeft`.)
**Check passes converge.** After the second check pass on a slice, only a crash, data-loss, security, privacy,
missing-twin-platform or loading-state finding may reopen the code; every other finding (a low, a "medium
(unconfirmed)" from a pass that ran no tests, a timing edge) becomes a line in the slice file's follow-up list with
its findings-file reference, and the slice goes on to its device run. Low follow-ups named in a PR body are copied
into the slice file before merge: a PR body is not a tracking place. A design that rests on a measuring assumption
(a hidden label's size, a font's width) proves that assumption on one run before it is built. (Night 2026-11-14-1547:
wave 1 parked 346 E, 243 and 317 after 4-5 rounds each, 384 took 11 passes, 387 item 3's hidden probe label measured
0 and cost a failed iOS run; the starter's "the device runs decide" was written nowhere.)

## 4. The gate, per slice, as each one finishes

**Board report:** when a slice enters the gate, report it again with `--type slice --title "<plan table title>" --status in_progress --why "in review"` (same key as the claim; type and title repeated so the tile appears even if the claim report failed; repeat at each stage, it is also the heartbeat that keeps the tile from going stale after 120 minutes).

**Before you accept any agent's report** (builder, fixer, reviewer), run `node ~/.claude/skills/run-wave/released-check.mjs <that agent's worktree>`: it lists the live processes whose command line names the worktree. Exit 1 means something is left; send the agent back to stop what it started, or name each process as another session's. A Claude Code session or an editor that merely names the path is printed as "named, not counted" and does not make the exit code 1. Known limit: a server started after `cd <worktree>` has no path in its command line and is missed; `folder-holders.ps1` covers open files. A `released:` line is a claim, not evidence (2026-11-15, night 1401 wave 2: a fixer reported nothing left running while 8 watcher shells were alive).

Don't wait for the whole wave; take each slice through as soon as it comes back. **A dead session's "fixes applied" or "review done" is unverified:** before recording or merging work a killed or dead session left, check each claimed finding against the diff, or rerun the pass (2026-10-31, Slice 205: a dead session's brief listed findings 1, 2, 4, 5, 7, 8 and 10 as applied; high 4 was still open on main).

1. `code-review-pass` (level `high`) with the worktree path. It writes the full findings to a file
   and returns one line for each. **Its first line ends with `Reviewed worktree: <path>`: compare that path with the one in
   your brief** (same for the medium pass); a different folder means the pass reviewed another slice and is rerun
   (a medium fork reviewed `s301` for a brief naming `s300`). Triage from those lines, then hand
   `fix-review-findings` the findings file path, the numbers to apply and the numbers
   to skip. **Triage means choosing:** apply correctness, data-loss, crash, security,
   privacy and missing-loading-state findings; skip style, naming, speculative
   "could race" findings with no failure path, and refactors for their own sake, with
   one line each on why; a reason that states a code fact ("Notify reports no failure") cites the
   file:line you read, else it is a guess and goes to *Not yet verified*. A finding about what live data or a live service will do (a board, a store, a deploy) is never skipped on a plan *Decision* line alone: dry-run it against the live system first, or apply it (2026-11-17-1526: skipped s16bd-medium #5 re-opened 11 merged board slices). Every applied finding is a new change that can break
   something; forwarding all of them caused regressions on 2026-10-26.
   **Never widen a fix past the slice** to a second product, app or platform ("Dino needs the
   same fix") until a `ground-in-code` answer shows the other one has the same defect.
   (2026-10-30, Slice 218: a Dino half was built on a guess and reverted, one extra round.)
   **A parity finding is never skipped "by design":** when a review says Android and iOS behave differently,
   apply it, or record it under the slice's *Waiting on the user*. Only the user exempts a parity difference
   (`~/.claude/CLAUDE.md`, *Android and iOS are the same app*).
   **No high or medium correctness or data-loss finding is skipped "by design"** unless the skip line cites a slice
   Decision or the user's own words; otherwise apply it or record it under *Waiting on the user* (2026-11-13: a Slice 246
   High finding, "a failed pack is ignored until the weekly check", was skipped by design and the user later met the bug).
   **A finding that undoes an earlier applied fix** (same lines, opposite intent) is not applied and
   not reverted: write down both reasons and design one behaviour that meets both, then run the
   slice's own device check against it (2026-11-01, Slice 233: medium fix 6 undid high fix 4; reverting
   it failed the test phone check; about 45 minutes and two phone runs). A fixer's `READ THE BRIEF AS:` line is
   answered before the next pass.
   **A finding that changes behaviour the diff did not introduce** is checked against `origin/main`
   first (`git show origin/main:<file>`): if main already behaved that way, it is a product decision,
   written under the slice's *Waiting on the user* with today's behaviour kept, not a fix (2026-11-01,
   Slice 229: "PageText Back should save" was applied, extended, then found to delete a blank page
   silently and reverted; main had always discarded on Back; two fix rounds).
   **A finding about a device check's measurement** (sample size, repeats, pass threshold) is not handed
   to a fixer on the reviewer's word: change it only with a device result that shows the need, and run
   that check before the slice counts as merge-ready (2026-11-01, Slice 220: repeats raised to 3 without
   evidence; two test phone runs failed before the real cause, a sentence cache, was found).
   Every builder, fixer and reviewer brief names the repo's documented test command verbatim (its
   `CLAUDE.md` or CI workflow), never a hand-picked subset (2026-11-01, AgentPipeline #134: briefs said
   "tests under skills/ and .github/", missed `tests/`, and the PR went red in CI).
2. `code-review-pass` (level `medium`, dispatched with Agent `effort: medium`) with the worktree path, a fresh pass. Triage and fix the same way.
   **A pass whose report starts with `REVIEW INCOMPLETE` did not happen:** dispatch a fresh
   agent for the same pass before going on (`merge-gate.mjs` also denies a merge whose `## Review` section lists a findings file
   starting with `REVIEW INCOMPLETE`; never tell the user "the second review found nothing" for such a pass). If the second one is incomplete too, don't merge:
   park the slice with "review gate not met" (reported to the board with the *Board report for a parked slice* paragraph near the end of this file) (or, interactive, tell the user). Never record a
   lighter review as the gate. (2026-10-30, Slice 218 merged on a medium pass that only read
   the diff.) The same applies to pass 1.
   **A slice's full suite starts only after the slices ahead of it in the wave have merged** (the wave's merge order): a suite started earlier runs on a tree that goes stale when they land, and the run is wasted (night 2026-11-17-2355 wave 1: Slice 20's suite started before Slices 19 and 21 merged and was stopped with `TaskStop` after about 34 minutes). Merge, update the branch, then start it.
   **The full suite starts after the last fix.** Never start `run-checks` while a fixer still edits the same
   worktree, and never rerun on a changed tree and call an earlier failure "flaky" (night 2026-11-17-1216:
   two suites started mid-fix). **Two identical failures of one test on the same tree end the reruns:** park the slice with both
   summaries named, never a third full run "in case the load has dropped", and never a new run while the last one's processes are
   still alive (`released-check.mjs <worktree>` exit 0 first) (night 2026-11-17-1526: suite 4 repeated the same timeout for 35 minutes,
   and a `--resume` run was dispatched while the earlier run's node processes lived). For this repo (AgentPipeline) the full-suite brief is
   `node .github/scripts/run-suite.mjs --out <worktree parent>/reviews/<slug>-suite.md --budget-ms 480000`,
   started with the Bash tool's `run_in_background` and a long timeout (a file can take 20 minutes, so a foreground run under the
   10-minute tool limit livelocks), its exit awaited (the harness reports the exit; meanwhile read the `--out` summary file, with no shell poll loops and no foreground `sleep`; never `TaskStop` or `taskkill` your own run; this paragraph wins over `agents/run-checks.md` if they differ), and repeated with `--resume` while it exits 3 (incomplete; `--rerun <file>` reruns one file an outside kill cut); never one `node --test "**/*.test.mjs"`
   with a long timeout, and never a run whose exit code the agent infers instead of reading. It runs each test file on
   its own, writes each file's exit code, the skipped tests and the hash of the code tree into the summary,
   and exits 1 when any file failed. Name the summary in the PR's `## Review` section: `merge-gate.mjs` denies
   the merge when its `Suite code tree:` line differs from the PR head's code, so a fix after the suite means
   a rerun. **List only the final summary:** remove each superseded one from the body, because the gate checks
   every listed summary (PR #375's second merge denial listed a stale one).
   **An earlier merge of the night does not send a later PR back to the full suite** (Slice 29 item 20: Slices 26 and 25 each
   reran the 71-file suite after Slice 23 merged, 35-60 minutes each). The gate only needs a summary whose `Suite code tree:`
   equals the head's, and it accepts a `--changed` ("Selected run") summary when it covers every file `select-tests.mjs` names for
   the PR's own diff. So after `origin/main` is merged into a PR that changes nothing under `.github/`, rerun
   `node .github/scripts/run-suite.mjs --changed --out <worktree parent>/reviews/<slug>-suite.md` (1-2 minutes) and list that
   summary; the full suite is for a PR that changes `.github/`, or the first run after the last fix when the PR has none yet.
   Merge the PR with the most files first, so the later ones merge in a smaller delta.
   **A test that fails by the same name on two trees is read before any further full suite** (Slice 29 item 24: "batch release: a
   stop file still releases on the way out" failed with the same 240 s `ETIMEDOUT` on two trees, was called flaky twice, and
   two 30-minute suites reran before anyone read the test, about 3 hours). A failure repeated by name gets a one-file rerun
   (`node --test <that file>`), a read of the test, then a fixer (compare *Two strikes*), never another full run.
3. `run-checks` on the worktree. If the slice changes what an app does on a device or
   desktop, the build comes first and is not yours to run: put the repo's build-only
   command (if it has one) into that `run-checks` brief, so a cold build never uses up
   the 10-minute cap (runs of 12 and 14 min, 2026-10-30). Dispatch `device-test` after it
   reports, not in the same message, on the worktree with the slice's
   checklist and the builder's new scripted checks (shown failing once against the old
   behaviour); this is the slice's first device run, after both reviews. Test only the
   apps and platforms the slice touches (shared UI code: the Android emulator; the VM
   only for Windows-specific code). The run stops at 10 minutes and runs only scripted
   flows (`agents/device-test.md`); what it didn't reach goes to *Not yet verified*, never
   to a second run. A second voice or variant is a second item inside the same 10 minutes, not
   a second run. A brief names only flags the script has (read its `param()` block first). Flow names, flags
   and what counts as a pass come from the repo's device-tooling rules file (ReadTheStupidText: `tools/CLAUDE.md`),
   never from this skill. Record a layout check as PASS only from the `PASS <flow>` line `run-flows` prints for a flow whose header carries `# layout-check` (a layout problem turns that line into `FAIL` with `Layout check failed:`), never from a flow with no such header or from a tag the brief assumed. A bug it finds goes to
   `fix-review-findings` (fast checks after its build), then only the failed or touched
   device checks run again; a check it can't run goes to *Not yet verified* and never
   holds the merge. (2026-10-26: a
   `NetworkOnMainThreadException` was found on the emulator only after Slice 132
   shipped.)
   If the slice changes CI, release or deploy code, list the preconditions its first run
   on `main` needs (tags, secrets, bindings, account features) and confirm each exists
   or is created by the code itself, before merging. (2026-10-26: per-product baseline
   tags were missing, and a Cloudflare binding needed a feature the account might lack.)
4. `update-docs` in **slice** mode with your brief: it records the slice as built in
   the slice file only, including its `For CLAUDE.md`, `For README.md` and
   `Not yet verified` blocks. It doesn't touch `plan.md`, `CLAUDE.md` or `README.md`.
   **Every new `Not yet verified` line carries a tag** (`[chrome]`, `[session]`, `[phone]`, `[cloud]`, `[chat]`, `[owner]`;
   `update-docs` writes it), and before the slice goes to `ship-branch` run
   `node ~/.claude/skills/run-all-waves/live-checks.mjs <worktree> --lint` (exit 0 required; exit 1 names each new untagged
   line in `docs/plan/unverified.md`: tag it). The lines tagged chrome, session, phone or cloud are run by the live-checks
   session after the release, never left for the owner (Slice 31).
5. `ship-branch` in **commit** mode: the implementation commits (with the repo's
   version marker, or "patch intended" in the brief when none applies; **in a GitVersion repo the default brief line is
   `version marker: patch intended`** (only when the slice file names no feature or breaking bump; otherwise the brief carries the slice's minor-bump or major-bump trailer, spelled as `pr-conventions` says), so ship-branch never stops to ask for one: wave 5 lost about 7 minutes before
   PR #1097 that way), pushed to the draft PR, with no `Co-Authored-By` line. **The brief carries the commit message
   as its exact text** (subject and body, or the path of a file holding them), never a description of what it should
   say: ship-branch does not write messages and stops (night 2026-11-15-1908: about two minutes lost on Slice 09). You write the final PR body now
   (Summary, Test plan, the closing references, and the claim's Touches and
   Migrations lines kept; for a PR that changes code also a `## Review` section listing the findings files by
   path: one high, one medium, plus a check pass when code changed after the last pass) and pass it so ship-branch sets it with
   `gh pr edit --body-file -`. Merge mode refuses a PR with no `## Test plan`.
   Take the Touches and Migrations lines from the live claim body
   (`gh pr view <n> --json body`), never retype or summarise them. (2026-10-26: a body
   that said "see the slice file" instead stalled a merge.)

Slices that hit a design question go back to the user. The rest of the wave keeps going.

**Read every "known behaviour" the builder or a fixer leaves.** If a user would call it
wrong (it does something they just told it not to, it starts work they cancelled), it is a
bug: fix it in the slice, or plan a follow-up slice before the wave closes, and say which.
Only real platform limits stay as known behaviour. (2026-10-29: Slice 183 recorded "after
cancelling the voice pack the OCR pack still auto-starts" as known behaviour.)

**Slices made of many small items** (one PR per book, per locale, per page): right
before starting each item, check `gh pr list` for open PRs touching that item's files,
from any session. Skip or queue an item another lane has open, and recheck before it
merges. (2026-10-26: three rewritten books later collided with another tab's PRs on
the same books.)

**Never change a worktree while a device test is running on it**, and don't stop a
device test to make room for a fix: let it finish (or ask it to report partial results),
then fix. `device-test` marks the worktree (one `<git dir>/device-test-running-<id>` file per run) and the fixer and
builder agents refuse to edit while any mark under 90 minutes old is there, so a fixer sent too early comes back
`blocked`; a `blocked: device test running` report means wait for that device test's report, then redispatch the
fixer (2026-11-01 wave 4: a fixer rewrote s232 under a running landscape check). **When a `device-test` agent is
stopped (`TaskStop`) or dies, the coordinator deletes that run's `device-test-running-*` mark from
`<absolute git dir>` before dispatching a fixer**; the agent never got to remove it and it would block edits for 90 minutes. When the emulator is too slow to judge a timing (swapping, arm64 under
translation), use the phone (USB first, else wireless adb; never ask the user for it) instead of
re-running emulator checks.
**A failed device run starts the next fix at once.** When a device run fails, dispatch the next
`fix-review-findings` with that failure immediately; it diagnoses right away. If another device run on the SAME
worktree still holds its `device-test-running` mark, the fixer prepares the fix and applies it as soon as the mark
clears (it never edits under a mark, and the other run is never stopped to make room). A run on another worktree
never delays it. The parallel run's result goes to the same fixer as a follow-up message (SendMessage). (2026-11-04, Slice 264: the wave sat 4.8 of 24 minutes between two VM attempts
waiting for an unrelated emulator run; Slice 266.)
**Build for a device run only after the last code change:** don't start a build-only agent while a fixer or a
check pass on that slice is still open; its build is thrown away by the next fix (2026-11-01 wave 4: two of
Slice 232's builds were discarded that way).

## 5. Merge, one at a time

Merges are serial, because every merge changes `main` for the rest. **A commit waits for its edits' results** (Slice 29 item 40): never
send the coordinator's own Write/Edit calls in the same message as the `ship-branch` dispatch or a commit; read their results first, and
name the files you edited in the ship brief so `ship-branch` step 4b stops on one whose edit did not land. For the next
slice that's through the gate:

1. `ship-branch` in **merge** mode. It merges `origin/main` into the branch only when the PR is
   `DIRTY` or `BEHIND` (M2; a clean PR keeps its checks); on a
   docs-only conflict it stops, and you dispatch `resolve-merge-conflicts`, then call
   merge mode again. If the merge brought in new commits that changed none of the PR's own files
   (`skills/run-wave/merge-touched-own-files.mjs` exits 0), it pushes and **keeps going**: it waits for the checks on the
   pushed merge commit and merges, with no `run-checks` and no second dispatch. If the merge changed a file of the PR, or
   resolved a conflict, it pushes and **stops** (`ship-branch` M2): run `run-checks` on the worktree, then call merge mode
   again. Otherwise it waits for the PR's checks. **The merge brief carries the batch subject:**
   `batch release: yes` and the exact `--subject "Merge pull request #<n> from <owner>/<branch> [skip ci]"`, so ship-branch's first
   `gh pr merge` is not denied (wave 1: six denials). **It also gives each `## Test plan` line with its result** (`- [x] <check>: <result>`);
   a ticked line with no result is unticked by the ship agent. Write the brief that way; never "merge main in
   and wait" (2026-10-30: two merge agents in one wave followed the two texts differently). A code conflict comes back to you: resolve
   it in the worktree (or dispatch `fix-review-findings` with exact instructions) and
   run `run-checks` again.
   **A resumed agent can notify more than once:** after `SendMessage` to a ship-branch agent, wait for
   its hand-back report, not the first "completed" notice; before dispatching any other merge for the
   same PR, run `gh pr view <n> --json state` (2026-11-01: two agents ran `gh pr merge 638`).
2. When the checks are green, ship-branch marks the PR ready and merges it (a merge
   commit, never a squash, so the claim commit and the version markers survive).
   **Board report:** once the PR is merged (`gh pr view <n> --json state` says `MERGED`), run `board.mjs report-progress --tool mark_done --slice <N> --note merged`, then `board.mjs report-progress --tool mark_done --slice <N> --waiting --note merged` to close its waiting child if a park left one open.
   A red check or a failed merge stops here and comes back to you, with `ci-status`'s
   read-out.
   **The `merge-gate.mjs` hook enforces the review gate.** It fires on `gh pr merge` (any flag order, number, URL or
   current branch) and, unless every changed file is Markdown or under docs/design/ (Claude Design mocks), denies the merge unless the PR body has a `## Review`
   section naming at least two distinct review files (paths under a `reviews/` folder, each on disk): one whose name
   contains `high` (or `pass-1`) and one containing `medium` (or `pass-2`). It proves both passes exist, not that they
   cover the final diff by itself, so it also reads the `Reviewed files:` block (path and git blob sha per changed
   code file) at the end of each listed review file and denies the merge when a changed file is in none of them
   at its sha at the PR head (or at the branch's last own commit, so merging origin/main never matters): run a check pass (`code-review-pass`, level `medium` (the agent accepts only `high` or `medium`, never `low`), on the final code; its brief's read list names every earlier `reviews/pr-<n>-*.md` findings file, so it does not repeat skipped findings) and list its file as a
   third entry in the same section. A reviewer agent writes every listed file, never the coordinator: a
   check file the coordinator wrote itself is not a review (2026-11-01: two AgentPipeline PRs merged on
   coordinator-written "no findings" check files, one with a HIGH finding filed as a "known limit"). So the merge brief tells ship-branch to put those paths in the body.
   (Three nights in a row a PR merged with no review pass on record.)

Merge only what is through both review passes and green; there's no "merge and fix forward".
In a repo that deploys on every push to `main`, a merge outside this skill is a release; the merges of a
wave are not (the merge brief says `batch release: yes`, so `ship-branch` puts the skip-CI marker in the
merge subject). The first wave merge in a repo is checked once: `gh run list --commit <merge sha>` must show
no `push` run. If one appears, `ship-branch` and the merge subject cannot be trusted to skip it: switch the
brief to `skip-checks: true` as a trailer in the merge `--body` (GitHub's documented alternative; the
trailer text goes only in that body, never a PR body or title) and check the next merge the same way.

**Batched release.** When the wave closes (section 7) and something merged, run
`node ~/.claude/skills/run-wave/batch-release.mjs release <repo>`. It starts every workflow a push to
`main` since the batch start would have started (the `push` branch, `paths` and `paths-ignore` filters
decide) with `gh workflow run <file> --ref main`, and prints one JSON line. A matching workflow with no
`workflow_dispatch` is an error naming the file: report it, never skip it. Nothing merged: it prints
"nothing merged" and stops. A deploy pipeline outside GitHub Actions (Cloudflare Workers Builds) also skips
skip-CI merges: when the batch touched its watch paths (`workerPaths` in `.claude/merge-gate.json`), `release` itself
POSTs the repo's Workers Builds deploy hook (`CF_WORKER_DEPLOY_HOOK_URL`, from the environment or the secrets store file
`<SECRETS_DIR or ~/.secrets>/<repo>/secrets.env`; never printed) and the JSON line carries `workerHook` (`started`,
`failed` with `workerHookError`, or `no hook url`); the hook starts the deploy and the reader confirms it in Cloudflare:
`watch` only prints the recorded hook outcome once and never checks or clears `workerNotDeployed` (`worker-deployed` does). Never `wrangler deploy` from a shell
(`deploy-guard.mjs`); a repo with no hook says so in the wave report as a planned tooling gap. Then `node ~/.claude/skills/run-wave/batch-release.mjs watch <repo>`
watches each run to its `conclusion` (10-minute check rule applies to the watch); report each
conclusion in one line, never "finished". At the end of the wave use `watch <repo> --clear-failed`: it
reports every run as usual, then drops every finished run (failed included) from the state, so the failure is
reported once and a later `watch` does not report it again. A run GitHub no longer has (HTTP 404 while the repo
itself answers: its workflow was deleted or the run passed retention) is reported once as "no longer exists" and dropped. A failure, or `startup_failure` with no jobs ("main is
broken"), becomes a fix item under *Outstanding work* through the docs index pass.

## 6. Index pass, after each merge

Keep at most one index-pass PR open per repo. Check `gh pr list --search
"chore/docs-index in:head"` first: if one is open, add the newly merged slice numbers
to it (same branch and worktree) instead of opening a second, and merge it before
starting another. Otherwise, on a fresh `chore/docs-index-<slug>` worktree from
`origin/main`, dispatch `update-docs` in **index** mode with the merged slice numbers. It sets each one's
status row (built, PR), copies the `Not yet verified` items into `docs/plan/unverified.md` (not `plan.md`) and updates the count line in *Outstanding work*,
lifts each `For CLAUDE.md` / `For README.md` block into those files, and marks the
blocks as lifted. Ship and merge that PR the same way (docs-only, no gate needed). Its
body still needs a `## Test plan` (e.g. `- [x] docs only`; claim a link check only if you ran one; every ticked line
carries its result, counts or exit code, or ship-branch unticks it as "not run"), or merge mode
refuses it. Merge plan and docs PRs first, as soon as they're green, and never hold
any PR (docs or code) for a release or deploy run on `main`: merges of this skill start none
(`batch release: yes`), and a run another merge started is never waited on (2026-10-26: two green
PRs were held ~40 min for an iOS release build). The index-pass PR merges with `batch release: yes` too.
Several merges in a row share one index pass: when another slice is through the gate and
will merge soon, wait for it and index both, rather than one pass per merge (each pass is
an update-docs, a ship-branch and a mirror). Then (optional) refresh your docs mirror with a `_STATUS.md`
body file you wrote: the whole-project snapshot with its `## Where it's live` section read from the stores
(the `_STATUS.md` bullet), then merged PRs, open claims, what is next (an old body without
that section is refused, so write one); with none, the mirror keeps the
old body under a new header (2026-11-01: both mirrors of a night showed a stale body).
Merge a docs PR only when every check is green, including ones that look unrelated;
a pending check is not green. (2026-10-29: a docs PR merged with `test-downloads` pending.)

## 7. Close the wave

Run the batched release first (section 5, *Batched release*): `release`, then `watch`, unless the
`run-all-waves` driver started this session. Then the steps below.

Before removing a worktree, grep its slice file for paths inside that worktree (`tmp/...`): move
each cited file to `<repo>-worktrees/reviews/` and fix the path, or the evidence goes with the
worktree (2026-11-01: Slice 233 cited `tmp/diag/state.txt`, deleted at close). Copy every `tmp/*.log` the slice file
cites to `<repo>-worktrees/reviews/<wave>-device/` (and fix the cited path) before `worktree remove`, including `--force`
(wave 2 of 2026-11-07 lost Slice 308's logs that way).
A wave report's "live" or "not live" line quotes the read made in that turn (the deployments list, the migrations list), never
an earlier turn's belief (night 2026-11-17-1216: two reports said migrations waited for a release that had deployed).
The report's count of fixed and skipped findings is read from the findings files and their skip lines
(`node ~/.claude/skills/feedback-loop/check-review-skips.mjs`), never from memory (wave 2 said 21 fixed; the files show 19 applied of 27).
Before the wave report says "parked", "not merged" or "nothing merged" about any PR, read its live state
(`gh pr view <n> --json state,mergedAt`) for every PR the wave claimed: another session may have taken it over and
merged it (night 2026-11-14-1547 wave 1 reported #1120 and #1122 as parked drafts half an hour after both merged).
Before the wave report lists anything as *Waiting on you*, re-read each parked slice's file and row at `origin/main`
HEAD and drop a wait an interactive session already settled (2026-11-13: wave 3 reported Slices 367 and 370 as
waiting an hour after #1081 and #1082 had settled both).
When every slice is merged or parked: check each agent's `released:` line, **list the
agents still running yourself** and stop or wait for each (a `released:` line covers what
an agent started, not whether a fixer or reviewer you dispatched is still going), and stop
any timer you armed. Only then say nothing is left running. **Check the `released:` line
against the disk, not from memory:** `ls <repo>-worktrees` and list every file or folder this
wave made that is still there (scratch folders, run logs, an empty worktree folder) as `left: ...`
with why; the next housekeeping removes them. (2026-10-31: a report said the scratch folders were
released while four were still on disk.) A leftover process is named with its owner, never
"probably": `Get-CimInstance Win32_Process -Filter "Name='dotnet.exe'"` gives each one's command
line and start time. **List leftover MSBuild nodes too:** run `Get-CimInstance Win32_Process -Filter "Name='dotnet.exe'"`
and keep the rows whose command line has `/nodeReuse:true` (or `MSBuild.dll`) and that started during this wave; name each
in the report with its start time and owner, and say it is another session's when it is, never stopping it (wave 6
left four, unclaimed; wave 1 of 2026-11-14 left three, and about 15 more came from a starter's fixers); run the same
listing after each batch of builders or fixers too, not only at close, and only to name them: never stop one on that
evidence alone (a shared build server may serve another session; the release rule still applies). (2026-11-01: three `dotnet.exe` were
left as "likely build servers", unchecked). Do the same for `adb.exe` and the shell scripts that start
it: an `adb ... logcat` (or `bash.exe <worktree>/tmp/...`) whose command line names this wave's device
serial or worktree was started by this wave's agents, so stop it (not the `adb fork-server`); one you
cannot tie to this wave is named, not stopped (2026-11-01: two `adb logcat` readers started at 12:07 by
wave 2's `tmp/diag/cap.sh` were still running five hours later). (2026-10-29: the wrap-up said
nothing ran while a fixer still did.) Then remove the clean worktrees you created, after leaving the folder in an **earlier** tool call (`cd <repo root>` on its own, then `git -C <repo root> worktree remove <path>` in the next call): a session whose last call ended inside the folder holds it, and the removal fails with "Permission denied", even when the same command `cd`s out first (2026-10-31: four times in two nights; `cd` and remove in one command failed, a separate `cd` call first worked; cause likely, not proven) (a lock
means a process is still holding it: name it with `pwsh -NoProfile -File ~/.claude/skills/run-wave/folder-holders.ps1 -Path <folder>` (open files, command lines, programs; it stops nothing; exit 3 = none found but the check was partial, so it does not clear the folder; Slice 307), stop it if this wave started it, else name
it in the report). For a deep worktree on Windows (.NET `obj`/`bin` folders, paths near
260 characters) use `git -c core.longpaths=true worktree remove <path>`; never a
`robocopy /MIR` purge or `Remove-Item -Recurse` (2026-10-31: a purge was blocked by the harness
as a delete under the shared worktrees folder). Run `git worktree prune` after. **Then clean up after the wave:**
`node ~/.claude/skills/run-all-waves/clean-stale.mjs --wave <repo>-worktrees --worktrees <this wave's worktree folder names, comma separated> --temp <temp dir>`
deletes the build-cache entries (`<repo>-worktrees/_builds/*`) recorded by those worktrees (never one a live process holds, `packs` or `.building-*`), which the wave is done with, and
the old temp build files (`--dry-run` shows the list first). Read its one JSON line; a nonzero `failed` is reported as
`left: ...`. Under `run-all-waves` the driver does this after every wave. (User, 2026-11-08: the owner asked that rules and
skills make each wave clean up after itself. D: hit 0 bytes with 35 GB of `_builds` entries from
10 days earlier.) Run
`archive-docs` if `node ~/.claude/skills/archive-docs/doc-budget.mjs <repo>` exits 1 (plan.md over 50,000 bytes or the root `CLAUDE.md` over 20,000; now, between
waves, never during one), and report a table to the user: slice, PR, merged or
parked (with why). **Read each slice's status line from `origin/main:plan.md` in that turn (after `git fetch`) and quote it**;
never say a slice "goes to the next wave" or was parked "as you asked" from memory (wave 1 said so of a slice it had parked itself).

**Board report for a parked slice** (any park above or in the wave report, after reading its live state): run
`board.mjs report-progress --slice <N> --type slice --title "<plan table title>" --status blocked --why "<what it waits for>"`, and when it waits on the user also
`board.mjs report-progress --tool ask_human --slice <N> --waiting --title "Waiting on you: <slice title>" --why "<the question>"`
(key and fields in the plugin skill `agent-board`; `board.mjs` is `node ~/.claude/skills/run-wave/board.mjs`). Never report a slice parked from the ledger alone.

Before that report, clear every slice's *Not yet verified* items (in `docs/plan/unverified.md`) yourself:
- Run follow-up workflows with `gh workflow run` and verify their output.
- Dispatch the `device-test` agent for device acceptance (local emulator or desktop),
  giving it the worktree, the build flags from the repo's memory or CLAUDE.md, and the
  slice's checklist. Don't do it yourself.
- Check store and console state by reading the public pages or APIs.
- Never change live production state (deployed config, buckets, listings) to make a
  check possible. Ask the user first, or plan a debug-only override as a follow-up.

Record the results in the slice files. Only items that need the user's own login or
signature go in the report, each checked first against live state. If
an item turns out already correct or not worth doing yet, report it as closed, not as a
chore. Leftovers that change nothing (a lock file that already reads "free", a stale tmp
file the next run overwrites) are not user items: leave them or clean them yourself.
(2026-10-29: the user was told they "may delete" two lock files that worked as they were.)

**Last step of the wave:** after the report, run `/feedback-loop` over this wave's session(s),
before any `/compact` or the next wave: its tooling fixes then apply to the next wave. (Under
`run-all-waves`, the wave session skips this: the driver runs one feedback loop at the end of all waves.)

## The implementation gate in full (moved from ~/.claude/CLAUDE.md, "Implementation workflow")

For any request to **implement** code, nothing is committed, pushed or PR'd until this gate has run. Order is fixed: **fast tests after every build, then two reviews, then devices, then fix what devices find.** No device run before both reviews.

1. Implement via `implement-slice` when the design is written down; after each build only fast checks (typecheck, lint, unit, integration without a device). It writes the scripted device checks but doesn't run them.
2. `code-review-pass` agent, level `high`, with the **worktree path**. Read every finding.
3. Triage; hand correctness, crash, data-loss, security, privacy and loading-state findings (not style or speculation) to `fix-review-findings`. Two failed fixes in one area mean a design problem: redesign (*Two strikes*).
4. `code-review-pass` agent, level `medium`, dispatched with Agent `effort: medium` (fresh pass, worktree path).
5. Fix those the same way.
6. Device and desktop runs (`device-test`), only those the change touches, on the reviewed code. **Each run stops at 10 minutes and runs only scripted flows.** Shared UI is checked on the Android emulator; the VM only for Windows-specific code or layout. What a run didn't reach goes to the slice's *Not yet verified*, each line tagged with who runs it (`[chrome]`, `[session]`, `[phone]`, `[cloud]`, `[chat]`, `[owner]`); never a second run to cover it. **A "not yet verified" check that any tool can reach (Chrome on the live site, a real Claude Code session, the test phone under the lease, a cloud session) is run by the run that wrote it, after its release (the driver's live-checks session), and is never left for the owner: only judgment and the owner's own accounts are theirs** (Slice 31).
7. Fix what devices report, re-run only the failed or touched checks.
8. `run-checks`, `update-docs` (slice mode, your brief), then `ship-branch`. The `merge-gate.mjs` hook needs a `## Review` section listing both findings files (written by the reviewer agents) and waits on checks (`gh pr checks <n> --watch --fail-fast && gh pr merge ...`). After merge, the index pass.

Never invoke `code-review` from the main thread, never without the worktree path. A pass with no findings: say so and move on. The gate does not apply to questions, read-only investigation or doc-only edits.

## Parallel work in full (moved from ~/.claude/CLAUDE.md, "Parallel work")

One session runs a wave of 3-4 slices with `run-wave` (unattended until done: `run-all-waves`, never waves looped inside one session); a session not running a wave is not bound by another session's wave limits (claims still required, cloud clashes still refused).

1. Every planned slice has a `**Touches:**` line; none, no parallel start. Run `parallel-check` before starting while other work may be live.
2. **Claim with a draft PR before any code** (`ship-branch` claim mode), with `**Migrations:** NNNN` from `parallel-check`.
3. A feature branch edits only its own slice file; `plan.md`, `CLAUDE.md` and `README.md` change in one `update-docs` index pass on a `chore/docs-index-*` branch. Shared append-only files: add inside your feature's own block.
4. Merge when green, one at a time, via `ship-branch`, without asking; never squash. Standing authorization (settings.example.json, 2026-10-19) for PRs that passed the full gate only.
5. A hand-run wave ends with `/feedback-loop` before `/compact` or the next wave; the wave ledger and its hooks are in this skill.
6. Big code-only slices can be written by a Claude Code cloud session (placement, nightly cap, run ids): section 3, *Cloud slices*.

Memory holds lessons, not status: `plan.md`'s table and the board are the record of status.

## Background agents: the 10-minute check (moved from ~/.claude/CLAUDE.md)

Whoever starts a background agent or long background command checks it every 10 minutes until it finishes; silence is never "still fine".

- **Arm one timer** after dispatching: background Bash `sleep 600` with `timeout: 660000`, started after a separate `cd <repo root>` call (in an earlier message, not the same one), never from inside a worktree. Re-arm after each check, and at once if the harness kills it.
- **Each check reads the work itself**, not a sign it began: the tail of the agent's output against the last check; for device work the app's newest log line by pid and the phone's wake and charge state; for CI the run's status. "Installed", "started" or an empty output file is not progress.
- **Healthy agents keep going**; only the user stops one. Never `TaskStop` a moving agent or a run the user started to finish sooner; report it as `left running`. **Stuck** (nothing new, same poll, waiting on something gone): one `SendMessage` with the missing fact; still stuck at the next check, `TaskStop` and redispatch; tell the user in one line.
- **Work that must outlive the session** is started detached (`run-all-waves/start-detached.ps1`), never as a background command. When the user is away and approved work dies, restart it the same way at once (once) and tell them afterwards; never wait on an absent user.
- **The user is never without news for more than one check:** each check ends with one line (what runs, what it found, what's next). Asked "when will you finish", the first line is the work left and an estimate in minutes from state read in that turn. Any time estimate says what it rests on (rounds so far, a measured run time); once it has slipped twice, the next message gives the work left, not a new time.
- Every brief that waits on something external names what counts as done, failed, cancelled or superseded, and a maximum wait.
- **Write files with Write or Edit, not shell heredocs, when the text has backslashes, `$` or non-ASCII** (`shell-write-guard.mjs` enforces the worst cases). Check line endings with `node ~/.claude/skills/feedback-loop/line-endings.mjs <files>`.

## Merge, deploy and release rules (held only in `pr-conventions`)

See `pr-conventions`, *Commit and push rules*: auto-merge in one command, fast-forward the primary checkout after every merge, production changes only through the pipeline, and confirm the deploy ran.
