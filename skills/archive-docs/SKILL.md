---
name: archive-docs
description: Keep a repo's plan.md and CLAUDE.md small by moving finished work into one file per slice under docs/plan/. Use when plan.md is over ~50 KB or CLAUDE.md over ~20 KB, when the Drive mirror falls back to an outline, on "split the plan", "archive the plan", "plan.md is too big", "trim CLAUDE.md", or to migrate an older repo to the docs layout.
---

This skill owns the docs layout and lifecycle (*Docs layout and lifecycle* below; `to-plan` and `update-docs` point here). It is also the
one-off migration of a repo that predates it, and the catch-up when a repo
drifts over budget. Day-to-day, `update-docs` moves each slice out as it's built, so
this skill shouldn't be needed often.

## Docs layout and lifecycle

```
plan.md                                index, budget ~50 KB
CLAUDE.md (root)                       rules, commands, architecture map, budget ~20 KB
<folder>/CLAUDE.md                     rules for one area, loaded only when working there
docs/plan/slices/NN-<slug>.md          one per slice, its full record
docs/plan/notes/YYYY-MM-DD-<slug>.md   investigations, incidents, design passes no slice owns
docs/plan/unverified.md                every open "Not yet verified" line, one block per slice
```

- `plan.md` holds a short summary, a status table of **open slices only**, *Outstanding work* (first bullet is the "Not yet tried on a device" count line pointing at unverified.md) and a short out-of-scope list.
- Lifecycle: a built slice's finished row moves to `docs/plan/notes/slices-done.md` (steps below; `update-docs` does it per slice). A check that passes on a device, or that the user confirms, is removed from unverified.md (count updated) and the slice marked `verified` (`agents/update-docs.md`, the *verified* brief).
- **Rules, not history.** A CLAUDE.md rule is the constraint and the file to look in, plus a link to its slice file. Incidents go in slice or note files.
- Put a rule in the nearest folder-scoped `CLAUDE.md`, only if an agent would get it wrong without it.
- **A user's answer to a human step is written down in the same turn** (slice file and *Outstanding work*, in a docs PR).
- Over budget: run this skill (not while parallel branches are open).

Work in a worktree on a `chore/<slug>` branch from `main`, like any other change. Every
move is verbatim: this skill never rewrites a slice's history, only relocates it. The
only new prose is `plan.md`'s index and `CLAUDE.md`'s shortened rules.

The script is `~/.claude/skills/archive-docs/archive_docs.py` (stdlib only; run it with
`python -I`). Keep its manifests and copies in the scratchpad, not in the repo.

## 1. Split `plan.md`

1. Copy the current `plan.md` to the scratchpad as `plan.orig.md`.
2. `archive_docs.py propose plan.md <scratch>/manifest.json` prints one line per segment
   with its proposed target:
   - `keep` (stays in `plan.md`): the preamble and out-of-scope. Planned and
     in-progress slices also start as `keep` (their first status lines say "not built"
     or don't say built, shipped or merged at all); change each to its
     `docs/plan/slices/NN-<slug>.md` target too, since no slice text stays in
     `plan.md` (*Docs layout and lifecycle* above), unless an open PR is editing that slice right now. A
     positive built/shipped/merged moves the slice even if "planned" or "in progress"
     also appears. If any section of a slice number is `keep`, all of that number's
     sections are (a slice is never split between `plan.md` and `docs/plan/`).
   - `docs/plan/slices/NN-<slug>.md`: every other slice. A second section for the same
     slice number (e.g. `## Slice 0 results`) joins the first one's file.
   - `docs/plan/notes/<date>-<slug>.md`: every other `##` section.
3. **Review the manifest; it's a heuristic.** Edit `target` where it's wrong:
   - A planned or in-progress slice moves to its own file like any other (status line
     unchanged), except one an open PR is editing in `plan.md`: that one stays `keep`
     and moves when its branch is claimed or merged.
   - A built slice moves, even while its PR is still open. Its unverified items go to
     `docs/plan/unverified.md` in step 3 below.
   - A note that belongs to one slice (a follow-up, its own bug write-up) joins that
     slice's file.
   - Fix ugly slugs. Keep them short and kebab-case, numbers padded to two digits.
   - A stray `##` heading that is really a continuation of the section above (a broken
     heading) gets the same target as that section.
4. `archive_docs.py apply plan.md <scratch>/manifest.json <repo-root>` writes the files
   and leaves only the `keep` segments in `plan.md`, with their original spacing and
   the file's line endings (CRLF stays CRLF). It first checks that the manifest tiles
   `plan.md` (each segment starts right after the previous, the last ends at the end
   of the file) and exits before writing if not, and checks every target and exits
   if one already exists. It writes `plan.md.bak` (the pre-apply `plan.md`) before
   rewriting; delete it before committing. Restoring from it is the fastest undo. For the **catch-up** case (a
   repo that already has `docs/plan/` files, e.g. a slice file `update-docs` made),
   add `--append`: segments are added to the existing file, whose prior text is kept
   in `<manifest>.prior.json` next to the manifest, with the list of files apply
   created.
   To move just one slice (what `update-docs` does when a slice is built), use
   `archive_docs.py move plan.md <N> <repo-root> [<target>]`: all of slice N's
   sections go verbatim to `docs/plan/slices/NN-<slug>.md` (appended to if it exists),
   with the same tiling check and `plan.md.bak`. It prints the target path.
5. `archive_docs.py verify <scratch>/plan.orig.md <repo-root> <scratch>/manifest.json`
   must print `ok`. If it doesn't, restore `plan.md` from the copy, delete **only the
   files apply created** (the `created` list in `<manifest>.prior.json`; never the whole
   `docs/plan/`), put each pre-existing target back to its `prior` text, fix the
   manifest, and start again.

## 2. Write the index

Rewrite what's left in `plan.md` into the index shape from *Docs layout and lifecycle* above:

1. A summary of two to five lines, plus the one rule if the repo has one. Move the
   long problem/architecture sections to `docs/plan/notes/background.md` if they're
   more than a screen; CLAUDE.md already covers architecture.
2. **Status table**: one row per **open** slice (`planned` or `in progress`), in number
   order. Columns: slice, title, status, PR, story issue, file link. Rows of `built` and
   `verified` slices go to `docs/plan/notes/slices-done.md` (same columns, links as
   `../slices/...`), along with the lane-order paragraphs of batches with no open slice;
   those batches' *Out of Scope* lines go to `docs/plan/notes/out-of-scope-history.md`.
   Take status and PR from each slice's own status line, never from a guess.
   If the slice files carry a `**Product:**` line, keep one table per product under
   `### <product>` headings (and the same headings in `slices-done.md`), each row in the table
   its slice file names; the count of open rows is still the total across the tables.
   A slice file with no `**Product:**` line gets the product of the table its row already sits in
   (or its filename/title rule in the plan), written into the file; never ask the caller.
   Then a short **Notes** list linking each note file with its date and a one-line
   gist.
3. **Outstanding work**: keep the existing summary if there is one, but shorten each
   item to a line or two that links to its slice or note file. Add every built
   slice's not-yet-verified items to `docs/plan/unverified.md` instead (blocks newest first,
   `### Slice NNN: <title> ([slice](slices/NN-slug.md))`, one-line header on top; create it if missing), moving any
   such bullets already in *Outstanding work* there too, and make *Outstanding work*'s first bullet the count line
   `- **Not yet tried on a device:** <N> checks across <M> slices[ (<Product> <n>, ...)], in [docs/plan/unverified.md](docs/plan/unverified.md).`
4. Active slices, in full, unchanged.
5. Explicitly out of scope: only lines of batches with open slices, plus a link to the history file.

Target: within the budget `node ~/.claude/skills/archive-docs/doc-budget.mjs <repo>` checks (50,000 bytes for plan.md, 20,000 for the root CLAUDE.md; it is the one place the number is written). If it's still over that, the outstanding-work items are too
long; trim them to their links.

## 3. Trim `CLAUDE.md`

Copy it to the scratchpad as `CLAUDE.orig.md` first. Then work through it section by
section:

- **Keep** commands, the one rule, constraints, file maps, "never do X because Y" lines,
  and version pins. Shorten each to the constraint and the file it lives in.
- **Move** history to the file of the slice it came from, under a heading `## Notes
  moved from CLAUDE.md (<YYYY-MM-DD>)` at the end of that file. History means
  incident narratives, measurements, superseded or reversed decisions, and "found
  live on …" accounts. Move the original paragraphs verbatim. A paragraph about no
  single slice goes to `docs/plan/notes/claude-md-history.md`.
- **Link** each shortened rule to its source: `(Slice 21:
  docs/plan/slices/21-<slug>.md)`.
- Never drop a rule because it's long; shorten it. If you're unsure whether something
  is a rule or history, it's a rule.

Then `archive_docs.py check-moved <scratch>/CLAUDE.orig.md CLAUDE.md docs/plan` must
print nothing: every line that left `CLAUDE.md` must exist verbatim somewhere under
`docs/plan/`. It is a line check, so a paragraph you rewrote shows as lost until its
original is in a slice file. Target: root `CLAUDE.md` under ~20 KB.

**Scope rules to folders.** A rule that governs one area (a project, a package, a
platform folder) moves, shortened and verbatim-linked, into that folder's own
`CLAUDE.md` (create it if needed); the root keeps only what applies repo-wide. Apply the
test to every rule you keep: would an agent get this wrong without being told? If not,
drop it from CLAUDE.md (the slice file still holds the story).

## 4. Re-point references

Use `grep -rn "plan\.md's\|plan\.md (\|see plan\.md\|in plan\.md"` over the repo's
**Markdown only**: `CLAUDE.md`, `README.md`, `docs/`, `.claude/agents/`. Point each at the
slice or note file instead.

**Leave code comments alone**, even ones that say "see plan.md's Slice 10 entry". They
still resolve, because `plan.md`'s status table and `docs/plan/notes/slices-done.md` map every slice number to its file. And
touching code has side effects a doc change shouldn't have: a repo that builds or
releases by changed path (ExampleApp's `ship-targets.mjs` builds every native app when
`android/`, `ios/` or `electron/` change) would ship every app for a comment edit.
`git diff --name-only origin/main...HEAD` must list only `.md` files.

## 5. Ship

Make three commits so review can tell a pure move from new prose: the split (step 1,
pure move), the index (step 2), and the `CLAUDE.md` trim plus the re-pointed
references (steps 3 and 4). Open the PR with a `chore:` title, and paste the `verify`
and `check-moved` output into the test plan. Then re-run your docs mirror, if you keep one; with the
files under budget it mirrors them whole again.

**Run this only between waves** (*Parallel work* in `~/.claude/CLAUDE.md`): check
`gh pr list` and `parallel-check` first. Open PRs that edit `plan.md` or `CLAUDE.md`
will conflict once. Say which ones in the PR body. When one rebases, its slice
section goes into its own `docs/plan/slices/` file, and its row goes into the table.
