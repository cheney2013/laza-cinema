"""Crop a photo to a bust-up around the face.

Why it exists: the face-swap reference is made by Qwen from two pictures, the clip's frame and the
replacement person's photo. In a full-length photo the face is a few percent of the picture and
Qwen reads the hairstyle badly (it kept the clip's own haircut and the Viggle swap that followed
came out as camouflage). The same photo cropped to the head and shoulders, face about 40% of the
width, gave the new hairstyle and a clean swap, twice (2026-10-04).
"""
from __future__ import annotations

from pathlib import Path

# A face already this wide (fraction of the picture's width) needs no crop.
LARGE_FACE = 0.30
# The crop, in face widths (landmark mesh width): 3:4 portrait, hair above the forehead, shoulders below.
CROP_W, CROP_H, ABOVE_FACE = 2.4, 3.3, 0.7
# 换人 needs the clothes in the picture too: to about the waist.
WIDE_W, WIDE_H = 3.6, 5.6


def bust_crop_box(face: tuple[float, float, float, float], width: int, height: int, wide: bool = False
                  ) -> tuple[int, int, int, int] | None:
    """(left, top, crop_w, crop_h) of the bust-up around `face` = (x, y, w, h) in pixels, kept
    inside the picture; None when the face is already large enough."""
    fx, fy, fw, _fh = face
    if fw <= 0 or fw / width >= LARGE_FACE:
        return None
    cw, ch = (WIDE_W, WIDE_H) if wide else (CROP_W, CROP_H)
    cw, ch = cw * fw, ch * fw
    scale = min(1.0, width / cw, height / ch)       # never ask for more picture than there is
    cw, ch = cw * scale, ch * scale
    left = min(max(0.0, fx + fw / 2 - cw / 2), width - cw)
    top = min(max(0.0, fy - ABOVE_FACE * fw * scale), height - ch)
    return int(left), int(top), int(round(cw)), int(round(ch))


def face_box(image_path: Path) -> tuple[float, float, float, float] | None:
    """(x, y, w, h) in pixels of the largest face MediaPipe finds, or None."""
    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    from wholebody_extractor import _ensure_holistic_model

    image = cv2.imread(str(image_path))
    if image is None:
        return None
    h, w = image.shape[:2]
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
    opts = vision.HolisticLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=_ensure_holistic_model()),
        running_mode=vision.RunningMode.IMAGE,
        min_pose_detection_confidence=0.3,
        min_face_detection_confidence=0.3,
        min_face_landmarks_confidence=0.3,
    )
    with vision.HolisticLandmarker.create_from_options(opts) as landmarker:
        result = landmarker.detect(mp_image)
    if not result.face_landmarks:
        return None
    xs = [p.x * w for p in result.face_landmarks]
    ys = [p.y * h for p in result.face_landmarks]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)


def crop_to_bust(src: Path, dst: Path, wide: bool = False) -> bool:
    """Write the bust-up of `src` to `dst`. False (nothing written) when no face is found or the
    face is already large."""
    import cv2

    face = face_box(src)
    if face is None:
        return False
    image = cv2.imread(str(src))
    box = bust_crop_box(face, image.shape[1], image.shape[0], wide=wide)
    if box is None:
        return False
    left, top, cw, ch = box
    return bool(cv2.imwrite(str(dst), image[top:top + ch, left:left + cw]))


def point_crop_box(x: float, y: float, width: int, height: int,
                   half_w: float = 0.14, half_h: float = 0.4) -> tuple[int, int, int, int]:
    """The (left, top, width, height) strip of an image around a point given as 0-1 fractions: the
    person the point is on, with little of the neighbours. The strip is moved, not shrunk, at an edge."""
    cw = max(2, round(2 * half_w * width))
    ch = max(2, round(2 * half_h * height))
    left = min(max(round(x * width - cw / 2), 0), max(width - cw, 0))
    top = min(max(round(y * height - ch / 2), 0), max(height - ch, 0))
    return left, top, min(cw, width), min(ch, height)


def crop_around_point(src: Path, dst: Path, x: float, y: float) -> bool:
    """Write the strip around the click (x, y as 0-1 fractions) of `src` to `dst`."""
    import cv2

    image = cv2.imread(str(src))
    if image is None:
        return False
    left, top, cw, ch = point_crop_box(x, y, image.shape[1], image.shape[0])
    return bool(cv2.imwrite(str(dst), image[top:top + ch, left:left + cw]))


# ── Which frame of a clip to repaint ─────────────────────────────────────────

# MediaPipe face-mesh points: outer corners of the eyes and the nose tip.
_EYE_L, _EYE_R, _NOSE = 33, 263, 1


def yaw_ratio(eye_l_x: float, eye_r_x: float, nose_x: float) -> float:
    """How far the nose sits from the middle of the eyes, in eye distances: 0 facing the camera,
    about +-0.5 or more for a profile. 0 when the eyes coincide (no usable face)."""
    span = eye_r_x - eye_l_x
    if abs(span) < 1e-6:
        return 0.0
    return (nose_x - (eye_l_x + eye_r_x) / 2) / abs(span)


def frontal_score(face_ratio: float, yaw: float) -> float:
    """Bigger and more frontal is better: face width over frame width, cut down by how far the
    head is turned (a full profile scores 0)."""
    return face_ratio * max(0.0, 1.0 - 2.0 * abs(yaw))


def pick_best(report: list[dict]) -> float | None:
    """The time of the highest-scoring sampled frame, or None when no frame has a face."""
    scored = [r for r in report if r.get("score", 0) > 0]
    return max(scored, key=lambda r: r["score"])["t"] if scored else None


def survey_faces(video: Path, samples: int = 24) -> tuple[list[dict], float, int]:
    """Look for a face in `samples` evenly spaced frames of the clip.

    Returns (report, duration seconds, frame count); the report has one entry per sampled frame:
    {"t", "face_ratio", "yaw", "score"} (zeros when no face was found there).
    """
    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    from wholebody_extractor import _ensure_holistic_model

    cap = cv2.VideoCapture(str(video))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    if total <= 0:
        cap.release()
        return [], 0.0, 0
    opts = vision.HolisticLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=_ensure_holistic_model()),
        running_mode=vision.RunningMode.IMAGE,
        min_pose_detection_confidence=0.3,
        min_face_detection_confidence=0.3,
        min_face_landmarks_confidence=0.3,
    )
    picks = sorted({min(total - 1, int(i * total / samples)) for i in range(samples)})
    report = []
    with vision.HolisticLandmarker.create_from_options(opts) as landmarker:
        for index in picks:
            cap.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, frame = cap.read()
            entry = {"t": round(index / fps, 3), "face_ratio": 0.0, "yaw": 0.0, "score": 0.0}
            if ok:
                h, w = frame.shape[:2]
                result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB,
                                                    data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))
                if result.face_landmarks:
                    pts = result.face_landmarks
                    xs = [p.x * w for p in pts]
                    ratio = (max(xs) - min(xs)) / w
                    yaw = yaw_ratio(pts[_EYE_L].x * w, pts[_EYE_R].x * w, pts[_NOSE].x * w)
                    entry.update(face_ratio=round(ratio, 4), yaw=round(yaw, 3),
                                 score=round(frontal_score(ratio, yaw), 4))
            report.append(entry)
    cap.release()
    return report, total / fps, total


def best_face_frame(video: Path, samples: int = 24, central: tuple[float, float] | None = None) -> float | None:
    """The second of the clip whose face is largest and most frontal; None when no sampled
    frame shows a face. `central` (fractions of the clip's length, e.g. (0.25, 0.75)) limits the
    choice to the middle of the clip: a whole-person swap needs a pose the whole clip shares, and
    the face's best frame can be the extreme of a pose change (2026-10-04, an overhead crawl that ends
    looking up: a reference from that last moment ghosted the first half, one from the middle did not)."""
    report, duration, _frames = survey_faces(video, samples)
    if central is not None and duration > 0:
        report = [r for r in report if central[0] * duration <= r["t"] <= central[1] * duration]
    return pick_best(report)
