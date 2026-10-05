"""Person masks: YOLOv10 boxes + SAM 2.1 *large* (official .pt, image mode, one frame at a time).
Run with the HY-World-2.0 venv:  python person_masks_large.py <frames_dir> <mask_dir> [--dilate 4] [--score 0.3]"""
import argparse
import os
from pathlib import Path

import cv2
import numpy as np

from person_masks import YOLO, person_boxes

CKPT = Path(os.environ.get("SAM2_CKPT", "D:/hf_cache/hub/models--facebook--sam2.1-hiera-large/snapshots/"
                           "665f8e2ad61cf5f53d65644ff27c8ee525124610/sam2.1_hiera_large.pt"))
CFG = "configs/sam2.1/sam2.1_hiera_l.yaml"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frames")
    ap.add_argument("out")
    ap.add_argument("--dilate", type=int, default=4)
    ap.add_argument("--score", type=float, default=0.3)
    a = ap.parse_args()
    import onnxruntime as ort
    import torch
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    sess = ort.InferenceSession(str(YOLO), providers=["CPUExecutionProvider"])
    pred = SAM2ImagePredictor(build_sam2(CFG, str(CKPT), device="cuda"))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    k = np.ones((2 * a.dilate + 1,) * 2, np.uint8) if a.dilate else None
    files = sorted(list(Path(a.frames).glob("*.png")) + list(Path(a.frames).glob("*.jpg")))
    for f in files:
        bgr = cv2.imread(str(f))
        h, w = bgr.shape[:2]
        mask = np.zeros((h, w), np.uint8)
        boxes = person_boxes(sess, bgr, a.score)
        if boxes:
            with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                pred.set_image(bgr[:, :, ::-1].copy())
                for b in boxes:
                    m, sc, _ = pred.predict(box=np.array(b, np.float32), multimask_output=False)
                    mask[m[0] > 0] = 255
            if k is not None:
                mask = cv2.dilate(mask, k)
        cv2.imwrite(str(out / (f.stem + ".png")), mask)
        print(f.name, len(boxes), "boxes", int((mask > 0).mean() * 100), "% masked", flush=True)


if __name__ == "__main__":
    main()
