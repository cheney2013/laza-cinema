import unittest

import video_cleanup as vc

SECTIONS = ("subject_definitions:", "summary:", "retention_analysis:",
            "detailed_description:", "overall_soundscape:", "non_diegetic_music:")


class BuildCleanupPromptTest(unittest.TestCase):
    def test_needs_a_flag(self):
        with self.assertRaises(ValueError):
            vc.build_cleanup_prompt(False, False)

    def test_six_sections_in_order(self):
        for flags in ((True, False), (False, True), (True, True)):
            p = vc.build_cleanup_prompt(*flags)
            positions = [p.index(s) for s in SECTIONS]
            self.assertEqual(positions, sorted(positions))
            self.assertIn("partially_preserved", p)
            self.assertIn("The sound of <Video 1>, unchanged.", p)
            self.assertIn("non_diegetic_music: N/A", p)
            self.assertIn("Nothing else changes.", p)

    def test_watermark_only_keeps_subtitles(self):
        p = vc.build_cleanup_prompt(True, False)
        self.assertIn("AI生成", p)
        self.assertIn("account-number", p)
        # kept lightly, as in the hand prompt that worked; a strong "subtitles held
        # exactly, same words, font" made the model keep the watermark too
        self.assertIn("the same subtitles", p)
        self.assertNotIn("the burnt-in subtitles removed", p)
        self.assertNotIn("same words, position, font", p)

    def test_hinted_watermark_has_no_negated_list(self):
        p = vc.build_cleanup_prompt(True, False, "the grey label box in the top left corner", "a cat at a desk")
        self.assertIn("a cat at a desk", p)
        self.assertIn("the grey label box in the top left corner, are gone", p)
        self.assertEqual(p.count("grey label box"), 1)
        self.assertNotIn("none of", p)

    def test_subtitles_only_keeps_watermark(self):
        p = vc.build_cleanup_prompt(False, True)
        self.assertIn("with the burnt-in subtitles removed", p)
        self.assertIn("logo, account text or corner label in <Video 1> is kept", p)
        self.assertNotIn("AI生成", p)

    def test_both_removes_both_keeps_neither(self):
        p = vc.build_cleanup_prompt(True, True)
        self.assertIn("AI生成", p)
        self.assertIn("caption or subtitle text", p)
        self.assertNotIn("kept exactly", p)

    def test_snap_size(self):
        self.assertEqual(vc.snap_size(544, 960), (544, 960))
        self.assertEqual(vc.snap_size(540, 960), (544, 960))
        self.assertEqual(vc.snap_size(1920, 1080), (1536, 1088))


if __name__ == "__main__":
    unittest.main()
