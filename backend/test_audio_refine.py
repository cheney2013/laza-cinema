"""Audio refine: the new sound goes under the ORIGINAL picture stream, copied, cut to its length."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import main


def _mk(path: Path, seconds: float, freq: int, rate: int = 24):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc=size=160x96:rate={rate}:duration={seconds}",
                    "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}:sample_rate=48000",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)], check=True)


def _packets(path: Path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=size",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout.split()
    return out


def _audio_seconds(path: Path) -> float:
    return float(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration",
                                 "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout.strip())


class FinishTest(unittest.IsolatedAsyncioTestCase):
    async def test_picture_stream_is_copied_and_sound_is_cut_to_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            src, produced = tmp / "src.mp4", tmp / "refined.mp4"
            _mk(src, 2.0, 440)            # the clip: 48 frames
            _mk(produced, 2.5, 880)       # what ComfyUI wrote: longer (padded to the AV grid), other sound
            (tmp / "up").mkdir()

            async def resolve(_url):
                return src
            with mock.patch.object(main, "resolve_upload", resolve), \
                    mock.patch.object(main, "COMFYUI_OUTPUT_DIR", str(tmp)), mock.patch.object(main, "UPLOAD_DIR", tmp / "up"):
                req = main.AudioRefineRequest(video_url="/uploads/src.mp4", prompt="x")
                res = await main._finish_audio_refine({"id": "j1"}, req, {"filename": "refined.mp4", "subfolder": ""},
                                                      {"padded_frames": 60})
            out = tmp / "up" / "audiorefine_j1.mp4"
            self.assertEqual(res["url"], "/uploads/audiorefine_j1.mp4")
            self.assertEqual(res["source_frames"], 48)
            self.assertEqual(_packets(out), _packets(src))                      # the picture stream, byte for byte
            self.assertAlmostEqual(_audio_seconds(out), 2.0, delta=0.05)         # cut to the picture, not the 2.5 s

    async def test_collects_a_finished_render_after_a_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            src, produced = tmp / "src.mp4", tmp / "H3_Video_zz_00001_.mp4"
            _mk(src, 1.0, 440); _mk(produced, 1.5, 660)
            (tmp / "up").mkdir()

            async def resolve(_url):
                return src

            async def prompt_state(_pid):
                return "success", {"9": {"videos": [{"filename": produced.name, "subfolder": "", "type": "output"}]}}
            job = {"id": "j2", "type": "audio_refine", "prompt_id": "p1", "refine_ctx": {"frames": 24, "padded_frames": 39},
                   "request": {"video_url": "/uploads/src.mp4", "prompt": "x"}}
            with mock.patch.object(main, "resolve_upload", resolve), mock.patch.object(main.comfyui, "prompt_state", prompt_state), \
                    mock.patch.object(main, "COMFYUI_OUTPUT_DIR", str(tmp)), mock.patch.object(main, "UPLOAD_DIR", tmp / "up"):
                res = await main._collect_finished(job)
            self.assertEqual(res["url"], "/uploads/audiorefine_j2.mp4")
            self.assertEqual(res["comfy_filename"], produced.name)

    async def test_nothing_to_collect_without_a_record_or_while_running(self):
        async def running(_pid):
            return "running", {}
        job = {"id": "j3", "type": "audio_refine", "prompt_id": "p1", "request": {"video_url": "/uploads/a.mp4", "prompt": "x"}}
        with mock.patch.object(main.comfyui, "prompt_state", running):
            self.assertIsNone(await main._collect_finished({**job, "refine_ctx": {"frames": 1}}))
            self.assertIsNone(await main._collect_finished(job))     # no refine_ctx: not guessed at

    async def test_a_prompt_is_required(self):
        with self.assertRaisesRegex(ValueError, "提示词"):
            await main._run_audio_refine_job({"id": "j4"}, main.AudioRefineRequest(video_url="/uploads/a.mp4"))


if __name__ == "__main__":
    unittest.main()
