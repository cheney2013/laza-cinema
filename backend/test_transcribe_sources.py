import asyncio
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import main
import transcribe_worker as tw


class ProbeWavTest(unittest.TestCase):
    def test_wav_without_start_time_has_audio(self):
        # A wav reports no start_time; it used to be read as silent, so every
        # wav clip dropped out of the export and transcription mix.
        with tempfile.TemporaryDirectory() as d:
            wav = Path(d) / "tone.wav"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=d=0.5",
                            str(wav)], check=True)
            self.assertTrue(main._probe_has_audio(wav)["has_audio"])


H3_GRAPH = {
    "200": {"class_type": "LoadAudio", "inputs": {"audio": "voice.wav"}},
    "31": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
        "prompt": "<Audio 1>: fully_copy - the soundtrack is exactly <Audio 1> from 00:00.000",
        "ref_audios.ref_audio_0": ["200", 0]}},
}


class ReferenceVoiceTest(unittest.IsolatedAsyncioTestCase):
    async def swap(self, graph):
        req = main.TimelineExportRequest(tracks=[main.ExportTrack(kind="video", clips=[
            main.ExportClip(url="/uploads/clip.mp4", start=24, duration=48, src_in_s=1, src_out_s=3)])])
        with mock.patch.object(main, "resolve_upload", mock.AsyncMock(return_value=Path("x"))), \
                mock.patch.object(main.provenance, "read_embedded_graph", return_value=graph):
            return await main._with_reference_voices(req)

    async def test_fully_copied_voice_replaces_the_render(self):
        out = await self.swap(H3_GRAPH)
        self.assertTrue(out.tracks[0].clips[0].muted)
        voice = out.tracks[1].clips[0]
        self.assertEqual((out.tracks[1].kind, voice.url, voice.start, voice.src_in_s),
                         ("audio", "voice.wav", 24, 1))

    async def test_chained_segment_keeps_its_own_sound(self):
        graph = {**H3_GRAPH, "7": {"class_type": "MiniMaxH3MotionContextLoadLatent", "inputs": {}}}
        out = await self.swap(graph)
        self.assertEqual(len(out.tracks), 1)
        self.assertFalse(out.tracks[0].clips[0].muted)


class HallucinationTest(unittest.TestCase):
    def test_credit_lines_and_prompt_echo(self):
        for text in ("请不吝点赞订阅转发打赏支持明镜与点点栏目", "使用简体中文和标点符号。",
                     "Teksting av Nicolai Winther"):
            self.assertTrue(tw.is_hallucination(text), text)
        self.assertFalse(tw.is_hallucination("我只知道一步一步往上爬"))


if __name__ == "__main__":
    unittest.main()
