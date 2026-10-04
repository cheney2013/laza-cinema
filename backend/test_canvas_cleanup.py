"""Which intermediate nodes nothing depends on (the Qwen repair trail)."""

import unittest

from canvas_cleanup import find_unused


def n(node_id, node_type="qwenImage", **data):
    return {"id": node_id, "type": node_type, "data": {"url": f"/uploads/{node_id}.png", **data}}


def e(src, dst):
    return {"source": src, "target": dst}


def ids(nodes, edges):
    return [u["id"] for u in find_unused(nodes, edges)]


class FindUnusedTest(unittest.TestCase):
    def test_a_dead_end_is_unused_and_a_node_feeding_a_shot_is_not(self):
        nodes = [n("a"), n("b"), n("shot", "video")]
        self.assertEqual(ids(nodes, [e("b", "shot")]), ["a"])

    def test_a_chain_ending_in_use_is_all_in_use(self):
        nodes = [n("still", "image"), n("edit1"), n("edit2"), n("shot", "video")]
        edges = [e("still", "edit1"), e("edit1", "edit2"), e("edit2", "shot")]
        self.assertEqual(ids(nodes, edges), [])

    def test_a_chain_ending_in_a_dead_end_is_all_unused(self):
        nodes = [n("still", "image"), n("edit1"), n("edit2")]
        edges = [e("still", "edit1"), e("edit1", "edit2")]
        found = find_unused(nodes, edges)
        self.assertEqual([u["id"] for u in found], ["edit1", "edit2", "still"])
        why = {u["id"]: u["why"] for u in found}
        self.assertTrue(why["edit2"].startswith("dead end"))
        self.assertTrue(why["edit1"].startswith("feeds only"))

    def test_a_library_node_is_in_use(self):
        self.assertEqual(ids([n("a", bibleId="bib_1")], []), [])

    def test_a_node_named_in_another_nodes_data_is_in_use(self):
        shot = {"id": "shot", "type": "video", "data": {"audioLocks": [{"node": "voice", "at": 2}]}}
        self.assertEqual(ids([n("voice", "image", mediaType="image"), shot], []), [])

    def test_a_label_that_only_mentions_it_does_not_count(self):
        other = n("other", label="made from upload-9 by qwen")
        self.assertEqual(sorted(ids([n("upload-9", "image"), other], [])), ["other", "upload-9"])

    def test_audio_video_and_shots_are_never_listed(self):
        nodes = [n("voice", "image", mediaType="audio"), n("clip", "image", mediaType="video"),
                 {"id": "s", "type": "video", "data": {}}, {"id": "g", "type": "group", "data": {}}]
        self.assertEqual(ids(nodes, []), [])

    def test_a_rendering_node_is_in_use(self):
        self.assertEqual(ids([n("a", status="generating")], []), [])

    def test_a_deprecated_label_is_flagged(self):
        found = find_unused([n("a", label="千问 · 已弃用")], [])
        self.assertTrue(found[0]["deprecated"])


if __name__ == "__main__":
    unittest.main()
