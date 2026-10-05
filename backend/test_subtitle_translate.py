import unittest

import subtitle_translate as st


class SubtitleTranslateTests(unittest.TestCase):
    def test_prompt_numbers_lines_and_flattens_multiline_cues(self):
        prompt = st.build_prompt(["Hello", "Two\nlines"], "en", "zh")
        self.assertIn("Simplified Chinese", prompt)
        self.assertTrue(prompt.endswith("1. Hello\n2. Two / lines"))

    def test_parse_keeps_order_and_blanks_what_was_skipped(self):
        self.assertEqual(st.parse_numbered("1. 你好\n3) 再见\n", 3), ["你好", "", "再见"])

    def test_parse_joins_a_wrapped_line_and_drops_thinking(self):
        out = st.parse_numbered("<think>\n1. no\n</think>\n1. 第一句\n还有半句\n2：第二句", 2)
        self.assertEqual(out, ["第一句 还有半句", "第二句"])

    def test_parse_ignores_numbers_outside_the_batch(self):
        self.assertEqual(st.parse_numbered("1. a\n9. b", 2), ["a", ""])

    def test_restore_breaks_only_where_the_source_had_one(self):
        out = st.restore_breaks(["a\nb", "c"], ["甲 / 乙", "丙/丁"])
        self.assertEqual(out, ["甲\n乙", "丙/丁"])


if __name__ == "__main__":
    unittest.main()
