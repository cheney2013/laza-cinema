"""AicinemaSeamMatch (comfyui_nodes/aicinema_chain/seam_match.py): the arithmetic, on synthetic latents."""
import importlib.util
import unittest
from pathlib import Path

import torch

_spec = importlib.util.spec_from_file_location(
    "seam_match", Path(__file__).resolve().parents[1] / "comfyui_nodes" / "aicinema_chain" / "seam_match.py")
sm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sm)

C, H, W = 24, 48, 86


def smooth_noise(t, seed, sigma=2.0, wobble=0.1):
    """t latent steps of one smooth random picture, each step moved a little: a held shot."""
    g = torch.Generator().manual_seed(seed)
    x = torch.randn(1, C, 1, H, W, generator=g) + wobble * torch.randn(1, C, t, H, W, generator=g)
    y = sm.blur(x.permute(0, 2, 1, 3, 4).reshape(t, C, H, W), sigma)
    return (y / y.std()).reshape(1, t, C, H, W).permute(0, 2, 1, 3, 4)


def clip_from(tail, bias, texture=1.0, steps=7, extra=10):
    """A clip whose first `steps` regenerate `tail` with `bias` added and its texture scaled."""
    head = tail[:, :, -steps:]
    fine, band, low = sm.split(head)
    head = low + band * texture + fine * texture + bias
    rest = head[:, :, -1:].repeat(1, 1, extra, 1, 1)
    return torch.cat([head, rest], 2)


class SeamMatchTest(unittest.TestCase):
    def setUp(self):
        self.tail = smooth_noise(12, 1)
        g = torch.Generator().manual_seed(2)
        self.offset = torch.randn(1, C, 1, 1, 1, generator=g) * 0.15        # the per-channel shift
        ramp = torch.linspace(-1, 1, W).view(1, 1, 1, 1, W)                   # and a smooth spatial part
        self.bias = self.offset + 0.05 * ramp

    def rel(self, out):
        tail = self.tail[:, :, -7:]
        return float((out[:, :, :7] - tail).pow(2).mean().sqrt() / tail.std())

    def test_window_lengths(self):
        self.assertEqual([sm.steps_for_frames(n) for n in (5, 22, 39, 56)], [2, 7, 12, 17])
        with self.assertRaises(ValueError):
            sm.steps_for_frames(10)

    def test_field_takes_out_offset_and_spatial_part(self):
        video = clip_from(self.tail, self.bias)
        before = self.rel(video)
        out, report = sm.match(video, self.tail, 7, "field", 1.0, 3.0, 0.5)
        self.assertLess(self.rel(out), before * 0.1, report)
        # every later step gets the same correction
        self.assertTrue(torch.allclose(out[:, :, -1] - video[:, :, -1], out[:, :, 6] - video[:, :, 6], atol=1e-5))

    def test_mean_takes_out_the_offset_only(self):
        video = clip_from(self.tail, self.bias)
        out, _ = sm.match(video, self.tail, 7, "mean", 1.0, 3.0, 0.5)
        resid = (out[:, :, :7] - self.tail[:, :, -7:]).mean((2, 3, 4))
        self.assertLess(float(resid.abs().max()), 1e-4)                        # channel means match
        self.assertGreater(self.rel(out), 0.01)                                 # the ramp is left

    def test_blotch_band_gain_is_divided_back_out_fine_detail_is_left(self):
        video = clip_from(self.tail, 0.0, texture=1.04)
        out, _ = sm.match(video, self.tail, 7, "mean", 1.0, 3.0, 0.5, texture=1.0)
        gf, gb = sm.texture_gains(out[:, :, :7], self.tail[:, :, -7:])
        # the bands overlap a little, so one pass lands within about 1 % of the tail
        self.assertAlmostEqual(float(gb.mean()), 1.0, delta=0.015)
        # what changed is the blotch band of the input, scaled, and nothing else
        _, g_band = sm.texture_gains(video[:, :, :7], self.tail[:, :, -7:])
        add = sm.correction(video[:, :, :7], self.tail[:, :, -7:], "mean", 3.0, video)
        _, band, _ = sm.split(video + add)
        expected = video + add + band * (g_band.clamp(0.8, 1.0).view(1, -1, 1, 1, 1) - 1)
        self.assertTrue(torch.allclose(out, expected, atol=1e-5))
        soft = clip_from(self.tail, 0.0, texture=0.96)
        out, _ = sm.match(soft, self.tail, 7, "mean", 0.0, 3.0, 0.5, texture=1.0)
        self.assertTrue(torch.allclose(out, soft, atol=1e-5))                  # a softer head stays soft

    def test_a_head_that_is_not_the_tail_is_left_alone(self):
        other = smooth_noise(17, 9)
        out, report = sm.match(other, self.tail, 7, "field", 1.0, 3.0, 0.15)
        self.assertTrue(torch.equal(out, other))
        self.assertIn("skipped", report)

    def test_auto_keeps_the_field_while_the_layout_holds_and_drops_it_after_a_cut(self):
        video = clip_from(self.tail, self.bias, extra=6)
        cut = smooth_noise(6, 5)
        video = torch.cat([video, cut], 2)
        w = sm.layout_weights(video, video[:, :, :7])
        self.assertTrue(bool((w[:13] > 0.99).all()), w)
        self.assertTrue(bool((w[13:] < 0.05).all()), w)
        out, _ = sm.match(video, self.tail, 7, "auto", 1.0, 3.0, 0.5)
        field_add = out[:, :, 3] - video[:, :, 3]
        cut_add = out[:, :, -1] - video[:, :, -1]
        self.assertGreater(float(field_add.std((2, 3)).mean()), 0.01)          # spatial part on the held frames
        self.assertLess(float(cut_add.std((2, 3)).mean()), 1e-4)               # only the offset after the cut

    def test_post_gain_leaves_the_overlap_and_ramps_after_it(self):
        p = sm.post_profile(20, 7, 1.6)
        self.assertTrue(bool((p[:7] == 1.0).all()))
        self.assertAlmostEqual(float(p[-1]), 1.6, places=5)
        self.assertTrue(bool((p[1:] >= p[:-1]).all()))


class FakeVAE:
    """Decodes a latent step to frames by a fixed linear map, 1 frame for the first step of each
    5-step cycle and 4 for the others, like the H3 video VAE's 1,4,4,4,4 grid."""
    def __init__(self):
        g = torch.Generator().manual_seed(7)
        self.w = torch.randn(3, C, generator=g) * 0.05

    def decode(self, z):
        frames = []
        for k in range(z.shape[2]):
            rgb = torch.einsum("oc,chw->hwo", self.w, z[0, :, k]) + 0.5
            rgb = rgb.repeat_interleave(16, 0).repeat_interleave(16, 1)
            frames += [rgb] * (1 if k % 5 == 0 else 4)
        return torch.stack(frames)


class AdaptiveGainTest(unittest.TestCase):
    def test_fit_finds_the_gain_that_nulls_the_step(self):
        g = torch.Generator().manual_seed(3)
        prev = torch.rand(5, 96, 160, 3, generator=g)
        bias = torch.tensor([0.03, 0.01, -0.02])
        regen = prev + bias
        after = prev + 0.6 * bias
        gain, r2, mag = sm.fit_gain(prev, regen, after)
        self.assertAlmostEqual(gain, 0.6, places=3)
        self.assertGreater(r2, 0.99)
        self.assertAlmostEqual(mag, float(bias.norm()), places=4)

    def test_measure_uses_the_frames_around_the_seam_and_falls_back(self):
        vae = FakeVAE()
        tail = smooth_noise(12, 1)
        held = clip_from(tail, 0.0, extra=20)          # a held shot: no bias at all
        near, far, rep = sm.measure_gain(vae, held, tail, 7, 22, 0.8)
        self.assertEqual((near, far), (0.8, 0.8))      # nothing to measure: the fallback
        self.assertIn("not reliable", rep)
        short = held[:, :, :10]
        self.assertEqual(sm.measure_gain(vae, short, tail, 7, 22, 0.8)[:2], (0.8, 0.8))

    def test_measure_recovers_the_gain_of_a_held_shot(self):
        vae = FakeVAE()
        tail = smooth_noise(12, 1, wobble=0.0)          # a still picture
        g = torch.Generator().manual_seed(4)
        bias = 0.3 * torch.randn(1, C, 1, 1, 1, generator=g)
        head = tail[:, :, -7:] + bias
        after = tail[:, :, -1:].repeat(1, 1, 20, 1, 1) + 0.65 * bias
        near, far, rep = sm.measure_gain(vae, torch.cat([head, after], 2), tail, 7, 22, 0.8)
        self.assertAlmostEqual(near, 0.65, places=2, msg=rep)
        self.assertAlmostEqual(far, 0.65, places=2, msg=rep)

    def test_the_previous_tail_is_decoded_with_a_group_of_context(self):
        # its last 2 steps decoded alone come out brighter than in the full decode; 7 start a group
        class Spy(FakeVAE):
            steps = []

            def decode(self, z):
                self.steps.append(z.shape[2])
                return super().decode(z)

        vae = Spy()
        tail = smooth_noise(12, 1)
        sm.measure_gain(vae, clip_from(tail, 0.1, extra=20), tail, 7, 22, 0.8)
        self.assertEqual(vae.steps[0], 7)
        for short in (tail[:, :, -5:], smooth_noise(13, 2)):     # too short / off the 17k+5 grid
            Spy.steps = []
            sm.measure_gain(vae, clip_from(tail, 0.1, extra=20), short, 7, 22, 0.8)
            self.assertEqual(vae.steps[0], 2)

    def test_profile_holds_near_through_the_seam_then_eases(self):
        p = sm.gain_profile(20, 7, 0.6, 1.1)
        self.assertTrue(bool((p[:9] == 0.6).all()))
        self.assertAlmostEqual(float(p[-1]), 1.1, places=5)


if __name__ == "__main__":
    unittest.main()
