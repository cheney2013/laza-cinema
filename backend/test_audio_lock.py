"""audio_lock: range planning, refusals, the <d> duplicate check, track building."""
import array
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path

import audio_lock as al


def _spec(at=3.0, dur=1.0, strength=1.0, text="", name="line.wav"):
    return al.LockSpec(path=Path(name), at=at, strength=strength, text=text, duration=dur)


class PlanTest(unittest.TestCase):
    def test_unchained_clip_has_no_offset(self):
        p = al.plan_locks([_spec(at=3.0, dur=0.75)], length_frames=175, context=0)
        self.assertEqual(p.offset, 0.0)
        self.assertEqual(p.ranges, "2.950-3.800:1")

    def test_chained_clip_adds_the_overlap(self):
        # 22 frames = 0.9167 s; the measured offset was 0.94 s
        p = al.plan_locks([_spec(at=5.0, dur=0.75)], length_frames=175, context=22)
        self.assertEqual(p.ranges, "5.867-6.717:1")

    def test_several_locks_one_range_each_with_strength(self):
        p = al.plan_locks([_spec(at=1.0, dur=5.0, strength=0.5), _spec(at=3.0, dur=1.0)],
                          length_frames=175, context=0)
        self.assertEqual(p.ranges, "0.950-6.050:0.5;2.950-4.050:1")

    def test_chained_clip_refuses_a_lock_in_the_pinned_head(self):
        with self.assertRaisesRegex(al.AudioLockError, "previous clip's sound is pinned"):
            al.plan_locks([_spec(at=0.2)], length_frames=175, context=22)
        al.plan_locks([_spec(at=0.2)], length_frames=175, context=0)   # fine when not chained

    def test_refuses_a_lock_past_the_end_of_the_delivered_clip(self):
        # 175 frames with 22 overlap delivers 6.375 s
        with self.assertRaisesRegex(al.AudioLockError, "delivered clip is 6.38s"):
            al.plan_locks([_spec(at=5.8, dur=1.0)], length_frames=175, context=22)

    def test_refuses_bad_strength_and_empty(self):
        with self.assertRaises(al.AudioLockError):
            al.plan_locks([_spec(strength=1.5)], length_frames=175, context=0)
        with self.assertRaises(al.AudioLockError):
            al.plan_locks([], length_frames=175, context=0)

    def test_context_frames_follows_the_trim_the_builder_applies(self):
        self.assertEqual(al.context_frames(), 0)
        self.assertEqual(al.context_frames(motion_context_latent="x.safetensors"), 22)
        self.assertEqual(al.context_frames(motion_context_video="v.mp4", motion_context_length=39), 39)
        self.assertEqual(al.context_frames(motion_context_video="v.mp4", existing_context_length=90), 90)


class PartialLockTest(unittest.TestCase):
    def test_a_whole_render_as_ambience_locked_from_after_the_pinned_head(self):
        # An earlier render of the shot (6.375 s delivered) placed at 0 and locked
        # from 0.4 s at half strength, under a line locked on top of it.
        bed = _spec(at=0.0, dur=6.375, strength=0.5, name="pass1.mp4")
        bed.lock_from = 0.4
        p = al.plan_locks([bed, _spec(at=5.0, dur=0.75)], length_frames=175, context=22)
        # 22 frames = 0.9167 s: the bed from 1.317 s, no margin where from/to are given
        # (to is open so the end gets the margin, clamped to the clip's 7.292 s)
        self.assertEqual(p.ranges, "1.317-7.292:0.5;5.867-6.717:1")

    def test_strength_zero_entry_is_mixed_but_locks_nothing_and_may_start_at_zero(self):
        bed = _spec(at=0.0, dur=6.0, strength=0.0, name="pass1.mp4")
        p = al.plan_locks([bed], length_frames=175, context=22)
        self.assertTrue(p.ranges.endswith(":0"))

    def test_from_and_to_give_a_range_without_margin(self):
        bed = _spec(at=0.0, dur=6.0, strength=1.0, name="pass1.mp4")
        bed.lock_from, bed.lock_to = 4.8, 6.4        # to is past the recording: it ends at 6.0
        p = al.plan_locks([bed], length_frames=175, context=22)
        self.assertEqual(p.ranges, "5.717-6.917:1")

    def test_lock_window_outside_the_recording_is_refused(self):
        s = _spec(at=1.0, dur=1.0)
        s.lock_from, s.lock_to = 3.0, 4.0
        with self.assertRaisesRegex(al.AudioLockError, "nothing of the recording"):
            al.plan_locks([s], length_frames=175, context=0)


class PromptCheckTest(unittest.TestCase):
    def test_locked_line_written_as_d_is_caught(self):
        prompt = ("Sarah says: <d>[English] Yeah.</d> and Joel: "
                  "<d>[English]We have got to get out of here.</d>")
        self.assertEqual(al.locked_lines_in_prompt(prompt, [_spec(text="Yeah.")]), ["Yeah."])
        self.assertEqual(al.locked_lines_in_prompt(prompt, [_spec(text="Holy shit")]), [])
        self.assertEqual(al.locked_lines_in_prompt(prompt, [_spec(text="")]), [])   # a bed has no words


class TrackTest(unittest.TestCase):
    def test_build_track_places_the_line_and_names_by_content(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            src = d / "tone.wav"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                            "sine=f=440:d=0.5:r=48000", "-ac", "2", str(src)], check=True)
            plan = al.plan_locks([al.LockSpec(path=src, at=1.0, duration=0.5)],
                                 length_frames=72, context=0)
            name = al.build_track(plan, d)
            self.assertTrue(name.startswith("audiolock_") and name.endswith(".wav"))
            with wave.open(str(d / name)) as w:
                self.assertLess(abs(w.getnframes() / w.getframerate() - 3.0), 0.05)
                raw = w.readframes(w.getnframes())
            a = array.array("h", raw)
            loud = [i // 2 / 48000 for i, v in enumerate(a) if abs(v) > 2000]
            self.assertTrue(loud)
            self.assertLess(abs(loud[0] - 1.0), 0.02)              # starts where it was placed
            self.assertEqual(al.build_track(plan, d), name)         # same audio, same name


if __name__ == "__main__":
    unittest.main()
