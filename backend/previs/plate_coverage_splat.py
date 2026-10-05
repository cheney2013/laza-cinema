"""Plate camera for a space that exists as a gaussian splat (a route splat from route_gs.py).

The same question plate_coverage.py answers for a Blender set: which camera, shot by the one plate
generator, shows the most of what the shots of the segment will look at.  Here the geometry is the splat:
every shot is rendered with depth, each of its pixels is lifted to a 3D point, and a candidate plate camera
covers that pixel when the point falls inside the candidate's frame and the candidate's own depth there
agrees (so a wall that stands in front of it counts as occluding).  cover(shot) is the covered fraction of
the shot's pixels; a plate camera is scored by the mean over the shots, and a second plate is chosen for what
the first leaves uncovered.

Each plate also gets <name>_clean.png: the same render with the areas that cannot be trusted painted flat grey
(the far side showing through gaps in a near surface, and holes the splat never filled), so that an image model
reading it as geometry does not take a gap for a street.

    python plate_coverage_splat.py --ply route.ply --route route_time_pos.json --shots shots.json \\
        --out out_dir [--lens 16,24] [--yaw-step 30] [--min-gain 0.02]

Run with an interpreter that has gsplat (FlashWorld's venv).

route_time_pos.json: {"times": [seconds...], "positions": [[x, y, z] metres, ...]} in the splat's frame
(x right, y down, z forward; route_gs writes <ply>_cams.json with the positions).
shots.json: list of {"name", "t": route time, "yaw_offset": degrees from the direction of travel
(positive turns right), "pitch": degrees (positive up), "lens": mm on a 36 mm sensor}.  Everything about a
particular film stays in that file; nothing here knows one.
"""
import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from plyfile import PlyData
from gsplat.rendering import rasterization

SCENE_SCALE = 0.1          # the splat stores positions as metres x 0.1 (route_gs / world_gen convention)
W, H = 344, 194            # coverage render size: coverage is a ratio, this is plenty


def view_matrix(pos, yaw: float, pitch: float) -> np.ndarray:
    """World-to-camera, OpenCV convention; yaw turns right, pitch tilts up (same as gs_render_view.py)."""
    ya, pa = math.radians(yaw), math.radians(pitch)
    fwd = np.array([math.sin(ya) * math.cos(pa), -math.sin(pa), math.cos(ya) * math.cos(pa)])
    right = np.array([math.cos(ya), 0.0, -math.sin(ya)])
    down = np.cross(fwd, right)
    R = np.stack([right, down, fwd])
    vm = np.eye(4)
    vm[:3, :3] = R
    vm[:3, 3] = -R @ np.asarray(pos, float)
    return vm


def intrinsics(lens: float, w: int, h: int) -> np.ndarray:
    f = (w / 2) / (18.0 / lens)            # 36 mm sensor across the width
    return np.array([[f, 0, w / 2], [0, f, h / 2], [0, 0, 1]], dtype=np.float32)


class Splat:
    def __init__(self, path: str):
        v = PlyData.read(path)["vertex"]
        col = lambda *n: torch.tensor(np.stack([np.asarray(v[k]) for k in n], 1), dtype=torch.float32, device="cuda")
        self.means = col("x", "y", "z")
        self.quats = torch.nn.functional.normalize(col("rot_0", "rot_1", "rot_2", "rot_3"), dim=-1)
        self.scales = torch.exp(col("scale_0", "scale_1", "scale_2"))
        self.opac = torch.sigmoid(col("opacity")[:, 0])
        names = [p.name for p in v.properties]
        rest = sorted([n for n in names if n.startswith("f_rest_")], key=lambda s: int(s.split("_")[-1]))
        sh = col("f_dc_0", "f_dc_1", "f_dc_2")[:, None, :]
        if rest:
            sh = torch.cat([sh, col(*rest).reshape(len(v), 3, -1).transpose(1, 2)], 1)
        self.sh = sh
        self.degree = int(round(sh.shape[1] ** 0.5)) - 1

    def render(self, pos, yaw, pitch, lens, w=W, h=H, scale_boost=1.0, opacity_boost=1.0):
        """(rgb [h,w,3] 0..1, depth [h,w], alpha [h,w]) from a camera; positions are in splat units.

        A splat is sparse where few frames saw it, and the far side shows through the gaps.  scale_boost makes
        every gaussian larger and opacity_boost more opaque (the viewer's size slider), which closes small gaps."""
        vm = torch.tensor(view_matrix(pos, yaw, pitch), dtype=torch.float32, device="cuda")[None]
        K = torch.tensor(intrinsics(lens, w, h), device="cuda")[None]
        opac = (self.opac * opacity_boost).clamp(max=0.999) if opacity_boost != 1.0 else self.opac
        out, alpha, _ = rasterization(self.means, self.quats, self.scales * scale_boost, opac, self.sh, vm, K, w, h,
                                      sh_degree=self.degree, render_mode="RGB+ED")
        return out[0, ..., :3].clamp(0, 1), out[0, ..., 3], alpha[0, ..., 0]


def unreliable_mask(depth, alpha, rough=0.12, hole=0.9, open_px=5, grow_px=6):
    """Where a render shows something that is not there: gaps in a surface that the far side shows through
    (depth jumps about inside a small window, over an area and not just along an edge) and holes the splat
    never filled.  Sky (a hole that touches the top of the frame) is left alone."""
    import cv2
    d = depth.cpu().numpy().astype(np.float32)
    a = alpha.cpu().numpy()
    d = np.where(a > 0.05, d, 0)
    k = 9
    mean = cv2.blur(d, (k, k))
    std = np.sqrt(np.maximum(cv2.blur(d * d, (k, k)) - mean * mean, 0))
    see_through = (std / np.maximum(mean, 1e-4) > rough).astype(np.uint8)
    see_through = cv2.morphologyEx(see_through, cv2.MORPH_OPEN, np.ones((open_px, open_px), np.uint8))   # edges are thin
    holes = (a < hole).astype(np.uint8)
    n, lab = cv2.connectedComponents(holes)
    sky = np.isin(lab, np.unique(lab[0][holes[0] > 0])) & (holes > 0) if n > 1 else np.zeros_like(holes, bool)
    m = ((see_through > 0) | ((holes > 0) & ~sky)).astype(np.uint8)
    return cv2.dilate(m, np.ones((grow_px, grow_px), np.uint8)) > 0


def clean_view(rgb, depth, alpha, grey=0.5):
    """rgb [h,w,3] 0..1 as numpy with the unreliable areas painted a flat grey, and the mask."""
    m = unreliable_mask(depth, alpha)
    out = rgb.cpu().numpy().copy()
    out[m] = grey
    return out, m


def route_at(route, t):
    """(position in splat units, heading in degrees) at route time t."""
    ts, ps = np.asarray(route["times"], float), np.asarray(route["positions"], float) * SCENE_SCALE
    p = np.array([np.interp(t, ts, ps[:, k]) for k in range(3)])
    a = np.array([np.interp(t - 0.7, ts, ps[:, k]) for k in range(3)])
    b = np.array([np.interp(t + 0.7, ts, ps[:, k]) for k in range(3)])
    d = b - a
    return p, math.degrees(math.atan2(d[0], d[2]))


def lift(depth, alpha, lens, vm_inv):
    """World points of every valid pixel of a rendered view: [n,3], and the pixel mask."""
    K = intrinsics(lens, W, H)
    v, u = np.mgrid[0:H, 0:W]
    d = depth.cpu().numpy()
    ok = (alpha.cpu().numpy() > 0.5) & (d > 1e-4)
    x = (u - K[0, 2]) / K[0, 0] * d
    y = (v - K[1, 2]) / K[1, 1] * d
    cam = np.stack([x[ok], y[ok], d[ok]], 1)
    return (vm_inv[:3, :3] @ cam.T).T + vm_inv[:3, 3], ok


def covered(points_w, cam_view, cam_depth, cam_alpha, lens, tol=0.08):
    """Boolean per point: inside the camera's frame, in front of it, and not hidden behind what it renders."""
    K = intrinsics(lens, W, H)
    pc = (cam_view[:3, :3] @ points_w.T).T + cam_view[:3, 3]
    z = pc[:, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        u = np.round(K[0, 0] * pc[:, 0] / z + K[0, 2]).astype(int)
        v = np.round(K[1, 1] * pc[:, 1] / z + K[1, 2]).astype(int)
    inside = (z > 0.02) & (u >= 0) & (u < W) & (v >= 0) & (v < H)
    out = np.zeros(len(points_w), bool)
    idx = np.where(inside)[0]
    d = cam_depth[v[idx], u[idx]]
    a = cam_alpha[v[idx], u[idx]]
    out[idx] = (a > 0.5) & (np.abs(z[idx] - d) < tol * z[idx] + 1e-3)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ply", required=True)
    ap.add_argument("--route", required=True)
    ap.add_argument("--shots", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--lens", default="16,24")
    ap.add_argument("--yaw-step", type=float, default=30.0)
    ap.add_argument("--pos-step", type=float, default=1.0, help="seconds between candidate positions")
    ap.add_argument("--margin", type=float, default=6.0, help="seconds either side of the shots to search")
    ap.add_argument("--min-gain", type=float, default=0.02, help="a further plate must add at least this")
    ap.add_argument("--max-plates", type=int, default=3)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    route = json.load(open(a.route))
    shots = json.load(open(a.shots))
    splat = Splat(a.ply)
    print(f"{len(splat.means):,} gaussians", flush=True)

    # shots: render with depth, lift every valid pixel to the world
    S = []
    for s in shots:
        pos, heading = route_at(route, s["t"])
        yaw = heading + s.get("yaw_offset", 0.0)
        rgb, depth, alpha = splat.render(pos, yaw, s.get("pitch", 0.0), s["lens"])
        vm = view_matrix(pos, yaw, s.get("pitch", 0.0))
        pts, ok = lift(depth, alpha, s["lens"], np.linalg.inv(vm))
        Image.fromarray((rgb.cpu().numpy() * 255).astype(np.uint8)).save(out / f"shot_{s['name']}.png")
        S.append({"name": s["name"], "pts": pts, "valid": float(ok.mean())})
        print(f"shot {s['name']}: t={s['t']} yaw={yaw:.0f} valid pixels {ok.mean() * 100:.0f}%", flush=True)

    # candidate plate cameras: along the route around the shots, every yaw step, a few lenses
    t0 = min(s["t"] for s in shots) - a.margin
    t1 = max(s["t"] for s in shots) + a.margin
    lenses = [float(x) for x in a.lens.split(",")]
    cands = []
    for t in np.arange(max(t0, min(route["times"])), min(t1, max(route["times"])) + 1e-6, a.pos_step):
        pos, heading = route_at(route, t)
        for off in np.arange(0, 360, a.yaw_step):
            for lens in lenses:
                cands.append({"t": float(t), "yaw": heading + float(off), "offset": float(off), "lens": lens, "pos": pos})
    print(f"{len(cands)} candidate cameras", flush=True)
    t_start = time.time()
    cover = np.zeros((len(cands), len(S)))
    for ci, c in enumerate(cands):
        rgb, depth, alpha = splat.render(c["pos"], c["yaw"], 0.0, c["lens"])
        view = view_matrix(c["pos"], c["yaw"], 0.0)
        d, al = depth.cpu().numpy(), alpha.cpu().numpy()
        for si, s in enumerate(S):
            cover[ci, si] = covered(s["pts"], view, d, al, c["lens"]).mean() if len(s["pts"]) else 0.0
        if ci % 100 == 0:
            print(f"  {ci}/{len(cands)}  {time.time() - t_start:.0f}s", flush=True)

    # greedy: best single plate, then the plate that adds most for the shots the chosen ones leave short
    chosen, best_so_far = [], np.zeros(len(S))
    for _ in range(a.max_plates):
        gain = np.maximum(cover, best_so_far[None, :]).mean(1) - best_so_far.mean()
        ci = int(np.argmax(gain))
        if chosen and gain[ci] < a.min_gain:
            break
        chosen.append(ci)
        best_so_far = np.maximum(best_so_far, cover[ci])
    report = {"shots": [{"name": s["name"], "valid_pixels": s["valid"]} for s in S], "plates": []}
    seen = np.zeros(len(S))
    for n, ci in enumerate(chosen):
        c = cands[ci]
        seen = np.maximum(seen, cover[ci])
        rgb, _, _ = splat.render(c["pos"], c["yaw"], 0.0, c["lens"], 1376, 774)
        name = f"plate_{n + 1}"
        Image.fromarray((rgb.cpu().numpy() * 255).astype(np.uint8)).save(out / f"{name}.png")
        rgb_h, depth_h, alpha_h = splat.render(c["pos"], c["yaw"], 0.0, c["lens"], 1376, 774)
        clean, mask = clean_view(rgb_h, depth_h, alpha_h)
        Image.fromarray((clean * 255).astype(np.uint8)).save(out / f"{name}_clean.png")
        report["plates"].append({
            "name": name, "unreliable_fraction": round(float(mask.mean()), 3), "route_time_s": c["t"], "yaw_offset_from_heading_deg": c["offset"], "lens_mm": c["lens"],
            "position_metres": (np.asarray(c["pos"]) / SCENE_SCALE).round(3).tolist(),
            "yaw_deg": round(c["yaw"], 2), "pitch_deg": 0.0,
            "alone": {s["name"]: round(float(cover[ci, si]), 3) for si, s in enumerate(S)},
            "alone_mean": round(float(cover[ci].mean()), 3),
            "with_earlier_plates": {s["name"]: round(float(seen[si]), 3) for si, s in enumerate(S)},
            "with_earlier_mean": round(float(seen.mean()), 3)})
    top = np.argsort(-cover.mean(1))[:10]
    report["top10_single"] = [{"route_time_s": cands[i]["t"], "yaw_offset": cands[i]["offset"], "lens": cands[i]["lens"],
                               "mean": round(float(cover[i].mean()), 3)} for i in top]
    (out / "coverage.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))
    print(json.dumps(report, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
