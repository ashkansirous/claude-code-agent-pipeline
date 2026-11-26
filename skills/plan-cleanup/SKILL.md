---
name: plan-cleanup
description: "Clean up a repo's plan against live state - one plan-cleanup agent per open slice checks waits and claims live, then one index pass ships a docs PR. Use ONLY when the user explicitly asks for a cleanup, or when the run-all-waves driver starts it at the end of all waves: 'plan cleanup', '/plan-cleanup', 'clean up the plan', 'close the slices that are done'. Never to summarise a plan."
---

# Plan cleanup

The plan's own lines are not evidence: they go stale the day they are written. This skill puts every open item
through a live check, one agent per target so each check's tool output stays out of the main thread. Then it
answers from the cleaned plan. The per-target procedure is `plan-cleanup-check`. This skill only coordinates.

## Steps

1. **Targets.** If the arguments name slices, use them. "outstanding" means only the *Outstanding work* lines.
   With no argument, or "all", every row of `plan.md`'s open status tables on `origin/main` is a target, and so is
   every *Outstanding work* bullet. Assign each bullet that names one open slice to that slice's target. Group the
   rest into targets of at most 5 bullets each. Skip the first bullet (the unverified count line); the index pass
   recomputes it.
2. **Docs worktree.** Run the main guard and `branch-sweep`, then
   `git worktree add -b chore/plan-cleanup-<yyyymmdd-hhmm> ../<repo>-worktrees/plcu<hhmm> origin/main`.
   Make the folder `<worktrees>/plan-cleanup/` for the index blocks (it sits beside `reviews/` in the worktrees
   folder, which counts as "your worktrees" for the outside-the-working-directory rule).
3. **One agent per target, in parallel.** Dispatch `plan-cleanup` agents (`subagent_type: "plan-cleanup"`), up to
   6 running at once, starting the next as each finishes, until every target is done. Each brief holds:
   - the docs worktree path and the primary repo path;
   - the one target (a slice number, or the quoted bullets). A slice target names its file too, read from
     `origin/main` (`docs/plan/slices/NN-<slug>.md`), with "follow every line of it; the slice file wins" (the
     `brief-plan-guard.mjs` hook denies a brief that names "Slice NN" without that path). For an *Outstanding work*
     bullet that names a slice, give that slice's file path the same way;
   - its index file, `<worktrees>/plan-cleanup/<target>.md`;
   - "Board parent: <key>", when the session has a card;
   - "never pick a slice number": a new slice is proposed in the index block without a number (rule below).

   Never put two slices in one agent: a slice's checks are its own context (user, 2026-11-25: run enough sub agents to close each slice separately). Read only each agent's short report, never the index files, but before the index pass list the folder of index
   files and match it to the target list: a target whose report says "written" with no file is re-dispatched (board
   night 2026-11-25-1729: the Slice 56 check agent reported files that were never on disk). Run
   the 10-minute check on the batch, and re-dispatch an agent that stalls, as `~/.claude/CLAUDE.md` says.
4. **One index pass.** When every target has a report, dispatch one `update-docs` agent in index mode with the
   worktree path and the folder of index blocks. Its brief:
   - apply every block exactly: row moves to `docs/plan/notes/slices-done.md` with their status text and the
     row-count line; new status cells; *Outstanding work* removals, additions and rewrites; `unverified.md`
     removals with the counts recomputed;
   - for each `new-slices:` entry (title, product, body file in the `plan-cleanup` folder): give it the next number
     in order, starting after the highest slice number on `origin/main`, in open PRs, in local branches and worktrees
     (plain Bash, no Skill tool: `git fetch origin; git ls-tree --name-only origin/main docs/plan/slices/`,
     `gh pr list --state open --limit 200 --json files --jq '.[].files[].path' | grep docs/plan/slices/`, and
     `git worktree list` with each worktree's `docs/plan/slices/` folder and each local branch's, via
     `git ls-tree --name-only <branch> docs/plan/slices/`; also the slice number in the first cell of each table row in `plan.md` and `slices-done.md` (never a number in prose);
     the highest leading `NN-` or number of all of them, plus one; never reuse a number whose file already exists), write `docs/plan/slices/NN-<slug>.md` from the body file with its `**Product:**` and
     `**Touches:**` lines, add its row to the matching `plan.md` table, and replace any "new slice" mention in the
     other blocks with its number;
   - a *Watch* line goes under a `**Watch (checked by plan-cleanup):**` heading in *Outstanding work*, never in a
     slice;
   - change nothing else.
5. **Ship.** Hand the worktree to `ship-branch`: one docs-only commit `docs(plan): plan cleanup <date>` and a PR
   whose body lists the closed slices, the moved items and the new slices, with a `## Test plan` heading. Merge
   when green, fast-forward the primary checkout, remove the worktree, then (optional) refresh your docs mirror (`plan.md`
   changed) with a `_STATUS.md` body file you wrote: the whole project, never a note about this cleanup, with a
   `## Where it's live` section (each product and platform, store status and version, read from the stores in that
   turn).
6. **Report to the user** in plain words, from the agents' reports only:
   - what was closed, and what was wrong in the record (stale waits, wrong claims, held-open side notes);
   - what is really left, per slice, in one line each with its live state;
   - which *Watch* events have fired and are now due (a release to promote, a follow-up to start), each with its
     deep link. Nothing outward-facing is done without the user;
   - the PR link, then `released: ...`.

## Rules

- Runs only in two cases: the user asks for a cleanup in that turn, or `run-all-waves` reaches its end (all waves
  built, next to the final feedback loop). "What is remaining" or a plan summary never starts it (user, 2026-11-25:
  the owner asks for a cleanup explicitly; it never starts on its own).
- The main thread never runs the checks itself. The agents do, so their API and file reads never enter the main
  context.
- Every result lands in the repo through the docs PR. A cleanup that only changed the answer in chat is not done.
