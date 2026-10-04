"""The cut room's version list for one canvas node, with the HD render made from each version."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import main


def _canvas():
    return {
        "nodes": [
            {"id": "shot", "type": "video", "data": {
                "generatedUrl": "/comfy_output/H3_Chunk_bbbbbbbb_00001_.mp4",
                "untrimmedUrl": "/comfy_output/H3_Full_bbbbbbbb_00001_.mp4", "contextFrames": 22,
                "takes": [
                    {"url": "/comfy_output/H3_Chunk_bbbbbbbb_00001_.mp4", "createdAt": 2,
                     "untrimmedUrl": "/comfy_output/H3_Full_bbbbbbbb_00001_.mp4", "contextFrames": 22},
                    {"url": "/comfy_output/H3_Chunk_aaaaaaaa_00001_.mp4", "createdAt": 1, "adopted": True},
                ]}},
            {"id": "up", "type": "videoUpscale", "data": {
                "compareUrl": "/comfy_output/H3_Chunk_aaaaaaaa_00001_.mp4",
                "generatedUrl": "/comfy_output/H3_Upscale_Video_cccccccc_00001_.mp4", "overlapFrames": 0}},
        ],
        "edges": [{"source": "shot", "target": "up", "targetHandle": "in-video"}],
    }


class NodeVersionsTests(unittest.TestCase):
    def _versions(self, node_id="shot"):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "canvas.json"
            path.write_text(json.dumps(_canvas()), encoding="utf-8")
            with mock.patch.object(main, "_read_meta", return_value={}), \
                 mock.patch.object(main, "_scene_list", return_value=[{"id": "main"}]), \
                 mock.patch.object(main, "_scene_canvas_path", return_value=path):
                return main._node_versions(Path(tmp), node_id)

    def test_lists_takes_newest_first_with_flags(self):
        found = self._versions()
        self.assertEqual([v["url"][-25:] for v in found["versions"]],
                         ["Chunk_bbbbbbbb_00001_.mp4", "Chunk_aaaaaaaa_00001_.mp4"])
        newest, older = found["versions"]
        self.assertTrue(newest["current"] and not older["current"])
        self.assertTrue(older["adopted"])
        self.assertEqual(newest["contextFrames"], 22)

    def test_hd_belongs_to_the_version_it_was_made_from(self):
        newest, older = self._versions()["versions"]
        self.assertIsNone(newest["hd"])
        self.assertEqual(older["hd"]["url"], "/comfy_output/H3_Upscale_Video_cccccccc_00001_.mp4")

    def test_unknown_node_is_none(self):
        self.assertIsNone(self._versions("nope"))


if __name__ == "__main__":
    unittest.main()
