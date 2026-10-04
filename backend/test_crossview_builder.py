"""The CrossView re-angle route through build_h3_video_workflow."""

import json
import unittest

from workflow_builders import build_h3_video_workflow


def _build(**kw):
    return build_h3_video_workflow(
        prompt="crossview", video_reference_filenames=["src.mp4"],
        width=960, height=544, length=124, steps=8, seed=1,
        unet_name="minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        lora_name="h3/minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors", **kw)


def _of(wf, class_type):
    return [k for k, n in wf.items() if n["class_type"] == class_type]


class CrossviewBuilderTest(unittest.TestCase):
    def test_depth_source_feeds_moge_but_warp_moves_original_frames(self):
        wf = _build(crossview_warp={"source": "src.mp4", "azimuth": 30, "keyframes": [],
                                    "depth_source": "src_depthsrc.mp4", "apply_mask": False})
        (moge,) = _of(wf, "MoGeInference")
        (warp,) = _of(wf, "CrossViewWarp")
        depth_load = wf[wf[moge]["inputs"]["image"][0]]["inputs"]["video"][0]
        self.assertEqual(wf[depth_load]["inputs"]["file"], "src_depthsrc.mp4")
        frames_load = wf[wf[warp]["inputs"]["frames"][0]]["inputs"]["video"][0]
        self.assertEqual(wf[frames_load]["inputs"]["file"], "src.mp4")
        self.assertFalse(wf[moge]["inputs"]["apply_mask"])

    def test_pivot_overrides_the_automatic_centre(self):
        wf = _build(crossview_warp={"source": "src.mp4", "azimuth": 30, "keyframes": [],
                                    "pivot": {"x": 0, "y": 0.1, "z": 0.8}, "smooth_depth": True})
        (warp,) = _of(wf, "CrossViewWarp")
        i = wf[warp]["inputs"]
        self.assertTrue(i["pivot_override"])
        self.assertEqual((i["pivot_x"], i["pivot_y"], i["pivot_z"]), (0.0, 0.1, 0.8))
        self.assertTrue(i["smooth_depth"])
        wf = _build(crossview_warp={"source": "src.mp4", "azimuth": 30, "keyframes": []})
        (warp,) = _of(wf, "CrossViewWarp")
        self.assertFalse(wf[warp]["inputs"]["pivot_override"])
        self.assertNotIn("pivot_z", wf[warp]["inputs"])

    def test_without_depth_source_moge_reads_the_clip(self):
        wf = _build(crossview_warp={"source": "src.mp4", "azimuth": 30, "keyframes": []})
        (moge,) = _of(wf, "MoGeInference")
        (warp,) = _of(wf, "CrossViewWarp")
        self.assertEqual(wf[moge]["inputs"]["image"], wf[warp]["inputs"]["frames"])
        self.assertTrue(wf[moge]["inputs"]["apply_mask"])

    def test_warp_feeds_addguide_as_raw_image(self):
        cuts = [{"f": 1, "az": -30, "el": 0, "dist": 1.0}, {"f": 60, "az": 35, "el": 0, "dist": 1.0}]
        wf = _build(crossview_warp={"source": "src.mp4", "azimuth": 0, "keyframes": cuts},
                    block_sparse=True, sampler="res_multistep")
        (warp,) = _of(wf, "CrossViewWarp")
        (moge,) = _of(wf, "MoGeInference")
        self.assertEqual(wf[warp]["inputs"]["moge_geometry"], [moge, 0])
        self.assertTrue(wf[warp]["inputs"]["use_keyframes"])
        self.assertEqual(json.loads(wf[warp]["inputs"]["keyframes"]), cuts)
        self.assertFalse(wf[warp]["inputs"]["pivot_override"])
        self.assertTrue(wf[warp]["inputs"]["keep_source_aim"])
        # warp -> ImageScale -> AddGuide(frame 0), no file in between
        (guide,) = _of(wf, "MiniMaxH3AddGuide")
        scale = wf[guide]["inputs"]["image"][0]
        self.assertEqual(wf[scale]["inputs"]["image"], [warp, 0])
        self.assertEqual(wf[guide]["inputs"]["frame_idx"], 0)
        # the guided conditioning is what the guider samples, through the sparse patch
        (guider,) = _of(wf, "BasicGuider")
        self.assertEqual(wf[guider]["inputs"]["conditioning"], [guide, 0])
        (bsa,) = _of(wf, "BlockSparseAttention")
        self.assertEqual(wf[guider]["inputs"]["model"], [bsa, 0])
        self.assertEqual(wf[bsa]["inputs"]["sink_conditioning"], "exact_kv_and_rows")
        (sampler,) = _of(wf, "KSamplerSelect")
        self.assertEqual(wf[sampler]["inputs"]["sampler_name"], "res_multistep")

    def test_default_path_untouched(self):
        wf = _build()
        for ct in ("CrossViewWarp", "MoGeInference", "BlockSparseAttention", "MiniMaxH3AddGuide"):
            self.assertEqual(_of(wf, ct), [], ct)
        (sampler,) = _of(wf, "KSamplerSelect")
        self.assertEqual(wf[sampler]["inputs"]["sampler_name"], "euler")

    def test_guide_and_warp_are_exclusive(self):
        with self.assertRaises(ValueError):
            _build(guide_video_filename="g.mp4", crossview_warp={"source": "src.mp4"})


if __name__ == "__main__":
    unittest.main()
