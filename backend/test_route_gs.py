"""route_gs: cancelling stops WorldMirror (the whole process tree) and reports it; a generated turn is bent back onto
the route's street."""
import math
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

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


def _write_xyz_ply(path: Path, pts: np.ndarray) -> None:
    head = f"ply\nformat binary_little_endian 1.0\nelement vertex {len(pts)}\n"
    head += "".join(f"property float {c}\n" for c in "xyz") + "end_header\n"
    path.write_bytes(head.encode() + np.ascontiguousarray(pts, dtype=np.float32).tobytes())


def _quat_matrix(q: np.ndarray) -> np.ndarray:
    w, x, y, z = q / np.linalg.norm(q)
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])


class BendTurn(unittest.TestCase):
    """A straight street, and a 'generated turn' of it whose space beyond the first frame is bent the way H3 bends it
    (the street behind the anchor lies 30 deg off and 0.3 m low): _bend_turn has to put it back."""
    MPU, PHI, RIGHT, LEFT, CAM_H, ALPHA = 30.5, 10.0, 6.5, -7.9, 1.55, 30.0

    def street(self, u_from: float):
        """(points in the anchor camera frame, metres; wall side +1/-1/0 for ground; u along the street)"""
        d = np.array([math.sin(math.radians(self.PHI)), math.cos(math.radians(self.PHI))])
        n = np.array([d[1], -d[0]])
        pts, side, us = [], [], []
        for u in np.arange(u_from, 28, 0.1):
            for v, sd in ((self.RIGHT, 1), (self.LEFT, -1)):
                for h in np.arange(0.6, 4.0, 0.25):
                    x, z = u * d + v * n
                    pts.append((x, self.CAM_H - h, z)); side.append(sd); us.append(u)
        for u in np.arange(u_from, 28, 0.25):
            for v in np.arange(self.LEFT, self.RIGHT, 0.25):
                x, z = u * d + v * n
                pts.append((x, self.CAM_H, z)); side.append(0); us.append(u)
        g = np.arange(-7.5, 7.5, 0.06)                  # the ground next to the camera as densely as a real splat has it
        x, z = (a.ravel() for a in np.meshgrid(g, g))
        keep = (np.hypot(x, z) > 1.5) & (np.hypot(x, z) < 7.5) & (z > u_from)
        uu = np.stack([x, z], 1)[keep] @ d
        pts += [(a, self.CAM_H, b) for a, b in zip(x[keep], z[keep])]
        side += [0] * int(keep.sum())
        us += list(uu)
        return np.array(pts), np.array(side), np.array(us)

    def test_bent_turn_goes_back_onto_the_street(self):
        tmp = Path(tempfile.mkdtemp())
        old, _, _ = self.street(-4)
        _write_xyz_ply(tmp / "old.ply", old / self.MPU)
        true, side, us = self.street(-45)
        heads = np.linspace(0, 150, 31)
        half = math.degrees(math.atan2(476, 640))
        t_a, t_b = half, 150 - half
        T = (np.degrees(np.arctan2(true[:, 0], true[:, 2])) + 90) % 360 - 90       # true azimuth along the turn
        t = np.where(T <= t_a, T, np.where(T >= t_b + self.ALPHA, T - self.ALPHA,
                                           t_a + (T - t_a) * (t_b - t_a) / (t_b + self.ALPHA - t_a)))
        r = np.hypot(true[:, 0], true[:, 2])
        new = np.stack([r * np.sin(np.radians(t)), true[:, 1] + 0.3, r * np.cos(np.radians(t))], 1)
        seen = (t >= -half) & (t <= 150 + half)
        new, side, us, T, t = new[seen], side[seen], us[seen], T[seen], t[seen]
        names = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2",
                 "rot_0", "rot_1", "rot_2", "rot_3"]
        data = np.zeros((len(new), len(names)), np.float32)
        data[:, :3] = new / self.MPU
        data[:, names.index("rot_0")] = 1.0
        cams = []
        for h in np.radians(heads):
            c = np.eye(4)
            c[:3, :3] = [[math.cos(h), 0, math.sin(h)], [0, 1, 0], [-math.sin(h), 0, math.cos(h)]]
            cams.append(c)
        K = np.array([[640.0, 0, 476], [0, 640, 266], [0, 0, 1]])
        out, rep = route_gs._bend_turn(data.copy(), names, tmp / "old.ply", np.eye(4), cams, [K] * len(cams), self.MPU)
        self.assertAlmostEqual(rep["alpha"], self.ALPHA, delta=1.5, msg=rep)
        p = out[:, :3].astype(np.float64) * self.MPU
        d = np.array([math.sin(math.radians(self.PHI)), math.cos(math.radians(self.PHI))])
        v = p[:, [0, 2]] @ np.array([d[1], -d[0]])
        behind = us < -10
        self.assertLess(np.percentile(np.abs(v[behind & (side == 1)] - self.RIGHT), 95), 0.35)
        self.assertLess(np.percentile(np.abs(v[behind & (side == -1)] - self.LEFT), 95), 0.6)
        self.assertLess(abs(np.median(p[behind & (side == 0), 1]) - self.CAM_H), 0.1)
        # every gaussian turns with its own azimuth change, the same way as its position
        k = np.flatnonzero(behind & (side == 1))[::50]
        a1 = np.degrees(np.arctan2(p[k, 0], p[k, 2]))
        for i, a0, b in zip(k, t[k], a1):
            R = _quat_matrix(out[i, [names.index(f"rot_{j}") for j in range(4)]].astype(np.float64))
            e = R @ np.array([math.sin(math.radians(a0)), 0.0, math.cos(math.radians(a0))])
            self.assertLess(abs(((math.degrees(math.atan2(e[0], e[2])) - b + 180) % 360) - 180), 1.5)


def _rot_y(deg: float) -> np.ndarray:
    a = math.radians(deg)
    return np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])


class RouteManifest(unittest.TestCase):
    def test_align_runs_composes_the_seams(self):
        """Clip 1 and clip 2 are clip 0's cameras seen through known similarities; _align_runs has to give each
        clip's transform into clip 0's frame, so its cameras land where clip 0 has them."""
        rng = np.random.default_rng(0)
        world = []
        for k in range(12):
            c = np.eye(4)
            c[:3, :3] = _rot_y(rng.uniform(-10, 10))
            c[:3, 3] = [rng.uniform(-0.2, 0.2), rng.uniform(-0.05, 0.05), 0.1 * k]
            world.append(c)
        truth = [(1.0, np.eye(3), np.zeros(3)), (0.7, _rot_y(25), np.array([0.3, 0.0, -0.2])),
                 (1.6, _rot_y(-40), np.array([-0.1, 0.05, 0.4]))]

        def seen_by(i, cams):               # what clip i's own reconstruction says about world cameras
            s, R, t = truth[i]
            out = []
            for c in cams:
                m = np.eye(4)
                m[:3, :3] = R.T @ c[:3, :3]
                m[:3, 3] = R.T @ (c[:3, 3] - t) / s
                out.append(m)
            return np.array(out)

        runs = [{"cams": seen_by(0, world[0:6]), "n_shared": 0},
                {"cams": seen_by(1, world[3:9]), "n_shared": 3},
                {"cams": seen_by(2, world[6:12]), "n_shared": 3}]
        T, report = route_gs._align_runs(runs)
        for i in (1, 2):
            s, R, t = T[i]
            back = np.array([s * (R @ m[:3, 3]) + t for m in runs[i]["cams"]])
            start = 3 * i
            np.testing.assert_allclose(back, np.array([c[:3, 3] for c in world[start:start + 6]]), atol=1e-9)
        self.assertEqual([r["seam"] for r in report], ["0->1", "1->2"])

    def test_find_anchor_picks_the_frame_the_turn_starts_on(self):
        import cv2
        tmp = Path(tempfile.mkdtemp())
        rng = np.random.default_rng(1)
        frames = tmp / "clip0" / "frames"
        frames.mkdir(parents=True)
        scenes = []
        for j in range(4):                  # four different 'street' frames, textured enough for SIFT
            im = np.full((360, 640, 3), 40, np.uint8)
            for _ in range(120):
                x, y = int(rng.integers(0, 620)), int(rng.integers(0, 340))
                w, h = int(rng.integers(8, 60)), int(rng.integers(8, 60))
                col = tuple(int(c) for c in rng.integers(60, 255, 3))
                cv2.rectangle(im, (x, y), (x + w, y + h), col, -1)
            scenes.append(im)
            cv2.imwrite(str(frames / f"b_{j + 1:03d}.png"), im)
        # the turn's first frame: frame 3 re-graded (de-peopled / re-textured in real use) and nudged by a few pixels
        q = cv2.convertScaleAbs(scenes[2], alpha=0.8, beta=25)
        q = cv2.warpAffine(q, np.float32([[1.01, 0, -6], [0, 1.01, 3]]), (640, 360))
        cv2.imwrite(str(tmp / "first.png"), q)
        manifest = {"clips": [{"cache": str(tmp / "clip0"), "own": [f"b_{j + 1:03d}.png" for j in range(4)],
                               "n_shared": 2, "indices": [10, 40, 70, 100], "fps": 50.0}]}
        a = route_gs.find_anchor(tmp / "first.png", manifest)
        self.assertEqual((a["clip"], a["own"], a["index"], a["time_s"]), (0, 2, 4, 1.4), a)
        self.assertGreater(a["inliers"], 3 * (a["runner_up"]["inliers"] if a["runner_up"] else 1))
        # a picture of somewhere else is refused instead of being anchored to whichever frame scores best
        other = np.full((360, 640, 3), 40, np.uint8)
        for _ in range(120):
            x, y = int(rng.integers(0, 600)), int(rng.integers(0, 330))
            cv2.circle(other, (x, y), int(rng.integers(4, 30)), tuple(int(c) for c in rng.integers(60, 255, 3)), -1)
        cv2.imwrite(str(tmp / "elsewhere.png"), other)
        with self.assertRaisesRegex(RuntimeError, "no frame of this route"):
            route_gs.find_anchor(tmp / "elsewhere.png", manifest)


if __name__ == "__main__":
    unittest.main()
