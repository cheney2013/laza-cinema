"""YOLOv10 (COCO 'person') boxes, the detector behind the SAM 2.1 fallback masks (person_masks_large.py)."""
import os
from pathlib import Path

import cv2
import numpy as np

YOLO = Path(os.environ.get("YOLO_ONNX", "D:/ComfyUI-sage3/ComfyUI/models/detection/yolov10m.onnx"))


def person_boxes(sess, img_bgr, score=0.35):
    h, w = img_bgr.shape[:2]
    s = 640 / max(h, w)
    nh, nw = round(h * s), round(w * s)
    canvas = np.full((640, 640, 3), 114, np.uint8)
    canvas[:nh, :nw] = cv2.resize(img_bgr, (nw, nh))
    x = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0][0]
    boxes = [(r[:4] / s).tolist() for r in out if r[4] >= score and int(r[5]) == 0]
    return [[max(0, b[0]), max(0, b[1]), min(w, b[2]), min(h, b[3])] for b in boxes]
