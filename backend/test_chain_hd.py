"""One click HD for a chain: the order, which HDs count, and where the seam anchor is cut."""

import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from mcp_test_support import import_mcp_server

cms = import_mcp_server()
import main


def _video(node_id, take=None):
    data = {"generatedUrl": f"/comfy_output/H3_Chunk_{take}_00001_.mp4"} if take else {}
    return {"id": node_id, "type": "video", "data": data}


def _chain_edge(src, dst):
    return {"source": src, "target": dst, "targetHandle": "in-motion-context"}


def _hd(node_id, shot, made_from, status="done"):
    return ({"id": node_id, "type": "videoUpscale",
             "data": {"status": status, "generatedUrl": "/comfy_output/hd.mp4",
                      "compareUrl": f"/comfy_output/H3_Full_{made_from}_00001_.mp4"}},
            {"source": shot, "target": node_id, "targetHandle": "in-video"})


class ChainOrderTest(unittest.TestCase):
    def test_from_any_shot_head_first_with_a_branch(self):
        canvas = {"nodes": [_video("a"), _video("b"), _video("c"), _video("d"),
                            {"id": "t", "type": "videoTrim", "data": {}}],
                  "edges": [_chain_edge("a", "b"), _chain_edge("b", "c"), _chain_edge("b", "d"),
                            _chain_edge("a", "t")]}
        for start in ("a", "c", "d"):
            self.assertEqual([n["id"] for n in cms._chain_hd_order(canvas, start)], ["a", "b", "c", "d"])

    def test_a_trim_between_shots_ends_the_chain(self):
        canvas = {"nodes": [_video("a"), {"id": "t", "type": "videoTrim", "data": {}}, _video("b")],
                  "edges": [_chain_edge("a", "t"), _chain_edge("t", "b")]}
        self.assertEqual([n["id"] for n in cms._chain_hd_order(canvas, "b")], ["b"])

    def test_not_a_shot(self):
        with self.assertRaises(ValueError):
            cms._chain_hd_order({"nodes": [{"id": "x", "type": "image", "data": {}}], "edges": []}, "x")


class HdIsCurrentTest(unittest.TestCase):
    def test_hd_of_the_shown_take_counts(self):
        shot = _video("a", "aaaa1111")
        hd, _ = _hd("h", "a", "aaaa1111")
        self.assertTrue(cms._hd_is_current(shot, hd, {'nodes': [shot, hd], 'edges': []}))

    def test_hd_of_an_older_take_does_not(self):
        shot = _video("a", "bbbb2222")
        hd, _ = _hd("h", "a", "aaaa1111")
        self.assertFalse(cms._hd_is_current(shot, hd, {'nodes': [shot, hd], 'edges': []}))

    def test_unfinished_or_unrecorded_hd_does_not(self):
        shot = _video("a", "aaaa1111")
        hd, _ = _hd("h", "a", "aaaa1111", status="generating")
        self.assertFalse(cms._hd_is_current(shot, hd, {'nodes': [shot, hd], 'edges': []}))
        hd, _ = _hd("h", "a", "aaaa1111")
        del hd["data"]["compareUrl"]
        self.assertFalse(cms._hd_is_current(shot, hd, {'nodes': [shot, hd], 'edges': []}))


class HdInFlightTest(unittest.TestCase):
    def test_a_generating_hd_of_the_shown_take_is_in_flight_not_current(self):
        shot = _video("a", "aaaa1111")
        hd, _ = _hd("h", "a", "aaaa1111", status="generating")
        hd["data"]["jobId"] = "j1"
        canvas = {"nodes": [shot, hd], "edges": []}
        self.assertTrue(cms._hd_in_flight(shot, hd, canvas))
        self.assertFalse(cms._hd_is_current(shot, hd, canvas))

    def test_not_in_flight_when_of_an_older_take_or_without_a_job(self):
        shot = _video("a", "bbbb2222")
        hd, _ = _hd("h", "a", "aaaa1111", status="generating")
        hd["data"]["jobId"] = "j1"
        self.assertFalse(cms._hd_in_flight(shot, hd, {"nodes": [shot, hd], "edges": []}))
        shot = _video("a", "aaaa1111")
        hd, _ = _hd("h", "a", "aaaa1111", status="generating")
        self.assertFalse(cms._hd_in_flight(shot, hd, {"nodes": [shot, hd], "edges": []}))


class CutBeforeHdTest(unittest.TestCase):
    """C10 -> trim -> HD: the HD is of the cut clip, and counts only for the shown take."""

    def _canvas(self, shot_take, cut_from, hd_compare="/comfy_output/H3_Trim_aa.mp4"):
        shot = _video("c10", shot_take)
        trim = {"id": "t", "type": "videoTrim", "data": {
            "status": "done", "generatedUrl": "/comfy_output/H3_Trim_aa.mp4",
            "sourceUrl": f"/comfy_output/H3_Video_{cut_from}_00001_.mp4"}}
        hd = {"id": "h", "type": "videoUpscale", "data": {
            "status": "done", "generatedUrl": "/x.mp4", "compareUrl": hd_compare}}
        edges = [{"source": "c10", "target": "t", "targetHandle": "in-video"},
                 {"source": "t", "target": "h", "targetHandle": "in-video"}]
        return {"nodes": [shot, trim, hd], "edges": edges}, shot, hd

    def test_hd_after_a_cut_is_found_and_current(self):
        canvas, shot, hd = self._canvas("c1d59ff8", "c1d59ff8")
        self.assertEqual([n["id"] for n in cms._hd_nodes_of(canvas, "c10")], ["h"])
        self.assertTrue(cms._hd_is_current(shot, hd, canvas))

    def test_cut_made_from_an_older_take_is_stale(self):
        canvas, shot, hd = self._canvas("c1d59ff8", "0ldtake0")
        self.assertFalse(cms._hd_is_current(shot, hd, canvas))

    def test_hd_of_a_different_cut_file_is_stale(self):
        canvas, shot, hd = self._canvas("c1d59ff8", "c1d59ff8", hd_compare="/comfy_output/H3_Trim_zz.mp4")
        self.assertFalse(cms._hd_is_current(shot, hd, canvas))


class EditWindowBeforeHdTest(unittest.TestCase):
    """C22a -> edit window -> HD: an edit node records no source take, yet its HD must be found."""

    def _canvas(self, status="done", job=None, compare="/comfy_output/H3_EditWindow_aa.mp4", edit_type="videoEdit",
                source=None):
        shot = _video("c22a", "5412b3b3")
        data = {"status": "done", "generatedUrl": "/comfy_output/H3_EditWindow_aa.mp4"}
        if source:
            data["sourceUrl"] = source
        edit = {"id": "e", "type": edit_type, "data": data}
        hd = {"id": "h", "type": "videoUpscale", "data": {
            "status": status, "generatedUrl": "/x.mp4", "compareUrl": compare, **({"jobId": job} if job else {})}}
        # the film goes on from the edit (the next shot takes it as its motion context): it is the
        # clip the film uses, not a try
        edges = [{"source": "c22a", "target": "e", "targetHandle": "in-video"},
                 {"source": "e", "target": "h", "targetHandle": "in-video"},
                 _chain_edge("e", "c22b")]
        return {"nodes": [shot, edit, hd, _video("c22b")], "edges": edges}, shot, hd

    def test_a_done_hd_of_the_edit_file_is_current(self):
        canvas, shot, hd = self._canvas()
        self.assertTrue(cms._hd_is_current(shot, hd, canvas))

    def test_a_generating_hd_of_the_edit_file_is_in_flight(self):
        canvas, shot, hd = self._canvas(status="generating", job="j1")
        self.assertTrue(cms._hd_in_flight(shot, hd, canvas))

    def test_an_hd_of_another_file_is_still_stale(self):
        canvas, shot, hd = self._canvas(compare="/comfy_output/H3_EditWindow_zz.mp4")
        self.assertFalse(cms._hd_is_current(shot, hd, canvas))

    def test_a_recorded_older_source_still_makes_it_stale(self):
        canvas, shot, hd = self._canvas(source="/comfy_output/H3_Chunk_0d1d7a4e_00001_.mp4")
        self.assertFalse(cms._hd_is_current(shot, hd, canvas))

    def test_a_trim_with_nothing_recorded_stays_stale(self):
        canvas, shot, hd = self._canvas(edit_type="videoTrim")
        self.assertFalse(cms._hd_is_current(shot, hd, canvas))


class UnusedEditIsNotTheShotTest(unittest.TestCase):
    """An edit nothing continues from is a try. Its HD is not the shot's (C22a, 2026-10-03)."""

    def _canvas(self, edit_type="videoEdit", shot_continues=True):
        shot = _video("c22a", "5412b3b3")
        edit = {"id": "e", "type": edit_type, "data": {"status": "done",
                                                       "generatedUrl": "/comfy_output/H3_EditWindow_aa.mp4"}}
        hd = {"id": "h", "type": "videoUpscale", "data": {
            "status": "done", "generatedUrl": "/x.mp4", "compareUrl": "/comfy_output/H3_EditWindow_aa.mp4"}}
        edges = [{"source": "c22a", "target": "e", "targetHandle": "in-video"},
                 {"source": "e", "target": "h", "targetHandle": "in-video"}]
        nodes = [shot, edit, hd]
        if shot_continues:
            nodes.append(_video("c22b"))
            edges.append(_chain_edge("c22a", "c22b"))      # the film goes on from the shot itself
        return {"nodes": nodes, "edges": edges}, shot, hd

    def test_a_dead_end_edit_beside_a_continued_shot_is_not_followed(self):
        canvas, shot, hd = self._canvas()
        source, via = cms._hd_source(canvas, "c22a")
        self.assertEqual((source["id"], via), ("c22a", []))
        self.assertEqual(cms._hd_nodes_of(canvas, "c22a"), [])
        self.assertFalse(cms._hd_is_current(shot, hd, canvas))

    def test_a_dead_end_edit_at_the_end_of_a_chain_is_not_followed_either(self):
        canvas, shot, hd = self._canvas(shot_continues=False)
        self.assertEqual(cms._hd_source(canvas, "c22a")[0]["id"], "c22a")
        self.assertFalse(cms._hd_is_current(shot, hd, canvas))

    def test_a_trim_at_the_end_of_a_chain_still_is_the_clip_used(self):
        canvas, shot, hd = self._canvas(edit_type="videoTrim", shot_continues=False)
        self.assertEqual(cms._hd_source(canvas, "c22a")[0]["id"], "e")


class AnchorWindowTest(unittest.TestCase):
    """_hd_tail_anchor cuts the overlap window; a join at frame N cuts it ending at N."""

    def _cut(self, total, frames, end_frame=0):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(main, "COMFYUI_INPUT_DIR", tmp), \
                mock.patch.object(main, "_video_frame_count", side_effect=lambda p: frames if Path(p).name.startswith("hdanchor") else total), \
                mock.patch.object(main.subprocess, "run") as run:
            run.return_value = mock.Mock(returncode=0, stderr="")
            with mock.patch.object(main.os, "replace"):
                name = main._hd_tail_anchor(Path("prev_hd.mp4"), frames, end_frame)
            cmd = run.call_args[0][0]
            select = next(a for a in cmd if a.startswith("select="))
            return name, int(re.search(r"gte\(n\\+,(\d+)\)", select).group(1))

    def test_default_is_the_tail(self):
        name, start = self._cut(total=200, frames=22)
        self.assertEqual(start, 178)
        self.assertTrue(name.endswith("_last22.mp4"))

    def test_join_at_frame_ends_at_that_frame(self):
        name, start = self._cut(total=200, frames=22, end_frame=132)
        self.assertEqual(start, 110)
        self.assertIn("_at132_22", name)

    def test_window_outside_the_file_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(main, "COMFYUI_INPUT_DIR", tmp), \
                mock.patch.object(main, "_video_frame_count", return_value=100):
            with self.assertRaisesRegex(RuntimeError, "outside the previous HD"):
                main._hd_tail_anchor(Path("prev_hd.mp4"), 22, 150)


if __name__ == "__main__":
    unittest.main()
