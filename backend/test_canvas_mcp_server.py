import sys
import unittest
import unittest.mock
from pathlib import Path

from mcp_test_support import import_mcp_server

import_mcp_server()  # skips this module when the mcp package is missing

from mcp import ClientSession, StdioServerParameters  # noqa: E402
from mcp.client.stdio import stdio_client  # noqa: E402

from canvas_mcp_server import (  # noqa: E402
    _GROUP_HEADER_H,
    _apply_operation,
    _archived_ids,
    _frame_around,
    _group_members,
    _transitive_members,
)


class CanvasOperationTests(unittest.TestCase):
    def setUp(self):
        self.canvas = {
            "nodes": [],
            "edges": [],
            "viewport": {"x": 0, "y": 0, "zoom": 1},
            "revision": 4,
        }

    def test_add_update_connect_and_remove_nodes(self):
        _apply_operation(self.canvas, {
            "op": "add_node",
            "type": "prompt",
            "id": "prompt-a",
            "position": {"x": 10, "y": 20},
            "data": {"text": "rear-view mirror"},
        })
        _apply_operation(self.canvas, {
            "op": "add_node",
            "type": "video",
            "id": "video-a",
            "position": {"x": 420, "y": 20},
            "data": {"length": 158},
        })
        _apply_operation(self.canvas, {
            "op": "add_edge",
            "source": "prompt-a",
            "source_handle": "out-prompt",
            "target": "video-a",
            "target_handle": "in-prompt",
        })
        self.assertEqual(self.canvas["nodes"][1]["data"]["length"], 158)
        self.assertEqual(len(self.canvas["edges"]), 1)

        _apply_operation(self.canvas, {
            "op": "update_node",
            "id": "video-a",
            "data": {"steps": 20},
        })
        self.assertEqual(self.canvas["nodes"][1]["data"]["steps"], 20)

        _apply_operation(self.canvas, {"op": "remove_node", "id": "prompt-a"})
        self.assertEqual([n["id"] for n in self.canvas["nodes"]], ["video-a"])
        self.assertEqual(self.canvas["edges"], [])

    def test_rejects_invalid_handle(self):
        _apply_operation(self.canvas, {"op": "add_node", "type": "prompt", "id": "p"})
        _apply_operation(self.canvas, {"op": "add_node", "type": "video", "id": "v"})
        with self.assertRaisesRegex(ValueError, "Invalid target handle"):
            _apply_operation(self.canvas, {
                "op": "add_edge",
                "source": "p",
                "target": "v",
                "source_handle": "out-prompt",
                "target_handle": "in-does-not-exist",
            })


class GroupLayoutTests(unittest.TestCase):
    """The two rules arrange_canvas must respect once a canvas has group frames.
    Twin of frontend/lib/canvasGroups.test.ts -- keep the two in step."""

    @staticmethod
    def _node(node_id, x, y, w=160, h=100, node_type="image", data=None):
        return {"id": node_id, "type": node_type, "position": {"x": x, "y": y},
                "width": w, "height": h, "data": data or {}}

    @classmethod
    def _frame(cls, node_id, x, y, w, h, **data):
        return cls._node(node_id, x, y, w, h, "group",
                         {"title": node_id, "collapsed": False, **data})

    def test_membership_is_the_body_not_the_title_bar(self):
        frame = self._frame("g", 0, 0, 400, 400)
        under = self._node("under", 100, _GROUP_HEADER_H + 10)
        over = self._node("over", 100, -60)
        self.assertEqual(_group_members(frame, [frame, under, over]), ["under"])

    def test_overlapping_frames_split_by_centre(self):
        a = self._frame("ga", 0, 0, 300, 300)
        b = self._frame("gb", 200, 0, 300, 300)
        in_a = self._node("inA", 20, 100)
        in_b = self._node("inB", 380, 100)
        nodes = [a, b, in_a, in_b]
        self.assertEqual(_group_members(a, nodes), ["inA"])
        self.assertEqual(_group_members(b, nodes), ["inB"])

    def test_nesting_and_cycles_terminate(self):
        outer = self._frame("outer", 0, 0, 600, 600)
        inner = self._frame("inner", 100, 100, 300, 300)
        leaf = self._node("leaf", 200, 250)
        self.assertEqual(sorted(_transitive_members(outer, [outer, inner, leaf])),
                         ["inner", "leaf"])
        a = self._frame("ga", 0, 0, 400, 400)
        b = self._frame("gb", 10, 10, 380, 380)
        self.assertEqual(_transitive_members(a, [a, b]), ["gb"])

    def test_collapsed_frame_answers_from_its_record(self):
        folded = self._frame("g", 0, 0, 400, 400, collapsed=True,
                             collapsedMemberIds=["a", "b"])
        loose = self._node("c", 100, 100)
        self.assertEqual(_group_members(folded, [folded, loose]), ["a", "b"])
        self.assertEqual(_archived_ids([folded, loose]), {"a", "b"})

    def test_frame_around_holds_what_it_was_fitted_to(self):
        members = [self._node("a", 100, 100), self._node("b", 300, 200)]
        x, y, w, h = _frame_around(members)
        frame = self._frame("g", x, y, w, h)
        self.assertEqual(sorted(_group_members(frame, [frame] + members)), ["a", "b"])


class PromptFileTests(unittest.TestCase):
    """A node bound to a promptFile: edits go to the file, a mismatch stops the run."""

    def setUp(self):
        import tempfile
        import canvas_mcp_server as server
        self.server = server
        self.tmp = tempfile.TemporaryDirectory()
        self.file = Path(self.tmp.name) / "shot_prompt.txt"
        self.file.write_text("old prompt\n", encoding="utf-8")
        self.canvas = {"revision": 3, "viewport": None, "edges": [], "nodes": [{
            "id": "v", "type": "video", "position": {"x": 0, "y": 0},
            "data": {"prompt": "old prompt", "promptFile": str(self.file)}}]}
        self.saved = []
        self.archived = []
        self.patches = {
            "_canvas": lambda project_id: __import__("copy").deepcopy(self.canvas),
            "_request": lambda method, path, **kw: self.saved.append(kw.get("json")) or {"revision": 4},
            "_write_prompt_file": self._write,
        }
        self.originals = {k: getattr(server, k) for k in self.patches}
        for k, v in self.patches.items():
            setattr(server, k, v)

    def _write(self, path_text, text):
        # Stands in for the real writer so a test never touches the content archive.
        Path(path_text).write_text(text + "\n", encoding="utf-8")
        self.archived.append(path_text)
        return ""

    def tearDown(self):
        for k, v in self.originals.items():
            setattr(self.server, k, v)
        self.tmp.cleanup()

    def test_replace_in_node_text_writes_the_file(self):
        result = self.server._apply_locked({"id": "p", "name": "p"}, [
            {"op": "replace_in_node_text", "id": "v", "old": "old", "new": "new"}], None)
        self.assertEqual(self.file.read_text(encoding="utf-8").strip(), "new prompt")
        self.assertEqual(result["prompt_files_written"], [str(self.file)])

    def test_label_edit_leaves_the_file_alone(self):
        self.server._apply_locked({"id": "p", "name": "p"}, [
            {"op": "update_node", "id": "v", "data": {"label": "C1"}}], None)
        self.assertEqual(self.archived, [])

    def test_run_refuses_when_node_and_file_differ(self):
        self.file.write_text("edited on disk\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "prompt_source"):
            self.server._run_locked({"id": "p", "name": "p"}, "v")
        self.assertEqual(self.saved, [])


@unittest.skipUnless(__import__("shutil").which("ffmpeg"), "needs ffmpeg")
class ExtractFrameTests(unittest.TestCase):
    """A time past the end of the video stream (audio runs longer) gives the last frame."""

    def test_time_past_the_video_falls_back_to_the_last_frame(self):
        import subprocess
        import tempfile
        from canvas_mcp_server import _extract_frame
        with tempfile.TemporaryDirectory() as tmp:
            clip = Path(tmp) / "clip.mp4"
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=24",
                            "-f", "lavfi", "-i", "sine=d=12.6", "-frames:v", "296", "-c:v", "libx264",
                            "-c:a", "aac", "-t", "12.6", str(clip)], check=True)
            still = Path(tmp) / "f.jpg"
            self.assertEqual(_extract_frame(clip, 5.0, still), "")
            self.assertIn("last frame", _extract_frame(clip, 12.3, still))
            self.assertTrue(still.stat().st_size > 0)


class AttentionFromTheBackendTests(unittest.TestCase):
    """The backend decides; the MCP only applies its answer."""

    def _policy(self, blocked, default="kjsage"):
        response = unittest.mock.Mock()
        response.json.return_value = {"allowed": ["kjsage", "none"], "blocked": blocked, "default": default}
        return unittest.mock.patch("canvas_mcp_server.httpx.get", return_value=response)

    def test_a_blocked_patch_is_replaced_by_the_backends_default(self):
        import canvas_mcp_server as m
        with self._policy({"sol": "x"}):
            self.assertEqual(m._attention_for_preset("anything", "sol"), "kjsage")
            self.assertEqual(m._attention_for_preset("anything", "solpv"), "kjsage")
            self.assertEqual(m._attention_for_preset("anything", "sol,solchunk"), "kjsage,solchunk")
            self.assertEqual(m._attention_for_preset("anything", "kjsage"), "kjsage")
        with self._policy({}, default="sol"):
            self.assertEqual(m._attention_for_preset("fused", "sol"), "sol")

    def test_falls_back_to_the_profile_rule_when_the_backend_is_down(self):
        import canvas_mcp_server as m
        low = {"preset_substitutes": {"singularity": "singularity_w4a8"}}
        with unittest.mock.patch("canvas_mcp_server.httpx.get", side_effect=OSError("down")),                 unittest.mock.patch.object(m, "_MACHINE_PROFILE", low):
            self.assertEqual(m._attention_for_preset("singularity", "sol"), "kjsage")
            self.assertEqual(m._attention_for_preset("fused", "sol"), "sol")


class AttentionForPresetTests(unittest.TestCase):
    """The profile fallback of _attention_for_preset, with the backend made unreachable on purpose
    (a running backend would answer, and its answer depends on the machine it runs on)."""

    def test_sol_on_a_w4a8_preset_becomes_kjsage(self):
        import canvas_mcp_server as m
        low = {"preset_substitutes": {"singularity": "singularity_w4a8", "ref2va": "pruned_w4a8"}}
        with unittest.mock.patch("canvas_mcp_server.httpx.get", side_effect=OSError("down")),                 unittest.mock.patch.object(m, "_MACHINE_PROFILE", low):
            self.assertEqual(m._attention_for_preset("singularity", "sol"), "kjsage")
            self.assertEqual(m._attention_for_preset("ref2va", "solpv"), "kjsage")
            self.assertEqual(m._attention_for_preset("pruned_w4a8", "sol"), "kjsage")
            self.assertEqual(m._attention_for_preset("singularity", "kjsage"), "kjsage")
            self.assertEqual(m._attention_for_preset("fused", "sol"), "sol")   # int8: left alone
        with unittest.mock.patch("canvas_mcp_server.httpx.get", side_effect=OSError("down")),                 unittest.mock.patch.object(m, "_MACHINE_PROFILE", {"preset_substitutes": {}}):
            self.assertEqual(m._attention_for_preset("singularity", "sol"), "sol")


class CanvasMcpProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_stdio_server_exposes_canvas_tools(self):
        server_path = str(Path(__file__).parent / "canvas_mcp_server.py")
        params = StdioServerParameters(
            command=sys.executable,
            args=[server_path],
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = await session.list_tools()
        names = {tool.name for tool in tools.tools}
        self.assertEqual(
            names,
            {"list_projects", "get_node_catalog", "get_canvas", "read_canvas_export", "apply_canvas_operations",
             "run_canvas_node", "cancel_canvas_node", "refresh_canvas_node", "adopt_render",
             "arrange_canvas", "lock_project", "unlock_project", "list_scenes", "add_scene",
             "list_bible", "add_bible_entry", "update_bible_entry", "get_frames",
             "transcribe_media", "get_media_transcription", "extract_audio",
             "get_media_frames", "add_media_still", "render_gaussian_view", "redo_audio",
             "upscale_chain", "upscale_chain_status", "cancel_upscale_chain", "cleanup_canvas",
             "canvas_progress"},
        )


if __name__ == "__main__":
    unittest.main()


class FinishedJobTests(unittest.TestCase):
    """A job that ends before anyone asks must still leave the node consistent."""

    def _patch(self, node_data, job):
        import canvas_mcp_server as m
        saved = []
        originals = {k: getattr(m, k) for k in
                     ("_resolve_project", "_canvas", "_hold_lock", "_request", "_save_node_data")}
        canvas = {"nodes": [{"id": "n1", "type": "video", "data": node_data}], "edges": []}
        m._resolve_project = lambda project, scene="": {"id": "p1"}
        m._canvas = lambda pid: canvas
        m._save_node_data = lambda pid, nid, upd, c: saved.append(upd) or 7

        class Lock:
            def __init__(self, *a): pass
            def __enter__(self): return self
            def __exit__(self, *e): return False
        m._hold_lock = Lock

        def request(method, path, *a, **k):
            if path.startswith("/job/"):
                if isinstance(job, Exception):
                    raise job
                return job
            raise AssertionError(f"unexpected {method} {path}")
        m._request = request
        self.addCleanup(lambda: [setattr(m, k, v) for k, v in originals.items()])
        return m, saved

    def test_cancel_after_done_finalises_take_instead_of_not_found(self):
        job = {"status": "done", "result": {"url": "/comfy_output/H3_Chunk_1.mp4"}}
        m, saved = self._patch({"jobId": "j1", "status": "generating",
                                "pendingTake": {"params": {}, "inputs": []}}, job)
        out = m.cancel_canvas_node("p1", "n1")
        self.assertFalse(out["cancelled"])
        self.assertEqual(out["status"], "done")
        self.assertEqual(saved[0]["generatedUrl"], "/comfy_output/H3_Chunk_1.mp4")
        self.assertIsNone(saved[0]["jobId"])
        self.assertEqual(saved[0]["takes"][0]["url"], "/comfy_output/H3_Chunk_1.mp4")

    def test_cancel_of_forgotten_job_clears_spinner(self):
        m, saved = self._patch({"jobId": "j1", "status": "generating"},
                               ValueError("LAZA CINEMA STUDIO backend rejected the request (404): not found"))
        out = m.cancel_canvas_node("p1", "n1")
        self.assertEqual(saved[0]["status"], "error")
        self.assertIsNone(saved[0]["jobId"])
        self.assertFalse(out["cancelled"])
