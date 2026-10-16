"""No speed LoRA (accel_lora 'none', the official 20-step path) runs without an attention patch unless
the request names one; every other path keeps the default."""
import unittest

import main


def _req(**kw):
    return main.VideoRequest(prompt="a shot", **kw)


class AttentionDefaultTest(unittest.TestCase):
    def test_no_speed_lora_and_no_choice_means_no_patch(self):
        self.assertEqual(main._h3_attention(_req(accel_lora="none")), "disabled")

    def test_an_explicit_choice_wins(self):
        self.assertEqual(main._h3_attention(_req(accel_lora="none", sage="kjsage")), "kjsage")
        self.assertEqual(main._h3_attention(_req(accel_lora="none", sage="sol")), "sol")

    def test_a_control_video_means_kjsage(self):
        for lora in ("none", "turbo8", ""):
            self.assertEqual(main._h3_attention(_req(accel_lora=lora, control_video_url="/uploads/c.mp4")), "kjsage")
        self.assertEqual(main._h3_attention(_req(control_video_url="/uploads/c.mp4", sage="sol")), "sol")

    def test_speed_lora_paths_keep_the_default(self):
        self.assertEqual(main._h3_attention(_req(accel_lora="turbo8")), main.DEFAULT_H3_ACCEL)
        self.assertEqual(main._h3_attention(_req()), main.DEFAULT_H3_ACCEL)


if __name__ == "__main__":
    unittest.main()
