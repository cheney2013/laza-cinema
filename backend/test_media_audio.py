"""Source-film audio by file name: cut a window, transcribe a window.

The transcriber is replaced by a stub that reports one line at 0.5-1.0 s of
whatever it is handed, so the test checks that times come back in seconds of
the source file (the window's start added back), not of the cut.
"""
import subprocess
import sys
import tempfile
import time
import unittest
import wave
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import main

STUB = """import json, sys
print(json.dumps({"language": "en", "device": "cpu",
                  "segments": [{"start": 0.5, "end": 1.0, "text": "Turn here."}]}))
"""


class MediaAudioTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.uploads = root / "uploads"
        self.uploads.mkdir()
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=d=4",
                        "-f", "lavfi", "-i", "testsrc=d=4:s=320x240:r=24",
                        str(self.uploads / "film.mp4")], check=True)
        self.patches = [
            mock.patch.object(main, "UPLOAD_DIR", self.uploads),
            mock.patch.object(main, "COMFYUI_OUTPUT_DIR", None),
            mock.patch.object(main, "_BACKEND_DIR", root),
            mock.patch.object(main, "_TRANSCRIBE_PYTHON", sys.executable),
        ]
        for p in self.patches:
            p.start()
        (root / "transcribe_worker.py").write_text(STUB, encoding="utf-8")
        self.client = TestClient(main.app)

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_extract_cuts_the_window_into_uploads(self):
        res = self.client.post("/media/extract-audio",
                               json={"name": "film.mp4", "start": 1.0, "end": 2.5, "out_name": "ref_line"})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["url"], "/uploads/ref_line.wav")
        self.assertTrue((self.uploads / "ref_line.wav").exists())
        again = self.client.post("/media/extract-audio",
                                 json={"name": "film.mp4", "start": 1.0, "end": 2.5, "out_name": "ref_line"})
        self.assertEqual(again.status_code, 409)

    def test_extract_joins_segments_in_order(self):
        res = self.client.post("/media/extract-audio",
                               json={"name": "film.mp4", "segments": [[0.5, 1.0], [2.0, 3.0]],
                                     "gap": 0.25, "out_name": "ref_two_lines"})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["duration"], 1.75)
        with wave.open(str(self.uploads / "ref_two_lines.wav")) as wav:
            self.assertAlmostEqual(wav.getnframes() / wav.getframerate(), 1.75, delta=0.1)
        bad = self.client.post("/media/extract-audio",
                               json={"name": "film.mp4", "segments": [[2.0, 1.0]]})
        self.assertEqual(bad.status_code, 400)

    def test_frame_and_still(self):
        frame = self.client.get("/media/frame", params={"name": "film.mp4", "t": 1.5, "width": 160})
        self.assertEqual(frame.status_code, 200, frame.text)
        self.assertEqual(frame.headers["content-type"], "image/jpeg")
        still = self.client.post("/media/still", json={"name": "film.mp4", "t": 1.5})
        self.assertEqual(still.status_code, 200, still.text)
        self.assertTrue((self.uploads / still.json()["url"].rsplit("/", 1)[1]).exists())

    def test_paths_are_refused(self):
        res = self.client.post("/media/extract-audio",
                               json={"name": "../main.py", "start": 0, "end": 1})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.client.post("/media/extract-audio",
                                          json={"name": "nope.mp4", "start": 0, "end": 1}).status_code, 404)

    def test_transcribe_returns_times_in_the_source_file(self):
        with self.client:
            job = self.client.post("/media/transcribe",
                                   json={"name": "film.mp4", "start": 2.0, "end": 4.0}).json()
            for _ in range(100):
                state = self.client.get(f"/media/transcribe/{job['job_id']}").json()
                if state["status"] in ("completed", "failed"):
                    break
                time.sleep(0.1)
        self.assertEqual(state["status"], "completed", state)
        self.assertEqual(state["segments"][0]["start"], 2.5)
        self.assertEqual(state["segments"][0]["end"], 3.0)

    def test_asking_again_for_a_running_window_returns_the_same_job(self):
        # A client that timed out re-sends the request; that must not start a
        # second Whisper on the same window.
        (main._BACKEND_DIR / "transcribe_worker.py").write_text(
            "import time\ntime.sleep(1)\n" + STUB, encoding="utf-8")
        with self.client:
            body = {"name": "film.mp4", "start": 1.0, "end": 3.0}
            first = self.client.post("/media/transcribe", json=body).json()
            again = self.client.post("/media/transcribe", json=body).json()
            self.assertEqual(again["job_id"], first["job_id"])
            for _ in range(100):
                state = self.client.get(f"/media/transcribe/{first['job_id']}").json()
                if state["status"] in ("completed", "failed"):
                    break
                time.sleep(0.1)
        self.assertEqual(state["status"], "completed", state)


if __name__ == "__main__":
    unittest.main()
