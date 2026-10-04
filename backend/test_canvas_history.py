"""The canvas save keeps the previous file and says who changed what."""

import gzip
import json
import tempfile
import unittest
from pathlib import Path

import main


class CanvasHistoryTest(unittest.TestCase):
    def test_previous_file_kept_and_changes_logged(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "canvas.json"
            path.write_text(json.dumps({"revision": 7, "nodes": [
                {"id": "a", "data": {"label": "new"}}, {"id": "b", "data": {"x": 1}}], "edges": []}), encoding="utf-8")
            with self.assertLogs("ai_cinema", level="INFO") as logs:
                main._keep_canvas_history(path, [{"id": "a", "data": {"label": "old"}}, {"id": "b", "data": {"x": 1}}],
                                          8, who="studio@100.1.1.1")
            kept = Path(tmp) / "canvas_history" / "canvas.r000007.json.gz"
            self.assertTrue(kept.is_file())
            self.assertEqual(json.loads(gzip.decompress(kept.read_bytes()))["revision"], 7)
            line = "\n".join(logs.output)
            self.assertIn("studio@100.1.1.1", line)
            self.assertIn("['a']", line)

    def test_keeps_only_the_last_few(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "canvas.json"
            for rev in range(1, main.CANVAS_HISTORY_KEEP + 6):
                path.write_text(json.dumps({"revision": rev, "nodes": [], "edges": []}), encoding="utf-8")
                main._keep_canvas_history(path, [], rev + 1, who="mcp")
            self.assertEqual(len(list((Path(tmp) / "canvas_history").glob("canvas.r*.json.gz"))), main.CANVAS_HISTORY_KEEP)

    def test_never_raises(self):
        main._keep_canvas_history(Path("Z:/no/such/canvas.json"), [], 1, who="x")


if __name__ == "__main__":
    unittest.main()
