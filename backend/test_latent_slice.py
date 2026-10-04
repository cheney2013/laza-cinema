"""Cutting a chain latent at the 17n+5 grid, and the trim that does it."""

import tempfile
import unittest
from pathlib import Path

import numpy as np

import latent_slice as ls
import main


def make_latent(path: Path, frames: int) -> None:
    rng = np.random.default_rng(1)
    video = rng.standard_normal((1, 24, ls.video_steps(frames), 3, 4)).astype(np.float32)
    audio = rng.standard_normal((1, 32, 2, int(frames / 24 * 40))).astype(np.float32)
    ls.write(path, {"format": "pt"}, {"video": video, "audio": audio})


class GridTest(unittest.TestCase):
    def test_grid(self):
        self.assertTrue(all(ls.on_grid(n) for n in (5, 22, 175, 192, 209)))
        self.assertFalse(any(ls.on_grid(n) for n in (0, 4, 23, 180, 200)))

    def test_steps_match_what_the_project_measured(self):
        # 209 frames -> 62 video steps and 348 audio steps; 175 -> 52; 260 -> 77 (main.py)
        self.assertEqual([ls.video_steps(n) for n in (209, 175, 260, 39)], [62, 52, 77, 12])
        self.assertEqual(ls.audio_steps(209), 348)
        self.assertEqual(ls.audio_steps(294), 490)
        self.assertEqual(ls.audio_steps(175), 292)   # 291.67 rounds up: the old floor gave 291

    def test_every_grid_length_is_within_a_third_of_a_step_of_5_3_frames(self):
        # what MiniMaxH3MotionContext accepts (-0.5 < overhang < 0.5)
        for n in range(5, 400, 17):
            self.assertLess(abs(ls.audio_steps(n) - n * 5 / 3), 0.5, n)


class SliceTest(unittest.TestCase):
    def test_slice_keeps_the_head_and_the_rest_bit_for_bit(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, dst = Path(tmp) / "a.safetensors", Path(tmp) / "b.safetensors"
            make_latent(src, 209)
            info = ls.slice_latent(src, 175, dst)
            self.assertEqual(info["video"], [[1, 24, 62, 3, 4], [1, 24, 52, 3, 4]])
            self.assertEqual(info["audio"][1][3], 292)
            meta_a, a = ls.read(src)
            meta_b, b = ls.read(dst)
            self.assertEqual(meta_a, meta_b)
            np.testing.assert_array_equal(b["video"], a["video"][:, :, :52])
            np.testing.assert_array_equal(b["audio"], a["audio"][:, :, :, :292])
            self.assertEqual(ls.latent_video_steps(dst), 52)

    def test_off_the_grid_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "a.safetensors"
            make_latent(src, 209)
            with self.assertRaisesRegex(ValueError, "17n\\+5"):
                ls.slice_latent(src, 180, Path(tmp) / "b.safetensors")

    def test_longer_than_the_latent_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "a.safetensors"
            make_latent(src, 175)
            with self.assertRaisesRegex(ValueError, "video steps"):
                ls.slice_latent(src, 209, Path(tmp) / "b.safetensors")


class TrimLatentTest(unittest.TestCase):
    def cut(self, tmp, latent_frames, context, source_frames, end):
        make_latent(Path(tmp) / "L.safetensors", latent_frames)
        return main._cut_trim_latent(Path(tmp), "L.safetensors", context, source_frames, end, "abcd1234")

    def test_unchained_clip_cut_on_the_grid(self):
        with tempfile.TemporaryDirectory() as tmp:
            name = self.cut(tmp, 209, 0, 209, 175)
            self.assertEqual(name, "H3_Latent_abcd1234_00001_.safetensors")
            self.assertEqual(ls.latent_video_steps(Path(tmp) / name), 52)

    def test_chained_clip_counts_its_context(self):
        # served clip 192 frames after 22 of context: the latent is 214 frames... must be 17n+5
        with tempfile.TemporaryDirectory() as tmp:
            # 22 + 170 = 192 is on the grid, so a cut that keeps 170 served frames works
            name = self.cut(tmp, 192 + 17, 22, 187, 170)
            self.assertEqual(ls.latent_video_steps(Path(tmp) / name), ls.video_steps(192))

    def test_off_the_grid_cut_gives_pictures_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "not on the 17n\\+5 grid"):
                self.cut(tmp, 209, 0, 209, 180)

    def test_a_latent_of_another_clip_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "this clip is"):
                self.cut(tmp, 192, 0, 209, 175)


if __name__ == "__main__":
    unittest.main()
