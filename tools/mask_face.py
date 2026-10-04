#!/usr/bin/env python
"""Erase one performer's *face* from a clip, keeping their body, clothes and props.

    backend\\.venv\\Scripts\\python tools\\mask_face.py --clip productions/h3_charswap/src_shot1.mp4 \\
        --body-mask productions/h3_charswap/masked_ref_tool.mp4 --preview --out face_masked.mp4

Why not `mask_performer.py`: that one replaces the whole performer with a grey silhouette,
which also erases whatever they are holding -- on `src_shot1` the tie the shot is about.
Viggle-Animate keeps the driving clip's head geometry (2026-09-07: the swap lands hair and
fringe from the reference still but keeps the source performer's face *shape*), so the
thing that needs to go is the face and nothing else.

Face selection: MediaPipe detects every face in the frame -- the lead, the extra beside
him, the class behind. Picking the biggest box is wrong here (the standing extra outsizes
the lead while the lead is bent over the desk), so the lead's own silhouette decides:
`--body-mask` takes a clip already masked by `mask_performer.py`, whose changed pixels are
exactly that performer, and the face box with the most overlap wins. Without it the tool
falls back to nearest-centroid tracking seeded from `--seed-frame`.

The fill is the same flat grey `mask_performer.py` uses (0x808080), as an ellipse with a
feathered edge so no hard rectangle is baked into the conditioning.
"""

import argparse
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

GREY = (128, 128, 128)


def probe(path):
    txt = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v",
         "-show_entries", "stream=width,height,nb_frames,r_frame_rate",
         "-of", "default=noprint_wrappers=1", str(path)],
        capture_output=True, text=True).stdout
    f = dict(line.split("=", 1) for line in txt.strip().splitlines())
    return int(f["width"]), int(f["height"]), int(f["nb_frames"]), f["r_frame_rate"]


def read_frames(path, w, h, n):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-frames:v", str(n),
         "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
        capture_output=True).stdout
    return np.frombuffer(raw, np.uint8)[:n * w * h * 3].reshape(-1, h, w, 3).copy()


def body_masks(src, masked):
    """Pixels the performer-masking changed -- that performer's silhouette, per frame."""
    d = np.abs(src.astype(np.int16) - masked.astype(np.int16)).max(axis=3)
    return d > 24


MODEL = Path(__file__).resolve().parents[1] / "models_local" / "blaze_face_short_range.tflite"


def detect_faces(frames, min_conf=0.3):
    """MediaPipe Tasks FaceDetector, per frame, every face in shot."""
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    opts = vision.FaceDetectorOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(MODEL)),
        running_mode=vision.RunningMode.IMAGE,
        min_detection_confidence=min_conf)
    out = []
    with vision.FaceDetector.create_from_options(opts) as fd:
        for f in frames:
            h, w = f.shape[:2]
            img = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(f))
            boxes = []
            for det in fd.detect(img).detections:
                b = det.bounding_box
                x0 = max(0, b.origin_x); y0 = max(0, b.origin_y)
                x1 = min(w, b.origin_x + b.width); y1 = min(h, b.origin_y + b.height)
                if x1 > x0 and y1 > y0:
                    boxes.append((x0, y0, x1, y1, det.categories[0].score))
            out.append(boxes)
    return out


def pick(boxes, body, prev):
    """The lead's face: most overlap with their silhouette, else nearest to the last pick."""
    if not boxes:
        return None
    if body is not None:
        scored = []
        for (x0, y0, x1, y1, s) in boxes:
            cover = body[y0:y1, x0:x1].mean() if y1 > y0 and x1 > x0 else 0.0
            scored.append((cover, (x0, y0, x1, y1)))
        cover, box = max(scored)
        if cover > 0.35:
            return box
        return None
    if prev is None:
        return max(boxes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))[:4]
    px, py = (prev[0] + prev[2]) / 2, (prev[1] + prev[3]) / 2
    return min(boxes, key=lambda b: (px - (b[0] + b[2]) / 2) ** 2
               + (py - (b[1] + b[3]) / 2) ** 2)[:4]


def fill_face(frame, box, expand, feather):
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    ax = int((x1 - x0) / 2 * (1 + expand))
    ay = int((y1 - y0) / 2 * (1 + expand))
    m = np.zeros(frame.shape[:2], np.uint8)
    cv2.ellipse(m, (cx, cy), (ax, ay), 0, 0, 360, 255, -1)
    if feather > 0:
        k = feather * 2 + 1
        m = cv2.GaussianBlur(m, (k, k), 0)
    a = (m.astype(np.float32) / 255.0)[..., None]
    grey = np.full_like(frame, GREY, dtype=np.uint8)
    return (frame * (1 - a) + grey * a).astype(np.uint8)


def outline(frame, box, expand):
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    ax = int((x1 - x0) / 2 * (1 + expand))
    ay = int((y1 - y0) / 2 * (1 + expand))
    f = frame.copy()
    cv2.ellipse(f, (cx, cy), (ax, ay), 0, 0, 360, (255, 0, 0), 3)
    return f


def write(frames, path, fps, w, h):
    p = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{w}x{h}", "-r", fps, "-i", "-", "-c:v", "libx264",
         "-crf", "14", "-pix_fmt", "yuv420p", str(path)], stdin=subprocess.PIPE)
    p.communicate(frames.tobytes())
    return p.returncode


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", type=Path, required=True)
    ap.add_argument("--body-mask", type=Path,
                    help="clip already masked by mask_performer.py; picks whose face to erase")
    ap.add_argument("--expand", type=float, default=0.25,
                    help="grow the face ellipse by this fraction of its half-axes")
    ap.add_argument("--feather", type=int, default=12)
    ap.add_argument("--seed-frame", type=int, default=0)
    ap.add_argument("--preview", action="store_true",
                    help="also write *_preview.mp4 with the ellipse outlined, nothing erased")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()

    w, h, n, fps = probe(a.clip)
    src = read_frames(a.clip, w, h, n)
    bodies = None
    if a.body_mask:
        bw, bh, bn, _ = probe(a.body_mask)
        if (bw, bh) != (w, h):
            sys.exit(f"body mask is {bw}x{bh}, clip is {w}x{h}")
        bodies = body_masks(src, read_frames(a.body_mask, w, h, min(n, bn)))

    boxes_per_frame = detect_faces(src)
    out = src.copy()
    prev, hits = None, 0
    prevs = []
    for i in range(n):
        body = bodies[i] if bodies is not None and i < len(bodies) else None
        box = pick(boxes_per_frame[i], body, prev)
        if box is None and prev is not None:
            box = prev            # brief detection dropout: hold the last box
        if box is not None:
            out[i] = fill_face(src[i], box, a.expand, a.feather)
            prev = box
            hits += 1
        prevs.append(box)
    print(f"faces erased on {hits}/{n} frames")
    write(out, a.out, fps, w, h)
    print("wrote", a.out)

    if a.preview:
        pv = a.out.with_name(a.out.stem + "_preview.mp4")
        prev_frames = np.stack([
            outline(src[i], prevs[i], a.expand) if prevs[i] is not None else src[i]
            for i in range(n)])
        write(prev_frames, pv, fps, w, h)
        print("wrote", pv)
