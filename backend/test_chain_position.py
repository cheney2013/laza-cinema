"""Continuing a clip from a point inside the previous one (motion_context_end_frame)."""

import unittest

from workflow_builders import build_h3_video_workflow


def _build(**kw):
    return build_h3_video_workflow(
        prompt="a quiet room", width=960, height=544, length=175, steps=8, seed=1,
        unet_name="minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        lora_name="h3/minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors", **kw)


class ChainPositionTest(unittest.TestCase):
    def test_default_reads_the_whole_clip(self):
        wf = _build(motion_context_video="prev.mp4")
        self.assertEqual(wf["80"]["inputs"]["frame_load_cap"], 0)

    def test_point_cuts_the_source_at_that_frame(self):
        wf = _build(motion_context_video="prev.mp4", motion_context_end_frame=202)
        self.assertEqual(wf["80"]["class_type"], "VHS_LoadVideoPath")
        self.assertEqual(wf["80"]["inputs"]["frame_load_cap"], 202)
        self.assertEqual(wf["80"]["inputs"]["skip_first_frames"], 0)

    def test_point_applies_to_the_extension_path_too(self):
        wf = _build(motion_context_video="prev.mp4", existing_context_length=39, motion_context_end_frame=120)
        self.assertEqual(wf["80"]["inputs"]["frame_load_cap"], 120)

    def test_point_needs_a_video(self):
        with self.assertRaisesRegex(ValueError, "needs motion_context_video"):
            _build(motion_context_latent="H3_Latent_x_00001_.safetensors", motion_context_end_frame=100)

    def test_point_must_leave_room_for_the_context_window(self):
        with self.assertRaisesRegex(ValueError, "shorter than the 22-frame"):
            _build(motion_context_video="prev.mp4", motion_context_end_frame=10)


if __name__ == "__main__":
    unittest.main()
