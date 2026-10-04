"""The automatic seam rule silences only the head frames it was given; a hand dissolve silences nothing."""
import unittest
from pathlib import Path

import main


def _chains(seam_mute=None, transition=None):
    a = main.ExportClip(url="/uploads/a.mp4", duration=100, src_in_s=0.0, src_out_s=4.0)
    b = main.ExportClip(url="/uploads/b.mp4", start=78, duration=60, src_in_s=0.0, src_out_s=2.5,
                        transition=transition, seam_mute=seam_mute)
    req = main.TimelineExportRequest(tracks=[main.ExportTrack(kind="video", clips=[a, b])],
                                     fps=24, width=1376, height=768, duration=138)
    src = (Path("x.mp4"), {"has_audio": True})
    graph = main._build_export_graph(req, [src, src])[1].split(";\n")
    return (next(l for l in graph if l.endswith("[a0]")), next(l for l in graph if l.endswith("[a1]")))


DISSOLVE_22 = main.ExportTransition(type="dissolve", frames=22)


class SeamMuteTest(unittest.TestCase):
    def test_whole_overlap_is_silent_then_comes_in_on_the_click_ramp(self):
        a, b = _chains(seam_mute=[0, 22], transition=DISSOLVE_22)
        self.assertIn("afade=t=in:st=0.9167:d=0.008", b)
        self.assertNotIn("afade=t=in:st=0:d=0.008", b)
        self.assertNotIn("0.9167", a)                     # the previous clip's sound is untouched

    def test_only_the_frames_after_the_hand_set_ones_are_silenced(self):
        _, b = _chains(seam_mute=[10, 22], transition=main.ExportTransition(type="dissolve", frames=10))
        self.assertIn("volume='1-clip(min((t-0.4127)/0.008,(0.9207-t)/0.008),0,1)':eval=frame", b)
        self.assertIn("afade=t=in:st=0:d=0.008", b)       # its sound still begins on the ordinary head ramp

    def test_without_the_mark_nothing_is_silenced_whatever_the_dissolve(self):
        a, b = _chains(seam_mute=None, transition=DISSOLVE_22)
        self.assertNotIn("0.9167", a + b)
        self.assertNotIn("volume=", b)
        self.assertIn("afade=t=in:st=0:d=0.008", b)

    def test_nonsense_ranges_are_ignored(self):
        for bad in ([22, 10], [5], [], [-3, 4]):
            _, b = _chains(seam_mute=bad)
            self.assertNotIn("volume=", b, bad)
            self.assertIn("afade=t=in:st=0:d=0.008", b, bad)


if __name__ == "__main__":
    unittest.main()
