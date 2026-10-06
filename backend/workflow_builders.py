"""
ComfyUI workflow definitions for LAZA CINEMA STUDIO.

Every function here is a pure builder: parameters in, ComfyUI prompt-graph dict out.
Fixed-topology workflows exported from the ComfyUI editor live as JSON files in
./workflows/ and are loaded via load_workflow_template(); dynamic-topology
workflows (variable reference counts, conditional branches) are built in Python.
"""

import json
import logging
import math
import uuid
import os
from pathlib import Path
from typing import Optional

try:
    from envfile import env_value
except ImportError:  # imported as backend.workflow_builders
    from backend.envfile import env_value

logger = logging.getLogger(__name__)


def h3_text_encoder() -> str:
    """The H3 text-encoder file for this machine (machine_profile.text_encoder). Imported late:
    machine_profile reads ComfyUI's address from comfyui_client, which imports this module."""
    try:
        import machine_profile
    except ImportError:
        from backend import machine_profile
    return machine_profile.text_encoder()

WORKFLOWS_DIR = Path(__file__).parent / "workflows"

def _normalize_lora_name(lora_name: str) -> str:
    """Normalize LoRA path separator to match ComfyUI's OS-native list (Windows uses backslash)."""
    if not lora_name:
        return ""
    if os.name == "nt":
        return lora_name.replace("/", "\\")
    return lora_name.replace("\\", "/")



# Default attention patch for H3 graphs. Measured on this box (see RUNLOG.md):
# at 8 steps "sol" is 17.4% faster than "kjsage" (44.9s vs 54.3s, n=4 each).
# IT IS NOT AN EQUIVALENT SPEEDUP -- same seed + same prompt gives a DIFFERENT
# picture (PSNR 17.82 dB), so switching mid-production re-rolls locked shots.
# Set H3_ACCEL=kjsage in the environment to restore the previous output exactly.
DEFAULT_H3_ACCEL = os.environ.get("H3_ACCEL", "sol")

def _get_default_h3_steps() -> int:
    raw = os.environ.get("H3_STEPS", "8").strip()
    try:
        val = int(raw)
        if val <= 0:
            raise ValueError("steps must be positive")
    except Exception as e:
        logger.warning(f"Invalid H3_STEPS={raw!r}, falling back to default 8: {e}")
        return 8
    if val != 8:
        logger.warning(
            f"[H3] H3_STEPS override active: {val} steps (production standard is 8). "
            "Ensure this is intentional and not an accidental preview downgrade."
        )
    return val

# Default sampling steps for fused MiniMax H3 video workflows.
# 4 is preview tier (under-samples small text and fine geometry).
# 8 is final/production tier (clear legibility on text and fine details).
# Cross-reference: Frontend counterpart is defined in frontend/lib/types.ts (DEFAULT_H3_STEPS). Keep in sync.
DEFAULT_H3_STEPS: int = _get_default_h3_steps()

# H3 acceleration patches, chained onto the model before the guider/scheduler.
# Parameter values mirror the live node signatures reported by /object_info on
# the ComfyUI-sol-attn build; re-check there before changing them.
H3_ACCEL_PRESETS = {
    "kjsage": ("MiniMaxH3MemoryEfficientSageAttentionPatch", {}),
    "sol": (
        "MiniMaxH3MemoryEfficientSolAttentionPatch",
        {
            "enabled": True,
            "tau": 1.3,
            "min_tokens": 4096,
            "strict": False,
            "thresh_type": "diag",
            "int8_qk": True,
            "int8_pv": False,
            "sink_conditioning": "exact_kv",
            "dense_blocks": "",
        },
    ),
    # "sol" with the P·V product in INT8 too (int8_qk is already on). Opt-in
    # for measuring speed against quality; 2026-09-22.
    "solpv": None,
    "solchunk": (
        "MiniMaxH3ChunkFeedForward",
        {"enabled": True, "chunks": 2, "min_tokens": 8192},
    ),
}


H3_ACCEL_PRESETS["solpv"] = (H3_ACCEL_PRESETS["sol"][0], {**H3_ACCEL_PRESETS["sol"][1], "int8_pv": True})


_SOL_ATTENTION = ("sol", "solpv")


def accel_for_unet(unet_name: str, sage: str) -> str:
    """The attention patch list a checkpoint may run with.

    The Sol sparse attention deforms and smears faces on w4a8 checkpoints (2026-10-04: official and
    Singularity w4a8, 864x480, 4 of 5 Sol renders judged bad, 0 of 10 with kjsage or no patch), so a
    w4a8 unet asks for kjsage wherever Sol was named. int8 checkpoints are untouched.
    """
    if "w4a8" not in (unet_name or "").lower():
        return sage
    parts = [p.strip() for p in (sage or "").split(",")]
    if not any(p in _SOL_ATTENTION for p in parts):
        return sage
    logger.warning("Sol attention is not used on a w4a8 checkpoint (%s): using kjsage instead", unet_name)
    swapped = ["kjsage" if p in _SOL_ATTENTION else p for p in parts]
    return ",".join(dict.fromkeys(p for p in swapped if p))


def _apply_h3_accel(wf: dict, model_src, sage: str, start_id: int = 20):
    """Chain acceleration patches onto model_src, in the order given.

    `sage` is a comma-separated preset list. Unknown or empty entries are
    skipped, so the old "disabled" value still means no patches.

    "kjsage" and "sol" are BOTH attention patches: each one replaces every
    transformer block's attention forward, so chaining them does not compose —
    whichever comes last simply overrides the other. Pick one, e.g. "kjsage"
    (default) or "sol". "solchunk" patches the feed-forward instead and does
    stack, so "sol,solchunk" is valid.
    Returns (new_model_src, next_free_node_id).
    """
    node_id = start_id
    for name in (part.strip() for part in (sage or "").split(",")):
        preset = H3_ACCEL_PRESETS.get(name)
        if preset is None:
            continue
        class_type, params = preset
        wf[str(node_id)] = {
            "class_type": class_type,
            "inputs": {"model": model_src, **params},
        }
        model_src = [str(node_id), 0]
        node_id += 1
    return model_src, node_id


def load_workflow_template(name: str) -> dict:
    """Load a workflow JSON template from the workflows directory."""
    path = WORKFLOWS_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"Workflow template not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ── FLUX.1 Kontext (character consistency) ────────────────────────────────────

def build_kontext_workflow(
    prompt: str,
    reference_filenames: list[str],
    model: str,
    width: int,
    height: int,
    steps: int,
    guidance: float,
    seed: int,
) -> dict:
    """
    Build a FLUX.1 Kontext ComfyUI workflow.

    For character consistency:
    - First reference = character reference (always included)
    - If multiple refs: they're stacked into a batch and the model sees all

    This workflow uses native ComfyUI FLUX Kontext nodes.
    Requires: flux1-kontext-dev.safetensors, t5xxl_fp8_e4m3fn.safetensors or t5xxl_fp16.safetensors,
              clip_l.safetensors, ae.safetensors in respective ComfyUI model folders.
    """
    ref = reference_filenames[0] if reference_filenames else None

    workflow = {
        # 1. Load UNET (FLUX Kontext model)
        "1": {
            "class_type": "UNETLoader",
            "inputs": {
                "unet_name": model,
                "weight_dtype": "fp8_e4m3fn",
            },
        },
        # 2. Load dual CLIP (T5 + CLIP-L for FLUX)
        "2": {
            "class_type": "DualCLIPLoader",
            "inputs": {
                "clip_name1": "t5xxl_fp8_e4m3fn.safetensors",
                "clip_name2": "clip_l.safetensors",
                "type": "flux",
            },
        },
        # 3. Load VAE
        "3": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": "ae.safetensors"},
        },
        # 4. Encode text prompt
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "clip": ["2", 0],
                "text": prompt,
            },
        },
        # 5. Apply FLUX guidance
        "5": {
            "class_type": "FluxGuidance",
            "inputs": {
                "conditioning": ["4", 0],
                "guidance": guidance,
            },
        },
    }

    if ref:
        # 6. Load reference image
        workflow["6"] = {
            "class_type": "LoadImage",
            "inputs": {"image": ref, "upload": "image"},
        }
        # 7. Kontext image conditioning — combines reference image with text
        workflow["7"] = {
            "class_type": "FluxKontextImageConditioning",
            "inputs": {
                "conditioning": ["5", 0],
                "vae": ["3", 0],
                "image": ["6", 0],
            },
        }
        positive_ref = ["7", 0]
    else:
        positive_ref = ["5", 0]

    # 8. Empty latent for output size
    workflow["8"] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": width, "height": height, "batch_size": 1},
    }

    # If we have a reference, use it as the starting latent (for Kontext editing mode)
    if ref:
        workflow["9"] = {
            "class_type": "VAEEncode",
            "inputs": {
                "pixels": ["6", 0],
                "vae": ["3", 0],
            },
        }
        latent_ref = ["9", 0]
    else:
        latent_ref = ["8", 0]

    # 10. KSampler
    workflow["10"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["1", 0],
            "positive": positive_ref,
            "negative": ["4", 0],  # empty negative for FLUX
            "latent_image": latent_ref,
            "seed": seed,
            "steps": steps,
            "cfg": 1.0,
            "sampler_name": "euler",
            "scheduler": "simple",
            "denoise": 1.0,
        },
    }

    # 11. VAE Decode
    workflow["11"] = {
        "class_type": "VAEDecode",
        "inputs": {"samples": ["10", 0], "vae": ["3", 0]},
    }

    # 12. Save Image
    workflow["12"] = {
        "class_type": "SaveImage",
        "inputs": {
            "images": ["11", 0],
            "filename_prefix": "cinema",
        },
    }

    return workflow


# ── FLUX.2-dev text-to-image ───────────────────────────────────────────────────

def build_flux2_workflow(
    prompt: str,
    width: int,
    height: int,
    steps: int,
    guidance: float,
    seed: int,
) -> dict:
    """
    Build a FLUX.2-dev ComfyUI workflow for pure text-to-image generation.
    Uses: flux2_dev_fp8mixed.safetensors, mistral_3_small_flux2_bf16.safetensors,
          full_encoder_small_decoder.safetensors
    Nodes: BasicGuider + SamplerCustomAdvanced + Flux2Scheduler + EmptyFlux2LatentImage
    """
    return {
        # UNET
        "f2:1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": "flux2_dev_fp8mixed.safetensors", "weight_dtype": "default"},
        },
        # CLIP (Mistral-based for FLUX.2)
        "f2:2": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": "mistral_3_small_flux2_bf16.safetensors",
                "type": "flux2",
                "device": "default",
            },
        },
        # VAE
        "f2:3": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": "flux2-vae.safetensors"},
        },
        # Encode text
        "f2:4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt, "clip": ["f2:2", 0]},
        },
        # FLUX guidance
        "f2:5": {
            "class_type": "FluxGuidance",
            "inputs": {"guidance": guidance, "conditioning": ["f2:4", 0]},
        },
        # Guider
        "f2:6": {
            "class_type": "BasicGuider",
            "inputs": {"model": ["f2:1", 0], "conditioning": ["f2:5", 0]},
        },
        # Noise
        "f2:7": {
            "class_type": "RandomNoise",
            "inputs": {"noise_seed": seed},
        },
        # Sampler select
        "f2:8": {
            "class_type": "KSamplerSelect",
            "inputs": {"sampler_name": "euler"},
        },
        # FLUX2 scheduler (produces sigmas)
        "f2:9": {
            "class_type": "Flux2Scheduler",
            "inputs": {"steps": steps, "width": width, "height": height},
        },
        # Empty FLUX2 latent
        "f2:10": {
            "class_type": "EmptyFlux2LatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1},
        },
        # Advanced sampler
        "f2:11": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["f2:7", 0],
                "guider": ["f2:6", 0],
                "sampler": ["f2:8", 0],
                "sigmas": ["f2:9", 0],
                "latent_image": ["f2:10", 0],
            },
        },
        # VAE decode
        "f2:12": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["f2:11", 0], "vae": ["f2:3", 0]},
        },
        # Save
        "f2:13": {
            "class_type": "SaveImage",
            "inputs": {"images": ["f2:12", 0], "filename_prefix": "cinema_flux2"},
        },
    }


# ── FLUX.2-dev image-to-image with references / pose / depth ──────────────────

def build_flux2_i2i_workflow(
    prompt: str,
    reference_filenames: list[str],
    pose_reference_filenames: list[str],
    depth_reference_filenames: list[str],
    width: int,
    height: int,
    steps: int,
    guidance: float,
    seed: int,
    depth_strength: float = 0.8,
) -> dict:
    wf = {
        "f2:1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": "flux2_dev_fp8mixed.safetensors", "weight_dtype": "default"},
        },
        "f2:2": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": "mistral_3_small_flux2_bf16.safetensors",
                "type": "flux2",
                "device": "default",
            },
        },
        "f2:3": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": "flux2-vae.safetensors"},
        },
        "f2:4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt, "clip": ["f2:2", 0]},
        },
        "f2:5": {
            "class_type": "FluxGuidance",
            "inputs": {"guidance": guidance, "conditioning": ["f2:4", 0]},
        },
    }

    prev_cond = ["f2:5", 0]

    for i, ref in enumerate(reference_filenames or []):
        base = 100 + i * 10
        wf[f"ref:{base}"] = {
            "class_type": "LoadImage",
            "inputs": {"image": ref, "upload": "image"},
        }
        wf[f"ref:{base+1}"] = {
            "class_type": "ImageScaleToTotalPixels",
            "inputs": {"upscale_method": "lanczos", "megapixels": 1, "resolution_steps": 1, "image": [f"ref:{base}", 0]},
        }
        wf[f"ref:{base+2}"] = {
            "class_type": "VAEEncode",
            "inputs": {"pixels": [f"ref:{base+1}", 0], "vae": ["f2:3", 0]},
        }
        wf[f"ref:{base+3}"] = {
            "class_type": "ReferenceLatent",
            "inputs": {"conditioning": prev_cond, "latent": [f"ref:{base+2}", 0]},
        }
        prev_cond = [f"ref:{base+3}", 0]

    pose_reference_filenames = pose_reference_filenames or []
    depth_reference_filenames = depth_reference_filenames or []

    # Size follows the first control image, so the frame lines up with the control
    # geometry pixel for pixel — generating 1024x1024 against a 16:9 depth pass
    # stretches the perspective it was supposed to lock.
    if pose_reference_filenames:
        wf["pose_size"] = {
            "class_type": "GetImageSize",
            "inputs": {"image": ["pose:200", 0]}
        }
        gen_width = ["pose_size", 0]
        gen_height = ["pose_size", 1]
    elif depth_reference_filenames:
        wf["depth_size"] = {
            "class_type": "GetImageSize",
            "inputs": {"image": ["depth:150", 0]}
        }
        gen_width = ["depth_size", 0]
        gen_height = ["depth_size", 1]
    else:
        gen_width = width
        gen_height = height

    # Depth goes through ControlNet, not ReferenceLatent. A VAE-encoded reference
    # latent only nudges content: it cannot hold perspective or occlusion, which is
    # the entire reason for supplying depth. Routed this way a depth pass behaves
    # like any other reference image — same failure as describing the geometry in
    # words. ControlNet is what actually constrains it.
    for i, depth_ref in enumerate(depth_reference_filenames):
        base = 150 + i * 10
        wf[f"depth:{base}"] = {
            "class_type": "LoadImage",
            "inputs": {"image": depth_ref, "upload": "image"},
        }
        wf[f"depth:{base+1}"] = {
            "class_type": "ImageResize+",
            "inputs": {
                "image": [f"depth:{base}", 0],
                "width": gen_width,
                "height": gen_height,
                "interpolation": "lanczos",
                "method": "fill / crop",
                "condition": "always",
                "multiple_of": 0,
            },
        }
        wf[f"depth:{base+2}"] = {
            "class_type": "Flux2FunControlNetLoader",
            "inputs": {"controlnet_name": "FLUX.2-dev-Fun-Controlnet-Union.safetensors"},
        }
        wf[f"depth:{base+3}"] = {
            "class_type": "Flux2FunControlNetApply",
            "inputs": {
                "conditioning": prev_cond,
                "controlnet": [f"depth:{base+2}", 0],
                "vae": ["f2:3", 0],
                "control_image": [f"depth:{base+1}", 0],
                "strength": depth_strength,
            },
        }
        prev_cond = [f"depth:{base+3}", 0]

    for i, pose_ref in enumerate(pose_reference_filenames):
        # ControlNet branch for pose
        base = 200 + i * 10
        # Load pose image
        wf[f"pose:{base}"] = {
            "class_type": "LoadImage",
            "inputs": {"image": pose_ref, "upload": "image"},
        }
        # Resize pose image to match generation size
        wf[f"pose:{base+1}"] = {
            "class_type": "ImageResize+",
            "inputs": {
                "image": [f"pose:{base}", 0],
                "width": gen_width,
                "height": gen_height,
                "interpolation": "lanczos",
                "method": "fill / crop",
                "condition": "always",
                "multiple_of": 0
            }
        }
        # Load ControlNet
        wf[f"pose:{base+2}"] = {
            "class_type": "Flux2FunControlNetLoader",
            "inputs": {"controlnet_name": "FLUX.2-dev-Fun-Controlnet-Union.safetensors"}
        }
        # Apply ControlNet
        wf[f"pose:{base+3}"] = {
            "class_type": "Flux2FunControlNetApply",
            "inputs": {
                "conditioning": prev_cond,
                "controlnet": [f"pose:{base+2}", 0],
                "vae": ["f2:3", 0],
                "control_image": [f"pose:{base+1}", 0],
                "strength": 0.75
            }
        }
        prev_cond = [f"pose:{base+3}", 0]

    final_image = ["f2:12", 0]
    if reference_filenames:
        wf["f2:color_match"] = {
            "class_type": "easy imageColorMatch",
            "inputs": {
                "method": "adain",
                "image_output": "Preview",
                "save_prefix": "ComfyUI",
                "image_ref": ["ref:100", 0],
                "image_target": ["f2:12", 0]
            }
        }
        final_image = ["f2:color_match", 0]

    wf.update({
        "f2:6": {
            "class_type": "BasicGuider",
            "inputs": {"model": ["f2:1", 0], "conditioning": prev_cond},
        },
        "f2:7": {
            "class_type": "RandomNoise",
            "inputs": {"noise_seed": seed},
        },
        "f2:8": {
            "class_type": "KSamplerSelect",
            "inputs": {"sampler_name": "euler"},
        },
        "f2:9": {
            "class_type": "Flux2Scheduler",
            "inputs": {"steps": steps, "width": gen_width, "height": gen_height},
        },
        "f2:10": {
            "class_type": "EmptyFlux2LatentImage",
            "inputs": {"width": gen_width, "height": gen_height, "batch_size": 1},
        },
        "f2:11": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["f2:7", 0],
                "guider": ["f2:6", 0],
                "sampler": ["f2:8", 0],
                "sigmas": ["f2:9", 0],
                "latent_image": ["f2:10", 0],
            },
        },
        "f2:12": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["f2:11", 0], "vae": ["f2:3", 0]},
        },
        "f2:13": {
            "class_type": "SaveImage",
            "inputs": {"images": final_image, "filename_prefix": "cinema_flux2_i2i"},
        },
    })
    return wf


# ── FLUX.2-dev inpainting ──────────────────────────────────────────────────────

def build_flux2_inpaint_workflow(
    prompt: str,
    image_filename: str,
    mask_filename: str,
    width: int,
    height: int,
    steps: int,
    guidance: float,
    seed: int,
    reference_filename: Optional[str] = None,
) -> dict:
    """
    Build a FLUX.2-dev ComfyUI workflow for inpainting.
    Loads base image and mask image, encodes using VAEEncodeForInpaint,
    and runs custom advanced FLUX.2 sampling.
    """
    wf = {
        "in:1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": "flux2_dev_fp8mixed.safetensors", "weight_dtype": "default"},
        },
        "in:2": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": "mistral_3_small_flux2_bf16.safetensors",
                "type": "flux2",
                "device": "default",
            },
        },
        "in:3": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": "flux2-vae.safetensors"},
        },
        "in:4": {
            "class_type": "LoadImage",
            "inputs": {"image": image_filename, "upload": "image"},
        },
        "in:5": {
            "class_type": "LoadImage",
            "inputs": {"image": mask_filename, "upload": "image"},
        },
        "in:6": {
            "class_type": "ImageToMask",
            "inputs": {
                "image": ["in:5", 0],
                "channel": "red",
            },
        },
        "in:7": {
            "class_type": "VAEEncodeForInpaint",
            "inputs": {
                "pixels": ["in:4", 0],
                "vae": ["in:3", 0],
                "mask": ["in:6", 0],
                "grow_mask_by": 6,
            },
        },
        "in:8": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt, "clip": ["in:2", 0]},
        },
        "in:9": {
            "class_type": "FluxGuidance",
            "inputs": {"guidance": guidance, "conditioning": ["in:8", 0]},
        },
        "in:10": {
            "class_type": "BasicGuider",
            "inputs": {"model": ["in:1", 0], "conditioning": ["in:9", 0]},
        },
        "in:11": {
            "class_type": "RandomNoise",
            "inputs": {"noise_seed": seed},
        },
        "in:12": {
            "class_type": "KSamplerSelect",
            "inputs": {"sampler_name": "euler"},
        },
        "in:13": {
            "class_type": "Flux2Scheduler",
            "inputs": {"steps": steps, "width": width, "height": height},
        },
        "in:14": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["in:11", 0],
                "guider": ["in:10", 0],
                "sampler": ["in:12", 0],
                "sigmas": ["in:13", 0],
                "latent_image": ["in:7", 0],
            },
        },
        "in:15": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["in:14", 0], "vae": ["in:3", 0]},
        },
        "in:16": {
            "class_type": "SaveImage",
            "inputs": {"images": ["in:15", 0], "filename_prefix": "cinema_flux2_inpaint"},
        },
    }
    if reference_filename:
        wf["in:ref:1"] = {
            "class_type": "LoadImage",
            "inputs": {"image": reference_filename, "upload": "image"},
        }
        wf["in:ref:2"] = {
            "class_type": "ImageScaleToTotalPixels",
            "inputs": {"upscale_method": "lanczos", "megapixels": 1,
                       "resolution_steps": 1, "image": ["in:ref:1", 0]},
        }
        wf["in:ref:3"] = {
            "class_type": "VAEEncode",
            "inputs": {"pixels": ["in:ref:2", 0], "vae": ["in:3", 0]},
        }
        wf["in:ref:4"] = {
            "class_type": "ReferenceLatent",
            "inputs": {"conditioning": ["in:9", 0], "latent": ["in:ref:3", 0]},
        }
        wf["in:10"]["inputs"]["conditioning"] = ["in:ref:4", 0]
    return wf


# LoRAs whose author requires a specific sampler/scheduler, as
# {file-name stem fragment: (sampler, scheduler)}. Matched by stem so every
# version and folder prefix is covered; enforced here rather than per client,
# so the studio, the canvas MCP and scripts all get it. (AfterMidnight needed
# euler + beta; it was removed on 2026-09-17.)
LORA_SAMPLING_LOCKS: dict[str, tuple[str, str]] = {}


def _lora_sampling_lock(*names) -> Optional[tuple]:
    """(sampler, scheduler) forced by any of the given LoRA names, else None."""
    for item in names:
        name = item.get("name") if isinstance(item, dict) else item
        base = os.path.basename(str(name or "")).lower()
        for key, lock in LORA_SAMPLING_LOCKS.items():
            if key in base:
                return lock
    return None

# ── MiniMax H3 Native Video + Audio (T2VA, I2VA, FL2VA, L2VA, Ref2VA) ─────────

def _h3_video_decode(samples: list, tiled: bool, vae: list | None = None) -> dict:
    """The video decode node; node "4" is the video VAE in every H3 builder.

    Tiled uses ComfyUI's stock VAEDecodeTiled defaults (512 px tiles, 64 overlap,
    64 frames per temporal window, 8 overlap). Not yet measured against the
    plain decode for seams.
    """
    vae = vae or ["4", 0]
    if not tiled:
        return {"class_type": "VAEDecode", "inputs": {"samples": samples, "vae": vae}}
    return {"class_type": "VAEDecodeTiled", "inputs": {
        "samples": samples, "vae": vae,
        "tile_size": 512, "overlap": 64, "temporal_size": 64, "temporal_overlap": 8,
    }}


# Official INT8 convrot build (7.26 GB, half of qwen_image_2.1_bf16's 14.2 GB). Switched 2026-10-02
# to free memory next to H3; the bf16 file stays in models/diffusion_models for A/B.
#
# A smaller machine swaps these two through the environment instead of editing code (see
# docs/DEPLOY.md): QWEN_IMAGE_UNET may name a community GGUF under models/unet/ (needs the
# ComfyUI-GGUF custom node; loaded with UnetLoaderGGUF), QWEN_IMAGE_CLIP a lighter Qwen3-VL 8B
# encoder such as qwen3vl_8b_w4a8. Unset, the files below load as before.
QWEN_IMAGE_21_UNET = env_value("QWEN_IMAGE_UNET") or "qwen_image_2.1_int8_convrot.safetensors"
QWEN_IMAGE_21_CLIP = env_value("QWEN_IMAGE_CLIP") or "qwen3vl_8b_int8_convrot.safetensors"
QWEN_IMAGE_21_VAE = "qwen_image_2.1_vae_bf16.safetensors"

#: Base models the 生成图片 node can pick. Each is a full Qwen-Image-2.1
#: transformer in models/diffusion_models that runs on the same text encoder,
#: VAE and graph -- only the UNETLoader file changes. Noct Q Anime is a merged
#: checkpoint (not a LoRA; Qwen Research License, non-commercial): its own
#: workflow is this graph with cfg 3 and a negative prompt, prompts starting
#: "An anime illustration of..." (without "anime" it renders a photo).
QWEN_IMAGE_21_BASE_MODELS = {
    "qwen21": QWEN_IMAGE_21_UNET,
    "noctAnime": "NoctQA_V1_int8_convrot.safetensors",
}


def qwen_image_21_unet(base_model: str) -> str:
    """UNet file for a base-model key; an unknown key is an error, not a fallback."""
    try:
        return QWEN_IMAGE_21_BASE_MODELS[base_model or "qwen21"]
    except KeyError:
        raise ValueError(f"Unknown Qwen-Image-2.1 base model {base_model!r}; "
                         f"known: {', '.join(QWEN_IMAGE_21_BASE_MODELS)}") from None

def _qwen_image_21_unet_loader(unet_name: str) -> dict:
    """UNETLoader for a safetensors file, UnetLoaderGGUF (ComfyUI-GGUF) for a .gguf one."""
    if unet_name.lower().endswith(".gguf"):
        return {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": unet_name}}
    return {"class_type": "UNETLoader", "inputs": {"unet_name": unet_name, "weight_dtype": "default"}}


#: Reference images are resized to about this many pixels on the long side,
#: at multiples of 32, before the text encoder sees them. 0 keeps each one at
#: its own size. Measured 2026-09-20: on a 1376x768 reference, 1024 and 0 give
#: bit-identical output, because that size is already on the 32 grid.
QWEN_IMAGE_21_REF_RESOLUTION = 1024

#: Viggle turbo: a few-step distilled LoRA for Qwen-Image-2.1 (Qwen Research License,
#: non-commercial). Measured 2026-10-04/05 on the 5090: 2-4x faster than the 25-step
#: base, same picture quality on plates, edits and sheets; 7 steps rather than the
#: card's 6 because 6 garbled headline text twice in 12 tries and 7 did not.
#: Needs the `ViggleTurboLora` / `ViggleTurboSigmas` custom nodes (tools/comfyui_setup/README.md);
#: the stock LoRA loaders merge it into the weights, which drops part of the update.
QWEN_TURBO_LORA = "Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r256.safetensors"
#: Raw (unshifted) nodes of the 7-step schedule; ViggleTurboSigmas applies the resolution shift.
QWEN_TURBO_NODES = "1.0, 0.9583, 0.9167, 0.875, 0.75, 0.5, 0.25"
QWEN_TURBO_STEPS = 7


def sampler_seeds_in_png(data: bytes) -> set[int]:
    """Seeds of every sampler in the ComfyUI graph embedded in a PNG, else empty."""
    import io
    from PIL import Image
    try:
        graph = json.loads(Image.open(io.BytesIO(data)).info.get("prompt") or "{}")
    except Exception:
        return set()
    seeds = set()
    for node in graph.values() if isinstance(graph, dict) else []:
        inputs = node.get("inputs", {}) if isinstance(node, dict) else {}
        for key in ("seed", "noise_seed"):
            if isinstance(inputs.get(key), int):
                seeds.add(inputs[key])
    return seeds


def seed_clear_of_references(seed: int, reference_pngs: list[bytes]) -> int:
    """A seed no reference image was itself generated with.

    Editing a Qwen output with the seed that made it starts from the same noise:
    the model converges back onto the reference, ignores the instruction and
    sharpens it once more (2026-09-22: four prompts, no change; a new seed, done
    first time). Every Qwen node defaults to the same seed, so Qwen -> Qwen
    chains hit this by default. The seed moves on by one until it is clear.
    """
    taken = set()
    for data in reference_pngs:
        taken |= sampler_seeds_in_png(data)
    while seed in taken:
        seed += 1
    return seed


def build_qwen_image_21_workflow(
    prompt: str,
    reference_filenames: list[str] = None,
    negative_prompt: str = "",
    width: int = 1376,
    height: int = 768,
    steps: int = 25,
    cfg: float = 1.0,
    seed: int = -1,
    ref_resolution: int = QWEN_IMAGE_21_REF_RESOLUTION,
    fixed_size: bool = False,
    lora_name: str = "",
    lora_strength: float = 1.0,
    base_model: str = "qwen21",
    turbo: bool = False,
) -> dict:
    """Qwen-Image-2.1: text-to-image, or edit against up to 10 reference images.

    One graph serves both, because `TextEncodeQwenImage21` is the text encoder in
    both cases and the references are what change:

    - No references: an `EmptyLatentImage` at width x height, no prefix cache.
    - With references: the latent comes from the encoder instead (slot 2), which
      sizes the canvas to reference 1's aspect ratio at about ref_resolution
      pixels -- so **width and height are ignored** in that branch, exactly as
      the official template's custom_size=False does. `QwenImage21Cache` sits
      between the UNet and the sampler to keep the prefix across steps.

    Reference order is the model's `<image N>` numbering, so the caller's list
    order is load-bearing -- it is the canvas edge order, the same rule the H3
    builders follow for `<Picture N>`.

    Graph taken class-for-class from ComfyUI's own template
    image_qwen_image_2_1_t2i.json / image_qwen_image_2_1_image_edit.json
    (0.36.0, core commit 6bfaacc6), with its subgraph expanded.

    fixed_size=True keeps width x height even with references (an empty latent
    instead of the encoder's), for outputs whose layout is not reference 1's --
    a three-panel character sheet built from a square head crop.

    denoise stays at 1.0 and is not exposed: the encoder's latent is not a plain
    VAE encode of reference 1 (the references are spliced in as a sequence), so
    a lower denoise is not img2img here -- measured 2026-09-20, it decodes to
    noise texture, not to a lightly-edited picture.

    turbo=True swaps the sampler for the distilled LoRA path: unmerged
    `ViggleTurboLora`, `BasicGuider`, `ViggleTurboSigmas` and QWEN_TURBO_STEPS
    steps; `steps`, `cfg` and `negative_prompt` do not apply (the card says no CFG and
    no negative). It cannot be stacked with `lora_name` (AnyAngle was never tested
    with it) and needs the plain Qwen 2.1 base.
    """
    refs = list(reference_filenames or [])
    if len(refs) > 10:
        raise ValueError(f"Qwen-Image-2.1 takes at most 10 reference images, got {len(refs)}")
    if turbo and lora_name:
        raise ValueError("turbo cannot be combined with another LoRA (lora_name)")
    if turbo and (base_model or "qwen21") != "qwen21":
        raise ValueError(f"turbo is made for the qwen21 base model, not {base_model!r}")

    encoder_inputs = {
        "clip": ["qi:2", 0],
        "vae": ["qi:3", 0],
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "resolution": ref_resolution,
    }
    workflow = {
        "qi:1": _qwen_image_21_unet_loader(qwen_image_21_unet(base_model)),
        "qi:2": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": QWEN_IMAGE_21_CLIP,
                            "type": "qwen_image", "device": "default"}},
        "qi:3": {"class_type": "VAELoader", "inputs": {"vae_name": QWEN_IMAGE_21_VAE}},
        "qi:4": {"class_type": "TextEncodeQwenImage21", "inputs": encoder_inputs},
        "qi:6": {"class_type": "KSampler",
                 "inputs": {"model": ["qi:1", 0], "positive": ["qi:4", 0],
                            "negative": ["qi:4", 1], "latent_image": ["qi:5", 0],
                            "seed": seed, "steps": steps, "cfg": cfg,
                            "sampler_name": "euler", "scheduler": "simple",
                            "denoise": 1.0}},
        "qi:7": {"class_type": "VAEDecode",
                 "inputs": {"samples": ["qi:6", 0], "vae": ["qi:3", 0]}},
        "qi:8": {"class_type": "SaveImage",
                 "inputs": {"images": ["qi:7", 0], "filename_prefix": "cinema_qwen21"}},
    }

    for i, name in enumerate(refs, start=1):
        load_id = f"qi:ref{i}"
        workflow[load_id] = {"class_type": "LoadImage",
                             "inputs": {"image": name, "upload": "image"}}
        # Flat dotted keys are how ComfyUI addresses an autogrow input in the API
        # format (finalize_prefix() in comfy_api/latest/_io.py).
        encoder_inputs[f"images.image_{i}"] = [load_id, 0]

    # An optional LoRA sits between the UNet and everything that samples from it
    # (QI2.1_AnyAngle: <image 1> the original, <image 2> the coarse new view).
    unet = ["qi:1", 0]
    if lora_name:
        workflow["qi:lora"] = {"class_type": "LoraLoaderModelOnly",
                               "inputs": {"model": ["qi:1", 0], "lora_name": lora_name,
                                          "strength_model": lora_strength}}
        unet = ["qi:lora", 0]
        workflow["qi:6"]["inputs"]["model"] = unet

    if refs:
        workflow["qi:cache"] = {"class_type": "QwenImage21Cache",
                                "inputs": {"model": unet,
                                           "device": "auto", "dtype": "default"}}
        workflow["qi:6"]["inputs"]["model"] = ["qi:cache", 0]
    if refs and not fixed_size:
        workflow["qi:6"]["inputs"]["latent_image"] = ["qi:4", 2]
    else:
        workflow["qi:5"] = {"class_type": "EmptyLatentImage",
                            "inputs": {"width": width, "height": height, "batch_size": 1}}

    if turbo:
        latent = workflow["qi:6"]["inputs"]["latent_image"]
        unet = workflow["qi:6"]["inputs"]["model"]  # the cache node when there are references
        workflow["qi:lora"] = {"class_type": "ViggleTurboLora",
                               "inputs": {"model": ["qi:1", 0], "lora_name": QWEN_TURBO_LORA,
                                          "strength": 1.0}}
        if refs:
            workflow["qi:cache"]["inputs"]["model"] = ["qi:lora", 0]
        else:
            unet = ["qi:lora", 0]
        workflow["qi:guider"] = {"class_type": "BasicGuider",
                                 "inputs": {"model": unet, "conditioning": ["qi:4", 0]}}
        workflow["qi:noise"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}}
        workflow["qi:sampler"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}}
        workflow["qi:sigmas"] = {"class_type": "ViggleTurboSigmas",
                                 "inputs": {"latent": latent, "nodes": QWEN_TURBO_NODES}}
        workflow["qi:6"] = {"class_type": "SamplerCustomAdvanced",
                            "inputs": {"noise": ["qi:noise", 0], "guider": ["qi:guider", 0],
                                       "sampler": ["qi:sampler", 0], "sigmas": ["qi:sigmas", 0],
                                       "latent_image": latent}}

    return workflow


UNTRIMMED_PREFIX = "H3_Full_"


def _seam_match(wf: dict, nid: str, samples: list, context: dict, context_length: int,
                mode: str, gain: float, texture: float = 1.0, post_gain: float = 1.0,
                adaptive: bool = True) -> list:
    """AicinemaSeamMatch on a continuation's sampler output; returns what to decode and save.

    `context` is {"context_latent": ref} or {"context_frames": ref}; the video VAE ("4") is
    wired either way, to encode a frame context and to decode the frames the gain is measured on.
    """
    if not mode:
        return samples
    if mode not in ("auto", "mean", "field"):
        raise ValueError(f"seam_match {mode!r}: use 'auto', 'mean' or 'field'")
    wf[nid] = {"class_type": "AicinemaSeamMatch",
               "inputs": {"samples": samples, "context_length": int(context_length), "mode": mode,
                          "gain": float(gain), "sigma": 3.0, "max_mismatch": 0.15,
                          "texture": float(texture), "post_gain": float(post_gain),
                          "adaptive": bool(adaptive), "vae": ["4", 0], **context}}
    return [nid, 0]


def _add_untrimmed_save(wf: dict, tag: str) -> None:
    """Also save the continuation before MotionContextTrim cuts the overlap off.

    The context frames are regenerated in every continuation render and then
    thrown away; saving the whole decode (overlap included) as H3_Full_<tag>
    lets the canvas show and edit the seam instead of only the trimmed clip.
    Output pickers skip this prefix, so the trimmed H3_Chunk stays the result.
    """
    wf["63"] = {"class_type": "CreateVideo",
                "inputs": {"images": ["50", 0], "fps": 24.0, "audio": ["51", 0]}}
    wf["64"] = {"class_type": "SaveVideo",
                "inputs": {"video": ["63", 0], "filename_prefix": f"{UNTRIMMED_PREFIX}{tag}",
                           "format": "mp4", "codec": "h264"}}


def build_h3_video_workflow(
    prompt: str,
    first_frame_filename: Optional[str] = None,
    last_frame_filename: Optional[str] = None,
    # Pixel frame the last_frame image is pinned at; -1 = the clip's last frame.
    last_frame_index: int = -1,
    # [(filename, pixel_frame_index), ...]: extra images pinned mid-clip, one
    # chained MiniMaxH3AddGuide each (negative index = counted from the end).
    guide_frames: Optional[list] = None,
    image_reference_filenames: list[str] = None,
    audio_reference_filenames: list[str] = None,
    video_reference_filenames: list[str] = None,
    video_reference_sizes: list[Optional[tuple[int, int]]] = None,
    silent_video_references: list[str] = None,
    ref_image_size: str = "match",
    width: int = 1376,
    height: int = 768,
    length: int = 124,
    steps: int = DEFAULT_H3_STEPS,
    seed: int = 12345,
    scheduler: str = "simple",
    # Empty by default: the turbo LoRA is merged into the fused checkpoint below,
    # so nothing is patched at load time. Naming one here stacks it on top of the
    # merged copy -- only do that for a base (non-fused) unet_name.
    lora_name: str = "",
    lora_strength: float = 1.0,
    # No style LoRA by default. Until 2026-09-09 this defaulted to
    # AfterMidnight (since removed) and every render carried it unasked;
    # the node now chooses, and can stack several (style_loras).
    style_lora_name: str = "",
    style_lora_strength: float = 1.0,
    style_loras: list | None = None,
    sage: str = DEFAULT_H3_ACCEL,
    shift_video: float = 12.0,
    shift_audio: float = 3.0,
    # Continue this chunk from a previous one: the filename of the latent that
    # chunk saved (H3_Latent_<tag>), plus how much of its tail to pin.
    motion_context_latent: str = "",
    # ...or continue from a video file instead: MiniMaxH3MotionContext takes
    # decoded frames and audio as an alternative to a saved latent, which is
    # the only way to carry on from a clip nothing saved a latent for -- a
    # trimmed chunk, an edit, an upload.  A path, absolute or in ComfyUI input.
    motion_context_video: str = "",
    # With motion_context_video: continue from the source's first N frames, i.e. from
    # the point N/24 s into it, instead of from its last frame. 0 = the whole file.
    motion_context_end_frame: int = 0,
    motion_context_length: int = 22,
    motion_context_audio: int = 24,
    # Take the colour bias a motion-context seam adds back out of the new clip
    # (AicinemaSeamMatch, comfyui_nodes/aicinema_chain): "" off, "mean" one offset
    # per latent channel, "field" that offset as a smooth picture, "auto" the field
    # while the picture keeps the overlap's layout and the mean after a cut. Measured
    # on the overlap the clip regenerates, applied before decode, save and the next link.
    seam_match: str = "",
    seam_match_gain: float = 1.0,
    # ...and divide back out the texture each seam adds (1 = all of it, 0 = colour only),
    # and scale the correction up to post_gain after the overlap, for the drift that follows it.
    seam_match_texture: float = 1.0,
    seam_match_post_gain: float = 1.0,
    # Measure each seam's gain on a few decoded frames (gain is then the fallback).
    seam_match_adaptive: bool = True,
    # With motion_context_video: carry the source's tail as an exact preserved
    # AV prefix (MiniMaxH3ExistingVideoMaskedContext, 39/90/141/... frames)
    # instead of MotionContext conditioning rows. 0 keeps MotionContext.
    existing_context_length: int = 0,
    # Generate a long clip as a chain of chunks inside ONE workflow. 0 is off.
    chunk_frames: int = 0,
    # Frame-aligned camera control from a grey-box animation. Unlike a reference
    # video, which H3 reads loosely, the control video is read frame for frame,
    # so it must be as long as the clip -- control_skip_frames picks the window.
    # A file in models/model_patches/ (the Fun ControlNet union). 2.0 is the default; the 1.x build still loads.
    control_net_name: str = "minimax_h3_fun_controlnet_union_2.0_pruned_bf16.safetensors",
    control_video_filename: str = "",
    # Frame-aligned source video for video-to-video LoRAs such as LMS. Unlike
    # Fun ControlNet this is encoded by the H3 VAE and placed on the target's
    # own timeline through MiniMaxH3AddGuide at frame 0.
    guide_video_filename: str = "",
    chunk_index: int = -1,
    control_skip_frames: int = 0,
    control_strength: float = 1.0,
    control_start_percent: float = 0.0,
    control_end_percent: float = 1.0,
    # The fallback for a direct call. Everything routed through main.py arrives
    # with a checkpoint already chosen by H3_MOTION_PRESETS, whose default is
    # "singularity" -- this value is only reached by a caller that names none.
    #
    # lightx2v's 8-step turbo and Mystic v2 motion (0.7) merged into the pruned
    # ref-delta base, then quantised once. Measured against the previous
    # hybrid-b25-49 + live turbo LoRA on a 7-reference Ref2VA shot: 78s vs 151s,
    # with the shot's acting beats actually performed rather than skipped. Run it
    # at 4 steps -- the merged turbo is a 4-or-8 NFE model. Because the LoRAs are
    # merged their strengths cannot be dialled back; a shot that needs restrained
    # motion wants "minimax_h3_hybrid_b25-49_int8.safetensors" plus the turbo LoRA
    # and scheduler="beta" instead.
    unet_name: str = "minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors",
    text_encoder: str = "",
    # int8_convrot: measured 1.56x faster than fp16 decoding 1376x768 and 1.63x
    # at 2752x1536 (23s off a 2x refine), for a difference to the fp16 decode of
    # 42-45 dB PSNR -- edge-hugging noise with no banding, blocking or colour
    # shift. Needs ComfyUI 0.31.0+ or it decodes black; we are on 0.34.0.
    video_vae: str = "minimax_h3_video_vae_int8_convrot.safetensors",
    audio_vae: str = "minimax_h3_audio_vae_fp32.safetensors",
    pair_tag: Optional[str] = None,
    # VAEDecodeTiled instead of VAEDecode, for 16 GB cards (machine_profile).
    tiled_vae_decode: bool = False,
    # videorebirth/hyperflow, converted to ComfyUI keys (custom node
    # ComfyUI-HyperFlow-H3). Its own 8-step sigma grid + euler; needs an unpruned
    # checkpoint (one with time_embedder), and replaces the turbo LoRA.
    hyperflow_lora: str = "",
    # Overrides the sampler the LoRA logic below would pick. The CrossView route
    # runs the official DMD LoRA with res_multistep, as its released workflow does.
    sampler: str = "",
    # Re-angle an existing clip (CrossView-Warp LoRA). A dict with "source" (a
    # clip in ComfyUI input, already at width x height and `length` frames),
    # "azimuth", "elevation", "distance" and optionally "keyframes" (a list of
    # {"f", "az", "el", "dist"}, f counted from 1; adjacent frames = a hard cut).
    # The clip is depth-warped to the new camera inside this graph and the warp
    # goes to AddGuide at frame 0 as a raw IMAGE: saving it as h264 first smears
    # the magenta holes into purple and the model paints them (2026-09-21).
    crossview_warp: Optional[dict] = None,
    # Core BlockSparseAttention (sol-attn) before the guider. Measured on the
    # CrossView route only: 284 s -> 232 s, no visible loss at 100% crop.
    block_sparse: bool = False,
    # Audio locks (backend/audio_lock.py): a mixed track, one file in ComfyUI input,
    # and "a-b:strength;..." ranges on the GENERATION timeline. The sampler keeps
    # those stretches of the audio stream as recorded (AicinemaLockAudioRanges,
    # comfyui_nodes/aicinema_audio_lock) and generates the rest around them.
    audio_lock_track: str = "",
    audio_lock_ranges: str = "",
    audio_lock_feather: float = 0.0,
    # Redo only the sound of a finished render (backend/audio_redo.py): `refine_latent` is
    # the H3_Latent_*.safetensors it saved; {"steps", "denoise"} come from audio_redo.resolve.
    # The first-pass sampler is not run: the saved latent's picture is frozen
    # (H3AudioRefineMask, ComfyUI-H3-AudioRefine) and its audio re-noised and denoised again.
    audio_redo: Optional[dict] = None,
    refine_latent: str = "",
    # ...or a plain video instead of a saved latent (a trim, an edit, an upload has none): an
    # absolute path, already 24 fps, `width` x `height` and exactly `length` frames on the 51k+39
    # AV grid with its sound padded to match (main._prepare_upscale_source_video). The graph
    # encodes it the way the latent upscale does, then freezes its picture the same way.
    refine_video: str = "",
    # False leaves the H3_Latent_ file out: a clip nothing continues from, refines or redoes (a spoken line)
    # has no use for a latent of several GB.
    save_latent: bool = True,
) -> dict:
    """
    Build a MiniMax H3 native Video + Audio generation workflow (Ref2VA / FL2VA / I2VA / L2VA / T2VA).
    Supports:
      - Video Editing with <Video 1> + <Picture N>
      - First & Last frame interpolation (FL2VA)
      - Native synchronized audio track reuse & revoicing
      - Turbo LoRA (4-step preview / 8-step final) and SageAttention acceleration.
    """
    image_reference_filenames = list(image_reference_filenames or [])
    audio_reference_filenames = list(audio_reference_filenames or [])

    # ComfyUI numbers each filename_prefix independently, so "H3_Video" and
    # "H3_Latent" drift apart (they were 7 apart in practice). Everything that
    # pairs a video with its latent does it by swapping the prefix and keeping the
    # number, which silently stops matching -- the upscale node then reports "no
    # latent" for a clip that has one. A shared per-run tag makes the two names
    # line up again, so that swap is correct by construction.
    tag = pair_tag or uuid.uuid4().hex[:8]
    video_reference_filenames = list(video_reference_filenames or [])
    video_reference_sizes = list(video_reference_sizes or [])
    silent_video_references = set(silent_video_references or ())

    # Ensure dimensions are multiples of 32 (strictly required by H3 VAE & DiT 2x2 patchify).
    # The floor is 384 so the 480p profile (864x480) is not pushed up to 512.
    width = max(384, min(1536, round(width / 32) * 32))
    height = max(384, min(1536, round(height / 32) * 32))

    # Snap to H3's 17k+5 frame grid at 24fps
    if length < 5:
        length = 124
    else:
        length = length + (5 - length % 17) % 17

    # euler belongs to the live turbo-LoRA path; the fused checkpoint (lora_name
    # empty) was distilled against res_multistep, which also measured better for
    # its audio at 4 steps.
    use_turbo_lora = steps <= 8 and bool(lora_name)
    sampler_name = "euler" if use_turbo_lora else "res_multistep"
    _lock = _lora_sampling_lock(lora_name, style_lora_name, *(style_loras or []))
    if _lock:
        sampler_name, scheduler = _lock
    if sampler:
        sampler_name = sampler
    if hyperflow_lora:
        if lora_name:
            raise ValueError("hyperflow_lora replaces the turbo LoRA; do not name both")
        sampler_name = "euler"

    wf: dict = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {
                "unet_name": unet_name,
                "weight_dtype": "default",
            },
        },
        "3": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": text_encoder or h3_text_encoder(),
                "type": "minimax",
                "device": "default",
            },
        },
        "4": {
            "class_type": "VAELoader",
            "inputs": {
                "vae_name": video_vae,
            },
        },
        "5": {
            "class_type": "VAELoader",
            "inputs": {
                "vae_name": audio_vae,
            },
        },
        "40": {
            "class_type": "RandomNoise",
            "inputs": {
                "noise_seed": seed,
            },
        },
        "43": {
            "class_type": "KSamplerSelect",
            "inputs": {
                "sampler_name": sampler_name,
            },
        },
        "44": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["40", 0],
                "guider": ["41", 0],
                "sampler": ["43", 0],
                "sigmas": ["42", 0],
                "latent_image": ["31", 1],
            },
        },
        "50": _h3_video_decode(["44", 0], tiled_vae_decode),
        "51": {
            "class_type": "VAEDecodeAudio",
            "inputs": {
                "samples": ["44", 0],
                "vae": ["5", 0],
            },
        },
        "60": {
            "class_type": "CreateVideo",
            "inputs": {
                "images": ["50", 0],
                "fps": 24.0,
                "audio": ["51", 0],
            },
        },
        "61": {
            "class_type": "SaveVideo",
            "inputs": {
                "video": ["60", 0],
                # A chunk of a longer clip is named apart from a finished one. Both used
                # to land in the output directory as H3_Video_<tag>, and a cancelled
                # chunked run leaves its finished chunks behind looking exactly like
                # results -- a 5-second "master" that was never a master (2026-09-08).
                "filename_prefix": (f"H3_Chunk_{tag}" if motion_context_latent or motion_context_video or chunk_index >= 0
                                    else f"H3_Video_{tag}"),
                "format": "mp4",
                "codec": "h264",
            },
        },
        "62": {
            # H3 samples contain a NestedTensor(video, audio). ComfyUI's stock
            # SaveLatent calls .contiguous() on the container and crashes after
            # sampling; the H3 saver serialises both streams independently.
            "class_type": "MiniMaxH3MotionContextSaveLatent",
            "inputs": {
                "latent": ["44", 0],
                "filename_prefix": f"H3_Latent_{tag}",
                "clip_index": 0,
            },
        },
    }

    # Model LoRA loader (Turbo LoRA support)
    if hyperflow_lora:
        wf["2"] = {
            "class_type": "HyperFlowH3Apply",
            "inputs": {"model": ["1", 0], "lora_name": _normalize_lora_name(hyperflow_lora), "strength": 1.0},
        }
        model_src = ["2", 0]
    elif lora_name:
        wf["2"] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": ["1", 0],
                "lora_name": _normalize_lora_name(lora_name),
                "strength_model": float(lora_strength),
            },
        }
        model_src = ["2", 0]
    else:
        model_src = ["1", 0]

    # Style / content LoRA, stacked on top of the Turbo LoRA
    if style_lora_name:
        wf["2s"] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": model_src,
                "lora_name": _normalize_lora_name(style_lora_name),
                "strength_model": float(style_lora_strength),
            },
        }
        model_src = ["2s", 0]

    # Several style LoRAs, stacked in the order given (node multi-select).
    for i, item in enumerate(style_loras or []):
        name = (item or {}).get("name") if isinstance(item, dict) else str(item)
        if not name:
            continue
        strength = float((item or {}).get("strength", 1.0)) if isinstance(item, dict) else 1.0
        nid = f"2s{i}"
        wf[nid] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": model_src,
                "lora_name": _normalize_lora_name(name),
                "strength_model": strength,
            },
        }
        model_src = [nid, 0]

    # Attention & Shift Patches
    model_src, curr_patch_id = _apply_h3_accel(wf, model_src, accel_for_unet(unet_name, sage), 20)

    if shift_video or shift_audio:
        wf[str(curr_patch_id)] = {
            "class_type": "MiniMaxH3SigmaShift",
            "inputs": {
                "model": model_src,
                "shift_video": float(shift_video or 12.0),
                "shift_audio": float(shift_audio or 3.0),
            },
        }
        model_src = [str(curr_patch_id), 0]

    # Fun ControlNet: drive the camera from a grey-box animation, frame for
    # frame.
    #
    # A grey-box mounted on ref_videos is only a soft reference -- H3 reads it
    # as "the room looks roughly like this" and rebuilds the geometry anyway,
    # which is what the relight attempts on 2026-09-07 demonstrated: a 124-frame
    # reference against a 124-frame generation still invented a gallery wall and
    # moved the window. The control video is the frame-aligned input, and being
    # frame-aligned is exactly why it has to be as long as the clip.
    #
    # VHS_LoadVideo does the windowing in the graph, so a chunk reads its own
    # stretch with skip_first_frames and needs no pre-cut file. Tested on pruned int8, w4a8 (official and
    # Singularity) and fused; the official nodes need no adaln_basis / adaln_mean, so fused is not required.
    if control_video_filename:
        wf["90"] = {
            "class_type": "VHS_LoadVideo",
            "inputs": {
                "video": control_video_filename,
                # Frame-aligned to a 24 fps generation, so read at 24 fps: a
                # control cut from a 59.94 fps source would otherwise play 2.5x slow.
                "force_rate": 24,
                "custom_width": width,
                "custom_height": height,
                "frame_load_cap": length,
                "skip_first_frames": int(control_skip_frames),
                "select_every_nth": 1,
            },
        }
        # ComfyUI's own nodes, as in the official template (video_minimax_h3_fun_controlnet_union): they load both
        # the 1.x (5 control blocks) and the 2.0 (10 blocks) union checkpoints from models/model_patches/. The earlier
        # custom H3FunControlLoader was the 1.x path and over-sharpened 2.0 (measured 2026-10-04: 7x the high-frequency
        # energy); through these nodes 2.0 renders normally on pruned int8, w4a8 (official and Singularity) and fused.
        wf["91"] = {
            "class_type": "ModelPatchLoader",
            "inputs": {"name": control_net_name},
        }
        wf["92"] = {
            "class_type": "MiniMaxH3FunControlNetApply",
            "inputs": {
                "model": model_src,
                "model_patch": ["91", 0],
                "vae": ["4", 0],
                "control_video": ["90", 0],
                "strength": float(control_strength),
                "start_percent": float(control_start_percent),
                "end_percent": float(control_end_percent),
            },
        }
        model_src = ["92", 0]

    if block_sparse:
        wf["95"] = {
            "class_type": "BlockSparseAttention",
            "inputs": {
                "model": model_src,
                "selection": "sol-attn", "selection.tau": 1.3,
                "start_percent": 0.2, "end_percent": 1.0, "dense_blocks": "",
                "min_tokens": 12288, "extra_tokens": 256,
                # Text, reference and target-audio rows stay dense: the audio is kept intact.
                "sink_conditioning": "exact_kv_and_rows", "verbose": False,
            },
        }
        model_src = ["95", 0]

    wf["41"] = {
        "class_type": "BasicGuider",
        "inputs": {
            "model": model_src,
            "conditioning": ["31", 0],
        },
    }
    wf["42"] = {
        "class_type": "BasicScheduler",
        "inputs": {
            "model": model_src,
            "scheduler": scheduler,
            "steps": steps,
            "denoise": 1.0,
        },
    }
    if hyperflow_lora:
        wf["42"] = {"class_type": "HyperFlowH3Sigmas",
                    "inputs": {"lora_name": _normalize_lora_name(hyperflow_lora)}}

    # Determine conditioning approach
    # If only first_frame without any other ref images/audio/video/last_frame -> lightweight MiniMaxH3ImageToVideo
    if first_frame_filename and not last_frame_filename and not guide_frames and not image_reference_filenames and not audio_reference_filenames and not video_reference_filenames:
        wf["99"] = {
            "class_type": "LoadImage",
            "inputs": {
                "image": first_frame_filename,
            },
        }
        wf["98"] = {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["99", 0],
                "upscale_method": "bicubic",
                "width": width,
                "height": height,
                "crop": "center",
            },
        }
        wf["31"] = {
            "class_type": "MiniMaxH3ImageToVideo",
            "inputs": {
                "clip": ["3", 0],
                "vae": ["4", 0],
                "prompt": prompt,
                "width": width,
                "height": height,
                "length": length,
                "first_frame": ["98", 0],
            },
        }
    else:
        # Full Multimodal Reference Engine (MiniMaxH3ReferenceToVideo)
        #
        # Only real <Picture N> references go in here. A first or last frame is
        # a *keyframe*, not a reference: it belongs at a fixed frame index, and
        # H3 has a node for exactly that (MiniMaxH3AddGuide, chained below).
        # Prepending it to this list used to renumber every label after it, so
        # a package whose prompt said <Picture 1> = the hero car silently got
        # the first frame under that label and pushed its last reference to a
        # <Picture N> the prompt never mentions.
        IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff'}
        VIDEO_EXTS = {'.mp4', '.avi', '.mov', '.mkv', '.webm'}
        AUDIO_EXTS = {'.m4a', '.mp3', '.wav', '.flac', '.ogg', '.aac'}

        all_images: list[str] = []
        for img in image_reference_filenames:
            if Path(img).suffix.lower() in IMAGE_EXTS and img not in all_images:
                all_images.append(img)

        r2v_inputs: dict = {
            "clip": ["3", 0],
            "vae": ["4", 0],
            "audio_vae": ["5", 0],
            "prompt": prompt,
            "width": width,
            "height": height,
            "length": length,
            "ref_image_size": ref_image_size,
        }

        # Mount reference images (<Picture 1>, <Picture 2>, ...).
        #
        # Untouched, whatever ref_image_size says. The node never crops: under
        # 'match' it scales each reference DOWN keeping its aspect until its area
        # equals the output canvas, under 'max' to a 2048px short edge
        # (comfy_extras/nodes_minimax_h3.py). The centre crop to the output shape
        # that used to sit here was our own addition, and it cut the top and
        # bottom off every portrait character sheet and the sides off every wide
        # plate before the model saw them (2026-09-06).
        for i, img in enumerate(all_images):
            load_nid = str(100 + i)
            wf[load_nid] = {"class_type": "LoadImage", "inputs": {"image": img}}
            r2v_inputs[f"ref_images.ref_image_{i}"] = [load_nid, 0]

        # Mount reference videos & their native synchronized audio tracks (<Video 1>, ...)
        valid_video_refs = [
            vid for vid in video_reference_filenames
            if vid and Path(vid).suffix.lower() in VIDEO_EXTS
        ]
        # Index the requested sizes by filename: valid_video_refs drops image
        # files, so positions here do not line up with the caller's list.
        size_by_name = {
            name: size
            for name, size in zip(video_reference_filenames, video_reference_sizes)
            if size
        }

        for i, vid in enumerate(valid_video_refs):
            nid = str(300 + i)
            cid = str(350 + i)
            wf[nid] = {"class_type": "LoadVideo", "inputs": {"file": vid}}
            wf[cid] = {"class_type": "GetVideoComponents", "inputs": {"video": [nid, 0]}}

            # Frames go in at the reference's own resolution unless the caller
            # asked for a smaller one. The size is computed from the source's
            # aspect ratio, so crop stays disabled — nothing is cut off, the
            # frame is only made smaller.
            frames_out = [cid, 0]
            target = size_by_name.get(vid)
            if target:
                rid = str(380 + i)
                wf[rid] = {
                    "class_type": "ImageScale",
                    "inputs": {
                        "image": [cid, 0],
                        # 'area' is the right filter for minification: it
                        # averages the pixels it discards instead of aliasing.
                        "upscale_method": "area",
                        "width": int(target[0]),
                        "height": int(target[1]),
                        "crop": "disabled",
                    },
                }
                frames_out = [rid, 0]

            r2v_inputs[f"ref_videos.ref_video_{i}"] = frames_out
            # Crucial: pass reference video audio stream to enable H3 native audio reuse & timbre guidance.
            # Skipped for a soundless reference (a previs render): the H3 node
            # encodes whatever audio it is handed and gives it an <Audio N>
            # label, so mounting silence declares a reference the prompt never
            # names and the shot's own soundscape has to argue with it.
            if vid not in silent_video_references:
                r2v_inputs[f"ref_video_audios.ref_video_audio_{i}"] = [cid, 1]

        # Mount standalone audio references (<Audio 1>, ...)
        valid_audio_refs = [
            aud for aud in audio_reference_filenames
            if aud and Path(aud).suffix.lower() in AUDIO_EXTS
        ]
        for i, aud in enumerate(valid_audio_refs):
            nid = str(200 + i)
            wf[nid] = {"class_type": "LoadAudio", "inputs": {"audio": aud}}
            r2v_inputs[f"ref_audios.ref_audio_{i}"] = [nid, 0]

        wf["31"] = {
            "class_type": "MiniMaxH3ReferenceToVideo",
            "inputs": r2v_inputs,
        }

        # Anchor the first/last frames on the target's own timeline. Unlike a
        # reference — packed before the target and sharing none of its time
        # coordinates — a guide latent is re-injected at its frame index every
        # step, which is the only thing in this stack that actually pins a
        # composition. The node resizes to the generation canvas itself.
        cond_out = ["31", 0]
        if guide_video_filename and crossview_warp:
            raise ValueError("crossview_warp builds its own guide; do not also pass guide_video_filename")
        if guide_video_filename or crossview_warp:
            wf["85"] = {"class_type": "LoadVideo",
                        "inputs": {"file": guide_video_filename or crossview_warp["source"]}}
            wf["86"] = {"class_type": "GetVideoComponents", "inputs": {"video": ["85", 0]}}
            guide_image = ["86", 0]
            if crossview_warp:
                keyframes = crossview_warp.get("keyframes") or []
                wf["80"] = {"class_type": "LoadMoGeModel",
                            "inputs": {"model_name": "moge_2_vitl_normal_fp16.safetensors"}}
                # Depth may be estimated from a brightened copy of the clip
                # (depth_source): on a dark night interior MoGe masks most of the
                # frame as unreliable, the warp comes out nearly all holes, and the
                # model ignores the guide and copies its references instead (
                # C27, 2026-09-28). The warp itself still moves the original frames.
                depth_image = ["86", 0]
                if crossview_warp.get("depth_source"):
                    wf["83"] = {"class_type": "LoadVideo",
                                "inputs": {"file": crossview_warp["depth_source"]}}
                    wf["84"] = {"class_type": "GetVideoComponents", "inputs": {"video": ["83", 0]}}
                    depth_image = ["84", 0]
                wf["81"] = {"class_type": "MoGeInference", "inputs": {
                    "moge_model": ["80", 0], "image": depth_image,
                    "resolution_level": 2, "fov_x_degrees": 0.0, "batch_size": 4,
                    "force_projection": True,
                    "apply_mask": bool(crossview_warp.get("apply_mask", True)),
                    "refine_steps": 0}}
                wf["82"] = {"class_type": "CrossViewWarp", "inputs": {
                    "frames": ["86", 0], "moge_geometry": ["81", 0],
                    "azimuth": float(crossview_warp.get("azimuth", 30.0)),
                    "elevation": float(crossview_warp.get("elevation", 0.0)),
                    "distance": float(crossview_warp.get("distance", 1.0)),
                    "hfov": 50.0, "vertical_shift": 0.0,
                    "depth_ratio": float(crossview_warp.get("depth_ratio", 6.0)),
                    "smooth_depth": bool(crossview_warp.get("smooth_depth", False)),
                    "invert_depth": False,
                    # The README's advice, and what the accepted tests ran: orbit a
                    # pivot estimated from the frame centre, keep the source's aim.
                    # The default fixed pivot (1.05 depth units) swings anything
                    # near the lens across the frame.
                    "pivot_override": False,
                    "keep_source_aim": bool(crossview_warp.get("keep_source_aim", True)),
                    # An explicit rotation centre, in MoGe's camera space (z = metres
                    # ahead). The automatic one comes from the middle of the frame:
                    # fine on a bed two metres away, but looking out of a car it lands
                    # on the road far ahead, the orbit radius (distance x |pivot|)
                    # explodes and the near seats shred (C27, 2026-09-28).
                    **({"pivot_override": True,
                        "pivot_x": float(crossview_warp["pivot"].get("x", 0.0)),
                        "pivot_y": float(crossview_warp["pivot"].get("y", 0.0)),
                        "pivot_z": float(crossview_warp["pivot"].get("z", 1.05))}
                       if crossview_warp.get("pivot") else {}),
                    "use_keyframes": bool(keyframes),
                    "keyframes": json.dumps(keyframes) if keyframes else ""}}
                guide_image = ["82", 0]
            wf["87"] = {
                "class_type": "ImageScale",
                "inputs": {
                    "image": guide_image,
                    "upscale_method": "area",
                    "width": width,
                    "height": height,
                    "crop": "disabled",
                },
            }
            wf["88"] = {
                "class_type": "MiniMaxH3AddGuide",
                "inputs": {
                    "positive": cond_out,
                    "latent": ["31", 1],
                    "frame_idx": 0,
                    "vae": ["4", 0],
                    "image": ["87", 0],
                },
            }
            cond_out = ["88", 0]
        # A continuation regenerates its first context_length frames from the previous clip, so a
        # first-frame guide at 0 is overwritten there and does nothing: it goes on the first frame
        # after that window instead.
        first_frame_idx = 0
        if motion_context_latent or motion_context_video:
            first_frame_idx = int(existing_context_length or motion_context_length)
        for fname, frame_idx, load_nid, guide_nid in (
            (first_frame_filename, first_frame_idx, "70", "71"),
            (last_frame_filename, int(last_frame_index), "72", "73"),
        ):
            if not fname:
                continue
            wf[load_nid] = {"class_type": "LoadImage", "inputs": {"image": fname}}
            wf[guide_nid] = {
                "class_type": "MiniMaxH3AddGuide",
                "inputs": {
                    "positive": cond_out,
                    "latent": ["31", 1],
                    "frame_idx": frame_idx,
                    "vae": ["4", 0],
                    "image": [load_nid, 0],
                },
            }
            cond_out = [guide_nid, 0]
        for gi, (fname, frame_idx) in enumerate(guide_frames or []):
            load_nid, guide_nid = str(700 + 2 * gi), str(701 + 2 * gi)
            wf[load_nid] = {"class_type": "LoadImage", "inputs": {"image": fname}}
            wf[guide_nid] = {
                "class_type": "MiniMaxH3AddGuide",
                "inputs": {
                    "positive": cond_out,
                    "latent": ["31", 1],
                    "frame_idx": int(frame_idx),
                    "vae": ["4", 0],
                    "image": [load_nid, 0],
                },
            }
            cond_out = [guide_nid, 0]

        # Motion context: continue this chunk from the previous one's latent.
        #
        # A master that is one unbroken camera move will not fit in a single
        # 15-second generation, and three independent 5-second generations of
        # one room disagree with each other by construction. This is what joins
        # them: the tail of the previous clip is pinned as never-denoised
        # conditioning rows, so the new chunk starts already knowing what the
        # room looked like and where the camera was (2026-09-07).
        #
        # The wiring is the pack's own example workflow verbatim rather than a
        # reading of the schema: conditioning and the empty latent from
        # ReferenceToVideo, context_latent from MotionContextLoadLatent, both
        # VAEs, and the frame count the node returns drives MotionContextTrim,
        # because a context window is regenerated at the head of the clip and
        # has to come off before the pieces are joined.
        if motion_context_end_frame:
            need = int(existing_context_length or motion_context_length)
            if not motion_context_video:
                raise ValueError("motion_context_end_frame needs motion_context_video: only a clip's pictures can be cut at a point")
            if int(motion_context_end_frame) < need:
                raise ValueError(f"motion_context_end_frame {motion_context_end_frame} is shorter than the {need}-frame context window")
        if motion_context_latent and existing_context_length and not motion_context_video:
            # The same preserved-prefix extension straight from the previous clip's saved
            # latent (MiniMaxH3GeneratedAVMaskedContext): its last AV run is copied into
            # the head of the target and masked, so it is neither regenerated nor passed
            # through a decode, an h264 file and a VAE encode the way the frame path is.
            wf["80"] = {"class_type": "MiniMaxH3MotionContextLoadLatent",
                        "inputs": {"latent_path": motion_context_latent, "clip_index": 0}}
            wf["81"] = {"class_type": "MiniMaxH3GeneratedAVMaskedContext",
                        "inputs": {"latent": ["31", 1], "source_latent": ["80", 0],
                                   "context_length": int(existing_context_length), "audio_feather_ticks": 8}}
            wf["44"]["inputs"]["latent_image"] = ["81", 0]
            wf["82"] = {
                "class_type": "MiniMaxH3MotionContextTrim",
                "inputs": {"images": ["50", 0], "audio": ["51", 0],
                           "trim_frames": ["81", 1], "audio_fps": 24, "trim_audio": True},
            }
            wf["60"]["inputs"]["images"] = ["82", 0]
            wf["60"]["inputs"]["audio"] = ["82", 1]
            _add_untrimmed_save(wf, tag)
        elif motion_context_video and existing_context_length:
            # The pack's own extension path: the source tail is VAE-encoded into
            # the head of the target latent and protected by a per-stream noise
            # mask, so those frames and their sound come out as the source had
            # them and H3 generates only what follows. The preserved head is cut
            # off the decoded result, so the node delivers only the new footage.
            wf["80"] = {
                "class_type": "VHS_LoadVideoPath",
                "inputs": {"video": motion_context_video, "force_rate": 24,
                           "custom_width": 0, "custom_height": 0, "frame_load_cap": int(motion_context_end_frame or 0),
                           "skip_first_frames": 0, "select_every_nth": 1},
            }
            wf["81"] = {
                "class_type": "MiniMaxH3ExistingVideoMaskedContext",
                "inputs": {"latent": ["31", 1], "vae": ["4", 0], "audio_vae": ["5", 0],
                           "source_frames": ["80", 0], "source_audio": ["80", 2],
                           "source_fps": 24.0, "context_length": int(existing_context_length),
                           "crop": "disabled", "audio_feather_ticks": 8},
            }
            wf["44"]["inputs"]["latent_image"] = ["81", 0]
            wf["82"] = {
                "class_type": "MiniMaxH3MotionContextTrim",
                "inputs": {"images": ["50", 0], "audio": ["51", 0],
                           "trim_frames": ["81", 1], "audio_fps": 24, "trim_audio": True},
            }
            wf["60"]["inputs"]["images"] = ["82", 0]
            wf["60"]["inputs"]["audio"] = ["82", 1]
            _add_untrimmed_save(wf, tag)
        elif motion_context_latent or motion_context_video:
            if motion_context_video:
                # Frames and audio straight off the file. force_rate 24 keeps a
                # clip that was re-encoded at another rate from silently
                # resampling the context window.
                wf["80"] = {
                    "class_type": "VHS_LoadVideoPath",
                    "inputs": {
                        "video": motion_context_video,
                        "force_rate": 24,
                        "custom_width": 0,
                        "custom_height": 0,
                        "frame_load_cap": int(motion_context_end_frame or 0),
                        "skip_first_frames": 0,
                        "select_every_nth": 1,
                    },
                }
                carry_in = {"context_frames": ["80", 0], "context_audio": ["80", 2]}
            else:
                wf["80"] = {
                    "class_type": "MiniMaxH3MotionContextLoadLatent",
                    "inputs": {"latent_path": motion_context_latent, "clip_index": 0},
                }
                carry_in = {"context_latent": ["80", 0]}
            wf["81"] = {
                "class_type": "MiniMaxH3MotionContext",
                "inputs": {
                    "conditioning": cond_out,
                    "vae": ["4", 0],
                    "latent": ["31", 1],
                    **carry_in,
                    "audio_vae": ["5", 0],
                    # 22 is the pack's default and its own note calls it "nearly
                    # seamless"; 5 is "just barely fluid" and 56 spends 2.3
                    # seconds of the render on frames that get thrown away.
                    "context_length": str(motion_context_length),
                    "audio_context_length": int(motion_context_audio),
                },
            }
            cond_out = ["81", 0]
            # Everything downstream of the sampler (decode, the saved latent the next
            # link continues from) takes the seam-matched latent.
            matched = _seam_match(
                wf, "45", ["44", 0],
                {"context_latent": ["80", 0]} if not motion_context_video
                else {"context_frames": ["80", 0]},
                motion_context_length, seam_match, seam_match_gain, seam_match_texture,
                seam_match_post_gain, seam_match_adaptive)
            if matched != ["44", 0]:
                wf["50"]["inputs"]["samples"] = matched
                wf["51"]["inputs"]["samples"] = matched
                if "62" in wf:
                    wf["62"]["inputs"]["latent"] = matched
            wf["82"] = {
                "class_type": "MiniMaxH3MotionContextTrim",
                "inputs": {
                    "images": ["50", 0],
                    "audio": ["51", 0],
                    "trim_frames": ["81", 1],
                    "audio_fps": 24,
                    "trim_audio": True,
                },
            }
            wf["60"]["inputs"]["images"] = ["82", 0]
            wf["60"]["inputs"]["audio"] = ["82", 1]
            _add_untrimmed_save(wf, tag)

        wf["41"]["inputs"]["conditioning"] = cond_out

    # ---- audio locks -----------------------------------------------------------
    # Sits on whatever latent the sampler was going to take (the Ref2VA latent, or
    # the masked-context latent of an extension), so it composes with motion
    # context: MotionContext pins its rows through the conditioning and leaves the
    # latent alone (read from the pack, then measured on a chained clip).
    if audio_lock_track and audio_lock_ranges:
        if chunk_frames and length > chunk_frames:
            raise ValueError("audio locks are not supported with chunk_frames: each chunk has its own "
                             "timeline; lock the lines on the chunk that speaks them")
        wf["aclock:load"] = {"class_type": "LoadAudio", "inputs": {"audio": audio_lock_track}}
        wf["aclock:enc"] = {"class_type": "VAEEncodeAudio",
                            "inputs": {"audio": ["aclock:load", 0], "vae": ["5", 0]}}
        wf["aclock:lock"] = {
            "class_type": "AicinemaLockAudioRanges",
            "inputs": {"target_latent": wf["44"]["inputs"]["latent_image"],
                       "audio_latent": ["aclock:enc", 0],
                       "ranges": audio_lock_ranges,
                       "feather_seconds": float(audio_lock_feather),
                       "duration_seconds": length / 24.0},
        }
        wf["44"]["inputs"]["latent_image"] = ["aclock:lock", 0]

    # ---- redo only the sound of an existing render -----------------------------
    if audio_redo and (refine_latent or refine_video):
        if chunk_frames and length > chunk_frames:
            raise ValueError("redoing audio is not supported with chunk_frames")
        guider_model = wf["41"]["inputs"]["model"]
        if refine_video:
            wf["ar:src"] = {"class_type": "VHS_LoadVideoPath", "inputs": {
                "video": refine_video, "force_rate": 24, "custom_width": 0, "custom_height": 0,
                "frame_load_cap": 0, "skip_first_frames": 0, "select_every_nth": 1}}
            wf["ar:empty"] = {"class_type": "EmptyMiniMaxH3LatentAV", "inputs": {
                "width": width, "height": height, "length": length}}
            wf["ar:pack"] = {"class_type": "MiniMaxH3ExistingVideoMaskedContext", "inputs": {
                "latent": ["ar:empty", 0], "vae": ["4", 0], "audio_vae": ["5", 0],
                "source_frames": ["ar:src", 0], "source_audio": ["ar:src", 2], "source_fps": 24.0,
                "context_length": length, "crop": "disabled", "audio_feather_ticks": 0}}
        else:
            wf["ar:load"] = {"class_type": "MiniMaxH3MotionContextLoadLatent",
                             "inputs": {"latent_path": refine_latent, "clip_index": 0}}
            wf["ar:pack"] = {"class_type": "AicinemaPackSavedLatent", "inputs": {"latent": ["ar:load", 0]}}
        wf["ar:mask"] = {"class_type": "H3AudioRefineMask", "inputs": {"latent": ["ar:pack", 0]}}
        sampled = ["ar:mask", 0]
        if "aclock:lock" in wf:
            # locked lines stay locked: this node keeps the video mask the line above set
            wf["ar:lock"] = {
                "class_type": "AicinemaLockAudioRanges",
                "inputs": {"target_latent": ["ar:mask", 0], "audio_latent": ["aclock:enc", 0],
                           "ranges": audio_lock_ranges, "feather_seconds": float(audio_lock_feather),
                           "duration_seconds": length / 24.0},
            }
            sampled = ["ar:lock", 0]
        wf["ar:guider"] = {"class_type": "BasicGuider",
                           "inputs": {"model": guider_model, "conditioning": wf["41"]["inputs"]["conditioning"]}}
        wf["ar:sched"] = {"class_type": "BasicScheduler",
                          "inputs": {"model": guider_model, "scheduler": "simple",
                                     "steps": int(audio_redo["steps"]), "denoise": float(audio_redo["denoise"])}}
        # the seed IS the new soundtrack when denoise is 1.0 (no first pass to share it with)
        wf["ar:noise"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": int(seed)}}
        wf["ar:samp"] = {"class_type": "SamplerCustomAdvanced",
                         "inputs": {"noise": ["ar:noise", 0], "guider": ["ar:guider", 0], "sampler": ["43", 0],
                                    "sigmas": ["ar:sched", 0], "latent_image": sampled}}
        wf["50"]["inputs"]["samples"] = ["ar:samp", 0]
        wf["51"]["inputs"]["samples"] = ["ar:samp", 0]
        if "62" in wf and "latent" in wf["62"]["inputs"]:
            wf["62"]["inputs"]["latent"] = ["ar:samp", 0]

    # ---- one long clip as a chain of chunks, inside one workflow ------------
    #
    # The ground-floor master is a single unbroken camera move that will not fit
    # in one 15-second generation. Splitting it into separate jobs was the first
    # answer and the wrong one: three generations of one room disagree, and
    # stitching them is manual work every time. So the chain is built into the
    # graph instead (2026-09-07: can the node not handle it itself).
    #
    # Each stage samples `chunk_frames`, and every stage after the first takes
    # the previous stage's latent straight off the sampler as its motion
    # context -- no save, no load, no file. MotionContextTrim then takes the
    # regenerated head off the decoded picture and audio, and the stages are
    # joined with ImageBatch and AudioConcat and cut back to the exact length.
    if chunk_frames and length > chunk_frames:
        keep = chunk_frames - int(motion_context_length)
        if keep < 1:
            raise ValueError(f"chunk_frames {chunk_frames} leaves nothing after a "
                             f"{motion_context_length}-frame context window")
        stages = 1 + -(-(length - chunk_frames) // keep)      # ceil

        base_r2v = dict(wf["31"]["inputs"])
        base_r2v["length"] = chunk_frames
        base_guider = dict(wf["41"]["inputs"])
        base_sampler = dict(wf["44"]["inputs"])
        base_noise = dict(wf["40"]["inputs"])

        images = audio = None
        prev_out = None          # each stage's (seam-matched) latent, the next stage's context
        for c in range(stages):
            r2v, gid, sid, nid = f"c{c}:r2v", f"c{c}:guide", f"c{c}:samp", f"c{c}:noise"
            dv, da = f"c{c}:dec", f"c{c}:deca"
            wf[r2v] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": dict(base_r2v)}
            # One seed for the whole chain, which is what the Motion Context
            # node's own documentation does (NikoDemon80/ComfyUI-H3-Motion-
            # Context: the chained clip inherits motion and audio through
            # `context_latent`, not through the noise). An earlier version here
            # used `seed + c`, on a suspicion that a shared seed pulls every
            # chunk toward the same still; that was never measured against a
            # same-prompt pair, so it is off until it is (2026-09-09).
            wf[nid] = {"class_type": "RandomNoise",
                       "inputs": {**base_noise, "noise_seed": int(seed)}}
            cond = [r2v, 0]
            if c:
                mc = f"c{c}:mctx"
                wf[mc] = {
                    "class_type": "MiniMaxH3MotionContext",
                    "inputs": {
                        "conditioning": cond,
                        "vae": ["4", 0],
                        "latent": [r2v, 1],
                        "context_latent": prev_out,
                        "audio_vae": ["5", 0],
                        "context_length": str(motion_context_length),
                        "audio_context_length": int(motion_context_audio),
                    },
                }
                cond = [mc, 0]
            wf[gid] = {"class_type": wf["41"]["class_type"],
                       "inputs": {**base_guider, "conditioning": cond}}
            wf[sid] = {"class_type": "SamplerCustomAdvanced",
                       "inputs": {**base_sampler, "noise": [nid, 0],
                                  "guider": [gid, 0], "latent_image": [r2v, 1]}}
            out = ([sid, 0] if not c else
                   _seam_match(wf, f"c{c}:seam", [sid, 0], {"context_latent": prev_out},
                               motion_context_length, seam_match, seam_match_gain, seam_match_texture,
                               seam_match_post_gain, seam_match_adaptive))
            prev_out = out
            wf[dv] = _h3_video_decode(out, tiled_vae_decode)
            wf[da] = {"class_type": "VAEDecodeAudio", "inputs": {"samples": out, "vae": ["5", 0]}}

            if c == 0:
                images, audio = [dv, 0], [da, 0]
                continue
            tr = f"c{c}:trim"
            wf[tr] = {"class_type": "MiniMaxH3MotionContextTrim",
                      "inputs": {"images": [dv, 0], "audio": [da, 0],
                                 "trim_frames": [f"c{c}:mctx", 1],
                                 "audio_fps": 24, "trim_audio": True}}
            wf[f"c{c}:cat"] = {"class_type": "ImageBatch",
                               "inputs": {"image1": images, "image2": [tr, 0]}}
            wf[f"c{c}:acat"] = {"class_type": "AudioConcat",
                                "inputs": {"audio1": audio, "audio2": [tr, 1],
                                           "direction": "after"}}
            images, audio = [f"c{c}:cat", 0], [f"c{c}:acat", 0]

        wf["cut"] = {"class_type": "ImageFromBatch",
                     "inputs": {"image": images, "batch_index": 0, "length": length}}
        wf["60"]["inputs"]["images"] = ["cut", 0]
        wf["60"]["inputs"]["audio"] = audio
        # The single-pass sampler and its decodes are now dead ends; the saved
        # latent should be the last chunk's, so a later shot can continue from
        # where this one stopped.
        for dead in ("40", "41", "44", "45", "50", "51"):
            wf.pop(dead, None)
        wf["62"]["inputs"]["latent"] = prev_out

    if not save_latent:
        wf.pop("62", None)
    return wf


def build_h3_temporal_reshot_workflow(
    source_video: str,
    prompt: str,
    start_frame: int,
    frame_count: int,
    context_before: int = 39,
    context_after: int = 39,
    edge_blend_frames: int = 0,
    image_reference_filenames: list[str] = None,
    ref_image_size: str = "match",
    steps: int = 20,
    seed: int = 12345,
    lora_name: str = "",
    lora_strength: float = 1.0,
    style_lora_name: str = "",
    style_lora_strength: float = 1.0,
    sage: str = DEFAULT_H3_ACCEL,
    unet_name: str = "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    text_encoder: str = "",
    video_vae: str = "minimax_h3_video_vae_int8_convrot.safetensors",
    audio_vae: str = "minimax_h3_audio_vae_fp32.safetensors",
    condition_source_audio: bool = False,
    pair_tag: Optional[str] = None,
) -> dict:
    """Build FL MiniMax H3's source-preserving temporal reshot graph.

    Source audio is copied by the assembler whether or not it is conditioned.
    Leaving audio conditioning off avoids the plugin's occasional one-token audio
    shape mismatch for otherwise valid frame ranges.
    """
    refs = list(image_reference_filenames or [])
    settings = json.dumps({
        "version": 1,
        "start_frame": int(start_frame),
        "frame_count": int(frame_count),
        "context_before": int(context_before),
        "context_after": int(context_after),
        "edge_blend_frames": int(edge_blend_frames),
    }, separators=(",", ":"))
    tag = pair_tag or uuid.uuid4().hex[:8]

    wf: dict = {
        "rs:unet": {"class_type": "UNETLoader", "inputs": {
            "unet_name": unet_name, "weight_dtype": "default"}},
        "rs:clip": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": text_encoder or h3_text_encoder(), "type": "minimax", "device": "default"}},
        "rs:vvae": {"class_type": "VAELoader", "inputs": {"vae_name": video_vae}},
    }
    if condition_source_audio:
        wf["rs:avae"] = {"class_type": "VAELoader", "inputs": {"vae_name": audio_vae}}
    model_src = ["rs:unet", 0]
    if lora_name:
        wf["rs:turbo"] = {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": model_src, "lora_name": _normalize_lora_name(lora_name),
            "strength_model": float(lora_strength)}}
        model_src = ["rs:turbo", 0]
    if style_lora_name:
        wf["rs:style"] = {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": model_src, "lora_name": _normalize_lora_name(style_lora_name),
            "strength_model": float(style_lora_strength)}}
        model_src = ["rs:style", 0]
    model_src, _ = _apply_h3_accel(wf, model_src, accel_for_unet(unet_name, sage), 910)
    _lock = _lora_sampling_lock(lora_name, style_lora_name) or (
        "euler" if lora_name and steps <= 8 else "res_multistep", "simple")

    planner_inputs = {
        "clip": ["rs:clip", 0], "vae": ["rs:vvae", 0],
        "video": source_video, "prompt": prompt, "reshot_settings": settings,
        "ref_image_size": ref_image_size,
    }
    if condition_source_audio:
        planner_inputs["audio_vae"] = ["rs:avae", 0]
    for index, filename in enumerate(refs):
        node_id = f"rs:ref:{index}"
        wf[node_id] = {"class_type": "LoadImage", "inputs": {"image": filename}}
        planner_inputs[f"ref_images.ref_image_{index}"] = [node_id, 0]

    wf.update({
        "rs:plan": {"class_type": "FL_MiniMaxH3TemporalReshotPlanner", "inputs": planner_inputs},
        "rs:sample": {"class_type": "FL_MiniMaxH3BeatKSampler", "inputs": {
            "model": model_src, "shot_plan": ["rs:plan", 0], "vae": ["rs:vvae", 0],
            "seed": int(seed), "seed_mode": "fixed", "steps": int(steps), "cfg": 1.0,
            "sampler_name": _lock[0],
            "scheduler": _lock[1], "denoise": 1.0, "live_preview": False}},
        "rs:assemble": {"class_type": "FL_MiniMaxH3TemporalReshotAssembler", "inputs": {
            "shot_plan": ["rs:plan", 0], "latent": ["rs:sample", 0], "vae": ["rs:vvae", 0]}},
        "rs:save": {"class_type": "SaveVideo", "inputs": {
            "video": ["rs:assemble", 0], "filename_prefix": f"H3_Reshot_{tag}",
            "format": "mp4", "codec": "h264"}},
    })
    return wf


# The refinement pass runs at THIS sigma: one step from 0.6 to 0.
#
# Chosen by eye across the whole ladder (0.2 -> 0.92, with and without anchoring,
# from finished and half-finished latents). Two things about it cost a day to
# learn and are worth keeping in mind:
#
#  * A single step from a high sigma is not "repainting 60%". One euler step to
#    zero is the model's x0 prediction taken in one jump -- strongly regularised,
#    it cleans the upscaler's output rather than reimagining it. Two or three
#    steps across the same span give the model room to drift instead.
#  * `BasicScheduler(denoise=0.2)` does NOT mean sigma 0.2. It takes the tail 20%
#    of a curve that flow shift has already pushed to the top, landing at 0.6
#    under shift 6 and 0.75 under shift 12. Writing the sigma out avoids the trap.
REFINE_SIGMAS = "0.6000, 0.0000"

# Sigma shift for the refinement pass. Generation uses 12; the upscaler's own
# example workflow drops to 6 here, and it holds detail visibly better.
REFINE_SHIFT_VIDEO = 6.0
REFINE_SHIFT_AUDIO = 3.0

# Conditioning for the refinement pass: how to render, not what to render. A scene
# prompt measured 0.13 dB against this one and invites the model to paint the
# described scene back into a pass that is only meant to sharpen.
REFINE_PROMPT = (
    "segment video which takes <Picture 1> as reference, sharp focus, clear details"
)
# The same instruction with the label removed, for a shot that has no references
# to mount. <Picture 1> is a reference label: a guide frame does not carry one,
# so naming it with nothing mounted points the conditioning at an entry that is
# not there. Dropping the clause is the whole change — the refine pass is still
# being told how to render, not what to render.
REFINE_PROMPT_NO_REF = "segment video, sharp focus, clear details"


def build_h3_latent_upscale_workflow(
    latent_filename: str,
    # Empty means "pick the right refine text": which one is right depends on
    # whether anything is mounted for it to name.
    prompt: str = "",
    # Same shared tag as the generator: ComfyUI numbers each filename_prefix on
    # its own, so an untagged "H3_Upscale_Video"/"H3_Upscale_Latent" pair drifts
    # apart and nothing downstream can tell which latent belongs to which clip.
    pair_tag: Optional[str] = None,
    scale_by: float = 2.0,
    reference_filenames: Optional[list] = None,
    # A plain video instead of a saved latent: an absolute path, already 24 fps,
    # the source size (source_latent_w/h x 16) and exactly `length` frames on the
    # 51k+39 AV grid. See _swap_latent_source_for_video.
    source_video: str = "",
    # The frames the shot was generated against. A guide is not a reference: it is
    # re-injected at its frame index every step, so it pins composition where a
    # reference only offers texture. MMH3UltimateUpscale handles them natively —
    # it crops keyframes per tile and resizes their latents to the upscaled chunk
    # grid (see its README, "Per-piece conditioning") — so the refine pass can be
    # anchored exactly the way the generation was.
    first_frame_filename: Optional[str] = None,
    last_frame_filename: Optional[str] = None,
    # Empty: H3_LATENT_UPSCALER (environment or .env), else the original 3D checkpoint below.
    upscale_model: str = "",
    upscale_precision: str = "bf16",
    source_latent_w: int = 48,
    source_latent_h: int = 86,
    # LATENT-space alignment. 2 is correct and is the minimum: the only hard
    # requirement is an EVEN latent dimension, because an odd one leaves half a row
    # that decodes as a ~10px grey-blue band (#a6aab9) along the bottom. Anything
    # larger over-inflates the request and skews the aspect ratio when only one axis
    # rounds up -- at 16, an 86x48 latent went to 176x96: 2.047x wide by 2.000x tall.
    upscale_align: int = 2,
    length: int = 124,
    seed: int = 12345,
    manual_sigmas: str = REFINE_SIGMAS,
    sampler_name: str = "sa_solver",
    # Temporal chunking. 0 (the default) samples the whole clip as ONE span: the
    # temporal_split_param input is left unconnected, which the node documents as
    # "single chunk". A 362-frame 2752x1536 refine fits, so chunking only added
    # seams and anchor re-stages (2026-09-06: the upscale is not batched).
    # Set a positive multiple of 17 only when a clip will not fit in VRAM; then
    # every span after the first is anchored to the previous one's boundary frame.
    chunk_frames: int = 0,
    chunk_overlap: int = 17,
    anchor_strength: float = 0.999,
    # Spatial tiling exists only to bound VRAM, and it is expensive: every tile pays
    # a full model re-stage (~10s for a 20GB int8 checkpoint carrying LoRA patches).
    # On a 34GB card a 2752x1536 frame samples whole -- 512px tiles measured 787s
    # where no tiling measured 285s. Set a tile size only when a frame will not fit.
    spatial_tile: int = 0,
    spatial_overlap: int = 128,
    # Merged into the checkpoint below, so nothing is patched at load time --
    # which is most of why the refine pass got faster: every temporal chunk used
    # to pay a LoRA re-stage.
    lora_name: str = "",
    lora_strength: float = 1.0,
    sage: str = DEFAULT_H3_ACCEL,
    # Same fused checkpoint the generator defaults to. Chosen for detail, NOT for
    # speed: interleaved over three seeds this pass takes 168.6s against 169.1s
    # for hybrid + live turbo LoRA -- identical. (Unlike generation, where merging
    # the LoRA does save real time.) What it buys is resolved detail the old pair
    # smears: on a 1376x768 -> 2752x1536 refine a background licence plate came
    # back legible where hybrid left a blur. PSNR to the source was 30.7 vs 31.0,
    # so neither drifts and the difference is detail rather than drift.
    unet_name: str = "minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors",
    text_encoder: str = "",
    # int8_convrot: measured 1.56x faster than fp16 decoding 1376x768 and 1.63x
    # at 2752x1536 (23s off a 2x refine), for a difference to the fp16 decode of
    # 42-45 dB PSNR -- edge-hugging noise with no banding, blocking or colour
    # shift. Needs ComfyUI 0.31.0+ or it decodes black; we are on 0.34.0.
    video_vae: str = "minimax_h3_video_vae_int8_convrot.safetensors",
    audio_vae: str = "minimax_h3_audio_vae_fp32.safetensors",
    # A chained clip's saved latent still holds the context window regenerated
    # at its head; the clip itself had those frames trimmed before it was saved,
    # so the upscale has to take the same number off or it comes back longer
    # than its source (2026-09-15: chain 2's 2x was 260 frames against a
    # 238-frame clip). The caller works the count out; 0 leaves the decode whole.
    trim_head_frames: int = 0,
) -> dict:
    """
    Upscale a finished H3 latent in latent space and re-sample it once at the new size.

    `MMH3UltimateUpscale` drives the loop: temporal chunking, the 3D latent upscaler,
    optional spatial tiling, per-piece sampling and stitching, with the audio latent
    carried through untouched.

    Upscaling without the re-sample was tried and dropped: it cannot change the
    picture, but it cannot add detail either, and side by side it lost.
    """
    references = [r for r in (reference_filenames or []) if r]
    tag = pair_tag or uuid.uuid4().hex[:8]

    # Upscale target, solved in LATENT units and only then turned into pixels.
    # Orientation comes from the latent itself (shape[-1]=W, shape[-2]=H); deriving
    # it from video pixel dimensions is how portrait clips got W/H swapped.
    _up_align = max(2, int(upscale_align))

    def _align_up(v) -> int:
        return ((int(math.ceil(v)) + _up_align - 1) // _up_align) * _up_align

    _src_w = max(1, int(source_latent_w))
    _src_h = max(1, int(source_latent_h))
    _req = max(1.0, float(scale_by))          # below 1.0 the upscaler rejects the job
    _up_w = max(_align_up(_src_w * _req), _align_up(_src_w)) * 16
    _up_h = max(_align_up(_src_h * _req), _align_up(_src_h)) * 16

    wf: dict = {
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": video_vae}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": audio_vae}},
        "10": {
            "class_type": "MiniMaxH3MotionContextLoadLatent",
            "inputs": {"latent_path": latent_filename, "clip_index": 0},
        },
        # The loader hands back {"samples": [video, audio]} -- a plain Python list.
        # Everything downstream expects a NestedTensor, and a list raises
        # `AttributeError: 'list' object has no attribute 'unbind'`. scale_by=1.0
        # keeps this a pure format conversion with no resampling.
        "11": {
            "class_type": "MiniMaxH3LatentUpscaleBy",
            "inputs": {"samples": ["10", 0], "upscale_method": "bicubic", "scale_by": 1.0},
        },
        "50": {"class_type": "VAEDecode", "inputs": {"samples": ["44", 0], "vae": ["4", 0]}},
        "51": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["44", 0], "vae": ["5", 0]}},
        "60": {
            "class_type": "CreateVideo",
            "inputs": {"images": ["50", 0], "fps": 24.0, "audio": ["51", 0]},
        },
        "61": {
            "class_type": "SaveVideo",
            "inputs": {
                "video": ["60", 0],
                "filename_prefix": f"H3_Upscale_Video_{tag}",
                "format": "mp4",
                "codec": "h264",
            },
        },
        "62": {
            "class_type": "MiniMaxH3MotionContextSaveLatent",
            "inputs": {
                "latent": ["44", 0],
                "filename_prefix": f"H3_Upscale_Latent_{tag}",
                "clip_index": 0,
            },
        },
    }
    if trim_head_frames > 0:
        # Same node the generator trims its context window with; the saved
        # upscale latent (node 62) keeps the full span.
        wf["52"] = {
            "class_type": "MiniMaxH3MotionContextTrim",
            "inputs": {
                "images": ["50", 0],
                "audio": ["51", 0],
                "trim_frames": int(trim_head_frames),
                "audio_fps": 24,
                "trim_audio": True,
            },
        }
        wf["60"]["inputs"]["images"] = ["52", 0]
        wf["60"]["inputs"]["audio"] = ["52", 1]

    wf["1"] = {"class_type": "UNETLoader", "inputs": {"unet_name": unet_name, "weight_dtype": "default"}}
    wf["3"] = {
        "class_type": "CLIPLoader",
        "inputs": {"clip_name": text_encoder or h3_text_encoder(), "type": "minimax", "device": "default"},
    }

    model_src = ["1", 0]
    if lora_name:
        wf["2"] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": model_src,
                "lora_name": _normalize_lora_name(lora_name),
                "strength_model": float(lora_strength),
            },
        }
        model_src = ["2", 0]
    model_src, curr_patch_id = _apply_h3_accel(wf, model_src, accel_for_unet(unet_name, sage), 20)
    wf[str(curr_patch_id)] = {
        "class_type": "MiniMaxH3SigmaShift",
        "inputs": {
            "model": model_src,
            "shift_video": float(REFINE_SHIFT_VIDEO),
            "shift_audio": float(REFINE_SHIFT_AUDIO),
        },
    }
    model_src = [str(curr_patch_id), 0]

    # Conditioning re-encoded at the UPSCALED size: the node pack requires the
    # upscale target and the conditioning's generation size to agree, and the
    # official i2v template runs a second encode for exactly this reason. The
    # references come along because the approved output was produced with them.
    r2v_inputs = {
        "clip": ["3", 0],
        "vae": ["4", 0],
        "audio_vae": ["5", 0],
        "prompt": prompt or (REFINE_PROMPT if references else REFINE_PROMPT_NO_REF),
        "width": _up_w,
        "height": _up_h,
        "length": int(length),
        # 'max' rather than 'match': the references are being read for texture at a
        # size larger than the one they were generated against.
        "ref_image_size": "max",
    }
    for i, fname in enumerate(references):
        wf[f"40{i}"] = {"class_type": "LoadImage", "inputs": {"image": fname}}
        r2v_inputs[f"ref_images.ref_image_{i}"] = [f"40{i}", 0]
    wf["30"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": r2v_inputs}

    # An I2V shot carries no references at all: it was generated from a first
    # frame alone, so the refine pass would re-encode with no image anchoring
    # whatsoever — while REFINE_PROMPT names a <Picture 1> that is not mounted.
    # The pack's own example always mounts the same images the generation used;
    # for this shot shape that means the guide frames, mounted the same way the
    # generator mounts them.
    cond_out = ["30", 0]
    for fname, frame_idx, load_nid, guide_nid in (
        (first_frame_filename, 0, "70", "71"),
        (last_frame_filename, -1, "72", "73"),
    ):
        if not fname:
            continue
        if fname.lower().endswith((".mp4", ".mov", ".webm", ".mkv")):
            # A clip guide: the previous chain's upscaled frames over this latent's
            # context window. One frame pins only frame 0 and the rest of the overlap
            # re-invents its detail, which showed as a luma dip right after the join
            # (chain 3 -> 4, 2026-09-16). AddGuide crops a batch to 17k+5 frames.
            wf[load_nid + "v"] = {"class_type": "LoadVideo", "inputs": {"file": fname}}
            wf[load_nid] = {"class_type": "GetVideoComponents",
                            "inputs": {"video": [load_nid + "v", 0]}}
        else:
            wf[load_nid] = {"class_type": "LoadImage", "inputs": {"image": fname}}
        wf[guide_nid] = {
            "class_type": "MiniMaxH3AddGuide",
            "inputs": {
                "positive": cond_out,
                "latent": ["30", 1],
                "frame_idx": frame_idx,
                "vae": ["4", 0],
                "image": [load_nid, 0],
            },
        }
        cond_out = [guide_nid, 0]

    wf["501"] = {
        "class_type": "MMH3LatentUpscaleWithModelParams",
        "inputs": {
            "model_name": upscale_model or env_value("H3_LATENT_UPSCALER") or "minimax_h3_latent_upscaler_3d_bf16.safetensors",
            "width": _up_w,
            "height": _up_h,
            "device": "cuda",
            "precision": upscale_precision,
        },
    }
    if chunk_frames:
        wf["502"] = {
            "class_type": "MMH3TemporalSplitParams",
            "inputs": {
                "chunk_length": int(chunk_frames),
                "temporal_overlap": int(chunk_overlap),
                "anchor_strength": float(anchor_strength),
            },
        }
    wf["504"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": sampler_name}}
    wf["505"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": str(manual_sigmas)}}
    wf["506"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}}
    wf["44"] = {
        "class_type": "MMH3UltimateUpscale",
        "inputs": {
            "model": model_src,
            "conditioning": cond_out,
            "latent": ["11", 0],
            "noise": ["506", 0],
            "sampler": ["504", 0],
            "sigmas": ["505", 0],
            "cfg": 1.0,
            "latent_upscale_param": ["501", 0],
        },
    }
    if chunk_frames:
        wf["44"]["inputs"]["temporal_split_param"] = ["502", 0]
    if spatial_tile:
        wf["503"] = {
            "class_type": "MMH3SpatialSplitParams",
            "inputs": {
                "upscale_width": _up_w,
                "upscale_height": _up_h,
                "tile_size_mode": "specific_size",
                "tile_width": int(spatial_tile),
                "tile_height": int(spatial_tile),
                "grid_rows": 2,
                "grid_cols": 2,
                "spatial_w_overlap": int(spatial_overlap),
                "spatial_h_overlap": int(spatial_overlap),
                "fade_width": 64,
                "fade_height": 64,
                "min_tile_size": 256,
                "overlap_mode": "later",
                "overlap_blend": "linear",
                "masked_area_noise": 0.0,
                "brightness_match": False,
                "dynamic_fade": "off",
                "dynamic_fade_min": 32,
            },
        }
        wf["44"]["inputs"]["spatial_split_param"] = ["503", 0]

    if source_video:
        _swap_latent_source_for_video(
            wf, source_video, int(length), int(source_latent_w) * 16, int(source_latent_h) * 16)
    return wf


# ── Wan2.2 I2V ─────────────────────────────────────────────────────────────────


def _swap_latent_source_for_video(wf: dict, source_video: str, frames: int,
                                  width: int, height: int) -> None:
    """Replace node 10 (the saved latent) with the same clip encoded from a video.

    MiniMaxH3ExistingVideoMaskedContext is what a chain uses to carry a plain
    video in; with context_length = the whole clip it encodes every frame and its
    sound (probe 2026-09-29: C10's 180-frame trim padded to 192, refined to
    2752x1536 with all 192 frames in place, 35-37 dB against a plain resize).
    It snaps that length to the 51k+39 AV grid, so the caller pads the file to
    exactly such a count. Its preserve mask would stop the refine from changing
    anything, so it is cleared.
    """
    del wf["10"]
    wf["900"] = {"class_type": "VHS_LoadVideoPath", "inputs": {
        "video": source_video, "force_rate": 24, "custom_width": 0, "custom_height": 0,
        "frame_load_cap": 0, "skip_first_frames": 0, "select_every_nth": 1}}
    wf["901"] = {"class_type": "EmptyMiniMaxH3LatentAV", "inputs": {
        "width": width, "height": height, "length": frames}}
    wf["902"] = {"class_type": "MiniMaxH3ExistingVideoMaskedContext", "inputs": {
        "latent": ["901", 0], "vae": ["4", 0], "audio_vae": ["5", 0],
        "source_frames": ["900", 0], "source_audio": ["900", 2], "source_fps": 24.0,
        "context_length": frames, "crop": "disabled", "audio_feather_ticks": 0}}
    wf["903"] = {"class_type": "MiniMaxH3ClearAVNoiseMask", "inputs": {"latent": ["902", 0]}}
    for node in wf.values():
        for key, value in list(node.get("inputs", {}).items()):
            if value == ["10", 0]:
                node["inputs"][key] = ["903", 0]

def _patch_sage(wf: dict, node_id: str, model_src: list, sage_attention: str) -> list:
    """
    Route a model through KJNodes' SageAttention patch, if one is requested.

    Applied as a node rather than ComfyUI's `--use-sage-attention` launch flag: that flag
    produces black output on Wan and Qwen models. `sageattn_qk_int8_pv_fp16_cuda` is the
    backend reported to work with them.
    """
    if not sage_attention or sage_attention == "disabled":
        return model_src
    wf[node_id] = {"class_type": "PathchSageAttentionKJ", "inputs": {
        "model": model_src, "sage_attention": sage_attention,
    }}
    return [node_id, 0]


# ── RIFE frame interpolation ───────────────────────────────────────────────────

def build_rife_interpolate_workflow(
    video_filename: str,
    rife_multiplier: int,
    fps: float,
) -> dict:
    return {
        "rife:1": {"class_type": "LoadVideo", "inputs": {"file": video_filename}},
        "rife:2": {"class_type": "GetVideoComponents", "inputs": {"video": ["rife:1", 0]}},
        "rife:3": {"class_type": "RIFE VFI", "inputs": {
            "frames": ["rife:2", 0],
            "ckpt_name": "rife47.pth",
            "clear_cache_after_n_frames": 10,
            "multiplier": rife_multiplier,
            "fast_mode": True,
            "ensemble": True,
            "scale_factor": 1,
        }},
        "rife:4": {"class_type": "CreateVideo", "inputs": {
            "fps": fps * rife_multiplier,
            "images": ["rife:3", 0],
        }},
        "rife:5": {"class_type": "SaveVideo", "inputs": {
            "filename_prefix": "cinema_rife",
            "format": "mp4",
            "codec": "h264",
            "video": ["rife:4", 0]
        }}
    }


def build_video_depth_workflow(
    video_filename: str,
    fps: float,
    resolution: int = 518,
    ckpt_name: str = "depth_anything_v2_vitl.pth",
) -> dict:
    """Per-frame depth of a clip, as a silent video at the clip's own size and rate.

    For a camera-movement reference: H3 lifts faces, costumes and look from a
    photographic reference video, but a depth pass carries only the geometry and
    how the camera moves through it.
    """
    return {
        "vd:1": {"class_type": "LoadVideo", "inputs": {"file": video_filename}},
        "vd:2": {"class_type": "GetVideoComponents", "inputs": {"video": ["vd:1", 0]}},
        "vd:3": {"class_type": "DepthAnythingV2Preprocessor",
                 "inputs": {"image": ["vd:2", 0], "ckpt_name": ckpt_name, "resolution": resolution}},
        "vd:4": {"class_type": "GetImageSize", "inputs": {"image": ["vd:2", 0]}},
        "vd:5": {"class_type": "ImageScale", "inputs": {
            "image": ["vd:3", 0], "upscale_method": "lanczos",
            "width": ["vd:4", 0], "height": ["vd:4", 1], "crop": "disabled",
        }},
        "vd:6": {"class_type": "CreateVideo", "inputs": {"images": ["vd:5", 0], "fps": float(fps)}},
        "vd:7": {"class_type": "SaveVideo", "inputs": {
            "video": ["vd:6", 0], "filename_prefix": "cinema_depth_video",
            "format": "mp4", "codec": "h264",
        }},
    }


# ── Gaussian Splatting model (SHARP) ──────────────────────────────────────────

def build_gaussian_model_workflow(image_filename: str) -> dict:
    return {
        "1": {
            "class_type": "LoadSharpModel",
            "inputs": {
                "precision": "auto",
                "checkpoint_path": ""
            }
        },
        "2": {
            "class_type": "SharpPredict",
            "inputs": {
                "focal_length_mm": 0,
                "output_prefix": "sharp",
                "model": ["1", 0],
                "image": ["3", 0]
            }
        },
        "3": {
            "class_type": "ImageScaleToTotalPixels",
            "inputs": {
                "upscale_method": "lanczos",
                "megapixels": 1,
                "resolution_steps": 1,
                "image": ["4", 0]
            }
        },
        "4": {
            "class_type": "LoadImage",
            "inputs": {
                "image": image_filename
            }
        }
    }


# ── 3D pose extraction (NLF / SCAIL) ──────────────────────────────────────────

def build_pose_workflow(image_filename: str) -> dict:
    return {
        "1": {
            "class_type": "LoadImage",
            "inputs": {
                "image": image_filename
            }
        },
        "3": {
            "class_type": "DownloadAndLoadNLFModel",
            "inputs": {
                "url": "https://github.com/isarandi/nlf/releases/download/v0.3.2/nlf_l_multi_0.3.2.torchscript",
                "warmup": True
            }
        },
        "4": {
            "class_type": "NLFPredict",
            "inputs": {
                "per_batch": -1,
                "model": ["3", 0],
                "images": ["1", 0]
            }
        },
        "5": {
            "class_type": "SaveNLFPosesAs3D",
            "inputs": {
                "nlf_poses": ["4", 0],
                "filename_prefix": "nlf_pose_3d",
                "fps": 24.0,
                "cylinder_radius": 21.5
            }
        }
    }


def build_openpose_extract_workflow(image_filename: str, render_size: int = 768) -> dict:
    """
    Full-body OpenPose extraction (body + hands + face) using SCAIL VitPose pipeline.
    Uses NLF for body skeleton + vitpose-l-wholebody for hands and face.
    """
    return {
        # ── Load image ────────────────────────────────────────────────────
        "op:1": {
            "class_type": "LoadImage",
            "inputs": {"image": image_filename},
        },
        # ── NLF body skeleton ─────────────────────────────────────────────
        "op:2": {
            "class_type": "DownloadAndLoadNLFModel",
            "inputs": {
                "url": "https://github.com/isarandi/nlf/releases/download/v0.3.2/nlf_l_multi_0.3.2.torchscript",
                "warmup": True,
            },
        },
        "op:3": {
            "class_type": "NLFPredict",
            "inputs": {
                "per_batch": -1,
                "model": ["op:2", 0],
                "images": ["op:1", 0],
            },
        },
        # ── VitPose wholebody — hands + face ──────────────────────────────
        "op:4": {
            "class_type": "OnnxDetectionModelLoader",
            "inputs": {
                "vitpose_model": "vitpose-l-wholebody.onnx",
                "yolo_model": "yolov10m.onnx",
                "onnx_device": "CUDAExecutionProvider",
            },
        },
        "op:5": {
            "class_type": "PoseDetectionVitPoseToDWPose",
            "inputs": {
                "vitpose_model": ["op:4", 0],
                "images": ["op:1", 0],
            },
        },
        # ── Canvas size constants ─────────────────────────────────────────
        "op:6": {
            "class_type": "INTConstant",
            "inputs": {"value": render_size},
        },
        "op:7": {
            "class_type": "INTConstant",
            "inputs": {"value": render_size},
        },
        # ── Render: body (NLF) + hands + face (VitPose) ───────────────────
        "op:8": {
            "class_type": "RenderNLFPoses",
            "inputs": {
                "width": ["op:6", 0],
                "height": ["op:7", 0],
                "draw_face": True,
                "draw_hands": True,
                "render_device": "gpu",
                "scale_hands": True,
                "render_backend": "taichi",
                "nlf_poses": ["op:3", 0],
                "dw_poses": ["op:5", 0],
                "ref_dw_pose": ["op:5", 0],
            },
        },
        "op:9": {
            "class_type": "SaveImage",
            "inputs": {
                "images": ["op:8", 0],
                "filename_prefix": "openpose_full",
            },
        },
    }


# ── Audio: ACE-Step music / Stable Audio Open ambience ─────────────────────────

def build_ace_step_music_workflow(
    tags: str,
    lyrics: str,
    seconds: float,
    steps: int,
    cfg: float,
    seed: int,
    lyrics_strength: float = 0.99,
) -> dict:
    """
    Text-to-music with ACE-Step v1 3.5B. Returns a stereo 44.1kHz track.

    Topology mirrors ComfyUI's audio_ace_step_1_t2a_instrumentals template, including the
    tonemap-Reinhard CFG operation — without it the decoded audio clips on loud passages.
    `tags` carries genre/instrument/mood; `lyrics` carries structure tags such as
    "[instrumental]\n[intro]\n[build]" for an instrumental cue.
    """
    return {
        "as:1": {"class_type": "CheckpointLoaderSimple",
                 "inputs": {"ckpt_name": "ace_step_v1_3.5b.safetensors"}},
        "as:2": {"class_type": "TextEncodeAceStepAudio", "inputs": {
            "clip": ["as:1", 1], "tags": tags, "lyrics": lyrics,
            "lyrics_strength": lyrics_strength}},
        "as:3": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["as:2", 0]}},
        "as:4": {"class_type": "ModelSamplingSD3", "inputs": {"shift": 5.0, "model": ["as:1", 0]}},
        "as:5": {"class_type": "LatentOperationTonemapReinhard", "inputs": {"multiplier": 1.0}},
        "as:6": {"class_type": "LatentApplyOperationCFG", "inputs": {
            "model": ["as:4", 0], "operation": ["as:5", 0]}},
        "as:7": {"class_type": "EmptyAceStepLatentAudio", "inputs": {
            "seconds": seconds, "batch_size": 1}},
        "as:8": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": steps, "cfg": cfg,
            "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
            "model": ["as:6", 0], "positive": ["as:2", 0],
            "negative": ["as:3", 0], "latent_image": ["as:7", 0]}},
        "as:9": {"class_type": "VAEDecodeAudio", "inputs": {
            "samples": ["as:8", 0], "vae": ["as:1", 2]}},
        # SaveAudio writes FLAC — lossless, so downstream mixing doesn't stack codec loss.
        "as:10": {"class_type": "SaveAudio", "inputs": {
            "audio": ["as:9", 0], "filename_prefix": "cinema_score"}},
    }


def build_stable_audio_workflow(
    prompt: str,
    seconds: float,
    steps: int,
    cfg: float,
    seed: int,
    negative_prompt: str = "",
) -> dict:
    """
    Text-to-audio with Stable Audio Open 1.0 — ambience beds and sound effects.

    Caps out around 47 seconds per generation, so long beds must be produced in
    segments. Sampler/scheduler follow ComfyUI's audio_stable_audio_example template.
    """
    return {
        "sa:1": {"class_type": "CheckpointLoaderSimple",
                 "inputs": {"ckpt_name": "stable-audio-open-1.0.safetensors"}},
        "sa:2": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": "t5-base.safetensors", "type": "stable_audio", "device": "default"}},
        "sa:3": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["sa:2", 0]}},
        "sa:4": {"class_type": "CLIPTextEncode", "inputs": {
            "text": negative_prompt, "clip": ["sa:2", 0]}},
        "sa:5": {"class_type": "EmptyLatentAudio", "inputs": {
            "seconds": seconds, "batch_size": 1}},
        "sa:6": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": steps, "cfg": cfg,
            "sampler_name": "dpmpp_3m_sde_gpu", "scheduler": "exponential", "denoise": 1.0,
            "model": ["sa:1", 0], "positive": ["sa:3", 0],
            "negative": ["sa:4", 0], "latent_image": ["sa:5", 0]}},
        "sa:7": {"class_type": "VAEDecodeAudio", "inputs": {
            "samples": ["sa:6", 0], "vae": ["sa:1", 2]}},
        "sa:8": {"class_type": "SaveAudio", "inputs": {
            "audio": ["sa:7", 0], "filename_prefix": "cinema_ambience"}},
    }


# ── Video upscale: RealESRGAN (deterministic) ──────────────────────────────────

def build_esrgan_upscale_workflow(
    video_filename: str,
    model_name: str = "RealESRGAN_x2.pth",
    target_width: int = 0,
    target_height: int = 0,
) -> dict:
    """
    Deterministic ESRGAN upscale of a whole clip.

    Chosen over SeedVR2 when the goal is resolution rather than invented detail. Being
    deterministic, identical input patches always map to identical output, so it cannot
    hallucinate different texture on each frame — measured on this project's footage it was
    the most temporally stable option of all, below even a plain lanczos resample
    (flicker 6.16 vs 6.25), while SeedVR2 sat at 8.93. It is also ~4x faster and needs no
    batching, so there are no batch-seam artefacts.

    `target_width`/`target_height` optionally resample the model's fixed factor (x2) down to
    a delivery size; leave at 0 to keep the native upscale.
    """
    wf: dict = {
        "eu:1": {"class_type": "LoadVideo", "inputs": {"file": video_filename}},
        "eu:2": {"class_type": "GetVideoComponents", "inputs": {"video": ["eu:1", 0]}},
        "eu:3": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": model_name}},
        "eu:4": {"class_type": "ImageUpscaleWithModel", "inputs": {
            "upscale_model": ["eu:3", 0], "image": ["eu:2", 0]}},
    }
    images = ["eu:4", 0]
    if target_width > 0 and target_height > 0:
        wf["eu:5"] = {"class_type": "ImageScale", "inputs": {
            "upscale_method": "lanczos", "width": target_width, "height": target_height,
            "crop": "disabled", "image": ["eu:4", 0]}}
        images = ["eu:5", 0]

    wf["eu:6"] = {"class_type": "CreateVideo", "inputs": {"fps": ["eu:2", 2], "images": images}}
    wf["eu:7"] = {"class_type": "SaveVideo", "inputs": {
        "filename_prefix": "cinema_esrgan", "format": "mp4", "codec": "h264",
        "video": ["eu:6", 0]}}
    return wf


def build_image_description_workflow(image_filename: str, ask: str, max_length: int = 220) -> dict:
    """A vision model's text about one picture, from the text encoder Qwen-Image 2.1 loads anyway
    (QWEN_IMAGE_21_CLIP, a Qwen3-VL) through ComfyUI's TextGenerate. Greedy decoding, so the same
    picture and question give the same words. Measured 2026-10-04: about 5 s, and no model beyond
    the one the Qwen edit needs (+160 MiB once it is loaded)."""
    return {
        "td:1": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": QWEN_IMAGE_21_CLIP, "type": "qwen_image", "device": "default"}},
        "td:2": {"class_type": "LoadImage", "inputs": {"image": image_filename}},
        "td:3": {"class_type": "TextGenerate",
                 "inputs": {"clip": ["td:1", 0], "prompt": ask, "image": ["td:2", 0],
                            "max_length": max_length, "sampling_mode": "off", "thinking": False}},
        "td:4": {"class_type": "PreviewAny", "inputs": {"source": ["td:3", 0]}},
    }


def build_text_generation_workflow(prompt: str, max_length: int = 1024) -> dict:
    """Text from the same Qwen3-VL text encoder with no picture (subtitle translation). Greedy, so a
    line translates the same way each time."""
    return {
        "td:1": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": QWEN_IMAGE_21_CLIP, "type": "qwen_image", "device": "default"}},
        "td:3": {"class_type": "TextGenerate",
                 "inputs": {"clip": ["td:1", 0], "prompt": prompt,
                            "max_length": max_length, "sampling_mode": "off", "thinking": False}},
        "td:4": {"class_type": "PreviewAny", "inputs": {"source": ["td:3", 0]}},
    }


def build_esrgan_image_workflow(
    image_filename: str,
    model_name: str = "RealESRGAN_x2.pth",
    target_width: int = 0,
    target_height: int = 0,
) -> dict:
    """
    Deterministic ESRGAN upscale of one still (the video builder's single-frame twin).

    `target_width`/`target_height` resample the model's fixed factor to a delivery size;
    0 keeps the native upscale. The model never invents a different picture, so the
    result is the same frame, sharper -- unlike a diffusion pass.
    """
    wf: dict = {
        "ei:1": {"class_type": "LoadImage", "inputs": {"image": image_filename, "upload": "image"}},
        "ei:2": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": model_name}},
        "ei:3": {"class_type": "ImageUpscaleWithModel", "inputs": {
            "upscale_model": ["ei:2", 0], "image": ["ei:1", 0]}},
    }
    images = ["ei:3", 0]
    if target_width > 0 and target_height > 0:
        wf["ei:4"] = {"class_type": "ImageScale", "inputs": {
            "upscale_method": "lanczos", "width": target_width, "height": target_height,
            "crop": "disabled", "image": ["ei:3", 0]}}
        images = ["ei:4", 0]
    wf["ei:9"] = {"class_type": "SaveImage", "inputs": {
        "images": images, "filename_prefix": "cinema_upscale"}}
    return wf


# ── Wan2.2 First/Last-Frame to Video ──────────────────────────────────────────

# ── Geometry passes ────────────────────────────────────────────────────────────
# Two ways to get a depth map for ControlNet. Estimating one from a finished still
# locks a shot's own geometry (useful for relighting or restyling the same frame).
# Rendering one from a reconstructed splat locks a *location's* geometry across
# shots, because every camera samples the same 3D scene rather than a description
# of it — the only way two shots of one room agree on where the walls are.

def build_depth_estimate_workflow(
    image_filename: str,
    resolution: int = 1024,
    ckpt_name: str = "depth_anything_v2_vitl.pth",
) -> dict:
    """Estimate a depth map, resized back to the source dimensions.

    The preprocessor works at its own resolution, so the result is scaled back to
    match the input exactly — a depth pass that does not register with the frame
    it came from constrains the wrong pixels.
    """
    return {
        "de:1": {
            "class_type": "LoadImage",
            "inputs": {"image": image_filename, "upload": "image"},
        },
        "de:2": {
            "class_type": "DepthAnythingV2Preprocessor",
            "inputs": {"image": ["de:1", 0], "ckpt_name": ckpt_name, "resolution": resolution},
        },
        "de:3": {
            "class_type": "GetImageSize",
            "inputs": {"image": ["de:1", 0]},
        },
        "de:4": {
            # Core node: ImageResize+ (ComfyUI_essentials) is not installed everywhere.
            "class_type": "ImageScale",
            "inputs": {
                "image": ["de:2", 0],
                "upscale_method": "lanczos",
                "width": ["de:3", 0],
                "height": ["de:3", 1],
                "crop": "disabled",
            },
        },
        "de:5": {
            "class_type": "SaveImage",
            "inputs": {"images": ["de:4", 0], "filename_prefix": "cinema_depth"},
        },
    }


def build_splat_render_workflow(
    ply_filename: str,
    width: int = 1280,
    height: int = 720,
    render_style: str = "depth",
    mode: str = "orbit",
    # orbit mode
    yaw: float = 35.0,
    pitch: float = 15.0,
    distance: float = 4.0,
    # look_at / quaternion modes
    position_x: float = 4.0,
    position_y: float = 4.0,
    position_z: float = 4.0,
    quat_x: float = 0.0,
    quat_y: float = 0.0,
    quat_z: float = 0.0,
    quat_w: float = 1.0,
    # shared
    target_x: float = 0.0,
    target_y: float = 0.0,
    target_z: float = 0.0,
    roll: float = 0.0,
    fov: float = 35.0,
    zoom: float = 1.0,
    camera_type: str = "perspective",
    frames: int = 1,
    splat_scale: float = 1.0,
    sharpen: float = 2.0,
    opacity_threshold: float = 0.0,
    background: str = "#000000",
) -> dict:
    """Render one pass (depth / normal / clay / color) of a splat from a given camera.

    `fov` and the camera parameters are the shot's actual lens and position, which
    is the point: two shots of the same location differ by camera, not by prompt,
    so their geometry cannot disagree.

    CreateCameraInfo is a V3 dynamic combo — the parameters belonging to the chosen
    mode are namespaced under it (`mode.yaw`, not `yaw`), and passing them flat
    fails validation with "required input missing".

    `frames` > 1 makes RenderSplat orbit a full turn, which is how a sequence for
    Uni3C is produced.
    """
    render_inputs = {
        "splat": ["rs:1", 0],
        "width": width,
        "height": height,
        "frames": frames,
        "splat_scale": splat_scale,
        "sharpen": sharpen,
        "headlight_shading": 0.0,
        "opacity_threshold": opacity_threshold,
        "render_style": render_style,
        "background": background,
    }

    # "auto" leaves camera_info unconnected, which makes RenderSplat frame the
    # splat itself from a default 3/4 view. Useful for calibration: a
    # reconstruction lands in its own normalised space, so the first job is to
    # see where the geometry actually is before aiming a camera at it.
    if mode == "auto":
        wf = {
            "rs:0": {
                "class_type": "Load3DAdvanced",
                "inputs": {
                    "model_file": ply_filename,
                    "viewport_state": {},
                    "width": width,
                    "height": height,
                },
            },
            "rs:1": {"class_type": "File3DToSplat", "inputs": {"model_3d": ["rs:0", 0]}},
            "rs:3": {"class_type": "RenderSplat", "inputs": render_inputs},
            "rs:4": {
                "class_type": "SaveImage",
                "inputs": {"images": ["rs:3", 0], "filename_prefix": f"cinema_{render_style}"},
            },
        }
        return wf

    camera_inputs = {
        "mode": mode,
        "target_x": target_x,
        "target_y": target_y,
        "target_z": target_z,
        "roll": roll,
        "fov": fov,
        "zoom": zoom,
        "camera_type": camera_type,
    }
    if mode == "orbit":
        camera_inputs.update({
            "mode.yaw": yaw, "mode.pitch": pitch, "mode.distance": distance,
        })
    elif mode == "look_at":
        camera_inputs.update({
            "mode.position_x": position_x,
            "mode.position_y": position_y,
            "mode.position_z": position_z,
        })
    elif mode == "quaternion":
        camera_inputs.update({
            "mode.position_x": position_x,
            "mode.position_y": position_y,
            "mode.position_z": position_z,
            "mode.quat_x": quat_x, "mode.quat_y": quat_y,
            "mode.quat_z": quat_z, "mode.quat_w": quat_w,
        })
    else:
        raise ValueError(f"Unknown camera mode: {mode}")

    return {
        # File3DToSplat wants a File3D resource, not a path, and Load3DAdvanced is
        # the only node that produces one from disk. Its combo lists mesh formats
        # only (.ply is absent), but its custom validate_inputs checks just that the
        # file exists, so a .ply reference passes. viewport_state is a UI widget and
        # is explicitly tolerated as an empty dict.
        "rs:0": {
            "class_type": "Load3DAdvanced",
            "inputs": {
                "model_file": ply_filename,
                "viewport_state": {},
                "width": width,
                "height": height,
            },
        },
        "rs:1": {
            "class_type": "File3DToSplat",
            "inputs": {"model_3d": ["rs:0", 0]},
        },
        "rs:2": {
            "class_type": "CreateCameraInfo",
            "inputs": camera_inputs,
        },
        "rs:3": {
            "class_type": "RenderSplat",
            "inputs": {**render_inputs, "camera_info": ["rs:2", 0]},
        },
        "rs:4": {
            "class_type": "SaveImage",
            "inputs": {"images": ["rs:3", 0], "filename_prefix": f"cinema_{render_style}"},
        },
    }


# ── Uni3C camera-guided video ──────────────────────────────────────────────────

# ── Novel-view repair (Qwen-Image-Edit + Gaussian LoRA) ────────────────────────

def build_gaussian_view_repair_workflow(
    broken_view_filename: str,
    reference_filename: str,
    prompt: str = "高斯泼溅,参考图2的场景图，修复图1的场景图透视并修复空白区域",
    steps: int = 10,
    cfg: float = 1.0,
    seed: int = -1,
    denoise: float = 1.0,
) -> dict:
    """Repair a splat render taken from a camera the reconstruction cannot cover.

    A single-image reconstruction is a 2.5D shell: move far enough off the source
    camera and the render tears open where nothing was ever observed. Rather than
    model the missing geometry, this regenerates the *view* — image1 is the torn
    render, image2 the original plate, and the Gaussian LoRA is trained to fix
    exactly this failure. Feeding the repaired views back into SharpPredict is what
    turns one still into a location that survives a real camera move.

    Ported from the hand-built ComfyUI graph, standard-node branch.
    """
    return {
        "gr:1": {"class_type": "LoadImage",
                 "inputs": {"image": broken_view_filename, "upload": "image"}},
        "gr:2": {"class_type": "ImageScaleToTotalPixels",
                 "inputs": {"upscale_method": "lanczos", "megapixels": 1,
                            "resolution_steps": 1, "image": ["gr:1", 0]}},
        "gr:3": {"class_type": "LoadImage",
                 "inputs": {"image": reference_filename, "upload": "image"}},
        "gr:4": {"class_type": "ImageScaleToTotalPixels",
                 "inputs": {"upscale_method": "lanczos", "megapixels": 1,
                            "resolution_steps": 1, "image": ["gr:3", 0]}},

        "gr:5": {"class_type": "UNETLoader",
                 "inputs": {"unet_name": "qwen_image_edit_2511_fp8_e4m3fn.safetensors",
                            "weight_dtype": "default"}},
        "gr:6": {"class_type": "LoraLoaderModelOnly",
                 "inputs": {"lora_name": "Gaussian.safetensors",
                            "strength_model": 1.0, "model": ["gr:5", 0]}},
        "gr:7": {"class_type": "LoraLoaderModelOnly",
                 "inputs": {"lora_name": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
                            "strength_model": 1.0, "model": ["gr:6", 0]}},
        "gr:8": {"class_type": "ModelSamplingAuraFlow",
                 "inputs": {"shift": 3.0, "model": ["gr:7", 0]}},
        "gr:9": {"class_type": "CFGNorm",
                 "inputs": {"strength": 1.0, "model": ["gr:8", 0]}},

        "gr:10": {"class_type": "CLIPLoader",
                  "inputs": {"clip_name": "qwen_2.5_vl_7b.safetensors",
                             "type": "qwen_image", "device": "default"}},
        "gr:11": {"class_type": "VAELoader",
                  "inputs": {"vae_name": "qwen_image_vae.safetensors"}},

        # image1 is the torn render, image2 the plate — the prompt refers to them
        # by that number, so the order is load-bearing.
        "gr:12": {"class_type": "TextEncodeQwenImageEditPlus",
                  "inputs": {"prompt": prompt, "clip": ["gr:10", 0], "vae": ["gr:11", 0],
                             "image1": ["gr:2", 0], "image2": ["gr:4", 0]}},
        "gr:13": {"class_type": "FluxKontextMultiReferenceLatentMethod",
                  "inputs": {"reference_latents_method": "index_timestep_zero",
                             "conditioning": ["gr:12", 0]}},
        "gr:14": {"class_type": "TextEncodeQwenImageEditPlus",
                  "inputs": {"prompt": "", "clip": ["gr:10", 0], "vae": ["gr:11", 0],
                             "image1": ["gr:2", 0], "image2": ["gr:4", 0]}},
        "gr:15": {"class_type": "FluxKontextMultiReferenceLatentMethod",
                  "inputs": {"reference_latents_method": "index_timestep_zero",
                             "conditioning": ["gr:14", 0]}},

        "gr:16": {"class_type": "VAEEncode",
                  "inputs": {"pixels": ["gr:2", 0], "vae": ["gr:11", 0]}},
        "gr:17": {"class_type": "KSampler",
                  "inputs": {"seed": seed, "steps": steps, "cfg": cfg,
                             "sampler_name": "euler", "scheduler": "simple",
                             "denoise": denoise, "model": ["gr:9", 0],
                             "positive": ["gr:13", 0], "negative": ["gr:15", 0],
                             "latent_image": ["gr:16", 0]}},
        "gr:18": {"class_type": "VAEDecode",
                  "inputs": {"samples": ["gr:17", 0], "vae": ["gr:11", 0]}},
        "gr:19": {"class_type": "SaveImage",
                  "inputs": {"images": ["gr:18", 0], "filename_prefix": "cinema_view_repair"}},
    }


# ── Multi-view splat merge ─────────────────────────────────────────────────────

def build_multiview_merge_workflow(
    views: list[dict],
    filename_prefix: str = "merged_scene",
    width: int = 1024,
    height: int = 1024,
) -> dict:
    """Fuse per-view reconstructions into one splat in a shared world frame.

    Every SharpPredict run returns its subject in *its own* camera frame — source
    camera at the origin looking down -Z. Merging them as-is piles every view on
    top of the first instead of extending it, so each one is first pushed back to
    where its camera actually stood. For the translation-only moves a dolly or
    truck produces, that is just the camera position; add `rotate` when the move
    included a pan.

    `views` items: {"ply_filename": "3d/x.ply", "translate": (x, y, z),
                    "rotate": (rx, ry, rz)}.
    """
    if len(views) < 2:
        raise ValueError("MergeSplat needs at least two views")

    wf: dict = {}
    merge_inputs: dict = {}
    for i, view in enumerate(views):
        base = f"mv{i}"
        tx, ty, tz = view.get("translate", (0.0, 0.0, 0.0))
        rx, ry, rz = view.get("rotate", (0.0, 0.0, 0.0))
        wf[f"{base}:load"] = {
            "class_type": "Load3DAdvanced",
            "inputs": {"model_file": view["ply_filename"], "viewport_state": {},
                       "width": width, "height": height},
        }
        wf[f"{base}:splat"] = {
            "class_type": "File3DToSplat",
            "inputs": {"model_3d": [f"{base}:load", 0]},
        }
        wf[f"{base}:xf"] = {
            "class_type": "TransformSplat",
            "inputs": {
                "splat": [f"{base}:splat", 0],
                "translate_x": tx, "translate_y": ty, "translate_z": tz,
                "rotate_x": rx, "rotate_y": ry, "rotate_z": rz,
                "scale_x": 1.0, "scale_y": 1.0, "scale_z": 1.0,
            },
        }
        # Autogrow slots are namespaced under the socket name and 0-indexed:
        # comfy_api builds them as finalize_prefix(["splats"], f"splat{i}"), and
        # min=2 makes splats.splat0/splat1 required. Flat "splat0" fails
        # validation even when present.
        #
        # KNOWN ISSUE, and it is not in this function. Reading the merged .ply back
        # shows the merge is exactly right: 2x the vertex count, the untranslated
        # view centred on the origin (x median -0.01), the translated one at its
        # offset (x median 4.99 for a +5 translate), unit quaternions and valid
        # colours in both halves, no NaN.
        #
        # What fails is rendering it. RenderSplat shows only the translated view:
        # from a camera at the origin the untranslated half is dead ahead and the
        # translated half is ~51 degrees off axis, outside a 45 degree fov, yet the
        # render contains the far one and not the near one. Adding distant points
        # makes previously visible near points disappear. Canvas size does not help,
        # so this is not the same window cap that breaks narrow-fov renders.
        # Unresolved — the merged file is probably fine for other consumers, but do
        # not trust RenderSplat output from it.
        merge_inputs[f"splats.splat{i}"] = [f"{base}:xf", 0]

    wf["mv:merge"] = {"class_type": "MergeSplat", "inputs": merge_inputs}
    wf["mv:file"] = {"class_type": "SplatToFile3D",
                     "inputs": {"splat": ["mv:merge", 0], "format": "ply"}}
    wf["mv:save"] = {
        "class_type": "SaveGaussianSplat",
        "inputs": {"model_3d": ["mv:file", 0], "filename_prefix": filename_prefix,
                   "viewport_state": {}, "width": width, "height": height},
    }
    return wf


# ── Equirectangular panorama (FLUX.2 Klein + 360 LoRA) ─────────────────────────

def build_panorama_reconstruct_workflow(
    panorama_filename: str,
    fov_degrees: float = 65.0,
    overlap_percent: float = 10.0,
    output_size: int = 1024,
    skip_poles: bool = True,
    output_prefix: str = "panoscene",
    max_depth: float = 0.0,
    min_opacity: float = 0.0,
) -> dict:
    """Reconstruct a whole location from one equirectangular panorama.

    This is the path the tooling was built for. SamplePanorama cuts the sphere
    into overlapping pinhole views *and emits their extrinsics*, SharpPredict
    consumes the batch with those extrinsics so every view lands in one shared
    frame, and MergeGaussians simply concatenates — it does no alignment of its
    own, and does not need to.

    Reconstructing views independently and translating them afterwards, which is
    what TransformSplat invites, cannot match this: SharpPredict normalises scale
    per image, so separately reconstructed views do not even share a unit.
    """
    return {
        "sp:1": {"class_type": "LoadImage",
                 "inputs": {"image": panorama_filename, "upload": "image"}},
        "sp:2": {"class_type": "SamplePanorama",
                 "inputs": {"panorama": ["sp:1", 0], "fov_degrees": fov_degrees,
                            "overlap_percent": overlap_percent, "output_size": output_size,
                            "skip_poles": skip_poles}},
        "sp:3": {"class_type": "LoadSharpModel",
                 "inputs": {"precision": "auto", "checkpoint_path": ""}},
        "sp:4": {"class_type": "SharpPredict",
                 "inputs": {"model": ["sp:3", 0], "image": ["sp:2", 0],
                            "extrinsics": ["sp:2", 1], "intrinsics": ["sp:2", 2],
                            "focal_length_mm": 0, "output_prefix": output_prefix}},
        "sp:5": {"class_type": "MergeGaussians",
                 "inputs": {"ply_folder": ["sp:4", 0], "output_prefix": f"{output_prefix}_merged",
                            "max_depth": max_depth, "min_opacity": min_opacity}},
    }


# ── Viggle-Animate character swap ──────────────────────────────────────────────

VIGGLE_UNET = "minimax_h3_ref2va_viggle_pruned_int8_convrot.safetensors"
VIGGLE_LORA = "viggle_animate_dmd_lora_r64.safetensors"
VIGGLE_TEXT_COND = "fixed_embed_fwd_anyframe.safetensors"
VIGGLE_VAE = "minimax_h3_video_vae_int8_convrot.safetensors"
# Long clips go through the node pack's own windowing (Windowed Conditioning + Viggle
# Chunked Sampler, pack 1.3.x). One generation holds 124 frames (upstream's default,
# 5.2 s); 243 and 345 frames in one go broke up from the first frame (2026-09-21).
# Our own segment chains were measured against this and lost: a chained segment's
# last latent row drifted into the reference still, and consistency decayed after
# ~8 s. The pack pads the final reference to the target latent count and anchors each
# window on five decoded frames, and its 14 s run held the character to the end.
VIGGLE_CHUNK = 124
VIGGLE_OVERLAP = 22
# Upstream's distilled schedule: four sigma points, three Euler updates.
VIGGLE_SIGMAS = "1.0, 0.8571428571428571, 0.6, 0.0"


def build_viggle_charswap_workflow(
    video_filename: str,
    reference_filename: str,
    length: int = 124,
    seed: int = 95051,
    sampler: str = "euler",
    megapixels: float = 0.8,
    shift: float = 3.0,
    filename_prefix: str = "cinema_charswap",
    keep_audio: bool = False,
) -> dict:
    """Viggle-Animate (MiniMax-H3 ref2va finetune): swap the performer in a clip.

    There is no prompt. The text encoder is replaced by a frozen 362-token embedding
    (`fixed_embed_fwd_anyframe`), so identity comes from the reference still and
    everything else -- blocking, camera, set, lighting, the other people -- from the
    driving clip. Anything the caller wants to change has to be changed in those two
    inputs; there is no text to argue with.

    `length` is the frames the clip supplies at 24 fps; loading more than exist hands
    the conditioning a short batch and the output mosaics. Clips over VIGGLE_CHUNK
    frames are windowed with a VIGGLE_OVERLAP overlap, all in this one graph.

    Held props do not survive: a tie the source performer raised was absent in every
    take (2026-09-07). Viggle repaints the performer and whatever is in their hands goes
    with them, and there is no prompt to fix it with -- a shot whose story is a hand
    prop belongs on the Ref2VA route. The face blends: hair from the still, bone
    structure from the driving performer.
    """
    wf = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": VIGGLE_UNET, "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly",
              "inputs": {"model": ["1", 0], "lora_name": VIGGLE_LORA,
                         "strength_model": 1.0}},
        "3": {"class_type": "MiniMaxH3SigmaShift",
              "inputs": {"model": ["2", 0], "shift_video": shift, "shift_audio": shift}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": VIGGLE_VAE}},
        "5": {"class_type": "ViggleTextCondLoader",
              "inputs": {"text_cond": VIGGLE_TEXT_COND}},
        "6": {"class_type": "VHS_LoadVideo",
              "inputs": {"video": video_filename, "force_rate": 24,
                         "custom_width": 0, "custom_height": 0,
                         "frame_load_cap": max(5, length), "skip_first_frames": 0,
                         "select_every_nth": 1, "format": "AnimateDiff"}},
        # The conditioning canvas is 0.4-1.2 MP; a larger source is scaled down here.
        "7": {"class_type": "ImageScaleToTotalPixels",
              "inputs": {"image": ["6", 0], "upscale_method": "lanczos",
                         "megapixels": megapixels, "resolution_steps": 32}},
        "8": {"class_type": "LoadImage", "inputs": {"image": reference_filename}},
        "9": {"class_type": "ViggleAnimateConditioningWindowed",
              "inputs": {"cond_video": ["7", 0], "ref_image": ["8", 0],
                         "text_cond": ["5", 0], "vae": ["4", 0],
                         "width": 0, "height": 0,
                         "chunk_frames": VIGGLE_CHUNK, "overlap_frames": VIGGLE_OVERLAP,
                         "continuation": "five_frame_anchor"}},
        "10": {"class_type": "BasicGuider",
               "inputs": {"model": ["3", 0], "conditioning": ["9", 1]}},
        "11": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": sampler}},
        "12": {"class_type": "ManualSigmas", "inputs": {"sigmas": VIGGLE_SIGMAS}},
        "14": {"class_type": "ViggleChunkedSampler",
               "inputs": {"guider": ["10", 0], "sampler": ["11", 0], "sigmas": ["12", 0],
                          "cond_set": ["9", 0], "vae": ["4", 0], "seed": seed,
                          "rerender_chunk": 0, "rerender_seed": 0}},
        "16": {"class_type": "VHS_VideoCombine",
               "inputs": {"images": ["14", 0], "frame_rate": 24, "loop_count": 0,
                          "filename_prefix": filename_prefix, "format": "video/h264-mp4",
                          "pix_fmt": "yuv420p", "crf": 14, "save_metadata": True,
                          "trim_to_audio": False, "pingpong": False,
                          "save_output": True}},
    }
    # Sol over kjsage (2026-09-21): same picture per window, identity judged more
    # consistent. With no patch ComfyUI runs plain pytorch attention over clip +
    # driving clip + still and spills past 32 GB into shared memory.
    wf["10"]["inputs"]["model"], _ = _apply_h3_accel(wf, ["3", 0], "sol", start_id=20)
    if keep_audio:
        # The model's own audio track is silence; the driving clip's sound, as loaded
        # for the same frames, goes onto the output instead. Only wired when the clip
        # has a track: VHS fed a silent mp4's audio stalls ComfyUI's prompt worker.
        wf["16"]["inputs"]["audio"] = ["6", 2]
    return wf


# ── Local repair: MiniMax H3 AV bridge ───────────────────────────────────────
#
# Redo part of an accepted clip without re-rendering all of it. Two shapes,
# and the difference decides which one a shot needs:
#
#   bridge  — both ENDS are frozen and only the middle is generated. The two
#             endpoints are the only anchor: this graph carries no reference
#             images and no reference audio (feeding it ours made the model
#             speak the reference recording's own words, 2026-09-16), so a pose
#             or a face can only be asked for in words. The voice does not
#             drift, because the frozen audio on both sides is what it
#             continues — measured on one line, 109.6 -> 107.7 Hz.
#   extend  — one seam, everything after it regenerated, everything before it
#             kept. That path goes through the normal Ref2VA builder, so
#             reference images and audio DO apply there.
#
# Both obey the H3 grids: a target length is 5 + 17k frames, and a preserved
# audio+video run is 39 + 51k (39, 90, 141, 192 …), the only lengths that land
# on both the 24 fps picture grid and the 40 Hz audio grid.

H3_PRESERVE_RUNS = (39, 90, 141, 192)


def snap_h3_length(frames: int) -> int:
    """Round a frame count up onto H3's 5 + 17k video grid."""
    n = max(5, int(frames))
    while n % 17 != 5 % 17:
        n += 1
    return n


def snap_h3_preserve(frames: int) -> int:
    """The largest usable preserved-context run at or below `frames`; floor 39."""
    usable = [n for n in H3_PRESERVE_RUNS if n <= int(frames)]
    return usable[-1] if usable else 39


def bridge_plan(frame_count: int, context: int = 39) -> tuple:
    """(preserve, target, middle) for redoing `frame_count` frames in place.

    The target has to clear twice the preserved context AND leave room for the
    middle, which is why a short repair inside a long context costs so much: at
    90-frame contexts the smallest target that fits anything at all is 192, and
    it buys 12 generated frames.
    """
    preserve = snap_h3_preserve(context)
    target = snap_h3_length(2 * preserve + max(1, int(frame_count)))
    return preserve, target, target - 2 * preserve


def build_h3_av_bridge_workflow(
    source_video: str,
    prompt: str,
    head_end: int,
    tail_start: int,
    preserve: int = 39,
    target: int = 107,
    width: int = 1376,
    height: int = 768,
    steps: int = 20,
    seed: int = 12345,
    shift_video: float = 12.0,
    shift_audio: float = 3.0,
    sage: str = DEFAULT_H3_ACCEL,
    unet_name: str = "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    # VAEDecodeTiled for 16 GB cards (machine_profile).
    tiled_vae_decode: bool = False,
    text_encoder: str = "",
    video_vae: str = "minimax_h3_video_vae_int8_convrot.safetensors",
    audio_vae: str = "minimax_h3_audio_vae_fp32.safetensors",
) -> dict:
    """Keep both ends of `source_video` and generate the middle between them.

    `head_end` is how many frames are kept from the start — its LAST `preserve`
    frames are what gets frozen at the bridge's start — and `tail_start` is the
    first frame of the kept tail, whose FIRST `preserve` frames are frozen at
    the bridge's end. The output is the whole span with the source laid back
    over both preserved runs by the pack's own assembly, so it can be watched
    end to end without a splice of our own.
    """
    wf: dict = {
        "bridge:unet": {"class_type": "UNETLoader", "inputs": {
            "unet_name": unet_name, "weight_dtype": "default"}},
        "bridge:clip": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": text_encoder or h3_text_encoder(), "type": "minimax", "device": "default"}},
        "bridge:vvae": {"class_type": "VAELoader", "inputs": {"vae_name": video_vae}},
        "bridge:avae": {"class_type": "VAELoader", "inputs": {"vae_name": audio_vae}},
        # The pack's compatibility wrapper, as its own example wires it: without
        # it an audio VAE that predates the H3 audio fixes fails late in the run.
        "bridge:avae_compat": {"class_type": "MiniMaxH3AudioVAECompatibility", "inputs": {
            "audio_vae": ["bridge:avae", 0]}},
    }

    accel_class, accel_inputs = H3_ACCEL_PRESETS.get(accel_for_unet(unet_name, sage), H3_ACCEL_PRESETS[DEFAULT_H3_ACCEL])
    wf["bridge:accel"] = {"class_type": accel_class, "inputs": {
        "model": ["bridge:unet", 0], **accel_inputs}}
    wf["bridge:shift"] = {"class_type": "MiniMaxH3SigmaShift", "inputs": {
        "model": ["bridge:accel", 0], "shift_video": shift_video, "shift_audio": shift_audio}}

    # The tail is loaded to the END of the clip, not just the preserved run: the
    # bridge freezes its first `preserve` frames and the assembly lays the rest of
    # it back after the middle. Capping it at `preserve` cut every repair short at
    # the end of the tail's preserved run -- the source after that was lost.
    for key, cap, skip in (("bridge:head", int(head_end), 0),
                           ("bridge:tail", 0, int(tail_start))):
        wf[key] = {"class_type": "VHS_LoadVideo", "inputs": {
            "video": source_video, "force_rate": 24, "custom_width": width,
            "custom_height": height, "frame_load_cap": cap,
            "skip_first_frames": skip, "select_every_nth": 1}}
    wf["bridge:head_ok"] = {"class_type": "MiniMaxH3Validate24FPSVideo", "inputs": {
        "images": ["bridge:head", 0], "video_info": ["bridge:head", 3]}}
    wf["bridge:tail_ok"] = {"class_type": "MiniMaxH3Validate24FPSVideo", "inputs": {
        "images": ["bridge:tail", 0], "video_info": ["bridge:tail", 3]}}

    # Text only: no first frame and no references anywhere in this graph.
    wf["bridge:cond"] = {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
        "clip": ["bridge:clip", 0], "vae": ["bridge:vvae", 0], "prompt": prompt,
        "width": width, "height": height, "length": int(target)}}
    wf["bridge:mask"] = {"class_type": "MiniMaxH3MaskedAVBridge", "inputs": {
        "latent": ["bridge:cond", 1], "vae": ["bridge:vvae", 0],
        "audio_vae": ["bridge:avae_compat", 0],
        "start_frames": ["bridge:head_ok", 0], "start_audio": ["bridge:head", 2],
        "end_frames": ["bridge:tail_ok", 0], "end_audio": ["bridge:tail", 2],
        "start_fps": 24.0, "end_fps": 24.0,
        "preserve_frames": int(preserve), "crop": "disabled"}}

    wf["bridge:noise"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": int(seed)}}
    wf["bridge:guider"] = {"class_type": "BasicGuider", "inputs": {
        "model": ["bridge:shift", 0], "conditioning": ["bridge:cond", 0]}}
    wf["bridge:sampler"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}}
    wf["bridge:sigmas"] = {"class_type": "BasicScheduler", "inputs": {
        "model": ["bridge:shift", 0], "scheduler": "simple", "steps": int(steps), "denoise": 1.0}}
    wf["bridge:run"] = {"class_type": "SamplerCustomAdvanced", "inputs": {
        "noise": ["bridge:noise", 0], "guider": ["bridge:guider", 0],
        "sampler": ["bridge:sampler", 0], "sigmas": ["bridge:sigmas", 0],
        "latent_image": ["bridge:mask", 0]}}
    wf["bridge:video"] = _h3_video_decode(["bridge:run", 0], tiled_vae_decode, vae=["bridge:vvae", 0])
    wf["bridge:audio"] = {"class_type": "VAEDecodeAudio", "inputs": {
        "samples": ["bridge:run", 0], "vae": ["bridge:avae_compat", 0]}}

    # Lay the real source back over both preserved runs, blended across the
    # overlap the bridge itself reports, and do the audio the same way.
    wf["bridge:join_head"] = {"class_type": "ImageBatchExtendWithOverlap", "inputs": {
        "source_images": ["bridge:head_ok", 0], "new_images": ["bridge:video", 0],
        "overlap": ["bridge:mask", 2], "overlap_side": "source", "overlap_mode": "linear_blend"}}
    wf["bridge:join_tail"] = {"class_type": "ImageBatchExtendWithOverlap", "inputs": {
        "source_images": ["bridge:join_head", 2], "new_images": ["bridge:tail_ok", 0],
        "overlap": ["bridge:mask", 2], "overlap_side": "source", "overlap_mode": "linear_blend"}}
    wf["bridge:join_audio"] = {"class_type": "MiniMaxH3AssembleBridgeAudio", "inputs": {
        "generated_audio": ["bridge:audio", 0], "start_audio": ["bridge:head", 2],
        "end_audio": ["bridge:tail", 2], "start_frames": ["bridge:head_ok", 0],
        "end_frames": ["bridge:tail_ok", 0], "target_frames": int(target),
        "preserve_frames": int(preserve)}}
    wf["bridge:out"] = {"class_type": "CreateVideo", "inputs": {
        "images": ["bridge:join_tail", 2], "fps": 24.0, "audio": ["bridge:join_audio", 0]}}
    wf["bridge:save"] = {"class_type": "SaveVideo", "inputs": {
        "video": ["bridge:out", 0], "filename_prefix": "H3_Bridge",
        "format": "mp4", "codec": "h264"}}
    # A repaired clip still has to go through the H3 latent upscale like every
    # other clip, and that needs a latent. This one covers the bridge's own
    # `target` frames only, not the assembled clip -- the job result records where
    # those frames sit in the output, so the HD version can be put together the
    # same way: the source's own HD outside the span, this latent upscaled inside.
    wf["bridge:latent"] = {"class_type": "MiniMaxH3MotionContextSaveLatent", "inputs": {
        "latent": ["bridge:run", 0], "filename_prefix": "H3_Latent_Bridge", "clip_index": 0}}
    return wf
