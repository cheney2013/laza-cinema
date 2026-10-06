"""What seam match a continuation request resolves to (main._seam_match_args)."""
import unittest

import main


def req(**kw):
    return main.VideoRequest(prompt="a shot", **kw)


class SeamMatchDefaultTest(unittest.TestCase):
    def test_a_continuation_gets_the_default(self):
        args = main._seam_match_args(req(motion_context_latent="H3_Latent_a_00001_.safetensors"))
        self.assertEqual(args["seam_match"], "auto")
        self.assertTrue(args["seam_match_adaptive"])
        args = main._seam_match_args(req(motion_context_video="/comfy_output/H3_Chunk_a_00001_.mp4"))
        self.assertEqual(args["seam_match"], "auto")

    def test_a_node_can_turn_it_off(self):
        for off in ("off", "none"):
            args = main._seam_match_args(req(motion_context_latent="x.safetensors", seam_match=off))
            self.assertEqual(args["seam_match"], "")

    def test_no_seam_no_match(self):
        self.assertEqual(main._seam_match_args(req())["seam_match"], "")
        args = main._seam_match_args(req(motion_context_latent="x.safetensors", existing_context_length=22))
        self.assertEqual(args["seam_match"], "")

    def test_a_request_overrides_single_fields(self):
        args = main._seam_match_args(req(motion_context_latent="x.safetensors", seam_match="mean",
                                         seam_match_gain=0.6, seam_match_adaptive=False))
        self.assertEqual((args["seam_match"], args["seam_match_gain"], args["seam_match_adaptive"]),
                         ("mean", 0.6, False))
        self.assertEqual(args["seam_match_texture"], 1.0)


if __name__ == "__main__":
    unittest.main()
