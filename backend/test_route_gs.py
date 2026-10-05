"""route_gs: cancelling stops WorldMirror (the whole process tree) and reports it."""
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import route_gs


def _fake_hyworld(root: Path, body: str) -> Path:
    pkg = root / "hyworld2" / "worldrecon"
    pkg.mkdir(parents=True)
    (root / "hyworld2" / "__init__.py").write_text("")
    (pkg / "__init__.py").write_text("")
    (pkg / "pipeline.py").write_text(body)
    return root


def _alive(pid: int) -> bool:
    if sys.platform == "win32":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        import os
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class RunWorldMirror(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        (self.tmp / "frames").mkdir()

    def _patched(self, root: Path):
        return mock.patch.multiple(route_gs, HYWORLD_DIR=root, _venv_python=lambda: Path(sys.executable))

    def test_cancel_kills_worldmirror_and_its_child(self):
        # the fake pipeline starts a child of its own and then sleeps, like the real one with its workers
        root = _fake_hyworld(self.tmp / "hy", (
            "import subprocess, sys, time\n"
            "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
            "open('child.pid', 'w').write(str(child.pid))\n"
            "time.sleep(120)\n"))
        t0 = time.time()
        stop_at = t0 + 3.0
        with self._patched(root), self.assertRaises(route_gs.RouteCancelled):
            route_gs.run_worldmirror(self.tmp / "frames", self.tmp / "out", should_stop=lambda: time.time() > stop_at)
        self.assertLess(time.time() - t0, 15, "cancel should return within seconds, not wait for the 120 s sleep")
        child_pid = int((root / "child.pid").read_text())
        time.sleep(1.0)
        self.assertFalse(_alive(child_pid), "the child of WorldMirror was left running")

    def test_failure_reports_the_log(self):
        root = _fake_hyworld(self.tmp / "hy", "import sys\nsys.stderr.write('boom from worldmirror')\n")
        with self._patched(root), self.assertRaisesRegex(RuntimeError, "boom from worldmirror"):
            route_gs.run_worldmirror(self.tmp / "frames", self.tmp / "out")


if __name__ == "__main__":
    unittest.main()
