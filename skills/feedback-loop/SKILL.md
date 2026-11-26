---
name: feedback-loop
description: End-of-session feedback loop - audit the session for mistakes, complaints, deferred items, hanging offers and false "done" claims; fix tooling now, put product work in slices, repeat until a pass finds nothing. Use on "run the feedback loop", "feedback loop", "retro", "anything you parked or slept on", "what could you have done better", "have you addressed all the findings", "are you sure", or at the end of a long session before /compact.
---

The aim: nothing from this session is left only in chat. Every mistake becomes a fixed tool
or rule, every piece of open work becomes a slice item or an *Outstanding work* line, and the
user never has to ask "are you sure?" three times to find the rest. (2026-10-30,
ReadTheStupidText: the user had to ask whether every finding was addressed four times and "are
you sure?" twice; each time more turned up, and a tooling issue sat in a GitHub issue nobody
reads. The session also ended on an offer to have an agent read the conversation -
an offer that should simply have been done.)

The main thread runs the loop and makes every decision. The `session-audit` agent does the
reading (section *Audit pass*), a fresh one per pass so no pass is anchored on the last.

## Never while the main session is busy; never over 30 minutes

- "The main session" is the session being audited. The loop never starts while that session is still working on something else (its own subagents running); the loop's own `session-audit` agents do not count. The main thread runs it only when its own work is finished; an unattended driver waits until the main session has no subagents in flight (its transcript written in the last 30 minutes).
- Total budget 30 minutes. At 25 minutes start no new pass: ship the note with what is left listed as open findings. Never run past 30 minutes. **Ship by minute 18:** open and merge the docs PR (Markdown only, so no checks run) by minute 18, and put any change that needs CI checks in a second PR started no later than minute 15, or into a slice; a PR whose Windows checks take 8-9 minutes and starts at minute 22 is killed at 30 with its reply, mirror and review prune never run (2026-11-17-1526: PR #314 opened at minute 22, `killedTimeout`). Write the ship time in the note's *Passes* section. (2026-11-01: a final loop ran 45+ minutes and 4+ passes because the session it audited kept working and its transcript kept growing.)

## 0. Decide the session's phase first

Read the user's own words in the session and write one line: **what was the user authorised
to have built in this session?**

- **Implementation phase** (the user ran `/run-wave`, said "build", "fix it", "do it now"):
  product work found by the loop may go through the normal gate in this session.
- **Not implementation** (planning, review, a question, or the user said so, e.g. "I don't
  need to build any of the slices in this thread"): product work is **planned, never built**.

Either way, **tooling and process fixes are done now**: that is the point of the loop.

## 1. Make the digest

The loop covers **every session of the work being reviewed**, not only this one: a day of
waves spans several sessions (`/clear`, a fresh session between waves) and the user may have
run parallel threads in the same repo. Pick them by content, never "the newest file" (a
parallel session in the same folder may be newer than yours).

```bash
D=~/.claude/skills/feedback-loop/transcript-digest.mjs
node $D --find "<session cwd>" "<a phrase from the user's trigger message>"   # this session
node $D --list "<session cwd>" 24                                            # the day's sessions, first and last prompt each
node $D <session.jsonl> [<more.jsonl> ...] --out "<scratchpad>/digest.txt" [--gaps 10]
```

Include this session plus the earlier sessions of the same work (the list shows each one's
first and last prompt). Include a parallel thread only when the user asks for it or it ran
the same slices. Say in the report which sessions were read. Work done from another folder
(e.g. `<repo>`) has its own project folder: list that cwd too when it applies.

The digest keeps user messages, assistant text, compaction summaries, agent briefs and tool
calls with their entry numbers. Ordinary tool results are dropped (17 MB of transcript becomes
about 400 KB), but three kinds are kept as short lines: `DENIED <tool>` (a permission block),
`AGENT RESULT` (a subagent's report, including a background hand-back; never the user's
words) and `TOOL ERROR <tool>` (a failed call). A last section, `slow stretches`, lists every
Agent/Bash/Workflow dispatch whose result took more than `--gaps` minutes (default 10) and
every gap that long between entries (user idle time and stretches already listed as a dispatch are left out), with entry
numbers. Make a fresh digest before each pass, so the loop's own work is in it too.

**Cloud slices have no local transcript.** For each wave-ledger slice line that says `cloud: ... run <session id>` (or `stage: cloud running <session id>`),
call `RemoteTrigger get_run_log` with that session id and give the log to the auditors as one more digest-sized input (split by line range like the rest).
No notes file is read. Say in the report which cloud runs were read; a run the call cannot fetch is listed as not audited, never skipped silently
(Slice 08).

**Split every pass across auditors by line range, never one auditor for the whole digest.** Every
step an agent takes resends everything it has read, so one auditor reading a whole digest grows
to hundreds of thousands of tokens and pays for it on each step (2026-11-15: pass 1 read a digest
in 28 parts, ended at 370k and cost 18M tokens in 8 minutes). Count the digest's lines
(`wc -l`) and give each auditor one range of about 800 lines (at most 4 auditors per pass; above
3,200 lines widen the ranges), overlapping the next range by 20 lines. The `slow stretches`
section goes to the last auditor. Together the ranges cover the whole digest.

## 2. Passes until one finds nothing

The whole loop has a 30-minute cap: at 25 minutes start no new pass and ship the note with the rest listed as open findings. The docs PR ships by minute 18 and a PR needing CI checks starts by minute 15 (see the budget rule above).

Keep a ledger at `<scratchpad>/feedback-ledger.md`: one line per finding, with its entry
number, destination and proof (PR, slice file and line, merged commit).

Each pass dispatches **new** `session-audit` agents, one per line range, in one message so they run at once, each with: the digest path, its line range, the repo paths it
may check (the session's repo, `<repo>` or `~/.claude/skills-repo`), the ledger path,
and the phase line from step 0, and tell it to return every item inline, uncapped (no output path: the harness refuses a subagent's report-file Write, so three findings files were lost on 2026-11-07). Don't give it your own
conclusions; the ledger tells it what is claimed as handled, and it checks those claims too.
Never narrow the reading in the brief ("only new items", "just the tail"): the pass's ranges
together cover the whole digest. (2026-10-30: pass 4 was told to report only items beyond the ledger and skipped
the middle of the session.)

- Merge the auditors' items (the same entry number from two ranges is one item), then read every item the pass returned inline (uncapped), and act on every item that is not `TRACKED` (steps 3-5) before the next pass.
- **At least two passes. Stop only when a pass returns no new finding and no false claim.**
  After four passes, stop and report what is still open by name.
- Never tell the user "nothing is left" from your own memory of the session. The last empty
  pass is the evidence; quote its counts.

## 3. Send each finding to the right place

**Tracked means one of these, and nothing else:** a merged change; an item in a planned
slice file; a line in `plan.md`'s *Outstanding work*. A GitHub issue, a memory file, the wave
ledger, a todo list or a chat message saying "later" is **not** tracked.

| Finding | Where it goes | When |
| --- | --- | --- |
| A skill, agent, rule, hook or install gap (this repo) | Fix it: worktree, PR, merge, `pull --ff-only`, re-copy skills and agents into `~/.claude` | Now |
| A mistake I made | First line: the plain cause (`~/.claude/CLAUDE.md`, *Own mistakes plainly*). Fix: the general principle it broke plus the script or check that would have caught it, in AgentPipeline or the repo | Now |
| A repo rule or doc (CLAUDE.md, README, a slice's record) | A docs PR | Now |
| Repo code: a script, a test tool, a product bug, a missing test, an unverified item | An item in a planned slice, or a new slice (`to-plan`); unverified items also in `docs/plan/unverified.md` | Planned now; built only in the implementation phase |
| A user complaint | Treat as a mistake (row 2) and say which fix answers it | Now |
| A decision only the user can make, or an outward-facing step (store, console, live data, their login) | One batched question at the end, after checking live state (check live state with tools first) | End |

**Before any tooling fix, look for an open PR that already makes it:**
`gh pr list --repo <repo> --state open --limit 200 --json number` then `gh pr diff <n> --repo <repo> --name-only` per PR (the list's `files` field is cut off on big PRs), and look for the path of the script, skill or
agent file the fix edits (`--search` looks only at titles and bodies, never at changed files). If one exists, finish that PR instead of writing a second fix (2026-11-13: the loop redid the
batch-release 404 fix in #212 while #201 with the same fix was open).

Several small findings in one area go into one PR or one slice. A slice item says what is
wrong, the entry number it came from and how to verify the fix.

## 4. Questions and offers that should have been actions

In the digest, the last `ASSISTANT:` line before each `USER:` line is where a turn ended. For
each one that ended with a question or an offer ("say X and I'll...", "should I fix this or wait?", "want me to...?"):

- If the work was inside what the user asked for, internal and reversible (an audit, a check,
  fixing a tool or rule, planning a slice, a docs PR), **the answer is "do it"**. Do it now in
  this loop, and record the finding as "asked instead of doing", with its fix in the rules if
  one isn't there already.
- It stays a question only if it is the user's decision (product choice, money, their
  account) or an outward-facing action not already authorised.
- Building a slice is never "do it" outside the implementation phase (step 0).

Example (2026-10-30): a turn ended offering either an audit by one agent reading the whole conversation, or a
/compact and a go to build Slice 215 and a tooling issue. The audit: do it. The tooling
issue: do it. Slice 215 (product code, not the implementation phase): stays planned.

## 5. What could have been done better

For each mistake or slow stretch the passes found, write one line: the plain cause, what it
cost (time, a wrong claim, a rerun) and the fix that went in. Fix the principle, not the
symptom (`~/.claude/CLAUDE.md`, *Own mistakes plainly*, last bullet). Check whether an existing
rule already covered it; if so, the fix is making it enforceable (a hook, a script, a check in
an agent), not repeating the rule in new words.

Before writing "I made a mistake", read who made it: `git log` for the commit, the PR's author and branch, the
session's own entries. A mistake another session or PR made is said as such ("session X / PR #N did ...") and fixed as
tooling; it is not owned as this session's (board note 2026-11-19-0441: the starter owned a plugin-install mistake
another session made; Slice 29 item 34).

Two findings have a fixed fix: a "wrong task" finding gets a rule about confirming the goal
before starting work outside what the user asked; a "handed manual work" finding gets the
hand-work check (prove a tool cannot do it, state a permission block plainly).

## 6. Report in the plan

In the session's repo, on a `chore/feedback-loop-<date>` worktree, write
`docs/plan/notes/YYYY-MM-DD-feedback-loop.md`: the phase line, the passes and their counts, and
one line per finding (what, entry number, where it went, PR or slice link). Add a line for it
under the notes list in `plan.md`. Write the note and every doc edit with the Write or Edit tool, never
a shell heredoc or `sed` (backslash paths turn into control characters), and before shipping run
`node ~/.claude/skills/feedback-loop/control-chars.mjs <worktree>` (exit 0 required). Also run it once with `--all`
on the repo and on AgentPipeline, each time on a worktree at `origin/main` (your loop worktree), never the
primary checkout, which may be far behind (2026-11-01 round 3: a scan of the stale primary listed 15 hits,
13 already fixed on main): a byte merged earlier is never in a branch's changes (2026-11-01: six were found
this way, one a broken regex `\b` in `tools/phone/common.ps1`); fix docs now, put code into a slice, and name
a deliberate byte (a separator character in source) in the note. Only the branch run must exit 0. Then check the note's claims with
`node ~/.claude/skills/feedback-loop/note-claims.mjs <note.md> <repo dir> [--other AgentPipeline=<path to that repo>]`:
it lists every `#N` with its live state and every backticked path missing on origin/main, and exits 1 when
a sentence says "merged" beside a PR that is not merged (or "open" beside a merged one) or a path is missing.
Fix what it reports before shipping (2026-10-31: every round's notes carried wrong PR states, counts and paths).
**The checks and the ship are one `&&` chain** (Slice 29 item 38; board PR #175 merged with `note-claims.mjs` at exit 1 because the check and
the commit, push, PR and merge were joined by `;`): `node ~/.claude/skills/feedback-loop/control-chars.mjs <worktree> && node
~/.claude/skills/feedback-loop/note-claims.mjs <note.md> <repo dir> && git -C <worktree> commit ... && <push-branch.mjs> && gh pr create ...`, so a failing check leaves no PR.
The chain ends at `create`: read the PR number from its output, then merge in a separate call with that literal number
(`gh pr checks <number> --watch --fail-fast && gh pr merge <number> --merge`), because the merge gate cannot resolve a `$n` variable to a PR and would skip its rules (failed checks, live rollup, mirror marker). `note-claims.mjs` reads a repo name
(and "PR"/"issue") that ends a line as the prefix of a `#N` starting the next line. **Edits and the commit that ships them never share one
message** (Slice 29 item 40; board PRs #177 and #178: four plan.md Edits failed "File has not been read yet" in the message that also held the
commit, push and merge, so #177 merged without them): send the Write/Edit calls, read their results, and only then the commit.
Also re-read, just before shipping, the live state the note asserts that no script checks: a device's
connection and settings, a host or service state, a "waiting on the user" step the user may already have
done (2026-10-31: a round note asked the user to turn the phone's Wi-Fi on an hour after they had). Every
*Waiting on the user* line is read live first (console pages read-only through the Chrome tools or a CLI,
never from a plan or slice sentence) and says when it was read (2026-11-01: a note repeated "the Play Data
safety change is saved, not submitted" after both apps had been published). A question goes to the user
only if their answer changes what we do next and no one else can settle it: each *Waiting on the user* item
names what it blocks; an obvious product choice a wave already took (keep the safer existing behaviour) is
recorded as a decision, never asked; a question about a past event that later merges or runs made moot is
dropped, not asked (2026-11-01: the user was asked whether Back on a Dino text page should discard, and
whether a two-day-old store run also submitted another app). The note's
*Passes* section holds every pass's counts, including the last, and each row names its PR number.
Ship it docs-only and merge it, then refresh your docs mirror if you keep one. A Markdown-only PR may be shipped from the
main thread (commit, `node ~/.claude/skills/parallel-check/push-branch.mjs <worktree> <branch>`, after the commit, `gh pr create`, `gh pr checks --watch --fail-fast && gh pr merge`);
a PR that changes code goes through `ship-branch` (2026-11-01: the loop shipped a code PR inline). After the note merges, delete
the round's review files under `<repo>-worktrees/reviews/` whose skip reasons the slice files now hold
(the waves keep them for this loop; nobody else removes them). List them first by date
(`find <repo>-worktrees/reviews -newermt <round start>`; `node ~/.claude/skills/feedback-loop/prune-reviews.mjs <repo>-worktrees/reviews [--days 14]` lists the stale ones of all rounds and deletes nothing), and keep files of slices still open and any file or
folder a slice file or note on `origin/main` cites (`git grep -n <name> origin/main -- docs/`; 2026-11-01: a
verify-checks table was cited as evidence by two slices). Before deleting a findings file whose skipped items
no slice file holds, copy their one-liners into a slice item (a parked slice if none is open). Write the
gate record (counts, applied and skipped findings with reasons) of every PR the loop opened into the note
first, since its review files go too. A note line about how code behaves cites file:line, and a line
about a tool, host or device says what was run to check it, or says "not checked". Remove your own
worktrees with `cd <repo root>` in one tool call and `git worktree remove` in the next. A repo with no `plan.md` gets the note in its AgentPipeline PR body instead.

**Confirm the night's Worker deploy (Slice 18).** When the night's final release printed "confirm the deployment in Cloudflare, then run
worker-deployed", this loop does it before the reply, since the driver does not: read `wrangler deployments list` (read-only,
never `wrangler deploy`) for a deployment newer than the deploy hook call (`batch-release.json`'s `hook.at`), then run
`node ~/.claude/skills/run-wave/batch-release.mjs worker-deployed <repo>`; with no newer deployment, say so in the note and
leave the warning set (night 2026-11-17-1657: done by hand at 18:04Z, 3 minutes after the 18:01:25Z deployment).

Then the reply to the user, short: passes run and the last one's counts; what was fixed now
(PR links); what was planned (slice numbers); what is waiting on the user, if anything; and
the `released:` line.

## Audit pass (for the `session-audit` agent)

You are read-only: never edit, commit, push or message anyone. You get a digest path, repo
paths, a ledger path, the phase line and your line range of the digest (an output path only in an old brief).

1. **Read your whole range of the digest**, in parts (`Read` with `offset`/`limit`) from its first line to its last, and
   nothing outside it except to look up one entry another line points at (Grep, then a few lines). Never
   sample or skip inside the range: findings hide in the middle. A brief with no range (an old one) means the whole digest. Compaction summaries list items from
   before the compaction: treat them as findings to check as well.
2. **Collect candidates**, each with its entry number:
   - every user complaint, correction, repeated question or "why did you...";
   - every mistake visible in the session: a wrong claim later corrected, a rerun, a rule
     broken, a retry loop, work redone;
   - every deferral: "later", "follow-up", "next session", "not yet verified", "skipped",
     "parked", "out of scope", "known behaviour", "TODO", review findings left unapplied, and
     leftovers in agent reports;
   - every question or offer the assistant ended a turn on, and what happened to it;
   - every "done", "recorded", "tracked", "fixed", "merged" the assistant told the user;
   - every `USER (sent while working)` line: the user typed it while the assistant was busy; check the
     next replies answered it (2026-11-01: a question about why wave 1 was slow got no answer);
   - every place the user corrects the goal itself ("that is something else", "I
     only wanted...", "why do we need that now"): the mistake is doing the wrong task;
   - every decision the user made, in its **last** form: when the user answers the same question
     twice, the later answer wins, and a record of the earlier one is a `FALSE-CLAIM` (2026-11-01:
     a round note recorded "no CI" two minutes after the user had switched to "keep the CI");
   - every step handed to the user to do by hand: could a tool have done it, or was it a
     permission block that should have been stated plainly, with the rule that unblocks it?
   - every `DENIED` line, and what the assistant told the user next;
   - the leftovers in every `AGENT RESULT` ("from memory", "not checked", "could not", "did not
     verify"): each is an open item until tracked;
   - the digest's `slow stretches` list: for each entry, what the wait was for and whether a
     faster path existed.
3. **Check each one in the real files**, not in the session's own words: grep the repo's
   `plan.md`, `docs/plan/slices/`, `docs/plan/notes/` and `CLAUDE.md` files, this repo's
   `skills/` and `agents/`; `gh pr list --state all --search`, `gh issue view`. Also
   check every line of the ledger the same way.
4. **Verdict per item:** `TRACKED` (path:line or merged PR), `WEAK` (only an issue, memory,
   ledger, todo or chat), `UNTRACKED`, `FALSE-CLAIM` (told the user it was done; it isn't),
   `SHOULD-HAVE-ACTED` (a question or offer that was in scope, see step 4 above). Use the
   phase line: a slice left unbuilt outside the implementation phase is `TRACKED` if planned.
5. **Return every item inline, uncapped** (do not write a report file: the harness refuses a subagent's
   Write of one): the counts per verdict, then every item that is not `TRACKED` (entry number, what, why),
   new items first. If everything is tracked, say so with the counts. If the brief names an output path
   anyway, return the items inline and say no file was written (the auditor has no Write tool).
