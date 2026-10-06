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
             "canvas_progress", "inspect_charswap_inputs", "build_route_gaussian", "append_route_turn",
             "extend_route", "adjust_route_extension", "set_route_scale"},
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


class RouteBuildWiringTests(unittest.TestCase):
    """A route splat shows on the canvas what it was built from: its clips wired into in-route-source in route
    order, its settings kept on the node, and a run of the node builds it again only when those clips changed."""

    def _patch(self, nodes, edges):
        import canvas_mcp_server as m
        canvas = {"nodes": nodes, "edges": edges, "revision": 1}
        posted = []
        originals = {k: getattr(m, k) for k in ("_resolve_project", "_canvas", "_hold_lock", "_request", "_apply_locked")}
        m._resolve_project = lambda project, scene="": {"id": "p1"}
        m._canvas = lambda pid: canvas

        class Lock:
            def __init__(self, *a): pass
            def __enter__(self): return self
            def __exit__(self, *e): return False
        m._hold_lock = Lock

        def request(method, path, *a, **k):
            posted.append((path, k.get("json")))
            return {"job_id": "abcdef123456", "status": "queued"}
        m._request = request

        def apply(resolved, ops, expected):
            for op in ops:
                _apply_operation(canvas, op)
            canvas["revision"] += 1
            return {"revision": canvas["revision"]}
        m._apply_locked = apply
        self.addCleanup(lambda: [setattr(m, k, v) for k, v in originals.items()])
        return m, canvas, posted

    @staticmethod
    def _clip(cid, url):
        return {"id": cid, "type": "video", "position": {"x": 0, "y": 0}, "data": {"generatedUrl": url}}

    def _sources(self, canvas, nid):
        return [e["source"] for e in canvas["edges"] if e["target"] == nid and e.get("targetHandle") == "in-route-source"]

    def test_a_new_route_node_is_wired_to_its_clips_in_order(self):
        m, canvas, posted = self._patch([self._clip("v1", "/uploads/a.mp4"), self._clip("v2", "/uploads/b.mp4")], [])
        out = m.build_route_gaussian("p1", ["v1", "v2"], node_id="g1", mask_people=True, frame_width=952)
        self.assertEqual(out["node_id"], "g1")
        self.assertEqual(self._sources(canvas, "g1"), ["v1", "v2"])
        body = posted[0][1]
        self.assertEqual((posted[0][0], body["clip_urls"], body["mask_people"], body["frame_width"]),
                         ("/generate-route-gaussian", ["/uploads/a.mp4", "/uploads/b.mp4"], True, 952))
        data = next(n for n in canvas["nodes"] if n["id"] == "g1")["data"]
        self.assertEqual((data["routeClips"], data["routeClipUrls"]), (["v1", "v2"], ["/uploads/a.mp4", "/uploads/b.mp4"]))
        self.assertTrue(data["routeSettings"]["mask_people"])

    def test_a_rebuild_rewires_in_route_order_and_leaves_other_inputs(self):
        nodes = [self._clip("v1", "/uploads/a.mp4"), self._clip("v2", "/uploads/b.mp4"), self._clip("v3", "/uploads/c.mp4"),
                 self._clip("turn", "/uploads/t.mp4"),
                 {"id": "g1", "type": "gaussian", "position": {"x": 0, "y": 0}, "data": {"label": "kept label"}}]
        edges = [{"id": "e1", "source": "v2", "target": "g1", "targetHandle": "in-route-source"},
                 {"id": "e2", "source": "v3", "target": "g1", "targetHandle": "in-route-source"},
                 {"id": "e3", "source": "turn", "target": "g1", "targetHandle": "in-video"}]
        m, canvas, _ = self._patch(nodes, edges)
        m.build_route_gaussian("p1", ["v1", "v2"], node_id="g1")
        self.assertEqual(self._sources(canvas, "g1"), ["v1", "v2"])
        self.assertTrue(any(e["source"] == "turn" and e["targetHandle"] == "in-video" for e in canvas["edges"]))
        self.assertEqual(next(n for n in canvas["nodes"] if n["id"] == "g1")["data"]["label"], "kept label")

    def test_running_the_node_builds_again_only_when_its_clips_changed(self):
        import canvas_mcp_server as m
        settings = dict(m.ROUTE_BUILD_DEFAULTS, mask_people=True)
        g1 = {"id": "g1", "type": "gaussian", "position": {"x": 0, "y": 0},
              "data": {"plyUrl": "/uploads/route_x.ply", "routeClips": ["v1"], "routeClipUrls": ["/uploads/a.mp4"],
                       "routeSettings": settings}}
        nodes = [self._clip("v1", "/uploads/a.mp4"), self._clip("ext", "/uploads/e.mp4"), g1]
        edges = [{"id": "e1", "source": "v1", "target": "g1", "targetHandle": "in-route-source"},
                 {"id": "e2", "source": "ext", "target": "g1", "targetHandle": "in-route"}]
        m, canvas, posted = self._patch(nodes, edges)
        with unittest.mock.patch.object(m, "_start_route_extend", return_value={"route": "extend"}) as extend:
            self.assertEqual(m._run_gaussian_locked({"id": "p1"}, canvas, g1), {"route": "extend"})
            extend.assert_called_once()
        self.assertEqual(posted, [])
        nodes[0]["data"]["generatedUrl"] = "/uploads/a_v2.mp4"      # the clip re-rendered in place
        m._run_gaussian_locked({"id": "p1"}, canvas, g1)
        self.assertEqual(posted[0][0], "/generate-route-gaussian")
        self.assertEqual((posted[0][1]["clip_urls"], posted[0][1]["mask_people"]), (["/uploads/a_v2.mp4"], True))


class RouteScaleTests(unittest.TestCase):
    """set_route_scale sends the node's route to /rescale-route; the finished result rescales the node's hand
    adjustments (metres) and the unit a rebuild uses, nothing else."""

    def test_the_request_and_what_the_result_changes(self):
        import canvas_mcp_server as m
        data = {"plyUrl": "/uploads/route_x.ply", "routeExtendAdjust": {"/uploads/a.mp4": {"yaw": 3.0, "right": 2.0}},
                "routeSettings": {"metres_per_unit": 30.5, "mask_people": True}}
        canvas = {"nodes": [{"id": "g1", "type": "gaussian", "data": data}], "edges": []}
        sent, saved = [], []

        class Lock:
            def __init__(self, *a): pass
            def __enter__(self): return self
            def __exit__(self, *e): return False
        with unittest.mock.patch.multiple(m, _resolve_project=lambda project, scene="": {"id": "p1"},
                                          _canvas=lambda pid: canvas, _hold_lock=Lock,
                                          _request=lambda method, path, **kw: sent.append((path, kw["json"])) or {"job_id": "j1"},
                                          _save_node_data=lambda pid, nid, upd, c: saved.append(upd) or 3):
            out = m.set_route_scale("p1", "g1", 14.1)
        self.assertEqual(sent, [("/rescale-route", {"route_ply_url": "/uploads/route_x.ply", "metres_per_unit": 14.1})])
        self.assertEqual((saved[0]["worldJobId"], saved[0]["worldJobKind"], out["job_id"]), ("j1", "routeScale", "j1"))
        changed = m._route_scaled_data(data, {"scale": 0.5, "metres_per_unit": 15.25})
        self.assertEqual(changed["routeExtendAdjust"], {"/uploads/a.mp4": {"yaw": 3.0, "right": 1.0}})
        self.assertEqual(changed["routeSettings"], {"metres_per_unit": 15.25, "mask_people": True})
        self.assertEqual(m._route_scaled_data(data, {"url": "/uploads/route_y.ply"}), {})

    def test_a_node_without_a_route_is_refused(self):
        import canvas_mcp_server as m
        canvas = {"nodes": [{"id": "g1", "type": "gaussian", "data": {"plyUrl": "/uploads/world_1.ply"}}], "edges": []}
        with unittest.mock.patch.multiple(m, _resolve_project=lambda project, scene="": {"id": "p1"},
                                          _canvas=lambda pid: canvas):
            with self.assertRaises(ValueError):
                m.set_route_scale("p1", "g1", 14.1)


class CharswapRunTests(unittest.TestCase):
    """run_canvas_node on a charswap node returned a KeyError('steps') *after* the job was
    submitted and the node saved: the reply read payload["steps"], which a Viggle swap
    has no use for. The caller saw an error for a job that was running."""

    def test_run_reports_the_job_it_started(self):
        import canvas_mcp_server as m
        canvas = {
            "nodes": [
                {"id": "clip", "type": "image", "data": {"url": "/uploads/a.mp4"}},
                {"id": "who", "type": "image", "data": {"url": "/uploads/b.png"}},
                {"id": "swap", "type": "charswap", "data": {"seed": 7, "megapixels": 0.5}},
            ],
            "edges": [
                {"source": "clip", "target": "swap", "targetHandle": "in-video"},
                {"source": "who", "target": "swap", "targetHandle": "in-character"},
            ],
        }
        sent = []

        def fake_request(method, path, **kw):
            sent.append((method, path, kw["json"]))
            return {"job_id": "j9", "status": "queued"}

        with unittest.mock.patch.object(m, "_request", side_effect=fake_request),                 unittest.mock.patch.object(m, "_save_node_data", return_value=12):
            out = m._run_charswap_locked({"id": "p1", "name": "P"}, canvas, canvas["nodes"][2])
        self.assertEqual(out["job_id"], "j9")
        self.assertEqual(out["seed"], 7)
        self.assertEqual(out["megapixels"], 0.5)
        self.assertEqual(sent[0][1], "/charswap")
        self.assertEqual(sent[0][2]["character_image_url"], "/uploads/b.png")
        self.assertEqual(sent[0][2]["mode"], "person")
        self.assertLess(sent[0][2]["face_frame_seconds"], 0)

    def test_face_mode_and_frame_time_reach_the_backend(self):
        import canvas_mcp_server as m
        canvas = {
            "nodes": [
                {"id": "clip", "type": "image", "data": {"url": "/uploads/a.mp4"}},
                {"id": "who", "type": "image", "data": {"url": "/uploads/b.png"}},
                {"id": "swap", "type": "charswap",
                 "data": {"swapMode": "head", "faceFrameSeconds": 3.5,
                          "facePrompt": "Edit <image 1>: give her the hair of <image 2>."}},
            ],
            "edges": [
                {"source": "clip", "target": "swap", "targetHandle": "in-video"},
                {"source": "who", "target": "swap", "targetHandle": "in-character"},
            ],
        }
        sent = []

        def fake_request(method, path, **kw):
            sent.append(kw["json"])
            return {"job_id": "j9", "status": "queued"}

        with unittest.mock.patch.object(m, "_request", side_effect=fake_request), \
                unittest.mock.patch.object(m, "_save_node_data", return_value=12):
            out = m._run_charswap_locked({"id": "p1", "name": "P"}, canvas, canvas["nodes"][2])
        self.assertEqual(sent[0]["mode"], "head")
        self.assertEqual(sent[0]["face_frame_seconds"], 3.5)
        self.assertEqual(sent[0]["face_prompt"], "Edit <image 1>: give her the hair of <image 2>.")
        self.assertEqual(out["mode"], "head")

    def test_each_swap_mode_reaches_the_backend(self):
        import canvas_mcp_server as m
        for node_mode, sent_mode in (('head', 'head'), ('reference', 'reference'), ('person', 'person'), (None, 'person'), ('face', 'person'), ('x', 'person')):
            canvas = {
                "nodes": [
                    {"id": "clip", "type": "image", "data": {"url": "/uploads/a.mp4"}},
                    {"id": "who", "type": "image", "data": {"url": "/uploads/b.png"}},
                    {"id": "swap", "type": "charswap", "data": {"swapMode": node_mode}},
                ],
                "edges": [
                    {"source": "clip", "target": "swap", "targetHandle": "in-video"},
                    {"source": "who", "target": "swap", "targetHandle": "in-character"},
                ],
            }
            sent = []
            with unittest.mock.patch.object(m, "_request", side_effect=lambda *a, **kw: sent.append(kw["json"]) or {"job_id": "j"}), \
                    unittest.mock.patch.object(m, "_save_node_data", return_value=1):
                m._run_charswap_locked({"id": "p1", "name": "P"}, canvas, canvas["nodes"][2])
            self.assertEqual(sent[0]["mode"], sent_mode, node_mode)

    def _two_people_canvas(self, node_data, photos=("/uploads/p1.png", "/uploads/p2.png")):
        nodes = [{"id": "clip", "type": "image", "data": {"url": "/uploads/a.mp4"}},
                 {"id": "swap", "type": "charswap", "data": node_data}]
        edges = [{"source": "clip", "target": "swap", "targetHandle": "in-video"}]
        for i, url in enumerate(photos):
            nodes.append({"id": f"who{i}", "type": "image", "data": {"url": url}})
            edges.append({"source": f"who{i}", "target": "swap", "targetHandle": "in-character"})
        return {"nodes": nodes, "edges": edges}

    def _run_swap(self, canvas):
        import canvas_mcp_server as m
        sent = []
        with unittest.mock.patch.object(m, "_request", side_effect=lambda *a, **kw: sent.append(kw["json"]) or {"job_id": "j"}),                 unittest.mock.patch.object(m, "_save_node_data", return_value=1):
            m._run_charswap_locked({"id": "p1", "name": "P"}, canvas, canvas["nodes"][1])
        return sent[0]

    def test_pointed_people_are_paired_with_the_photos_in_wired_order(self):
        sent = self._run_swap(self._two_people_canvas({
            "faceFrameSeconds": 1.5,
            "swapTargets": [{"x": 0.3, "y": 0.5}, {"x": 0.7, "y": 0.4}]}))
        self.assertEqual(sent["targets"], [
            {"x": 0.3, "y": 0.5, "image_url": "/uploads/p1.png"},
            {"x": 0.7, "y": 0.4, "image_url": "/uploads/p2.png"}])
        self.assertEqual(sent["character_image_url"], "/uploads/p1.png")
        self.assertEqual(sent["face_frame_seconds"], 1.5)

    def test_points_pin_the_frame_to_the_start_when_no_time_is_set(self):
        sent = self._run_swap(self._two_people_canvas({"swapTargets": [{"x": 0.3, "y": 0.5}]}, photos=("/uploads/p1.png",)))
        self.assertEqual(sent["face_frame_seconds"], 0.0)
        self.assertEqual(len(sent["targets"]), 1)

    def test_one_photo_and_no_points_sends_no_targets(self):
        sent = self._run_swap(self._two_people_canvas({}, photos=("/uploads/p1.png",)))
        self.assertNotIn("targets", sent)

    def test_several_photos_without_points_are_refused(self):
        with self.assertRaises(ValueError) as caught:
            self._run_swap(self._two_people_canvas({}))
        self.assertIn("no person is pointed at", str(caught.exception))

    def test_more_photos_than_points_leave_the_extra_photos_out(self):
        sent = self._run_swap(self._two_people_canvas({"swapTargets": [{"x": 0.5, "y": 0.5}]}))
        self.assertEqual([t["image_url"] for t in sent["targets"]], ["/uploads/p1.png"])

    def test_points_off_the_frame_are_dropped(self):
        sent = self._run_swap(self._two_people_canvas(
            {"swapTargets": [{"x": 1.4, "y": 0.5}, {"x": 0.5, "y": 0.5}]}, photos=("/uploads/p1.png",)))
        self.assertEqual(sent["targets"], [{"x": 0.5, "y": 0.5, "image_url": "/uploads/p1.png"}])

    def test_head_and_reference_modes_take_one_picture_and_no_points(self):
        for mode in ("head", "reference"):
            with self.assertRaises(ValueError):
                self._run_swap(self._two_people_canvas({"swapMode": mode}))
            sent = self._run_swap(self._two_people_canvas(
                {"swapMode": mode, "swapTargets": [{"x": 0.5, "y": 0.5}]}, photos=("/uploads/p1.png",)))
            self.assertNotIn("targets", sent, mode)

    def test_inspect_sends_both_inputs_and_returns_the_report(self):
        import canvas_mcp_server as m
        canvas = {
            "nodes": [
                {"id": "clip", "type": "image", "data": {"url": "/uploads/a.mp4"}},
                {"id": "who", "type": "image", "data": {"url": "/uploads/b.png"}},
                {"id": "swap", "type": "charswap", "data": {"swapMode": "head"}},
            ],
            "edges": [
                {"source": "clip", "target": "swap", "targetHandle": "in-video"},
                {"source": "who", "target": "swap", "targetHandle": "in-character"},
            ],
        }
        sent = []

        def fake_request(method, path, **kw):
            sent.append((method, path, kw["json"]))
            return {"best_frame_seconds": 3.2, "warnings": ["x"], "survey": []}

        with unittest.mock.patch.object(m, "_resolve_project", return_value={"id": "p1", "name": "P"}), \
                unittest.mock.patch.object(m, "_canvas", return_value=canvas), \
                unittest.mock.patch.object(m, "_request", side_effect=fake_request):
            out = m.inspect_charswap_inputs("p1", "swap")
        self.assertEqual(sent, [("POST", "/charswap/inspect",
                                 {"video_url": "/uploads/a.mp4", "character_image_url": "/uploads/b.png"})])
        self.assertEqual(out["best_frame_seconds"], 3.2)
        self.assertEqual(out["mode"], "head")

    def test_inspect_refuses_a_node_that_is_not_a_swap(self):
        import canvas_mcp_server as m
        canvas = {"nodes": [{"id": "n", "type": "video", "data": {}}], "edges": []}
        with unittest.mock.patch.object(m, "_resolve_project", return_value={"id": "p1", "name": "P"}), \
                unittest.mock.patch.object(m, "_canvas", return_value=canvas):
            with self.assertRaises(ValueError):
                m.inspect_charswap_inputs("p1", "n")


class VideoEditSpeedLoraTests(unittest.TestCase):
    """The edit node's speed LoRA reaches the backend. It did not: a TaoMate test queued with
    accelLora 'taomate3' went out with no accel_lora, and the backend took its steps from the default
    8-step LoRA, so the run was the one it was meant to be compared with (2026-10-04)."""

    def _sent(self, node_data):
        import canvas_mcp_server as m
        canvas = {
            "nodes": [
                {"id": "clip", "type": "video", "data": {"generatedUrl": "/comfy_output/a.mp4"}},
                {"id": "who", "type": "image", "data": {"url": "/uploads/b.png"}},
                {"id": "edit", "type": "videoEdit", "data": {"prompt": "p", **node_data}},
            ],
            "edges": [
                {"source": "clip", "target": "edit", "targetHandle": "in-video"},
                {"source": "who", "target": "edit", "targetHandle": "in-character"},
            ],
        }
        sent = []
        with unittest.mock.patch.object(m, "_request", side_effect=lambda *a, **kw: sent.append(kw["json"]) or {"job_id": "j"}),                 unittest.mock.patch.object(m, "_save_node_data", return_value=1):
            m._run_video_edit_locked({"id": "p1", "name": "P"}, canvas, canvas["nodes"][2])
        return sent[0]

    def test_taomate_reaches_the_backend(self):
        self.assertEqual(self._sent({"accelLora": "taomate3"})["accel_lora"], "taomate3")

    def test_no_choice_leaves_the_backend_default(self):
        self.assertNotIn("accel_lora", self._sent({}))

    def test_a_raw_prompt_and_style_loras_reach_the_backend(self):
        sent = self._sent({"rawPrompt": True, "styleLoras": ["h3/swap.safetensors"], "styleLoraStrengths": {"h3/swap.safetensors": 0.8}})
        self.assertIs(sent["raw_prompt"], True)
        self.assertEqual(sent["style_loras"], [{"name": "h3/swap.safetensors", "strength": 0.8}])
        plain = self._sent({})
        self.assertNotIn("raw_prompt", plain)

    def test_a_depth_clip_reaches_the_backend_as_the_control_video(self):
        sent = self._sent({"controlVideoUrl": "/comfy_output/depth.mp4", "controlStrength": 0.6})
        self.assertEqual((sent["control_video_url"], sent["control_strength"]), ("/comfy_output/depth.mp4", 0.6))
        self.assertNotIn("control_video_url", self._sent({}))


class CharswapEngineTests(unittest.TestCase):
    """The swap node's H3 engine: the options reach the backend, and what the engine cannot do is refused."""

    def _sent(self, node_data, photos=("/uploads/p1.png",)):
        import canvas_mcp_server as m
        nodes = [{"id": "clip", "type": "image", "data": {"url": "/uploads/a.mp4"}},
                 {"id": "swap", "type": "charswap", "data": node_data}]
        edges = [{"source": "clip", "target": "swap", "targetHandle": "in-video"}]
        for i, url in enumerate(photos):
            nodes.append({"id": f"who{i}", "type": "image", "data": {"url": url}})
            edges.append({"source": f"who{i}", "target": "swap", "targetHandle": "in-character"})
        canvas = {"nodes": nodes, "edges": edges}
        sent = []
        with unittest.mock.patch.object(m, "_request", side_effect=lambda *a, **kw: sent.append(kw["json"]) or {"job_id": "j"}),                 unittest.mock.patch.object(m, "_save_node_data", return_value=1):
            out = m._run_charswap_locked({"id": "p1", "name": "P"}, canvas, nodes[1])
        return sent[0], out

    def test_the_h3_engine_defaults_to_eight_steps_at_the_clips_size(self):
        sent, out = self._sent({"swapEngine": "h3"})
        self.assertEqual((sent["engine"], sent["h3_accel"], sent["h3_size"], sent["mode"]), ("h3", "turbo8", "source", "person"))
        self.assertEqual(sent["pose"], "auto")
        self.assertEqual(out["engine"], "h3")

    def test_the_options_combine(self):
        for accel, size in (("turbo8", "small"), ("taomate3", "small"), ("turbo8", "source")):
            sent, _ = self._sent({"swapEngine": "h3", "h3Accel": accel, "h3Size": size})
            self.assertEqual((sent["h3_accel"], sent["h3_size"]), (accel, size))

    def test_viggle_is_the_default_and_sends_no_h3_fields(self):
        for data in ({}, {"swapEngine": "viggle"}, {"swapEngine": "x"}):
            sent, out = self._sent(data)
            self.assertNotIn("engine", sent)
            self.assertEqual(out["engine"], "viggle")

    def test_what_the_h3_engine_cannot_do_is_refused(self):
        refused = (({"swapEngine": "h3", "swapMode": "head"}, ("/uploads/p1.png",)),
                   ({"swapEngine": "h3", "swapMode": "reference"}, ("/uploads/p1.png",)),
                   ({"swapEngine": "h3"}, ("/uploads/p1.png", "/uploads/p2.png")),
                   ({"swapEngine": "h3", "h3Accel": "fast"}, ("/uploads/p1.png",)),
                   ({"swapEngine": "h3", "h3Size": "huge"}, ("/uploads/p1.png",)))
        for data, photos in refused:
            with self.assertRaises(ValueError, msg=str(data)):
                self._sent(data, photos)

    def test_the_h3_engine_takes_the_pointed_people_like_the_other_engine(self):
        sent, _ = self._sent({"swapEngine": "h3", "faceFrameSeconds": 0.5,
                              "swapTargets": [{"x": 0.3, "y": 0.5}, {"x": 0.7, "y": 0.5}]},
                             ("/uploads/p1.png", "/uploads/p2.png"))
        self.assertEqual(sent["engine"], "h3")
        self.assertEqual([t["image_url"] for t in sent["targets"]], ["/uploads/p1.png", "/uploads/p2.png"])
        self.assertEqual(sent["face_frame_seconds"], 0.5)



class AutoHeightSizeTests(unittest.TestCase):
    def test_a_swap_node_keeps_only_its_width(self):
        import canvas_mcp_server as m
        swap = {"type": "charswap", "data": {"width": 1376, "height": 768}}
        m._apply_size(swap, {"width": 240, "aspect_ratio": 1.79})
        self.assertEqual(swap["width"], 240)
        self.assertNotIn("height", swap)
        self.assertEqual(swap["data"]["userWidth"], 240)
        video = {"type": "video", "data": {"width": 1376, "height": 768}}
        m._apply_size(video, {"width": 360})
        self.assertNotIn("height", video)
        image = {"type": "image", "data": {"width": 1376, "height": 768}}
        m._apply_size(image, {"width": 240})
        self.assertNotIn("height", image)
        text = {"type": "prompt", "data": {}}
        m._apply_size(text, {"width": 240, "height": 180})
        self.assertEqual(text["height"], 180)          # a text card's height is the user's: still stored
