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


GS_NAMES = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2",
            "rot_0", "rot_1", "rot_2", "rot_3"]


def _write_run(out: Path, cams_world: list, pts_world: np.ndarray, truth: tuple) -> Path:
    """A fake WorldMirror run: the world cameras and points as a run whose frame is world = s R run + t sees them."""
    s, R, t = truth
    out.mkdir(parents=True, exist_ok=True)
    ext = []
    for c in cams_world:
        m = np.eye(4)
        m[:3, :3] = R.T @ c[:3, :3]
        m[:3, 3] = R.T @ (c[:3, 3] - t) / s
        ext.append({"matrix": m.tolist()})
    (out / "camera_params.json").write_text(__import__("json").dumps({"extrinsics": ext}))
    d = np.zeros((len(pts_world), len(GS_NAMES)), np.float32)
    d[:, :3] = (pts_world - t) @ R / s
    d[:, GS_NAMES.index("opacity")] = 0.8
    d[:, [GS_NAMES.index(f"scale_{k}") for k in range(3)]] = -6.0
    d[:, GS_NAMES.index("rot_0")] = 1.0
    head = f"ply\nformat binary_little_endian 1.0\nelement vertex {len(d)}\n"
    head += "".join(f"property float {n}\n" for n in GS_NAMES) + "end_header\n"
    (out / "gaussians.ply").write_bytes(head.encode() + d.tobytes())
    return out


class ExtendRoute(unittest.TestCase):
    """A straight 'route' of two clips whose runs see the world through known similarities; a third clip is added
    after its end, or before its start.  The new clip has to land on its world cameras and points, through the
    shared frames alone, and the route between its ends has to stay as it was."""
    K, MPU = 3, 30.5

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        rng = np.random.default_rng(3)
        self.world = []                       # 36 cameras along z, 0.1 units apart, a little yaw each
        for i in range(36):
            c = np.eye(4)
            c[:3, :3] = _rot_y(rng.uniform(-6, 6))
            c[:3, 3] = [rng.uniform(-0.05, 0.05), 0.0, 0.1 * i]
            self.world.append(c)
        self.wall = lambda i0, i1: np.array([[x, y, z] for z in np.arange(0.1 * i0, 0.1 * i1, 0.02)
                                             for x in (-0.25, 0.25) for y in (-0.05, 0.0, 0.05)])
        self.truths = {"A": (0.8, _rot_y(20), np.array([0.2, 0.0, -0.1])), "B": (1.4, _rot_y(-35), np.array([0.0, 0.1, 0.3])),
                       "new": (0.6, _rot_y(50), np.array([-0.3, 0.05, 0.2]))}

    def _clip(self, name: str, world_idx: list, shared_idx: list, n_shared: int, n_tail: int, truth: tuple) -> dict:
        cache = self.tmp / f"cache_{name}"
        (cache / "frames").mkdir(parents=True)
        own = [f"b_{j + 1:03d}.png" for j in range(len(world_idx))]
        for f in own:
            (cache / "frames" / f).write_bytes(f"{name}:{f}".encode())
        idx = shared_idx[:n_shared] + world_idx + shared_idx[n_shared:]
        run = _write_run(cache / "out" / "run", [self.world[i] for i in idx], self.wall(min(idx), max(idx) + 1), truth)
        s, R, t = truth
        return {"clip": str(self.tmp / f"{name}.mp4"), "cache": str(cache), "run": str(run), "n_shared": n_shared,
                "n_tail": n_tail, "own": own, "indices": list(range(len(own))), "fps": 24.0,
                "transform": {"s": s, "R": R.tolist(), "t": t.tolist()}}

    def _route(self, a_idx, b_idx):
        """clip A = world a_idx, clip B = world b_idx with A's last K own frames shared at its start."""
        a = self._clip("A", a_idx, [], 0, 0, self.truths["A"])
        b = self._clip("B", b_idx, a_idx[-self.K:], self.K, 0, self.truths["B"])
        manifest = {"metres_per_unit": self.MPU, "frame_width": 64, "clips": [a, b], "settings": {"shared": self.K}}
        core = self.tmp / "route_core.ply"
        _, self.core_cams = route_gs.recompose_route(manifest, core)
        return manifest, core

    def _extend(self, manifest, core, new_idx, where, adjustments=None, wm_calls=None):
        clip = self.tmp / "new.mp4"
        clip.write_bytes(b"new clip")
        adj = manifest["clips"][-1] if where == "end" else manifest["clips"][0]
        adj_world = [self.world_of[adj["clip"]][j] for j in range(len(adj["own"]))]
        shared_world = adj_world[-self.K:] if where == "end" else adj_world[:self.K]
        world_of_frames = {}

        def fake_sample(video, out_dir, step, max_frames, width=704, adaptive=True, ends=False):
            out_dir.mkdir(parents=True, exist_ok=True)
            files = []
            for j, wi in enumerate(new_idx):
                f = out_dir / f"b_{j + 1:03d}.png"
                f.write_bytes(b"x")
                files.append(f)
                world_of_frames[f.name] = wi
            (out_dir / "indices.json").write_text(__import__("json").dumps(list(range(len(files)))))
            return files

        def fake_worldmirror(frames_dir, out_dir, mask_dir=None, should_stop=None, timeout=0):
            if wm_calls is not None:
                wm_calls.append(mask_dir)
            names = sorted(p.name for p in Path(frames_dir).glob("*.png"))
            pre = {"a": "end", "c": "start"}
            idx = []
            for n in names:
                if n[0] in pre:
                    idx.append(shared_world[int(n[2:5])])
                else:
                    idx.append(world_of_frames[n])
            return _write_run(Path(out_dir) / "run", [self.world[i] for i in idx],
                              self.wall(min(new_idx), max(new_idx) + 1), self.truths["new"])

        ok = {"ok": True, "inliers": 300, "clip": 0, "own": 0, "far": 10}
        no = {"ok": False, "inliers": 5, "clip": 0, "own": 0, "far": 5}
        with mock.patch.multiple(route_gs, sample_frames=fake_sample, run_worldmirror=fake_worldmirror,
                                 _end_frames=lambda clip, out_dir, width: (out_dir / "first.png", out_dir / "last.png"),
                                 _end_match=lambda image, m, at_end, k, what: ok if at_end == (where == "end") else no,
                                 _probe=mock.Mock(side_effect=RuntimeError("no ffprobe here"))):
            out = self.tmp / (f"route_ext_{where}.ply" if not adjustments else f"route_ext_{where}_adj.ply")
            res = route_gs.extend_route(core, manifest, [clip], out, self.tmp / "cache", adjustments=adjustments)
        return out, res

    def _check(self, where: str):
        a_idx, b_idx = list(range(10, 22)), list(range(22, 30))
        self.world_of = {str(self.tmp / "A.mp4"): a_idx, str(self.tmp / "B.mp4"): b_idx}
        manifest, core = self._route(a_idx, b_idx)
        new_idx = list(range(30, 36)) if where == "end" else list(range(4, 10))
        out, res = self._extend(manifest, core, new_idx, where)
        m = __import__("json").loads(out.with_name(out.stem + "_route.json").read_text())
        self.assertEqual([c["clip"].rsplit("\\", 1)[-1].rsplit("/", 1)[-1] for c in m["clips"]],
                         ["A.mp4", "B.mp4", "new.mp4"] if where == "end" else ["new.mp4", "A.mp4", "B.mp4"])
        self.assertEqual(m["core_ply"], core.name)
        new = m["clips"][-1] if where == "end" else m["clips"][0]
        self.assertEqual((new["n_shared"], new["n_tail"]), (self.K, 0) if where == "end" else (0, self.K))
        # the new run's cameras land on their world cameras through the transform found from the shared frames
        s, R, t = new["transform"]["s"], np.array(new["transform"]["R"]), np.array(new["transform"]["t"])
        cams = route_gs._run_cams(Path(new["run"]))
        world_idx = ([None] * self.K + new_idx) if where == "end" else (new_idx + [None] * self.K)
        for c, wi in zip(cams, world_idx):
            if wi is not None:
                np.testing.assert_allclose(s * (R @ c[:3, 3]) + t, self.world[wi][:3, 3], atol=1e-9)
        self.assertLess(max(res["extensions"][0]["seam_residual_m"]), 1e-6)
        # route cameras: the old ones unchanged, the new clip's own ones added at that end, in metres
        old_cams = self.core_cams
        cams_m = __import__("json").loads(out.with_name(out.stem + "_cams.json").read_text())
        added = [(self.world[i][:3, 3] * self.MPU).tolist() for i in new_idx]
        expect = old_cams + added if where == "end" else added + old_cams
        np.testing.assert_allclose(np.array(cams_m), np.array(expect), atol=1e-6)
        # the merged splat is the extended manifest recomposed; the clip that is not at the seam keeps its bytes
        again = self.tmp / "again.ply"
        route_gs.recompose_route(m, again)
        self.assertEqual(again.read_bytes(), out.read_bytes())
        return m

    def test_a_clip_added_after_the_end(self):
        self._check("end")

    def test_a_clip_added_before_the_start_with_a_first_clip_off_the_route_frame(self):
        m = self._check("start")
        self.assertNotEqual(m["clips"][1]["transform"]["s"], 1.0)     # clip A was never the route frame here

    def test_a_hand_adjustment_is_kept_and_applied_without_reconstruction(self):
        """extend_route with an adjustment = the automatic result adjusted afterwards (adjust_route); no adjustment
        brings the automatic one back; the rows of each run in the file are recorded."""
        import json
        a_idx, b_idx = list(range(10, 22)), list(range(22, 30))
        self.world_of = {str(self.tmp / "A.mp4"): a_idx, str(self.tmp / "B.mp4"): b_idx}
        manifest, core = self._route(a_idx, b_idx)
        adj = {"scale": 1.05, "yaw": 5.0, "pitch": -1.0, "roll": 0.5, "right": 0.2, "up": -0.1, "forward": 0.5}
        key = str(self.tmp / "new.mp4")
        auto, _ = self._extend(manifest, core, list(range(30, 36)), "end")
        auto_m = json.loads(auto.with_name(auto.stem + "_route.json").read_text())
        adjusted = self.tmp / "route_adjusted.ply"
        res = route_gs.adjust_route(auto, auto_m, {key: adj}, adjusted)
        m = json.loads(adjusted.with_name(adjusted.stem + "_route.json").read_text())
        new = m["clips"][-1]
        self.assertEqual(new["adjust"], adj)
        self.assertEqual(res["extensions"][0]["adjust"], adj)
        # the new clip's cameras = the adjustment (about the seam camera) after the automatic placement
        s, R, t = route_gs.adjustment(adj, new["pivot"], new["axes"], 1.0 / self.MPU)
        cams_auto = np.array(json.loads(auto.with_name(auto.stem + "_cams.json").read_text()))
        cams_adj = np.array(json.loads(adjusted.with_name(adjusted.stem + "_cams.json").read_text()))
        n_new = len(new["own"])
        expect = (s * (cams_auto[-n_new:] / self.MPU) @ R.T + t) * self.MPU
        np.testing.assert_allclose(cams_adj[-n_new:], expect, atol=1e-9)
        np.testing.assert_array_equal(cams_adj[:-n_new], cams_auto[:-n_new])      # the route itself does not move
        # rows: every run's range in the file, one after another, covering it
        rows = [c["rows"] for c in m["clips"]]
        self.assertEqual(rows[0][0], 0)
        self.assertEqual([r[0] for r in rows[1:]], [r[1] for r in rows[:-1]])
        self.assertEqual(rows[-1][1], res["gaussians"])
        # going back to no adjustment gives the automatic result again, bytes and all
        again = self.tmp / "route_back.ply"
        route_gs.adjust_route(adjusted, m, {}, again)
        self.assertEqual(again.read_bytes(), auto.read_bytes())
        # and an extend run told the adjustment writes what adjusting afterwards wrote
        with mock.patch.object(route_gs, "_extension_run", wraps=route_gs._extension_run):
            direct, _ = self._extend(manifest, core, list(range(30, 36)), "end", adjustments={key: adj})
        self.assertEqual(direct.read_bytes(), adjusted.read_bytes())

    def test_a_route_in_another_unit_keeps_its_shape(self):
        """scale_route: every gaussian and camera k times as far from the route's origin and every gaussian k times as
        large; recomposing the scaled manifest gives the scaled route, so the unit is all that changed."""
        import json
        a_idx, b_idx = list(range(10, 22)), list(range(22, 30))
        self.world_of = {}
        manifest, core = self._route(a_idx, b_idx)
        route_gs._write_route_sidecars(core, self.core_cams, [], 0, self.MPU, "test")      # what a build writes
        core.with_name(core.stem + "_route.json").write_text(json.dumps(manifest))
        out = self.tmp / "route_scaled.ply"
        res = route_gs.scale_route(core, manifest, self.MPU / 2, out)
        self.assertAlmostEqual(res["scale"], 0.5)
        _, names, a = route_gs.read_ply(core)
        _, names2, b = route_gs.read_ply(out)
        self.assertEqual(names, names2)
        xyz = [names.index(c) for c in "xyz"]
        sc = [names.index(f"scale_{i}") for i in range(3)]
        np.testing.assert_array_equal(b[:, xyz], a[:, xyz] * 0.5)
        np.testing.assert_allclose(b[:, sc], a[:, sc] + math.log(0.5), atol=1e-5)
        rest = [i for i in range(len(names)) if i not in xyz + sc]
        np.testing.assert_array_equal(b[:, rest], a[:, rest])
        cams = np.array(json.loads(out.with_name(out.stem + "_cams.json").read_text()))
        np.testing.assert_allclose(cams, np.array(self.core_cams) * 0.5, atol=1e-12)
        side = json.loads(out.with_suffix(".json").read_text())
        old = json.loads(core.with_suffix(".json").read_text())
        self.assertAlmostEqual(side["route_length_m"], old["route_length_m"] * 0.5)
        self.assertEqual(side["metres_per_unit"], self.MPU / 2)
        sm = json.loads(out.with_name(out.stem + "_route.json").read_text())
        self.assertEqual(sm["metres_per_unit"], self.MPU / 2)
        again = self.tmp / "again.ply"
        route_gs.recompose_route(sm, again)
        _, _, c = route_gs.read_ply(again)
        np.testing.assert_allclose(c[:, xyz], b[:, xyz], atol=1e-6)

    def test_scaling_an_adjusted_route_scales_its_core_and_its_metres(self):
        """A route with a hand-adjusted clip at its end: its core is scaled beside it and named by the new manifest,
        the adjustment's metres are scaled, and adjusting again in the new unit gives the scaled route back."""
        import json
        a_idx, b_idx = list(range(10, 22)), list(range(22, 30))
        self.world_of = {str(self.tmp / "A.mp4"): a_idx, str(self.tmp / "B.mp4"): b_idx}
        manifest, core = self._route(a_idx, b_idx)
        key = str(self.tmp / "new.mp4")
        adj = {"scale": 1.05, "yaw": 5.0, "right": 0.2, "up": -0.1, "forward": 0.5}
        auto, _ = self._extend(manifest, core, list(range(30, 36)), "end")
        adjusted = self.tmp / "route_adjusted.ply"
        route_gs.adjust_route(auto, json.loads(auto.with_name(auto.stem + "_route.json").read_text()), {key: adj},
                              adjusted)
        m = json.loads(adjusted.with_name(adjusted.stem + "_route.json").read_text())
        out = self.tmp / "route_adj_scaled.ply"
        res = route_gs.scale_route(adjusted, m, self.MPU * 2, out)
        sm = json.loads(out.with_name(out.stem + "_route.json").read_text())
        self.assertEqual((sm["core_ply"], res["core_ply"]), (out.stem + "_core.ply", out.stem + "_core.ply"))
        _, names, c0 = route_gs.read_ply(core)
        _, _, c1 = route_gs.read_ply(out.with_name(sm["core_ply"]))
        xyz = [names.index(c) for c in "xyz"]
        np.testing.assert_array_equal(c1[:, xyz], c0[:, xyz] * 2)
        new_adj = sm["clips"][-1]["adjust"]
        self.assertEqual(new_adj, {"scale": 1.05, "yaw": 5.0, "right": 0.4, "up": -0.2, "forward": 1.0})
        self.assertEqual(sm["extensions"][0]["adjust"], new_adj)
        again = self.tmp / "route_adj_scaled_again.ply"
        route_gs.adjust_route(out, sm, {key: new_adj}, again)
        _, _, a = route_gs.read_ply(out)
        _, _, b = route_gs.read_ply(again)
        np.testing.assert_allclose(b[:, xyz], a[:, xyz], atol=1e-6)

    def test_an_added_clip_is_painted_like_the_route(self):
        """On a route whose people were painted over, a clip added at its end is painted too (its own frames; the
        route's frames it repeats are painted already) and reconstructed with no mask, keyed apart from a masked one."""
        a_idx, b_idx = list(range(10, 22)), list(range(22, 30))
        self.world_of = {str(self.tmp / "A.mp4"): a_idx, str(self.tmp / "B.mp4"): b_idx}
        manifest, core = self._route(a_idx, b_idx)
        for c in manifest["clips"]:                      # built with masks
            (Path(c["cache"]) / "masks").mkdir(exist_ok=True)
            for n in c["own"]:
                (Path(c["cache"]) / "masks" / n).write_bytes(b"m")
        calls, wm_calls, dirs = {}, [], []

        def fake_paint_masks(clip, cdir, own, own_idx, lo, hi, width, masks, job=None, should_stop=None):
            masks.mkdir(parents=True, exist_ok=True)
            for f in own:
                (masks / f.name).write_bytes(b"m")
            calls["masks"] = (lo, hi)
            dirs.append(cdir.name)
            return list(range(lo, hi))

        def fake_paint_own(cdir, own, own_idx, pp_idx, masks, should_stop=None):
            calls["own"] = [f.name for f in own]

        def fake_collect(job, frames_dir, mask_dir, should_stop=None, indices=None, **kw):
            mask_dir.mkdir(parents=True, exist_ok=True)

        common = dict(sam3_submit=mock.Mock(return_value={}), sam3_collect=fake_collect, add_box_masks=mock.Mock(),
                      _paint_masks=fake_paint_masks, _paint_own=fake_paint_own, comfy_free=mock.Mock(),
                      _propainter_python=mock.Mock(return_value=Path("py")), _frame_count=mock.Mock(return_value=48))
        manifest["settings"] = {"shared": self.K, "inpaint": "propainter"}
        with mock.patch.multiple(route_gs, **common):
            self._extend(manifest, core, list(range(30, 36)), "end", wm_calls=wm_calls)
        self.assertEqual(calls["masks"], (0, 48))                       # the whole added clip, consecutively
        self.assertEqual(calls["own"], [f"b_{j + 1:03d}.png" for j in range(6)])
        self.assertEqual(wm_calls, [None])                              # painted: nothing to drop
        # the same clip on a masked route: masks, no painting, another cache entry
        manifest["settings"] = {"shared": self.K}
        calls.clear()
        with mock.patch.multiple(route_gs, **common):
            self._extend(manifest, core, list(range(30, 36)), "end", wm_calls=wm_calls)
        self.assertNotIn("own", calls)
        self.assertIsNotNone(wm_calls[-1])
        exts = sorted(d.name for d in (self.tmp / "cache").glob("ext_*"))
        self.assertEqual(len(exts), 2)

    def test_recompose_is_what_the_merge_wrote(self):
        a_idx, b_idx = list(range(10, 22)), list(range(22, 30))
        self.world_of = {}
        manifest, core = self._route(a_idx, b_idx)
        n, _ = route_gs.recompose_route(manifest, self.tmp / "again.ply")
        self.assertEqual((self.tmp / "again.ply").read_bytes(), core.read_bytes())
        self.assertGreater(n, 100)


class SharedCount(unittest.TestCase):
    """An added clip is aligned through enough of the route's frames at that end to span SHARED_MIN_M."""
    def run_of(self, step_m: float, n: int = 30, mpu: float = 30.5) -> dict:
        cams = []
        for i in range(n):
            c = np.eye(4)
            c[2, 3] = i * step_m / mpu
            cams.append(c)
        return {"cams": np.array(cams), "n_shared": 5, "n_tail": 0}

    def test_more_frames_when_the_walk_is_slow(self):
        T = (1.0, np.eye(3), np.zeros(3))
        self.assertEqual(route_gs._shared_count(self.run_of(2.0), T, True, 5, 30.5), 5)      # 8 m in 5 frames
        self.assertEqual(route_gs._shared_count(self.run_of(0.8), T, True, 5, 30.5), 8)      # 5.6 m needs 8
        self.assertEqual(route_gs._shared_count(self.run_of(0.3), T, False, 5, 30.5), route_gs.SHARED_MAX)


class Adjustment(unittest.TestCase):
    """A hand adjustment is about the seam camera, in its own directions."""
    def setUp(self):
        self.C = _rot_y(30) @ np.array([[1.0, 0, 0], [0, math.cos(0.2), -math.sin(0.2)], [0, math.sin(0.2), math.cos(0.2)]])
        self.p = np.array([1.0, -0.2, 3.0])

    def apply(self, adj, x, upm=0.5):
        s, R, t = route_gs.adjustment(adj, self.p, self.C, upm)
        return s * (R @ x) + t

    def test_the_seam_camera_stays_put(self):
        np.testing.assert_allclose(self.apply({"scale": 1.2, "yaw": 7, "pitch": -3, "roll": 2}, self.p), self.p, atol=1e-12)

    def test_directions(self):
        ahead = self.p + self.C @ np.array([0, 0, 2.0])              # 2 units straight ahead of the seam camera
        local = lambda x: self.C.T @ (x - self.p)
        np.testing.assert_allclose(local(self.apply({"yaw": 90}, ahead)), [2, 0, 0], atol=1e-12)     # now to its right
        np.testing.assert_allclose(local(self.apply({"pitch": 90}, ahead)), [0, -2, 0], atol=1e-12)  # up is -y
        np.testing.assert_allclose(local(self.apply({"scale": 1.5}, ahead)), [0, 0, 3], atol=1e-12)
        np.testing.assert_allclose(local(self.apply({"forward": 1.0, "right": 2.0, "up": 1.0}, ahead, upm=0.5)),
                                   [1.0, -0.5, 2.5], atol=1e-12)
        right = self.p + self.C @ np.array([1.0, 0, 0])
        np.testing.assert_allclose(local(self.apply({"roll": 90}, right)), [0, 1, 0], atol=1e-12)    # right side down


@unittest.skipUnless(__import__("shutil").which("node"), "node is not installed")
class AdjustParity(unittest.TestCase):
    """gs_route_adjust.js (the viewer's live preview) does the sums route_gs.adjustment() does."""
    def test_viewer_and_backend_agree(self):
        import json
        rng = np.random.default_rng(5)
        cases = []
        for _ in range(6):
            q = rng.normal(size=4)
            C = _quat_matrix(q)
            cur = {k: float(v) for k, v in zip(route_gs.ADJUST_KEYS, [1 + rng.uniform(-.1, .1), *rng.uniform(-8, 8, 3), *rng.uniform(-2, 2, 3)])}
            nxt = {k: float(v) for k, v in zip(route_gs.ADJUST_KEYS, [1 + rng.uniform(-.1, .1), *rng.uniform(-8, 8, 3), *rng.uniform(-2, 2, 3)])}
            cases.append({"cur": cur, "next": nxt, "pivot": rng.normal(size=3).tolist(), "axes": C.tolist(),
                          "upm": float(rng.uniform(0.01, 3)), "pts": rng.normal(size=(5, 3)).tolist()})
        harness = (Path(route_gs.__file__).with_name("gs_route_adjust.js").read_text(encoding="utf-8") +
                   "\nconst cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));\n"
                   "console.log(JSON.stringify(cases.map((c) => ({a: routeAdjustment(c.next, c.pivot, c.axes, c.upm),\n"
                   "  d: routeAdjustDelta(c.next, c.cur, c.pivot, c.axes, c.upm)}))));\n")
        tmp = Path(tempfile.mkdtemp()) / "parity.cjs"
        tmp.write_text(harness, encoding="utf-8")
        out = subprocess.run([__import__("shutil").which("node"), str(tmp)], input=json.dumps(cases),
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        for c, js in zip(cases, json.loads(out.stdout)):
            s, R, t = route_gs.adjustment(c["next"], c["pivot"], c["axes"], c["upm"])
            self.assertAlmostEqual(js["a"]["s"], s, places=12)
            np.testing.assert_allclose(np.array(js["a"]["R"]), R, atol=1e-12)
            np.testing.assert_allclose(np.array(js["a"]["t"]), t, atol=1e-12)
            # the preview object moves what was written with `cur` to where `next` puts it
            s0, R0, t0 = route_gs.adjustment(c["cur"], c["pivot"], c["axes"], c["upm"])
            d = js["d"]
            Rq = _quat_matrix(np.array([d["rotation"][3], *d["rotation"][:3]]))       # [x y z w] -> w x y z
            for x in np.array(c["pts"]):
                shown = s0 * (R0 @ x) + t0
                np.testing.assert_allclose(d["scale"] * (Rq @ shown) + np.array(d["position"]), s * (R @ x) + t, atol=1e-9)


class EndMatch(unittest.TestCase):
    def test_only_the_frames_at_that_end_count(self):
        import cv2
        tmp = Path(tempfile.mkdtemp())
        rng = np.random.default_rng(4)
        clips, scenes = [], {}
        for ci in range(2):
            frames = tmp / f"clip{ci}" / "frames"
            frames.mkdir(parents=True)
            own = []
            for j in range(8):
                im = np.full((360, 640, 3), 40, np.uint8)
                for _ in range(120):
                    x, y = int(rng.integers(0, 620)), int(rng.integers(0, 340))
                    w, h = int(rng.integers(8, 60)), int(rng.integers(8, 60))
                    cv2.rectangle(im, (x, y), (x + w, y + h), tuple(int(c) for c in rng.integers(60, 255, 3)), -1)
                name = f"b_{j + 1:03d}.png"
                cv2.imwrite(str(frames / name), im)
                own.append(name)
                scenes[(ci, j)] = im
            clips.append({"cache": str(tmp / f"clip{ci}"), "own": own, "n_shared": 0 if ci == 0 else 2})
        manifest = {"clips": clips}

        def shot(ci, j):
            q = cv2.warpAffine(cv2.convertScaleAbs(scenes[(ci, j)], alpha=0.85, beta=20),
                               np.float32([[1.01, 0, -5], [0, 1.01, 4]]), (640, 360))
            p = tmp / f"q_{ci}_{j}.png"
            cv2.imwrite(str(p), q)
            return p

        self.assertTrue(route_gs._end_match(shot(1, 7), manifest, True, 2, "q")["ok"])     # the route's last frame
        self.assertTrue(route_gs._end_match(shot(1, 6), manifest, True, 2, "q")["ok"])     # within the last k = 2
        self.assertFalse(route_gs._end_match(shot(1, 4), manifest, True, 2, "q")["ok"])    # further in: a branch
        self.assertTrue(route_gs._end_match(shot(0, 0), manifest, False, 2, "q")["ok"])    # the route's first frame
        self.assertFalse(route_gs._end_match(shot(0, 0), manifest, True, 2, "q")["ok"])    # ...is not its end
        self.assertFalse(route_gs._end_match(shot(0, 5), manifest, False, 2, "q")["ok"])



class ClipParts(unittest.TestCase):
    """A clip too long for one run at a useful frame gap is reconstructed in parts; clips that always fitted keep
    their single run (and their cache key)."""

    def test_clips_that_fitted_stay_one_run(self):
        self.assertEqual(route_gs._clip_parts(707, 59.94, 9, 36, 31), [None])    # d4: 11.8 s of the original game
        self.assertEqual(route_gs._clip_parts(707, 59.94, 9, 31, 31), [None])    # ... after the first clip
        self.assertEqual(route_gs._clip_parts(360, 24.0, 9, 31, 31), [None])     # a 15 s H3 clip
        self.assertEqual(route_gs._clip_parts(300, 24.0, 9, 36, 31), [None])     # the step, not the budget, sets the gap

    def test_a_long_clip_is_split_into_parts_that_tile_it(self):
        parts = route_gs._clip_parts(1679, 59.94, 9, 36, 31)      # route-gs-1136: 28 s, 0.78 s apart in one run
        self.assertEqual(len(parts), 3)
        self.assertEqual(parts[0][0], 0)
        self.assertEqual(parts[-1][1], 1679)
        for (a, b), (c, d) in zip(parts, parts[1:]):
            self.assertEqual(b, c)
        for a, b in parts:      # sampled at most PART_GAP_S apart with the frames a later part has of its own
            self.assertLessEqual((b - a) / 31 / 59.94, route_gs.PART_GAP_S + 1e-9)

    def test_a_swing_asks_for_more_frames_and_no_cut_lands_in_it(self):
        flow = np.full(1679, 0.0015)       # a walk: 0.15 % of the width a frame
        flow[515:526] = 0.0                # a still moment near the first cut
        flow[1100:1180] = 0.02             # a swing, 13x the walk (route-gs-1136 at 720.5 s: 0.0127)
        parts = route_gs._clip_parts(1679, 59.94, 9, 36, 31, flow)
        self.assertEqual(len(parts), 4)    # 80 frames for the time, 16 more for the swing: 96 at 31 a part
        self.assertLessEqual(abs(parts[0][1] - 520), 15)     # in the still moment (smoothed over half a second)
        for a, b in parts[1:]:
            self.assertFalse(1100 - 10 <= a <= 1180 + 5, a)

    def test_samples_keep_both_gaps_through_a_swing(self):
        fps, flow = 59.94, np.full(1200, 0.0015)
        flow[600:660] = 0.0127
        d = route_gs._demand(1200, fps, 9, flow)
        idx = route_gs.pick_frame_indices(1200, int(math.ceil(d.sum())), d, mix=1.0)
        cum = np.cumsum(flow)
        self.assertLessEqual(max(np.diff(idx)), route_gs.PART_GAP_S * fps + 1)
        # within a frame's worth of motion of GAP_FLOW (samples fall on whole frames)
        self.assertLessEqual(max(cum[j] - cum[i] for i, j in zip(idx, idx[1:])), route_gs.GAP_FLOW + flow.max())
        inside = [i for i in idx if 600 <= i < 660]
        self.assertGreaterEqual(len(inside), 9)          # 0.76 widths of swing at 0.08 a gap


class FlowProfile(unittest.TestCase):
    def test_a_pan_reads_as_its_shift(self):
        """A picture held still, panned 4 px a frame for 40 frames, held again: the profile reads the pan as
        4/320 of the width a frame and the still stretches as nothing."""
        import shutil
        import subprocess as sp
        if not shutil.which("ffmpeg"):
            self.skipTest("needs ffmpeg")
        import cv2
        tmp = Path(tempfile.mkdtemp())
        rng = np.random.default_rng(6)
        big = cv2.GaussianBlur(rng.integers(0, 255, (180, 900), dtype=np.uint8), (5, 5), 0)
        xs = [0] * 30 + [4 * k for k in range(1, 41)] + [160] * 30
        raw = b"".join(np.ascontiguousarray(big[:, x:x + 320]).tobytes() for x in xs)
        clip = tmp / "pan.mp4"
        sp.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", "320x180", "-r", "30",
                "-i", "-", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", str(clip)], input=raw, check=True)
        f = route_gs._flow_profile(clip, len(xs))
        self.assertAlmostEqual(float(np.median(f[35:65])), 4 / 320, delta=0.25 * 4 / 320)
        self.assertLess(float(np.median(f[2:28])), 0.1 * 4 / 320)
        self.assertLess(float(np.median(f[75:98])), 0.1 * 4 / 320)


class PoseBreaks(unittest.TestCase):
    def test_a_jump_is_reported_and_nothing_across_clips(self):
        route = [[0.0, 0.0, 1.5 * i] for i in range(10)]
        times = [(0, 0.5 * i) for i in range(10)]
        route[7:] = [[0.0, 0.0, z - 20.0] for _, _, z in route[7:]]        # frames 7.. put 20 m back
        out = route_gs._pose_breaks(route, times)
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0]["clip"], out[0]["from_s"], out[0]["to_s"]), (0, 3.0, 3.5))
        self.assertAlmostEqual(out[0]["jump_m"], 18.5, places=6)
        # the same jump where a new clip starts is not timed, so not reported
        times2 = [(0, 0.5 * i) for i in range(7)] + [(1, 0.5 * i) for i in range(3)]
        self.assertEqual(route_gs._pose_breaks(route, times2), [])
        self.assertEqual(route_gs._pose_breaks([[0, 0, 0.1 * i] for i in range(10)], [(0, 0.1 * i) for i in range(10)]), [])


class BuildInParts(unittest.TestCase):
    """One long clip built in parts: each part is its own run, chained through the frames it repeats from the part
    before; every own camera lands where the world has it, and the manifest names each part's frame range."""

    def test_one_long_clip_in_three_parts(self):
        import json
        tmp = Path(tempfile.mkdtemp())
        clip = tmp / "long.mp4"
        clip.write_bytes(b"a long clip")
        total, fps = 1679, 59.94
        rng = np.random.default_rng(5)
        world = []
        for i in range(total):                    # a walk along z with a little wander and yaw
            c = np.eye(4)
            c[:3, :3] = _rot_y(10 * math.sin(i / 90))
            c[:3, 3] = [0.3 * math.sin(i / 200), 0.02 * math.sin(i / 50), 0.004 * i]
            world.append(c)
        sampled = []

        def fake_sample(video, out_dir, step, max_frames, width=704, adaptive=True, ends=False, part=None, demand=None):
            lo, hi = part if part else (0, total)
            count = min(max_frames, math.ceil((hi - lo) / step))
            idx = [int(round(v)) for v in np.linspace(lo, hi - 1, count)]
            out_dir.mkdir(parents=True, exist_ok=True)
            files = []
            for j, fi in enumerate(idx):
                f = out_dir / f"b_{j + 1:03d}.png"
                f.write_text(str(fi))                  # the fake reconstruction reads the frame number back
                files.append(f)
            (out_dir / "indices.json").write_text(json.dumps(idx))
            sampled.append((part, len(idx)))
            return files

        def fake_worldmirror(frames_dir, out_dir, mask_dir=None, should_stop=None, timeout=0):
            names = sorted(Path(frames_dir).glob("*.png"))      # a_* (repeated) sort before b_* (own)
            idx = [int(f.read_text()) for f in names]
            truth = ((float(rng.uniform(0.5, 2.0)), _rot_y(float(rng.uniform(-60, 60))), rng.uniform(-1, 1, 3))
                     if names[0].name.startswith("a_") else (1.0, np.eye(3), np.zeros(3)))   # the route frame is run 0's
            pts = np.array([[x, 0.0, 0.004 * i] for i in range(min(idx), max(idx) + 1, 20) for x in (-1.0, 1.0)])
            return _write_run(Path(out_dir) / "run", [world[i] for i in idx], pts, truth)

        still = np.zeros(total)           # no image motion: the parts follow time alone
        with mock.patch.multiple(route_gs, sample_frames=fake_sample, run_worldmirror=fake_worldmirror,
                                 _probe=mock.Mock(return_value=(fps, 1376, 774)),
                                 _frame_count=mock.Mock(return_value=total),
                                 _flow_profile=mock.Mock(return_value=still)):
            out = tmp / "route.ply"
            res = route_gs.build_route_gaussian([clip], out, tmp / "work", cache_dir=tmp / "cache", metres_per_unit=1.0)
        self.assertEqual(res["runs"], 3)
        self.assertEqual(res["pose_breaks"], [])
        self.assertEqual([n for _, n in sampled], [36, 31, 31])
        man = json.loads(out.with_name("route_route.json").read_text())
        parts = [c["part"] for c in man["clips"]]
        self.assertEqual([p[0] for p in parts], [0, parts[0][1], parts[1][1]])
        self.assertEqual(parts[-1][1], total)
        self.assertEqual([c["n_shared"] for c in man["clips"]], [0, 5, 5])
        for c in man["clips"]:          # frame numbers count from the clip's first frame, inside the part
            self.assertTrue(all(c["part"][0] <= i < c["part"][1] for i in c["indices"]))
        # every own camera of every part lands on its world camera (metres_per_unit 1: metres = world units)
        cams = json.loads(out.with_name("route_cams.json").read_text())
        own = [i for c in man["clips"] for i in c["indices"]]
        np.testing.assert_allclose(np.array(cams), np.array([world[i][:3, 3] for i in own]), atol=1e-6)
        side = json.loads(out.with_suffix(".json").read_text())
        self.assertEqual((side["runs"], side["pose_breaks"]), (3, []))
        self.assertIn("1 clips in 3 runs", side["source"])
        # built again: every part comes from the cache, nothing is sampled or reconstructed
        sampled.clear()
        with mock.patch.multiple(route_gs, sample_frames=fake_sample,
                                 run_worldmirror=mock.Mock(side_effect=AssertionError("reconstructed again")),
                                 _probe=mock.Mock(return_value=(fps, 1376, 774)),
                                 _frame_count=mock.Mock(return_value=total),
                                 _flow_profile=mock.Mock(return_value=still)):
            again = route_gs.build_route_gaussian([clip], tmp / "again.ply", tmp / "work2", cache_dir=tmp / "cache",
                                                  metres_per_unit=1.0)
        self.assertEqual((sampled, again["runs"]), ([], 3))
        self.assertEqual((tmp / "again.ply").read_bytes(), out.read_bytes())


class Inpainting(unittest.TestCase):
    """With inpaint_people the people are painted over before reconstruction: only the masked pixels change, the
    reconstruction gets the painted frames and no mask, the repeated frames are the painted ones, and the cache
    tells a painted run from a masked one."""

    def test_only_the_masked_pixels_change(self):
        from PIL import Image
        tmp = Path(tempfile.mkdtemp())
        rng = np.random.default_rng(7)
        a = rng.integers(0, 255, (60, 80, 3), dtype=np.uint8)
        b = rng.integers(0, 255, (60, 80, 3), dtype=np.uint8)
        m = np.zeros((60, 80), np.uint8)
        m[20:40, 30:50] = 255
        Image.fromarray(a).save(tmp / "a.png")
        Image.fromarray(b).save(tmp / "b.png")
        Image.fromarray(m).save(tmp / "m.png")
        route_gs.composite_inpainted(tmp / "a.png", tmp / "b.png", tmp / "m.png", tmp / "c.png", grow=4)
        c = np.asarray(Image.open(tmp / "c.png").convert("RGB"))
        far = np.ones((60, 80), bool)
        far[12:48, 22:58] = False                      # beyond the grown, feathered edge
        np.testing.assert_array_equal(c[far], a[far])
        np.testing.assert_array_equal(c[24:36, 34:46], b[24:36, 34:46])

    def test_the_cache_key_tells_painted_from_masked(self):
        clip = Path(tempfile.mkdtemp()) / "c.mp4"
        clip.write_bytes(b"clip")
        args = (clip, "", 9, 5, 36, True, True, False, 0, 704)
        self.assertEqual(route_gs._clip_key(*args), route_gs._clip_key(*args, inpaint=False))
        self.assertNotEqual(route_gs._clip_key(*args), route_gs._clip_key(*args, inpaint=True))

    def test_a_long_clip_painted_part_by_part(self):
        import json
        from PIL import Image
        tmp = Path(tempfile.mkdtemp())
        clip = tmp / "long.mp4"
        clip.write_bytes(b"a long clip")
        total, fps = 1679, 59.94
        world = []
        for i in range(total):
            c = np.eye(4)
            c[:3, :3] = _rot_y(10 * math.sin(i / 90))
            c[:3, 3] = [0.3 * math.sin(i / 200), 0.02 * math.sin(i / 50), 0.004 * i]
            world.append(c)

        def frame(i: int, painted: bool = False) -> Image.Image:
            # the frame number in the corner (never masked), a person in the middle (or what was painted there)
            im = np.full((8, 16, 3), 40, np.uint8)
            im[0, 0] = [i % 256, i // 256, 0]
            im[2:6, 5:11] = [200, 200, 200] if painted else [255, 0, 0]
            return Image.fromarray(im)

        def fake_sample(video, out_dir, step, max_frames, width=704, adaptive=True, ends=False, part=None, demand=None):
            lo, hi = part if part else (0, total)
            idx = [int(round(v)) for v in np.linspace(lo, hi - 1, min(max_frames, math.ceil((hi - lo) / step)))]
            out_dir.mkdir(parents=True, exist_ok=True)
            files = []
            for j, fi in enumerate(idx):
                f = out_dir / f"b_{j + 1:03d}.png"
                frame(fi).save(f)
                files.append(f)
            (out_dir / "indices.json").write_text(json.dumps(idx))
            return files

        def fake_dense(video, out_dir, lo, hi, every, also, width):
            idx = sorted(set(range(lo, hi, every)) | {i for i in also if lo <= i < hi})
            out_dir.mkdir(parents=True, exist_ok=True)
            for n, fi in enumerate(idx):
                frame(fi).save(out_dir / f"b_{n + 1:05d}.png")
            return idx

        def fake_collect(job, frames_dir, mask_dir, should_stop=None, indices=None, **kw):
            mask_dir.mkdir(parents=True, exist_ok=True)
            m = np.zeros((8, 16), np.uint8)
            m[2:6, 5:11] = 255
            for f in sorted(frames_dir.glob("b_*.png")):
                Image.fromarray(m).save(mask_dir / f.name)

        painted_runs = []

        def fake_inpaint(frames_dir, mask_dir, out_dir, should_stop=None, timeout=0):
            out_dir.mkdir(parents=True, exist_ok=True)
            files = []
            for k, f in enumerate(sorted(frames_dir.glob("*.png"))):
                i = int(np.asarray(Image.open(f))[0, 0, 0]) + 256 * int(np.asarray(Image.open(f))[0, 0, 1])
                g = out_dir / f"{k:04d}.png"
                frame(i, painted=True).save(g)
                files.append(g)
            painted_runs.append(len(files))
            return files

        wm_calls = []

        def fake_worldmirror(frames_dir, out_dir, mask_dir=None, should_stop=None, timeout=0):
            names = sorted(Path(frames_dir).glob("*.png"))
            px = [np.asarray(Image.open(f).convert("RGB")) for f in names]
            wm_calls.append({"mask_dir": mask_dir, "names": [f.name for f in names],
                             "centres": [tuple(int(v) for v in im[3, 7]) for im in px]})
            idx = [int(im[0, 0, 0]) + 256 * int(im[0, 0, 1]) for im in px]
            truth = (1.0, np.eye(3), np.zeros(3)) if not names[0].name.startswith("a_") else (1.3, _rot_y(20), np.array([0.1, 0, 0.2]))
            pts = np.array([[x, 0.0, 0.004 * i] for i in range(min(idx), max(idx) + 1, 20) for x in (-1.0, 1.0)])
            return _write_run(Path(out_dir) / "run", [world[i] for i in idx], pts, truth)

        with mock.patch.multiple(route_gs, sample_frames=fake_sample, run_worldmirror=fake_worldmirror,
                                 dense_frames=fake_dense, sam3_submit=mock.Mock(return_value={}),
                                 sam3_collect=fake_collect, add_box_masks=mock.Mock(), comfy_free=mock.Mock(),
                                 inpaint_frames=fake_inpaint, _propainter_python=mock.Mock(return_value=Path("py")),
                                 _probe=mock.Mock(return_value=(fps, 1376, 774)),
                                 _frame_count=mock.Mock(return_value=total),
                                 _flow_profile=mock.Mock(return_value=np.zeros(total))):
            out = tmp / "route.ply"
            res = route_gs.build_route_gaussian([clip], out, tmp / "work", cache_dir=tmp / "cache", metres_per_unit=1.0,
                                                mask_people=True, inpaint_people=True)
        self.assertEqual(res["runs"], 3)
        self.assertEqual(len(painted_runs), 3)
        for call in wm_calls:
            self.assertIsNone(call["mask_dir"])                       # painted frames: nothing left to drop
            self.assertEqual(set(call["centres"]), {(200, 200, 200)})   # every frame, repeated ones too, painted
        self.assertTrue(any(n.startswith("a_") for n in wm_calls[1]["names"]))
        man = json.loads(out.with_name("route_route.json").read_text())
        self.assertEqual(man["settings"]["inpaint"], "propainter")
        # the frames as sampled are kept beside the painted ones, and the poses still land on the world
        self.assertTrue((Path(man["clips"][0]["cache"]) / "frames_masked" / "b_001.png").exists())
        cams = json.loads(out.with_name("route_cams.json").read_text())
        own = [i for c in man["clips"] for i in c["indices"]]
        np.testing.assert_allclose(np.array(cams), np.array([world[i][:3, 3] for i in own]), atol=1e-6)


class SeamFill(unittest.TestCase):
    """At a seam the later run often has nothing for the first metre or two (its first frames do not see the ground
    there); the earlier run does but is cut at the plane. With seam_fill it keeps what fills that gap, and only that."""

    def test_the_gap_past_a_seam_is_filled_and_nothing_doubles(self):
        tmp = Path(tempfile.mkdtemp())
        ident = (1.0, np.eye(3), np.zeros(3))
        def cams(z0, z1, n):                             # looking down +z, walking along it
            out = []
            for z in np.linspace(z0, z1, n):
                c = np.eye(4)
                c[2, 3] = z
                out.append(c)
            return out
        ground = lambda z0, z1: np.array([[x, 0.2, z] for z in np.arange(z0, z1, 0.01) for x in np.arange(-0.2, 0.2001, 0.01)])
        a = _write_run(tmp / "a", cams(0.0, 1.0, 11), ground(0.0, 1.6), ident)        # seam plane at z = 1.1
        b = _write_run(tmp / "b", cams(0.8, 2.0, 13), ground(1.4, 2.5), ident)        # nothing before z = 1.4
        runs = [{"dir": a, "cams": route_gs._run_cams(a), "n_shared": 0},
                {"dir": b, "cams": route_gs._run_cams(b), "n_shared": 3}]
        T = [ident, ident]
        mpu = 10.0                                        # 0.3 m = 0.03 units: three grid steps
        f = mpu * route_gs.SCENE_SCALE

        def zs(path):
            _, names, d = route_gs.read_ply(path)
            return d[:, names.index("z")] / f, d

        _, rows0 = route_gs._merge_runs(runs, T, tmp / "cut.ply", mpu)[1:]
        z0, _ = zs(tmp / "cut.ply")
        self.assertEqual(int(((z0 > 1.11) & (z0 < 1.39)).sum()), 0)                  # the band, as it was
        _, rows1 = route_gs._merge_runs(runs, T, tmp / "filled.ply", mpu, seam_fill=True)[1:]
        z1, _ = zs(tmp / "filled.ply")
        a_rows = slice(rows1[0][0], rows1[0][1])
        za = z1[a_rows]
        self.assertGreater(int(((za > 1.11) & (za < 1.36)).sum()), 0.9 * 25 * 41)     # the band comes from run a ...
        self.assertEqual(int((za > 1.40).sum()), 0)                                   # ... and stops where b begins
        zb = z1[rows1[1][0]:rows1[1][1]]
        self.assertEqual(int((zb <= 1.1).sum()), 0)                                    # b adds nothing behind: a has it
        # off by default: what a recompose of an older route writes
        route_gs._merge_runs(runs, T, tmp / "again.ply", mpu)
        self.assertEqual((tmp / "again.ply").read_bytes(), (tmp / "cut.ply").read_bytes())

if __name__ == "__main__":
    unittest.main()
