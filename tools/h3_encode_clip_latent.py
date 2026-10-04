"""
Give a finished clip an H3 latent, so it can go through the H3 latent upscale.

A clip assembled outside the sampler -- an AV extension, a bridge, anything spliced
from pixels -- has no latent of its own, and the upscale backend refuses such a
clip or used to fall back to SeedVR2 (since removed), which gave it a different HD
look from its neighbours. Re-running the render to get the latent does not work either: chain 5
v31 re-run with the same seed and settings came back a different take
(PSNR 23 dB over the regenerated part).

So the clip itself is encoded: the H3 video VAE and audio VAE, joined into one
audio+video latent with ComfyUI's core LTXVConcatAVLatent (H3's latent is the same
video-then-audio nested structure), and saved the way the chain renders save theirs.

The H3 video VAE only takes 17n+5 frames. A clip off that grid is padded at the end
by repeating its last frame -- never trimmed at the head, because the upscale
backend reads "latent longer than the video" as a chain context and cuts that many
frames off the front. Upscale against the padded video, then cut the padding off.

The graph also decodes the latent straight back and saves it, so the round trip
can be checked against the source before anything is built on it.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
import urllib.request

COMFY = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8189")
VIDEO_VAE = "minimax_h3_video_vae_int8_convrot.safetensors"
AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"


def grid_length(frames: int) -> int:
    n = max(5, frames)
    while n % 17 != 5:
        n += 1
    return n


def frame_count(path: str) -> int:
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v",
                          "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True).stdout
    return int(out.strip())


def pad_to_grid(src: str, out: str) -> tuple[int, int]:
    frames = frame_count(src)
    target = grid_length(frames)
    pad = target - frames
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src,
                    "-vf", f"tpad=stop_mode=clone:stop={pad}",
                    "-af", f"apad=whole_dur={target / 24:.6f}",
                    # near-lossless: the VAE's own error is far larger than this
                    "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "256k", out], check=True)
    return frames, target


def build(video_path: str, prefix: str) -> dict:
    return {
        "1": {"class_type": "VHS_LoadVideoPath", "inputs": {
            "video": video_path, "force_rate": 24, "custom_width": 0, "custom_height": 0,
            "frame_load_cap": 0, "skip_first_frames": 0, "select_every_nth": 1}},
        "2": {"class_type": "VAELoader", "inputs": {"vae_name": VIDEO_VAE}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": AUDIO_VAE}},
        "4": {"class_type": "MiniMaxH3AudioVAECompatibility", "inputs": {"audio_vae": ["3", 0]}},
        "5": {"class_type": "VAEEncode", "inputs": {"pixels": ["1", 0], "vae": ["2", 0]}},
        "6": {"class_type": "VAEEncodeAudio", "inputs": {"audio": ["1", 2], "vae": ["4", 0]}},
        "7": {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": ["5", 0], "audio_latent": ["6", 0]}},
        "8": {"class_type": "MiniMaxH3MotionContextSaveLatent", "inputs": {
            "latent": ["7", 0], "filename_prefix": prefix, "clip_index": 0}},
        # round trip, for checking the encode before anything is built on it
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["2", 0]}},
        "10": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["7", 0], "vae": ["4", 0]}},
        "11": {"class_type": "CreateVideo", "inputs": {"images": ["9", 0], "fps": 24.0, "audio": ["10", 0]}},
        "12": {"class_type": "SaveVideo", "inputs": {
            "video": ["11", 0], "filename_prefix": prefix + "_roundtrip", "format": "mp4", "codec": "h264"}},
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", required=True, help="The finished clip.")
    ap.add_argument("--padded", required=True, help="Where to write the grid-padded copy (ComfyUI input dir).")
    ap.add_argument("--prefix", required=True, help="Output prefix for the latent, e.g. H3_Latent_c5v31enc")
    args = ap.parse_args()

    frames, target = pad_to_grid(args.source, args.padded)
    print(f"{frames} frames -> padded to {target} (+{target - frames})")
    wf = build(args.padded, args.prefix)
    req = urllib.request.Request(f"{COMFY}/prompt", data=json.dumps({"prompt": wf}).encode(),
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
