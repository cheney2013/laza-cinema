import sys
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import paste_edit_region as per  # noqa: E402


def scene():
    rng = np.random.default_rng(3)
    base = rng.integers(20, 60, size=(200, 300, 3), dtype=np.uint8)
    return Image.fromarray(base)


class PasteBackTests(unittest.TestCase):
    def edited_with_text(self, source, crop):
        """The crop with a white bar added at the bottom, plus a colour drift everywhere else, returned at half size."""
        c = np.asarray(source.crop(crop)).astype(np.int16)
        c = np.clip(c + 6, 0, 255)                    # the editor's slight drift on "unchanged" pixels
        c[80:95, 20:100] = 255                          # the new text
        small = Image.fromarray(c.astype(np.uint8)).resize((c.shape[1] // 2, c.shape[0] // 2), Image.LANCZOS)
        return small

    def test_pastes_only_the_new_text_and_leaves_everything_else_exact(self):
        source = scene()
        crop = (50, 10, 250, 120)
        edited = self.edited_with_text(source, crop)
        result, report = per.paste_back(source, edited, crop, search=(0, 60, 200, 110), threshold=40, pad=3, feather=1.5)
        self.assertEqual(report["pixels_changed_outside_box"], 0)
        arr, orig = np.asarray(result), np.asarray(source)
        # the bar is in, the drifted background elsewhere in the crop is not
        self.assertGreater(int(arr[10 + 87, 50 + 60].mean()), 200)
        self.assertTrue((arr[10:50, 50:250] == orig[10:50, 50:250]).all())
        self.assertTrue((arr[:, :50] == orig[:, :50]).all())
        self.assertLess(report["share_of_image_replaced"], 0.1)

    def test_search_area_keeps_a_change_elsewhere_out(self):
        source = scene()
        crop = (0, 0, 300, 200)
        c = np.asarray(source).copy()
        c[10:40, 10:60] = 255                       # a change outside the search area
        c[150:170, 100:200] = 255                   # the wanted one
        result, report = per.paste_back(source, Image.fromarray(c), crop, search=(0, 140, 300, 200), pad=2, feather=1.0)
        arr = np.asarray(result)
        self.assertGreater(int(arr[160, 150].mean()), 200)
        self.assertTrue((arr[10:40, 10:60] == np.asarray(source)[10:40, 10:60]).all())

    def test_shift_moves_the_new_text_and_leaves_the_old_place_as_the_original(self):
        source = scene()
        crop = (0, 0, 300, 200)
        c = np.asarray(source).copy()
        c[100:115, 50:150] = 255                    # new text as the editor drew it
        result, report = per.paste_back(source, Image.fromarray(c), crop, search=(0, 90, 300, 130),
                                        pad=2, feather=1.0, shift=(0, 20))
        arr, orig = np.asarray(result), np.asarray(source)
        self.assertGreater(int(arr[130, 100].mean()), 200)             # at its new place
        self.assertTrue((arr[100:112, 60:140] == orig[100:112, 60:140]).all())   # the old place is the original
        self.assertEqual(report["pixels_changed_outside_box"], 0)

    def test_refuses_when_nothing_changed_and_when_the_crop_is_outside(self):
        source = scene()
        with self.assertRaises(ValueError):
            per.paste_back(source, source.crop((0, 0, 100, 100)), (0, 0, 100, 100))
        with self.assertRaises(ValueError):
            per.paste_back(source, source, (0, 0, 999, 100))


if __name__ == "__main__":
    unittest.main()
