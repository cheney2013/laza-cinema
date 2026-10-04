"""Single image -> a whole-scene 3D Gaussian splat with FlashWorld.

FlashWorld (ICLR 2026, Wan2.2-TI2V-5B based) generates the views along a camera
trajectory from one picture and fuses them into 3DGS, filling in what the picture
never showed -- the back of an object, the street behind the camera. It lives in
its own checkout and venv (FLASHWORLD_DIR, default D:/Projects/FlashWorld; see
the project memory for how gsplat was built there) and runs as a subprocess, so
nothing here imports torch.

Conventions that took a wrong render each to learn:

- The input JSON's cameras are camera-to-world with the quaternion real part first,
  the camera looking down its -z. Written with the camera looking down +z the whole
  trajectory runs backwards (a push-in becomes a pull-back).
- FlashWorld exports its .ply in metres of the trajectory we passed, in the first
  camera's frame with the scene at -z and y up. prune_ply() turns it 180 degrees
  about x so the file lands in
  the frame SHARP writes and the canvas viewer assumes: camera at the origin,
  x right, y down, looking down +z. Recorded in the sidecar <ply>.json.
- It also shrinks the splat by SCENE_SCALE. The canvas viewer (gsplat.js) drops
  splats a street's length away -- a bus 15 m off vanished while the same splats
  at a tenth the size showed (2026-09-29) -- and a SHARP splat sits within a few
  metres, which is the range the viewer was tuned on. The sidecar's scene_scale
  converts back: ply units = metres * scene_scale.
- The picture is always frame 0, at the origin looking straight ahead.

World coordinates used for trajectories below: x right, y up, z forward from the
picture's camera, in metres.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

FLASHWORLD_DIR = Path(os.environ.get("FLASHWORLD_DIR", "D:/Projects/FlashWorld"))
FLASHWORLD_HF_HOME = os.environ.get("FLASHWORLD_HF_HOME", "D:/hf_cache")
TRAJECTORIES = ("ring", "orbit", "pan")
N_FRAMES = 24
# FlashWorld divides every camera position by the farthest one's distance from the origin and multiplies the
# splat back by it on export (utils.normalize_cameras / export_gaussians). Cameras that never move make that
# distance 0, and the exported splat has every position and size multiplied by 0: 1.5 M gaussians at the
# origin, drawn as a speck (gaussian-1791007749183, 2026-10-03). A pan therefore turns on a tiny circle.
PAN_RADIUS = 0.2
GEN_WIDTH, GEN_HEIGHT = 704, 480
SCENE_SCALE = 0.1


def _quat_wxyz(R: np.ndarray) -> list[float]:
    """Rotation matrix -> unit quaternion, real part first, w >= 0."""
    m = R
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        q = [0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [(m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s]
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s]
    q = np.array(q) / np.linalg.norm(q)
    return (q if q[0] >= 0 else -q).tolist()


def _camera(eye, target, focal: float, width: int, height: int) -> dict:
    eye, target = np.asarray(eye, float), np.asarray(target, float)
    fwd = target - eye
    fwd /= np.linalg.norm(fwd)
    right = np.cross([0.0, 1.0, 0.0], fwd)
    right /= np.linalg.norm(right)
    up = np.cross(fwd, right)
    # Columns right, -up, -forward: the basis FlashWorld's own examples use and the
    # one the tested runs used (a proper rotation, det +1). [right, up, -fwd] has
    # det -1 and is not a rotation at all.
    R = np.stack([right, -up, -fwd], 1)
    return {"quaternion": _quat_wxyz(R), "position": eye.tolist(),
            "fx": focal, "fy": focal, "cx": width / 2, "cy": height / 2}


def build_trajectory(kind: str, width: int, height: int, vfov: float = 45.0,
                     radius: float = 1.5, distance: float = 10.0, degrees: float = 360.0,
                     n: int = N_FRAMES) -> list[dict]:
    """Cameras in the input picture's pixel units (FlashWorld rescales them).

    ring  -- walk a circle of `radius` metres that passes through the picture's
             camera, always looking outward, turning `degrees` (360 = all round).
             Parallax in every direction, so the splat holds up when the camera
             later moves about a metre or two off the ring.
    orbit -- push in `distance`/2 metres toward a point `distance` ahead, then arc
             left around it by `degrees`. For looking at the far side of a subject.
    pan   -- turn (almost) in place by `degrees`: a ring of PAN_RADIUS metres, since cameras
             that do not move at all give FlashWorld a zero scale and an empty splat. Little
             parallax: the splat is a panorama that only holds from about this spot.
    """
    if kind not in TRAJECTORIES:
        raise ValueError(f"trajectory must be one of {TRAJECTORIES}, got {kind!r}")
    f = (height / 2) / math.tan(math.radians(vfov) / 2)
    cam = lambda eye, tgt: _camera(eye, tgt, f, width, height)
    if kind in ("ring", "pan"):
        radius = PAN_RADIUS if kind == "pan" else radius
        out = []
        for i in range(n):
            b = math.radians(-degrees * i / n)
            d = np.array([math.sin(b), 0.0, math.cos(b)])
            eye = np.array([0.0, 0.0, -radius]) + radius * d
            out.append(cam(eye, eye + d))
        return out
    push = n // 3
    pivot = np.array([0.0, 0.0, distance])
    r = distance / 2
    out = [cam([0, 0, (distance - r) * i / push], pivot) for i in range(push)]
    arc = n - push
    for i in range(1, arc + 1):
        b = math.radians(-degrees * i / arc)
        out.append(cam(pivot + r * np.array([math.sin(b), 0.0, -math.cos(b)]), pivot))
    return out


def prune_ply(src: Path, dst: Path, max_gaussians: int, to_camera_frame: bool = True,
              scale: float = 1.0) -> int:
    """Keep the `max_gaussians` most opaque gaussians. FlashWorld writes ~4M, which a
    browser WebGL viewer cannot hold; the faint ones carry little of the picture.

    Only the base colour is kept: FlashWorld writes all 27 degree-2 SH coefficients
    as f_dc_0..f_dc_26 (the standard names are f_dc_0..2 plus f_rest_*), which the
    canvas viewer cannot read, and the higher orders would also have to be rotated
    below. The result has SHARP's 14 fields, at about a third of the size.

    to_camera_frame turns the splat 180 degrees about x ((x, y, z) -> (x, -y, -z)):
    the picture's camera then sits at the origin looking down +z with y down, as in
    a SHARP splat. Each gaussian's rotation is pre-multiplied by that turn,
    q -> (0, 1, 0, 0) * q = (-x, w, -z, y); scales are unchanged. Colour is
    degree-0 SH only, so it needs no rotating.

    scale shrinks positions and gaussian sizes together (log scales shift by
    log(scale)), so every view looks the same, only nearer to the origin.
    """
    with open(src, "rb") as fh:
        header = []
        while True:
            line = fh.readline()
            header.append(line)
            if line.strip() == b"end_header":
                break
        names = [ln.split()[-1].decode() for ln in header if ln.startswith(b"property")]
        count = next(int(ln.split()[-1]) for ln in header if ln.startswith(b"element vertex"))
        data = np.frombuffer(fh.read(count * 4 * len(names)), dtype=np.float32).reshape(count, len(names))
    if count > max_gaussians:
        opacity = data[:, names.index("opacity")]
        data = data[np.argsort(-opacity)[:max_gaussians]]
    keep = [i for i, n in enumerate(names)
            if not n.startswith("f_rest_") and not (n.startswith("f_dc_") and int(n[5:]) > 2)]
    data, names = data[:, keep], [names[i] for i in keep]
    if to_camera_frame:
        data = data.copy()
        for name in ("y", "z", "ny", "nz"):
            if name in names:
                data[:, names.index(name)] *= -1
        if "rot_0" in names:
            w, x, y, z = (data[:, names.index(f"rot_{k}")].copy() for k in range(4))
            for k, col in enumerate((-x, w, -z, y)):
                data[:, names.index(f"rot_{k}")] = col
    if scale != 1.0:
        data = data.copy()
        for name in ("x", "y", "z"):
            data[:, names.index(name)] *= scale
        for name in ("scale_0", "scale_1", "scale_2"):
            if name in names:
                data[:, names.index(name)] += math.log(scale)
    if len(data) and not np.any(data[:, names.index("x"):names.index("z") + 1]):
        raise RuntimeError("FlashWorld returned an empty splat: every gaussian sits at the origin "
                           "(its cameras did not move, so its scale came out as 0).")
    props = [ln for ln in header if ln.startswith(b"property") and ln.split()[-1].decode() in names]
    out_header = b"".join(
        (b"element vertex %d\n" % len(data)) if ln.startswith(b"element vertex") else ln
        for ln in header if not ln.startswith(b"property") and ln.strip() != b"end_header")
    out_header += b"".join(props) + b"end_header\n"
    with open(dst, "wb") as fh:
        fh.write(out_header)
        fh.write(np.ascontiguousarray(data, dtype=np.float32).tobytes())
    return len(data)


def run_flashworld(image: Path, prompt: str, cameras: list[dict], work_dir: Path,
                   timeout: int = 1800) -> tuple[Path, Path]:
    """Run FlashWorld's CLI on one scene; returns (gaussians.ply, video.mp4)."""
    python = FLASHWORLD_DIR / ".venv" / "Scripts" / "python.exe"
    if not python.exists():
        python = FLASHWORLD_DIR / ".venv" / "bin" / "python"
    if not python.exists():
        raise RuntimeError(f"FlashWorld venv not found under {FLASHWORLD_DIR}")
    in_dir, out_dir = work_dir / "in", work_dir / "out"
    shutil.rmtree(work_dir, ignore_errors=True)
    in_dir.mkdir(parents=True)
    (in_dir / "scene.json").write_text(json.dumps({
        "image_prompt": str(image.resolve()), "text_prompt": prompt,
        "resolution": [len(cameras), GEN_HEIGHT, GEN_WIDTH], "image_index": 0,
        "cameras": cameras}), encoding="utf-8")
    env = {**os.environ, "HF_HOME": FLASHWORLD_HF_HOME, "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.run(
        [str(python), "cli.py", "--input_dir", str(in_dir), "--output_dir", str(out_dir),
         "--offload_t5", "--offload_transformer_during_vae", "--ply", "--video"],
        cwd=FLASHWORLD_DIR, env=env, capture_output=True, text=True, encoding="utf-8",
        errors="replace", timeout=timeout)
    ply, video = out_dir / "scene" / "gaussians.ply", out_dir / "scene" / "video.mp4"
    if proc.returncode != 0 or not ply.exists():
        tail = (proc.stderr or proc.stdout or "")[-2000:]
        raise RuntimeError(f"FlashWorld failed (exit {proc.returncode}): {tail}")
    return ply, video


if __name__ == "__main__":  # quick check of a trajectory: python world_gen.py ring 1376 768
    cams = build_trajectory(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
    for c in cams[:3]:
        print(c)
