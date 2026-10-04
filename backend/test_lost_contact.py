"""A render the backend lost contact with is collected once ComfyUI has finished it, not failed."""
import asyncio
import unittest
from unittest import mock

import main
from comfyui_client import ComfyUIError


def _job():
    return {"id": "j1", "type": "upscale", "status": "queued", "prompt_id": "p1", "request": {"x": 1}}


class LostContactTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        for p in (mock.patch.object(main, "save_state"), mock.patch.object(main, "RECOVERY_POLL_S", 0.01),
                  mock.patch.object(main.asset_origin, "record"),
                  mock.patch.object(main, "_job_sched", return_value={"family": "x"}),
                  mock.patch.object(main.sched, "needs_free", return_value=False),
                  mock.patch.object(main.sched, "is_heavy", return_value=False)):
            p.start()
            self.addCleanup(p.stop)
        main._history.clear()

    async def _run(self, job, runner, states):
        seq = list(states)

        async def prompt_state(_pid):
            return (seq.pop(0) if len(seq) > 1 else seq[0]), {}

        with mock.patch.object(main.comfyui, "prompt_state", prompt_state):
            await main._execute_job(job, runner)

    async def test_waits_for_comfyui_then_collects_the_result(self):
        calls = []

        async def runner(job):
            calls.append(1)
            if len(calls) == 1:
                raise ComfyUIError("ComfyUI server disconnected or unreachable: ")
            return {"url": "/uploads/hd.mp4"}

        job = _job()
        await self._run(job, runner, ["unreachable", "running", "success"])
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["result"], {"url": "/uploads/hd.mp4"})
        self.assertEqual(len(calls), 2)

    async def test_other_errors_still_fail_the_job_at_once(self):
        async def runner(job):
            raise ComfyUIError("Job disappeared from ComfyUI (server restarted or queue cleared)")

        job = _job()
        await self._run(job, runner, ["success"])
        self.assertEqual(job["status"], "error")

    async def test_a_second_failure_after_the_wait_is_an_error(self):
        async def runner(job):
            raise ComfyUIError("ComfyUI server disconnected or unreachable: ")

        job = _job()
        await self._run(job, runner, ["success"])
        self.assertEqual(job["status"], "error")

    async def test_a_job_without_a_prompt_cannot_be_waited_for(self):
        async def runner(job):
            raise ComfyUIError("ComfyUI server disconnected or unreachable: ")

        job = {**_job(), "prompt_id": None}
        await self._run(job, runner, ["success"])
        self.assertEqual(job["status"], "error")


if __name__ == "__main__":
    unittest.main()
