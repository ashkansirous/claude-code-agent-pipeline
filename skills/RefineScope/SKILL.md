---
name: RefineScope
description: Interview the user with at most 4 high-leverage questions about a plan or design, then recommend answers for the open decisions in one batch. Use for a fast clarification pass before planning, or on "refine scope", "refine the scope", "RefineScope", "quick clarify", or invokes `/RefineScope`.
---

Walk the design tree for the user's plan and identify every open decision.

## When to use this skill

Invoke this skill **only**:

- When the user has a plan or design and wants a fast clarification
  pass before committing to it.
- As the "clarify intent" step at the start of the planning workflow in
  `~/.claude/CLAUDE.md`.

Do **not** invoke this skill:

- For a free-form chat that has not yet produced a candidate plan or
  design — ask the user to share their plan first.
- When the user has already approved a plan — they want execution, not
  more questions.

## Process

Pick at most 4 questions to ask the user. Choose the ones with the highest
information gain — i.e. answers that resolve or constrain the most other
open decisions. Never exceed 4 questions, no matter how complex the plan.

If a question can be answered by exploring the codebase, explore the
codebase instead of asking. Do not grep file by file on the main thread:
collect every such factual question ("does X exist?", "where is Y
handled?", "what does Z assume?") and send them in **one** `ground-in-code`
call (Sonnet) with the repo or worktree path. Use its file:line conclusions
when you pick the questions and write the recommendations.

This skill runs inline, on the session's own model, on purpose. It talks to
the user, which a subagent can't do, so never wrap it in an agent. Its
frontmatter deliberately has no `model:` pin: a pin would downgrade a Fable
session on a risky slice, where the stronger model is worth it most.

For every remaining open decision, write a single recommendation block in
this format:

> Here are my questions, each with the answer I suggest. Are you OK with them?
>
> **<question>**
> <recommended answer>
> Alternatives: <other options>. I recommend <answer> because <reason>.
> Second choice: <runner-up> because <reason>.

Write every question and answer in plain words a non-developer follows on first
read: what the user will see or do, not class, file or slice names; one idea per
sentence; no shorthand like `A -> B` or "per Decision 12". If an answer needs a
term, explain it in the same sentence. (2026-11-01, ReadTheStupidText: "your text
is not understandable".)

Wait for the user's approval. Once they confirm, if the conversation
does not already have a good, descriptive name, tell the user to run
`/rename` and suggest a specific topic-relevant name based on what was
just discussed. `/rename` is a UI-only command and cannot be invoked
from the agent, so do not try to invoke it yourself — just prompt the
user.

Example phrasing: "This thread doesn't have a good name yet. Run
`/rename` and call it something like `creating to-scope skill`."

Then the skill is done — hand control back to the caller. Do not write
plan.md or take further action.

**Reminder to the caller.** When RefineScope returns, the caller is
responsible for the rest of the planning workflow (`to-plan`): each slice
goes into its own `docs/plan/slices/NN-<slug>.md` with a row in `plan.md`'s
status table, never overwriting `plan.md` and not only the harness-provided
plan path. If you are the caller and just received approval here, that is
your next action. The harness's plan file is the agent's working memory; the
slice files are the record the user can see, commit and tick off.

If the plan has 4 or fewer total decisions, just ask all of them and skip
the recommendation block.

