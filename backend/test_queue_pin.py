import asyncio
import unittest
from unittest import mock

import main


class QueuePinTest(unittest.IsolatedAsyncioTestCase):
    async def test_pinned_job_runs_next(self):
        order = []

        def runner(name):
            async def run(job):
                order.append(name)
                return {}
            return run

        pending, runners = [], {}
        with mock.patch.object(main, "save_state"), mock.patch.object(main, "GENERATION_ENABLED", True), \
                mock.patch.object(main, "_pending", pending), mock.patch.object(main, "_runners", runners), \
                mock.patch.object(main, "_queue_wake", asyncio.Event()), mock.patch.object(main, "_history", []), \
                mock.patch.object(main.comfyui, "get_system_stats", mock.AsyncMock(return_value={})), \
                mock.patch.object(main.comfyui, "last_family", mock.AsyncMock(return_value=None)), \
                mock.patch.object(main.comfyui, "loaded_vram_bytes", mock.AsyncMock(return_value=None)), \
                mock.patch.object(main.comfyui, "free_memory", mock.AsyncMock(return_value=True)):
            ids = []
            for name in ("a", "b", "c"):
                out = await main.submit_job("video", runner(name))
                ids.append(out["job_id"])
            self.assertTrue(main.pin_job(ids[2]))
            self.assertEqual([j["id"] for j in pending], [ids[2], ids[0], ids[1]])
            self.assertFalse(main.pin_job("nope"))
            worker = asyncio.create_task(main._job_worker())
            for _ in range(50):
                if len(order) == 3:
                    break
                await asyncio.sleep(0.01)
            worker.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await worker
        self.assertEqual(order, ["c", "a", "b"])


if __name__ == "__main__":
    unittest.main()
