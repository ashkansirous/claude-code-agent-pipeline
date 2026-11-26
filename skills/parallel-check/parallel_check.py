"""Which slices can run in parallel: compare their Touches lines with live work.

Live work is every open PR (draft included) and every worktree with changes against
origin/main. Stdlib only; run with `python -I`.

    parallel_check.py <repo> [--slices N ...] [--shared GLOB ...]
    parallel_check.py <worktree> --check-slice <branch>

--check-slice exits 1 when a slice file this branch adds uses an id (`212`, `212a`)
that origin/main, another open PR, or another worktree or branch already holds, or when a
Touches line in a slice file it adds or edits names a folder the branch does not have and is
not marked `(new)`, `(removed)` or `(deleted)` (2026-11-01: two claims named `tools/emulator/flows/**`, a folder that never existed).
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from fnmatch import fnmatch
from pathlib import Path

BASE = "origin/main"
DEFAULT_SHARED = [
    "plan.md", "CLAUDE.md", "README.md", "AGENTS.md", "docs/*",
    "*/locales/*", "*/i18n/*",
]
SHARED_FILE = ".claude/parallel-shared.txt"
MIGRATIONS_RE = re.compile(r"^\*\*Migrations:\*\*(.*)$", re.MULTILINE)
TOUCHES_STOPS = ("**", "#", "- ", "* ")
TOUCHES_HEAD_RE = re.compile(r"^\*\*Touches(?:,.*?)?:\*\*")
SLICE_DIR = "docs/plan/slices/"
SLICE_FILE_RE = re.compile(r"docs/plan/slices/(\d+[a-z]?)-")
TABLE_ROW_RE = re.compile(r"^\|\s*(\d+[a-z]?)\s*\|", re.MULTILINE)
DIGITS_RE = re.compile(r"\d+")
MIGRATION_PATH_RE = re.compile(r"(?:^|/)migrations/(\d+)_")
BACKTICK_RE = re.compile(r"`([^`]+)`")
WILDCARDS = "*?["
GH_FILES_CAP = 100
STALE_DRAFT_HOURS = 24
# RTST Slice 354 item 14: a feedback-loop worktree (branch `chore/feedback-loop-*`) with no PR whose newest commit is older than
# this is abandoned, not live work (fl1703 held up three slices for days). Its folder is still listed, as a note.
LOOP_BRANCH_PREFIX = "chore/feedback-loop-"
LOOP_WORKTREE_HOURS = 24
UNCOMMITTED = "same files, uncommitted so not trial-merged"
UNAVAILABLE = "trial merge unavailable (git merge-tree --write-tree needs git 2.38+)"


@dataclass
class Work:
    label: str
    patterns: list[str] = field(default_factory=list)
    migrations: set[str] = field(default_factory=set)
    has_touches: bool = True
    ref: str | None = None
    dirty: bool = False
    pr_number: int | None = None
    claim_pr: int | None = None


def run(repo: Path, *args: str) -> str:
    result = subprocess.run(
        list(args), cwd=repo, capture_output=True, text=True, encoding="utf-8",
    )
    if result.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def normalize(pattern: str) -> str:
    """A directory entry (trailing slash) means everything under it."""
    return pattern + "*" if pattern.endswith("/") else pattern


def touches_block(text: str) -> str | None:
    """Every Touches line (`**Touches:**` and per-part `**Touches, part A (...):**`) plus its hard-wrapped
    continuation lines, joined: a slice's paths are the union of all of them (2026-11-04: Slice 246 had only
    per-part lines and read as "no Touches line", so it was held back)."""
    lines, found = text.splitlines(), []
    for i, line in enumerate(lines):
        head = TOUCHES_HEAD_RE.match(line)
        if not head:
            continue
        block = [line[head.end():]]
        for more in lines[i + 1:]:
            if not more.strip() or more.startswith(TOUCHES_STOPS):
                break
            block.append(more)
        found.append("\n".join(block))
    return "\n".join(found) if found else None


def parse_touches(text: str) -> list[str] | None:
    block = touches_block(text)
    if block is None:
        return None
    paths = [normalize(p.strip()) for p in BACKTICK_RE.findall(block) if p.strip()]
    return list(dict.fromkeys(paths))


def parse_migrations(text: str) -> set[str]:
    match = MIGRATIONS_RE.search(text)
    if match is None:
        return set()
    return set(re.findall(r"\b\d{4,}\b", match.group(1)))


def migrations_in(paths: list[str]) -> set[str]:
    found = set()
    for path in paths:
        match = MIGRATION_PATH_RE.search(path)
        if match:
            found.add(match.group(1))
    return found


def claim_for(repo: Path, prs: list[dict], digits: int) -> tuple[dict, str] | None:
    """An open PR that already holds this slice's file, with that file's path."""
    pattern = re.compile(rf"docs/plan/slices/{digits:02d}[a-z]?-")
    for pr in prs:
        for path in pr_paths(repo, pr):
            if pattern.match(path):
                return pr, path
    return None


def git_show(repo: Path, ref: str, path: str) -> str | None:
    try:
        return run(repo, "git", "show", f"{ref}:{path}")
    except RuntimeError:
        return None


def main_slice_text(repo: Path, digits: int) -> str | None:
    """The slice's own file on origin/main, else its section in plan.md."""
    listing = run(repo, "git", "ls-tree", "-r", "--name-only", BASE, "docs/plan/slices")
    prefix = f"docs/plan/slices/{digits:02d}-"
    for path in listing.splitlines():
        if path.startswith(prefix):
            return git_show(repo, BASE, path)
    plan = git_show(repo, BASE, "plan.md")
    if plan is None:
        return None
    head = rf"^#{{2,4}} Slice {digits}[a-z]?\b"
    stop = rf"^#{{2,4}} Slice (?!{digits}[a-z]?\b)|\Z"
    match = re.search(rf"{head}.*?(?={stop})", plan, re.M | re.S)
    return match.group(0) if match else None


def candidate(repo: Path, ident: str, prs: list[dict]) -> Work:
    lead = re.match(r"\d+", ident)
    work = Work(f"Slice {ident}")
    text = None
    if lead is not None:
        digits = int(lead.group(0))
        claim = claim_for(repo, prs, digits)
        if claim is None:
            text = main_slice_text(repo, digits)
        else:
            pr, path = claim
            work.label += f" (claimed by PR #{pr['number']})"
            work.claim_pr = pr["number"]
            text = git_show(repo, f"origin/{pr['headRefName']}", path)
    if text is None:
        work.label += " (not found)"
        work.has_touches = False
        return work
    touches = parse_touches(text)
    work.has_touches = touches is not None
    work.patterns = touches or []
    work.migrations = parse_migrations(text)
    return work


def open_prs(repo: Path) -> list[dict]:
    fields = "number,title,headRefName,isDraft,body,files,updatedAt"
    raw = run(repo, "gh", "pr", "list", "--state", "open", "--limit", "100", "--json", fields)
    return json.loads(raw)


def closed_branches(repo: Path) -> set[str]:
    raw = run(repo, "gh", "pr", "list", "--state", "all", "--limit", "300",
              "--json", "headRefName,state")
    return {pr["headRefName"] for pr in json.loads(raw) if pr["state"] != "OPEN"}


def pr_paths(repo: Path, pr: dict) -> list[str]:
    """The PR's files; gh caps the list at 100, so a full list is re-read from git."""
    paths = [f["path"] for f in pr.get("files") or []]
    if len(paths) < GH_FILES_CAP:
        return paths
    try:
        diff = run(repo, "git", "diff", "--name-only",
                   f"{BASE}...origin/{pr['headRefName']}")
    except RuntimeError:
        return paths
    return diff.splitlines()


def is_stale_draft(pr: dict, now: datetime | None = None) -> bool:
    """A draft not updated for STALE_DRAFT_HOURS: its declared Touches no longer hold other slices back.

    (2026-11-01: idle drafts #638 and #435 held back 8 of 13 planned slices by Touches alone; #435 changed
    one file.) Its real diff still counts.
    """
    stamp = pr.get("updatedAt")
    if not pr.get("isDraft") or not stamp:
        return False
    updated = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    return (now or datetime.now(timezone.utc)) - updated > timedelta(hours=STALE_DRAFT_HOURS)


def pr_work(repo: Path, pr: dict, now: datetime | None = None) -> Work:
    paths = pr_paths(repo, pr)
    body = pr.get("body") or ""
    stale = is_stale_draft(pr, now)
    claimed = [] if stale else parse_touches(body) or []
    draft = " draft" if pr.get("isDraft") else ""
    if stale:
        draft += f", idle over {STALE_DRAFT_HOURS} h: only its changed files count"
    work = Work(f"PR #{pr['number']}{draft} [{pr['headRefName']}]", paths + claimed)
    work.ref = f"origin/{pr['headRefName']}"
    work.pr_number = pr["number"]
    work.migrations = migrations_in(paths) | parse_migrations(body)
    return work


def worktrees(repo: Path) -> list[tuple[Path, str]]:
    """(path, branch) for every worktree on a branch other than main."""
    found, path = [], None
    for line in run(repo, "git", "worktree", "list", "--porcelain").splitlines():
        if line.startswith("worktree "):
            path = Path(line[len("worktree "):])
        elif line.startswith("branch ") and path is not None:
            branch = line[len("branch refs/heads/"):]
            if branch != "main":
                found.append((path, branch))
    return found


def worktree_paths(path: Path) -> tuple[list[str], list[str]]:
    """(committed, uncommitted) files the worktree changed against origin/main."""
    committed = run(path, "git", "diff", "--name-only", f"{BASE}...HEAD").splitlines()
    pending = []
    status = run(path, "git", "status", "--porcelain", "--untracked-files=all")
    for line in status.splitlines():
        name = line[3:].split(" -> ")[-1].strip('"')
        pending.append(name)
    return committed, pending


def add_pending(work: Work, pending: list[str]) -> None:
    """Fold a worktree's uncommitted paths into the open PR it belongs to."""
    work.patterns = sorted(set(work.patterns) | set(pending))
    work.migrations |= migrations_in(pending)
    work.dirty = True


def loose_worktree(branch: str, committed: list[str], pending: list[str]) -> Work | None:
    paths = sorted(set(committed) | set(pending))
    if not paths:
        return None
    work = Work(f"worktree [{branch}] (no PR)", paths)
    work.ref = branch if committed else None
    work.dirty = bool(pending)
    work.migrations = migrations_in(paths)
    return work


def worktree_activity(path: Path, pending: list[str]) -> datetime | None:
    """The newest time something happened in a worktree that a commit date does not show: its creation (the `.git` link file) or an edit to an uncommitted file."""
    stamps = []
    for target in [path / ".git", *(path / name for name in pending)]:
        try:
            stamps.append(target.stat().st_mtime)
        except OSError:
            continue
    return datetime.fromtimestamp(max(stamps), timezone.utc) if stamps else None


def is_abandoned_loop_worktree(path: Path, branch: str, now: datetime | None = None, pending: list[str] | None = None) -> bool:
    """A `chore/feedback-loop-*` worktree with no commit, creation or uncommitted edit newer than LOOP_WORKTREE_HOURS (an unreadable date is live).

    A branch cut from main carries main's last commit date, so the commit date alone would call a fresh worktree abandoned."""
    if not branch.startswith(LOOP_BRANCH_PREFIX):
        return False
    try:
        stamp = run(path, "git", "log", "-1", "--format=%cI", "HEAD").strip()
        newest = datetime.fromisoformat(stamp)
    except (RuntimeError, ValueError):
        return False
    activity = worktree_activity(path, pending or [])
    if activity is not None and activity > newest:
        newest = activity
    return (now or datetime.now(timezone.utc)) - newest > timedelta(hours=LOOP_WORKTREE_HOURS)


def worktree_work(repo: Path, by_branch: dict[str, Work], closed: set[str], now: datetime | None = None) -> list[Work]:
    works = []
    for path, branch in worktrees(repo):
        if not path.exists():
            continue
        try:
            committed, pending = worktree_paths(path)
        except RuntimeError:
            continue
        if branch in by_branch:
            if pending:
                add_pending(by_branch[branch], pending)
        elif is_abandoned_loop_worktree(path, branch, now, pending):
            print(f"note: {path} [{branch}] is an abandoned feedback-loop worktree (no commit, creation or edit within {LOOP_WORKTREE_HOURS} h, no PR): not counted as live work.", file=sys.stderr)
        elif branch not in closed or pending:
            work = loose_worktree(branch, committed, pending)
            if work is not None:
                works.append(work)
    return works


def active_work(repo: Path, prs: list[dict]) -> list[Work]:
    pr_works = [pr_work(repo, pr) for pr in prs]
    by_branch = {pr["headRefName"]: w for pr, w in zip(prs, pr_works)}
    return pr_works + worktree_work(repo, by_branch, closed_branches(repo))


def literal_prefix(pattern: str) -> str:
    cut = [pattern.index(c) for c in WILDCARDS if c in pattern]
    return pattern[: min(cut)] if cut else pattern


def overlaps(a: str, b: str) -> bool:
    a, b = normalize(a), normalize(b)
    if a == b or fnmatch(a, b) or fnmatch(b, a):
        return True
    pa, pb = literal_prefix(a), literal_prefix(b)
    if not pa or not pb or (pa == a and pb == b):
        return False
    return pa.startswith(pb) or pb.startswith(pa)


def is_shared(path: str, shared: list[str]) -> bool:
    for glob in shared:
        stripped = glob.lstrip("*/")
        if fnmatch(path, glob) or (stripped and fnmatch(path, stripped)):
            return True
    return False


def collisions(a: Work, b: Work, shared: list[str]) -> tuple[list[str], list[str]]:
    """(hard overlaps, shared-file overlaps) between two pieces of work."""
    hard, soft = set(), set()
    for pa in a.patterns:
        for pb in b.patterns:
            if not overlaps(pa, pb) or ("migrations/" in pa and "migrations/" in pb):
                continue
            name = pa if len(pa) >= len(pb) else pb
            (soft if is_shared(name, shared) else hard).add(name)
    return sorted(hard), sorted(soft)


def main_migrations(repo: Path) -> set[str]:
    listing = run(repo, "git", "ls-tree", "-r", "--name-only", BASE)
    return migrations_in(listing.splitlines())


def next_migration(taken: set[str]) -> str:
    if not taken:
        return "none (no numbered migrations found)"
    width = max(len(n) for n in taken)
    return str(max(int(n) for n in taken) + 1).zfill(width)


def slice_ids(paths: list[str]) -> set[str]:
    """The slice ids (`212`, `212a`) named by slice-file paths."""
    return {m.group(1) for m in map(SLICE_FILE_RE.match, paths) if m}


def added_slice_files(repo: Path, ref: str) -> list[str]:
    """Slice files `ref` adds against origin/main; an edited file is not listed."""
    out = run(repo, "git", "diff", "--diff-filter=A", "--no-renames", "--name-only",
              f"{BASE}...{ref}", "--", SLICE_DIR)
    return out.splitlines()


def branch_refs(repo: Path, own: str, skip: set[str]) -> list[str]:
    """Local and origin branch refs other than this branch, main and closed-PR branches."""
    out = run(repo, "git", "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin")
    by_name: dict[str, str] = {}
    for ref in out.splitlines():
        local = not ref.startswith("refs/remotes/")
        name = ref[len("refs/heads/"):] if local else ref.split("/", 3)[-1]
        if name not in (own, "main", "HEAD") and name not in skip and (local or name not in by_name):
            by_name[name] = ref
    return list(by_name.values())


def slice_holders(repo: Path, prs: list[dict], own: str) -> dict[str, set[str]]:
    """Slice id -> who holds it: origin/main, open PRs, worktrees and branches (not `own`)."""
    holders: dict[str, set[str]] = {}

    def add(ids: set[str], who: str) -> None:
        for ident in ids:
            holders.setdefault(ident, set()).add(who)

    plan = git_show(repo, BASE, "plan.md") or ""
    add(set(TABLE_ROW_RE.findall(plan)), f"{BASE} plan.md")
    listing = run(repo, "git", "ls-tree", "-r", "--name-only", BASE, SLICE_DIR)
    add(slice_ids(listing.splitlines()), BASE)
    for pr in prs:
        if pr["headRefName"] != own:
            add(slice_ids(pr_paths(repo, pr)), f"PR #{pr['number']} [{pr['headRefName']}]")
    for path, branch in worktrees(repo):
        if branch != own and path.exists():
            try:
                committed, pending = worktree_paths(path)
            except RuntimeError:
                continue
            add(slice_ids(committed + pending), f"worktree [{branch}]")
    closed = closed_branches(repo) - {pr["headRefName"] for pr in prs}
    for ref in branch_refs(repo, own, closed):
        try:
            add(slice_ids(added_slice_files(repo, ref)), f"branch {ref}")
        except RuntimeError as error:
            print(f"WARNING: could not read {ref}: {error}", file=sys.stderr)
    return holders


def next_free_slice(holders: dict[str, set[str]]) -> int:
    numbers = [int(DIGITS_RE.match(i).group(0)) for i in holders]
    return max(numbers, default=0) + 1


def touches_entries(text: str, only: set[str] | None = None) -> list[tuple[str, bool]]:
    """(path, marked new) for every backticked entry on a `**Touches...:**` line of a block (head or continuation) with a line in `only`, when given."""
    lines, entries = text.splitlines(), []
    for i, line in enumerate(lines):
        if not line.startswith("**Touches"):
            continue
        block = [line]
        for more in lines[i + 1:]:
            if not more.strip() or more.startswith(TOUCHES_STOPS):
                break
            block.append(more)
        if only is not None and not any(part in only for part in block):
            continue
        joined = " ".join(block)
        for match in BACKTICK_RE.finditer(joined):
            marked = joined[match.end():].lstrip().startswith(("(new", "(removed", "(deleted"))
            entries.append((match.group(1).strip(), marked))
    return entries


def missing_touch_folders(entries: list[tuple[str, bool]], folders: set[str], files: set[str] = frozenset()) -> list[str]:
    """Entries rooted in a real top-level folder whose folder (before any wildcard) is not in the tree
    and that are not marked `(new)`. Project-relative entries (`Reading/X.cs`) are not checked."""
    missing = []
    for path, marked in entries:
        if marked or " " in path or "<" in path or "{" in path or "/" not in path or path.split("/", 1)[0] not in folders:
            continue
        norm = normalize(path)
        if "*" not in norm and "." not in norm.rstrip("/").rsplit("/", 1)[-1]:
            if norm.rstrip("/") not in folders and norm.rstrip("/") not in files:
                missing.append(path)
            continue
        prefix = literal_prefix(norm)
        folder = prefix.rstrip("/") if prefix.endswith("/") else prefix.rsplit("/", 1)[0]
        if folder and folder not in folders:
            missing.append(path)
    return missing


def added_lines(repo: Path, path: str) -> set[str]:
    """The lines this branch adds to `path` against origin/main."""
    diff = run(repo, "git", "diff", "-U0", "--no-renames", f"{BASE}...HEAD", "--", path)
    return {line[1:] for line in diff.splitlines() if line.startswith("+") and not line.startswith("+++")}


def touches_problems(repo: Path) -> list[str]:
    """Touches lines this branch adds to slice files that name a folder HEAD lacks (old lines are left alone)."""
    changed = run(repo, "git", "diff", "--diff-filter=AM", "--no-renames", "--name-only",
                  f"{BASE}...HEAD", "--", SLICE_DIR).splitlines()
    tree = run(repo, "git", "ls-tree", "-r", "--name-only", "HEAD").splitlines()
    folders = {p.rsplit("/", i)[0] for p in tree for i in range(1, p.count("/") + 1)}
    problems = []
    for path in changed:
        entries = touches_entries(git_show(repo, "HEAD", path) or "", added_lines(repo, path))
        problems += [f"{path}: `{p}`" for p in missing_touch_folders(entries, folders, set(tree))]
    return problems


def normalize_branch(name: str) -> str:
    """`refs/heads/x` and `origin/x` both mean the branch `x`."""
    for prefix in ("refs/heads/", "origin/"):
        if name.startswith(prefix):
            return name[len(prefix):]
    return name


def check_slice(repo: Path, own: str) -> int:
    """0 when no slice file this branch adds shares an id with other work and every Touches folder exists, else 1.

    The check diffs HEAD of `repo`, so it refuses when `repo` is not on `own` (Slice 33 item 51:
    run on `main` it said "adds no slice files" while seven were being added)."""
    own = normalize_branch(own)
    current = run(repo, "git", "branch", "--show-current").strip()
    if current != own:
        print(f"WRONG BRANCH: repo is on {current or 'a detached HEAD'}, not {own}; run the check in that branch's worktree")
        return 1
    mine = slice_ids(added_slice_files(repo, "HEAD"))
    holders = slice_holders(repo, open_prs(repo), own)
    clashes = {i: holders[i] for i in sorted(mine) if i in holders}
    for ident, who in clashes.items():
        print(f"COLLISION slice {ident}: already held by {', '.join(sorted(who))}")
    problems = touches_problems(repo)
    for problem in problems:
        print(f"MISSING FOLDER in Touches: {problem} (fix the path, or write `(new)` after it if the folder is new)")
    if clashes:
        print(f"Next free slice number: {next_free_slice(holders)}")
    if clashes or problems:
        return 1
    if not mine:
        print("OK: this branch adds no slice files")
        return 0
    print(f"OK: slice ids {sorted(mine)} are free")
    return 0


def slice_report(repo: Path, prs: list[dict]) -> None:
    own = run(repo, "git", "branch", "--show-current").strip()
    print(f"Slices: next free number {next_free_slice(slice_holders(repo, prs, own))}")


def load_shared(repo: Path, extra: list[str]) -> list[str]:
    path = repo / SHARED_FILE
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    return DEFAULT_SHARED + [l.strip() for l in lines if l.strip()] + extra


def print_active(active: list[Work]) -> None:
    print(f"Active work ({len(active)}):")
    for work in active:
        migr = f", migrations {sorted(work.migrations)}" if work.migrations else ""
        print(f"  {work.label}: {len(work.patterns)} paths{migr}")


def migration_report(repo: Path, works: list[Work]) -> None:
    on_main = main_migrations(repo)
    seen: dict[str, list[str]] = {}
    claimed = {w.claim_pr for w in works if w.claim_pr is not None}
    for work in works:
        if work.pr_number in claimed:
            continue
        for number in work.migrations - on_main:
            seen.setdefault(number, []).append(work.label)
    print(f"Migrations: next free number {next_migration(on_main | set(seen))}")
    for number, labels in sorted(seen.items()):
        flag = "  COLLISION" if len(labels) > 1 else ""
        print(f"  {number}: {', '.join(labels)}{flag}")
    for number in sorted(n for w in works for n in w.migrations if n in on_main):
        print(f"  {number}: already on main, renumber{'':>2}")


def pair_report(cand: Work, other: Work, shared: list[str]) -> bool:
    hard, soft = collisions(cand, other, shared)
    if hard:
        print(f"  CONFLICT {cand.label} x {other.label}: {', '.join(hard[:8])}")
    if soft:
        print(f"  shared   {cand.label} x {other.label}: {', '.join(soft[:5])}")
    return not hard


def merge_conflicts(repo: Path, first: Work, second: Work) -> list[str] | str:
    """Conflicting files of a trial merge, or UNCOMMITTED / UNAVAILABLE."""
    if first.ref is None or second.ref is None or first.dirty or second.dirty:
        return UNCOMMITTED
    result = subprocess.run(
        ["git", "merge-tree", "--write-tree", "--name-only", "--no-messages",
         first.ref, second.ref],
        cwd=repo, capture_output=True, text=True, encoding="utf-8",
    )
    if result.returncode not in (0, 1):
        return UNAVAILABLE
    return result.stdout.splitlines()[1:] if result.returncode == 1 else []


def merge_verdict(real: list[str] | str) -> str:
    if isinstance(real, str):
        return real
    if not real:
        return "same files, merges cleanly"
    return f"CONFLICTS in {', '.join(real)}"


def active_overlaps(repo: Path, active: list[Work], shared: list[str]) -> None:
    print("Overlaps among active work (trial-merged only when both are fully committed):")
    for i, first in enumerate(active):
        for second in active[i + 1:]:
            hard, _ = collisions(first, second, shared)
            if not hard:
                continue
            verdict = merge_verdict(merge_conflicts(repo, first, second))
            print(f"  {first.label} x {second.label}: {verdict} ({', '.join(hard[:5])})")


def safe_set(cands: list[Work], active: list[Work], shared: list[str]) -> list[str]:
    print("Overlaps (CONFLICT = same code; shared = append in your own block):")
    chosen: list[Work] = []
    for cand in cands:
        if not cand.has_touches:
            print(f"  UNKNOWN  {cand.label}: no **Touches:** line, add one first")
            continue
        others = [o for o in active if o.pr_number is None or o.pr_number != cand.claim_pr]
        clear = all([pair_report(cand, o, shared) for o in others + chosen])
        if clear:
            chosen.append(cand)
    return [c.label for c in chosen]


def parse_args(argv: list[str]) -> tuple[Path, list[str], list[str]]:
    if not argv:
        raise SystemExit(__doc__)
    repo, slices, shared, current = Path(argv[0]), [], [], None
    for arg in argv[1:]:
        if arg in ("--slices", "--shared"):
            current = slices if arg == "--slices" else shared
        elif current is not None:
            current.append(arg)
    return repo, slices, shared


def main(argv: list[str]) -> None:
    if "--check-slice" in argv:
        at = argv.index("--check-slice")
        if at != 1 or len(argv) != 3:
            print("usage: parallel_check.py <repo> --check-slice <branch>", file=sys.stderr)
            sys.exit(2)
        repo = Path(argv[0])
        try:
            run(repo, "git", "fetch", "--quiet", "--prune", "origin")
            code = check_slice(repo, argv[argv.index("--check-slice") + 1])
        except (RuntimeError, OSError) as error:
            print(f"ERROR: {error}", file=sys.stderr)
            sys.exit(2)
        sys.exit(code)
    repo, numbers, extra = parse_args(argv)
    run(repo, "git", "fetch", "--quiet", "--prune", "origin")
    shared = load_shared(repo, extra)
    prs = open_prs(repo)
    active = active_work(repo, prs)
    cands = [candidate(repo, n, prs) for n in numbers]
    print_active(active)
    slice_report(repo, prs)
    migration_report(repo, active + cands)
    active_overlaps(repo, active, shared)
    if cands:
        safe = safe_set(cands, active, shared)
        print(f"Safe to start together, in order: {', '.join(safe) or 'none'}")


if __name__ == "__main__":
    main(sys.argv[1:])
