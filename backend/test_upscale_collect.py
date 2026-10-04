"""An upscale whose ComfyUI prompt already finished is collected, not rendered a second time."""
import unittest
from unittest import mock

import main

OUT = {"61": {"videos": [{"filename": "H3_Upscale_Video_ab_00001_.mp4", "subfolder": "", "type": "output"}]},
       "62": {"latents": [{"filename": "H3_Upscale_Latent_ab_00001_.safetensors", "subfolder": "", "type": "output"}]}}


def _job(**request):
    req = {"video_url": "/comfy_output/H3_Chunk_aa_00001_.mp4", "method": "h3_latent",
           "latent_filename": "H3_Latent_aa_00001_.safetensors", "overlap_frames": 0, **request}
    return {"id": "j1", "type": "upscale", "prompt_id": "p1", "request": req}


class CollectTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        async def resolve(_url):
            return main.Path("x.mp4")
        for p in (mock.patch.object(main, "resolve_upload", resolve),):
            p.start()
            self.addCleanup(p.stop)

    async def _collect(self, job, state="success"):
        async def prompt_state(_pid):
            return state, OUT
        with mock.patch.object(main.comfyui, "prompt_state", prompt_state):
            return await main._upscale_result_from_comfy(job)

    async def test_a_finished_render_is_collected(self):
        result = await self._collect(_job())
        self.assertEqual(result["url"], "/comfy_output/H3_Upscale_Video_ab_00001_.mp4")
        self.assertEqual(result["comfy_filename"], "H3_Upscale_Video_ab_00001_.mp4")

    async def test_nothing_to_collect_while_it_runs_or_when_it_is_gone(self):
        self.assertIsNone(await self._collect(_job(), state="running"))
        self.assertIsNone(await self._collect(_job(), state="gone"))

    async def test_other_methods_and_other_jobs_are_left_alone(self):
        self.assertIsNone(await self._collect(_job(method="esrgan")))
        self.assertIsNone(await self._collect({**_job(), "type": "video"}))
        self.assertIsNone(await self._collect({**_job(), "prompt_id": None}))

    async def test_a_plain_video_encode_without_a_record_is_not_guessed_at(self):
        self.assertIsNone(await self._collect(_job(latent_filename=None)))

    async def test_after_prompt_does_not_run_the_job_again_when_it_collects(self):
        called = []

        async def runner(job):
            called.append(1)
            return {"url": "rerun"}

        async def prompt_state(_pid):
            return "success", OUT
        job = {**_job(), "prompt_id": None}
        with mock.patch.object(main.comfyui, "prompt_state", prompt_state):
            result = await main._after_prompt("p1", runner)(job)
        self.assertEqual(result["url"], "/comfy_output/H3_Upscale_Video_ab_00001_.mp4")
        self.assertEqual(called, [])

    async def test_after_prompt_runs_it_again_when_the_old_render_did_not_succeed(self):
        async def runner(job):
            return {"url": "rerun"}

        states = iter(["running", "gone", "gone"])

        async def prompt_state(_pid):
            return next(states), OUT
        job = {**_job(), "prompt_id": None}
        with mock.patch.object(main.comfyui, "prompt_state", prompt_state), \
                mock.patch.object(main, "RECOVERY_POLL_S", 0.01):
            result = await main._after_prompt("p1", runner)(job)
        self.assertEqual(result["url"], "rerun")


if __name__ == "__main__":
    unittest.main()
