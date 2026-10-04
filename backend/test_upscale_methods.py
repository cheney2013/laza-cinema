"""The studio's video upscale has three methods; SeedVR2 is gone (2026-10-02)."""
import unittest
from pathlib import Path
from unittest import mock

import job_scheduler
import main


class UpscaleMethodsTest(unittest.IsolatedAsyncioTestCase):
    def test_default_method_is_the_h3_latent_refine(self):
        self.assertEqual(main.VideoUpscaleRequest(video_url="/uploads/a.mp4").method, "h3_latent")

    def test_scheduler_families(self):
        fam = lambda method: job_scheduler.describe("upscale", {"method": method} if method else {})["family"]
        self.assertEqual(fam(None), "h3:default")
        self.assertEqual(fam("lms"), "h3:default")
        self.assertEqual(fam("esrgan"), "esrgan")

    async def test_an_unknown_method_is_refused_not_run(self):
        async def resolve(_url):
            return Path("a.mp4")

        req = main.VideoUpscaleRequest(video_url="/uploads/a.mp4", method="seedvr2")
        with mock.patch.object(main, "resolve_upload", resolve):
            with self.assertRaisesRegex(ValueError, "Unknown upscale method"):
                await main._run_video_upscale_job({"id": "j"}, req)


if __name__ == "__main__":
    unittest.main()
