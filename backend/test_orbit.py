"""The 360 环绕 node sends H3 what the run that proved the LoRA sent (H3_Video_7a105a73, 2026-10-06)."""
import asyncio
import unittest

import main


class OrbitRequestBuildsTheProvenRun(unittest.TestCase):
    def run_job(self, **fields):
        seen = {}

        async def fake_video_job(job, vreq):
            seen["vreq"] = vreq
            return {"url": "/comfy_output/x.mp4"}

        original, main._run_video_job = main._run_video_job, fake_video_job
        try:
            main.save_state = lambda *a, **k: None
            asyncio.run(main._run_orbit_job({"id": "j"}, main.OrbitRequest(image_url="/uploads/a.png", **fields)))
        finally:
            main._run_video_job = original
        return seen["vreq"]

    def test_same_picture_first_and_last_on_the_fl2va_base_with_the_orbit_lora(self):
        v = self.run_job()
        self.assertEqual(v.image_url, "/uploads/a.png")
        self.assertEqual(v.guide_frames, [{"url": "/uploads/a.png", "frame_index": -1}])
        self.assertEqual(v.motion_preset, "fl2va")
        self.assertEqual(v.accel_lora, "none")             # no speed LoRA: the official run is 28 plain steps
        self.assertEqual(v.style_loras, [{"name": "h3/minimax_h3_flf2v_lora_v1.safetensors", "strength": 1.0}])
        self.assertTrue(v.raw_prompt)
        self.assertEqual(v.shift_video, 12.0)
        self.assertTrue(v.block_sparse)

    def test_official_space_defaults(self):
        v = self.run_job()
        self.assertEqual((v.width, v.height, v.length), (768, 768, 73))   # 3 s snapped to 17k+5

    def test_prompt_is_the_trained_sentence_and_cannot_be_replaced(self):
        v = self.run_job()
        self.assertTrue(v.prompt.startswith("One frozen instant. Only the camera moves. In a continuous 360 orbit."))
        self.assertTrue(v.prompt.endswith("No cuts, zoom, morphing or added objects."))
        self.assertNotIn("prompt", main.OrbitRequest.model_fields)

    def test_duration_snaps_up_to_the_frame_grid(self):
        self.assertEqual(main._orbit_frames(3), 73)
        for sec in (1, 2.5, 3, 4, 5, 7):
            n = main._orbit_frames(sec)
            self.assertEqual((n - 5) % 17, 0)
            self.assertGreaterEqual(n, round(sec * 24))


if __name__ == "__main__":
    unittest.main()
