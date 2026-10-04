"""
Decode a saved H3 chain latent back to video, context window included.

A motion-context chain regenerates the previous clip's last frames at its head
and the clip on disk has them trimmed off. Those regenerated frames are what a
join crossfade needs: they show the same motion as the previous clip's tail, so
fading from the real tail to them over the overlap hides the small jump a hard
cut at the trim point leaves (chain 1 -> 2: 37.9 dB at the join against 45-48
between ordinary neighbours, the same on a second seed).
"""
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.request

COMFY = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8189")
VIDEO_VAE = "minimax_h3_video_vae_int8_convrot.safetensors"
AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"


def build(latent: str, prefix: str) -> dict:
    return {
        "1": {"class_type": "MiniMaxH3MotionContextLoadLatent", "inputs": {"latent_path": latent, "clip_index": 0}},
        # the loader returns a plain list; a scale-1 upscale turns it into the nested latent VAEDecode expects
        "2": {"class_type": "MiniMaxH3LatentUpscaleBy", "inputs": {"samples": ["1", 0], "upscale_method": "bicubic", "scale_by": 1.0}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VIDEO_VAE}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": AUDIO_VAE}},
        "5": {"class_type": "VAEDecode", "inputs": {"samples": ["2", 0], "vae": ["3", 0]}},
        "6": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["2", 0], "vae": ["4", 0]}},
        "7": {"class_type": "CreateVideo", "inputs": {"images": ["5", 0], "fps": 24.0, "audio": ["6", 0]}},
        "8": {"class_type": "SaveVideo", "inputs": {"video": ["7", 0], "filename_prefix": prefix, "format": "mp4", "codec": "h264"}},
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--latent", required=True, help="e.g. H3_Latent_68273b09_00001_.safetensors")
    ap.add_argument("--prefix", required=True, help="output prefix, e.g. H3_Decode_68273b09_full")
    args = ap.parse_args()
    req = urllib.request.Request(f"{COMFY}/prompt", data=json.dumps({"prompt": build(args.latent, args.prefix)}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        prompt_id = json.load(urllib.request.urlopen(req))["prompt_id"]
    except urllib.error.HTTPError as exc:
        print(exc.read().decode()[:1500]); raise SystemExit(1)
    while True:
        time.sleep(4)
        hist = json.load(urllib.request.urlopen(f"{COMFY}/history/{prompt_id}"))
        if prompt_id in hist:
            print(json.dumps(hist[prompt_id]["outputs"])[:800])
            status = hist[prompt_id].get("status", {})
            if status.get("status_str") == "error":
                print(json.dumps(status)[:1500])
            return


if __name__ == "__main__":
    main()
