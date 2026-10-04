"""Audio seam fades in the timeline export: real cuts get a short fade, a split
of one continuous take does not."""
from pathlib import Path

from main import _build_export_graph, TimelineExportRequest


def _audio_chains(clips):
    req = TimelineExportRequest(fps=24, width=640, height=360, duration=96,
                                tracks=[{"kind": "video", "clips": clips}])
    graph = _build_export_graph(req, [(Path("x.mp4"), {"has_audio": True})] * len(clips))[1]
    return [line for line in graph.split(";\n") if ":a]" in line.split("]")[0] + "]"]


def test_split_take_has_no_seam_fade_but_cut_does():
    a, b, c = _audio_chains([
        {"url": "a.mp4", "start": 0, "duration": 24, "src_in_s": 0, "src_out_s": 1},
        {"url": "a.mp4", "start": 24, "duration": 24, "src_in_s": 1, "src_out_s": 2},
        {"url": "b.mp4", "start": 48, "duration": 48, "src_in_s": 0, "src_out_s": 2},
    ])
    assert "afade=t=out" not in a            # continues into its other half
    assert "afade=t=in" not in b
    assert "afade=t=out" in b                # cut to another file
    assert "afade=t=in" in c and "afade=t=out" in c
