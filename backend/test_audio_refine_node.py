"""The 声音精修 node: what it asks the backend for, and where its conditioning comes from."""
import unittest
from unittest import mock

from mcp_test_support import import_mcp_server

cms = import_mcp_server()


def _node(node_id, type_, **data):
    return {"id": node_id, "type": type_, "data": data}


def _edge(src, dst, handle):
    return {"source": src, "target": dst, "targetHandle": handle}


H3 = {
    "generatedUrl": "/comfy_output/H3_Chunk_aaaa1111_00001_.mp4",
    "compiledPrompt": "summary: night street\n\noverall_soundscape: engine hum",
    "prompt": "the NEXT prompt, not what made the clip",
    "submittedResources": {
        "reference_images": [{"url": "/uploads/sheet.png"}, {"url": "/uploads/env.png"}],
        "reference_audios": [{"url": "/uploads/va.wav"}],
    },
}


class RunAudioRefineTest(unittest.TestCase):
    def _run(self, nodes, edges, node_id="ar"):
        canvas = {"nodes": nodes, "edges": edges}
        sent = {}

        def request(method, path, **kw):
            sent.update(path=path, json=kw.get("json"))
            return {"job_id": "job1", "status": "queued"}

        saved = {}
        resolved = {"id": "p1", "name": "P"}
        with mock.patch.object(cms, "_request", request), \
                mock.patch.object(cms, "_save_node_data",
                                  lambda pid, nid, update, canvas=None: saved.update(update) or 7):
            out = cms._run_audio_refine_locked(resolved, canvas, next(n for n in nodes if n["id"] == node_id))
        return out, sent, saved

    def test_inherits_the_prompt_references_and_the_clip_of_the_h3_node_through_an_edit(self):
        nodes = [_node("shot", "video", **H3),
                 _node("edit", "videoEdit", generatedUrl="/comfy_output/H3_EditWindow_bb.mp4"),
                 _node("ar", "audioRefine", mode="polish", seed=5)]
        edges = [_edge("shot", "edit", "in-video"), _edge("edit", "ar", "in-video")]
        out, sent, saved = self._run(nodes, edges)
        self.assertEqual(sent["path"], "/audio-refine")
        body = sent["json"]
        self.assertEqual(body["video_url"], "/comfy_output/H3_EditWindow_bb.mp4")          # the clip as it is now
        self.assertEqual(body["prompt"], H3["compiledPrompt"])                              # what made it, not data.prompt
        self.assertEqual(body["ref_image_urls"], ["/uploads/sheet.png", "/uploads/env.png"])
        self.assertEqual(body["ref_audio_urls"], ["/uploads/va.wav"])
        self.assertEqual((body["mode"], body["seed"], body["steps"], body["denoise"]), ("polish", 5, None, None))
        self.assertEqual(out["inherited_from"], "shot")
        self.assertEqual(saved["refineInfo"]["inheritedFrom"], "shot")
        self.assertEqual(saved["status"], "generating")

    def test_a_chained_shot_is_redone_from_its_untrimmed_render_overlap_included(self):
        chained = {**H3, "untrimmedUrl": "/comfy_output/H3_Full_aaaa1111_00001_.mp4", "contextFrames": 22}
        nodes = [_node("shot", "video", **chained), _node("ar", "audioRefine")]
        _, sent, saved = self._run(nodes, [_edge("shot", "ar", "in-video")])
        self.assertEqual(sent["json"]["video_url"], "/comfy_output/H3_Full_aaaa1111_00001_.mp4")
        self.assertEqual(sent["json"]["overlap_frames"], 22)
        self.assertEqual(saved["pendingOverlapFrames"], 22)

    def test_an_untrimmed_file_of_another_take_is_not_used(self):
        stale = {**H3, "untrimmedUrl": "/comfy_output/H3_Full_bbbb2222_00001_.mp4", "contextFrames": 22}
        nodes = [_node("shot", "video", **stale), _node("ar", "audioRefine")]
        _, sent, _ = self._run(nodes, [_edge("shot", "ar", "in-video")])
        self.assertEqual(sent["json"]["video_url"], H3["generatedUrl"])
        self.assertEqual(sent["json"]["overlap_frames"], 0)

    def test_wired_references_follow_the_inherited_ones(self):
        nodes = [_node("shot", "video", **H3), _node("img", "image", url="/uploads/extra.png"),
                 _node("ar", "audioRefine")]
        edges = [_edge("shot", "ar", "in-video"), _edge("img", "ar", "in-ref-image")]
        _, sent, _ = self._run(nodes, edges)
        self.assertEqual(sent["json"]["ref_image_urls"], ["/uploads/sheet.png", "/uploads/env.png", "/uploads/extra.png"])

    def test_a_prompt_of_its_own_replaces_everything_inherited(self):
        nodes = [_node("shot", "video", **H3), _node("img", "image", url="/uploads/extra.png"),
                 _node("ar", "audioRefine", prompt="rain on a roof")]
        edges = [_edge("shot", "ar", "in-video"), _edge("img", "ar", "in-ref-image")]
        out, sent, saved = self._run(nodes, edges)
        self.assertEqual(sent["json"]["prompt"], "rain on a roof")
        self.assertEqual(sent["json"]["ref_image_urls"], ["/uploads/extra.png"])             # only what is wired
        self.assertEqual(sent["json"]["ref_audio_urls"], [])
        self.assertIsNone(out["inherited_from"])
        self.assertTrue(saved["refineInfo"]["overridden"])

    def test_an_upload_with_no_h3_node_upstream_needs_a_prompt(self):
        nodes = [_node("up", "image", url="/uploads/a.mp4"), _node("ar", "audioRefine")]
        with self.assertRaisesRegex(ValueError, "no H3 video node upstream"):
            self._run(nodes, [_edge("up", "ar", "in-video")])
        out, sent, _ = self._run([_node("up", "image", url="/uploads/a.mp4"), _node("ar", "audioRefine", prompt="wind")],
                                 [_edge("up", "ar", "in-video")])
        self.assertEqual(sent["json"]["video_url"], "/uploads/a.mp4")

    def test_needs_exactly_one_finished_clip(self):
        with self.assertRaisesRegex(ValueError, "exactly one clip"):
            self._run([_node("ar", "audioRefine", prompt="x")], [])
        with self.assertRaisesRegex(ValueError, "has no file yet"):
            self._run([_node("shot", "video"), _node("ar", "audioRefine", prompt="x")], [_edge("shot", "ar", "in-video")])

    def test_warns_which_chained_clips_still_carry_the_old_sound(self):
        nodes = [_node("shot", "video", **H3), _node("next", "video", generatedUrl="/comfy_output/n.mp4"),
                 _node("ar", "audioRefine")]
        edges = [_edge("shot", "ar", "in-video"), _edge("shot", "next", cms.CHAIN_HANDLE)]
        out, _, _ = self._run(nodes, edges)
        self.assertEqual(out["downstream_not_updated"], ["next"])

    def test_the_mode_and_overrides_reach_the_backend(self):
        nodes = [_node("shot", "video", **H3), _node("ar", "audioRefine", mode="reroll", steps=6, denoise=0.8, seed=9)]
        _, sent, _ = self._run(nodes, [_edge("shot", "ar", "in-video")])
        self.assertEqual((sent["json"]["mode"], sent["json"]["steps"], sent["json"]["denoise"], sent["json"]["seed"]),
                         ("reroll", 6, 0.8, 9))

    def test_the_catalog_knows_the_node(self):
        entry = cms.NODE_CATALOG["audioRefine"]
        self.assertEqual(entry["inputs"], ["in-video", "in-ref-image", "in-ref-audio"])
        self.assertEqual(entry["outputs"], ["out-video"])


if __name__ == "__main__":
    unittest.main()
