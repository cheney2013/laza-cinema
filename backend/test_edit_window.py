import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

from edit_window import (cut_padded_piece, cut_tail, h3_length_at_least, last_cut_frame, plan_edit_window,
                         plan_tail, seam_differences, splice_edit)


class PlanTest(unittest.TestCase):
    def test_lengths_are_on_the_h3_grid(self):
        self.assertEqual(h3_length_at_least(1), 22)
        self.assertEqual(h3_length_at_least(22), 22)
        self.assertEqual(h3_length_at_least(23), 39)
        self.assertEqual(h3_length_at_least(65), 73)

    def test_window_is_centred_in_the_piece(self):
        p = plan_edit_window(204, 53, 65)
        self.assertEqual((p.clip_length, p.clip_start, p.offset), (73, 49, 4))
        self.assertEqual(p.clip_start + p.offset, 53)

    def test_piece_is_pushed_inside_the_source_at_either_end(self):
        head = plan_edit_window(204, 0, 30)
        self.assertEqual((head.clip_start, head.offset), (0, 0))
        tail = plan_edit_window(204, 190, 14)
        self.assertEqual(tail.clip_start + tail.clip_length, 204)
        self.assertEqual(tail.clip_start + tail.offset, 190)

    def test_rejects_windows_that_do_not_fit(self):
        with self.assertRaises(ValueError):
            plan_edit_window(100, 90, 20)
        with self.assertRaises(ValueError):
            plan_edit_window(30, 0, 25)
        with self.assertRaises(ValueError):
            plan_edit_window(100, 10, 0)


def _solid_clip(path: Path, frames: int, value: int, size="64x36", audio=False):
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
           f"color=c=0x{value:02x}{value:02x}{value:02x}:s={size}:r=24:d={frames / 24}"]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={frames / 24}", "-shortest"]
    cmd += ["-frames:v", str(frames), "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "0", str(path)]
    subprocess.run(cmd, check=True, capture_output=True)


def _luma(path: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vf", "format=gray",
                          "-f", "rawvideo", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, 36, 64).mean(axis=(1, 2))


class PieceTest(unittest.TestCase):
    def test_piece_holds_the_window_edges_instead_of_neighbouring_footage(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            a, b, c, src, piece = (d / n for n in ("a.mp4", "b.mp4", "c.mp4", "src.mp4", "piece.mp4"))
            _solid_clip(a, 20, 30)
            _solid_clip(b, 15, 200)
            _solid_clip(c, 25, 90)
            listing = d / "list.txt"
            listing.write_text("".join(f"file '{p.as_posix()}'\n" for p in (a, b, c)))
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                            "-i", str(listing), "-c", "copy", str(src)], check=True, capture_output=True)
            plan = plan_edit_window(60, 20, 15)
            cut_padded_piece(src, plan, piece)
            y = _luma(piece)
            self.assertEqual(len(y), plan.clip_length)
            self.assertTrue(np.all(y > 160), "every frame of the piece comes from the window")


class SpliceTest(unittest.TestCase):
    def test_only_the_window_comes_from_the_edit(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            src, edit, out = d / "src.mp4", d / "edit.mp4", d / "out.mp4"
            _solid_clip(src, 60, 40, audio=True)
            plan = plan_edit_window(60, 20, 10)
            _solid_clip(edit, plan.clip_length, 200, size="128x72")
            splice_edit(src, edit, plan, out)
            y = _luma(out)
            self.assertEqual(len(y), 60)
            self.assertTrue(np.all(y[:20] < 80) and np.all(y[30:] < 80))
            self.assertTrue(np.all(y[20:30] > 160))
            probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a",
                                    "-show_entries", "stream=index", "-of", "csv=p=0", str(out)],
                                   capture_output=True, text=True).stdout.strip()
            self.assertTrue(probe)
            seams = seam_differences(out, plan)
            self.assertGreater(seams["head"], 100)
            self.assertGreater(seams["tail"], 100)

    def test_window_at_the_clip_end(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            src, edit, out = d / "src.mp4", d / "edit.mp4", d / "out.mp4"
            _solid_clip(src, 60, 40)
            plan = plan_edit_window(60, 45, 15)
            _solid_clip(edit, plan.clip_length, 200)
            splice_edit(src, edit, plan, out)
            y = _luma(out)
            self.assertEqual(len(y), 60)
            self.assertTrue(np.all(y[45:] > 160) and np.all(y[:45] < 80))
            self.assertIsNone(seam_differences(out, plan)["tail"])


class TailTest(unittest.TestCase):
    def test_plan_tail(self):
        self.assertEqual(plan_tail(300, 200), 200)                  # from the last cut
        self.assertEqual(plan_tail(300, 290), 300 - 48)             # at least 2 s
        self.assertEqual(plan_tail(600, 0), 600 - 360)              # at most 15 s
        self.assertEqual(plan_tail(300, 200, tail_frames=72), 228)  # fixed seconds win
        with self.assertRaises(ValueError):
            plan_tail(30, 0)

    def test_last_cut_and_tail(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            a, b, lst, src, tail = d / "a.mp4", d / "b.mp4", d / "l.txt", d / "s.mp4", d / "t.mp4"
            _solid_clip(a, 60, 30, audio=True)
            _solid_clip(b, 72, 220, audio=True)
            lst.write_text("file '%s'" % a.as_posix() + chr(10) + "file '%s'" % b.as_posix() + chr(10))
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                            "-i", str(lst), "-c:v", "libx264", "-c:a", "aac", str(src)], check=True)
            cut = last_cut_frame(src)
            self.assertLessEqual(abs(cut - 60), 1)
            cut_tail(src, cut, tail)
            y = _luma(tail)
            self.assertLessEqual(abs(len(y) - 72), 1)
            self.assertTrue(np.all(y > 160))


if __name__ == "__main__":
    unittest.main()
