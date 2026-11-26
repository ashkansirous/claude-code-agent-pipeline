"""Split a long plan.md into one file per slice, and check nothing was lost.

Subcommands (stdlib only, run with `python -I`):

  propose <plan.md> <manifest.json>
      Cut plan.md into segments and write a manifest proposing where each goes:
      "keep" (stays in plan.md), docs/plan/slices/NN-<slug>.md, or
      docs/plan/notes/<date>-<slug>.md. Review and edit the manifest's "target"
      fields before applying; the proposal is a heuristic.

  apply <plan.md> <manifest.json> <repo-root>
      Write every segment to its target (segments sharing a target are joined in
      their original order) and rewrite plan.md with the "keep" segments only.
      The manifest must tile plan.md (each segment starts right after the previous
      one ends, the last ends at the end of the file) or it exits before writing.
      Writes <plan.md>.bak first. plan.md's line endings (CRLF or LF) are preserved.
      Checks every target first: if any exists and --append is not given, it exits
      before writing anything. With --append it adds to existing targets. Either way
      it writes <manifest>.prior.json: the prior text of each pre-existing target and
      the list of files it created, so a failed run can be undone precisely.

  move <plan.md> <slice-number> <repo-root> [<target>]
      Move every section of one slice number (all its sub-slice and "results"
      sections) verbatim from plan.md to <target> (default
      docs/plan/slices/NN-<slug>.md; appended to if it exists). Same safety as apply:
      tiling check and a <plan.md>.bak first. Prints the target path.

  verify <original-plan.md> <repo-root> <manifest.json>
      Check that the new plan.md plus every target file together hold exactly the
      original's lines. Run it straight after apply, before editing the index. Lines
      that were in a target before an --append (from <manifest>.prior.json) are not
      counted.

  check-moved <old-CLAUDE.md> <new-CLAUDE.md> <docs-dir>
      List every non-blank line removed from CLAUDE.md that does not appear,
      verbatim, in some Markdown file under <docs-dir>. Empty output = nothing lost.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from collections import Counter
from pathlib import Path

SLICE_HEADING = re.compile(r"^#{2,3}\s+Slice\s+(\d+)[a-z]?\b(.*)$")
NOTE_HEADING = re.compile(r"^##\s+(.+)$")
DATE = re.compile(r"(\d{4}-\d{2}-\d{2})")
NOT_BUILT = re.compile(r"\bnot built\b", re.IGNORECASE)
BUILT = re.compile(r"(?<!not )\b(built|shipped|merged)\b", re.IGNORECASE)
KEEP_TITLES = re.compile(r"^\W*(explicitly out of scope|out of scope|outstanding work|status)\b",
                         re.IGNORECASE)
FENCE = re.compile(r"^\s*(```|~~~)")
PRIOR_SUFFIX = ".prior.json"
SLUG_WORDS = 5
TITLE_BREAK = re.compile(r"\s[—(]|:\s|,\s|\*")
STATUS_LINES = 15
BACKUP_SUFFIX = ".bak"


def read_lines(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    return text.replace("\r\n", "\n").split("\n")


def read_raw_lines(path: Path) -> tuple[list[str], str]:
    """Lines with their original endings kept, and the file's ending (CRLF if it has any)."""
    with open(path, encoding="utf-8", newline="") as handle:
        text = handle.read()
    eol = "\r\n" if "\r\n" in text else "\n"
    return re.findall(r"[^\n]*\n|[^\n]+", text), eol


def slugify(text: str) -> str:
    """Kebab-case of the title up to its first clause break ("Slice 0 — Probe *(…)*" → "probe")."""
    head = TITLE_BREAK.split(text.strip(" —-:*"), maxsplit=1)[0]
    words = re.findall(r"[a-z0-9]+", head.lower())
    return "-".join(words[:SLUG_WORDS]) or "untitled"


def heading_lines(lines: list[str]) -> list[int]:
    """Indexes of slice or ## headings that sit outside fenced code blocks."""
    found = []
    in_fence = False
    for i, line in enumerate(lines):
        if FENCE.match(line):
            in_fence = not in_fence
        if not in_fence and (SLICE_HEADING.match(line) or NOTE_HEADING.match(line)):
            found.append(i)
    return found


def segment_starts(lines: list[str]) -> list[int]:
    """Line indexes where a slice or a top-level note begins, after the preamble."""
    headings = heading_lines(lines)
    first_slice = next((i for i in headings if SLICE_HEADING.match(lines[i])), None)
    if first_slice is None:
        return []
    return [i for i in headings if i >= first_slice]


def propose_target(heading: str, body: str) -> str:
    slice_match = SLICE_HEADING.match(heading)
    if slice_match:
        status = "\n".join(body.split("\n")[:STATUS_LINES])
        # Order matters: an explicit "not built" keeps; a positive built/shipped/merged
        # moves even if "planned" or "in progress" also appears; no signal keeps.
        if NOT_BUILT.search(status) or not BUILT.search(status):
            return "keep"
        number = int(slice_match.group(1))
        title = slice_match.group(2).strip(" —-:*")
        return f"docs/plan/slices/{number:02d}-{slugify(title)}.md"
    title = NOTE_HEADING.match(heading).group(1)
    if KEEP_TITLES.match(title):
        return "keep"
    date = DATE.search(title)
    prefix = f"{date.group(1)}-" if date else ""
    return f"docs/plan/notes/{prefix}{slugify(DATE.sub('', title))}.md"


def build_manifest(raw_lines: list[str]) -> list[dict]:
    lines = [line.rstrip("\r\n") for line in raw_lines]
    starts = segment_starts(lines)
    if not starts:
        return [{"start": 1, "end": len(lines), "heading": "(whole file)", "target": "keep"}]
    bounds = list(zip(starts, starts[1:] + [len(lines)]))
    manifest = [{"start": 1, "end": starts[0], "heading": "(preamble)", "target": "keep"}]
    for begin, end in bounds:
        body = "\n".join(lines[begin:end])
        manifest.append({"start": begin + 1, "end": end, "heading": lines[begin],
                         "target": propose_target(lines[begin], body)})
    return merge_same_slice(manifest)


def merge_same_slice(manifest: list[dict]) -> list[dict]:
    """All sections of one slice number share a target; one `keep` keeps them all."""
    by_number: dict[int, list[dict]] = {}
    for entry in manifest:
        match = SLICE_HEADING.match(entry["heading"])
        if match:
            by_number.setdefault(int(match.group(1)), []).append(entry)
    for entries in by_number.values():
        targets = [e["target"] for e in entries]
        shared = "keep" if "keep" in targets else targets[0]
        for entry in entries:
            entry["target"] = shared
    return manifest


def validate_tiling(manifest: list[dict], line_count: int) -> None:
    """Exit unless the segments cover lines 1..end of file exactly once, in order."""
    expected = 1
    for entry in manifest:
        if entry["start"] != expected or entry["end"] < entry["start"]:
            sys.exit(f"manifest does not tile plan.md: segment at line {entry['start']}"
                     f"-{entry['end']} (expected to start at {expected})")
        expected = entry["end"] + 1
    if expected != line_count + 1:
        sys.exit(f"manifest does not tile plan.md: it ends at line {expected - 1}, "
                 f"the file has {line_count}")


def segment_text(lines: list[str], entry: dict, eol: str) -> str:
    chunk = "".join(lines[entry["start"] - 1:entry["end"]])
    return chunk.replace("\r\n", "\n").strip("\n").replace("\n", eol) + eol


def ends_in_fence(segment: list[str]) -> bool:
    """Whether a fenced code block opened in the segment is still open at its last line."""
    fenced = False
    for line in segment:
        if FENCE.match(line):
            fenced = not fenced
    return fenced


def kept_segment(lines: list[str], entry: dict, eol: str) -> str:
    """A kept segment as it was, except that its trailing blank lines shrink to one (unless the segment ends
    inside an unclosed code fence: those blank lines are code, so it is kept whole)."""
    segment = lines[entry["start"] - 1:entry["end"]]
    if ends_in_fence(segment):
        return "".join(segment)
    trailing = 0
    while segment and not segment[-1].strip():
        segment.pop()
        trailing += 1
    text = "".join(segment)
    if trailing and (not text or text.endswith("\n")):
        text += eol
    return text


def kept_text(lines: list[str], manifest: list[dict], eol: str) -> str:
    """Kept segments as they were; a segment's trailing blank lines shrink to one (a run of eight
    blank lines was left in plan.md by the 2026-10-30 pass, Slice 307)."""
    out = ""
    for entry in manifest:
        if entry["target"] == "keep":
            if out and not out.endswith("\n"):
                out += eol
            out += kept_segment(lines, entry, eol)
    return out


def group_by_target(lines: list[str], manifest: list[dict], eol: str) -> dict[str, list[str]]:
    """Moved segments per target, in order. `keep` is listed (empty) when any segment stays."""
    groups: dict[str, list[str]] = {}
    for entry in manifest:
        parts = groups.setdefault(entry["target"], [])
        if entry["target"] != "keep":
            parts.append(segment_text(lines, entry, eol))
    return groups


def check_targets(groups: dict[str, list[str]], root: Path, append: bool) -> list[str]:
    """Targets that already exist; exits before any write if that isn't allowed."""
    existing = [t for t in groups if t != "keep" and (root / t).exists()]
    if existing and not append:
        sys.exit("refusing to overwrite (pass --append to add to them): " + ", ".join(existing))
    return existing


def record_prior(path: Path, groups: dict[str, list[str]], root: Path, existing: list[str]) -> None:
    prior = {t: (root / t).read_text(encoding="utf-8") for t in existing}
    created = [t for t in groups if t != "keep" and t not in existing]
    record = {"prior": prior, "created": created}
    path.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")


def write_targets(groups: dict[str, list[str]], root: Path, eol: str) -> None:
    for target, parts in groups.items():
        if target == "keep":
            continue
        path = root / target
        path.parent.mkdir(parents=True, exist_ok=True)
        existing = ""
        if path.exists():
            with open(path, encoding="utf-8", newline="") as handle:
                existing = handle.read() + eol
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(existing + eol.join(parts))


def write_plan(plan: Path, lines: list[str], manifest: list[dict], eol: str) -> None:
    """Back plan.md up to <plan.md>.bak, then rewrite it with the kept segments."""
    shutil.copyfile(plan, str(plan) + BACKUP_SUFFIX)
    with open(plan, "w", encoding="utf-8", newline="") as handle:
        handle.write(kept_text(lines, manifest, eol))


def cmd_propose(plan: str, manifest_path: str) -> None:
    lines, _ = read_raw_lines(Path(plan))
    manifest = build_manifest(lines)
    text = json.dumps(manifest, indent=2, ensure_ascii=False)
    Path(manifest_path).write_text(text, encoding="utf-8")
    for entry in manifest:
        print(f"{entry['start']:>6}  {entry['target']:<60}  {entry['heading'][:70]}")


def cmd_apply(plan: str, manifest_path: str, root: str, append: bool) -> None:
    lines, eol = read_raw_lines(Path(plan))
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    validate_tiling(manifest, len(lines))
    groups = group_by_target(lines, manifest, eol)
    existing = check_targets(groups, Path(root), append)
    record_prior(Path(manifest_path + PRIOR_SUFFIX), groups, Path(root), existing)
    write_targets(groups, Path(root), eol)
    write_plan(Path(plan), lines, manifest, eol)
    kept = sum(1 for e in manifest if e["target"] == "keep")
    print(f"wrote {len(groups) - ('keep' in groups)} files; plan.md keeps {kept} segments "
          f"(backup: {plan}{BACKUP_SUFFIX})")


def slice_manifest(lines: list[str], number: int, target: str | None) -> tuple[list[dict], str]:
    """Manifest that moves every section of slice `number` to one target, keeping the rest."""
    manifest = build_manifest(lines)
    mine = [e for e in manifest
            if (m := SLICE_HEADING.match(e["heading"])) and int(m.group(1)) == number]
    if not mine:
        sys.exit(f"no section for Slice {number} in plan.md")
    first = SLICE_HEADING.match(mine[0]["heading"])
    chosen = target or f"docs/plan/slices/{number:02d}-{slugify(first.group(2).strip(' —-:*'))}.md"
    for entry in manifest:
        entry["target"] = chosen if any(entry is m for m in mine) else "keep"
    return manifest, chosen


def cmd_move(plan: str, number: str, root: str, target: str | None = None) -> None:
    lines, eol = read_raw_lines(Path(plan))
    manifest, chosen = slice_manifest(lines, int(number), target)
    validate_tiling(manifest, len(lines))
    groups = group_by_target(lines, manifest, eol)
    write_targets(groups, Path(root), eol)
    write_plan(Path(plan), lines, manifest, eol)
    print(chosen)


def nonblank(lines: list[str]) -> Counter:
    kept = [line for line in lines if line.strip()]
    return Counter(kept)


def prior_lines(manifest_path: str) -> Counter:
    """Non-blank lines that --append targets already held before apply ran."""
    path = Path(manifest_path + PRIOR_SUFFIX)
    if not path.exists():
        return Counter()
    total: Counter = Counter()
    for text in json.loads(path.read_text(encoding="utf-8"))["prior"].values():
        total += nonblank(text.replace("\r\n", "\n").split("\n"))
    return total


def blank_runs(lines: list[str]) -> Counter:
    """The runs of two or more blank lines outside fenced code blocks, each keyed by the non-blank line
    before it only: archiving a segment changes the line AFTER an old run, so keying by both lines failed correct
    archives (review of Slice 307); a run moved elsewhere still has a different line before it."""
    runs: Counter = Counter()
    blanks, fenced, previous = 0, False, ""
    body = list(lines)
    while body and not body[-1].strip():  # blank lines at the end of the file are not a run between content
        body.pop()
    for line in body + [None]:
        blank = line is not None and not fenced and not line.strip()
        if blank:
            blanks += 1
            continue
        if blanks >= 2:
            runs[previous] += 1
        blanks = 0
        if line is not None:
            if FENCE.match(line):
                fenced = not fenced
            previous = line.strip()
    return runs


def check_blank_runs(original: str, root: str) -> None:
    """Exit when the new plan.md has a blank-line run (by its neighbouring lines) the original did not have."""
    before = blank_runs(read_lines(Path(original)))
    added = blank_runs(read_lines(Path(root) / "plan.md")) - before
    if added:
        sys.exit(f"blank lines: plan.md has {sum(added.values())} new runs of 2+ blank lines, e.g. after: {next(iter(added))[:80]}")


def cmd_verify(original: str, root: str, manifest_path: str) -> None:
    check_blank_runs(original, root)
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    targets = {entry["target"] for entry in manifest if entry["target"] != "keep"}
    now = nonblank(read_lines(Path(root) / "plan.md"))
    for target in targets:
        now += nonblank(read_lines(Path(root) / target))
    now = now - prior_lines(manifest_path)
    before = nonblank(read_lines(Path(original)))
    report_difference("missing", before - now)
    report_difference("extra", now - before)
    if before != now:
        sys.exit(1)
    print(f"ok: {sum(before.values())} non-blank lines, all accounted for")


def report_difference(label: str, diff: Counter) -> None:
    for line, count in list(diff.items())[:20]:
        print(f"{label} x{count}: {line[:120]}")


def cmd_check_moved(old: str, new: str, docs_dir: str) -> None:
    removed = nonblank(read_lines(Path(old))) - nonblank(read_lines(Path(new)))
    docs = set()
    for path in Path(docs_dir).rglob("*.md"):
        docs.update(line.strip() for line in read_lines(path))
    lost = [line for line in removed if line.strip() not in docs]
    for line in lost:
        print(f"lost: {line[:160]}")
    sys.exit(1 if lost else 0)


def main(argv: list[str]) -> None:
    append = "--append" in argv
    args = [a for a in argv if a != "--append"]
    commands = {"propose": (cmd_propose, 2, 2), "apply": (cmd_apply, 3, 3),
                "verify": (cmd_verify, 3, 3), "check-moved": (cmd_check_moved, 3, 3),
                "move": (cmd_move, 3, 4)}
    if not args or args[0] not in commands:
        sys.exit(__doc__)
    func, low, high = commands[args[0]]
    if not low <= len(args) - 1 <= high:
        sys.exit(__doc__)
    func(*args[1:], append) if args[0] == "apply" else func(*args[1:])


if __name__ == "__main__":
    main(sys.argv[1:])
