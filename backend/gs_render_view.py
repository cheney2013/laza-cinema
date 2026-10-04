"""Render one view of a 3DGS .ply with gsplat -- the server-side twin of the canvas
gaussian viewer's capture, for callers that have no browser (the canvas MCP).

The ply is taken in the frame SHARP writes and world_gen.prune_ply() converts
FlashWorld splats to: the source picture's camera at the origin, x right, y down,
looking down +z, metres. The camera is placed in that frame:

    x, y, z     camera position (y down: a negative y lifts the camera)
    yaw         degrees, positive turns right (toward +x)
    pitch       degrees, positive tilts up

Run with an interpreter that has gsplat (FlashWorld's venv; world_gen.FLASHWORLD_DIR):

    python gs_render_view.py scene.ply out.png --pos 1,0,0 --yaw 20 --pitch 0 \
        --vfov 45 --size 1376x768
"""
from __future__ import annotations

import argparse
import math

import numpy as np
import torch
from PIL import Image
from plyfile import PlyData
from gsplat.rendering import rasterization


def view_matrix(pos, yaw: float, pitch: float) -> np.ndarray:
    """World-to-camera for an OpenCV camera (x right, y down, z forward)."""
    ya, pa = math.radians(yaw), math.radians(pitch)
    fwd = np.array([math.sin(ya) * math.cos(pa), -math.sin(pa), math.cos(ya) * math.cos(pa)])
    right = np.array([math.cos(ya), 0.0, -math.sin(ya)])
    down = np.cross(fwd, right)
    R = np.stack([right, down, fwd])
    vm = np.eye(4)
    vm[:3, :3] = R
    vm[:3, 3] = -R @ np.asarray(pos, float)
    return vm


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("ply")
    ap.add_argument("out")
    ap.add_argument("--pos", default="0,0,0")
    ap.add_argument("--yaw", type=float, default=0.0)
    ap.add_argument("--pitch", type=float, default=0.0)
    ap.add_argument("--vfov", type=float, default=45.0)
    ap.add_argument("--size", default="1376x768")
    a = ap.parse_args()
    W, H = (int(v) for v in a.size.split("x"))

    v = PlyData.read(a.ply)["vertex"]
    col = lambda *n: torch.tensor(np.stack([np.asarray(v[k]) for k in n], 1), dtype=torch.float32, device="cuda")
    names = [p.name for p in v.properties]
    rest = sorted([n for n in names if n.startswith("f_rest_")], key=lambda s: int(s.split("_")[-1]))
    sh = col("f_dc_0", "f_dc_1", "f_dc_2")[:, None, :]
    if rest:
        sh = torch.cat([sh, col(*rest).reshape(len(v), 3, -1).transpose(1, 2)], 1)
    degree = int(round(sh.shape[1] ** 0.5)) - 1

    f = (H / 2) / math.tan(math.radians(a.vfov) / 2)
    K = torch.tensor([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]], dtype=torch.float32, device="cuda")[None]
    vm = torch.tensor(view_matrix([float(x) for x in a.pos.split(",")], a.yaw, a.pitch),
                      dtype=torch.float32, device="cuda")[None]
    img, _, _ = rasterization(
        col("x", "y", "z"), torch.nn.functional.normalize(col("rot_0", "rot_1", "rot_2", "rot_3"), dim=-1),
        torch.exp(col("scale_0", "scale_1", "scale_2")), torch.sigmoid(col("opacity")[:, 0]), sh,
        vm, K, W, H, sh_degree=degree, backgrounds=torch.zeros(1, 3, device="cuda"))
    Image.fromarray((img[0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)).save(a.out)


if __name__ == "__main__":
    main()
