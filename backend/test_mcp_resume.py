"""After this server restarts, running nodes get a watcher again and chain HD runs carry on."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from mcp_test_support import import_mcp_server

cms = import_mcp_server()


class GeneratingJobsTest(unittest.TestCase):
    def test_finds_every_node_waiting_for_a_job(self):
        canvas = {"nodes": [
            {"id": "a", "data": {"status": "generating", "jobId": "j1"}},
            {"id": "b", "data": {"status": "done", "jobId": None}},
            {"id": "c", "data": {"status": "idle"}},
            {"id": "d", "data": {"status": "loading", "worldJobId": "w1"}},
            {"id": "e", "data": {"status": "generating"}},          # no job id: nothing to watch
        ]}
        self.assertEqual(cms._generating_jobs(canvas), [("a", "j1"), ("d", "w1")])


class ChainRunsFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.file = Path(self.tmp.name) / "chain.json"
        patch = mock.patch.object(cms, "_CHAIN_HD_FILE", self.file)
        patch.start()
        self.addCleanup(patch.stop)
        runs = mock.patch.dict(cms._CHAIN_HD_RUNS, {}, clear=True)
        runs.start()
        self.addCleanup(runs.stop)

    def test_only_running_chains_are_recorded_and_read_back(self):
        cms._CHAIN_HD_RUNS["p1"] = {"status": "running", "scene": "s1", "chain": ["a", "b", "c"], "scale_by": 2.0}
        cms._CHAIN_HD_RUNS["p2"] = {"status": "done", "scene": "", "chain": ["x"], "scale_by": 2.0}
        cms._save_chain_runs()
        self.assertEqual(cms._load_chain_runs(), [
            {"project": "p1", "scene": "s1", "node_id": "a", "scale_by": 2.0, "shot_ids": ["a", "b", "c"]}])

    def test_a_missing_or_broken_file_is_no_runs(self):
        self.assertEqual(cms._load_chain_runs(), [])
        self.file.write_text("{not json", encoding="utf-8")
        self.assertEqual(cms._load_chain_runs(), [])

    def test_resume_watches_the_running_nodes_and_restarts_the_chain(self):
        cms._CHAIN_HD_RUNS["p1"] = {"status": "running", "scene": "s1", "chain": ["a", "b"], "scale_by": 2.0}
        cms._save_chain_runs()
        cms._CHAIN_HD_RUNS.clear()
        watched, started = [], []

        def request(method, path, **kw):
            if path == "/projects":
                return {"projects": [{"id": "p1", "updated_at": "2999-01-01T00:00:00+00:00"},
                                     {"id": "old", "updated_at": "2001-01-01T00:00:00+00:00"}]}
            if path == "/projects/p1/scenes":
                return {"scenes": [{"id": "s1"}, {"id": "s2"}]}
            raise AssertionError(path)

        canvases = {"s1": {"nodes": [{"id": "hd", "data": {"status": "generating", "jobId": "j9"}}]},
                    "s2": {"nodes": [{"id": "x", "data": {"status": "done"}}]}}
        with mock.patch.object(cms, "_request", request), \
                mock.patch.object(cms, "_canvas", lambda pid: canvases[cms._SCENE.get()]), \
                mock.patch.object(cms, "_watch_job", lambda *a: watched.append(a)), \
                mock.patch.object(cms, "start_chain_hd", lambda *a: started.append(a)):
            out = cms._resume_after_restart(wait_s=0)
        self.assertEqual(watched, [("p1", "hd", "j9", "s1")])
        self.assertEqual(started, [("p1", "a", "s1", 2.0, ["a", "b"])])
        self.assertEqual(out, {"watched": 1, "chains": 1})

    def test_one_unreadable_project_does_not_stop_the_rest(self):
        def request(method, path, **kw):
            if path == "/projects":
                return {"projects": [{"id": "bad", "updated_at": "2999-01-01T00:00:00+00:00"},
                                     {"id": "ok", "updated_at": "2999-01-01T00:00:00+00:00"}]}
            if path == "/projects/bad/scenes":
                raise RuntimeError("boom")
            return {"scenes": []}
        watched = []
        with mock.patch.object(cms, "_request", request), \
                mock.patch.object(cms, "_canvas", lambda pid: {"nodes": [{"id": "n", "data": {"status": "generating", "jobId": "j"}}]}), \
                mock.patch.object(cms, "_watch_job", lambda *a: watched.append(a)):
            cms._resume_after_restart(wait_s=0)
        self.assertEqual(watched, [("ok", "n", "j", "main")])


if __name__ == "__main__":
    unittest.main()
