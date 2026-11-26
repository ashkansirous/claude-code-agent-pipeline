---
name: parallel-check
description: Show which work is live in a repo right now (open PRs, drafts and worktrees with changes) and which planned slices can start alongside it without editing the same code, plus the next free database migration number. Compares each slice's **Touches:** line with live work's changed files, and trial-merges committed branches to tell real conflicts from shared files. Use before starting any slice while other sessions may be working, when the user asks "what can I run in parallel", "what else can I start", "is anyone working on X", and at the start of every run-wave.
---

The script is `~/.claude/skills/parallel-check/parallel_check.py` (stdlib only). Run it
from anywhere; it reads `origin/main`, never the checkout:

```bash
python -I ~/.claude/skills/parallel-check/parallel_check.py <repo> --slices 50 51 52
```

Leave out `--slices` to see only the live work and migration numbers. Pass extra
`--shared <glob>` patterns, or list them one per line in the repo's
`.claude/parallel-shared.txt`, for files every slice appends to that aren't covered
by the defaults (`plan.md`, `CLAUDE.md`, `README.md`, `AGENTS.md`, `docs/*`,
locale and i18n files).

## What it reads

- **Each candidate slice's `**Touches:**` line.** It's in the slice's file
  (`docs/plan/slices/NN-*.md`), or its section in `plan.md` for an older repo. It's a
  line of backticked repo-relative paths or globs, which may be hard-wrapped (the
  continuation lines count until a blank line or a line starting with `**`, `#`,
  `- ` or `* `). A path ending in `/` means everything under that folder. A glob that
  starts with a wildcard (`**/*.test.ts`) is compared by pattern match only:
  `` **Touches:** `src/messages/**`, `worker/room.ts`, `migrations/*`, `src/i18n/locales/*.json` ``.
  Name the hub files (the ones every feature edits, like `useCall.ts`) too: an honest
  overlap is better than a surprise. A slice with no Touches line is reported as
  `UNKNOWN` and never counted as safe.
- **Sub-slice ids** such as `27a` or `41e` work in `--slices`: the leading digits pick
  the slice file and the `Slice 27` section of `plan.md`. A missing `plan.md` on
  `origin/main` just means "not found".
- **Claimed slices.** If an open PR already holds `docs/plan/slices/NN-*` among its
  changed files, the slice is read from that PR's branch, labelled
  `Slice N (claimed by PR #X)`, and that PR is left out of its comparisons (it is the
  same work).
- **`**Migrations:** 0010`**: a migration number the slice has claimed.
- **Live work.** Every open PR (its changed files, plus a Touches and Migrations line in
  its body if it has them), and every worktree with changes against `origin/main`. A worktree on a branch with
  an open PR adds its uncommitted files (new folders listed file by file) to that PR
  and marks it dirty, so it is "uncommitted so not trial-merged", never "merges
  cleanly". A worktree whose PR is closed or merged counts only while it has
  uncommitted changes. A **draft not updated for 24 hours** counts only its changed files, not the
  Touches line in its body, and its label says so: an idle claim (a parked slice's old draft, the
  user's own lane) no longer holds other slices back by declaration alone (2026-11-01: drafts #638
  and #435 held back 8 of 13 planned slices; #435 changed one file). Its real diff still collides.

## What it prints

1. **Active work**: one line each.
2. **Slices**: `next free number N`, one more than the highest slice number in
   `plan.md`'s status table and `docs/plan/notes/slices-done.md` on `origin/main`, the slice files on `origin/main` and
   the slice files in any open PR, **draft PRs included** (a draft claim PR holds its number), other worktrees and local or pushed branches that add one, and suffixed ids such as `212a`. To check a branch before pushing, run `python -I ~/.claude/skills/parallel-check/parallel_check.py <worktree> --check-slice <branch>`: it exits 1 and names the holder when a slice file the branch adds uses a taken id (the branch's own PR does not count), and also when a Touches line the branch adds names a folder that does not exist (an entry rooted in a real top-level folder; write `(new)` after a path whose folder the slice creates; 2026-11-01: two claims named `tools/emulator/flows/**`, which never existed). `to-plan` takes its new slice number from it. Run the script's tests from the repo root with `python -m unittest discover -s skills/parallel-check`.
3. **Migrations**: the next free number counting `main`, every branch and every
   claim, and any number two pieces of work both use (`COLLISION`).
4. **Overlaps among active work.** When both branches are fully committed, a trial
   `git merge-tree` says whether they really conflict or only share a file. Otherwise
   it says "uncommitted so not trial-merged".
5. **Candidate overlaps.** `CONFLICT` means the same code. `shared` means shared
   append-only files, so add your entries in your own block (see *Parallel work* in
   `~/.claude/CLAUDE.md`).
6. **Safe to start together**: candidates taken greedily in the order given, each
   clear of all live work and of the candidates already taken.

## Reading the result

A `CONFLICT` on a hub file isn't automatically a no. Two slices that each add a few
lines to `useCall.ts` usually merge cleanly. Say so to the user and let them decide,
or sequence the pair. A conflict on a file that's the core of both slices (the same
store, the same migration table) means sequencing. Uncommitted worktree changes are
invisible to the trial merge, which is one more reason to commit early in a draft PR.
Report the list, not the raw output, unless the user asks for it.
