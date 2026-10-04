"""Tests for check_h3_prompt.py.

    python tools/test_check_h3_prompt.py

One prompt that should pass clean, and one that trips every production rule the
checker knows, so a rule that stops firing is noticed. Assertions match on the
stable part of each message (the rule name), not on the wording.
"""

from __future__ import annotations

import json
import sys
import tempfile
import re
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_h3_prompt as chk  # noqa: E402

GOOD = """subject_definitions:
<Picture 1> is a single storyboard sheet carrying two grey-box panels. The left panel is [Shot 1], the right panel is [Shot 2]. Each shot of the target video is a single photographic image filling the whole frame.
<Subject 1> is the woman. Her face, dark hair tied back and rust-red knitted cardigan come from <Picture 2>.
<Subject 2> is the study. Its sage green walls, off-white wainscoting and knotty pine desk come from <Picture 3>.

summary:
[reference generation] A scene at a desk in <Subject 2>, with <Subject 1> beside it. <Picture 1> gives the two camera setups; each shot is described in its own [Shot] block.

retention_analysis:
<Picture 1> (storyboard for [Shot 1] and [Shot 2]): fully_preserved - each shot takes camera position, framing and performer placement from its panel, and the set as drawn.
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - her face, hair and cardigan match <Picture 2>.
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - wall colour, wainscoting and desk timber match <Picture 3>.

detailed_description:
The target video is live-action and cinematic on a rainy late afternoon, with a desaturated palette and fine film grain.
[Shot 1] The shot takes its framing from the left panel of <Picture 1>, a static medium shot. <Subject 1> stands at the knotty pine desk on the left-hand side of the frame, looking down at the desk top, where the brass task lamp is switched on and throws a steady warm pool of electric light across bare pine timber. <Subject 1> (S1) says quietly: <d>[English] This came in the post.</d> She closes her lips. The camera holds a static shot.
[Shot 2] At 00:03.500, the shot cuts to the right panel of <Picture 1>, a static overhead insert of the desk. The unfolded white letter lies flat on the bare timber; across its top one line of bold black capitals reads "ACCEPTANCE OF RESIGNATION". The camera pushes in with small amplitude at slow speed toward the letterhead, so the heading fills more of the frame.

overall_soundscape: Steady rain taps on the window glass, clearly audible throughout. Paper settles onto timber with a crisp rustle.

non_diegetic_music: N/A
"""

BAD = """subject_definitions:
<Picture 1> is a character turnaround sheet of the woman on grey. It defines only her appearance.
<Picture 3> is the storyboard for [Shot 1], defining its camera position.
<Video 1> gives the camera position, framing and blocking of the whole take.
<Subject 1> is the woman.
<Subject 2> is the man.

summary:
The target video shows <Subject 1> in the study.

retention_analysis:
<Picture 1> (character): transferred - her look.
<Picture 3> ([Shot 1] anchor): fully_preserved - camera.
<Video 1> (camera and blocking): fully_preserved - the shot follows its camera and blocking.
<Subject 1> (appears in [Shot 1]): fully_preserved - <Subject 1> (S1) is kept.
<Subject 4> (appears in [Shot 1]): fully_preserved - who.

detailed_description:
[Shot 1] At 00:00.000, the camera moves through the study. There is no window on this wall and the doorway remains empty. <Subject 1> sits with the notebook on her right-hand side of the desk. The brass lamp burns on the desk. The white door stands by the door frame near the doorway of the door. The woman says <d>"Hello there"</d> and the notebook page is covered in handwritten lines. The camera pushes in and pans left across the room. Her rust-red cardigan is buttoned; her pale cardigan sleeve rests on the desk.
[Shot 3] the shot cuts to the man, who finishes closing the notebook and stops. A line reads "This is a very long line of on-screen text that is far too long to render legibly at all". The camera holds a static shot.
[Shot 4] At 00:03.000, a close-up of <Subject 9>.

overall_soundscape: Quiet room tone and a faint soft hum. The woman (S1) says <d>[English] hi</d>. Rain. Wind. Steps. Creak.

non_diegetic_music: A sad, tense piano melody.
"""


def run(text: str, **kw) -> chk.Report:
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "p.txt"
        p.write_text(text, encoding="utf-8")
        return chk.check(p, **kw)


def joined(items: list[str]) -> str:
    return "\n".join(items)


class Good(unittest.TestCase):
    def test_passes_clean(self):
        r = run(GOOD, frames=124, film=True)
        self.assertEqual(r.errors, [], joined(r.errors))
        # the only expected warnings: none
        self.assertEqual(r.warnings, [], joined(r.warnings))
        self.assertEqual(r.stats["shots"], 2)
        self.assertEqual(r.stats["pictures"], 3)
        self.assertEqual(r.stats["dialogue_lines"], 1)
        self.assertEqual(r.stats["text_chars"], [25])

    def test_baseline_growth_fails(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d) / "base.txt"
            base.write_text(GOOD.replace("with a desaturated palette and fine film grain", ""),
                            encoding="utf-8")
            r = run(GOOD, baseline=base)
        self.assertTrue(any("基线" in e for e in r.errors), joined(r.errors))

    def test_whitelist_both_directions(self):
        wl = {"props": ["lamp", "letter", "mug"],
              "shots": {"1": ["lamp", "mug"], "2": ["letter"]}}
        with tempfile.TemporaryDirectory() as d:
            w = Path(d) / "wl.json"
            w.write_text(json.dumps(wl), encoding="utf-8")
            r = run(GOOD, whitelist=w)
        # shot 1 names no mug though the whitelist says one is in frame -> warn
        self.assertTrue(any("`mug`" in x and "[Shot 1]" in x for x in r.warnings), joined(r.warnings))
        # nothing out-of-frame is named -> no error
        self.assertEqual(r.errors, [], joined(r.errors))
        wl["shots"]["2"] = ["mug"]  # now the letter in shot 2 is out of frame
        with tempfile.TemporaryDirectory() as d:
            w = Path(d) / "wl.json"
            w.write_text(json.dumps(wl), encoding="utf-8")
            r = run(GOOD, whitelist=w)
        self.assertTrue(any("`letter`" in e and "[Shot 2]" in e for e in r.errors), joined(r.errors))


class InShotTimecodes(unittest.TestCase):
    """Every MM:SS.mmm in the official guides sits right after [Shot N] and marks
    a cut. One anywhere else is a beat, which the spec writes in prose."""

    def lint(self, shot_text):
        # Injected mid-shot on purpose: a timecode in the head-of-block position
        # is a cut time, which Shot 1 may not have -- a different rule.
        anchor = "a static medium shot."
        assert GOOD.count(anchor) == 1
        return run(GOOD.replace(anchor, anchor + " " + shot_text))

    def test_lowercase_beat_is_caught(self):
        r = self.lint("at 00:02.000 she lifts the mug.")
        self.assertTrue(any("镜内时间码" in w and "00:02.000" in w for w in r.warnings), joined(r.warnings))

    def test_capitalised_beat_is_caught(self):
        r = self.lint("At 00:02.000, she lifts the mug.")
        self.assertTrue(any("镜内时间码" in w for w in r.warnings), joined(r.warnings))

    def test_from_and_by_forms_are_caught(self):
        r = self.lint("From 00:01.000 she waits and by 00:03.500 she is standing.")
        found = [w for w in r.warnings if "镜内时间码" in w]
        self.assertEqual(len(found), 2, joined(r.warnings))

    def test_prose_beat_is_clean(self):
        r = self.lint("She lifts the mug slowly, then waits two seconds.")
        self.assertEqual([w for w in r.warnings if "镜内时间码" in w], [])

    def test_a_real_cut_is_not_flagged(self):
        r = run(GOOD)
        self.assertEqual([w for w in r.warnings if "镜内时间码" in w], [], joined(r.warnings))


class Speakers(unittest.TestCase):
    """Speaker ids against speaking order and the <Audio N> that voices them."""

    DETAIL = ("Tommy, <Subject 2> (S1) says: <d>[English]What happened?</d> "
              "Joel, <Subject 1> (S2) says: <d>[English]Yes.</d>")

    def lint(self, defs, detail=DETAIL):
        r = chk.Report()
        chk.check_speakers(defs, detail, r)
        return r

    def test_aligned_voices_are_clean(self):
        r = self.lint("<Audio 1> is the voice-timbre reference for <Subject 2> (S1); only its timbre.\n"
                      "<Audio 2> is the voice-timbre reference for <Subject 1> (S2); only its timbre.")
        self.assertEqual((r.errors, r.warnings), ([], []))

    def test_crossed_audio_numbering_warns(self):
        r = self.lint("<Audio 1> is the voice-timbre reference for <Subject 1> (S2); only its timbre.\n"
                      "<Audio 2> is the voice-timbre reference for <Subject 2> (S1); only its timbre.")
        self.assertTrue(any("编号交叉" in w for w in r.warnings), joined(r.warnings))

    def test_audio_bound_to_the_wrong_person(self):
        r = self.lint("<Audio 1> is the voice-timbre reference for <Subject 1> (S1); only its timbre.")
        self.assertTrue(any("<Audio 1> 绑的是 <Subject 1> (S1)" in e for e in r.errors), joined(r.errors))

    def test_quoted_lines_in_timbre_reference(self):
        r = self.lint('<Audio 1> is the voice-timbre reference for <Subject 2> (S1), his line "What happened?"; '
                      "only its timbre.")
        self.assertTrue(any("写了台词原文" in w for w in r.warnings), joined(r.warnings))

    def test_ids_out_of_speaking_order(self):
        r = self.lint("", "<Subject 1> (S2) says <d>[English]a</d> <Subject 2> (S1) says <d>[English]b</d>")
        self.assertTrue(any("首次开口的先后" in e for e in r.errors), joined(r.errors))

    def test_one_id_for_two_people(self):
        r = self.lint("", "<Subject 1> (S1) says <d>[English]a</d> <Subject 2> (S1) says <d>[English]b</d>")
        self.assertTrue(any("一个说话人 ID 只对应一个人" in e for e in r.errors), joined(r.errors))


class Bad(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.r = run(BAD, frames=124, film=True)
        cls.all = joined(cls.r.errors + cls.r.warnings + cls.r.notes)

    def has_error(self, needle):
        self.assertTrue(any(needle in e for e in self.r.errors), f"no ERROR containing {needle!r}\n{self.all}")

    def has_warning(self, needle):
        self.assertTrue(any(needle in w for w in self.r.warnings), f"no WARN containing {needle!r}\n{self.all}")

    # format rules
    def test_summary_prefix(self): self.has_error("summary 必须以方括号")
    def test_marker_enum(self): self.has_error("没有合法关系标记")
    def test_speaker_in_retention(self): self.has_error("retention_analysis 里出现了说话人 ID")
    def test_undefined_in_retention(self): self.has_error("<Subject 4> 出现在 retention_analysis")
    def test_undefined_in_body(self): self.has_error("<Subject 9> 在 detailed_description 里用到")
    def test_picture_numbering(self): self.has_error("<Picture N> 编号不连续")
    def test_shot_numbering(self): self.has_error("[Shot N] 编号不连续")
    def test_shot1_timestamp(self): self.has_error("[Shot 1] 不带切点时间戳")
    def test_missing_timecode(self): self.has_error("[Shot 3] 缺绝对切点")
    def test_dialogue_quotes(self): self.has_error("<d> 内部有引号")
    def test_dialogue_language(self): self.has_error("<d> 缺语言标记")
    def test_dialogue_speaker(self): self.has_error("台词前没有说话人 ID")
    def test_dialogue_in_soundscape(self): self.has_error("不放台词")
    def test_film_music(self): self.has_error("non_diegetic_music 必须写成 `N/A`")
    def test_long_text_fails(self): self.has_error("超过 60 中段必走形")

    # production rules
    def test_standalone_character_picture(self): self.has_warning("<Picture 1> 是独立条目，却只在定义人物")
    def test_two_spatial_authorities(self): self.has_warning("都在管机位/构图")
    def test_video_without_architecture(self): self.has_warning("没把墙和布局划给它管")
    def test_negation(self): self.has_warning("否定/缺席词 `no`")
    def test_empty(self): self.has_warning("否定/缺席词 `empty`")
    def test_character_relative(self): self.has_warning("人物视角方位")
    def test_lamp_burns(self): self.has_warning("燃烧动词")
    def test_generic_camera(self): self.has_warning("`the camera moves`")
    def test_two_moves(self): self.has_warning("种运镜")
    def test_unquoted_text(self): self.has_warning("提到了可见文字")
    def test_process_open(self): self.has_warning("开头用了过程动词")
    def test_repeated_noun(self): self.has_warning("`door` 在一镜里出现")
    def test_two_colours(self): self.has_warning("`cardigan` 在正文里带了 2 种颜色")
    def test_quiet_sound(self): self.has_warning("quiet/faint/soft")
    def test_soundscape_length(self): self.has_warning("规范 1–4 句")
    def test_mood_words(self): self.has_warning("情绪形容词")
    def test_missing_style_opening(self): self.has_warning("[Shot 1] 之前没有风格开场句")
    def test_missing_cut_verb(self): self.has_warning("[Shot 4] 首句没有")


class Helpers(unittest.TestCase):
    def test_timecode(self):
        self.assertEqual(chk.parse_timecode("[Shot 2] At 01:02.500, the shot cuts"), 62.5)
        self.assertIsNone(chk.parse_timecode("[Shot 1] The shot opens"))

    def test_words_hard_fail(self):
        long = GOOD.replace("The camera holds a static shot.",
                            "The camera holds a static shot. " + "The desk is pine. " * 260)
        r = run(long, word_cap=True)
        self.assertTrue(any("超过硬上限" in e for e in r.errors))

    def test_words_hard_cap_is_a_warning_by_default(self):
        long = GOOD.replace("The camera holds a static shot.",
                            "The camera holds a static shot. " + "The desk is pine. " * 260)
        r = run(long)
        self.assertFalse(any("超过硬上限" in e for e in r.errors), joined(r.errors))
        self.assertTrue(any("超过硬上限" in w for w in r.warnings), joined(r.warnings))

    def test_empty_room_plate_has_no_word_cap(self):
        """A plate of an unoccupied room is exempt from the word caps: it has
        no people to deform, and it needs the length to describe form
        (2026-09-07, after the plates came back as cubes)."""
        long = GOOD.replace("The camera holds a static shot.",
                            "The camera holds a static shot. " + "The desk is pine. " * 260)
        plate = re.sub(r"<Subject \d+> is (?:the|a) [^\n]*\n", "", long)
        plate = re.sub(r"<d>.*?</d>", "", plate, flags=re.S)
        r = run(plate)
        self.assertFalse(any("超过硬上限" in e for e in r.errors), joined(r.errors))
        self.assertTrue(any("无人场景板" in n for n in r.notes), joined(r.notes))

    def test_word_cap_returns_once_a_subject_is_back(self):
        """The exemption is a licence for empty rooms, not a way round the rule."""
        long = GOOD.replace("The camera holds a static shot.",
                            "The camera holds a static shot. " + "The desk is pine. " * 260)
        self.assertTrue(any("超过硬上限" in e for e in run(long, word_cap=True).errors))

    def test_quoted_negation_not_flagged(self):
        t = GOOD.replace('"ACCEPTANCE OF RESIGNATION"', '"I did not say it."')
        r = run(t)
        self.assertFalse(any("否定/缺席词" in w for w in r.warnings), joined(r.warnings))


if __name__ == "__main__":
    unittest.main(verbosity=1)
