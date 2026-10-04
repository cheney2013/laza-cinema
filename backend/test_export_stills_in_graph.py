"""Subtitle pictures as source filters in the graph (stills_in_graph) draw the same film as pictures
passed as command-line inputs; they exist so hundreds of subtitles do not pass Windows' 32767-character
command line (WinError 206)."""
import hashlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import main

FFMPEG = shutil.which("ffmpeg")


def _frames_md5(graph_inputs, graph, total, out: Path, tmp: Path) -> str:
    script = tmp / "g.filter"
    script.write_text(graph, encoding="utf-8")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", *graph_inputs, "-filter_complex_script", str(script),
         "-map", "[vout]", "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", str(out),
         "-map", "[aout]", "-f", "null", "-"], check=True)
    return hashlib.md5(out.read_bytes()).hexdigest()


@unittest.skipUnless(FFMPEG, "ffmpeg is not installed")
class StillsInGraphTest(unittest.TestCase):
    def test_same_pictures_both_ways(self):
        with tempfile.TemporaryDirectory() as tmp_name:
            tmp = Path(tmp_name)
            video = tmp / "base.mp4"
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                            "testsrc=s=320x180:r=24:d=3", "-pix_fmt", "yuv420p", str(video)], check=True)
            png = tmp / "sub.png"
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                            "color=c=red@0.6:s=320x180,format=rgba,drawbox=x=40:y=120:w=240:h=30:color=white@1:t=fill",
                            "-frames:v", "1", str(png)], check=True)
            req = main.TimelineExportRequest(
                tracks=[
                    main.ExportTrack(kind="video", clips=[
                        main.ExportClip(url="/uploads/base.mp4", duration=72, src_in_s=0.0, src_out_s=3.0)]),
                    main.ExportTrack(kind="video", clips=[
                        main.ExportClip(url="/uploads/sub.png", kind="image", start=12, duration=24, alpha=True),
                        main.ExportClip(url="/uploads/sub.png", kind="image", start=40, duration=20, alpha=True)]),
                ],
                fps=24, width=320, height=180, duration=72)
            sources = [(video, {"has_audio": False}), (png, {}), (png, {})]
            plain = main._build_export_graph(req, sources)
            moved = main._build_export_graph(req, sources, stills_in_graph=True)
            self.assertEqual(plain[2], moved[2])
            self.assertLess(sum(len(a) for a in moved[0]), sum(len(a) for a in plain[0]))
            self.assertNotIn("-loop", moved[0])
            self.assertEqual(
                _frames_md5(plain[0], plain[1], plain[2], tmp / "a.raw", tmp),
                _frames_md5(moved[0], moved[1], moved[2], tmp / "b.raw", tmp))


if __name__ == "__main__":
    unittest.main()
