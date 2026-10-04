"""world_gen: FlashWorld trajectories and ply pruning (no FlashWorld needed)."""
import math
import tempfile
import unittest
from pathlib import Path

import numpy as np

import world_gen as wg


def _rot(q):
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])


class TrajectoryTest(unittest.TestCase):
    def test_every_trajectory_starts_at_the_picture(self):
        for kind in wg.TRAJECTORIES:
            cams = wg.build_trajectory(kind, 1376, 768)
            self.assertEqual(len(cams), wg.N_FRAMES)
            self.assertTrue(np.allclose(cams[0]["position"], [0, 0, 0]))
            for c in cams:
                self.assertAlmostEqual(np.linalg.det(_rot(c["quaternion"])), 1.0, places=6)
            # frame 0 looks straight ahead (+z world); FlashWorld cameras look down their -z
            self.assertTrue(np.allclose(_rot(cams[0]["quaternion"])[:, 2], [0, 0, -1]))
            self.assertEqual((cams[0]["cx"], cams[0]["cy"]), (688, 384))

    def test_ring_stays_on_its_circle_and_looks_out(self):
        centre = np.array([0, 0, -1.5])
        for c in wg.build_trajectory("ring", 1376, 768, radius=1.5):
            p = np.array(c["position"])
            self.assertTrue(math.isclose(np.linalg.norm(p - centre), 1.5, abs_tol=1e-6))
            self.assertGreater(np.dot(-_rot(c["quaternion"])[:, 2], (p - centre) / 1.5), 0.999)

    def test_pan_still_moves_a_little(self):
        """FlashWorld scales the splat by the farthest camera's distance: cameras that stay put give an empty one."""
        far = max(np.linalg.norm(c["position"]) for c in wg.build_trajectory("pan", 1376, 768))
        self.assertGreater(far, 0.1)

    def test_orbit_pushes_in_then_arcs_left(self):
        cams = wg.build_trajectory("orbit", 1376, 768, distance=10.0, degrees=90.0)
        last_push = cams[wg.N_FRAMES // 3 - 1]["position"]
        self.assertGreater(last_push[2], 3.0)
        self.assertAlmostEqual(last_push[0], 0.0)
        self.assertLess(cams[-1]["position"][0], -4.9)   # ends 90 deg left of the pivot

    def test_bad_trajectory(self):
        with self.assertRaises(ValueError):
            wg.build_trajectory("spiral", 100, 100)


class PruneTest(unittest.TestCase):
    def test_keeps_the_most_opaque(self):
        names = ["x", "y", "z", "opacity"]
        rows = np.array([[i, 0, 0, op] for i, op in enumerate([0.1, 5.0, -3.0, 2.0])], np.float32)
        head = b"ply\nformat binary_little_endian 1.0\nelement vertex 4\n" + b"".join(
            b"property float %s\n" % n.encode() for n in names) + b"end_header\n"
        with tempfile.TemporaryDirectory() as d:
            src, dst = Path(d) / "a.ply", Path(d) / "b.ply"
            src.write_bytes(head + rows.tobytes())
            self.assertEqual(wg.prune_ply(src, dst, 2, to_camera_frame=False), 2)
            raw = dst.read_bytes()
        self.assertIn(b"element vertex 2\n", raw)
        body = np.frombuffer(raw.split(b"end_header\n", 1)[1], np.float32).reshape(-1, 4)
        self.assertEqual(sorted(body[:, 0].tolist()), [1.0, 3.0])


class EmptySplatTest(unittest.TestCase):
    def test_every_gaussian_at_the_origin_is_refused(self):
        names = ["x", "y", "z", "opacity"]
        rows = np.array([[0, 0, 0, 1.0], [0, 0, 0, 2.0]], np.float32)
        head = b"ply\nformat binary_little_endian 1.0\nelement vertex 2\n" + b"".join(
            b"property float %s\n" % n.encode() for n in names) + b"end_header\n"
        with tempfile.TemporaryDirectory() as d:
            src, dst = Path(d) / "a.ply", Path(d) / "b.ply"
            src.write_bytes(head + rows.tobytes())
            with self.assertRaises(RuntimeError):
                wg.prune_ply(src, dst, 10, to_camera_frame=False)
            self.assertFalse(dst.exists())


class ShFieldsTest(unittest.TestCase):
    def test_keeps_only_the_base_colour(self):
        """FlashWorld names all 27 degree-2 coefficients f_dc_*; only f_dc_0..2 survive."""
        names = ["x", "y", "z"] + [f"f_dc_{i}" for i in range(27)] + ["opacity"]
        rows = np.arange(len(names), dtype=np.float32)[None]
        head = b"ply\nformat binary_little_endian 1.0\nelement vertex 1\n" + b"".join(
            b"property float %s\n" % n.encode() for n in names) + b"end_header\n"
        with tempfile.TemporaryDirectory() as d:
            src, dst = Path(d) / "a.ply", Path(d) / "b.ply"
            src.write_bytes(head + rows.tobytes())
            wg.prune_ply(src, dst, 10, to_camera_frame=False)
            head_out, body = dst.read_bytes().split(b"end_header\n", 1)
        self.assertEqual([ln.split()[-1] for ln in head_out.splitlines() if ln.startswith(b"property")],
                         [b"x", b"y", b"z", b"f_dc_0", b"f_dc_1", b"f_dc_2", b"opacity"])
        self.assertEqual(np.frombuffer(body, np.float32).tolist(), [0, 1, 2, 3, 4, 5, 30])


class SceneScaleTest(unittest.TestCase):
    def test_shrinks_positions_and_sizes_together(self):
        names = ["x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2"]
        rows = np.array([[10.0, -4.0, 20.0, 1.0, math.log(0.5), math.log(0.2), 0.0]], np.float32)
        head = b"ply\nformat binary_little_endian 1.0\nelement vertex 1\n" + b"".join(
            b"property float %s\n" % n.encode() for n in names) + b"end_header\n"
        with tempfile.TemporaryDirectory() as d:
            src, dst = Path(d) / "a.ply", Path(d) / "b.ply"
            src.write_bytes(head + rows.tobytes())
            wg.prune_ply(src, dst, 10, to_camera_frame=False, scale=0.1)
            out = np.frombuffer(dst.read_bytes().split(b"end_header\n", 1)[1], np.float32)
        self.assertTrue(np.allclose(out[:3], [1.0, -0.4, 2.0]))
        self.assertTrue(np.allclose(np.exp(out[4:7]), [0.05, 0.02, 0.1], atol=1e-6))


class CameraFrameTest(unittest.TestCase):
    def test_turns_flashworld_frame_into_the_picture_camera_frame(self):
        """A point 5 m ahead of FlashWorld's first camera (at -z, y up) lands at +z, y
        down; the gaussian's orientation turns with it."""
        names = ["x", "y", "z", "opacity", "rot_0", "rot_1", "rot_2", "rot_3"]
        c, s_ = math.cos(math.pi / 8), math.sin(math.pi / 8)       # 45 deg about y
        rows = np.array([[0.5, 2.0, -5.0, 1.0, c, 0.0, s_, 0.0]], np.float32)
        head = b"ply\nformat binary_little_endian 1.0\nelement vertex 1\n" + b"".join(
            b"property float %s\n" % n.encode() for n in names) + b"end_header\n"
        with tempfile.TemporaryDirectory() as d:
            src, dst = Path(d) / "a.ply", Path(d) / "b.ply"
            src.write_bytes(head + rows.tobytes())
            wg.prune_ply(src, dst, 10)
            out = np.frombuffer(dst.read_bytes().split(b"end_header\n", 1)[1], np.float32)
        self.assertTrue(np.allclose(out[:3], [0.5, -2.0, 5.0]))
        turn = np.diag([1.0, -1.0, -1.0])
        self.assertTrue(np.allclose(_rot(out[4:8]), turn @ _rot(rows[0, 4:8])))


if __name__ == "__main__":
    unittest.main()
