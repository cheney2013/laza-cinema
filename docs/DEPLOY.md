> Viggle engine removed on 2026-10-07; the H3 swap is the only engine. The Viggle files below stay on disk and are unused.

# Deploying to another machine

This repository holds only the **platform**: the canvas, the editing desk, the backend, the MCP. Film content (prompts, storyboards, project canvases, assets) is not in it;
on a new machine it is an empty platform, and you create your own projects.

It is written for a target machine with 16 GB of VRAM / 32 GB of RAM; on a machine with more than 30 GB of VRAM, set `H3_MACHINE_PROFILE` to
`workstation` (or leave it at `auto`) and every feature runs.

## 0. Hard requirements

| Item | Requirement | Reason |
|---|---|---|
| OS | Windows 10/11 | The startup scripts are PowerShell; Triton is the Windows build |
| GPU | NVIDIA, 16 GB minimum; 50 series (5060 Ti 16G, 5070 Ti, 5080, etc.) or 40 series (4070 Ti Super, 4080, etc.) | The official Comfy-Org notes say the NVFP4 text encoder **does not need a Blackwell GPU**, so both generations use the same files. The main model w4a8 computes in int8 and is not tied to Blackwell either. **The 40 series has not been run on real hardware**; it was only tested on a 5090 |
| RAM | 32 GB, page file at least 32 GB | On a 16 GB machine the bottleneck is RAM, not VRAM: the text encoder 15.7 GB + the main model 11.8 GB take about 27.5 GB |
| Disk | 100 GB or more free | The H3 core weights are about 34 GB, Qwen image about 17 GB, plus ComfyUI and the other models |

Software: Python 3.12 (3.10 or later works), Node.js 20 or later, Git, `ffmpeg` and `ffprobe` (must be on PATH).

## 1. Components and ports

| Component | Port | Started by |
|---|---|---|
| ComfyUI (runs the models) | 8188 | You install it, sections 2, 3, 4 |
| Backend FastAPI | 8003 | `start.ps1` |
| Frontend Next.js | 4000 | `start.ps1` |
| Canvas MCP (for AI assistants, optional) | 8004 | `start.ps1` |

## 2. Install ComfyUI

ComfyUI is not in this repository. What is on the author's machine is recorded in `tools/comfyui_setup/setup.json` (generated on the original machine by
`tools/export_comfyui_setup.py`):

- Core: the official `Comfy-Org/ComfyUI` master, commit `f1072eb0` (version 0.38.0), **with no local changes to the core code**
  (checked at export time: no commits ahead of origin/master, working tree clean).
- Python packages: `tools/comfyui_setup/requirements.txt` (the result of `pip freeze`). torch is 2.12.1+cu130,
  triton-windows 3.7.1. The two entries marked `# local wheel` (`sageattention`, `sageattn3`) are wheels the author installed
  locally; you need to install versions that match CUDA 13 / torch 2.12 yourself.
- Launch argument: `--disable-comfy-compiler`. With the compiler on, rendering is slowed down by shared VRAM
  (`docs/issue_comfy_compiler_vram.md`).
- Whether a 16 GB machine needs arguments such as `--lowvram` has not been tested; use the defaults first and try them if RAM gets tight.

The rough steps (**not walked through in full on a clean machine**; if pip reports errors, the versions in `requirements.txt` are authoritative):

```powershell
git clone https://github.com/Comfy-Org/ComfyUI.git
cd ComfyUI
git checkout f1072eb0350638a3390ddb6afbcaa8c6b237c6fd
py -3.13 -m venv .venv
.\.venv\Scripts\pip install torch==2.12.1 torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\pip install comfy-kitchen==0.2.37 triton-windows==3.7.1.post27
.\.venv\Scripts\python main.py --disable-comfy-compiler
```

**The version of `comfy-kitchen` must be right**: the w4a8, `int8_convrot` and NVFP4 weight formats are registered by it; a version that is too old decodes to a black screen or refuses to load
(`tools/comfyui_setup/README.md` §2). The w4a8 weights use the standard UNETLoader and need no extra loader node.
Do not run `pip install -r tools/comfyui_setup/requirements.txt` directly: it is a full 212-line snapshot that includes the CUDA build of torch
and the two local wheels, and is only for comparing versions.

After installing, run ComfyUI once and confirm that `http://127.0.0.1:8188` opens.

## 3. Custom nodes (one-click script)

`tools/comfyui_setup/setup.json` records the 37 node packs on the author's machine. **The studio really needs 19 of them** (`required`):
the pack behind every node class the backend uses, plus RIFE frame interpolation and the live preview; the rest (typography, panorama, gaussian, workflow encryption, etc.)
are other things installed alongside, which the studio does not call and which are not installed by default.

```powershell
python tools\install_comfyui_nodes.py --comfyui C:\ComfyUI
```

You do not need to fetch any archive separately; the repository carries what is needed:

- **15 packs are cloned from GitHub** and checked out at the recorded commit; 5 of them then get the patches in `tools/comfyui_setup/patches/` applied.
- **3 packs are in the repository** (`comfyui_nodes/third_party/`): `ComfyUI-sol-attn` and `ComfyUI-Viggle-Animate-H3`, whose GitHub repositories
  have been deleted, so this is the only place to get them, and `ComfyUI-NLF-Minimal`, which has no repository of its own (two classes lifted from kijai's WanVideoWrapper).
- **This project's own packs** (every directory under `comfyui_nodes/` other than `third_party`: live preview, audio lock, VRAM, the chain correction `aicinema_chain`) are copied as they are.
- Finally, ComfyUI's own Python installs each pack's `requirements.txt`, while pinning torch, numpy, comfy-kitchen and triton at
  the versions ComfyUI currently has, so that a pack does not upgrade them.

Running it again is safe; what is already installed is skipped. `--dry-run` only prints the plan, `--no-pip` skips the dependency install, and `--all` installs the packs that are not needed too.
After installing, restart ComfyUI, then run `python tools\check_install.py`.

Measured before the packs listed above were switched from vendored copies to clones (installed into an empty directory on the author's machine, with the pip step skipped using `--no-pip`): all 19 packs installed, 3 patches applied, and on a second run all 22 items showed as already present;
compared file by file with the author's machine, the contents are identical (the only difference is the `.bak` backup files the author left). **The pip dependency install step, and whether ComfyUI
on another machine loads these nodes correctly after installing, have not been verified.**

After the node packs change on the author's machine, run on that machine
`python tools/export_comfyui_setup.py --comfyui <ComfyUI directory> --vendor comfyui_nodes/third_party`
to update the copy in the repository (this also refreshes `setup.json`, the patches and `requirements.txt`).

The depth estimation weights of `comfyui_controlnet_aux` (`depth_anything_v2_vitl.pth`) are not in the pack and are downloaded separately;
"video depth" and "single-image depth" use them, and you need them on a 16 GB machine if you want depth control.

## 4. Model files

File names follow the code; the full list and sizes are in `docs/H3_WEIGHTS.md`. What a 16 GB machine **must** have:

| File | Goes under `ComfyUI\models\` | Size |
|---|---|---|
| `Minimax-h3_Singularity_ref2va_v1.3_Pruned_w4a8.safetensors` (this is what the 16 GB tier "Singularity" runs) | `diffusion_models/` | 11.8 GB |
| `minimax_h3_ref2va_pruned_w4a8_mixed.safetensors` (the w4a8 of the official ref2va, used by the "official" preset and camera-position change) | `diffusion_models/` | 11.8 GB |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders/` | 15.7 GB |
| `minimax_h3_video_vae_int8_convrot.safetensors` | `vae/` | 3.2 GB |
| `minimax_h3_audio_vae_fp32.safetensors` | `vae/` | 0.6 GB |
| `minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors` | `loras/` | 2.0 GB |
| `minimax_h3_lms_v1.0_r64.safetensors` | `loras/` | 1.2 GB |
| `RealESRGAN_x2.pth` | `upscale_models/` | 0.07 GB |

Image generation (generate image, and the detail pass of image upscaling) additionally needs:

| File | Folder | Size |
|---|---|---|
| `qwen_image_2.1_int8_convrot.safetensors` | `diffusion_models/` | 7.3 GB |
| `qwen3vl_8b_int8_convrot.safetensors` | `text_encoders/` | 9.4 GB |
| `qwen_image_2.1_vae_bf16.safetensors` | `vae/` | 0.3 GB |

The text encoder is the NVFP4 version by default. If it gives trouble on a particular card, you can switch to the INT4 version (`qwen3vl_32b_minimax_h3_int4_convrot.safetensors`,
15.0 GB, source in the table below) and write `H3_TEXT_ENCODER=int4` (or the actual file name) in `.env`. The INT4 version produced one 5.17-second video on a 5090, with picture and sound normal.

Optional: camera-position change (CrossView) needs `loras/h3/MiniMax-H3_Ref2VA-LoRA-CrossView-Warp_v1_3500.safetensors`,
`loras/h3/minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors` and
`geometry_estimation/moge_2_vitl_normal_fp16.safetensors`; the weights for music, sound effects, frame interpolation and pose are each listed in
`tools/comfyui_setup/README.md` §5.

**Where to download.** Each item below was checked: a file with the same name and **exactly the same byte count** was found on Hugging Face (compared with the file on the author's machine),
so it is the same file. The official repository is [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3). After downloading, compare the file names with
`python tools/check_install.py`.

| File | Source | Check |
|---|---|---|
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (default encoder, 15.7 GB) | Comfy-Org/MiniMax-H3 `text_encoders/` | byte count matches |
| `qwen3vl_32b_minimax_h3_int4_convrot.safetensors` (optional INT4 encoder, 15.0 GB) | [Merserk/MiniMax-H3-INT4-ConvRot](https://huggingface.co/Merserk/MiniMax-H3-INT4-ConvRot) (Abiray/MiniMax-H3-GGUF also has a copy) | downloaded, SHA256 matches the repository |
| `minimax_h3_audio_vae_fp32.safetensors` | Comfy-Org/MiniMax-H3 `vae/` | byte count matches |
| `minimax_h3_video_vae_int8_convrot.safetensors` | This machine's copy (3.17 GB) comes from [Kijai/MiniMax-H3-experimental](https://huggingface.co/Kijai/MiniMax-H3-experimental); Comfy-Org/MiniMax-H3 `vae/` has a file of the same name that is **newer and smaller (2.81 GB)** | this machine's copy matches Kijai's byte count; the two versions were compared (same seed, two seeds): picture PSNR 42.7 dB, sharpness the same, either will do, the official one is smaller |
| `Minimax-h3_Singularity_ref2va_v1.3_Pruned_w4a8.safetensors` (11.8 GB) | [WarmBloodAban/Minimax-h3_Singularity](https://huggingface.co/WarmBloodAban/Minimax-h3_Singularity) (downloaded, SHA256 matches the repository) | has been used to render clips |
| `minimax_h3_ref2va_pruned_w4a8_mixed.safetensors` (11.8 GB) | [Kijai/MiniMax-H3-experimental](https://huggingface.co/Kijai/MiniMax-H3-experimental); starsfriday's repository of the same w4a8 name requires a custom loader and supports Linux only, and is not the file we use | byte count matches |
| `minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors` | [lightx2v/Minimax-h3-Turbo](https://huggingface.co/lightx2v/Minimax-h3-Turbo) | byte count matches; that repository has no newer ref2v 8-step version than this one |
| `minimax_h3_lms_v1.0_r64.safetensors` | [Alissonerdx/Minimax-H3-ComfyUI](https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI) `loras/` | byte count matches |
| `minimax_h3_latent_upscaler_3d_bf16.safetensors` (old version) | Mirrors such as DeepBeepMeep/MiniMax-H3; the original repository [LBH-123-AI/Minimax_h3_latent_Upscaler](https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler) now publishes the new version `minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` (0.69 GB) | the old version's byte count matches the mirror; **the new `conv_v1` is bit-for-bit identical to the old file (same SHA256) and only renamed**, so either name is the same; set `H3_LATENT_UPSCALER` to the corresponding file name |
| `MiniMax-H3_Ref2VA-LoRA-CrossView-Warp_v1_3500.safetensors` | [Cseti/…CrossView-Warp_v1](https://huggingface.co/Cseti/MiniMax-H3_Ref2VA-LoRA-CrossView-Warp_v1) | byte count matches |
| `minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors` | [drbaph/MiniMax-H3-Turbo-Lora-ComfyUI](https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI) `experimental/` | byte count matches |
| `moge_2_vitl_normal_fp16.safetensors` | [Comfy-Org/MoGe](https://huggingface.co/Comfy-Org/MoGe) | byte count matches |
| `RealESRGAN_x2.pth` | for example ai-forever/Real-ESRGAN | byte count matches |
| `minimax_h3_fun_controlnet_union_2.0_pruned_bf16.safetensors` (depth control, 8.4 GB, **default**) | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) `model_patches/`, put into `ComfyUI/models/model_patches/` (downloaded, SHA256 matches the repository) | goes through ComfyUI core nodes; clips have been rendered on the w4a8 / int8 / fused base models, picture normal |
| `minimax_h3_fun_controlnet_union_pruned_bf16.safetensors` (1.x, optional, 4.2 GB) | same repository, same folder | byte count matches this machine; can be specified in the node in place of 2.0 |

Weights used only on a workstation (not needed on the 16 GB tier), likewise checked by name and byte count, with no newer version found:

| File | Source |
|---|---|
| `Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors` | [WarmBloodAban/Minimax-h3_Singularity](https://huggingface.co/WarmBloodAban/Minimax-h3_Singularity) (the newest in the repository is v1.3) |
| `minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors` | [MATLOWAI/minimax-h3-fused-turbo-int8-convrot](https://huggingface.co/MATLOWAI/minimax-h3-fused-turbo-int8-convrot) |
| `minimax_h3_ref2va_viggle_pruned_int8_convrot.safetensors`, `viggle_animate_dmd_lora_r64.safetensors`, `text_cond/fixed_embed_fwd_anyframe.safetensors` | [drbaph/Viggle-Animate-ComfyUI](https://huggingface.co/drbaph/Viggle-Animate-ComfyUI) |
| `h3-realism-people-t2v-i2v-r2v.safetensors` | [fal/MiniMax-H3-Realism-People-LoRA](https://huggingface.co/fal/MiniMax-H3-Realism-People-LoRA) |
| `minimax_h3_hybrid_b25-49_int8.safetensors` (and `…b15-49_int8`) | `minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors` (`…b15-49-int8`) in [smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models](https://huggingface.co/smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models): the SHA256 is exactly the same as the file on this machine, only the name differs; after downloading, rename it to `minimax_h3_hybrid_b25-49_int8.safetensors`, which is what the code uses |
- Other low-VRAM builds of the same official pruned ref2va (w4a8, NVFP4, GGUF):
  [starsfriday/MiniMax-H3-w4a8](https://huggingface.co/starsfriday/MiniMax-H3-w4a8) (custom loader, Linux only),
  [lilcheaty/MiniMax-H3-NVFP4](https://huggingface.co/lilcheaty/MiniMax-H3-NVFP4),
  [Abiray/MiniMax-H3-Pruned-GGUF](https://huggingface.co/Abiray/MiniMax-H3-Pruned-GGUF),
  [realrebelai/MiniMax-H3_GGUFs](https://huggingface.co/realrebelai/MiniMax-H3_GGUFs),
  [the comfy-native ref2va page on Civitai](https://civitai.com/models/2857809).
  GGUF needs ComfyUI-GGUF installed and the loader changed; the project currently supports GGUF only for Qwen image (section 7), and the H3 main model is not wired up.
- Qwen-Image 2.1: the official weights have a download entry in ComfyUI's template `image_qwen_image_2_1_image_edit`.
- The source of the author's own weights (Singularity, fused, Viggle, etc.) was not recorded; the 16 GB tier does not need them.

## 5. Install this project

```powershell
git clone <repository URL> laza-cinema
cd laza-cinema
copy .env.example .env
```

Open `.env` and fill in at least:

- `COMFYUI_OUTPUT_DIR`, `COMFYUI_INPUT_DIR`: the `output` and `input` folders of the other machine's ComfyUI. **Required**:
  the backend reads the videos, point clouds and latent files in these two folders directly; if they are not filled in, the backend log reports errors and the results of video jobs cannot be retrieved.
- `H3_MACHINE_PROFILE`: leave it at `auto`; the backend picks automatically from the VRAM ComfyUI reports (below 24 GB it is `lowvram`).
- `LLM_BASE_URL`: can be left empty, see below.

Then:

```powershell
.\start.ps1
python tools\check_install.py
```

`start.ps1` starts the backend (the first time it creates `.venv` and installs dependencies), the frontend (the first time `npm install`, afterwards
`next build`) and the MCP in new windows. `tools/check_install.py` checks Python, Node, ffmpeg, ComfyUI connectivity and version, VRAM and RAM,
the directory configuration, whether the nodes are fully installed, and whether the model files are all present, and lists whatever is missing.

Open `http://localhost:4000` in a browser; the first time, **register an account** first, then create a project.

Optional LLM: prompt translation and optimisation use any OpenAI-compatible local service (LM Studio, Ollama, vLLM);
write `LLM_BASE_URL` in `.env`. Without these two settings those two features are unavailable and nothing else is affected. The H3 director desk, the prompt assistant and the subject description
use the NVIDIA NIM cloud service, which needs `NV_API_KEY` or your own key entered in the settings.

## 6. What works on a 16 GB machine

The specific behaviour of the `lowvram` tier is in `backend/machine_profile.py`: resolution 864×480, tiled VAE decoding,
and "Singularity" is automatically swapped for its w4a8 version.

| Feature | Status |
|---|---|
| Video generation (T2VA / I2VA / Ref2VA / first-and-last frame), continuation, local repair, audio-video bridge | Works; "Singularity" uses its own w4a8 version |
| Official `ref2va` preset | Works; automatically swapped to `pruned_w4a8` (the quantised version of the same weights) |
| Camera-position change (CrossView) | Works, swapped to the w4a8 base model; **the picture quality on this path has not been tested**, a quantised weight stacked with a LoRA may come out grey |
| Video enhancement: ESRGAN, lms (sharpening at original size) | Works; ESRGAN is the default |
| Video enhancement: H3 latent space | **Disabled**, it has to load the 21 GB fused base model |
| Motion presets `fused`, `hybrid`, `ref2va_full` | **Disabled**, 21–34 GB, no low-VRAM version of the same weights was found |
| Character swap (H3 native; the original Viggle engine has been removed) | **The node is still disabled by this machine's profile** (`disabled_node_types`); H3 character swap uses the ref2va base model, and whether it can run on the 16 GB tier has not been tested |
| Depth control (ControlNet 2.0, through the official node) | Works: clips have been rendered at 864×480 on the official w4a8 and Singularity w4a8, picture normal and following the depth map; **memory has not been tested on a real 16 GB machine**. Needs the 2.0 file in `model_patches/`; the control video can be generated with the "depth video" node on the canvas |
| Generate image, image upscaling | Works; with Qwen image and H3 alternating, memory gets tight, not measured |
| Music, sound effects, frame interpolation, pose | Works (small weights), not measured |

How disabling works: the backend refuses the job at the start and says why; the frontend removes the corresponding nodes from the panel and greys out the preset buttons.
`GET /machine-profile` shows the current tier and the disabled list.

**Attention patch.** The 16 GB tier uses `kjsage` by default, not `sol`: with the same seed, the same prompt, w4a8 plus ref2v turbo 8 steps, at 864×480
faces under `sol` are blurry and melting, while with the patch removed or with `kjsage` they are clear (measured 2026-10-04, the author looked at them one by one). At 1344×768 `sol` did not show this problem
in my comparison images, so the workstation (1344×768) still defaults to `sol`. To change it, write `H3_ACCEL=kjsage`, `sol` or leave it empty (no patch) in `.env`.
The backend also has a safeguard: **whenever the base model is w4a8, whatever the request says (including a manual selection on a canvas node), `sol` is automatically replaced with `kjsage` and a warning is written to the backend log**; int8 base models are not affected.

Three things **not yet tested on a real 16 GB / 32 GB machine** (`tools/comfyui_setup/README.md` §6):
the memory peak and time of one 864×480 Ref2VA render; the latent-space round trip of one continuation generation (motion context);
whether the page file is used during text encoding.

## 7. Low-VRAM weights for Qwen-Image 2.1 (optional, not measured)

The INT8 version is used by default (7.3 GB main model + 9.4 GB text encoder). The community has smaller versions, switched with environment variables, no code change needed;
write them in `.env`:

```
QWEN_IMAGE_UNET=<.gguf file name placed under models/unet/>
QWEN_IMAGE_CLIP=<a lighter Qwen3-VL 8B text encoder, for example qwen3vl_8b_w4a8.safetensors>
```

- GGUF: [realrebelai/Qwen-Image-2.1_GGUFs](https://huggingface.co/realrebelai/Qwen-Image-2.1_GGUFs),
  six levels from Q2_K to Q8_0, the author recommends Q4_K_M-HQv3 as the default. Needs the ComfyUI-GGUF custom node installed, and the main model goes in
  `models/unet/`. When the backend sees a name ending in `.gguf` it loads with `UnetLoaderGGUF` instead.
- Text encoder: Qwen3-VL 8B also has a w4a8 version (mentioned in an article, the repository was not checked).
- The author's machine does not have ComfyUI-GGUF installed and did not download these weights, so this path has only had its generated node graph checked and **has not actually been run**.
  `tools/check_install.py` reports an error if you set a `.gguf` but did not install the node.

## 8. The MCP token

The canvas MCP (port 8004) is for AI assistants (for example Claude Code) to read and write the canvas. Once a token is set, every request must carry
`Authorization: Bearer <token>`, local access included. If none is set there is no authentication at all, which is only acceptable when nobody can connect to this machine.

**The token is simply a random string you generate yourself; there is no place to register or apply for one.** Generate it:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

It is used in three places, and **must be the same value**:

1. Server side: write it into the project's `.env`: `AI_CINEMA_MCP_TOKEN=<the value just generated>`. The backend and the MCP service read it on restart.
   A system environment variable of the same name takes precedence over `.env`.
2. Client (Claude Code): it reads the environment variables of the shell that launched it. Write it into the user environment variables and reopen the terminal:
   ```powershell
   setx AI_CINEMA_MCP_TOKEN "<the same value>"
   ```
3. Client configuration: the `.mcp.json` in the repository root is the author's own (it has paths on his machine), **do not use it directly**;
   copy `.mcp.json.example` over, which says `Bearer ${AI_CINEMA_MCP_TOKEN}`. Or add it with a command:
   ```powershell
   claude mcp add --transport http ai-cinema-canvas http://127.0.0.1:8004/mcp --header "Authorization: Bearer <the same value>"
   ```

After changing the token, restart: `.\restart-mcp.ps1` (the MCP) and `.\restart-backend.ps1` (the backend uses it to forward the one-click upscale requests).

Verify (measured on the author's machine; both the 401 and the authenticated result matched):

```powershell
curl.exe -s -o NUL -w "%{http_code}" -X POST http://127.0.0.1:8004/mcp -H "Content-Type: application/json" -d "{}"
# Without a token: 401
curl.exe -s -o NUL -w "%{http_code}" -X POST http://127.0.0.1:8004/mcp -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "{}"
# With the right token: no longer 401 (the empty request body here gets 400, which shows authentication has passed)
```

## 9. Network and security

- The backend, frontend and MCP all listen on `0.0.0.0`. Use them only on a private network such as a LAN or Tailscale; before putting them on the public internet, first
  restrict the source in the firewall, and always set the MCP token (section 8).
- The studio has an account system (register on first entry). Registration is unrestricted, so do not expose 4000 and 8003 to people you do not trust.
- `.env` is not checked in (it is in `.gitignore`); it holds keys and tokens, so do not send it to anyone.

## 10. Other notes

- Film content is not in the repository. The content on the author's machine is recorded in `backend/workspaces/content_archive.db` (not checked in).
  The other side has an empty platform and no sample projects.
- `.mcp.json` and `AGENTS.md` still contain paths on the author's machine (`C:\Users\...`, `D:\Projects\blockout`); they only affect
  AI assistants such as Claude Code and do not affect starting the studio.
- The same seed and prompt will not produce bit-identical pictures on the w4a8 version and on the int8 version the author uses; changing the weights is changing the model.
