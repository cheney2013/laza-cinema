#!/usr/bin/env python
"""
Render a 3D Gaussian splat (.ply) from a new camera angle, headlessly.

Changing the camera on a scene is the hard case for consistency. Re-prompting the same
location from a different angle re-invents it — this production lost a whole room that way,
getting a different window, different props and inverted lighting when one shot flipped to a
reverse angle. A scene reference can't help, because the new angle genuinely looks different.

Reconstructing the shot into 3D and moving the camera keeps the geometry *identical* by
construction. Feed the render back as a `depth_ref` (or scene reference) and FLUX.2 repaints
it with real materials and light while staying on the same set.

    # splat from an existing keyframe (via the backend), then orbit 40 degrees left
    python tools/splat_render.py scene.ply out.png --yaw -40 --pitch 5

Output is deliberately rough — a reference latent only has to carry layout, not pixels.
The interactive route is the canvas GaussianNode, which orbits in a real WebGL viewer;
this exists so a batch production can do it without a browser.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

SH_C0 = 0.28209479177387814  # degree-0 spherical harmonic -> base colour


def load_ply(path: Path) -> dict[str, np.ndarray]:
    """Read a binary_little_endian 3DGS ply into named float arrays."""
    with path.open("rb") as f:
        header, names = [], []
        while True:
            line = f.readline().decode("ascii", "replace").strip()
            header.append(line)
            if line.startswith("property"):
                names.append(line.split()[-1])
            elif line.startswith("element vertex"):
                count = int(line.split()[-1])
            elif line == "end_header":
                break
        if not any(h.startswith("format binary_little_endian") for h in header):
            raise SystemExit("Only binary_little_endian ply is supported.")
        data = np.frombuffer(f.read(count * 4 * len(names)), dtype=np.float32)
    data = data.reshape(count, len(names))
    return {n: data[:, i] for i, n in enumerate(names)}


def render(
    ply: dict[str, np.ndarray], w: int, h: int,
    yaw: float, pitch: float, dolly: float, fov: float, keep: float,
) -> np.ndarray:
    xyz = np.stack([ply["x"], ply["y"], ply["z"]], 1).astype(np.float64)

    # Colour from the degree-0 SH term; opacity through the usual sigmoid.
    rgb = np.stack([ply.get(f"f_dc_{i}", np.zeros(len(xyz), np.float32)) for i in range(3)], 1)
    rgb = np.clip(0.5 + SH_C0 * rgb, 0, 1)
    alpha = 1.0 / (1.0 + np.exp(-ply.get("opacity", np.zeros(len(xyz), np.float32))))

    # Drop near-transparent gaussians and any far outliers, then centre on what's left.
    solid = alpha > 0.25
    xyz, rgb, alpha = xyz[solid], rgb[solid], alpha[solid]
    centre = np.median(xyz, 0)
    radius = np.quantile(np.linalg.norm(xyz - centre, axis=1), keep)
    inlier = np.linalg.norm(xyz - centre, axis=1) <= radius
    xyz, rgb, alpha = xyz[inlier], rgb[inlier], alpha[inlier]

    # Orbit the camera around the scene centre, looking back at it.
    ay, ap = np.radians(yaw), np.radians(pitch)
    ry = np.array([[np.cos(ay), 0, np.sin(ay)], [0, 1, 0], [-np.sin(ay), 0, np.cos(ay)]])
    rp = np.array([[1, 0, 0], [0, np.cos(ap), -np.sin(ap)], [0, np.sin(ap), np.cos(ap)]])
    rot = ry @ rp

    dist = radius * dolly
    eye = centre + rot @ np.array([0.0, 0.0, -dist])
    fwd = centre - eye
    fwd /= np.linalg.norm(fwd)
    # world-up x forward, not forward x world-up: the latter mirrors the scene, which would
    # silently flip the set left-to-right and break the continuity this tool exists to keep.
    right = np.cross(np.array([0.0, 1.0, 0.0]), fwd)
    right /= np.linalg.norm(right) or 1.0
    up = np.cross(fwd, right)                   # completes the basis without re-mirroring
    view = np.stack([right, up, fwd])           # world -> camera

    cam = (xyz - eye) @ view.T
    infront = cam[:, 2] > 1e-6
    cam, rgb, alpha = cam[infront], rgb[infront], alpha[infront]

    focal = (w / 2) / np.tan(np.radians(fov) / 2)
    u = (cam[:, 0] / cam[:, 2]) * focal + w / 2
    v = (cam[:, 1] / cam[:, 2]) * focal + h / 2
    on = (u >= 0) & (u < w) & (v >= 0) & (v < h)
    u, v, z = u[on].astype(np.int32), v[on].astype(np.int32), cam[on, 2]
    rgb, alpha = rgb[on], alpha[on]

    # Painter's algorithm: draw far to near so nearer splats overwrite.
    order = np.argsort(-z)
    u, v, rgb, alpha = u[order], v[order], rgb[order], alpha[order]

    img = np.zeros((h, w, 3), np.float64)
    hit = np.zeros((h, w), bool)
    np.maximum.at(img, (v, u), rgb * alpha[:, None])
    hit[v, u] = True

    # Fill unwritten pixels with a mid grey so the reference reads as a scene, not confetti.
    img[~hit] = 0.35
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("ply", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--yaw", type=float, default=0.0, help="orbit left/right, degrees")
    ap.add_argument("--pitch", type=float, default=0.0, help="orbit up/down, degrees")
    ap.add_argument("--dolly", type=float, default=2.2, help="distance in scene radii")
    ap.add_argument("--fov", type=float, default=55.0)
    ap.add_argument("--keep", type=float, default=0.92,
                    help="quantile of points to keep, trims reconstruction outliers")
    args = ap.parse_args()

    from PIL import Image
    ply = load_ply(args.ply)
    img = render(ply, args.width, args.height, args.yaw, args.pitch,
                 args.dolly, args.fov, args.keep)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img).save(args.out)
    print(f"wrote {args.out} (yaw={args.yaw} pitch={args.pitch} dolly={args.dolly})")


if __name__ == "__main__":
    main()
