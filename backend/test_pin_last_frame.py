"""钉末帧: which clip a canvas-MCP run pins the ending to."""
import unittest

from mcp_test_support import import_mcp_server

mcp = import_mcp_server()

A = "/comfy_output/H3_Chunk_eb519eeb_00001_.mp4"
B = "/comfy_output/H3_Chunk_fe146484_00001_.mp4"


class PinnedFrameSourceTests(unittest.TestCase):
    def test_off_means_no_pin(self):
        self.assertIsNone(mcp._pinned_frame_source({"generatedUrl": A}))

    def test_pin_stays_on_the_version_it_was_set_on(self):
        self.assertEqual(mcp._pinned_frame_source({"pinLastFrame": True, "pinLastFrameOf": A, "generatedUrl": B}), A)

    def test_old_pin_follows_the_shown_version(self):
        self.assertEqual(mcp._pinned_frame_source({"pinLastFrame": True, "generatedUrl": B}), B)


if __name__ == "__main__":
    unittest.main()
