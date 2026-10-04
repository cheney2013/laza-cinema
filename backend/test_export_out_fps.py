"""A lone shot exported at its real frame rate: the picture chain, the encoder
rate and the base all follow out_fps, while frame counts stay on the grid."""
import unittest
from pathlib import Path

import main


def _graph(speed, out_fps):
    req = main.TimelineExportRequest(
        tracks=[main.ExportTrack(kind="video", clips=[
            main.ExportClip(url="/uploads/a.mp4", duration=96, src_in_s=0.0, src_out_s=2.0,
                            speed=speed)])],
        fps=24, width=1376, height=768, duration=96, out_fps=out_fps)
    return main._build_export_graph(req, [(Path("a.mp4"), {"has_audio": False})])


class ExportOutFpsTest(unittest.TestCase):
    def test_half_speed_runs_at_twelve_frames_a_second(self):
        inputs, graph, total = _graph(0.5, 12)
        self.assertIn("r=12", inputs[3])
        self.assertIn("setpts=(PTS-STARTPTS)/0.500000,fps=12,", graph)
        self.assertEqual(total, 4.0)            # still 96 grid frames at 24

    def test_without_out_fps_the_grid_rate_is_used(self):
        inputs, graph, _ = _graph(0.5, None)
        self.assertIn("r=24", inputs[3])
        self.assertIn(",fps=24,", graph)

    def test_fractional_rate_is_written_without_trailing_zeros(self):
        _, graph, _ = _graph(0.4, 9.6)
        self.assertIn(",fps=9.6,", graph)

    def test_out_fps_is_bounded(self):
        for bad in (0, -1, 500):
            with self.assertRaises(Exception, msg=f"out_fps={bad}"):
                main.TimelineExportRequest(tracks=[], out_fps=bad)


if __name__ == "__main__":
    unittest.main()
