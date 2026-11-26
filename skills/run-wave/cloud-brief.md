# Cloud worker brief (run-wave)

The coordinator fills the four `<...>` values and puts the result into the worker routine's prompt
(`RemoteTrigger update`, then `run`; see `SKILL.md`, section 3, *Cloud slices*). The brief is for a cloud
session that only writes code: no profile, no agents, no hooks, no reviews.

---

You are building one already-designed slice in the repository `<owner>/<repo>`. Implementation only.

1. The slice file is `<slice file path>` on the branch `<claim branch>`. Run `git fetch origin <claim branch>`
   and `git switch <claim branch>` first. The slice file wins over anything in this brief where they differ.
   Follow every line of its Work items. Edit only the paths on its **Touches:** line (and tick finished work items in
   the slice file itself, item 3); if the work needs any other file, stop and say which file and why on your last line.
   An item whose text asks for a run, dry run or verify stays unticked: list it under *Not yet verified* in the slice file (one `sed` once ticked every item, two dry runs never run).
2. Match the surrounding code's naming and idioms. Write unit tests for new pure logic. Read the repo's
   `CLAUDE.md` for the commands, then run its typecheck, lint and unit tests (the ones that need no
   emulator, VM or phone) until they pass. Never run anything on a device.
3. Do not review your own work, do not write findings or notes files, do not edit `plan.md`, `CLAUDE.md`,
   `README.md` or the slice file's status line. You may also tick, in the slice's own file, the work items you
   finished (the one file allowed besides the paths on its **Touches:** line). Never tick an item whose text asks for a run, dry run or verify: it goes to *Not yet verified*.
4. Commit with a plain message (`feat(<scope>): Slice <N> <title>`), with **no `Co-Authored-By` line** and no
   session link. Push to the claim branch: `git push origin <claim branch>`. Never push to `main`, never
   force-push, never create or delete another branch, never open or merge a pull request (the claim PR
   `#<pr number>` already exists; the local coordinator reviews and merges it).
5. GitHub from this session is REST only: `gh pr list`, `gh pr create` and any GraphQL call answer 403.
   If you need GitHub data, use `gh api repos/<owner>/<repo>/...`.
6. Your last line is exactly one of these, so the coordinator can match it:
   - `CLOUD DONE <full commit sha> pushed=yes` when the branch is pushed and the checks pass;
   - `CLOUD DONE <full commit sha> pushed=yes checks=failing <one line: what fails>` when pushed but a check fails;
   - `CLOUD BLOCKED <one line: the file or fact that stops you>` when you could not build it.

   Work you pushed but did not finish (some items left unticked) still ends with a `CLOUD DONE` line for the pushed
   sha: the unticked items in the slice file tell the coordinator what is left. Never end on a summary alone; a run
   with no last line is read as failed (`cloud-wait.mjs`) and its wait runs to the cap (four runs in two nights:
   Slices 32, 33 and 35 on 2026-11-18, Slice 45 on 2026-11-19, run cse_012UYzYTQPjHnFmQh4F6DBt4).
