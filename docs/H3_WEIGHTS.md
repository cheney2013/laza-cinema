> Viggle engine removed on 2026-10-07; the H3 swap is the only engine. The Viggle files below stay on disk and are unused.

# Weight files used by the H3 nodes

Compiled on 2026-10-02, from: `backend/main.py` (`H3_MOTION_PRESETS`, `_h3_motion_preset`), `backend/workflow_builders.py` (the default parameters of each `build_*` function), `backend/comfyui_client.py`, `backend/machine_profile.py`; each file under `D:\ComfyUI-sage3\ComfyUI` was also checked for existence and size. All paths below are relative to `ComfyUI\models` unless stated otherwise.

File names follow the code. To change a default, change the code, not this document.

## 1. Shared by all H3 generation

| Role | File | Location | Size |
|---|---|---|---|
| Text encoder | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders/` | 15.7 GB |
| Video VAE | `minimax_h3_video_vae_int8_convrot.safetensors` | `vae/` | 3.2 GB |
| Audio VAE | `minimax_h3_audio_vae_fp32.safetensors` | `vae/` | 0.6 GB |

`vae/minimax_h3_video_vae_fp16.safetensors` (5.2 GB) is still on disk but the code does not use it by default; int8_convrot decodes 1.56 times faster than it (measured, per the comment in `workflow_builders.py`).

## 2. Main model (diffusion model): chosen by motion preset motionPreset

A shot with no preset takes the default from the machine profile. The workstation (RTX 5090 32GB) defaults to **singularity** (since 2026-10-02; it was fused before). The 16GB tier (5060 Ti) also writes `singularity` as its default, but it is actually replaced with `pruned_w4a8`.

| Preset | Main model `diffusion_models/` | Size | Acceleration LoRA | Scheduler |
|---|---|---|---|---|
| fused | `minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors` | 21.0 GB | None; turbo and Mystic 0.7 are merged into the weights | builder default |
| hybrid | `minimax_h3_hybrid_b25-49_int8.safetensors` | 21.0 GB | `loras/h3/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors` | beta |
| **singularity** (workstation default) | `Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors` | 21.0 GB | `loras/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors` | simple |
| ref2va | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | 21.0 GB | Same ref2v turbo8 as singularity | simple |
| ref2va_full | `minimax_h3_ref2va_int8_convrot.safetensors` (not pruned) | 34.0 GB | Same as above | simple |
| crossview | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | 21.0 GB | `loras/h3/minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors` (2.3 GB), sampler res_multistep | simple |
| pruned_w4a8 (16GB tier) | `minimax_h3_ref2va_pruned_w4a8_mixed.safetensors` | 11.8 GB | ref2v turbo8 | simple |

- Steps: fused is fixed at 8; presets with a LoRA run 8 steps when `accel_lora` is the default `turbo8`; with `taomate3` they switch to `loras/h3/TaoMate-H3-3step-ComfyUI.safetensors` and run 3 steps; with `none` no LoRA is attached and they run 20 steps.
- Where the request names `unet_name` / `lora_name` explicitly, the request wins.
- Substitutions on the 16GB tier (`machine_profile.py`): the preset `singularity` is replaced with `pruned_w4a8`; `minimax_h3_ref2va_pruned_int8_convrot.safetensors`, when a builder names it directly, and the Singularity file are both replaced with `minimax_h3_ref2va_pruned_w4a8_mixed.safetensors`.

## 3. What each node actually uses

| Node / path | Main model | Other weights |
|---|---|---|
| Video generation (H3 video, including Ref2VA / first-last frame / T2V) | Section 2, by preset | The three shared files from section 1; style LoRAs are not attached by default (`style_loras` defaults to empty) |
| Video editing (`<Video 1>`) | Same as video generation (same builder) | Same as above |
| Generation with a control video (depth control) | Any ref2va base model (official pruned int8, w4a8, Singularity and fused were all tested); goes through the ComfyUI core nodes `ModelPatchLoader` + `MiniMaxH3FunControlNetApply` | `model_patches/minimax_h3_fun_controlnet_union_2.0_pruned_bf16.safetensors` (8.4 GB, default); the 1.x `…union_pruned_bf16.safetensors` (4.2 GB) is optional |
| Local repair / edit window / reshot (`build_h3_temporal_reshot_workflow`) | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` (w4a8 on the 16GB tier) | Acceleration LoRA and style LoRA come from the request; the shared files from section 1 |
| Audio-video bridge (`build_h3_av_bridge_workflow`) | Same as above, pruned int8 ref2va (w4a8 on the 16GB tier) | This builder has no LoRA parameters; the shared files from section 1 |
| Video enhancement, method h3_latent (default) | `minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors` | `latent_upscale_models/minimax_h3_latent_upscaler_3d_bf16.safetensors` (0.7 GB); the shared files from section 1; no LoRA attached |
| Video enhancement, method lms (1× sharpening, `_run_video_upscale_job`) | Default preset (singularity on the workstation), 8 steps turbo8 | `loras/minimax_h3_lms_v1.0_r64.safetensors` (1.2 GB), strength 1.0; the shared files from section 1 |
| Character swap charswap (Viggle) | `minimax_h3_ref2va_viggle_pruned_int8_convrot.safetensors` (21.0 GB) | `loras/viggle_animate_dmd_lora_r64.safetensors` (0.9 GB); `text_cond/fixed_embed_fwd_anyframe.safetensors` (in place of text encoding); `vae/minimax_h3_video_vae_int8_convrot.safetensors` |
| Angle change reangle (CrossView) | Preset crossview (see section 2) | `loras/h3/MiniMax-H3_Ref2VA-LoRA-CrossView-Warp_v1_3500.safetensors` (0.6 GB); depth is estimated by MoGe: `geometry_estimation/moge_2_vitl_normal_fp16.safetensors`; the shared files from section 1 |
| Redo audio only (redo_audio) | The preset the shot originally used | Same as the original shot; reads the `H3_Latent_*.safetensors` saved with that take |
| Portrait realism | — | `loras/h3-realism-people-t2v-i2v-r2v.safetensors` (0.13 GB): attached by hand as a style LoRA only, with no default in the code; by existing convention it is used only for faces from a fixed camera, at strength 0.6 |

## 4. Weights used by other ComfyUI paths, not part of H3

File names only, for reference:
- Image generation Qwen-Image 2.1: `diffusion_models/qwen_image_2.1_int8_convrot.safetensors` (7.26 GB, the default since 2026-10-02; the earlier `qwen_image_2.1_bf16.safetensors`, 14.2 GB, is still on disk), text encoder `text_encoders/qwen3vl_8b_int8_convrot.safetensors` (9.4 GB), VAE `vae/qwen_image_2.1_vae_bf16.safetensors` (all three files verified to exist).
- Gaussian view repair: `qwen_image_edit_2511_fp8_e4m3fn.safetensors`, `Gaussian.safetensors`, `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`, `qwen_2.5_vl_7b.safetensors`, `qwen_image_vae.safetensors`.
- FLUX: `flux1-kontext-dev.safetensors`, `flux2_dev_fp8mixed.safetensors`, `mistral_3_small_flux2_bf16.safetensors`, `flux2-vae.safetensors`, `FLUX.2-dev-Fun-Controlnet-Union.safetensors`.
- Music / sound effects: `checkpoints/ace_step_v1_3.5b.safetensors`, `checkpoints/stable-audio-open-1.0.safetensors`.
- Upscaling / frame interpolation: `upscale_models/RealESRGAN_x2.pth`, `rife47.pth` (see section 5).
- Single-image / video depth estimation: `depth_anything_v2_vitl.pth` (in `custom_nodes/comfyui_controlnet_aux/ckpts/depth-anything/Depth-Anything-V2-Large/`, not under `models/`).

## 5. Problems found during the check

Files named in the code but not found under `models` or `custom_nodes` (SeedVR2 was deleted on 2026-10-02 together with its weights, workflow and code):

1. `rife47.pth`: the frame interpolation workflow hard-codes this name; it was not found. It may be downloaded by the node on first run; I did not verify this.

For this item I only confirmed that the file cannot be found; I did not actually run the frame interpolation node, so I am not sure whether it would really fail now.

## 6. On disk but not used by default in the current code

`diffusion_models/`: `minimax_h3_fl2va_pruned_int8_convrot.safetensors`, `minimax_h3_hybrid_b15-49_int8.safetensors`.
`loras/`: `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`; under `loras/h3/`, the various fl2v turbo 4/8-step versions, the `minimax_h3_turbo_*` series, and `Motion_Repair_V2`, `MysticXXX_MMH3-V4`, `NSFW_ANIME_V7_H3-step00019500`, `cinema_h3_realfilm_v0.1`, `wushu_spatial_physics_clean_3000_pruned`. These only enter a workflow when selected by hand in a node.
