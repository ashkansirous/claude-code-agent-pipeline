---
name: to-plan
description: "Produce or extend the plan.md at the repo root for a piece of work - the heavier sibling of to-scope. Runs the planning workflow end to end: RefineScope, one slice file per vertical slice with a Touches line, plan.md index row, PR. Use when the user says \"let's plan\", \"make a plan\", \"plan this\", \"to plan\", \"write the plan\", or wants to turn a settled scope.md into an executable plan."
---

This skill produces or extends **`plan.md` at the repo root** — the project's
source-of-truth plan that the user can read, edit, commit, and tick off
during implementation. `plan.md` is a cumulative index (see *Docs layout* in
`~/.claude/CLAUDE.md`), not a per-branch document. It is the heavier sibling of `to-scope` (which writes
the lightweight `scope.md`) and the invokable entry point to the planning
workflow defined in the shared `~/.claude/CLAUDE.md`.

Where it sits in the chain:

- **`to-scope`** → `scope.md` — lightweight synthesis (Goals / Approach /
  Out of Scope / Notes). Optional first pass when the shape is still fuzzy.
- **`to-plan`** → `plan.md` — the full, executable plan (this skill).

Handoff: if the work started as a doc from your own notes store (an inbox of ideas written elsewhere), treat it as already-clarified input — don't
re-ask what it settles. After the PR is open, optionally mirror the new `plan.md` to that store.

You can run `to-scope` first to settle the rough shape, or skip straight to
`to-plan` for small or well-understood work.

## When to use this skill

Use it:

- Whenever the user asks for a plan, in any phrasing — "let's plan", "make a
  plan", "plan this", "to plan", "write the plan", "start a plan for …". If
  you are unsure whether they want a plan or a quick chat, default to using it
  — a stray `plan.md` is cheap; a lost audit trail is not.
- To escalate a settled `scope.md` into an executable `plan.md`.

Do **not** use it:

- For free-form chat that hasn't produced a candidate piece of work yet —
  discuss first, or run `to-scope`.
- To create the GitHub issues — do that *after* `plan.md` exists.

## Process (the planning workflow)

This is the canonical 7-step planning workflow; `~/.claude/CLAUDE.md` keeps only the
trigger and points here.

**Planning from findings** ("plan everything you found", "refine all of them"): work from the
source record (the run note, device report, review files, or the session transcript through
the `feedback-loop` skill's digest), line by line, never from a summary or memory. Every
finding gets a destination (slice item, *Outstanding work*, or "fixed in PR #n"). Never label
a finding "by design" or "known" without the code or a date that proves it, and keep every
caveat a data source gave (date range, filters, sample size) next to the number.

1. **Clarify intent.** Use the `RefineScope` skill — at most 4 high-leverage
   questions, then recommend answers for the rest in one batch. Skip only if
   intent is already crystal clear. If a `scope.md` exists, read it first and
   build on it instead of re-asking what it already settles. Prefer exploring
   the codebase over asking when a question can be answered by reading code.

2. **Branch.** If this is a git repo, first run the `main` guard (default branch must be
   `main`; fix it before branching) and the `branch-sweep` skill. Then create a branch off `main` named
   `plan/<short-slug>` derived from the topic, in a new worktree
   (`git worktree add -b plan/<slug> ../<repo>-worktrees/<slug> origin/main`),
   never by switching the primary checkout, and do every later step there.
   If it is not a git repo, skip
   the branch (do **not** run `git init` without asking) but still continue.

3. **Write `plan.md` at the repo root** in the index shape below, and each new
   slice to its own file. This is the source of truth. **Never overwrite it.**
   Write each new slice in full to `docs/plan/slices/NN-<slug>.md` (the slice
   template below), and add a row for it to the status table (in a repo with one table per product,
   the table named by the slice's `**Product:**` line) linking that file,
   leaving every other slice, row and section as they are. Take `NN` from the
   `parallel-check` agent's "next free slice number" (it counts `plan.md`'s table,
   slice files on `main` and slice files in open PRs), not from PR titles, so two
   planning threads don't pick the same one. A number is reserved only once a PR
   adding its slice file is open, so push the plan PR right after writing the slice
   file, re-run `parallel-check` just before pushing, and if the number was taken in
   the meantime, renumber before pushing. In the same repo too, never guess "last number + 1": take it from
   `parallel_check.py <repo> --check-slice <branch>` (push-branch refuses a guessed number; night 2026-11-17-2023: two
   guesses refused; Slice 22). **A status or decision line attributes to the user only their own words**; a desk decision
   says "decided by <session>", never "owner ..." (a quote that only refused a repeat test was written as the owner's
   plan; Slice 22). When the slice is written for **another repo** (a board or sibling project), take its number
   the same way first: run `parallel-check` (open PRs, worktrees) in that repo and reserve the number there before any file in this repo
   names it (night 2026-11-17-1826: slices numbered 19-23 without that check; AgentPipeline #302 merged with the wrong numbers and cost two
   fix PRs). If `plan.md` doesn't exist,
   create the skeleton below. If the harness also hands you a
   working plan path (e.g. `~/.claude/plans/<slug>.md`), keep the two in sync,
   but the repo-root `plan.md` wins. **Pre-migration `plan.md`** (no status table or *Planned* section):
   if it is under ~50 KB, convert it to the index shape in place first. Existing
   slices move to their own files with `archive_docs.py move`, every slice gets a
   row by its own status line, and nothing is dropped. If it is over ~50 KB, stop and tell the caller to
   run `archive-docs` first.

4. **Reflect the plan.** If it introduces new conventions, commands, or
   behaviors, update `CLAUDE.md` (the nearest folder-scoped one for the area, root only
   for repo-wide rules; add a rule only if an agent would get it wrong without it). If it changes user-facing behavior or
   install steps, update `README.md`. If neither applies, leave them alone.

5. **Commit and push.** Only if this is a git repo. One commit per logical
   step (the plan itself, then each reflection). Push with `-u`. Do not stop to
   ask first: pushing a short-lived branch is reversible and reviewable. Write the
   commit messages and PR text yourself, then hand steps 5 and 6 to `ship-branch`.

6. **Open a PR** against `main`. Only if the repo has a remote. Title from the
   slug; body = a 1–3 line summary plus a checklist of the in-scope items. Open it
   automatically and report the URL. See `pr-conventions` for the body rules.

7. **Mirror (optional).** Copy the new `plan.md` (and
   any `CLAUDE.md`/`README.md`/`docs/plan/` change) to your own notes store, if you keep one.

**A fix slice for a behaviour the user complained about** starts with a search of the slice and decision files
(`docs/plan/slices/`, `docs/plan/decisions.md`, `docs/plan/notes/`) for the user's own rule on that behaviour, and
the slice quotes it (2026-11-13: Slice 360 was first written without Slice 267's rule).

**A slice that fixes a bug inside a third-party library or model** starts with one `web-research`
search of that project's issue tracker, written into the slice before any design (2026-11-01,
ReadTheStupidText Slice 220: two designs failed before one search found sherpa-onnx #4086).

## Vertical slices over horizontal layers

Order the **Changes** by vertical slice, not by layer. The first chunk should
be the smallest end-to-end change that produces user-visible value (migration
+ service + endpoint + UI for *one* thing), not "all migrations, then all
services, then all UI". Name the exception in the plan if pure infrastructure
or a cross-layer refactor genuinely warrants a horizontal cut.

For a new app with a UI (mobile or desktop), the first UI slice also carries the device-test
pipeline (`device-test-pipeline`): Debug test hooks and log markers, a headless scripted flow
for that screen, the touched-apps selector and build cache, and the device locks. Later
slices each add their screen's flow. Don't plan it as a "speed up tests" slice later.

## Template: the index skeleton

```markdown
# Plan: <project>

<Two to five lines: what the project is and why. The one rule everything serves,
if there is one.>

## Status

| Slice | Title | Status | PR | Issue | File |
| --- | --- | --- | --- | --- | --- |
| 1 | <title> | planned | | | |

Notes: _(none yet; `docs/plan/notes/YYYY-MM-DD-<slug>.md`, one line each)_

## Outstanding work

- **Not yet tried on a device:** 0 checks across 0 slices[ (<Product> 0, ...) when unverified.md has per-product headings], in [docs/plan/unverified.md](docs/plan/unverified.md).

_(Open gaps, review leftovers, human-only blockers. One or two lines each, linking the slice
file. Not-yet-verified device checks live in `docs/plan/unverified.md`, not here.)_

## Out of Scope

Things explicitly NOT being done — especially things a reader might
reasonably assume are included.
```

## Template: a slice file (`docs/plan/slices/NN-<slug>.md`)

```markdown
### Slice NN — <title>
**Product:** <RTST | Dino | Shared, only in a repo whose plan.md has one status table per product; the project's own names>

*Planned.*

**Touches:** `<path or glob>`, `<path or glob>`, …

**Replaces:** <only when the slice replaces a component: each behaviour and setting of the old one with its default, and where the new one covers it; otherwise omit the line>

Why, decisions locked with the user, then the work as `- [ ]` items, the first
sub-slice being the smallest end-to-end thing that works. Add **Verification**: the
commands, tests or manual steps that show it works.
```

**Replaces line.** A slice that swaps one component for another (a reporter for a plugin, a script for a hook)
lists every behaviour and default of the old one under `**Replaces:**`, read from the old code or git history, each
with where the new one covers it or "dropped on purpose"; `implement-slice` checks each before the old part goes
(Slice 20's swap lost the cap reading until Slice 25; Slice 29 item 8).

**A premise about Claude Code or cloud behaviour is checked at plan time.** When a slice rests on how the harness, a
hook, a plugin, a settings file or a cloud session behaves, run a `claude-code-guide` (or `library-docs`) check
against the docs before the slice is written, and cite the answer in the slice. (Slice 27 assumed cloud sessions read
user-level hooks, which the docs contradict; the owner was told "nothing else is needed" first; Slice 29 item 11.)

**A request to set something up is done when live data shows it works.** A slice that sets up a label, variable,
connector or setting has a Verification that reads live data (the board, the API, the store) proving it took effect;
page text or a guide for the owner is not the fix (Slice 29 item 18: the first cloud-label slice shipped text and a
guide, and the owner had asked a day earlier to have it set).

**A slice closes within hours of starting.** No work item waits on an outside event: a store review or approval,
a vendor's reply, a support case, a date, or a release reaching users. Such a wait goes to *Outstanding work* as a
*Watch* line, with the command or URL that reads it and what to do when it fires. A slice that cannot start yet
says `**Starts after:** <date or slice>`. Later, while building, a tooling gap, side finding or review follow-up is
never added to the slice as an open item. It becomes its own slice or an *Outstanding work* line, so it never holds
the slice open (`plan-cleanup-check`; 2026-11-25: Slices 350, 402 and 418 stayed open days over such lines).

**Product line.** When `plan.md`'s *Status* section has one table per product (`### <product>` headings),
every slice file carries a `**Product:**` line directly under its title, and the slice's row goes into
the table of that product (shared work, with no single owner, goes in the Shared table). The line sits
right under the title so it never touches the status line below it.

**Android and iOS parity.** If the app ships on Android and iOS, every slice that
changes what it does has an Android task and an iOS task, and its **Verification**
covers both (`~/.claude/CLAUDE.md`, *Android and iOS are the same app*). A slice that
leaves one of them out needs the user's explicit exemption, written into the slice.

**Touches** lists every repo-relative path or glob the slice will edit, hub files
included (the ones every feature edits), and `migrations/*` if it adds a migration.
`parallel-check` reads it to decide what can run alongside other work, so check the
paths exist (or will be created) and name them as tightly as you honestly can.
A path or folder the slice creates is marked `(new)` after it, and before the plan PR is shipped the
slice file passes the `--check-slice` check described in `parallel-check` (the push script refuses a
Touches path that neither exists nor is marked; 2026-11-16: a plan PR was refused for one unmarked new folder).
When two slices (or two parts of one) would edit the same files, split them now into parts whose
Touches don't overlap (a new file per part for the shared logic), so a wave can run them together;
splitting only at claim time cost a night two serial waves (night 2026-11-01-2355: 232 E then 234 A,
106 minutes, while wave 5 ran three narrowed parts at once).
An ask to make something faster gets a work item that changes it and reports before/after numbers;
a measuring item alone never closes it (night 2026-11-01-2355: Slice 247 measured the slow emulator
flows and the user, who had asked twice, still had no faster tests).
Then read every folder-scoped `CLAUDE.md` on the way from the repo root down to each
Touches path, and check the slice's tasks against their rules before you write them
(2026-11-01, ReadTheStupidText: a plan put Dino's Done button on the left for Farsi and
Arabic, breaking `src/DinoReader.App/CLAUDE.md`'s "never mirror" rule; the user caught it).

## Keeping `plan.md` honest

During implementation, tick off items (`- [x]`) in the slice's file as they
complete and record any scope changes the user agrees to. When a slice is built,
`update-docs` records it in that file; after the merge, its index pass updates the
status row, `docs/plan/unverified.md` and the count line in *Outstanding work*. The plan plus those files are the record of what
was built; a slice file is never deleted.

After writing `plan.md`, if the conversation has no good, descriptive name,
tell the user to run `/rename` and suggest a topic-relevant name. `/rename` is
UI-only and cannot be invoked by the agent — just prompt the user.

## Planning and docs rules (moved from ~/.claude/CLAUDE.md, "Planning workflow" and "Docs layout")

When the user asks for a plan (`let's plan`, `make a plan`, `plan this`, `/RefineScope` with planning-shaped arguments; if unsure, treat it as one), load this skill. Check your notes inbox first, if you keep one. `plan.md` is the source of truth, never overwritten. Push and open the PR automatically. During implementation tick items off in the slice file; the PR closes the slice's story and done sub-tasks (`pr-conventions`).

**A plan cleanup runs only when the user asks for one** ("plan cleanup", "clean up the plan") **or at the end of `run-all-waves`** (once all waves are built, before its feedback loop); then load `plan-cleanup`. "What is remaining" or a summary of the plan is answered from `plan.md` and the slice files, never by starting a cleanup (user, 2026-11-25: the owner asks for it explicitly). A slice holds only its own work: tooling gaps, side findings and review follow-ups go to their own slice or *Outstanding work*. A started slice never waits on an outside event (a store review, a vendor reply, a date). Such a wait becomes a *Watch* line, so the slice closes within hours (2026-11-25, ReadTheStupidText Slices 283, 350, 397, 402).

The docs layout (`plan.md` as an index, one file per slice, `unverified.md`) and its lifecycle (finished rows to `slices-done.md`, passed checks out of `unverified.md`, `verified` marking, over-budget handling) are defined only in the `archive-docs` skill, *Docs layout and lifecycle*.
