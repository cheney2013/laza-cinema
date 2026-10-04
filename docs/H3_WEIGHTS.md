# H3 节点使用的权重文件

整理于 2026-10-02，依据：`backend/main.py`（`H3_MOTION_PRESETS`、`_h3_motion_preset`）、`backend/workflow_builders.py`（各 `build_*` 函数的默认参数）、`backend/comfyui_client.py`、`backend/machine_profile.py`，并逐个核对了 `D:\ComfyUI-sage3\ComfyUI` 下文件是否存在、大小多少。下面的路径都相对 `ComfyUI\models`，除非另写。

文件名以代码为准。改默认值要改代码，不是改这份文档。

## 1. 所有 H3 生成共用

| 作用 | 文件 | 位置 | 大小 |
|---|---|---|---|
| 文本编码器 | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders/` | 15.7 GB |
| 视频 VAE | `minimax_h3_video_vae_int8_convrot.safetensors` | `vae/` | 3.2 GB |
| 音频 VAE | `minimax_h3_audio_vae_fp32.safetensors` | `vae/` | 0.6 GB |

`vae/minimax_h3_video_vae_fp16.safetensors`（5.2 GB）还在磁盘上，代码默认不用，int8_convrot 解码比它快 1.56 倍（`workflow_builders.py` 里的实测注释）。

## 2. 主模型（扩散模型）：按运动预设 motionPreset 选

没写预设的镜头取机器档案里的默认。工作站（RTX 5090 32GB）默认是 **singularity**（2026-10-02 起，之前是 fused），16GB 档（5060 Ti）默认也写 `singularity`，但实际换成 `pruned_w4a8`。

| 预设 | 主模型 `diffusion_models/` | 大小 | 加速 LoRA | 调度器 |
|---|---|---|---|---|
| fused | `minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors` | 21.0 GB | 无，turbo 和 Mystic 0.7 已并进权重 | 构建器默认 |
| hybrid | `minimax_h3_hybrid_b25-49_int8.safetensors` | 21.0 GB | `loras/h3/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors` | beta |
| **singularity**（工作站默认） | `Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors` | 21.0 GB | `loras/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors` | simple |
| ref2va | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | 21.0 GB | 同 singularity 的 ref2v turbo8 | simple |
| ref2va_full | `minimax_h3_ref2va_int8_convrot.safetensors`（未裁剪） | 34.0 GB | 同上 | simple |
| hyperflow | `minimax_h3_ref2va_int8_convrot.safetensors` | 34.0 GB | `loras/minimax_h3_hyperflow_8step_v1.0_comfyui.safetensors` | HyperFlow 自带 sigma |
| crossview | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | 21.0 GB | `loras/h3/minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors`（2.3 GB），采样器 res_multistep | simple |
| pruned_w4a8（16GB 档） | `minimax_h3_ref2va_pruned_w4a8_mixed.safetensors` | 11.8 GB | ref2v turbo8 | simple |

- 步数：fused 固定 8；带 LoRA 的预设在 `accel_lora` 为默认 `turbo8` 时 8 步；`taomate3` 时换成 `loras/h3/TaoMate-H3-3step-ComfyUI.safetensors` 跑 3 步；`none` 时不挂 LoRA 跑 20 步。
- 请求里明写 `unet_name` / `lora_name` 的，以请求为准。
- 16GB 档的替换（`machine_profile.py`）：预设 `singularity` 换成 `pruned_w4a8`；构建器直接点名的 `minimax_h3_ref2va_pruned_int8_convrot.safetensors` 和 Singularity 的文件都换成 `minimax_h3_ref2va_pruned_w4a8_mixed.safetensors`。

## 3. 各类节点实际用到什么

| 节点 / 路径 | 主模型 | 其他权重 |
|---|---|---|
| 视频生成（H3 video，含 Ref2VA / 首尾帧 / T2V） | 第 2 节，按预设 | 第 1 节三个共用文件；风格 LoRA 默认不挂（`style_loras` 默认空） |
| 视频编辑（`<Video 1>`） | 同视频生成（同一个构建器） | 同上 |
| 带控制视频的生成（深度控制） | 任何 ref2va 底模（官方 pruned int8、w4a8、Singularity、fused 都测过）；走 ComfyUI 核心节点 `ModelPatchLoader` + `MiniMaxH3FunControlNetApply` | `model_patches/minimax_h3_fun_controlnet_union_2.0_pruned_bf16.safetensors`（8.4 GB，默认）；1.x `…union_pruned_bf16.safetensors`（4.2 GB）可选 |
| 局部修补 / 编辑窗口 / reshot（`build_h3_temporal_reshot_workflow`） | `minimax_h3_ref2va_pruned_int8_convrot.safetensors`（16GB 档换 w4a8） | 加速 LoRA 和风格 LoRA 由请求传入；第 1 节共用文件 |
| 音视频桥（`build_h3_av_bridge_workflow`） | 同上，pruned int8 ref2va（16GB 档换 w4a8） | 该构建器没有 LoRA 参数；第 1 节共用文件 |
| 视频增强，方法 h3_latent（默认） | `minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors` | `latent_upscale_models/minimax_h3_latent_upscaler_3d_bf16.safetensors`（0.7 GB）；第 1 节共用文件；不挂 LoRA |
| 视频增强，方法 lms（1× 锐化，`_run_video_upscale_job`） | 默认预设（工作站是 singularity），8 步 turbo8 | `loras/minimax_h3_lms_v1.0_r64.safetensors`（1.2 GB），强度 1.0；第 1 节共用文件 |
| 换人 charswap（Viggle） | `minimax_h3_ref2va_viggle_pruned_int8_convrot.safetensors`（21.0 GB） | `loras/viggle_animate_dmd_lora_r64.safetensors`（0.9 GB）；`text_cond/fixed_embed_fwd_anyframe.safetensors`（代替文本编码）；`vae/minimax_h3_video_vae_int8_convrot.safetensors` |
| 换角度 reangle（CrossView） | 预设 crossview（见第 2 节） | `loras/h3/MiniMax-H3_Ref2VA-LoRA-CrossView-Warp_v1_3500.safetensors`（0.6 GB）；深度由 MoGe 估计：`geometry_estimation/moge_2_vitl_normal_fp16.safetensors`；第 1 节共用文件 |
| 只重做声音（redo_audio） | 取该镜头原来的预设 | 同原镜头；读取该 take 保存的 `H3_Latent_*.safetensors` |
| 人像真实感 | — | `loras/h3-realism-people-t2v-i2v-r2v.safetensors`（0.13 GB）：只作为风格 LoRA 手动挂，代码里没有默认值；按已有约定只给固定机位的脸用，强度 0.6 |

## 4. 其他 ComfyUI 路径用到的、不属于 H3 的权重

只列文件名，方便对照：
- 图像生成 Qwen-Image 2.1：`diffusion_models/qwen_image_2.1_int8_convrot.safetensors`（7.26 GB，2026-10-02 起默认；原来的 `qwen_image_2.1_bf16.safetensors` 14.2 GB 还在盘上），文本编码 `text_encoders/qwen3vl_8b_int8_convrot.safetensors`（9.4 GB），VAE `vae/qwen_image_2.1_vae_bf16.safetensors`（三个文件都核实存在）。
- 高斯视角修复：`qwen_image_edit_2511_fp8_e4m3fn.safetensors`、`Gaussian.safetensors`、`Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`、`qwen_2.5_vl_7b.safetensors`、`qwen_image_vae.safetensors`。
- FLUX：`flux1-kontext-dev.safetensors`、`flux2_dev_fp8mixed.safetensors`、`mistral_3_small_flux2_bf16.safetensors`、`flux2-vae.safetensors`、`FLUX.2-dev-Fun-Controlnet-Union.safetensors`。
- 音乐 / 音效：`checkpoints/ace_step_v1_3.5b.safetensors`、`checkpoints/stable-audio-open-1.0.safetensors`。
- 超分 / 补帧：`upscale_models/RealESRGAN_x2.pth`、`rife47.pth`（见第 5 节）。
- 单图 / 视频深度估计：`depth_anything_v2_vitl.pth`（在 `custom_nodes/comfyui_controlnet_aux/ckpts/depth-anything/Depth-Anything-V2-Large/`，不在 `models/` 下）。

## 5. 核对时发现的问题

代码里写了、但在 `models` 和 `custom_nodes` 下搜不到的文件（SeedVR2 已于 2026-10-02 连同权重、工作流和代码一起删除）：

1. `rife47.pth`：补帧工作流写死了这个名字，没搜到。可能由节点首次运行时下载，我没验证。

这一项我只确认了“文件搜不到”，没有实际运行补帧节点，不确定它现在是否真的会失败。

## 6. 磁盘上有、当前代码没有默认使用的

`diffusion_models/`：`minimax_h3_fl2va_pruned_int8_convrot.safetensors`、`minimax_h3_hybrid_b15-49_int8.safetensors`。
`loras/`：`minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`；`loras/h3/` 下的各种 fl2v turbo 4/8 步版本、`minimax_h3_turbo_*` 系列，以及 `Motion_Repair_V2`、`MysticXXX_MMH3-V4`、`NSFW_ANIME_V7_H3-step00019500`、`cinema_h3_realfilm_v0.1`、`wushu_spatial_physics_clean_3000_pruned`。这些要手动在节点里选，才会进入工作流。
