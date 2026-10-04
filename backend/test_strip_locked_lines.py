"""Redoing the sound with locks: the clauses that speak a locked line are cut from the prompt."""

import unittest
from pathlib import Path

import audio_lock as al


def lock(text):
    return al.LockSpec(path=Path("x.wav"), at=5.7, text=text)


class StripLockedLinesTest(unittest.TestCase):
    def test_cuts_the_clause_that_speaks_the_locked_line(self):
        prompt = ("Mark's dark shape appears outside the glass; her breath goes out and <Subject 1> (S1), breathless, "
                  "says: <d>[English] There you are.</d> Beat three: Mark crashes in.")
        out, removed = al.strip_locked_lines(prompt, [lock("There you are.")])
        self.assertNotIn("<d>", out)
        self.assertIn("Mark's dark shape appears outside the glass", out)
        self.assertIn("Beat three: Mark crashes in.", out)
        self.assertEqual(len(removed), 1)
        self.assertIn("There you are.", removed[0])
        self.assertEqual(al.locked_lines_in_prompt(out, [lock("There you are.")]), [])

    def test_keeps_the_lines_that_are_not_locked(self):
        prompt = ("She speaks: <d>[English] There you are.</d> Then Mark, hard: <d>[English] Anna. Are you okay?</d>")
        out, removed = al.strip_locked_lines(prompt, [lock("There you are.")])
        self.assertIn("<d>[English] Anna. Are you okay?</d>", out)
        self.assertEqual(len(removed), 1)

    def test_no_locked_line_in_the_prompt_changes_nothing(self):
        prompt = "A quiet room. Beat one: she walks."
        out, removed = al.strip_locked_lines(prompt, [lock("There you are.")])
        self.assertEqual((out, removed), (prompt, []))

    def test_several_locks(self):
        prompt = "He speaks: <d>[English] Has anyone come in here?</d> She answers: <d>[English] No, who would come in here?</d>"
        out, removed = al.strip_locked_lines(
            prompt, [lock("Has anyone come in here?"), lock("No, who would come in here?")])
        self.assertNotIn("<d>", out)
        self.assertEqual(len(removed), 2)


if __name__ == "__main__":
    unittest.main()
