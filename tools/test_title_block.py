import sys
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import title_block as tb  # noqa: E402


def logo():
    arr = np.zeros((300, 150, 4), np.uint8)
    arr[..., :3] = 250
    arr[:, :, 3] = 255                               # an opaque tall logo, 1:2
    return Image.fromarray(arr, "RGBA")


class BlockTests(unittest.TestCase):
    def test_block_has_equal_margins_and_a_gap_that_is_what_is_left(self):
        block, layout = tb.build_block(logo(), "FILM 1【中字】", height=1000, margin=60, content_width=300, distress=0)
        self.assertEqual(block.size, (420, 1000))
        a = np.asarray(block)[..., 3]
        ys, xs = np.where(a > 8)
        self.assertEqual(int(xs.min()), 60)              # left margin
        self.assertEqual(int(xs.max()) + 1, 360)         # right margin: 420 - 60
        self.assertEqual(int(ys.min()), 60)              # top margin (the logo's top)
        self.assertEqual(int(ys.max()) + 1, 940)         # bottom margin: the line's ink ends on it
        self.assertEqual(layout["logo_box"], (60, 60, 360, 660))
        self.assertEqual(layout["gap"], layout["line_box"][1] - 660)

    def test_changing_only_the_line_changes_only_the_bottom(self):
        a, _ = tb.build_block(logo(), "FILM 1【中字】", height=1000, margin=60, content_width=300, distress=0)
        b, _ = tb.build_block(logo(), "FILM 2【中字】", height=1000, margin=60, content_width=300, distress=0)
        aa, bb = np.asarray(a), np.asarray(b)
        self.assertTrue((aa[:700] == bb[:700]).all())    # the logo and its gap are the same
        self.assertFalse((aa[700:] == bb[700:]).all())

    def test_refuses_a_line_that_does_not_fit_under_the_logo(self):
        with self.assertRaises(ValueError):
            tb.build_block(logo(), "FILM 1【中字】", height=700, margin=60, content_width=300, min_gap=32)

    def test_place_left_and_right_keep_the_same_spacing(self):
        block, _ = tb.build_block(logo(), "", height=500, margin=40, content_width=100)
        plate = Image.new("RGB", (900, 500), (30, 10, 5))
        left = np.asarray(tb.place_block(plate, block, "left"))
        right = np.asarray(tb.place_block(plate, block, "right"))
        self.assertGreater(int(left[100, 40:140].mean()), 200)            # logo ink at x 40..140
        self.assertTrue((left[:, 200:] == np.asarray(plate)[:, 200:]).all())
        self.assertGreater(int(right[100, 900 - 140:900 - 40].mean()), 200)   # mirrored margins on the right
        self.assertTrue((right[:, :600] == np.asarray(plate)[:, :600]).all())

    def test_latin_and_cjk_runs_are_centred_on_the_same_line(self):
        line = tb.render_line("FILM 1【中字】", 640)
        a = np.asarray(line)[..., 3] > 8

        def centre(cols):
            ys = np.where(a[:, cols[0]:cols[1]].any(axis=1))[0]
            return (ys.min() + ys.max()) / 2
        self.assertAlmostEqual(centre((0, 200)), centre((450, 640)), delta=3)     # Latin vs CJK

    def test_a_wider_line_is_a_taller_line_and_widens_the_block(self):
        narrow, ln = tb.build_block(logo(), "FILM 1【中字】", height=1200, margin=60, content_width=300, distress=0)
        wide, lw = tb.build_block(logo(), "FILM 1【中字】", height=1200, margin=60, content_width=300, line_width=420, distress=0)
        self.assertEqual(narrow.width, 420)
        self.assertEqual(wide.width, 540)
        self.assertGreater(lw["line_box"][3] - lw["line_box"][1], ln["line_box"][3] - ln["line_box"][1])

    def test_runs_split_latin_from_cjk(self):
        self.assertEqual(tb._runs("FILM 1【中字】"), [("FILM 1", False), ("【中字】", True)])


if __name__ == "__main__":
    unittest.main()
