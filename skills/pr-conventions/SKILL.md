---
name: pr-conventions
description: Rules for writing a commit message or pull request body - SemVer bump markers (GitVersion, Conventional Commits), the prose-token footgun, closing the issues a PR completes (one Closes line each), PR body shape, Projects board sync. Load before writing ANY commit message, gh pr create or gh pr edit, and whenever a PR is described as closing or completing tracked work.
---

Load this before writing a commit message or PR body. The rules below prevent specific
bugs that have actually happened.

## Decide the SemVer bump when the repo auto-versions from commits

Some repos compute their release version from commit history: **GitVersion** (reads
`+semver: major|minor|patch|none` tokens in the message), **Conventional Commits** /
semantic-release (`feat:` minor, `fix:` patch, `feat!:` / `BREAKING CHANGE:` major), or a
bespoke CI job. There, the commit message is the version input.

Before committing, check whether it is wired up: `GitVersion.yml`, a `version`/`release` CI
job, `semantic-release`/`commitlint`/`changesets` config, or a `CLAUDE.md`/`CONTRIBUTING.md`
note on commit convention. If found:

1. **Learn the exact marker the tool consumes.** GitVersion wants a `+semver: minor` token in
   the body; Conventional Commits wants a `feat:`/`fix:`/`feat!:` prefix; changesets wants a
   changeset file. Use the mechanism actually in place.
2. **Classify the change:**
   - **major** - breaking change to a public/consumed contract: removed or renamed
     API/exports, changed CLI flags, config keys, on-disk/schema/wire formats.
   - **minor** - backward-compatible new capability, **including any user-facing change**: a
     UI redesign or refresh, a new or reworked control/screen/flow, new visible behaviour,
     even when it replaces an existing surface. "Refresh the UI" is a minor, not a patch.
   - **patch** - bug fix, perf tweak, docs, chore, test, CI, or a purely internal refactor a
     user cannot perceive. Default; most tools bump patch with no marker. Do not rationalise
     a visible rework as a "refactor" to land it as a patch.
3. **Default to patch when unsure, but never under-mark.** Litmus test: if a user would
   notice the difference (looks different, behaves differently, new or changed control), it
   is at least minor. If unsure between minor and major on a public contract, take the
   higher bump or ask.

**Footgun: never write the literal marker in prose.** Token tools match the marker anywhere
in the message, including quoted examples. A commit that documented a marker forced a real
0.1.1 to 1.0.0 jump. Only write a marker as a directive. To mention one, break it
(`+semver:` followed by a zero-width space, then `major`) or write "the major token".
Applies to commit bodies, PR text that becomes a squash commit, and docs you commit.

**Footgun: never write the skip-CI marker in a commit message, PR title or PR body.** GitHub skips
push and pull_request workflows when the bracketed "skip ci" word (or `ci skip`, `no ci`,
`skip actions`, `actions skip`) appears anywhere in the head commit's message, body included, so a
sentence that merely mentions it leaves the PR with no checks (2026-11-06, print-the-damn-book #52: no
checks, because the commit body mentioned it in prose). A PR title becomes the merge commit body, so it
counts too. The one place it appears is the merge `--subject` in batch-release mode (`ship-branch`,
M4, brief field `batch release: yes`). To mention it in prose write "the skip-CI marker".

Put the marker on the commit that carries the change. In squash-merge repos mirror it in the
PR title/description. If the repo has no auto-versioning, add no markers.

## Find which issues the PR closes - BEFORE you open it

For tracked work, identify every issue the PR completes and add a closing reference for
each. Sources, in order:

- `plan.md`'s status table links each slice to its story issue (the slice file repeats it).
  The PR implementing the slice closes that **story and its task/sub-issues** (find them
  with `gh issue list`, filtered by the slice label, or the story's sub-issue list).
- The Projects v2 board / `gh issue list --state open`.

Closing the parent story does not auto-close its sub-tasks: list every done task explicitly.
If a slice only partly completes a story, close just the finished tasks, leave the story and
deferred tasks open, and say so in the body. An implementation PR for tracked work with no
`Closes #...` line is a bug until proven otherwise.

## Closing references: one keyword per line

```
Closes #11
Closes #12
Closes #13
```

Not `Closes #11, #12, #13` and not `Closes #11, closes #12`: GitHub only links the first
issue in inline forms. Keywords: close(s/d), fix(es/ed), resolve(s/d).

## Verify the references parsed - every time

After every `gh pr create` / `gh pr edit` for tracked work:

```bash
gh pr view <num> --json closingIssuesReferences --jq '.closingIssuesReferences[].number'
```

The list must match exactly the intended issues. Empty when work was tracked means you
forgot the lines; a mismatch means the syntax is wrong. Fix and re-verify. The field can lag
a few seconds, so re-query before concluding it is wrong.

## Body shape

- **Summary** - 1-3 bullets on why and the user-visible change, not a recap of the diff.
- **Test plan** - checkboxed list of what was actually verified, with commands. Be honest
  about what could not be run. Never tick a check that didn't run this session, template
  lines included ("docs only, links checked" with no link check: print-the-damn-book #42 and #46, 2026-11-01).
  **A tick carries its result when it is written** (`- [x] node --test x.test.mjs: 12 pass`, exit code, count); a
  check that did not run is written `- [ ] ... (not run: <why>)`, never ticked (Slice 29 item 15: the board's #119, #122
  and #125 each had unrun checks ticked and ship-branch unticked them). The body always has a `## Test plan` heading,
  even for a docs-only PR (board #153 and #157 had none and the merge was refused); `merge-gate.mjs` also denies a non-draft
  `gh pr create` whose literal body lacks it (Slice 29 item 26; a `--draft` claim PR is exempt). A docs-only PR's line
  `- [x] docs only, no tests apply: <reason>` stays ticked when it states its reason (Slice 29 item 25).
- **Review** - a PR that changes code (any changed file that is not Markdown and not under docs/design/ or a glob in the repo's `.claude/merge-gate.json` `contentPaths` on main, e.g. `{"contentPaths": ["content/dino/**"]}` for story content) has a `## Review` section listing
  the review findings files by absolute path (the merge gate cannot resolve a relative one): one high, one medium, plus a check pass when code changed after the last
  pass. A reviewer agent writes every listed file, never the main thread. The `merge-gate.mjs` hook denies
  `gh pr merge` without it.
- Closing references on their own lines at the bottom.

## Keep the project board in sync

When a PR opens, move every issue it closes to `Status=In Progress` on the Projects v2 board
if not already (the closed-issue workflow moves them to Done on merge). When starting work
on a tracked issue before a PR exists, move it to In Progress before the first commit. Leaving everything in Todo while shipping PRs is a bug.

## Commit and push rules (moved from ~/.claude/CLAUDE.md, "Commit and push defaults")

Commit and push to a feature branch and PR, **never directly to `main`** unless the user says "commit straight to main". Implementations need the review gate first. Steps: main guard and `branch-sweep`, branch in a worktree, commit, push `-u`, `gh pr create --base main`; hand them to `ship-branch` with your text. Don't ask before pushing or opening the PR; report the URL.

- **No co-author, ever:** no `Co-Authored-By` line unless the user asks in that turn (`coauthor-guard.mjs` enforces it). PR bodies keep the "Generated with Claude Code" footer.
- **Load this skill before any commit message or PR body.** Never write a literal `+semver` marker in prose.
- **Every repo auto-merges:** a gated PR (or a docs-only change) is merged as soon as checks are green, in one command (`gh pr checks <n> --watch --fail-fast && gh pr merge <n> --merge`, never `;`), merge commit, no wait for the user. Add `--repo <owner>/<repo>` if the command `cd`s first. Never covers pushing to `main`, anything that skipped the gate, force-pushes or history rewrites.
- **After every merge, fast-forward the primary checkout** with `node ~/.claude/skills/run-wave/ff-primary.mjs <primary>` (`ship-branch` step M5); a dirty primary is no reason to skip, the script blocks only on a real conflict.
- **Production changes only through the build and release pipeline.** Never deploy from a shell (`wrangler deploy`, `npm run deploy`, `firebase deploy`, `vercel --prod`, `terraform apply` ...) and never ask the user for an OK to; a merge to `main` that the repo's CI or Cloudflare Workers Builds deploys is the only route (`deploy-guard.mjs` enforces it; `--dry-run` and the npm scripts `deploy:dry-run|local|dev|staging|preview|test` pass). A skipped run (a skip-CI batch merge, a path filter) is fixed by starting the pipeline's own run (its retry, deploy hook or `gh workflow run`), and the gap that skipped it becomes tooling work.
- **Then confirm the deploy ran** where the repo deploys on merge (`gh run list --workflow <deploy>.yml --limit 1`; GitHub silently disables idle scheduled workflows, so a missing run means `gh workflow list --all`, enable, `gh workflow run`). Report a run by `status` while running and `conclusion` when done, never "finished": `startup_failure`, or `failure` with no jobs, means main is broken; say so at once. A `pending` run behind a stuck `in_progress` one (current step past twice its normal time) is reported as stuck. Wave merges carry the skip-CI marker and release in one batch (`run-wave`).
- This repo: PRs touching only Markdown outside SKILL.md, agents/ and `CLAUDE.md.example` have no checks (`gh pr merge <n> --merge`). After the merge: `git -C <repo> pull --ff-only`, re-copy skills and agents into `~/.claude`, remove the worktree, report the PR link.
