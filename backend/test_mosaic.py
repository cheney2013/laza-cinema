import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
import mosaic  # noqa: E402


def _write(path, frames, fps=24):
    h, w = frames[0].shape[:2]
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
                          "-s", f"{w}x{h}", "-r", str(fps), "-i", "-", "-pix_fmt", "yuv420p", str(path)],
                         stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    p.wait()



class MosaicTests(unittest.TestCase):
    def test_seed_points_first_frame_with_boxes(self):
        dets = [{"frame": 0, "boxes": []},
                {"frame": 8, "boxes": [{"c": "X", "s": .6, "box": [10, 20, 30, 40]},
                                       {"c": "X", "s": .5, "box": [100, 100, 20, 20]}]}]
        self.assertEqual(mosaic.seed_points(dets), (8, [(25, 40), (110, 110)]))
        self.assertEqual(mosaic.seed_points([{"frame": 0, "boxes": []}]), (-1, []))

    def test_grow_mask_expands_by_px_and_keeps_empty(self):
        m = np.zeros((50, 50), bool)
        m[25, 25] = True
        g = mosaic.grow_mask(m, 5)
        self.assertTrue(g[25, 30] and g[20, 25])
        self.assertFalse(g[25, 32])
        self.assertFalse(mosaic.grow_mask(np.zeros((5, 5), bool), 3).any())
        self.assertIs(mosaic.grow_mask(m, 0), m)

    def test_box_coverage_counts_pixels_not_extent(self):
        m = np.zeros((100, 100), bool)
        m[0:10, 0:10] = True
        self.assertAlmostEqual(mosaic.box_coverage(m, [0, 0, 20, 10]), 0.5)

    def test_apply_style_changes_only_masked_pixels(self):
        rng = np.random.default_rng(0)
        f = rng.integers(0, 255, (96, 128, 3), dtype=np.uint8)
        m = np.zeros((96, 128), bool)
        m[20:60, 30:90] = True
        for style in mosaic.STYLES:
            with self.subTest(style=style):
                out = mosaic.apply_style(f, m, style, block=8)
                self.assertTrue((out[~m] == f[~m]).all())
                self.assertTrue((out[m] != f[m]).any())

    def test_default_classes_exclude_face_armpits_and_breast(self):
        for c in ("FACE_FEMALE", "ARMPITS_EXPOSED", "FEMALE_BREAST_EXPOSED"):
            self.assertNotIn(c, mosaic.DEFAULT_CLASSES)

    def test_render_falls_back_to_box_when_track_covers_nothing(self):
        h, w, n = 96, 128, 10
        base = np.random.default_rng(1).integers(0, 255, (h, w, 3), dtype=np.uint8)
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            src, mask, out = tmp / "s.mp4", tmp / "m.mp4", tmp / "o.mp4"
            _write(src, [base] * n)
            _write(mask, [np.zeros((h, w, 3), np.uint8)] * n)   # the track lost the object
            dets = [{"frame": 0, "boxes": [{"c": "X", "s": .9, "box": [40, 30, 40, 30]}]},
                    {"frame": 5, "boxes": [{"c": "X", "s": .9, "box": [40, 30, 40, 30]}]}]
            info = mosaic.render(src, mask, out, dets, 5, expand=0, temporal=0, block=16, feather=0)
            self.assertEqual(info["frames"], n)
            self.assertIn(0, info["suspect_frames"])
            self.assertIn(5, info["suspect_frames"])
            def frame(p):
                cap = cv2.VideoCapture(str(p)); cap.set(cv2.CAP_PROP_POS_FRAMES, 5)
                _, f = cap.read(); cap.release(); return f
            diff = np.abs(frame(out)[30:60, 40:80].astype(int) - frame(src)[30:60, 40:80].astype(int)).mean()
            self.assertGreater(diff, 5)

    def test_seeds_to_pixels_scales_groups_and_rejects_outside(self):
        out = mosaic.seeds_to_pixels([{"frame": 5, "x": 0.5, "y": 0.25}, {"frame": 5, "x": 1.0, "y": 0.0},
                                      {"frame": 0, "x": 0.1, "y": 0.9}], 200, 100, 10)
        self.assertEqual(out, {5: [(100, 25), (199, 0)], 0: [(20, 90)]})
        with self.assertRaises(ValueError):
            mosaic.seeds_to_pixels([{"frame": 10, "x": .5, "y": .5}], 200, 100, 10)
        with self.assertRaises(ValueError):
            mosaic.seeds_to_pixels([{"frame": 1, "x": 1.2, "y": .5}], 200, 100, 10)

    def test_fill_gaps_bridges_short_holes_and_flags_them(self):
        a = np.zeros((4, 4), bool); a[0, 0] = True
        b = np.zeros((4, 4), bool); b[3, 3] = True
        masks = [None, a, None, None, b, None]
        out, flagged = mosaic.fill_gaps(masks, gap=5)
        self.assertTrue(out[2][0, 0] and out[3][3, 3])          # each takes the nearer side
        self.assertFalse(out[0].any() or out[5].any())          # before the first / after the last: left empty
        self.assertEqual(flagged, [2, 3])
        out2, flagged2 = mosaic.fill_gaps(masks, gap=1)         # hole longer than the gap is left, but flagged
        self.assertFalse(out2[2].any() or out2[3].any())
        self.assertEqual(flagged2, [2, 3])

    def test_union_tracks_runs_a_reversed_track_backwards(self):
        h, w = 256, 256
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            dots = []
            for k in range(4):
                f = np.zeros((h, w, 3), np.uint8)
                f[100 + 6 * k:120 + 6 * k, 100:120] = 255     # a square that moves down 6 px per frame
                dots.append(f)
            fwd, rev, out = tmp / "f.mp4", tmp / "r.mp4", tmp / "u.mp4"
            _write(fwd, dots[2:])        # clip frames 2, 3
            _write(rev, [dots[2], dots[1], dots[0]])   # clip frames 2, 1, 0 (reversed head)
            seed = (110, 122)
            stats = mosaic.union_tracks([(fwd, 2, False, seed), (rev, 2, True, seed)], 4, out, (w, h))
            self.assertEqual(stats["tracked_frames"], 4)
            got = list(mosaic._gray_frames(out))
            for k in range(4):
                self.assertTrue(got[k][110 + 6 * k, 110], f"frame {k}")

    def test_clean_track_drops_frames_where_the_mask_wanders_off(self):
        h, w = 200, 200
        def box(y0, y1, x0, x1):
            m = np.zeros((h, w), bool); m[y0:y1, x0:x1] = True; return m
        good = box(100, 110, 100, 110)
        huge = box(0, 150, 0, 200)                          # re-acquired the whole body
        far = good | box(10, 20, 10, 20)                    # the part plus a blob far away
        out = mosaic.clean_track([good, good, huge, far, good, np.zeros((h, w), bool), good], (105, 105))
        self.assertTrue(out[0] is not None and out[1] is not None and out[4] is not None)
        self.assertIsNone(out[2])                            # area far above the median
        self.assertIsNone(out[5])                            # empty stays lost
        self.assertEqual(int(out[3].sum()), 100)             # the far blob is cut, the part kept
        self.assertFalse(out[3][10:20, 10:20].any())


if __name__ == "__main__":
    unittest.main()
