"""A job that only wants its sound leaves the latent file out of the graph."""
import unittest

import workflow_builders as wb


class SaveLatentTest(unittest.TestCase):
    KW = dict(prompt="a line", width=512, height=288, length=49, seed=1)

    def test_latent_is_saved_by_default(self):
        self.assertIn("62", wb.build_h3_video_workflow(**self.KW))

    def test_no_latent_node_when_not_wanted(self):
        wf = wb.build_h3_video_workflow(**self.KW, save_latent=False)
        self.assertNotIn("62", wf)
        self.assertIn("60", wf)   # the video itself is still written


if __name__ == "__main__":
    unittest.main()
