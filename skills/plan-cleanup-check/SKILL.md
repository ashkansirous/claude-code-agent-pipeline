---
name: plan-cleanup-check
description: Check ONE open plan slice (its docs/plan/slices/ file and its plan.md row) or ONE plan.md *Outstanding work* line against live state, and fix the record - every wait is checked (the date, the other slice, the store review, the CI run, the user's own report in past sessions), every claim is checked against origin/main code, gh and the stores' read APIs, items added later that are not the slice's own work (tooling gaps, side findings, review follow-ups) are moved out, and no slice is left waiting on an outside event. Ends with a verdict (close, keep open with the real remaining items, or rewrite the line) and an index block for plan.md. Run by the plan-cleanup agent, one target per agent; the plan-cleanup skill dispatches them.
---

# Check one plan item against live state

You get a repo or docs worktree path and **one target**: a slice number, or one *Outstanding work* line (quoted).
You fix that target's record in its own slice file and return an index block. You never edit `plan.md`,
`docs/plan/notes/slices-done.md` or `docs/plan/unverified.md` (the caller applies every agent's index block once), never
commit, never ask the user anything, and never change live state (no submission, promotion, deploy, merge, store write
or settings change: read-only API calls only; opening and deleting an uncommitted Play edit counts as read-only).

**Why this exists (2026-11-24/25, ReadTheStupidText):** a session answered "what is remaining" by repeating
plan lines. It said version 1.133.1 was waiting when 1.136 was live, that iOS card states and Fix payment were not
built when they were, and that Slice 283 waited on "a real play" a day after the user had played it and reported
its bugs. It also kept Slices 350, 402, 412, 418 and 346 open over side notes, tooling gaps and store waits that were
not their work. Every one of those was checkable with a tool.

## The rules this check enforces

1. **A wait is checked, never repeated.** Every "waits for", "after", "once", "blocked by", "needs", "parked" is
   checked live in this run (table below). Report what you read and when, never the old line.
2. **A claim is checked, never repeated.** Every statement of fact in the row, the status line, the open items and
   the *Not yet verified* lines ("not built", "suite red on main", "X is live", "Apple refuses", "the script never
   writes Y") is checked against `origin/main` and the live system. A wrong claim is rewritten with the evidence or
   removed.
3. **A slice holds only its own work.** Its own work is what its title, *Why*, *Decisions* and original work items
   asked for. Anything added later that is not that work never keeps the slice open. That covers tooling gaps,
   "found while building", side findings, review follow-ups, "also noticed", parity notes for another platform the
   slice did not promise, and checks of another slice's code. Move each one out:
   - real work becomes a proposed new slice **without a number** (parallel agents cannot reserve one): write its
     body to `<worktree parent>/plan-cleanup/<target>-new-<n>.md` and list its title, product and that path under
     `new-slices:` in the index block; the single index pass numbers it and writes the slice file. Or it goes to an
     existing slice that owns it (name it);
   - a small item becomes one *Outstanding work* line in the index block;
   - an item that is already done, obsolete or superseded is dropped, with the evidence.
4. **No slice waits on an outside event.** A started slice must be closable within hours. No work item may wait on
   a store review or approval, a vendor's reply, a support case, a date, a release reaching users, or another
   session. For each such item:
   - if the event has happened (you read it live), say what you read. The follow-up becomes the item's next
     step, done by the next builder, or its own slice if it is real work;
   - if it has not happened, take it out of the slice and put it in the index block as one *Watch* line: what to
     read, the exact command or URL that reads it, and what to do when it fires. The slice closes when its own work
     is done.

   A slice that has not started may say `**Starts after:** <date or slice>`. That is a start condition, not a wait
   inside the work. An owner step that needs the user's own login or legal declaration is not a wait either. It
   goes in *Outstanding work* with its deep link, and only if `user-says` (below) shows the user never did it.
5. **What the user said or accepted is settled.** Search their own words before calling anything "waits on the
   user". A report, an acceptance or an answer found there is written into the slice file with the date and a quote.
   It is never asked for again.
6. **Unverified device checks never hold a slice.** A *Not yet verified* line stays in `unverified.md`. It is not
   a reason to keep the slice open.

## Steps

1. **Read the target from `origin/main`** (`git fetch origin`, then `git show origin/main:<path>`). Read the slice
   file by section, plus its row in `plan.md`. Note every open item (`- [ ]`, an unticked numbered item, "open",
   "left", "waits", "parked", "follow-up") and every factual claim. Read only the sections you need.
2. **Classify each open item.** Is it the slice's own work (rule 3)? Is it a wait (rule 4)? Which claims does it
   make (rule 2)?
3. **Check each wait and each claim live**, with the cheapest tool that settles it:

   | Kind | How to check |
   | --- | --- |
   | another slice or PR | its row and *Built* lines on `origin/main`; `gh pr view <n> --json state,mergedAt` |
   | a date | compare it with today's date; note how many days are left |
   | code built or not | `git grep -n <symbol> origin/main -- <paths>`; read the excerpt; `git log origin/main -- <path>` |
   | CI, release, tag | `gh run list/view`, `gh release list`, `git tag -l` |
   | App Store state (version, review, screenshots, placements, IAPs) | the repo's own App Store Connect read scripts, else a JWT built from your stored API key and GET calls |
   | Google Play (tracks, listing, products) | the repo's scripts, else the stored service-account key: open an edit, GET, delete the edit |
   | Microsoft Store | the public product page (`web-fetch`) or the repo's Partner Center read script |
   | Worker or site | `curl` of the public URL; `wrangler deployments list` |
   | the user's step, report, test or acceptance | `node ~/.claude/skills/plan-cleanup-check/user-says.mjs --repo <primary repo path> --terms <comma-separated words or short phrases, e.g. sonos,self test>` (each comma piece is one exact phrase; retry with single words before concluding nothing was said), then the slice file and the notes |
   | a vendor reply, support case, portal state no tool can read | say it cannot be read and why; it is a *Watch* line, never inside the slice |

   One check per claim. Keep the command and its one-line result; that is the evidence.
4. **Fix the slice file** (Edit, never a script, in the given worktree):
   - tick each item that is done, with the evidence in a few words;
   - rewrite wrong claims, and quote the user's words where they settle something;
   - move out each item that is not the slice's own work (rule 3) and each outside wait (rule 4);
   - add one dated note under the `**Product:**` line (or the title) saying what this check found and its verdict.
   Never delete history in the file. Mark lines moved or replaced and say where to.
5. **Verdict.** Pick one:
   - **close**: every own-work item is done. Only *Watch* lines, unverified checks and moved items are left;
   - **keep open**: list only the real remaining own-work items, each with its live state;
   - for an *Outstanding work* line: **remove** (done or obsolete), **rewrite** (give the new text) or **move**
     (to slice N).

## Output

Write the index block to the file the caller names (default `<worktree parent>/plan-cleanup/<target>.md`):

```
target: Slice NN | outstanding: "<first 60 chars>"
verdict: close | keep open | remove | rewrite | move
row: <the new status cell for plan.md, or "move to slices-done: <status text>">
outstanding-remove: <first 60 chars of each Outstanding work line about this target that is now stale>
outstanding-add: <each new Watch line or moved small item, full text, with its check command or deep link>
unverified-remove: <exact lines in docs/plan/unverified.md that a live check or the user's report settled>
new-slices: <one per line, no number: "<title> | <RTST, Dino or Shared> | <body file path in the plan-cleanup folder>">
evidence: <one line per check: claim -> command -> result>
```

Then report to the caller in at most 8 lines, verdict first: what was wrong in the record, what you moved out, and
what is really left. End with `released: ...`.
