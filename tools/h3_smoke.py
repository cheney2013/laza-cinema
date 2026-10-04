"""Smoke-test MiniMax H3 against the local ComfyUI and report the numbers that
decide whether a film is affordable: wall time, peak VRAM, and whether a 32GB
card can hold the 21GB diffusion model and the 15.7GB text encoder at all.

    backend\\.venv\\Scripts\\python tools\\h3_smoke.py --seconds 5

The graph is the official `video_minimax_h3_t2v` template rebuilt in API form:
res_multistep / beta / 20 steps / BasicGuider (no CFG) / 24fps, decoding the one
packed latent twice — VAEDecode pulls the video half, VAEDecodeAudio the audio.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
import uuid

COMFY = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/")

DIFFUSION_T2V = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
DIFFUSION_R2V = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
TEXT_ENCODER = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"

# H3 samples on a 17k+5 frame grid at 24fps; the official template does this
# conversion in a ComfyMathExpression node.
FPS = 24
TRAINED_MIN, TRAINED_MAX = 124, 362


def frame_length(seconds: float) -> int:
    n = max(5, round(seconds * FPS))
    return n + (5 - n % 17) % 17


def _get(path: str, timeout: int = 60):
    with urllib.request.urlopen(f"{COMFY}{path}", timeout=timeout) as r:
        return json.load(r)


def _post(path: str, payload: dict, timeout: int = 60):
    req = urllib.request.Request(
        f"{COMFY}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def build_t2v_graph(prompt: str, width: int, height: int, length: int, seed: int,
                    steps: int, scheduler: str, prefix: str,
                    shift: tuple[float, float] | None = None,
                    sage: str | None = None, memeff: bool = False,
                    sol_attn: bool = False, sol_tau: float = 1.3,
                    sol_int8_qk: bool = False, sol_chunk_ffn: int = 0,
                    model: str | None = None, weight_dtype: str = "default") -> dict:
    # The official templates don't patch sigma shift at all, so the model runs on its
    # internal default. MiniMaxH3SigmaShift exposes video/audio separately (12.0/3.0),
    # which is the only documented knob aimed at the audio half of the latent.
    model_src = ["1", 0]
    graph = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": model or DIFFUSION_T2V,
                         "weight_dtype": weight_dtype}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": TEXT_ENCODER, "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VIDEO_VAE}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": AUDIO_VAE}},
        "5": {"class_type": "MiniMaxH3ImageToVideo",
              "inputs": {"clip": ["2", 0], "vae": ["3", 0], "prompt": prompt,
                         "width": width, "height": height, "length": length}},
        "6": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "7": {"class_type": "BasicScheduler",
              "inputs": {"model": model_src, "scheduler": scheduler,
                         "steps": steps, "denoise": 1.0}},
        "8": {"class_type": "BasicGuider",
              "inputs": {"model": model_src, "conditioning": ["5", 0]}},
        "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "10": {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": ["9", 0], "guider": ["8", 0], "sampler": ["6", 0],
                          "sigmas": ["7", 0], "latent_image": ["5", 1]}},
        "11": {"class_type": "VAEDecode", "inputs": {"samples": ["10", 0], "vae": ["3", 0]}},
        "12": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["10", 0], "vae": ["4", 0]}},
        "13": {"class_type": "CreateVideo",
               "inputs": {"images": ["11", 0], "fps": FPS, "audio": ["12", 0]}},
        "14": {"class_type": "SaveVideo",
               "inputs": {"video": ["13", 0], "filename_prefix": prefix,
                          "format": "auto", "codec": "auto"}},
    }
    if shift:
        graph["15"] = {"class_type": "MiniMaxH3SigmaShift",
                       "inputs": {"model": ["1", 0],
                                  "shift_video": shift[0], "shift_audio": shift[1]}}
        graph["7"]["inputs"]["model"] = ["15", 0]
        graph["8"]["inputs"]["model"] = ["15", 0]
    if sage:
        # As a node at the end of the model chain, never ComfyUI's --use-sage-attention
        # launch flag, which produces black output on Wan and Qwen here. Only "auto" works
        # with SageAttention 1.x; the commonly-quoted sageattn_qk_int8_pv_fp16_cuda is a
        # 2.x API and fails in five seconds, which reads as a 98% speedup on a stopwatch.
        src = graph["7"]["inputs"]["model"]
        graph["16"] = {"class_type": "PathchSageAttentionKJ",
                       "inputs": {"model": src, "sage_attention": sage,
                                  "allow_compile": False}}
        graph["7"]["inputs"]["model"] = ["16", 0]
        graph["8"]["inputs"]["model"] = ["16", 0]
    if memeff:
        # KJNodes' H3-specific patch. It replaces every transformer block's attention
        # forward, so it *overrides* whatever PathchSageAttentionKJ did — do not expect
        # the two to compose. Needs a compiled SageAttention 2.x (it reads
        # sageattention.core.get_cuda_arch_versions), which only exists on a matching
        # torch ABI + CUDA branch + sm_120 build.
        src = graph["7"]["inputs"]["model"]
        graph["17"] = {"class_type": "MiniMaxH3MemoryEfficientSageAttentionPatch",
                       "inputs": {"model": src}}
        graph["7"]["inputs"]["model"] = ["17", 0]
        graph["8"]["inputs"]["model"] = ["17", 0]
    if sol_attn:
        src = graph["7"]["inputs"]["model"]
        graph["18"] = {
            "class_type": "MiniMaxH3MemoryEfficientSolAttentionPatch",
            "inputs": {
                "model": src,
                "enabled": True,
                "tau": float(sol_tau),
                "min_tokens": 4096,
                "strict": False,
                "thresh_type": "diag",
                "int8_qk": bool(sol_int8_qk),
                "int8_pv": False,
                "sink_conditioning": "exact_kv",
                "dense_blocks": "",
            },
        }
        curr = ["18", 0]
        if sol_chunk_ffn > 0:
            graph["19"] = {
                "class_type": "MiniMaxH3ChunkFeedForward",
                "inputs": {
                    "model": curr,
                    "enabled": True,
                    "chunks": int(sol_chunk_ffn),
                    "min_tokens": 8192,
                },
            }
            curr = ["19", 0]
        graph["7"]["inputs"]["model"] = curr
        graph["8"]["inputs"]["model"] = curr
    return graph


def preflight() -> bool:
    """Fail loudly on a missing weight rather than inside ComfyUI's enum validation."""
    info = _get("/object_info", timeout=180)
    have = {
        "diffusion_models": set(info["UNETLoader"]["input"]["required"]["unet_name"][0]),
        "text_encoders": set(info["CLIPLoader"]["input"]["required"]["clip_name"][0]),
        "vae": set(info["VAELoader"]["input"]["required"]["vae_name"][0]),
    }
    wanted = [("diffusion_models", DIFFUSION_T2V), ("diffusion_models", DIFFUSION_R2V),
              ("text_encoders", TEXT_ENCODER), ("vae", VIDEO_VAE), ("vae", AUDIO_VAE)]
    ok = True
    for folder, name in wanted:
        present = name in have[folder]
        # ref2va is only needed by the R2V path; report but don't block the smoke test.
        blocking = name != DIFFUSION_R2V
        print(f"  [{'ok ' if present else 'MISSING'}] {folder}/{name}")
        if not present and blocking:
            ok = False
    clip_types = info["CLIPLoader"]["input"]["required"]["type"][0]
    if "minimax" not in clip_types:
        print(f"  [MISSING] CLIPLoader has no 'minimax' type — ComfyUI is too old "
              f"(needs 0.30.0+). Types: {clip_types}")
        ok = False
    return ok


def main() -> int:
    global COMFY  # must precede any read of COMFY in this scope, including a default=
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--width", type=int, default=1344)
    ap.add_argument("--height", type=int, default=768)
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--scheduler", default="beta")
    ap.add_argument("--seed", type=int, default=12345)
    ap.add_argument("--prefix", default="video/h3_smoke")
    ap.add_argument("--prompt-file", type=str,
                    help="read the prompt from a UTF-8 file instead of --prompt")
    ap.add_argument("--shift-video", type=float,
                    help="patch MiniMaxH3SigmaShift (node default 12.0); "
                         "needs --shift-audio too")
    ap.add_argument("--shift-audio", type=float,
                    help="sigma shift for the audio half of the latent (node default 3.0)")
    ap.add_argument("--comfy", default=COMFY,
                    help="ComfyUI base URL — point at a sandbox instance to A/B a "
                         "different torch/SageAttention stack against the production one")
    ap.add_argument("--model", default=None,
                    help=f"diffusion model filename (default {DIFFUSION_T2V}) — use to "
                         "A/B a different quantisation of the same weights")
    ap.add_argument("--weight-dtype", default="default",
                    choices=["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"],
                    help="UNETLoader weight_dtype; fp8_e4m3fn_fast enables Blackwell's "
                         "fast fp8 matmul path and only makes sense on an fp8 checkpoint")
    ap.add_argument("--memeff", action="store_true",
                    help="apply KJNodes' MiniMaxH3MemoryEfficientSageAttentionPatch "
                         "(needs compiled SageAttention 2.x)")
    ap.add_argument("--sage", nargs="?", const="auto", default=None,
                    help="patch SageAttention via KJNodes (default mode 'auto'; only auto "
                         "works with SageAttention 1.x). Verify the picture afterwards — a "
                         "degenerate attention path shows up as black or washed frames, "
                         "which a wall-clock measurement alone will not catch.")
    ap.add_argument("--sol-attn", action="store_true",
                    help="apply MiniMaxH3MemoryEfficientSolAttentionPatch (NVIDIA Sol-Attn "
                         "sparse attention via Triton)")
    ap.add_argument("--sol-tau", type=float, default=1.3,
                    help="Sol-Attn routing threshold (default 1.3)")
    ap.add_argument("--sol-int8-qk", action="store_true",
                    help="quantize Q/K to int8 for Sol-Attn (faster on SM120 Blackwell)")
    ap.add_argument("--sol-chunk-ffn", type=int, default=0,
                    help="chunk FFN activations to reduce peak VRAM (e.g. 2)")
    ap.add_argument("--prompt", default=(
        "Handheld documentary look, warm tungsten work light, shallow depth of field, "
        "35mm film grain. A cluttered foley studio at night: gravel pit in the floor, "
        "a free-standing door frame on a rack, two boom mics overhead.\n\n"
        "Timeline:\n"
        "[0s-2.5s] A woman in a grey work shirt steps into the gravel pit and takes four "
        "deliberate steps, watching something off-screen. The camera holds still.\n"
        "[2.5s-5s] She stops mid-step and looks up, listening.\n\n"
        "Audio: close-miked footsteps in coarse gravel, quiet room tone, a faint "
        "air-conditioning hum. Diegetic sound only, no music, no score."))
    args = ap.parse_args()

    COMFY = args.comfy.rstrip("/")

    if args.prompt_file:
        from pathlib import Path
        args.prompt = Path(args.prompt_file).read_text(encoding="utf-8")
    shift = None
    if (args.shift_video is None) != (args.shift_audio is None):
        ap.error("--shift-video and --shift-audio must be given together")
    if args.shift_video is not None:
        shift = (args.shift_video, args.shift_audio)

    length = frame_length(args.seconds)
    print(f"ComfyUI   {COMFY}")
    try:
        stats = _get("/system_stats", timeout=15)
    except (urllib.error.URLError, OSError) as e:
        print(f"!! ComfyUI unreachable: {e}")
        return 2
    dev = stats["devices"][0]
    print(f"version   {stats['system']['comfyui_version']}")
    print(f"device    {dev['name']}  {dev['vram_total'] / 2**30:.1f} GB total, "
          f"{dev['vram_free'] / 2**30:.1f} GB free")
    print("weights:")
    if not preflight():
        print("\n!! weights not ready — the download is still running.")
        return 1

    print(f"\nrequest   {args.width}x{args.height}  {length} frames "
          f"({length / FPS:.2f}s @ {FPS}fps)  steps={args.steps} "
          f"scheduler={args.scheduler} seed={args.seed}")
    if not TRAINED_MIN <= length <= TRAINED_MAX:
        print(f"  ! {length} frames is outside the trained range "
              f"{TRAINED_MIN}-{TRAINED_MAX} — quality is untested here")

    if shift:
        print(f"          sigma shift video={shift[0]} audio={shift[1]}")
    if args.sage:
        print(f"          sage_attention={args.sage}")
    if args.memeff:
        print("          MiniMaxH3MemoryEfficientSageAttentionPatch")
    if args.sol_attn:
        print(f"          Sol-Attn (tau={args.sol_tau}, int8_qk={args.sol_int8_qk}, chunk_ffn={args.sol_chunk_ffn})")
    print(f"          model={args.model or DIFFUSION_T2V} "
          f"weight_dtype={args.weight_dtype}")
    graph = build_t2v_graph(args.prompt, args.width, args.height, length,
                            args.seed, args.steps, args.scheduler, args.prefix, shift,
                            args.sage, args.memeff,
                            args.sol_attn, args.sol_tau, args.sol_int8_qk, args.sol_chunk_ffn,
                            args.model, args.weight_dtype)
    client_id = str(uuid.uuid4())
    resp = _post("/prompt", {"prompt": graph, "client_id": client_id})
    if "prompt_id" not in resp:
        print("!! ComfyUI rejected the graph:")
        print(json.dumps(resp, indent=2, ensure_ascii=False)[:4000])
        return 1
    pid = resp["prompt_id"]
    print(f"queued    {pid}\n")

    t0 = time.time()
    vram_used = []
    last_note = 0.0
    while True:
        time.sleep(3)
        try:
            d = _get("/system_stats", timeout=15)["devices"][0]
            used = (d["vram_total"] - d["vram_free"]) / 2**30
            vram_used.append(used)
        except (urllib.error.URLError, OSError):
            used = float("nan")
        # ComfyUI stalls its event loop while it pages a 15GB text encoder in and out,
        # so a poll can simply time out mid-run. Losing the script does not stop the
        # job, and treating a timeout as failure throws away a five-minute render.
        try:
            hist = _get(f"/history/{pid}", timeout=30)
        except (urllib.error.URLError, OSError) as e:
            print(f"  poll failed ({type(e).__name__}) — job is still queued, retrying")
            continue
        el = time.time() - t0
        if pid in hist:
            status = hist[pid].get("status", {})
            if status.get("completed"):
                outs = hist[pid].get("outputs", {})
                print(f"\ndone      {el:.0f}s  ({el / 60:.1f} min)")
                print(f"vram      peak {max(vram_used):.1f} GB / "
                      f"{d['vram_total'] / 2**30:.1f} GB  "
                      f"(median {statistics.median(vram_used):.1f} GB)")
                for node, out in outs.items():
                    for vids in out.values():
                        if isinstance(vids, list):
                            for v in vids:
                                if isinstance(v, dict) and v.get("filename"):
                                    print(f"output    {v.get('subfolder', '')}/{v['filename']}")
                seconds_out = length / FPS
                print(f"\ncost      {el / seconds_out:.0f}s of compute per second of film")
                print(f"          a 7-scene / 86s film ≈ "
                      f"{el / seconds_out * 86 / 60:.0f} min of sampling")
                return 0
            if status.get("status_str") == "error":
                print("\n!! job failed:")
                for m in status.get("messages", []):
                    print("  ", json.dumps(m, ensure_ascii=False)[:1200])
                return 1
        if el - last_note >= 30:
            last_note = el
            q = _get("/queue", timeout=15)
            running = len(q.get("queue_running", []))
            print(f"  {el:6.0f}s  vram {used:5.1f} GB  running={running}")


if __name__ == "__main__":
    sys.exit(main())
