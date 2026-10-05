"""Re-project one input frame into a new camera with the depth WorldMirror estimated for it.

A render of the merged route splat shows the far side through gaps in a near surface, because nothing in the
splat stands in front of it.  One input frame with its own depth has no such gap: whatever the frame saw is a
surface, and whatever it did not see becomes an honest hole.  The colours are the frame's own pixels, and the
holes come out as a mask for an inpainting model.

    python frame_warp.py --run-dir <WorldMirror output folder: camera_params.json + depth/> \\
        --frame frames/b_009.png --index 8 --yaw 30 [--pitch 0] [--shift 0,0,0] [--lens-scale 1.0] \\
        --out warp.png [--mask-out hole.png]

--index is the frame's position in camera_params.json.  The new camera sits at the frame's own camera moved by
--shift (x right, y down, z forward, in WorldMirror units) and turned by --yaw (positive to the right) and
--pitch (positive up).  Run with an interpreter that has torch, numpy and opencv (any of ours).
"""
import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np
import torch


def rot_yaw_pitch(yaw_deg: float, pitch_deg: float) -> np.ndarray:
    """Camera-to-camera rotation for a turn of yaw (right positive) and pitch (up positive), OpenCV axes."""
    ya, pa = math.radians(yaw_deg), math.radians(pitch_deg)
    ry = np.array([[math.cos(ya), 0, math.sin(ya)], [0, 1, 0], [-math.sin(ya), 0, math.cos(ya)]])
    rx = np.array([[1, 0, 0], [0, math.cos(pa), math.sin(pa)], [0, -math.sin(pa), math.cos(pa)]])
    return ry @ rx


def warp(color: np.ndarray, depth: np.ndarray, K: np.ndarray, c2w: np.ndarray, yaw=0.0, pitch=0.0,
         shift=(0.0, 0.0, 0.0), lens_scale=1.0, splat=2, device="cuda"):
    """-> (image uint8 [h,w,3], hole mask bool [h,w], target depth [h,w]).  Forward warp with a z-buffer; each
    source pixel lands as a splat x splat block so that a turn does not leave the surface full of cracks."""
    h, w = depth.shape
    dev = torch.device(device)
    v, u = torch.meshgrid(torch.arange(h, device=dev, dtype=torch.float32),
                          torch.arange(w, device=dev, dtype=torch.float32), indexing="ij")
    d = torch.tensor(depth, device=dev)
    Kt = torch.tensor(K, device=dev, dtype=torch.float32)
    x = (u - Kt[0, 2]) / Kt[0, 0] * d
    y = (v - Kt[1, 2]) / Kt[1, 1] * d
    pts = torch.stack([x, y, d], -1).reshape(-1, 3)                         # source camera frame
    Rt = torch.tensor(rot_yaw_pitch(yaw, pitch), device=dev, dtype=torch.float32)   # source -> target camera
    t = torch.tensor(shift, device=dev, dtype=torch.float32)
    pt = (pts - t) @ Rt                                                      # target camera frame (R^-1 = R^T)
    z = pt[:, 2]
    K2 = Kt.clone()
    K2[0, 0] *= lens_scale
    K2[1, 1] *= lens_scale
    uu = K2[0, 0] * pt[:, 0] / z.clamp(min=1e-6) + K2[0, 2]
    vv = K2[1, 1] * pt[:, 1] / z.clamp(min=1e-6) + K2[1, 2]
    col = torch.tensor(color, device=dev, dtype=torch.float32).reshape(-1, 3)
    zbuf = torch.full((h * w,), float("inf"), device=dev)
    out = torch.zeros((h * w, 3), device=dev)
    half = splat // 2
    for dv in range(-half, splat - half):
        for du in range(-half, splat - half):
            iu = torch.round(uu).long() + du
            iv = torch.round(vv).long() + dv
            ok = (z > 1e-3) & (iu >= 0) & (iu < w) & (iv >= 0) & (iv < h)
            idx = (iv * w + iu)[ok]
            zz = z[ok]
            zbuf.scatter_reduce_(0, idx, zz, reduce="amin", include_self=True)
    for dv in range(-half, splat - half):
        for du in range(-half, splat - half):
            iu = torch.round(uu).long() + du
            iv = torch.round(vv).long() + dv
            ok = (z > 1e-3) & (iu >= 0) & (iu < w) & (iv >= 0) & (iv < h)
            idx = (iv * w + iu)[ok]
            zz = z[ok]
            win = zz <= zbuf[idx] * 1.002 + 1e-6            # the nearest surface at that pixel, with a hair of slack
            out[idx[win]] = col[ok][win]
    hole = torch.isinf(zbuf).reshape(h, w)
    return out.reshape(h, w, 3).clamp(0, 255).byte().cpu().numpy(), hole.cpu().numpy(), zbuf.reshape(h, w).cpu().numpy()


def fuse(sources, target_c2w: np.ndarray, K: np.ndarray, size, splat=2, device="cuda"):
    """Several frames of one WorldMirror run seen from one new camera.

    sources: list of (colour [h,w,3] uint8 rgb, depth [h,w], K [3,3], c2w [4,4], valid [h,w] bool), all in
    the run's own frame.  Every valid pixel becomes a 3D point; the nearest point at each target pixel wins
    (a z-buffer across all frames), so a wall that a later frame saw close up fills what an earlier frame
    could not.  Pixels left out of `valid` (people, from the masks) take no part.
    -> (image uint8 [H,W,3] rgb, hole mask bool [H,W], which source each pixel came from [H,W] int, -1 = hole)
    """
    H, W = size
    dev = torch.device(device)
    Kt = torch.tensor(K, device=dev, dtype=torch.float32)
    w2t = torch.tensor(np.linalg.inv(target_c2w), device=dev, dtype=torch.float32)
    pts, cols, src = [], [], []
    for n, (color, depth, Ks, c2w, valid) in enumerate(sources):
        h, w = depth.shape
        v, u = torch.meshgrid(torch.arange(h, device=dev, dtype=torch.float32),
                              torch.arange(w, device=dev, dtype=torch.float32), indexing="ij")
        d = torch.tensor(depth, device=dev)
        Ks_t = torch.tensor(Ks, device=dev, dtype=torch.float32)
        cam = torch.stack([(u - Ks_t[0, 2]) / Ks_t[0, 0] * d, (v - Ks_t[1, 2]) / Ks_t[1, 1] * d, d], -1).reshape(-1, 3)
        m = torch.tensor(valid, device=dev).reshape(-1)
        c2w_t = torch.tensor(c2w, device=dev, dtype=torch.float32)
        world = cam[m] @ c2w_t[:3, :3].T + c2w_t[:3, 3]
        pts.append(world @ w2t[:3, :3].T + w2t[:3, 3])
        cols.append(torch.tensor(color, device=dev, dtype=torch.float32).reshape(-1, 3)[m])
        src.append(torch.full((int(m.sum()),), n, device=dev, dtype=torch.long))
    pt, col, sid = torch.cat(pts), torch.cat(cols), torch.cat(src)
    z = pt[:, 2]
    uu = Kt[0, 0] * pt[:, 0] / z.clamp(min=1e-6) + Kt[0, 2]
    vv = Kt[1, 1] * pt[:, 1] / z.clamp(min=1e-6) + Kt[1, 2]
    zbuf = torch.full((H * W,), float("inf"), device=dev)
    out = torch.zeros((H * W, 3), device=dev)
    who = torch.full((H * W,), -1, device=dev, dtype=torch.long)
    half = splat // 2
    offs = [(du, dv) for dv in range(-half, splat - half) for du in range(-half, splat - half)]
    for du, dv in offs:
        iu, iv = torch.round(uu).long() + du, torch.round(vv).long() + dv
        ok = (z > 1e-3) & (iu >= 0) & (iu < W) & (iv >= 0) & (iv < H)
        zbuf.scatter_reduce_(0, (iv * W + iu)[ok], z[ok], reduce="amin", include_self=True)
    for du, dv in offs:
        iu, iv = torch.round(uu).long() + du, torch.round(vv).long() + dv
        ok = (z > 1e-3) & (iu >= 0) & (iu < W) & (iv >= 0) & (iv < H)
        idx = (iv * W + iu)[ok]
        win = z[ok] <= zbuf[idx] * 1.002 + 1e-6
        out[idx[win]] = col[ok][win]
        who[idx[win]] = sid[ok][win]
    hole = torch.isinf(zbuf).reshape(H, W)
    return out.reshape(H, W, 3).clamp(0, 255).byte().cpu().numpy(), hole.cpu().numpy(), who.reshape(H, W).cpu().numpy()


def load(run_dir: Path, index: int):
    cp = json.loads((run_dir / "camera_params.json").read_text())
    c2w = np.array(cp["extrinsics"][index]["matrix"], dtype=np.float64)
    K = np.array(cp["intrinsics"][index]["matrix"], dtype=np.float64)
    depth = np.load(run_dir / "depth" / f"depth_{index:04d}.npy").astype(np.float32)
    return c2w, K, depth


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--frame", required=True)
    ap.add_argument("--index", type=int, required=True)
    ap.add_argument("--yaw", type=float, default=0.0)
    ap.add_argument("--pitch", type=float, default=0.0)
    ap.add_argument("--shift", default="0,0,0")
    ap.add_argument("--lens-scale", type=float, default=1.0)
    ap.add_argument("--out", required=True)
    ap.add_argument("--mask-out", default="")
    a = ap.parse_args()
    c2w, K, depth = load(Path(a.run_dir), a.index)
    h, w = depth.shape
    color = cv2.resize(cv2.imread(a.frame), (w, h), interpolation=cv2.INTER_AREA)[:, :, ::-1].copy()
    img, hole, _ = warp(color, depth, K, c2w, a.yaw, a.pitch, tuple(float(v) for v in a.shift.split(",")), a.lens_scale)
    cv2.imwrite(a.out, img[:, :, ::-1])
    if a.mask_out:
        cv2.imwrite(a.mask_out, hole.astype(np.uint8) * 255)
    print(f"holes {100 * hole.mean():.1f}% of the new view")


if __name__ == "__main__":
    main()
