"""A side job (submit_side_job, e.g. /adjust-route) runs at once beside the queue: a render holding the queue does
not hold it, and it is found through /job/{id} while it runs and in the history when it ends."""
import time
import unittest
from unittest import mock

import main
from fastapi.testclient import TestClient


class SideJobs(unittest.TestCase):
    def test_runs_beside_a_busy_queue(self):
        busy = {"id": "render-in-progress", "type": "video", "status": "running"}

        async def fake_adjust(job, req):
            return {"url": "/uploads/route_adj_test.ply", "adjusted": req.adjustments}

        with mock.patch.object(main, "_active_job", busy), mock.patch.object(main, "GENERATION_ENABLED", True), \
                mock.patch.object(main, "_run_route_adjust_job", fake_adjust), mock.patch.object(main, "save_state"):
            client = TestClient(main.app)
            r = client.post("/adjust-route", json={"route_ply_url": "/uploads/route_x.ply",
                                                   "adjustments": {"/uploads/clip.mp4": {"yaw": 2.0}}})
            self.assertEqual(r.status_code, 200, r.text)
            job_id = r.json()["job_id"]
            deadline = time.time() + 5
            while time.time() < deadline:
                job = client.get(f"/job/{job_id}").json()
                if job["status"] != "running":
                    break
                time.sleep(0.05)
            self.assertEqual(job["status"], "done", job)
            self.assertEqual(job["result"]["adjusted"], {"/uploads/clip.mp4": {"yaw": 2.0}})
            self.assertIs(main._active_job, busy)                      # the render was not touched
            self.assertIn(job_id, client.get(f"/queue?ids={job_id}").json()["tracked"])
            self.assertNotIn(job_id, main._side_jobs)                  # ended: in the history now


if __name__ == "__main__":
    unittest.main()
