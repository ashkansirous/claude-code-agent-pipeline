# claude-code-agent-pipeline

A multi-agent software delivery pipeline built on [Claude Code](https://claude.com/claude-code): skills, model-pinned subagents and guardrail hooks that plan, build, review, test and ship code, in parallel and unattended overnight.

I built and run it to maintain my own products alone: [Read The Stupid Text](https://github.com/ashkansirous/ReadTheStupidText) and Dino (a kids' book reader), live on Google Play, the App Store and the Microsoft Store. Since the wave runner went in on 19 October 2026, 1,201 pull requests have been merged into that repo. Progress is reported to [agent-progress-board](https://github.com/ashkansirous/agent-progress-board), a Cloudflare Worker + D1 app with a remote MCP server, also open source.

This repo is a cleaned copy of my private config: the parts that make up the pipeline, without my personal skills. Rules and hook comments cite the incident that caused them (date, repo, what went wrong), so you can see why each one exists.

## How it works

A coordinator session (Opus) keeps the judgement work: diagnosis, design, choosing which review findings to act on, and talking to the owner. Mechanical work goes to subagents in [`agents/`](agents), each pinned to the cheapest model that can do it. A wave ([`skills/run-wave`](skills/run-wave)) builds 3-4 slices in parallel, each in its own git worktree, and every slice passes the same gate:

1. **Plan.** Each piece of work is a vertical slice with its own spec file and a `Touches:` line ([`skills/to-plan`](skills/to-plan)), so [`parallel-check`](skills/parallel-check) can tell which slices can run side by side.
2. **Claim.** A draft pull request claims the slice before any code is written.
3. **Implement.** `implement-slice` (Sonnet) builds the spec and runs typecheck, lint and tests until green.
4. **Review twice.** A high-effort review, fixes, a medium-effort review, fixes (`code-review-pass`, `fix-review-findings`). Only correctness, crash, data-loss, security and privacy findings are fixed; two failed fixes in one area mean the design is wrong.
5. **Test on devices.** `device-test` runs scripted flows on a real phone, an emulator or a headless Windows VM, capped at 10 minutes ([`skills/device-test-pipeline`](skills/device-test-pipeline)).
6. **Ship.** `ship-branch` (Haiku) commits, opens the PR and merges once checks are green. Production changes only go out through the release pipeline.
7. **Record.** `update-docs` writes what was built into the slice file; an index pass updates the plan.

| Model | Used for | Agents |
| --- | --- | --- |
| Opus | Coordination, triage, deep review | main thread, `code-review-in-detail` |
| Sonnet | Building, reviewing, testing, investigating | `implement-slice`, `code-review-pass`, `fix-review-findings`, `device-test`, `ground-in-code`, `update-docs`, `session-audit` and others |
| Haiku | Mechanical steps | `ship-branch`, `run-checks`, `ci-status`, `parallel-check`, `resolve-merge-conflicts`, `web-research` |
| Fable | Security review | `security-review` |

[`skills/run-all-waves`](skills/run-all-waves) runs wave after wave unattended, each in a fresh headless session, and ends with a plan cleanup and a feedback loop.

## Guardrails: every failure becomes a hook

The agents' mistakes were the interesting part. Each one became a rule in [`CLAUDE.md.example`](CLAUDE.md.example) and, where possible, a hook in [`skills/feedback-loop`](skills/feedback-loop) that blocks it mechanically:

- **Briefs written from memory.** A coordinator briefed an agent from memory instead of the slice spec, and the agent did the opposite of what the spec said. `brief-plan-guard` rejects a brief that names a slice without its spec file.
- **Guesses stated as facts.** A guessed cause went into an email to a store as fact. Anything stated as fact must have been read or run in that session, and a fix counts only when it passes a run in the same form as the one that failed.
- **Deploys around the pipeline.** Batched merges skipped CI and an agent tried to deploy from a shell. `deploy-guard` blocks shell deploys.
- **Stalled background work.** A phone slept mid-test and the run was called healthy because the app was installed. Background agents now get a 10-minute check that reads the work itself.
- **Shell corruption on Windows.** Heredocs and `sed` corrupted Windows paths in committed files. `shell-write-guard` refuses those writes.

`feedback-loop` audits a long session with a fresh agent, checking every complaint, deferred item and "done" claim against the repo, and repeats until a pass finds nothing new.

## Install

1. Copy `skills/` and `agents/` into `~/.claude/` (the hook paths in `settings.example.json` assume `~/.claude/skills/...`).
2. Merge `settings.example.json` into `~/.claude/settings.json` (hooks wiring, plugin switches, skill visibility).
3. Copy `CLAUDE.md.example` to `~/.claude/CLAUDE.md` and edit it to taste.
4. Optional: enable the `agent-board` plugin from the `agent-progress-board` marketplace (it is set to `false` in `settings.example.json`) only if you run that board, and set `AGENT_BOARD_URL` and `AGENT_BOARD_TOKEN` (or `AGENT_BOARD_SECRETS_FILE`) so `skills/run-wave/board.mjs` reports to your own progress board.

The rules assume a `main` trunk, git worktrees and the `gh` CLI. Some skills mention companion skills of mine that are not in this repo (a Drive mirror, a secrets store); those steps are marked optional.

## Tests

```bash
node --test $(node .github/scripts/select-tests.mjs --linux)
python -I -m unittest discover -s skills/parallel-check
```

CI runs the Linux set on every pull request ([`tests.yml`](.github/workflows/tests.yml)) and the Windows-only set in [`tests-windows.yml`](.github/workflows/tests-windows.yml).

## License

[MIT](LICENSE)
