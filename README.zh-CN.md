<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/laza-logo.svg">
    <img src="frontend/public/laza-logo-light.svg" alt="LAZA CINEMA STUDIO" width="420">
  </picture>
</p>

<p align="center"><a href="README.md">English</a> · <b>简体中文</b> · <a href="README.ja.md">日本語</a></p>

<p align="center">一张无限画布，把视频、图像、音频的生成和剪辑接在一起。</p>

LAZA CINEMA STUDIO 是一个本地运行的影视制作工作室：在画布上用节点连线组织镜头，后端把节点翻译成 ComfyUI 工作流，在你自己的显卡上出片。画布本身就是项目的唯一记录——提示词、参考图的顺序、种子、每次渲染的结果都留在节点上。

当前版本见 [`VERSION`](VERSION)。仓库只有**平台**（画布、剪辑台、后端、MCP）；影片内容（提示词、分镜、素材）和模型权重都不在里面。

## 能做什么

- **视频生成**：MiniMax H3，支持参考图生视频（Ref2VA）、首尾帧、文生视频，镜头链式续接。
- **图像生成与编辑**：Qwen-Image 2.1，无图输入时文生图，有图输入时改图。
- **放大与插帧**：视频放大（H3 潜空间放大）、图像放大、RIFE 插帧。
- **画面处理**：视频剪切与编辑窗口、换装、换人、姿态、重新取角度、深度视频（Depth Anything V2，可作运镜参考）。
- **声音**：音频生成与精修，音色锁定。
- **剪辑台**：把画布上的片段拖进时间线，拼接、微调接缝。
- **MCP 接口**：AI 助手可以通过画布 MCP 读取和修改项目，渲染结果同样写回画布。

## 需要什么

| 项 | 要求 |
|---|---|
| 系统 | Windows 10/11（启动脚本是 PowerShell） |
| 显卡 | NVIDIA 16 GB 显存起；50 系和 40 系。**40 系没有在真机上跑过，只在 5090 上测过** |
| 内存 | 32 GB，页面文件至少 32 GB |
| 硬盘 | 100 GB 以上空闲 |
| 软件 | Python 3.12、Node.js 20+、Git、ffmpeg 和 ffprobe（在 PATH 里）、ComfyUI |

30 GB 以上显存的机器把 `H3_MACHINE_PROFILE` 设成 `workstation`（或留 `auto`）即可跑全部功能；16 GB 机器会自动换成低显存配置。

## 快速开始

完整步骤（安装 ComfyUI、节点包、模型文件、常见问题）在 **[docs/DEPLOY.md](docs/DEPLOY.md)**，模型文件清单在 [docs/H3_WEIGHTS.md](docs/H3_WEIGHTS.md)。大致顺序：

```powershell
# 1. 装好 ComfyUI 和它的自定义节点（一键脚本，见 DEPLOY.md 第 2、3 节）
python tools\install_comfyui_nodes.py --comfyui C:\ComfyUI

# 2. 把模型权重放进 ComfyUI\models（见 DEPLOY.md 第 4 节）

# 3. 配置并启动本项目
copy .env.example .env
.\start.ps1

# 4. 检查环境
python tools\check_install.py
```

启动后：

| 组件 | 地址 |
|---|---|
| 前端（画布） | http://127.0.0.1:4000 |
| 后端 API | http://127.0.0.1:8003 |
| ComfyUI | http://127.0.0.1:8188 |
| 画布 MCP（可选） | http://127.0.0.1:8004 |

后端的 `GET /version` 返回版本号和提交，页面里的版本标签读的是同一个来源。

## 接入 AI 助手（画布 MCP）

画布 MCP 让 AI 助手（例如 Claude Code）读写项目。`start.ps1` 会在 8004 端口的 `/mcp` 启动它；第一次运行会按 `backend/requirements-mcp.txt` 建一个单独的虚拟环境 `backend/.venv-mcp`（它需要比后端更新的 pydantic）。

1. 生成 token（就是一串随机字符，没有注册的地方），**同一个值**用在两处：

   ```powershell
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

   - 服务端：写进 `.env` 的 `AI_CINEMA_MCP_TOKEN=<值>`，然后运行 `.\restart-mcp.ps1` 和 `.\restart-backend.ps1`
   - 客户端：`setx AI_CINEMA_MCP_TOKEN "<值>"`，重开终端
2. 把服务注册到客户端：把 `.mcp.json.example` 复制成 `.mcp.json`，或者：

   ```powershell
   claude mcp add --transport http ai-cinema-canvas http://127.0.0.1:8004/mcp --header "Authorization: Bearer <值>"
   ```
3. 验证：不带头的请求必须返回 401。

   ```powershell
   curl.exe -s -o NUL -w "%{http_code}" -X POST http://127.0.0.1:8004/mcp -H "Content-Type: application/json" -d "{}"
   ```

助手使用它的方式（服务端自己的说明里也写了）：

- 先用 `get_canvas(summary=True)` 读；要看某个节点的全部内容，传 `node_ids=[...]`。
- 只用 `apply_canvas_operations` 改；渲染用 `run_canvas_node`，再 `refresh_canvas_node`。不要直接把渲染提交给 ComfyUI，否则画布就不再是记录。
- 连入一个节点的边的顺序就是它的 `<Picture N>` 编号。`get_node_catalog` 列出节点类型和字段。
- 没设 token 时服务接受所有请求，只在别人连不到的机器上这样用。细节见 [docs/DEPLOY.md](docs/DEPLOY.md) 第 8 节。

## 仓库结构

```
frontend/        Next.js 画布和剪辑台
backend/         FastAPI 后端、工作流构建器、画布 MCP
comfyui_nodes/   本项目自带的 ComfyUI 节点，以及 third_party/ 里随仓库带的第三方节点包
tools/           安装检查、节点安装、质检脚本
docs/            部署说明、权重清单
```

## 说明

- 模型权重不随仓库分发，来源和文件名见 [docs/H3_WEIGHTS.md](docs/H3_WEIGHTS.md) 和 DEPLOY.md。
- `comfyui_nodes/third_party/` 里的节点包来自各自的作者，保留了原有的文件；用到它们之前请先看各包自己的说明。
- 本项目用于非商业用途。
- 在干净的机器上完整装一遍的流程还没有走过，DEPLOY.md 里标注了哪些步骤没有实测，遇到问题欢迎提 issue。
