"""A canvas save based on an older revision, or on none, must not overwrite newer edits."""
import asyncio
import json
import unittest
from types import SimpleNamespace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi import HTTPException

import main


def _save(nodes, base):
    req = main.CanvasSaveRequest(nodes=nodes, edges=[], base_revision=base)
    return asyncio.run(main.save_canvas("p1", req, SimpleNamespace(client=None), x_agent=None, authorization=None))


class CanvasSaveRevisionTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)
        self._patch = mock.patch.object(main, "WORKSPACES_DIR", root)
        self._patch.start()
        proj = main._project_dir("p1")
        proj.mkdir(parents=True)
        (proj / "meta.json").write_text(json.dumps({"id": "p1"}), encoding="utf-8")
        self.canvas = proj / "canvas.json"
        self.canvas.write_text(json.dumps({"nodes": [], "edges": []}), encoding="utf-8")

    def tearDown(self):
        self._patch.stop()
        self._tmp.cleanup()

    def _nodes(self):
        return json.loads(self.canvas.read_text(encoding="utf-8"))["nodes"]

    def test_stale_and_blind_saves_are_refused(self):
        self.assertEqual(_save([{"id": "first"}], None)["revision"], 1)  # never saved: allowed
        self.assertEqual(_save([{"id": "mcp"}], 1)["revision"], 2)      # MCP edit
        for base in (1, None):                                            # stale tab
            with self.assertRaises(HTTPException) as ctx:
                _save([{"id": "stale"}], base)
            self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(self._nodes(), [{"id": "mcp"}])
        self.assertEqual(_save([{"id": "next"}], 2)["revision"], 3)


if __name__ == "__main__":
    unittest.main()
