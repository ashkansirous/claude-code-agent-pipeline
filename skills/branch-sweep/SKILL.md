---
name: branch-sweep
description: Prune branches whose PRs already merged into main, without checking anything out - fetch --prune, worktree prune, delete merged local and remote branches. Load right after the main guard and before creating any new branch or worktree, and when the user asks to clean up or prune branches.
---

Short-lived branches are disposable once their PR merges. Leaving them hides which branch is
the real trunk. Sweep every time you create a new branch, after the `main` guard and before
`git worktree add`. The sweep never checks anything out; it compares against `origin/main`.

## Local

```bash
git fetch --prune origin          # prune drops stale remote-tracking refs
git worktree prune                # forget worktrees whose folders are gone
comm -12 <(git branch --merged origin/main --format='%(refname:short)' | sort) \
         <(gh pr list --state merged --limit 300 --json headRefName --jq '.[].headRefName' | sort) \
  | grep -vx main | xargs -r git branch -D
```

Delete only a branch that is both contained in `origin/main` and the head branch of a merged PR,
with `-D` (`-d` compares with the primary checkout's own HEAD, often stale, and refused four merged
branches on 2026-10-31). Containment alone is not enough: a fresh branch with no commits sits at
origin/main's tip and counts as merged, and another session may have just created it.

After the local sweep, record it: `node ~/.claude/skills/branch-sweep/sweep-stamp.mjs write <repo>` (ship-branch claim
mode refuses a claim when no sweep was recorded in the last 4 hours).

For a worktree whose branch has merged: run `git -C <path> status --short` first. Run
`git worktree remove <path>` only when it is empty and you created it, or the user confirms
it is abandoned. If removal fails with "Filename too long", retry with `git -c core.longpaths=true worktree remove <path>`. Then `git branch -D` the branch (after checking it is in `git branch --merged origin/main`).

## Remote

```bash
gh pr list --state merged --json headRefName --jq '.[].headRefName'   # candidates
git push origin --delete <branch>                                     # delete the merged ones
```

## Rules

- **List what you are about to delete and confirm with the user before deleting any remote
  branch.** Remote deletion is destructive and outward-facing. Local deletion of a branch
  `origin/main` contains is safe without asking.
- Never delete `main`, the current branch, or a branch with an open/unmerged PR. Use `-D` only on
  the `--merged origin/main` list above; skip anything git refuses and head branches of open PRs.
- **Unattended (night) runs:** a night does not ask, so it deletes the remote head branch of a PR only when that PR merged the same night and `gh pr list --state merged --head <branch>` finds it (the same proof as a local delete); any other remote branch is left and listed. Turning on `gh repo edit --delete-branch-on-merge` is an outward-facing repo setting and the owner's call: a night lists it under the note's *Waiting on the user* and never sets it. Before reporting a remote branch as left or its delete as blocked, read `git ls-remote --heads origin <branch>` and `gh repo view --json deleteBranchOnMerge`: a branch GitHub already deleted at merge is not a finding, and a denied delete of it is not reported (board night 2026-11-25-1729: housekeeping 1 said six merged branches were "still on GitHub"; the repo had deleted them at merge).
- Prefer enabling auto-delete of head branches on merge on repos you set up:
  `gh repo edit --delete-branch-on-merge`.
- Never `git checkout`/`switch` in the primary checkout to do any of this.

## Main guard fix (moved from ~/.claude/CLAUDE.md, "The trunk is always `main`")

If the main guard (`git fetch origin && gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`, must print `main`) prints anything else, fix the trunk first: bring that branch's work into `main` from a worktree on `main`, `git push -u origin main`, `gh repo edit --default-branch main`, retarget open PRs (`gh pr edit <n> --base main`), and delete the impostor branch only after confirming with the user. A fresh repo's `main` gets a ruleset with `deletion` + `non_fast_forward` when asked or at setup. A new repo starts with `git init -b main`.

## Worktree rules (moved from ~/.claude/CLAUDE.md, "Work in a worktree")

- Create a branch only in a worktree next to the repo: `git fetch origin` then `git worktree add -b <type>/<slug> ../<repo>-worktrees/<slug> origin/main`. A repo with no commits and a non-git directory are exempt; the harness's own worktree tooling counts.
- Slug about 12 characters (`s313`): long ones push Android build paths past 260 characters on Windows.
- Run every command from inside the worktree (absolute paths or `git -C`); install dependencies there.
- **Read repo facts from `origin/main`** (`git show origin/main:<path>`, `git grep <pattern> origin/main`), never from the primary checkout, which can be far behind.
- **Never `checkout`, `switch`, `reset`, `stash` or `pull` in the primary checkout** or in a worktree you didn't create this session (`primary-checkout-guard.mjs` enforces it). If `git worktree list` already shows the branch, use that worktree.
- Remove a worktree only when its PR merged, it is clean and you created it. Leave the folder in an earlier tool call (`cd <repo root>` on its own) and `TaskStop` any background task started inside it first: either holds the folder. "Filename too long": `git -c core.longpaths=true worktree remove`. A removal that failed with "Permission denied" has already deregistered it: stop the holder, `rmdir` the empty folder. Never purge with `robocopy /MIR` or `Remove-Item -Recurse`.
