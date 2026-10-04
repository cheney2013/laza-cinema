"""Peak and loudness per bucket for the cut room's waveform."""
import subprocess
import tempfile
import unittest
from pathlib import Path

import main


def _tone(path: Path, level: float, seconds: float = 4.0) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
         "-af", f"volume={level * 8}", "-ar", "8000", str(path)], check=True)


class AudioLevelTests(unittest.TestCase):
    def test_sine_loudness_is_peak_over_root_two(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "tone.wav"
            _tone(path, 0.5)
            peaks, rms = main._build_levels(path, 4.0)
        self.assertEqual(len(peaks), len(rms))
        mid = len(peaks) // 2
        self.assertAlmostEqual(peaks[mid], 0.5 * 0.9999, delta=0.06)
        # A full-scale sine's RMS is 1/sqrt(2) of its peak.
        self.assertAlmostEqual(rms[mid] / peaks[mid], 0.7071, delta=0.06)

    def test_a_quiet_stretch_reads_quiet_in_both(self):
        with tempfile.TemporaryDirectory() as tmp:
            loud, quiet, joined = Path(tmp) / "l.wav", Path(tmp) / "q.wav", Path(tmp) / "j.wav"
            _tone(loud, 0.8, 2.0)
            _tone(quiet, 0.05, 2.0)
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(loud), "-i", str(quiet),
                            "-filter_complex", "[0][1]concat=n=2:v=0:a=1", str(joined)], check=True)
            peaks, rms = main._build_levels(joined, 4.0)
        first, second = len(rms) // 4, 3 * len(rms) // 4
        self.assertGreater(rms[first], 8 * rms[second])
        self.assertGreater(peaks[first], 8 * peaks[second])

    def test_peaks_keep_the_old_recipe(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "tone.wav"
            _tone(path, 0.3)
            self.assertEqual(main._build_peaks(path, 4.0), main._build_levels(path, 4.0)[0])


if __name__ == "__main__":
    unittest.main()
