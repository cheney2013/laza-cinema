"""audio_redo: presets, and checking a saved latent against the node before ComfyUI loads it."""
import json
import struct
import tempfile
import unittest
from pathlib import Path

import audio_redo as ar


def _latent(path: Path, video, audio):
    """A safetensors file with just a header (the checker never reads the data)."""
    header = {"video": {"dtype": "F32", "shape": list(video), "data_offsets": [0, 0]},
              "audio": {"dtype": "F32", "shape": list(audio), "data_offsets": [0, 0]},
              "__metadata__": {"format": "h3_motion_context_av_v1"}}
    raw = json.dumps(header).encode()
    path.write_bytes(struct.pack("<Q", len(raw)) + raw)


class ResolveTest(unittest.TestCase):
    def test_presets(self):
        self.assertEqual(ar.resolve("polish"), {"steps": 4, "denoise": 0.5, "mode": "polish"})
        self.assertEqual(ar.resolve("reroll"), {"steps": 8, "denoise": 1.0, "mode": "reroll"})

    def test_overrides_and_limits(self):
        self.assertEqual(ar.resolve("polish", steps=6, denoise=0.4)["steps"], 6)
        with self.assertRaises(ar.AudioRedoError):
            ar.resolve("nonsense")
        with self.assertRaises(ar.AudioRedoError):
            ar.resolve("polish", steps=99)
        with self.assertRaises(ar.AudioRedoError):
            ar.resolve("polish", denoise=1.5)


class SourceLatentTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.f = self.dir / "H3_Latent_x_00001_.safetensors"
        # the C14b latent: 1376x768, 175 frames -> video (1,24,52,48,86), audio (1,32,2,292)
        _latent(self.f, (1, 24, 52, 48, 86), (1, 32, 2, 292))

    def test_fits_the_render_that_saved_it(self):
        ar.check_source_latent(self.f, width=1376, height=768, length_frames=175)

    def test_missing_file(self):
        with self.assertRaisesRegex(ar.AudioRedoError, "is gone"):
            ar.check_source_latent(self.dir / "nope.safetensors", width=1376, height=768, length_frames=175)

    def test_size_changed(self):
        with self.assertRaisesRegex(ar.AudioRedoError, "saved at 1376x768"):
            ar.check_source_latent(self.f, width=1248, height=832, length_frames=175)

    def test_length_changed(self):
        with self.assertRaisesRegex(ar.AudioRedoError, "length changed"):
            ar.check_source_latent(self.f, width=1376, height=768, length_frames=294)

    def test_not_a_latent(self):
        bad = self.dir / "bad.safetensors"
        bad.write_bytes(b"not a safetensors file")
        with self.assertRaises(ar.AudioRedoError):
            ar.check_source_latent(bad, width=1376, height=768, length_frames=175)


if __name__ == "__main__":
    unittest.main()
