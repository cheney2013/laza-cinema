"""Production bible: entries, linking, and propagation to scene canvases."""
import json
import tempfile
import unittest
from pathlib import Path

import bible


def _canvas(*nodes):
    return {"nodes": list(nodes), "edges": [], "revision": 3}


def _node(node_id, **data):
    return {"id": node_id, "type": "image", "width": 240, "height": 200, "data": data}


class BibleTest(unittest.TestCase):
    def test_new_entry_needs_a_file(self):
        with self.assertRaises(ValueError):
            bible.new_entry({"name": "x"})
        entry = bible.new_entry({"name": " A ", "kind": "nope", "url": "/uploads/a.png", "width": 100})
        self.assertEqual((entry["name"], entry["kind"], entry["width"]), ("A", "other", 100))

    def test_guesses(self):
        self.assertEqual(bible.guess_kind("定妆板 · 甲 v5"), "cast")
        self.assertEqual(bible.guess_kind("环境板 · 客厅"), "environment")
        self.assertEqual(bible.guess_kind("原片语音参考 · 甲"), "voice")
        self.assertEqual(bible.guess_kind("随便", "audio"), "voice")
        self.assertEqual(bible.guess_name("定妆板 · 甲 v5（seed 1，竖屏）"), "甲 v5")

    def test_replacing_the_file_keeps_history(self):
        entry = bible.new_entry({"name": "A", "url": "/uploads/a1.png", "width": 100, "height": 50})
        self.assertFalse(bible.apply_patch(entry, {"name": "B"}))
        self.assertTrue(bible.apply_patch(entry, {"url": "/uploads/a2.png", "width": 200, "height": 200}))
        self.assertEqual(entry["url"], "/uploads/a2.png")
        self.assertEqual(entry["history"][0]["url"], "/uploads/a1.png")
        self.assertFalse(bible.apply_patch(entry, {"url": "/uploads/a2.png"}))
        with self.assertRaises(ValueError):
            bible.apply_patch(entry, {"kind": "bogus"})

    def test_propagate_rewrites_only_linked_nodes(self):
        entry = bible.new_entry({"name": "A", "url": "/uploads/a2.png", "mediaType": "image", "width": 200, "height": 100})
        main = _canvas(_node("n1", url="/uploads/a1.png", label="mine", bibleId=entry["id"], duration=3),
                       _node("n2", url="/uploads/other.png"))
        other = _canvas(_node("n3", url="/uploads/unrelated.png"))
        written = {}
        changed = bible.propagate([("main", Path("m"), main), ("s2", Path("o"), other)], entry, entry["id"],
                                  lambda p, d: written.__setitem__(str(p), json.loads(json.dumps(d))))
        self.assertEqual(changed, [{"scene": "main", "node_ids": ["n1"]}])
        self.assertEqual(list(written), ["m"])
        n1 = written["m"]["nodes"][0]
        self.assertEqual((n1["data"]["url"], n1["data"]["label"], n1["height"]), ("/uploads/a2.png", "mine", 32 + 120))
        self.assertNotIn("duration", n1["data"])
        self.assertEqual(written["m"]["revision"], 4)
        self.assertEqual(written["m"]["nodes"][1]["data"]["url"], "/uploads/other.png")

    def test_unlink_keeps_the_file(self):
        main = _canvas(_node("n1", url="/uploads/a.png", bibleId="bib_1"))
        bible.propagate([("main", Path("m"), main)], None, "bib_1", lambda p, d: None)
        self.assertEqual(main["nodes"][0]["data"], {"url": "/uploads/a.png"})

    def test_usage_and_link(self):
        entry = {"id": "bib_1"}
        a = _canvas(_node("n1", url="x"), _node("n2", url="y"))
        self.assertEqual(bible.link(a, ["n1", "missing"], entry), ["n1"])
        b = _canvas(_node("n9", url="x", bibleId="bib_1"))
        self.assertEqual(bible.usage([("main", a), ("s2", b)]), {"bib_1": {"scenes": ["main", "s2"], "nodes": 2}})
        self.assertEqual(bible.affected([("main", a), ("s2", b)], "bib_1"), ["main", "s2"])

    def test_bible_file_counts_as_a_reference(self):
        import artifact_pruner
        with tempfile.TemporaryDirectory() as tmp:
            proj = Path(tmp) / "default" / "projects" / "proj_x"
            proj.mkdir(parents=True)
            (proj / "bible.json").write_text(json.dumps({"entries": [
                {"id": "bib_1", "url": "/uploads/sheet_v6.png", "history": [{"url": "/uploads/sheet_v5.png"}]}]}),
                encoding="utf-8")
            refs = artifact_pruner.collect_references(Path(tmp))
            self.assertEqual(refs.get("sheet_v6.png"), {"proj_x"})
            self.assertEqual(refs.get("sheet_v5.png"), {"proj_x"})


if __name__ == "__main__":
    unittest.main()
