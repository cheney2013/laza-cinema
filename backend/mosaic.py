"""Censor mosaic for platform review: detect -> SAM track -> grow -> mosaic.

Platform code only: it takes the classes, thresholds and amounts as arguments and
knows nothing about any film. The ComfyUI step (SAM 3.1 track from the detector's
points) is in workflow_builders.build_mask_track_workflow; this module is what
runs around it.

Validated 2026-10-16 on one 6.6 s H3 clip (probe, not a benchmark): a single point
from the first detection tracked all 158 frames with no empty frame and a
frame-to-frame area change of at most 0.2%. Not covered by that run: cuts (SAM does
not carry an object across one, so the clip is seeded per shot) and several people.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Iterable, Iterator, Optional

import cv2
import numpy as np

# The classes that are censored by default. Face, armpits, feet, buttocks-covered and
# every *_COVERED class are deliberately not in it: on a clothed body nudenet reads the
# outline of the cloth as FEMALE_BREAST_EXPOSED, so breast classes are opt-in.
DEFAULT_CLASSES = (
    "MALE_GENITALIA_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "ANUS_EXPOSED",
)
ALL_CLASSES = DEFAULT_CLASSES + (
    "FEMALE_BREAST_EXPOSED",
    "MALE_BREAST_EXPOSED",
    "BUTTOCKS_EXPOSED",
)
STYLES = ("mosaic", "blur", "block")
REF_SHORT_SIDE = 768  # `expand` is given in pixels at this short side and scaled to the clip


TILE_SIZES = (256, 320)   # nudenet's input is 320 px: a part that is 1/20 of the frame is ~15 px in it
TILE_MIN_SIDE = 480       # below this the whole frame is already near the detector's own size


def _iou(a: list[int], b: list[int]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    iw = min(ax + aw, bx + bw) - max(ax, bx)
    ih = min(ay + ah, by + bh) - max(ay, by)
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    return inter / (aw * ah + bw * bh - inter)


def _tile_origins(size: int, tile: int) -> list[int]:
    stride = max(1, tile // 2)
    pos = list(range(0, max(1, size - tile), stride))
    return pos + [max(0, size - tile)]


def detect_frame(detector, frame: np.ndarray, want: set[str], threshold: float,
                 tile: bool = True) -> list[dict]:
    """Detections of `want` classes in one frame: [{c, s, box:[x,y,w,h]}], boxes merged across tiles.

    The detector runs on the whole frame and, for a frame whose short side is at least
    TILE_MIN_SIDE, on overlapping native-resolution tiles as well: a small subject that the
    full-frame pass resizes into a handful of pixels is found at its own scale. Measured on a
    1280x736 clip (243 frames, 31 keyframes): the full frame found nothing in any keyframe,
    tiles of 256/320 px found the subject in 17 of 31, at one place within a few pixels.
    """
    h, w = frame.shape[:2]
    cands: list[dict] = []

    def run(img: np.ndarray, ox: int, oy: int) -> None:
        for d in detector.detect(img):
            if d["class"] in want and d["score"] >= threshold:
                x, y, bw, bh = (int(v) for v in d["box"])
                cands.append({"c": d["class"], "s": float(d["score"]), "box": [x + ox, y + oy, bw, bh]})

    run(frame, 0, 0)
    if tile and min(h, w) >= TILE_MIN_SIDE:
        for t in TILE_SIZES:
            for oy in _tile_origins(h, t):
                for ox in _tile_origins(w, t):
                    run(frame[oy:oy + t, ox:ox + t], ox, oy)
    cands.sort(key=lambda c: -c["s"])
    kept: list[dict] = []
    for c in cands:   # greedy NMS, same class
        if all(k["c"] != c["c"] or _iou(k["box"], c["box"]) < 0.3 for k in kept):
            kept.append(c)
    return kept


def detect_keyframes(video: Path, step: int = 8, classes: Iterable[str] = DEFAULT_CLASSES,
                     threshold: float = 0.25, detector=None, tile: bool = True
                     ) -> tuple[list[dict], int, float]:
    """Detections on every `step`-th frame: [{frame, boxes: [{c, s, box:[x,y,w,h]}]}], total frames, fps."""
    if detector is None:
        from nudenet import NudeDetector
        detector = NudeDetector()
    want = set(classes)
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    out, i = [], 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if i % max(1, step) == 0:
                out.append({"frame": i, "boxes": detect_frame(detector, frame, want, threshold, tile)})
            i += 1
    finally:
        cap.release()
    return out, i, float(fps)


def seed_points(dets: list[dict]) -> tuple[int, list[tuple[int, int]]]:
    """(first frame with a detection, centre of each of its boxes). (-1, []) when nothing was found."""
    for d in dets:
        if d["boxes"]:
            return d["frame"], [(b["box"][0] + b["box"][2] // 2, b["box"][1] + b["box"][3] // 2)
                                for b in d["boxes"]]
    return -1, []


def grow_mask(mask: np.ndarray, px: int) -> np.ndarray:
    """Bool mask grown by `px` pixels (round structuring element)."""
    if px <= 0 or not mask.any():
        return mask
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * px + 1, 2 * px + 1))
    return cv2.dilate(mask.astype(np.uint8), k).astype(bool)


def apply_style(frame: np.ndarray, mask: np.ndarray, style: str = "mosaic",
                block: int = 0, feather: int = 0) -> np.ndarray:
    """`frame` (BGR) with the masked pixels mosaicked, blurred or filled."""
    if not mask.any():
        return frame
    h, w = frame.shape[:2]
    if style == "block":
        cens = np.zeros_like(frame)
    elif style == "blur":
        r = max(9, (block or max(10, min(h, w) // 48)) * 3) | 1
        cens = cv2.GaussianBlur(frame, (r, r), 0)
    else:
        b = block or max(10, min(h, w) // 48)
        small = cv2.resize(frame, (max(1, w // b), max(1, h // b)), interpolation=cv2.INTER_AREA)
        cens = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    if feather > 0:
        a = cv2.GaussianBlur(mask.astype(np.float32), (2 * feather + 1, 2 * feather + 1), 0)[..., None]
        return (frame * (1 - a) + cens * a).astype(np.uint8)
    out = frame.copy()
    out[mask] = cens[mask]
    return out


def box_mask(shape: tuple[int, int], boxes: Iterable[dict]) -> np.ndarray:
    m = np.zeros(shape, bool)
    for b in boxes:
        x, y, w, h = b["box"]
        m[max(0, y):max(0, y + h), max(0, x):max(0, x + w)] = True
    return m


def box_coverage(mask: np.ndarray, box: list[int]) -> float:
    """Fraction of the detector's box that the tracked mask covers (pixels, not extents)."""
    x, y, w, h = box
    area = max(1, w * h)
    return float(mask[max(0, y):max(0, y + h), max(0, x):max(0, x + w)].sum()) / area


def _gray_frames(path: Path) -> Iterator[np.ndarray]:
    cap = cv2.VideoCapture(str(path))
    try:
        while True:
            ok, f = cap.read()
            if not ok:
                return
            yield f[..., 2] > 127 if f.ndim == 3 else f > 127
    finally:
        cap.release()


def render(source: Path, mask_video: Optional[Path], out: Path, dets: list[dict], step: int,
           *, expand: int = 12, temporal: int = 2, style: str = "mosaic", block: int = 0,
           feather: int = 4, min_coverage: float = 0.3, seed_frame: int = 0,
           ffmpeg: str = "ffmpeg") -> dict:
    """Write `out`: `source` with the tracked region censored, sound copied from `source`.

    Safety over neatness: a keyframe where the detector found something but the track
    covers under `min_coverage` of its box is censored by the box itself (and listed in
    `suspect_frames`), and the mask of each frame is the union of its `temporal` neighbours.
    Frames before `seed_frame` are not tracked; they are censored from the boxes alone.
    """
    cap = cv2.VideoCapture(str(source))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    px = int(round(expand * min(w, h) / REF_SHORT_SIDE))
    by_frame = {d["frame"]: d["boxes"] for d in dets}
    masks = _gray_frames(mask_video) if mask_video else iter(())
    suspects: list[int] = []
    proc = subprocess.Popen(
        [ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
         "-s", f"{w}x{h}", "-r", f"{fps}", "-i", "-", "-i", str(source), "-map", "0:v", "-map", "1:a?",
         "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "copy", str(out)],
        stdin=subprocess.PIPE)
    n = 0
    # The mask video starts at `seed_frame`: it is the clip from there on.
    tracked: dict[int, np.ndarray] = {}
    read = 0
    keep = max(temporal, step // 2) + 2
    try:
        def get_mask(i: int) -> np.ndarray:
            nonlocal read
            j = i - seed_frame
            while j >= read:
                m = next(masks, None)
                if m is None:
                    break
                tracked[read] = m
                read += 1
            return tracked.get(j, np.zeros((h, w), bool)) if j >= 0 else np.zeros((h, w), bool)

        keys = sorted(by_frame)
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            m = np.zeros((h, w), bool)
            lo, hi = max(seed_frame, n - temporal), n + temporal
            for k in range(lo, hi + 1):
                m |= get_mask(k)
            # nearest keyframe within half a step decides the box fallback
            near = min(keys, key=lambda k: abs(k - n)) if keys else None
            reach = max(1, step // 2)
            if near is not None and not by_frame[near]:
                # a keyframe that found nothing between two that did is a miss, not an absence:
                # fall back on the nearest keyframe with boxes within two steps
                hit = [k for k in keys if by_frame[k] and abs(k - n) <= 2 * step]
                if hit:
                    near, reach = min(hit, key=lambda k: abs(k - n)), 2 * step
            if near is not None and abs(near - n) <= reach and by_frame[near]:
                if n < seed_frame:
                    m |= box_mask((h, w), by_frame[near])
                elif any(box_coverage(get_mask(near), b["box"]) < min_coverage for b in by_frame[near]):
                    m |= box_mask((h, w), by_frame[near])
                    if n == near:
                        suspects.append(n)
            m = grow_mask(m, px)
            proc.stdin.write(apply_style(frame, m, style, block, feather).tobytes())
            for old in [t for t in tracked if t < n - seed_frame - keep]:
                del tracked[old]
            n += 1
    finally:
        cap.release()
        proc.stdin.close()
        proc.wait()
    if proc.returncode:
        raise RuntimeError(f"ffmpeg exited {proc.returncode} writing {out.name}")
    return {"frames": n, "fps": float(fps), "expand_px": px, "suspect_frames": suspects}


# ── manual seeds ──────────────────────────────────────────────────────────────
# Automatic detection is trained on photographs: on a rendered / anime frame with the part
# half hidden it put its box on a finger, consistently, and the mosaic landed there while the
# real part stayed bare (2026-10-16). A person points at the part instead; SAM tracks it.

GAP_FILL = 24   # frames: an empty stretch shorter than this, between two tracked frames, is bridged


def seeds_to_pixels(seeds: list[dict], w: int, h: int, n_frames: int) -> dict[int, list[tuple[int, int]]]:
    """{frame: [(x, y) px]} from seeds given as {frame, x, y} with x, y in 0..1 of the picture."""
    out: dict[int, list[tuple[int, int]]] = {}
    for sd in seeds:
        f = int(sd["frame"])
        if not 0 <= f < n_frames:
            raise ValueError(f"seed frame {f} is outside the clip (0..{n_frames - 1})")
        x, y = float(sd["x"]), float(sd["y"])
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            raise ValueError(f"seed point ({x}, {y}) must be inside the picture (0..1)")
        out.setdefault(f, []).append((min(w - 1, int(round(x * w))), min(h - 1, int(round(y * h)))))
    return out


def write_head_reversed(source: Path, upto: int, out: Path, ffmpeg: str = "ffmpeg") -> None:
    """Frames 0..upto of `source`, last first, so a forward track from index 0 runs backwards in time."""
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-i", str(source), "-an",
         "-vf", f"select='lte(n,{int(upto)})',reverse,setpts=N/24/TB", "-r", "24",
         "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", str(out)],
        check=True, capture_output=True)


def fill_gaps(masks: list[Optional[np.ndarray]], gap: int = GAP_FILL) -> tuple[list[np.ndarray], list[int]]:
    """Masks with short empty stretches bridged, and the frames that needed it or stayed empty.

    `masks[i]` is None or empty where the track had nothing. A stretch of at most `gap` frames
    with a tracked frame on both sides takes the nearer side's mask (the part is occluded, not
    gone); the frame numbers returned are what to look at: bridged ones and still-empty ones
    inside the tracked span.
    """
    n = len(masks)
    live = [i for i, m in enumerate(masks) if m is not None and m.any()]
    out: list[np.ndarray] = []
    flagged: list[int] = []
    shape = next((m.shape for m in masks if m is not None), (1, 1))
    for i in range(n):
        m = masks[i]
        if m is not None and m.any():
            out.append(m)
            continue
        prev = max((j for j in live if j < i), default=None)
        nxt = min((j for j in live if j > i), default=None)
        if prev is not None and nxt is not None and nxt - prev - 1 <= gap:
            src = prev if i - prev <= nxt - i else nxt
            out.append(masks[src])
            flagged.append(i)
        else:
            out.append(np.zeros(shape, bool))
            if live and live[0] < i < live[-1]:
                flagged.append(i)
    return out, flagged


def clean_track(masks: Iterable[np.ndarray], seed_xy: tuple[int, int],
                max_jump: float = 0.12, area_factor: float = 4.0) -> list[Optional[np.ndarray]]:
    """A SAM track with the frames where it wandered off treated as lost (None).

    When the part is occluded SAM re-acquires something else; on one clip it put the mask on
    the face and body (28% of the frame at 0.13% normal). Per frame, only the connected pieces
    whose centre lies within `max_jump` x the picture's short side of the last accepted
    position are kept; a frame whose kept area is more than `area_factor` x the track's median
    is dropped whole. The first reference is the seed point itself.
    """
    frames = list(masks)
    if not frames:
        return []
    h, w = frames[0].shape
    reach = max_jump * min(h, w)
    ref = (float(seed_xy[0]), float(seed_xy[1]))
    kept: list[Optional[np.ndarray]] = []
    for m in frames:
        if not m.any():
            kept.append(None)
            continue
        n, lab, _stats, cents = cv2.connectedComponentsWithStats(m.astype(np.uint8), connectivity=8)
        ok = [i for i in range(1, n) if np.hypot(cents[i][0] - ref[0], cents[i][1] - ref[1]) <= reach]
        if not ok:
            kept.append(None)
            continue
        out = np.isin(lab, ok)
        kept.append(out)
        ys, xs = np.nonzero(out)
        ref = (float(xs.mean()), float(ys.mean()))
    areas = [int(m.sum()) for m in kept if m is not None]
    if areas:
        cap = area_factor * float(np.median(areas))
        kept = [m if m is not None and m.sum() <= cap else None for m in kept]
    return kept


def union_tracks(tracks: list[tuple[Path, int, bool, tuple[int, int]]], n_frames: int, out: Path,
                 size: tuple[int, int], ffmpeg: str = "ffmpeg") -> dict:
    """One mask video (white = censor) from SAM tracks.

    `tracks` is [(mask_video, first_frame, reversed, seed_xy)]: a forward track's frame k is clip frame
    first_frame + k; a reversed one (from write_head_reversed) is clip frame first_frame - k.
    Frames are the union over tracks, short gaps bridged by fill_gaps.
    """
    w, h = size
    masks: list[Optional[np.ndarray]] = [None] * n_frames
    for path, first, rev, seed_xy in tracks:
        raw = [m if m.shape == (h, w) else cv2.resize(m.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST).astype(bool)
               for m in _gray_frames(path)]
        for k, m in enumerate(clean_track(raw, seed_xy)):
            i = first - k if rev else first + k
            if m is None or not 0 <= i < n_frames:
                continue
            masks[i] = m if masks[i] is None else (masks[i] | m)
    filled, flagged = fill_gaps(masks)
    proc = subprocess.Popen(
        [ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{w}x{h}",
         "-r", "24", "-i", "-", "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", str(out)],
        stdin=subprocess.PIPE)
    try:
        for m in filled:
            proc.stdin.write((m.astype(np.uint8) * 255).tobytes())
    finally:
        proc.stdin.close()
        proc.wait()
    if proc.returncode:
        raise RuntimeError(f"ffmpeg exited {proc.returncode} writing {out.name}")
    # a sudden change of the tracked area is the other thing worth a look
    areas = np.array([m.mean() for m in filled])
    jumps = [int(i) for i in np.nonzero(np.abs(np.diff(areas)) > max(0.002, 0.6 * float(areas.max())))[0] + 1] if areas.size > 1 and areas.max() > 0 else []
    return {"tracked_frames": int((areas > 0).sum()), "flagged_frames": sorted(set(flagged + jumps)),
            "bridged_frames": len([i for i in flagged if filled[i].any()])}
