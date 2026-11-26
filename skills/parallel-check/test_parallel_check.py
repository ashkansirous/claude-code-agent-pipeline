"""Tests for --check-slice and the next free slice number: python -I -m unittest."""
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import parallel_check as pc


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def write(root, rel, text="x\n"):
    path = Path(root) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class CheckSliceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        origin, self.repo = base / "origin.git", base / "repo"
        git(base, "init", "--bare", "-b", "main", str(origin))
        git(base, "clone", str(origin), str(self.repo))
        git(self.repo, "config", "user.email", "t@t")
        git(self.repo, "config", "user.name", "t")
        write(self.repo, "docs/plan/slices/01-old.md")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-m", "base")
        git(self.repo, "push", "-u", "origin", "main")
        git(self.repo, "checkout", "-b", "feat/mine")
        self.prs = []
        patches = [
            mock.patch.object(pc, "open_prs", lambda repo: self.prs),
            mock.patch.object(pc, "closed_branches", lambda repo: set()),
            mock.patch.object(pc, "pr_paths", lambda repo, pr: pr.get("paths", [])),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def commit_slice(self, name):
        write(self.repo, f"docs/plan/slices/{name}")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-m", name)

    def check(self):
        return pc.check_slice(self.repo, "feat/mine")

    def test_other_branch_checked_out_is_refused(self):
        self.commit_slice("02-new.md")
        git(self.repo, "checkout", "main")
        self.assertEqual(self.check(), 1)

    def test_detached_head_is_refused(self):
        self.commit_slice("02-new.md")
        git(self.repo, "checkout", "--detach")
        self.assertEqual(self.check(), 1)

    def test_prefixed_branch_name_is_accepted(self):
        self.commit_slice("02-new.md")
        self.assertEqual(pc.check_slice(self.repo, "refs/heads/feat/mine"), 0)
        self.assertEqual(pc.check_slice(self.repo, "origin/feat/mine"), 0)

    def test_free_number_passes(self):
        self.commit_slice("02-new.md")
        self.assertEqual(self.check(), 0)

    def test_other_pr_collides(self):
        self.commit_slice("212-mine.md")
        self.prs = [{"number": 7, "headRefName": "feat/other",
                     "paths": ["docs/plan/slices/212-theirs.md"]}]
        self.assertEqual(self.check(), 1)

    def test_own_pr_excluded(self):
        self.commit_slice("212-mine.md")
        self.prs = [{"number": 600, "headRefName": "feat/mine",
                     "paths": ["docs/plan/slices/212-mine.md"]}]
        self.assertEqual(self.check(), 0)

    def test_edited_not_added_file_ignored(self):
        write(self.repo, "docs/plan/slices/01-old.md", "changed\n")
        git(self.repo, "commit", "-am", "edit")
        self.assertEqual(pc.slice_ids(pc.added_slice_files(self.repo, "HEAD")), set())
        self.assertEqual(self.check(), 0)

    def test_suffixed_id_collides_only_with_same_suffix(self):
        self.commit_slice("212a-mine.md")
        self.prs = [{"number": 8, "headRefName": "feat/o", "paths": ["docs/plan/slices/212a-x.md"]}]
        self.assertEqual(self.check(), 1)
        self.prs = [{"number": 8, "headRefName": "feat/o", "paths": ["docs/plan/slices/212b-x.md"]}]
        self.assertEqual(self.check(), 0)

    def test_worktree_only_slice_collides_and_counts_for_next_free(self):
        other = Path(self.tmp.name) / "wt"
        git(self.repo, "worktree", "add", "-b", "feat/wt", str(other), "origin/main")
        write(other, "docs/plan/slices/09-pending.md")
        self.commit_slice("09-mine.md")
        self.assertEqual(self.check(), 1)
        holders = pc.slice_holders(self.repo, [], "feat/mine")
        self.assertEqual(pc.next_free_slice(holders), 10)
        git(self.repo, "worktree", "remove", "--force", str(other))

    def test_unpushed_local_branch_collides(self):
        git(self.repo, "checkout", "-b", "feat/other", "origin/main")
        self.commit_slice("20-theirs.md")
        git(self.repo, "checkout", "feat/mine")
        self.commit_slice("20-mine.md")
        self.assertEqual(self.check(), 1)

    def test_renamed_slice_file_counts_as_added(self):
        git(self.repo, "mv", "docs/plan/slices/01-old.md", "docs/plan/slices/03-renamed.md")
        git(self.repo, "commit", "-am", "rename")
        self.assertEqual(pc.slice_ids(pc.added_slice_files(self.repo, "HEAD")), {"03"})

    def test_claim_for_finds_suffixed_file(self):
        pr = {"number": 9, "headRefName": "feat/x", "paths": ["docs/plan/slices/212a-claim.md"]}
        self.assertEqual(pc.claim_for(self.repo, [pr], 212), (pr, "docs/plan/slices/212a-claim.md"))
        self.assertIsNone(pc.claim_for(self.repo, [pr], 213))

    def test_touches_missing_folder_fails(self):
        write(self.repo, "tools/emulator/run.ps1")
        write(self.repo, "docs/plan/slices/02-new.md", "**Touches:** `tools/emulator/flows/**`, `tools/emulator/run.ps1`\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-m", "claim")
        self.assertEqual(self.check(), 1)

    def test_touches_existing_new_file_or_marked_folder_passes(self):
        write(self.repo, "tools/emulator/run.ps1")
        write(self.repo, "docs/plan/slices/01-old.md",
              "**Touches, part A:** `tools/emulator/new.ps1`, `src/Fresh/**` (new),\n`.maestro/dino/*.yaml` (new), `README.md`\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-m", "edit claim")
        self.assertEqual(self.check(), 0)

    def test_old_touches_line_not_rechecked_when_slice_edited(self):
        write(self.repo, "tools/run.ps1")
        write(self.repo, "docs/plan/slices/01-old.md", "**Touches:** `tools/flows/**`\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-m", "old slice")
        git(self.repo, "push", "origin", "HEAD:main")
        git(self.repo, "fetch", "origin")
        write(self.repo, "docs/plan/slices/01-old.md", "**Touches:** `tools/flows/**`\n\nBuilt.\n")
        git(self.repo, "commit", "-am", "index pass")
        self.assertEqual(self.check(), 0)

    def test_edited_continuation_line_is_checked(self):
        write(self.repo, "tools/run.ps1")
        write(self.repo, "docs/plan/slices/01-old.md", "**Touches:** `tools/run.ps1`,\n`README.md`\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-m", "old slice")
        git(self.repo, "push", "origin", "HEAD:main")
        git(self.repo, "fetch", "origin")
        write(self.repo, "docs/plan/slices/01-old.md", "**Touches:** `tools/run.ps1`,\n`tools/flows/**`\n")
        git(self.repo, "commit", "-am", "edit continuation")
        self.assertEqual(self.check(), 1)

    def test_brace_glob_entries_are_skipped(self):
        entries = [("tools/{emulator,phone}/x", False)]
        self.assertEqual(pc.missing_touch_folders(entries, {"tools"}), [])

    def test_missing_touch_folders_skips_prose_and_marked(self):
        folders = {"tools", "tools/emulator"}
        entries = [("tools/emulator/flows/**", False), ("src/New/**", True), ("RTST_DROP_RC=0", False),
                   ("a b/c", False), ("tools/emulator/x.ps1", False)]
        self.assertEqual(pc.missing_touch_folders(entries, folders), ["tools/emulator/flows/**"])

    def test_missing_touch_folders_checks_extensionless_leaf(self):
        folders, files = {"tools", "tools/emulator"}, {"tools/emulator/a.ps1"}
        self.assertEqual(pc.missing_touch_folders([("tools/emulator/flows", False)], folders, files), ["tools/emulator/flows"])
        self.assertEqual(pc.missing_touch_folders([("tools/emulator", False)], folders, files), [])
        self.assertEqual(pc.missing_touch_folders([("tools/emulator/new.ps1", False)], folders, files), [])

    def test_check_slice_fetch_error_exits_2_not_1(self):
        with mock.patch.object(pc, "run", side_effect=RuntimeError("no network")):
            with self.assertRaises(SystemExit) as raised:
                pc.main([str(self.repo), "--check-slice", "feat/mine"])
        self.assertEqual(raised.exception.code, 2)

    def test_check_slice_bad_args_exit_2(self):
        for argv in ([str(self.repo), "--check-slice"], ["--check-slice", str(self.repo), "feat/mine"]):
            with self.assertRaises(SystemExit) as raised:
                pc.main(argv)
            self.assertEqual(raised.exception.code, 2)


class StaleDraftTest(unittest.TestCase):
    NOW = pc.datetime(2026, 11, 1, 10, 0, tzinfo=pc.timezone.utc)

    def work(self, **pr):
        base = {"number": 7, "headRefName": "feat/x", "isDraft": True, "body": "**Touches:** `tools/**`",
                "paths": ["docs/plan/slices/07-x.md"]}
        base.update(pr)
        with mock.patch.object(pc, "pr_paths", lambda repo, p: p["paths"]):
            return pc.pr_work(Path("."), base, self.NOW)

    def test_idle_draft_counts_only_its_changed_files(self):
        work = self.work(updatedAt="2026-10-26T23:09:11Z")
        self.assertEqual(work.patterns, ["docs/plan/slices/07-x.md"])
        self.assertIn("idle over 24 h", work.label)

    def test_recent_draft_and_ready_pr_keep_their_touches(self):
        self.assertIn("tools/**", self.work(updatedAt="2026-11-01T08:00:00Z").patterns)
        self.assertIn("tools/**", self.work(updatedAt="2026-10-20T00:00:00Z", isDraft=False).patterns)
        self.assertIn("tools/**", self.work().patterns)


class AbandonedLoopWorktreeTest(unittest.TestCase):
    NOW = pc.datetime(2026, 11, 14, 12, 0, tzinfo=pc.timezone.utc)

    def make_worktree(self, commit_date):
        root = Path(tempfile.mkdtemp())
        git(root, "init", "-q", "-b", "main")
        git(root, "config", "user.email", "t@example.com")
        git(root, "config", "user.name", "t")
        write(root, "a.txt")
        git(root, "add", ".")
        env = {"GIT_COMMITTER_DATE": commit_date, "GIT_AUTHOR_DATE": commit_date}
        subprocess.run(["git", "commit", "-q", "-m", "x"], cwd=root, check=True, capture_output=True, env={**__import__("os").environ, **env})
        return root

    def test_a_fresh_worktree_cut_from_an_old_main_commit_is_live(self):
        old = self.make_worktree("2026-11-08T20:56:00+00:00")
        fresh = pc.datetime(2026, 11, 14, 11, 0, tzinfo=pc.timezone.utc)
        with mock.patch.object(pc, "worktree_activity", lambda path, pending: fresh):
            self.assertFalse(pc.is_abandoned_loop_worktree(old, "chore/feedback-loop-2026-11-14-1100", self.NOW, ["docs/new.md"]))

    def test_old_loop_worktree_is_abandoned_and_recent_or_other_branches_are_live(self):
        old = self.make_worktree("2026-11-08T20:56:00+00:00")
        patcher = mock.patch.object(pc, "worktree_activity", lambda path, pending: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.assertTrue(pc.is_abandoned_loop_worktree(old, "chore/feedback-loop-2026-11-08-1703", self.NOW))
        self.assertFalse(pc.is_abandoned_loop_worktree(old, "chore/354-fl-leftovers", self.NOW))
        recent = self.make_worktree("2026-11-14T08:00:00+00:00")
        self.assertFalse(pc.is_abandoned_loop_worktree(recent, "chore/feedback-loop-2026-11-14-0726", self.NOW))

    def test_an_abandoned_loop_worktree_with_changes_is_not_listed_as_live_work(self):
        old = self.make_worktree("2026-11-08T20:56:00+00:00")
        write(old, "docs/new.md")  # uncommitted, as fl1703's four paths were
        with mock.patch.object(pc, "worktree_activity", lambda path, pending: None), \
                mock.patch.object(pc, "worktrees", lambda repo: [(old, "chore/feedback-loop-2026-11-08-1703")]), \
                mock.patch.object(pc, "worktree_paths", lambda path: ([], ["docs/new.md"])), \
                mock.patch("sys.stderr"):
            self.assertEqual(pc.worktree_work(Path("."), {}, set(), self.NOW), [])
        with mock.patch.object(pc, "worktrees", lambda repo: [(old, "chore/other")]), \
                mock.patch.object(pc, "worktree_paths", lambda path: ([], ["docs/new.md"])):
            self.assertEqual(len(pc.worktree_work(Path("."), {}, set(), self.NOW)), 1)


class ParseTouchesTest(unittest.TestCase):
    def test_plain_and_part_lines_are_joined(self):
        text = "**Touches:** `a/**`\n\n**Touches, part A:** `b/**`\n"
        self.assertEqual(pc.parse_touches(text), ["a/**", "b/**"])

    def test_glob_in_part_label_and_duplicates(self):
        text = "**Touches, part A (`src/**`):** `a/**`\n\n**Touches, part B:** `a/**`, `b.cs`\n"
        self.assertEqual(pc.parse_touches(text), ["a/**", "b.cs"])

    def test_bold_text_after_touches_is_not_a_head(self):
        self.assertIsNone(pc.parse_touches("**Touches** nothing `a/**` here **:**\n"))

    def test_part_lines_only_give_their_union(self):
        text = "**Touches, part A (`x`):** `a/**`, `b.cs`\nmore `c.cs`\n\n**Touches, part B:** `d/**`\n"
        self.assertEqual(pc.parse_touches(text), ["a/**", "b.cs", "c.cs", "d/**"])

    def test_no_touches_line_is_none(self):
        self.assertIsNone(pc.parse_touches("**Status:** planned\n"))


if __name__ == "__main__":
    unittest.main()
