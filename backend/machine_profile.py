"""Per-machine H3 defaults.

The same project runs on the RTX 5090 workstation (32 GB VRAM) and on smaller
boxes such as an RTX 5060 Ti 16 GB with 32 GB of system RAM. What differs is
only what a render gets when the node names nothing: the checkpoint preset,
the output size and how the video VAE decodes.

H3_MACHINE_PROFILE names the profile. Unset (or "auto"), it is picked from the
total VRAM that ComfyUI reports on /system_stats -- the GPU belongs to ComfyUI,
which need not be on this box -- and an unreachable ComfyUI falls back to
"workstation" with a warning. An unknown name also falls back to "workstation".

A node that sets width/height explicitly keeps them on every machine. A node
that names motionPreset keeps it too, except where the profile has no room for
that checkpoint: lowvram swaps "singularity" for "singularity_w4a8", its quantised
build, because the int8 checkpoint does not fit in 16 GB.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request

logger = logging.getLogger(__name__)

MACHINE_PROFILES: dict[str, dict] = {
    # RTX 5090 32 GB. Singularity is the default base again as of 2026-10-02.
    # Fused had been the default since 2026-09-18, when it pulled the C3 bedroom door
    # toward the camera where singularity pushed it every take; a shot that needs that
    # names motionPreset "fused" itself.
    "workstation": {
        "label": "RTX 5090 32GB",
        "motion_preset": "singularity",
        "width": 1376,
        "height": 768,
        "tiled_vae_decode": False,
        "upscale_method": "h3_latent",
        # Attention patch a render gets when the request names none (workflow_builders.H3_ACCEL_PRESETS).
        "h3_accel": "sol",
    },
    # RTX 5060 Ti 16 GB / 32 GB RAM. The Singularity int8 checkpoint (19.5 GB)
    # does not fit, so this uses the pruned ref2va w4a8 (11.8 GB) plus the ref2v
    # turbo LoRA, at 480p. Not NVFP4: ComfyUI merges a LoRA into NVFP4 weights by
    # requantising with stochastic rounding (~17% relative error per layer) and
    # the clip comes out hazy. 864x480 is the 16:9 size closest to 1376x768 on H3's 32-px grid.
    # Tiled decode keeps the VAE's activation peak inside 16 GB.
    "lowvram": {
        "label": "RTX 5060 Ti 16GB",
        # Singularity by name; preset_substitutes runs its w4a8 build here.
        "motion_preset": "singularity",
        "width": 864,
        "height": 480,
        "tiled_vae_decode": True,
        # Presets whose checkpoint does not fit here, and what runs instead.
        # "ref2va" is the official pruned ref2va with the ref2v turbo8 LoRA: the same weights
        # pruned_w4a8 quantises, so it runs there instead of being refused. "crossview" keeps its
        # own LoRA and sampler and only has its checkpoint swapped (unet_substitutes, applied to
        # presets in main._h3_motion_preset); its quality on w4a8 is not measured yet.
        "preset_substitutes": {"singularity": "singularity_w4a8", "ref2va": "pruned_w4a8"},
        # Checkpoints named directly by a builder (local repair, AV bridge)
        # rather than through a preset: the 21 GB int8 ref2va builds do not fit
        # beside the 15.7 GB text encoder in 32 GB of RAM; the w4a8 build does.
        # What this card cannot run at all: these are 21-34 GB builds with no community quantisation
        # of the same weights (searched 2026-10-04), and the text encoder (15.7 GB) must sit beside
        # them in 32 GB of RAM. Presets are refused with a clear message; node types are hidden
        # from the studio and refused by the backend. Viggle's pruned build has no smaller version.
        "disabled_presets": ["fused", "hybrid", "ref2va_full", "hyperflow"],
        "disabled_node_types": ["charswap"],
        # Video enhance: the latent refine loads the fused int8 base (21 GB), so ESRGAN is the default
        # here and the latent method is refused. lms (same-size sharpen) runs on the substituted preset.
        "upscale_method": "esrgan",
        "disabled_upscale_methods": ["h3_latent"],
        # Not "sol": at 864x480 the Sol sparse attention smeared faces on this build (w4a8 + ref2v turbo 8-step,
        # 2026-10-04, same seed: dense and kjsage clean, sol melted; confirmed on H3_Video_65b84132).
        # kjsage is the memory-efficient patch that kept the picture clean in that test.
        "h3_accel": "kjsage",
        "unet_substitutes": {
            "minimax_h3_ref2va_pruned_int8_convrot.safetensors": "minimax_h3_ref2va_pruned_w4a8_mixed.safetensors",
            "Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors": "Minimax-h3_Singularity_ref2va_v1.3_Pruned_w4a8.safetensors",
        },
    },
}

#: Below this much total VRAM, auto picks "lowvram". The Singularity int8
#: checkpoint alone is 19.5 GB.
LOWVRAM_BELOW_GIB = 24

DEFAULT_MACHINE_PROFILE = "workstation"


def _comfyui_vram_gib() -> float | None:
    """Total VRAM of ComfyUI's first device, or None if ComfyUI cannot be asked."""
    try:
        try:
            from comfyui_client import COMFYUI_BASE
        except ImportError:
            from backend.comfyui_client import COMFYUI_BASE
        with urllib.request.urlopen(f"{COMFYUI_BASE}/system_stats", timeout=5) as r:
            devices = json.load(r).get("devices") or []
        return devices[0]["vram_total"] / 2**30 if devices else None
    except Exception as e:
        logger.warning("Could not read ComfyUI VRAM for the machine profile: %s", e)
        return None


def _resolve() -> tuple[str, dict]:
    name = os.environ.get("H3_MACHINE_PROFILE", "").strip()
    if name in ("", "auto"):
        vram = _comfyui_vram_gib()
        if vram is None:
            name = DEFAULT_MACHINE_PROFILE
        else:
            name = "lowvram" if vram < LOWVRAM_BELOW_GIB else "workstation"
            logger.info("Machine profile %r from %.1f GiB VRAM", name, vram)
    if name not in MACHINE_PROFILES:
        logger.warning("Unknown H3_MACHINE_PROFILE=%r, using %r", name, DEFAULT_MACHINE_PROFILE)
        name = DEFAULT_MACHINE_PROFILE
    return name, MACHINE_PROFILES[name]


PROFILE_NAME, PROFILE = _resolve()


def public_profile() -> dict:
    """What the studio needs to pick its defaults."""
    return {"name": PROFILE_NAME, **PROFILE}


def substitute_unet(name: str) -> str:
    """The checkpoint file that actually loads here for a builder that names `name`."""
    return PROFILE.get("unet_substitutes", {}).get(name, name)


def substitute_preset(name: str) -> str:
    """The preset that actually runs here for a node that names `name`."""
    return PROFILE.get("preset_substitutes", {}).get(name, name)


#: Node type -> the backend job that runs it, for the message below.
_NODE_LABELS = {"charswap": "换人 (Viggle)"}


def require_preset(name: str) -> None:
    """Refuse a preset this machine's profile lists as unable to run, before ComfyUI is asked."""
    if name in PROFILE.get("disabled_presets", ()):
        raise ValueError(
            f"运动预设 {name!r} 在这台机器（{PROFILE['label']}）上跑不了：它的权重超过显存。"
            f"请改用 {PROFILE.get('motion_preset')!r}（会自动换成 {PROFILE.get('preset_substitutes', {}).get(PROFILE.get('motion_preset'), PROFILE.get('motion_preset'))}）。"
        )


def require_upscale_method(method: str) -> None:
    """Refuse a video-enhance method this machine cannot load the weights for."""
    if method in PROFILE.get("disabled_upscale_methods", ()):
        raise ValueError(
            f"视频增强方式 {method!r} 在这台机器（{PROFILE['label']}）上跑不了：它要加载 21GB 的底模。"
            f"请改用 {PROFILE.get('upscale_method', 'esrgan')!r}。"
        )


def require_node(node_type: str) -> None:
    """Refuse a node type this machine's profile lists as unable to run."""
    if node_type in PROFILE.get("disabled_node_types", ()):
        raise ValueError(
            f"{_NODE_LABELS.get(node_type, node_type)} 在这台机器（{PROFILE['label']}）上不可用：权重太大，16GB 显存放不下。"
        )


#: The H3 text encoder (Qwen3-VL 32B). Comfy-Org's own README says the NVFP4 build "does not require
#: Blackwell GPU to use", so it is the default everywhere. The INT4 convrot build (15.0 GB, the same size
#: class; Merserk/MiniMax-H3-INT4-ConvRot, SHA256 checked, ran once on a 5090) is an option for a card
#: where NVFP4 misbehaves. NVFP4: Comfy-Org/MiniMax-H3.
TEXT_ENCODERS = {
    "nvfp4": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "int4": "qwen3vl_32b_minimax_h3_int4_convrot.safetensors",
}


def text_encoder() -> str:
    """The text-encoder file this machine loads: H3_TEXT_ENCODER (environment or .env; a key
    "nvfp4" / "int4" or a file name) when set, else the NVFP4 build."""
    try:
        from envfile import env_value
    except ImportError:
        from backend.envfile import env_value
    chosen = env_value("H3_TEXT_ENCODER")
    return TEXT_ENCODERS.get(chosen.lower(), chosen) if chosen else TEXT_ENCODERS["nvfp4"]
