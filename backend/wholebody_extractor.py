"""
Wholebody 3D joint extractor using MediaPipe HolisticLandmarker (Tasks API, v0.10+).
Outputs unified 3D coordinates (body + hands + face key points) as JSON.

The holistic_landmarker.task model (~29 MB) is downloaded automatically on first run.
"""

import json
import urllib.request
from pathlib import Path

MODELS_DIR = Path(__file__).parent / "mediapipe_models"
HOLISTIC_MODEL_FILENAME = "holistic_landmarker.task"
HOLISTIC_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/"
    "holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task"
)


def _ensure_holistic_model() -> str:
    MODELS_DIR.mkdir(exist_ok=True)
    path = MODELS_DIR / HOLISTIC_MODEL_FILENAME
    if not path.exists():
        print(f"[wholebody] Downloading {HOLISTIC_MODEL_FILENAME} (~29 MB)…")
        urllib.request.urlretrieve(HOLISTIC_MODEL_URL, str(path))
        print(f"[wholebody] Model downloaded to {path}")
    return str(path)


# ── MediaPipe landmark indices ────────────────────────────────────────────────

BODY_CONNECTIONS = [
    # Face region
    (0, 1), (1, 2), (2, 3), (3, 7),
    (0, 4), (4, 5), (5, 6), (6, 8),
    (9, 10),
    # Torso
    (11, 12), (11, 13), (13, 15),
    (12, 14), (14, 16),
    (11, 23), (12, 24), (23, 24),
    # Left leg
    (23, 25), (25, 27), (27, 29), (29, 31),
    # Right leg
    (24, 26), (26, 28), (28, 30), (30, 32),
    # Feet
    (27, 31), (28, 32),
]

HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),       # thumb
    (0, 5), (5, 6), (6, 7), (7, 8),       # index
    (0, 9), (9, 10), (10, 11), (11, 12),  # middle
    (0, 13), (13, 14), (14, 15), (15, 16),# ring
    (0, 17), (17, 18), (18, 19), (19, 20),# pinky
    (5, 9), (9, 13), (13, 17),            # palm
]

# 68 representative landmarks from the 468-point face mesh
FACE_KEY_INDICES = [
    # Jaw contour (17)
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400,
    # Right eyebrow (5)
    46, 53, 52, 65, 55,
    # Left eyebrow (5)
    285, 295, 282, 283, 276,
    # Nose bridge (4)
    168, 6, 197, 195,
    # Nose bottom (5)
    5, 4, 1, 19, 94,
    # Right eye (6)
    33, 7, 163, 144, 145, 153,
    # Left eye (6)
    362, 382, 381, 380, 374, 373,
    # Outer mouth (12)
    61, 39, 37, 0, 267, 269, 291, 321, 314, 17, 84, 181,
    # Inner mouth (8)
    78, 95, 88, 178, 87, 14, 317, 402,
]

FACE_KEY_CONNECTIONS = [
    # Jaw contour
    (0,1),(1,2),(2,3),(3,4),(4,5),(5,6),(6,7),(7,8),(8,9),(9,10),(10,11),(11,12),(12,13),(13,14),(14,15),(15,16),
    # Right eyebrow
    (17,18),(18,19),(19,20),(20,21),
    # Left eyebrow
    (22,23),(23,24),(24,25),(25,26),
    # Nose bridge
    (27,28),(28,29),(29,30),
    # Nose bottom
    (31,32),(32,33),(33,34),(34,35),
    # Right eye
    (36,37),(37,38),(38,39),(39,40),(40,41),(41,36),
    # Left eye
    (42,43),(43,44),(44,45),(45,46),(46,47),(47,42),
    # Outer mouth
    (48,49),(49,50),(50,51),(51,52),(52,53),(53,54),(54,55),(55,56),(56,57),(57,58),(58,59),(59,48),
    # Inner mouth
    (60,61),(61,62),(62,63),(63,64),(64,65),(65,66),(66,67),(67,60),
]


def extract_wholebody_3d(image_path: str) -> dict:
    """
    Run MediaPipe HolisticLandmarker on `image_path`.
    Returns a dict with 3D joint positions in Three.js world space:
      body (33 pts), left_hand (21 pts), right_hand (21 pts), face (68 pts)
    """
    import cv2
    import numpy as np
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    image = cv2.imread(image_path)
    if image is None:
        raise ValueError(f"Cannot read image: {image_path}")
    h, w = image.shape[:2]
    image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=image_rgb)

    model_path = _ensure_holistic_model()
    opts = vision.HolisticLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=model_path),
        running_mode=vision.RunningMode.IMAGE,
        min_pose_detection_confidence=0.5,
        min_pose_landmarks_confidence=0.5,
        min_hand_landmarks_confidence=0.3,
        min_face_detection_confidence=0.5,
        min_face_landmarks_confidence=0.5,
    )

    with vision.HolisticLandmarker.create_from_options(opts) as landmarker:
        result = landmarker.detect(mp_image)

    if not result.pose_world_landmarks:
        raise ValueError("未能检测到人物姿势 — 请确保图片中有清晰的完整人体")

    # ── Body: 33 world landmarks (meters, origin ≈ hip center) ──────────────
    # MediaPipe world Y increases downward → flip Y and Z for Three.js (Y-up, -Z forward)
    body = [[lm.x, -lm.y, -lm.z] for lm in result.pose_world_landmarks]

    # ── Hands: world landmarks already in meters ─────────────────────────────
    # Origin = geometric center of hand. We translate so wrist (lm[0]) matches
    # the corresponding body wrist world landmark.
    def place_hand_in_world(hand_world_lm, body_wrist_world):
        wrist_canonical = np.array([hand_world_lm[0].x, -hand_world_lm[0].y, -hand_world_lm[0].z])
        body_wrist      = np.array(body_wrist_world)
        T = body_wrist - wrist_canonical
        return [
            (np.array([lm.x, -lm.y, -lm.z]) + T).tolist()
            for lm in hand_world_lm
        ]

    left_hand: list = []
    right_hand: list = []

    if result.left_hand_world_landmarks:
        left_hand = place_hand_in_world(result.left_hand_world_landmarks, body[15])
    if result.right_hand_world_landmarks:
        right_hand = place_hand_in_world(result.right_hand_world_landmarks, body[16])

    # ── Face: 468-pt normalized mesh → world space via nose anchor ───────────
    face: list = []
    if result.face_landmarks:
        all_face = result.face_landmarks
        # Landmark 1 in the face mesh ≈ nose tip (close to body landmark 0)
        nose_face = all_face[1]
        nose_body = np.array(body[0])

        # Scale by ear-to-ear distance from body world landmarks
        ear_l = np.array(body[7])
        ear_r = np.array(body[8])
        head_width = float(np.linalg.norm(ear_l - ear_r))
        face_scale = max(head_width, 0.12)   # at least 12 cm

        for idx in FACE_KEY_INDICES:
            lm = all_face[idx]
            delta = np.array([
                lm.x - nose_face.x,
                -(lm.y - nose_face.y),   # image Y down → world -Y
                -(lm.z - nose_face.z),   # depth → -Z forward
            ])
            face.append((nose_body + delta * face_scale).tolist())

    return {
        "body": body,
        "body_connections": BODY_CONNECTIONS,
        "left_hand": left_hand,
        "right_hand": right_hand,
        "hand_connections": HAND_CONNECTIONS,
        "face": face,
        "face_connections": FACE_KEY_CONNECTIONS,
        "image_width": w,
        "image_height": h,
        "detected": {
            "body": True,
            "left_hand": len(left_hand) > 0,
            "right_hand": len(right_hand) > 0,
            "face": len(face) > 0,
        },
    }


if __name__ == "__main__":
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else "test.jpg"
    data = extract_wholebody_3d(path)
    print(json.dumps({
        "body_count": len(data["body"]),
        "left_hand_count": len(data["left_hand"]),
        "right_hand_count": len(data["right_hand"]),
        "face_count": len(data["face"]),
        "detected": data["detected"],
    }, indent=2))
