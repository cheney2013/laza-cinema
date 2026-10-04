"""Deleting library files on behalf of one project touches only that project's own files."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import main


def entry(path: Path, origin=None, projects=()):
    return {"path": str(path), "companions": [], "kind": "video", "origin_project": origin,
            "projects": [{"id": p, "name": p} for p in projects], "referenced": bool(projects)}


class DeleteForProjectTest(unittest.TestCase):
    def test_only_this_projects_own_files_are_deleted(self):
        with tempfile.TemporaryDirectory() as tmp:
            names = ["mine.mp4", "made_here_used_elsewhere.mp4", "made_elsewhere.mp4",
                     "shared_ref.mp4", "unattributed.mp4", "ref_only_here.mp4"]
            paths = {n: Path(tmp) / n for n in names}
            for path in paths.values():
                path.write_bytes(b"x")
            files = {
                "mine.mp4": entry(paths["mine.mp4"], origin="p1"),
                "made_here_used_elsewhere.mp4": entry(paths["made_here_used_elsewhere.mp4"], origin="p1", projects=["p1", "p2"]),
                "made_elsewhere.mp4": entry(paths["made_elsewhere.mp4"], origin="p2"),
                "shared_ref.mp4": entry(paths["shared_ref.mp4"], projects=["p1", "p2"]),
                "unattributed.mp4": entry(paths["unattributed.mp4"]),
                "ref_only_here.mp4": entry(paths["ref_only_here.mp4"], projects=["p1"]),
            }
            with mock.patch.object(main, "_scan_assets", return_value=files):
                result = main._delete_assets(names, False, "p1")
            self.assertEqual(sorted(result["deleted"]), ["mine.mp4", "ref_only_here.mp4"])
            self.assertEqual(sorted(result["skipped"]),
                             ["made_elsewhere.mp4", "made_here_used_elsewhere.mp4", "shared_ref.mp4", "unattributed.mp4"])
            for name in result["skipped"]:
                self.assertTrue(paths[name].exists(), name)

    def test_without_a_project_the_old_behaviour_stands(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "x.mp4"
            path.write_bytes(b"x")
            with mock.patch.object(main, "_scan_assets", return_value={"x.mp4": entry(path, origin="p2")}):
                self.assertEqual(main._delete_assets(["x.mp4"], False)["deleted"], ["x.mp4"])


if __name__ == "__main__":
    unittest.main()
