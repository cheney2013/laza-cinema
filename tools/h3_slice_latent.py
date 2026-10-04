"""
Cut an H3 chain latent to its first N frames (the core is backend/latent_slice.py).

    python tools/h3_slice_latent.py --latent H3_Latent_c1d59ff8_00001_.safetensors --frames 175

writes H3_Latent_c1d59ff8_cut175_00001_.safetensors next to it (the ComfyUI output
folder). The length must be on the 17n+5 grid (5, 22, ... 175, 192, 209 ...).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
from latent_slice import slice_latent  # noqa: E402

OUT = Path(os.environ.get("COMFYUI_OUTPUT_DIR", r"D:\ComfyUI-sage3\ComfyUI\output"))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--latent", required=True, help="file name in the ComfyUI output folder")
    ap.add_argument("--frames", type=int, required=True, help="clip length to keep, on the 17n+5 grid")
    args = ap.parse_args()
    src = OUT / args.latent
    tag = src.stem.replace("H3_Latent_", "").rstrip("_").rsplit("_", 1)[0]
    dst = OUT / f"H3_Latent_{tag}_cut{args.frames}_00001_.safetensors"
    print(json.dumps(slice_latent(src, args.frames, dst)))


if __name__ == "__main__":
    main()
