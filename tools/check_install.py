"""Check that this machine can run LAZA CINEMA STUDIO, and say exactly what is missing.

  python tools/check_install.py            # reads the repository's .env
  python tools/check_install.py --profile lowvram

Nothing is changed or downloaded. Exit code 0 means no blocking problem; warnings are things that
switch a feature off, errors are things that stop the studio or every render.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
from envfile import comfyui_dir, env_value  # noqa: E402

problems = {"error": 0, "warn": 0}


def say(level: str, text: str) -> None:
    mark = {"ok": "  ok   ", "warn": " WARN  ", "error": " ERROR ", "info": "       "}[level]
    if level in problems:
        problems[level] += 1
    print(f"{mark}{text}")


def fetch_json(url: str, timeout: int = 20):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.load(response)


def total_ram_gib() -> float | None:
    if sys.platform != "win32":
        try:
            with open("/proc/meminfo") as f:
                return int(f.readline().split()[1]) / 2**20
        except OSError:
            return None

    class Status(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong),
                    ("avail", ctypes.c_ulonglong), ("tpf", ctypes.c_ulonglong), ("apf", ctypes.c_ulonglong),
                    ("tv", ctypes.c_ulonglong), ("av", ctypes.c_ulonglong), ("ave", ctypes.c_ulonglong)]

    status = Status()
    status.length = ctypes.sizeof(Status)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
    return status.total / 2**30


# Files each profile needs, relative to ComfyUI/models. Names match docs/H3_WEIGHTS.md.
COMMON = [
    # the text encoder depends on the GPU generation: added in main()
    "vae/minimax_h3_video_vae_int8_convrot.safetensors",
    "vae/minimax_h3_audio_vae_fp32.safetensors",
    "upscale_models/RealESRGAN_x2.pth",
    # the latent upscaler named by H3_LATENT_UPSCALER is added in main()
    "loras/minimax_h3_lms_v1.0_r64.safetensors",
]
PER_PROFILE = {
    "workstation": [
        "diffusion_models/Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors",
        "loras/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
        "diffusion_models/minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors",
    ],
    "lowvram": [
        "diffusion_models/Minimax-h3_Singularity_ref2va_v1.3_Pruned_w4a8.safetensors",
        "diffusion_models/minimax_h3_ref2va_pruned_w4a8_mixed.safetensors",
        "loras/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
    ],
}
# Needed only by one feature; a missing one switches that feature off, it does not stop the studio.
OPTIONAL = {
    "换机位 (CrossView)": [
        "loras/h3/MiniMax-H3_Ref2VA-LoRA-CrossView-Warp_v1_3500.safetensors",
        "loras/h3/minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors",
        "geometry_estimation/moge_2_vitl_normal_fp16.safetensors",
    ],
    "深度控制": ["model_patches/minimax_h3_fun_controlnet_union_2.0_pruned_bf16.safetensors"],
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--profile", choices=["workstation", "lowvram"], help="override the profile guessed from VRAM")
    args = parser.parse_args()

    print("Tools")
    py = sys.version_info
    say("ok" if py >= (3, 10) else "error", f"Python {py.major}.{py.minor}" + ("" if py >= (3, 10) else " (3.10+ needed)"))
    for tool in ("node", "ffmpeg", "ffprobe"):
        path = shutil.which(tool)
        if path:
            version = subprocess.run([path, "-version" if tool != "node" else "-v"], capture_output=True, text=True).stdout.splitlines()[:1]
            say("ok", f"{tool}: {version[0] if version else path}")
        else:
            say("error", f"{tool} not found on PATH")

    print("\nConfiguration (.env)")
    say("ok" if (ROOT / ".env").is_file() else "warn", ".env present" if (ROOT / ".env").is_file() else ".env missing: copy .env.example to .env")
    comfy_url = env_value("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/")
    out_dir, in_dir = comfyui_dir("COMFYUI_OUTPUT_DIR"), comfyui_dir("COMFYUI_INPUT_DIR")
    for name, value in (("COMFYUI_OUTPUT_DIR", out_dir), ("COMFYUI_INPUT_DIR", in_dir)):
        if not value:
            say("error", f"{name} is empty: set it to your ComfyUI's {name.split('_')[1].lower()} folder")
        elif not Path(value).is_dir():
            say("error", f"{name} does not exist: {value}")
        else:
            say("ok", f"{name} = {value}")
    token = env_value("AI_CINEMA_MCP_TOKEN")
    say("ok" if token else "warn", "AI_CINEMA_MCP_TOKEN set" if token else "AI_CINEMA_MCP_TOKEN empty: the MCP on :8004 has no authentication")

    print("\nComfyUI")
    try:
        stats = fetch_json(f"{comfy_url}/system_stats")
    except Exception as exc:
        say("error", f"ComfyUI not reachable at {comfy_url}: {exc}")
        print(f"\n{problems['error']} error(s): fix these first, the rest needs a running ComfyUI.")
        return 1
    device = (stats.get("devices") or [{}])[0]
    vram = device.get("vram_total", 0) / 2**30
    say("ok", f"ComfyUI {stats.get('system', {}).get('comfyui_version', '?')} on {device.get('name', '?')} ({vram:.1f} GiB VRAM)")
    ram = total_ram_gib()
    if ram is not None:
        say("ok" if ram >= 30 else "warn", f"System RAM {ram:.0f} GiB" + ("" if ram >= 30 else " (32 GiB is the working minimum)"))
    profile = args.profile or ("lowvram" if vram < 24 else "workstation")
    say("info", f"profile: {profile}" + (" (from VRAM)" if not args.profile else ""))

    print("\nCustom nodes")
    info = fetch_json(f"{comfy_url}/object_info", timeout=120)
    used = set()
    for name in ("workflow_builders.py", "comfyui_client.py"):
        used |= set(re.findall(r'"class_type":\s*"([A-Za-z0-9_]+)"', (ROOT / "backend" / name).read_text(encoding="utf-8")))
    # Retired FLUX2 nodes and the optional GGUF loader are not part of the base install.
    optional_nodes = {"Flux2FunControlNetApply", "Flux2FunControlNetLoader", "FluxKontextImageConditioning", "UnetLoaderGGUF"}
    missing = sorted(c for c in used - optional_nodes if c not in info)
    if missing:
        say("error", f"{len(missing)} node class(es) not installed in ComfyUI: {', '.join(missing)}")
        say("info", "install the packs listed in docs/comfyui_setup.json (see docs/DEPLOY.md, step 3)")
    else:
        say("ok", f"all {len(used - optional_nodes)} node classes the studio builds are installed")
    qwen_unet = env_value("QWEN_IMAGE_UNET")
    if qwen_unet.lower().endswith(".gguf") and "UnetLoaderGGUF" not in info:
        say("error", "QWEN_IMAGE_UNET is a .gguf but the ComfyUI-GGUF custom node is not installed")

    print("\nModel files")
    models = None
    if out_dir and (Path(out_dir).parent / "models").is_dir():
        models = Path(out_dir).parent / "models"
    if models is None:
        say("warn", "cannot find ComfyUI/models next to COMFYUI_OUTPUT_DIR; skipping the file check")
    else:
        import importlib
        wb = importlib.import_module("workflow_builders")
        qwen = [
            f"{'unet' if wb.QWEN_IMAGE_21_UNET.lower().endswith('.gguf') else 'diffusion_models'}/{wb.QWEN_IMAGE_21_UNET}",
            f"text_encoders/{wb.QWEN_IMAGE_21_CLIP}",
            f"vae/{wb.QWEN_IMAGE_21_VAE}",
        ]
        import machine_profile
        encoder = machine_profile.text_encoder()
        say("info", f"text encoder for this GPU: {encoder}")
        upscaler = env_value("H3_LATENT_UPSCALER") or "minimax_h3_latent_upscaler_3d_bf16.safetensors"
        for rel in [f"text_encoders/{encoder}", f"latent_upscale_models/{upscaler}"] + COMMON + PER_PROFILE[profile]:
            say("ok" if (models / rel).is_file() else "error", rel)
        for rel in qwen:
            say("ok" if (models / rel).is_file() else "warn", f"{rel}  (图片生成)")
        for feature, files in OPTIONAL.items():
            absent = [f for f in files if not (models / f).is_file()]
            say("ok" if not absent else "warn", f"{feature}: " + ("ready" if not absent else "missing " + ", ".join(absent)))

    print()
    if problems["error"]:
        print(f"{problems['error']} error(s), {problems['warn']} warning(s). See docs/DEPLOY.md.")
        return 1
    print(f"No blocking problem. {problems['warn']} warning(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
