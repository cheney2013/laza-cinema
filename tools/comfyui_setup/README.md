# ComfyUI setup for a 16 GB VRAM / 32 GB RAM machine

What the studio needs from ComfyUI, taken from what the backend actually submits
(`backend/workflow_builders.py`, `backend/main.py` presets) and checked against the
workstation install (`D:\ComfyUI-sage3`) on 2026-09-19.

The backend picks the `lowvram` profile by itself when ComfyUI reports < 24 GiB VRAM
(`backend/machine_profile.py`): 864x480, tiled VAE decode, and Singularity runs
as its w4a8 quantised build (`minimax_h3_ref2va_pruned_w4a8_mixed`) with the
ref2v turbo 8-step LoRA. It is the same base to the user -- the node shows one
Singularity button; the backend chooses the build by total VRAM.

## 1. Hardware constraint

- **NVIDIA RTX 50 or 40 series, 16 GB.** The NVFP4 text encoder (`qwen3vl_32b_minimax_h3_nvfp4_awq`) does not need
  Blackwell (Comfy-Org's README says so), so both generations use the same files. An INT4 convrot build
  (`qwen3vl_32b_minimax_h3_int4_convrot`, 15.0 GB) can be chosen with `H3_TEXT_ENCODER=int4`; it ran once on a 5090
  (124 frames, 864x480, picture and sound normal). The w4a8 main model computes in int8 and is not tied to
  Blackwell. No 40-series card has run this.
- The limit on this machine is **system RAM, not VRAM**. Measured on the
  workstation with VRAM capped to ~14 GB: Singularity (w4a8 build) renders fine
  (12.5 GB used, 94 s per 480p clip); ComfyUI streams weights from RAM. Text
  encoder (15.7 GB) + the w4a8 build (11.8 GB) ≈ 27.5 GB of the 32 GB. Any
  21 GB int8 base + the encoder (~37 GB) does not fit. **Not yet measured on a real 32 GB machine.**
- Set the Windows page file to at least 32 GB so a peak spills instead of crashing.

## 2. Environment (as on the workstation)

| Item | Version |
|---|---|
| ComfyUI | 0.38.0, official master `f1072eb0`, core unmodified (`setup.json`; was 0.36.0 when this was first written) |
| Python | 3.13.12 |
| torch | 2.12.1+cu130 (CUDA 13.0) |
| comfy-kitchen | 0.2.35 — registers the `asym_w4a8_int8` / `int8_convrot` / NVFP4 weight formats; older versions decode black or refuse w4a8 |
| sageattention | 2.2.0 (cu130, torch ≥ 2.10 build) |
| triton-windows | 3.7.1 |
| onnxruntime-gpu | 1.28.0 (pose / detection) |
| av | 18.0.0 |

Launch flag that matters: `--disable-comfy-compiler` (with the compiler on,
renders slowed badly through shared memory; see `docs/issue_comfy_compiler_vram.md`).
Output directory: point `--output-directory` wherever the backend's
`COMFYUI_URL` machine serves `/comfy_output` from.

Backend side: `H3_MACHINE_PROFILE` unset (auto) or `lowvram`; `COMFYUI_URL` if
ComfyUI is not on 127.0.0.1:8188/8189.

## 3. Custom nodes

| Package | Source | Commit / version | Used for |
|---|---|---|---|
| comfyui-h3-motion-context | github.com/NikoDemon80/ComfyUI-H3-Motion-Context | f80e36b + **patch** | chains (motion context), latent save/load, `MiniMaxH3LatentUpscaleBy` |
| ComfyUI-H3-Motion-Context-MultiRef | github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef | 361624f + **patch** | existing-video context, AV bridge, 24 fps check |
| comfyui-kjnodes | github.com/kijai/ComfyUI-KJNodes | 1.5.0 | Sage attention patch for H3, image batch helpers |
| ComfyUI-sol-attn | github.com/Saganaki22/ComfyUI-sol-attn | 930a4d6 | Sol attention + chunked feed-forward (default H3 accel) |
| comfyui-videohelpersuite | github.com/Kosinkadink/ComfyUI-VideoHelperSuite | 1.7.9 + **patch** | loading reference / control videos |
| ComfyUI-FL-MiniMaxH3 | github.com/filliptm/ComfyUI-FL-MiniMaxH3 | 4af2faa + **patch** | temporal reshot (local repair) |
| Comfyui-MMH3-UltimateUpscale | github.com/bbaudio-2025/Comfyui-MMH3-UltimateUpscale | 8d98e68 | latent upscale |
| ComfyUI-H3-FunControl | github.com/wyzborrero/ComfyUI-H3-FunControl | 22a7ec3 | grey-box control video (needs the fused base, see §5) |
| ComfyUI-Viggle-Animate-H3 | github.com/Saganaki22/ComfyUI-Viggle-Animate-H3 | 998d013 | character swap |
| ComfyUI-HyperFlow-H3 | this folder (`ComfyUI-HyperFlow-H3/`) | ours | HyperFlow preset (not usable at 16 GB, see §5) |
| ComfyUI-WanAnimatePreprocess | github.com/kijai/ComfyUI-WanAnimatePreprocess | 1.0.3 | ONNX detector loader (pose) |
| ComfyUI-SCAIL-Pose | github.com/kijai/ComfyUI-SCAIL-Pose | 1.0.2 | ViTPose → DWPose |
| ComfyUI-NLF-Minimal | (installed through the Manager; no repo metadata) | — | 3D pose (NLF) |

Everything else the backend uses is ComfyUI core (MiniMax H3,
Gaussian splat, audio, video nodes).

### Local patches (`patches/`)

Apply after cloning, from inside each package: `git apply <file>.patch`.
Re-apply after every update of that package.

- `comfyui-h3-motion-context.patch` — adds `MiniMaxH3LatentUpscaleBy`.
- `ComfyUI-H3-Motion-Context-MultiRef.patch` — drops its four class names that
  collide with comfyui-h3-motion-context; accepted chains depend on the latter's
  semantics.
- `comfyui-videohelpersuite.patch` — a video without an audio stream no longer
  kills ComfyUI's prompt worker (queue shows "running", stays at 0 %).
- `ComfyUI-FL-MiniMaxH3.patch` — unloads models before the reshot assembler
  decodes the source; without it long sources fail for lack of host RAM.
  Even more needed at 32 GB.

The core `comfy_execution/caching.py` patch from 2026-09-07 is no longer
needed: ComfyUI 0.36.0 wraps that scan in try/except itself.

## 4. Weights — H3 core (required)

Copy these from the workstation (sizes in GB). Folder = ComfyUI model folder.

| File | Folder | GB |
|---|---|---|
| minimax_h3_ref2va_pruned_w4a8_mixed.safetensors (Singularity, w4a8 build) | diffusion_models | 11.8 |
| qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors | text_encoders | 15.7 |
| minimax_h3_video_vae_int8_convrot.safetensors | vae | 3.2 |
| minimax_h3_audio_vae_fp32.safetensors | vae | 0.6 |
| minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors | loras | 2.0 |
| h3-realism-people-t2v-i2v-r2v.safetensors (optional, face shots) | loras | 0.1 |
| minimax_h3_latent_upscaler_3d_bf16.safetensors (latent upscale) | latent_upscale_models | 0.7 |

About 34 GB. That covers T2VA / I2VA / Ref2VA / FL2VA, chains, and the
existing-video context.

## 5. Other features and whether they fit

| Feature | Weights (GB) | 16 GB / 32 GB |
|---|---|---|
| Pose / 3D pose | vitpose-l-wholebody.onnx (1.2), yolov10m.onnx (0.1) in `detection`; NLF downloads its own | fits |
| Music (ACE-Step) | ace_step_v1_3.5b (7.7, checkpoints) | fits |
| Sound effects (Stable Audio) | stable-audio-open-1.0 (4.9, checkpoints), t5-base (0.9, text_encoders) | fits |
| ESRGAN upscale | RealESRGAN_x2.pth (0.07, upscale_models) | fits |
| RIFE interpolation | rife47.pth (comfyui-frame-interpolation downloads it) | fits |
| Latent upscale | uses the **fused** int8 base (21.0) | **does not fit in 32 GB RAM** with the encoder; the app refuses `h3_latent` here and defaults to ESRGAN (`machine_profile.py`) |
| Temporal reshot / AV bridge | ref2va_pruned_int8 (21.0) on the workstation; on this machine the backend loads the w4a8 build instead (`unet_substitutes` in `machine_profile.py`), bridge decodes tiled | fits (same weights as §4); not measured |
| Character swap (Viggle) | ref2va_viggle_pruned_int8 (21.0) + viggle LoRA | **does not fit**; node hidden and job refused on this profile |
| Depth control (Fun ControlNet 2.0 through ComfyUI's own nodes) | `model_patches/minimax_h3_fun_controlnet_union_2.0_pruned_bf16.safetensors` (8.4); any ref2va base, no fused needed | fits as far as tested: official w4a8 and Singularity w4a8 at 864x480 render normally; memory on a real 16 GB card not measured |
| FLUX.2 dev stills | flux2_dev_fp8mixed (35.5) + mistral_3_small (35.6) | **no** |
| Gaussian view repair (Qwen Image Edit) | qwen_image_edit_2511_fp8 (20.4) + qwen_2.5_vl_7b (16.6) | **no** |
| HyperFlow preset | unpruned ref2va int8 (34.0) | **no**; preset refused (so are `fused`, `hybrid`, `ref2va_full`) |
| Qwen-Image 2.1 stills | int8 (7.3) + Qwen3-VL 8B encoder (9.4); a GGUF / lighter encoder can be set with `QWEN_IMAGE_UNET` / `QWEN_IMAGE_CLIP` | should fit; **not measured** next to H3 in 32 GB RAM |
| CrossView re-angle | `crossview` preset keeps its LoRA, checkpoint swapped to w4a8 | runs; **quality on w4a8 not measured** |

Builders whose nodes are missing on the workstation too (feature currently
dead, nothing to install): FLUX Kontext, FLUX.2 Fun
ControlNet, SHARP Gaussian / panorama, Depth Anything.

## 6. Still to verify on the real machine

1. One 864x480 Ref2VA render at the lowvram defaults: peak RAM and time.
2. A chained segment (motion context) — the latent round-trip.
3. Whether the page file gets hit during text encoding.

## 7. Keeping this folder current

`python tools/export_comfyui_setup.py --comfyui <ComfyUI folder> [--zip bundle.zip]` rewrites
`setup.json`, `requirements.txt` and the patches from the working install. Run it on the machine that
works after any change to ComfyUI or its node packs. The full deployment guide is `docs/DEPLOY.md`.
