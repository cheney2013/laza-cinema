"""Audio locks through build_h3_video_workflow, and what provenance reads back."""

import unittest

import provenance
from workflow_builders import build_h3_video_workflow


def _build(**kw):
    return build_h3_video_workflow(
        prompt="a quiet room", width=960, height=544, length=kw.pop("length", 175), steps=8, seed=1,
        unet_name="minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        lora_name="h3/minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors", **kw)


def _of(wf, class_type):
    return [k for k, n in wf.items() if n["class_type"] == class_type]


LOCK = dict(audio_lock_track="audiolock_abc.wav", audio_lock_ranges="2.950-3.800:1")


class AudioLockBuilderTest(unittest.TestCase):
    def test_default_path_untouched(self):
        wf = _build()
        self.assertEqual(_of(wf, "AicinemaLockAudioRanges"), [])
        self.assertEqual(wf["44"]["inputs"]["latent_image"], ["31", 1])

    def test_lock_sits_between_the_reference_latent_and_the_sampler(self):
        wf = _build(**LOCK)
        (lock,) = _of(wf, "AicinemaLockAudioRanges")
        (enc,) = _of(wf, "VAEEncodeAudio")
        self.assertEqual(wf["44"]["inputs"]["latent_image"], [lock, 0])
        i = wf[lock]["inputs"]
        self.assertEqual(i["target_latent"], ["31", 1])
        self.assertEqual(i["audio_latent"], [enc, 0])
        self.assertEqual(i["ranges"], "2.950-3.800:1")
        self.assertAlmostEqual(i["duration_seconds"], 175 / 24.0)
        self.assertEqual(wf[enc]["inputs"]["vae"], ["5", 0])                     # the H3 audio VAE
        self.assertEqual(wf[wf[enc]["inputs"]["audio"][0]]["inputs"]["audio"], "audiolock_abc.wav")

    def test_chained_clip_keeps_motion_context_and_trim(self):
        wf = _build(motion_context_latent="H3_Latent_x_00001_.safetensors", **LOCK)
        (lock,) = _of(wf, "AicinemaLockAudioRanges")
        self.assertEqual(wf["44"]["inputs"]["latent_image"], [lock, 0])
        self.assertEqual(len(_of(wf, "MiniMaxH3MotionContext")), 1)
        self.assertEqual(len(_of(wf, "MiniMaxH3MotionContextTrim")), 1)
        # the lock reads the latent the Ref2VA node made; MotionContext works on the conditioning
        self.assertEqual(wf[lock]["inputs"]["target_latent"], ["31", 1])

    def test_extension_path_locks_the_masked_context_latent(self):
        wf = _build(motion_context_video="prev.mp4", existing_context_length=39, **LOCK)
        (lock,) = _of(wf, "AicinemaLockAudioRanges")
        self.assertEqual(wf[lock]["inputs"]["target_latent"], ["81", 0])

    def test_chunked_render_is_refused(self):
        with self.assertRaisesRegex(ValueError, "chunk_frames"):
            _build(length=300, chunk_frames=124, **LOCK)

    def test_track_without_ranges_changes_nothing(self):
        self.assertEqual(_of(_build(audio_lock_track="x.wav"), "AicinemaLockAudioRanges"), [])

    def test_provenance_reads_the_lock_back(self):
        record = provenance.describe_generation(_build(**LOCK))
        self.assertEqual(record["audio_locks"]["ranges"], "2.950-3.800:1")
        self.assertEqual(record["audio_locks"]["track"], "audiolock_abc.wav")
        self.assertIsNone(provenance.describe_generation(_build())["audio_locks"])


REDO = dict(audio_redo={"mode": "polish", "steps": 4, "denoise": 0.5}, refine_latent="H3_Latent_x_00001_.safetensors")


class AudioRedoBuilderTest(unittest.TestCase):
    def test_first_pass_is_replaced_by_the_saved_latent(self):
        wf = _build(motion_context_latent="H3_Latent_prev_00001_.safetensors", **REDO)
        samp = wf["ar:samp"]["inputs"]
        self.assertEqual(wf["ar:load"]["inputs"]["latent_path"], "H3_Latent_x_00001_.safetensors")
        self.assertEqual(wf["ar:pack"]["inputs"]["latent"], ["ar:load", 0])
        self.assertEqual(wf["ar:mask"]["inputs"]["latent"], ["ar:pack", 0])
        self.assertEqual(samp["latent_image"], ["ar:mask", 0])
        self.assertEqual(wf["ar:sched"]["inputs"]["steps"], 4)
        self.assertEqual(wf["ar:sched"]["inputs"]["denoise"], 0.5)
        # decode, and the latent saved for the next clip, come from the refined latent
        self.assertEqual(wf["50"]["inputs"]["samples"], ["ar:samp", 0])
        self.assertEqual(wf["51"]["inputs"]["samples"], ["ar:samp", 0])
        self.assertEqual(wf["62"]["inputs"]["latent"], ["ar:samp", 0])
        # the chained clip still trims its overlap, and its conditioning is the motion-context one
        self.assertEqual(len(_of(wf, "MiniMaxH3MotionContextTrim")), 1)
        self.assertEqual(wf["ar:guider"]["inputs"]["conditioning"], wf["41"]["inputs"]["conditioning"])

    def test_seed_is_the_graphs_seed(self):
        wf = _build(**REDO)
        self.assertEqual(wf["ar:noise"]["inputs"]["noise_seed"], 1)

    def test_locked_lines_stay_locked_in_the_refine_pass(self):
        wf = _build(**LOCK, **REDO)
        lock = wf["ar:lock"]["inputs"]
        self.assertEqual(lock["target_latent"], ["ar:mask", 0])
        self.assertEqual(lock["audio_latent"], ["aclock:enc", 0])
        self.assertEqual(lock["ranges"], "2.950-3.800:1")
        self.assertEqual(wf["ar:samp"]["inputs"]["latent_image"], ["ar:lock", 0])

    def test_an_ordinary_render_is_untouched(self):
        wf = _build()
        self.assertEqual(_of(wf, "H3AudioRefineMask"), [])
        self.assertNotIn("ar:samp", wf)

    def test_chunked_render_is_refused(self):
        with self.assertRaisesRegex(ValueError, "chunk_frames"):
            _build(length=300, chunk_frames=124, **REDO)

    def test_provenance_reads_the_redo_back(self):
        record = provenance.describe_generation(_build(**REDO))
        self.assertEqual(record["audio_redo"], {"source_latent": "H3_Latent_x_00001_.safetensors",
                                                "steps": 4, "denoise": 0.5})
        self.assertIsNone(provenance.describe_generation(_build())["audio_redo"])


if __name__ == "__main__":
    unittest.main()
