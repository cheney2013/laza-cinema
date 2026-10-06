# 部署到另一台机器

本仓库只有**平台**：画布、剪辑台、后端、MCP。影片内容（提示词、分镜、项目画布、素材）不在里面，
新机器上是一个空平台，自己建项目。

目标机器按 16 GB 显存 / 32 GB 内存来写；30 GB 显存以上的机器把 `H3_MACHINE_PROFILE` 设成
`workstation`（或留 `auto`）即可跑全部功能。

## 0. 硬性要求

| 项 | 要求 | 原因 |
|---|---|---|
| 系统 | Windows 10/11 | 启动脚本是 PowerShell；Triton 用的是 Windows 版 |
| 显卡 | NVIDIA 16 GB 起，50 系（5060 Ti 16G、5070 Ti、5080 等）或 40 系（4070 Ti Super、4080 等） | 官方 Comfy-Org 的说明写明 NVFP4 文本编码器**不需要 Blackwell 显卡**，所以两代用同一套文件。主模型 w4a8 走 int8 计算，也不绑 Blackwell。**40 系没有在真机上跑过**，只在 5090 上测过 |
| 内存 | 32 GB，页面文件至少 32 GB | 16 GB 机器的瓶颈是内存，不是显存：文本编码器 15.7 GB + 主模型 11.8 GB 约占 27.5 GB |
| 硬盘 | 100 GB 以上空闲 | H3 核心权重约 34 GB，Qwen 图像约 17 GB，加上 ComfyUI 和其他模型 |

软件：Python 3.12（3.10 以上可用）、Node.js 20 以上、Git、`ffmpeg` 和 `ffprobe`（要在 PATH 里）。

## 1. 组成与端口

| 组件 | 端口 | 谁启动 |
|---|---|---|
| ComfyUI（跑模型） | 8188 | 自己装，第 2、3、4 节 |
| 后端 FastAPI | 8003 | `start.ps1` |
| 前端 Next.js | 4000 | `start.ps1` |
| 画布 MCP（给 AI 助手用，可选） | 8004 | `start.ps1` |

## 2. 安装 ComfyUI

ComfyUI 不在本仓库里。作者机器上的情况记在 `tools/comfyui_setup/setup.json`（由
`tools/export_comfyui_setup.py` 在原机生成）：

- 核心：官方 `Comfy-Org/ComfyUI` master，提交 `f1072eb0`（版本 0.38.0），**核心代码没有本地改动**
  （导出时核对过：没有领先 origin/master 的提交，工作区干净）。
- Python 包：`tools/comfyui_setup/requirements.txt`（`pip freeze` 的结果）。torch 是 2.12.1+cu130，
  triton-windows 3.7.1。里面标成 `# local wheel` 的两项（`sageattention`、`sageattn3`）是作者本地装的
  wheel，需要自己装对应 CUDA 13 / torch 2.12 的版本。
- 启动参数：`--disable-comfy-compiler`。打开 compiler 后渲染会被共享显存拖慢
  （`docs/issue_comfy_compiler_vram.md`）。
- 16 GB 机器要不要加 `--lowvram` 之类的参数，没有测过，先用默认，内存吃紧再试。

大致的步骤（**没有在干净机器上完整走过**，pip 报错时以 `requirements.txt` 里的版本为准）：

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

**`comfy-kitchen` 的版本要对**：w4a8、`int8_convrot` 和 NVFP4 这些权重格式是它注册的，版本太旧会解码成黑屏或者直接拒绝加载
（`tools/comfyui_setup/README.md` §2）。w4a8 权重用的是标准的 UNETLoader，不需要额外的加载节点。
不要直接 `pip install -r tools/comfyui_setup/requirements.txt`：它是 212 行的完整快照，包含 CUDA 版 torch
和两个本地 wheel，只用来对照版本。

装好后跑一次 ComfyUI，确认 `http://127.0.0.1:8188` 能打开。

## 3. 自定义节点（一键脚本）

`tools/comfyui_setup/setup.json` 记录了作者机器上的 37 个节点包。**工作室真正需要的是其中 19 个**（`required`）：
后端用到的每个节点类对应的包，加上 RIFE 插帧和实时预览；其余的（排版、panorama、gaussian、工作流加密等）
是装在旁边的别的东西，工作室不调用，默认不装。

```powershell
python tools\install_comfyui_nodes.py --comfyui C:\ComfyUI
```

不需要另外拿任何压缩包，仓库自带需要的东西：

- **6 个包从 GitHub clone**，切到记录的提交；其中 3 个再打 `tools/comfyui_setup/patches/` 里的补丁。
- **11 个包在仓库里**（`comfyui_nodes/third_party/`，约 40 MB）：没有 git 历史的 9 个，加上 `ComfyUI-sol-attn` 和
  `ComfyUI-Viggle-Animate-H3` —— 它们的 GitHub 仓库已经删除，只有这里能拿到。已去掉只用于说明文档的图片和视频。
- **本项目自己的包**（`comfyui_nodes/` 下除 `third_party` 外的每个目录：实时预览、音频锁定、显存、接续校正 `aicinema_chain`）直接复制。
- 最后用 ComfyUI 自己的 Python 装各包的 `requirements.txt`，同时把 torch、numpy、comfy-kitchen、triton 钉在
  ComfyUI 当前的版本，避免被某个包升级掉。

重复运行是安全的，已经装好的会跳过。`--dry-run` 只打印计划，`--no-pip` 跳过依赖安装，`--all` 连不需要的包也装。
装完重启 ComfyUI，再跑 `python tools\check_install.py`。

实测（在作者机器上装进一个空目录，pip 一步用 `--no-pip` 跳过）：19 个包全部装上，3 个补丁打上，重跑时 22 项都显示已存在，
和作者本机逐文件比对内容一致（只差作者自己留的 `.bak` 备份文件）。**pip 安装依赖这一步，和装完后 ComfyUI 能否在另一台
机器上正常加载这些节点，没有验证过。**

作者机器上节点包有变化后，在那台机器上运行
`python tools/export_comfyui_setup.py --comfyui <ComfyUI 目录> --vendor comfyui_nodes/third_party`
更新仓库里的这份拷贝（同时刷新 `setup.json`、补丁和 `requirements.txt`）。

`comfyui_controlnet_aux` 的深度估计权重（`depth_anything_v2_vitl.pth`）不在包里，单独下载；
「视频深度」「单图深度」用到它，16 GB 机器上要用深度控制就需要。

## 4. 模型文件

文件名以代码为准，完整清单和大小见 `docs/H3_WEIGHTS.md`。16 GB 机器**必需**的：

| 文件 | 放在 `ComfyUI\models\` 下 | 大小 |
|---|---|---|
| `Minimax-h3_Singularity_ref2va_v1.3_Pruned_w4a8.safetensors`（16 GB 档「Singularity」跑的就是它） | `diffusion_models/` | 11.8 GB |
| `minimax_h3_ref2va_pruned_w4a8_mixed.safetensors`（官方 ref2va 的 w4a8，「官方」预设和换机位用） | `diffusion_models/` | 11.8 GB |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders/` | 15.7 GB |
| `minimax_h3_video_vae_int8_convrot.safetensors` | `vae/` | 3.2 GB |
| `minimax_h3_audio_vae_fp32.safetensors` | `vae/` | 0.6 GB |
| `minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors` | `loras/` | 2.0 GB |
| `minimax_h3_lms_v1.0_r64.safetensors` | `loras/` | 1.2 GB |
| `RealESRGAN_x2.pth` | `upscale_models/` | 0.07 GB |

图片生成（生成图片、图片超清的补细节）另需：

| 文件 | 文件夹 | 大小 |
|---|---|---|
| `qwen_image_2.1_int8_convrot.safetensors` | `diffusion_models/` | 7.3 GB |
| `qwen3vl_8b_int8_convrot.safetensors` | `text_encoders/` | 9.4 GB |
| `qwen_image_2.1_vae_bf16.safetensors` | `vae/` | 0.3 GB |

文本编码器默认用 NVFP4 版。如果某张卡上它有问题，可以换成 INT4 版（`qwen3vl_32b_minimax_h3_int4_convrot.safetensors`，
15.0 GB，来源见下表），在 `.env` 里写 `H3_TEXT_ENCODER=int4`（或具体文件名）。INT4 版在 5090 上出过一条 5.17 秒的视频，画面和声音正常。

可选：换机位（CrossView）要 `loras/h3/MiniMax-H3_Ref2VA-LoRA-CrossView-Warp_v1_3500.safetensors`、
`loras/h3/minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors` 和
`geometry_estimation/moge_2_vitl_normal_fp16.safetensors`；音乐、音效、补帧、姿态各自的权重见
`tools/comfyui_setup/README.md` §5。

**去哪里下载。** 下面每一项都核对过：在 Hugging Face 上找同名且**字节数完全一致**的文件（和作者机器上的文件比对），
所以是同一份文件。官方仓库是 [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3)。下完用
`python tools/check_install.py` 对一遍文件名。

| 文件 | 来源 | 核对 |
|---|---|---|
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`（默认编码器，15.7 GB） | Comfy-Org/MiniMax-H3 `text_encoders/` | 字节数一致 |
| `qwen3vl_32b_minimax_h3_int4_convrot.safetensors`（可选的 INT4 编码器，15.0 GB） | [Merserk/MiniMax-H3-INT4-ConvRot](https://huggingface.co/Merserk/MiniMax-H3-INT4-ConvRot)（Abiray/MiniMax-H3-GGUF 也有一份） | 已下载，SHA256 与仓库一致 |
| `minimax_h3_audio_vae_fp32.safetensors` | Comfy-Org/MiniMax-H3 `vae/` | 字节数一致 |
| `minimax_h3_video_vae_int8_convrot.safetensors` | 本机这份（3.17 GB）来自 [Kijai/MiniMax-H3-experimental](https://huggingface.co/Kijai/MiniMax-H3-experimental)；Comfy-Org/MiniMax-H3 `vae/` 里有同名的**较新较小版本（2.81 GB）** | 本机版字节数与 Kijai 一致；两版对比过（同 seed、两个 seed）：画面 PSNR 42.7 dB、清晰度一致，用哪个都行，官方版更小 |
| `Minimax-h3_Singularity_ref2va_v1.3_Pruned_w4a8.safetensors`（11.8 GB） | [WarmBloodAban/Minimax-h3_Singularity](https://huggingface.co/WarmBloodAban/Minimax-h3_Singularity)（已下载，SHA256 与仓库一致） | 已用它出过片 |
| `minimax_h3_ref2va_pruned_w4a8_mixed.safetensors`（11.8 GB） | [Kijai/MiniMax-H3-experimental](https://huggingface.co/Kijai/MiniMax-H3-experimental)；starsfriday 的 w4a8 同名仓库要求自定义加载器且只支持 Linux，不是我们用的这份 | 字节数一致 |
| `minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors` | [lightx2v/Minimax-h3-Turbo](https://huggingface.co/lightx2v/Minimax-h3-Turbo) | 字节数一致；该仓库没有比它更新的 ref2v 8 步版本 |
| `minimax_h3_lms_v1.0_r64.safetensors` | [Alissonerdx/Minimax-H3-ComfyUI](https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI) `loras/` | 字节数一致 |
| `minimax_h3_latent_upscaler_3d_bf16.safetensors`（旧版） | DeepBeepMeep/MiniMax-H3 等镜像；原仓库 [LBH-123-AI/Minimax_h3_latent_Upscaler](https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler) 现在发布的是新版 `minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors`（0.69 GB） | 旧版字节数与镜像一致；**新版 `conv_v1` 与旧版文件逐位相同（SHA256 一样），只是改了名**，用哪个名字都一样，设 `H3_LATENT_UPSCALER` 指向对应文件名即可 |
| `MiniMax-H3_Ref2VA-LoRA-CrossView-Warp_v1_3500.safetensors` | [Cseti/…CrossView-Warp_v1](https://huggingface.co/Cseti/MiniMax-H3_Ref2VA-LoRA-CrossView-Warp_v1) | 字节数一致 |
| `minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors` | [drbaph/MiniMax-H3-Turbo-Lora-ComfyUI](https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI) `experimental/` | 字节数一致 |
| `moge_2_vitl_normal_fp16.safetensors` | [Comfy-Org/MoGe](https://huggingface.co/Comfy-Org/MoGe) | 字节数一致 |
| `RealESRGAN_x2.pth` | 例如 ai-forever/Real-ESRGAN | 字节数一致 |
| `minimax_h3_fun_controlnet_union_2.0_pruned_bf16.safetensors`（深度控制，8.4 GB，**默认**） | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) `model_patches/`，放进 `ComfyUI/models/model_patches/`（已下载，SHA256 与仓库一致） | 走 ComfyUI 核心节点，w4a8 / int8 / fused 底模上都出过片，画面正常 |
| `minimax_h3_fun_controlnet_union_pruned_bf16.safetensors`（1.x，可选，4.2 GB） | 同上仓库，同一文件夹 | 字节数与本机一致；可在节点里指定它代替 2.0 |

仅工作站用的权重（16 GB 档用不到），同样按名字加字节数核对过，没有发现更新版本：

| 文件 | 来源 |
|---|---|
| `Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors` | [WarmBloodAban/Minimax-h3_Singularity](https://huggingface.co/WarmBloodAban/Minimax-h3_Singularity)（仓库里最新就是 v1.3） |
| `minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors` | [MATLOWAI/minimax-h3-fused-turbo-int8-convrot](https://huggingface.co/MATLOWAI/minimax-h3-fused-turbo-int8-convrot) |
| `minimax_h3_ref2va_viggle_pruned_int8_convrot.safetensors`、`viggle_animate_dmd_lora_r64.safetensors`、`text_cond/fixed_embed_fwd_anyframe.safetensors` | [drbaph/Viggle-Animate-ComfyUI](https://huggingface.co/drbaph/Viggle-Animate-ComfyUI) |
| `h3-realism-people-t2v-i2v-r2v.safetensors` | [fal/MiniMax-H3-Realism-People-LoRA](https://huggingface.co/fal/MiniMax-H3-Realism-People-LoRA) |
| `minimax_h3_hyperflow_8step_v1.0_comfyui.safetensors` | 不是直接下载的：是用 `tools/comfyui_setup/ComfyUI-HyperFlow-H3/convert.py` 把 [videorebirth/hyperflow](https://huggingface.co/videorebirth/hyperflow) 的 `minimax_h3_hyperflow_8step_v1.0.safetensors` 转出来的 |
| `minimax_h3_hybrid_b25-49_int8.safetensors`（以及 `…b15-49_int8`） | [smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models](https://huggingface.co/smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models) 里的 `minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors`（`…b15-49-int8`）：SHA256 与本机文件完全一致，只是名字不同，下载后要改成代码里用的 `minimax_h3_hybrid_b25-49_int8.safetensors` |
- 同一份官方 pruned ref2va 的其他低显存版（w4a8、NVFP4、GGUF）：
  [starsfriday/MiniMax-H3-w4a8](https://huggingface.co/starsfriday/MiniMax-H3-w4a8)（自定义加载器，仅 Linux）、
  [lilcheaty/MiniMax-H3-NVFP4](https://huggingface.co/lilcheaty/MiniMax-H3-NVFP4)、
  [Abiray/MiniMax-H3-Pruned-GGUF](https://huggingface.co/Abiray/MiniMax-H3-Pruned-GGUF)、
  [realrebelai/MiniMax-H3_GGUFs](https://huggingface.co/realrebelai/MiniMax-H3_GGUFs)、
  [Civitai 的 comfy-native ref2va 页面](https://civitai.com/models/2857809)。
  GGUF 要装 ComfyUI-GGUF 并改加载器，项目现在只有 Qwen 图像支持 GGUF（第 7 节），H3 主模型没接。
- Qwen-Image 2.1：官方权重在 ComfyUI 的模板 `image_qwen_image_2_1_image_edit` 里有下载入口。
- 作者自己的权重（Singularity、fused、Viggle 等）来源没有记录，16 GB 档用不到。

## 5. 安装本项目

```powershell
git clone <仓库地址> laza-cinema
cd laza-cinema
copy .env.example .env
```

打开 `.env`，至少填：

- `COMFYUI_OUTPUT_DIR`、`COMFYUI_INPUT_DIR`：对方 ComfyUI 的 `output` 和 `input` 文件夹。**必填**，
  后端要直接读这两个文件夹里的视频、点云和潜空间文件；不填，后端日志会报错，视频任务的结果取不回来。
- `H3_MACHINE_PROFILE`：留 `auto`，后端按 ComfyUI 报告的显存自动选（24 GB 以下为 `lowvram`）。
- `LLM_BASE_URL`：可留空，见下。

然后：

```powershell
.\start.ps1
python tools\check_install.py
```

`start.ps1` 会在新窗口里启动后端（第一次建 `.venv` 并装依赖）、前端（第一次 `npm install`，之后
`next build`）和 MCP。`tools/check_install.py` 检查 Python、Node、ffmpeg、ComfyUI 连通和版本、显存和内存、
目录配置、节点是否装全、模型文件是否都在，缺什么列什么。

浏览器打开 `http://localhost:4000`，第一次进入先**注册一个账号**，再建项目。

可选的 LLM：提示词翻译和优化用的是任何 OpenAI 兼容的本地服务（LM Studio、Ollama、vLLM），
在 `.env` 里写 `LLM_BASE_URL`。不写这两个功能不可用，其他不受影响。H3 导演台、提示词助手、主体描述
这几个用的是 NVIDIA NIM 云服务，要 `NV_API_KEY` 或在设置里填自己的 key。

## 6. 16 GB 机器上能用什么

`lowvram` 档位的具体行为在 `backend/machine_profile.py`：分辨率 864×480，VAE 分块解码，
「Singularity」自动换成它的 w4a8 版。

| 功能 | 状态 |
|---|---|
| 视频生成（T2VA / I2VA / Ref2VA / 首尾帧）、接续、局部修补、音视频桥 | 能用，「Singularity」用它自己的 w4a8 版 |
| 官方 `ref2va` 预设 | 能用，自动换成 `pruned_w4a8`（同一份权重的量化版） |
| 换机位（CrossView） | 能用，换成 w4a8 底模；**这条路径的画质没有测过**，量化权重叠 LoRA 有可能发灰 |
| 视频增强：ESRGAN、lms（原尺寸锐化） | 能用，ESRGAN 是默认 |
| 视频增强：H3 潜空间 | **已禁用**，要加载 21 GB 的 fused 底模 |
| 运动预设 `fused`、`hybrid`、`ref2va_full`、`hyperflow` | **已禁用**，21–34 GB，没有找到同一份权重的低显存版 |
| 换人（Viggle） | **已禁用**，权重 21 GB，没有找到小的版本 |
| 深度控制（ControlNet 2.0，走官方节点） | 能用：在官方 w4a8、Singularity w4a8 上用 864×480 出过片，画面正常、跟随深度图；**没在 16 GB 真机上测过内存**。需要 `model_patches/` 里的 2.0 文件，控制视频可用画布上的「深度视频」节点生成 |
| 生成图片、图片超清 | 能用；Qwen 图像和 H3 交替使用时内存吃紧，没有实测 |
| 音乐、音效、补帧、姿态 | 能用（权重小），没有实测 |

禁用的做法：后端在任务一开始就拒绝并说明原因；前端把对应的节点从面板里去掉、把预设按钮置灰。
`GET /machine-profile` 能看到当前档位和禁用清单。

**注意力补丁。** 16 GB 档默认用 `kjsage`，不用 `sol`：同一个 seed、同一个提示词、w4a8 加 ref2v turbo 8 步，864×480 下
`sol` 的人脸糊、融化，去掉补丁或用 `kjsage` 都是清楚的（2026-10-04 实测，作者逐条看过）。`sol` 在 1344×768 下
我的对比图里没有看到这个问题，所以工作站（1376×768）仍默认 `sol`。想改，在 `.env` 里写 `H3_ACCEL=kjsage`、`sol` 或留空（不打补丁）。
后端还有一道保险：**只要底模是 w4a8，不管请求里写的是不是 `sol`（包括画布节点上手动选的），都会自动换成 `kjsage` 并在后端日志里记一条警告**；int8 底模不受影响。

**还没在真实的 16 GB / 32 GB 机器上测过**的三件事（`tools/comfyui_setup/README.md` §6）：
一次 864×480 的 Ref2VA 渲染的内存峰值和耗时；一段接续生成（motion context）的潜空间往返；
文本编码时页面文件是否被用到。

## 7. Qwen-Image 2.1 的低显存权重（可选，没有实测）

默认用 INT8 版（7.3 GB 主模型 + 9.4 GB 文本编码器）。社区有更小的版本，用环境变量切换，不用改代码，
写在 `.env` 里：

```
QWEN_IMAGE_UNET=<放在 models/unet/ 下的 .gguf 文件名>
QWEN_IMAGE_CLIP=<更轻的 Qwen3-VL 8B 文本编码器，例如 qwen3vl_8b_w4a8.safetensors>
```

- GGUF：[realrebelai/Qwen-Image-2.1_GGUFs](https://huggingface.co/realrebelai/Qwen-Image-2.1_GGUFs)，
  Q2_K 到 Q8_0 六档，作者推荐 Q4_K_M-HQv3 作为默认。需要装 ComfyUI-GGUF 自定义节点，主模型放
  `models/unet/`。后端看到 `.gguf` 结尾就改用 `UnetLoaderGGUF` 加载。
- 文本编码器：Qwen3-VL 8B 另有 w4a8 版本（文章里提到，没有核对仓库）。
- 作者机器没有装 ComfyUI-GGUF，也没下载这些权重，所以这条路径只检查过生成的节点图，**没有真正跑过**。
  `tools/check_install.py` 会在你设了 `.gguf` 但没装节点时报错。

## 8. MCP 的 token

画布 MCP（端口 8004）给 AI 助手（例如 Claude Code）读写画布用。设了 token，每个请求都要带
`Authorization: Bearer <token>`，本机访问也一样。没设就没有任何认证，只在没人能连到这台机器时这样用。

**token 就是你自己生成的一串随机字符，没有注册或申请的地方。** 生成：

```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

用在三个地方，**必须是同一个值**：

1. 服务端：写进项目的 `.env`：`AI_CINEMA_MCP_TOKEN=<刚生成的值>`。后端和 MCP 服务重启时读取。
   系统环境变量里的同名变量优先于 `.env`。
2. 客户端（Claude Code）：它读的是启动它的 shell 的环境变量。写进用户环境变量并重开终端：
   ```powershell
   setx AI_CINEMA_MCP_TOKEN "<同一个值>"
   ```
3. 客户端配置：仓库根目录的 `.mcp.json` 是作者自己的（里面有他本机的路径），**不要直接用**，
   复制 `.mcp.json.example` 过来，里面写的是 `Bearer ${AI_CINEMA_MCP_TOKEN}`。或者用命令添加：
   ```powershell
   claude mcp add --transport http ai-cinema-canvas http://127.0.0.1:8004/mcp --header "Authorization: Bearer <同一个值>"
   ```

改了 token 后重启：`.\restart-mcp.ps1`（MCP）和 `.\restart-backend.ps1`（后端用它转发一键高清的请求）。

验证（在作者机器上实测过，401 和通过认证两种结果都对得上）：

```powershell
curl.exe -s -o NUL -w "%{http_code}" -X POST http://127.0.0.1:8004/mcp -H "Content-Type: application/json" -d "{}"
# 没带 token：401
curl.exe -s -o NUL -w "%{http_code}" -X POST http://127.0.0.1:8004/mcp -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "{}"
# 带对 token：不再是 401（这里的空请求体会得到 400，说明认证已经通过）
```

## 9. 网络和安全

- 后端、前端、MCP 都监听 `0.0.0.0`。只在局域网或 Tailscale 这样的私网里用；要放到公网，先在防火墙上
  限制来源，并且一定设 MCP token（第 8 节）。
- 工作室有账号系统（第一次进入时注册）。注册没有限制，所以不要把 4000 和 8003 暴露给不信任的人。
- `.env` 不入库（已在 `.gitignore`），里面有 key 和 token，不要发给别人。

## 10. 其他说明

- 影片内容不在仓库里。作者机器上的内容记在 `backend/workspaces/content_archive.db`（不入库）。
  对方是空平台，没有示例项目。
- `.mcp.json` 和 `AGENTS.md` 里还有作者本机的路径（`C:\Users\...`、`D:\Projects\blockout`），只影响
  Claude Code 这类 AI 助手，不影响启动工作室。
- 同一个 seed 和提示词，在 w4a8 版和作者用的 int8 版上不会出逐位相同的画面，换权重就是换了一个模型。
