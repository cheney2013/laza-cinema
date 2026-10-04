"""Jobs from a previous backend process are settled from ComfyUI's own record."""
import asyncio
import unittest
from unittest import mock

import main


class FakeComfy:
    def __init__(self, states):
        self.states = list(states)
        self.abandoned = []

    async def prompt_state(self, prompt_id):
        return self.states.pop(0) if len(self.states) > 1 else self.states[0]

    output_files = staticmethod(main.comfyui.output_files)

    async def abandon_prompt(self, prompt_id):
        self.abandoned.append(prompt_id)


def _job(**kw):
    return {"id": "j1", "type": "video", "status": "running", "prompt_id": "p1", "project_id": None, **kw}


VIDEO_OUT = {"9": {"videos": [{"filename": "H3_Video_ab_00001_.mp4", "subfolder": "", "type": "output"}]}}


class RecoveryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        patches = [mock.patch.object(main, "save_state"), mock.patch.object(main, "RECOVERY_POLL_S", 0.01),
                   mock.patch.object(main.asset_origin, "record")]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    async def test_finished_render_becomes_done_with_its_prompt(self):
        fake = FakeComfy([("success", VIDEO_OUT)])
        job = _job(recovery_extras={"compiled_prompt": "P", "mode": "t2va"})
        with mock.patch.object(main, "comfyui", fake):
            self.assertTrue(await main._recover_job(job))
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["result"]["url"], "/comfy_output/H3_Video_ab_00001_.mp4")
        self.assertEqual(job["result"]["compiled_prompt"], "P")
        self.assertTrue(job["recovery_checked"])

    async def test_render_still_running_is_watched_to_the_end(self):
        fake = FakeComfy([("running", {}), ("running", {}), ("success", VIDEO_OUT)])
        job = _job()
        with mock.patch.object(main, "comfyui", fake):
            self.assertTrue(await main._recover_job(job))
            self.assertEqual(job["status"], "running")
            await asyncio.gather(*main._recovery_tasks)
        self.assertEqual(job["status"], "done")

    async def test_chunk_is_not_passed_off_as_the_clip(self):
        out = {"9": {"videos": [{"filename": "H3_Chunk_ab_00001_.mp4", "type": "output"}]}}
        job = _job()
        with mock.patch.object(main, "comfyui", FakeComfy([("success", out)])):
            self.assertFalse(await main._recover_job(job))
        self.assertEqual(job["status"], "error")
        self.assertIn("H3_Chunk_ab_00001_.mp4", job["error"])

    async def test_chunk_with_its_request_is_run_again(self):
        out = {"9": {"videos": [{"filename": "H3_Chunk_ab_00001_.mp4", "type": "output"}]}}
        job = _job(request={"prompt": "x"})
        enq = []
        with mock.patch.object(main, "comfyui", FakeComfy([("success", out)])), \
                mock.patch.object(main, "_replay_runner", lambda j: (lambda jj: None)), \
                mock.patch.object(main, "_enqueue", lambda j, r: enq.append(j)):
            await main._recover_job(job)
        self.assertEqual(job["status"], "queued")
        self.assertEqual(enq, [job])
        main._pending.remove(job)

    async def test_after_prompt_waits_for_the_old_render_then_runs(self):
        fake = FakeComfy([("running", {}), ("running", {}), ("success", {})])
        ran = []

        async def runner(j):
            ran.append(len(fake.states))
            return {"url": "u"}
        with mock.patch.object(main, "comfyui", fake):
            result = await main._after_prompt("p1", runner)({"id": "j"})
        self.assertEqual(result, {"url": "u"})
        self.assertEqual(ran, [1])
        self.assertEqual(fake.abandoned, [])

    async def test_gone_or_failed_prompt_is_an_error(self):
        for state in ("gone", "interrupted", "error"):
            job = _job()
            with mock.patch.object(main, "comfyui", FakeComfy([(state, {})])):
                self.assertFalse(await main._recover_job(job))
            self.assertEqual(job["status"], "error")
            self.assertTrue(job["recovery_checked"])

    async def test_unreachable_comfyui_is_asked_again_next_time(self):
        job = _job()
        with mock.patch.object(main, "comfyui", FakeComfy([("unreachable", {})])):
            self.assertFalse(await main._recover_job(job))
        self.assertEqual((job["status"], job["error"]), ("error", main.SHUTDOWN_ERROR))
        self.assertFalse(job.get("recovery_checked"))

    async def test_post_processed_job_types_are_not_recovered(self):
        job = _job(type="wardrobe_swap_h3")
        with mock.patch.object(main, "comfyui", FakeComfy([("success", VIDEO_OUT)])):
            self.assertFalse(await main._recover_job(job))
        self.assertEqual(job["status"], "running")  # untouched: the caller fails and abandons it


class ReplayTest(unittest.IsolatedAsyncioTestCase):
    def test_every_replayable_type_names_a_real_model_and_runner(self):
        for job_type, (model, runner) in main._REPLAYABLE.items():
            self.assertTrue(issubclass(getattr(main, model), main.BaseModel), job_type)
            if runner:
                self.assertTrue(callable(getattr(main, runner)), job_type)

    async def test_submitted_request_is_kept_and_rebuilds_the_runner(self):
        seen = {}

        async def fake_runner(job, req):
            seen["prompt"] = req.prompt
            return {"url": "/x.mp4"}

        with mock.patch.object(main, "save_state"), mock.patch.object(main, "GENERATION_ENABLED", True), \
                mock.patch.object(main, "_runners", {}), mock.patch.object(main, "_pending", []), \
                mock.patch.object(main, "_run_video_job", fake_runner):
            req = main.VideoRequest(prompt="a shot")
            out = await main.submit_job("video", lambda job: fake_runner(job, req), request=req)
            job = main._pending[0]
            self.assertEqual(job["id"], out["job_id"])
            self.assertEqual(job["request"]["prompt"], "a shot")
            await main._replay_runner(job)(job)
        self.assertEqual(seen["prompt"], "a shot")

    def test_unknown_or_missing_request_is_not_replayable(self):
        self.assertIsNone(main._replay_runner({"type": "video"}))
        self.assertIsNone(main._replay_runner({"type": "nope", "request": {}}))


if __name__ == "__main__":
    unittest.main()
