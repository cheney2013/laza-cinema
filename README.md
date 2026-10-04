<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/laza-logo.svg">
    <img src="frontend/public/laza-logo-light.svg" alt="LAZA CINEMA STUDIO" width="420">
  </picture>
</p>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a></p>

<p align="center">One infinite canvas that ties video, image and audio generation and editing together.</p>

LAZA CINEMA STUDIO is a film-making studio that runs on your own machine. You lay out shots on a canvas by wiring nodes together; the backend turns the nodes into ComfyUI workflows and renders on your own GPU. The canvas is the single record of a project: prompts, the order of reference images, seeds and every render stay on the nodes.

See [`VERSION`](VERSION) for the current version. This repository holds the **platform** only (canvas, cut room, backend, MCP). Film content (prompts, storyboards, footage) and model weights are not in it.

## What it does

- **Video generation**: MiniMax H3 with reference-to-video (Ref2VA), first/last frame and text-to-video, with chained continuation between shots.
- **Image generation and editing**: Qwen-Image 2.1. No image input means text-to-image; with an image it edits that image.
- **Upscaling and interpolation**: video upscaling (H3 latent upscaler), image upscaling, RIFE frame interpolation.
- **Picture tools**: video trim and edit windows, wardrobe swap, character swap, pose, re-angle, depth video (Depth Anything V2, usable as a camera reference).
- **Sound**: audio generation and refinement, with voice locks.
- **Cut room**: drag clips from the canvas onto a timeline, join them and fine-tune the seams.
- **MCP interface**: an AI assistant can read and edit a project through the canvas MCP; renders are written back to the canvas.

## Requirements

| Item | Requirement |
|---|---|
| OS | Windows 10/11 (the launch scripts are PowerShell) |
| GPU | NVIDIA, 16 GB VRAM or more; RTX 50 and 40 series. **The 40 series has not been run on real hardware; it was only tested on a 5090** |
| RAM | 32 GB, with a page file of at least 32 GB |
| Disk | 100 GB or more free |
| Software | Python 3.12, Node.js 20+, Git, ffmpeg and ffprobe on PATH, ComfyUI |

On machines with 30 GB of VRAM or more, set `H3_MACHINE_PROFILE` to `workstation` (or leave it on `auto`) to use every feature; a 16 GB machine switches to the low-VRAM profile automatically.

## Quick start

The full guide (installing ComfyUI, node packs, model files, troubleshooting) is **[docs/DEPLOY.md](docs/DEPLOY.md)**, and the model file list is [docs/H3_WEIGHTS.md](docs/H3_WEIGHTS.md). Both documents are currently **in Chinese only**. The order of steps:

```powershell
# 1. Install ComfyUI and its custom nodes (one-shot script, DEPLOY.md sections 2 and 3)
python tools\install_comfyui_nodes.py --comfyui C:\ComfyUI

# 2. Put the model weights into ComfyUI\models (DEPLOY.md section 4)

# 3. Configure and start this project
copy .env.example .env
.\start.ps1

# 4. Check the environment
python tools\check_install.py
```

Once running:

| Component | Address |
|---|---|
| Frontend (canvas) | http://127.0.0.1:4000 |
| Backend API | http://127.0.0.1:8003 |
| ComfyUI | http://127.0.0.1:8188 |
| Canvas MCP (optional) | http://127.0.0.1:8004 |

`GET /version` on the backend returns the version and commit; the version chip in the UI reads from the same source.

## Connecting an AI agent (canvas MCP)

The canvas MCP server lets an AI agent (for example Claude Code) read and edit projects. `start.ps1` starts it on port 8004 at `/mcp`; the first run builds its own virtual environment `backend/.venv-mcp` from `backend/requirements-mcp.txt` (it needs a newer pydantic than the backend).

1. Generate a token (any random string; there is nowhere to register one) and use the **same value** in two places:

   ```powershell
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

   - server: `AI_CINEMA_MCP_TOKEN=<value>` in `.env`, then `.\restart-mcp.ps1` and `.\restart-backend.ps1`
   - client: `setx AI_CINEMA_MCP_TOKEN "<value>"`, then reopen the terminal
2. Register the server with the client, either by copying `.mcp.json.example` to `.mcp.json`, or:

   ```powershell
   claude mcp add --transport http ai-cinema-canvas http://127.0.0.1:8004/mcp --header "Authorization: Bearer <value>"
   ```
3. Check it: a request without the header must return 401.

   ```powershell
   curl.exe -s -o NUL -w "%{http_code}" -X POST http://127.0.0.1:8004/mcp -H "Content-Type: application/json" -d "{}"
   ```

How an agent should work with it (the server also states this in its own instructions):

- Read first with `get_canvas(summary=True)`; pass `node_ids=[...]` for one node in full.
- Edit only with `apply_canvas_operations`; render with `run_canvas_node`, then `refresh_canvas_node`. Do not submit renders to ComfyUI directly, or the canvas stops being the record.
- The order of edges into a node is its `<Picture N>` numbering. `get_node_catalog` lists the node types and their fields.
- Without a token the server accepts every request; only run it that way on a machine nobody else can reach. Details: [docs/DEPLOY.md](docs/DEPLOY.md) section 8 (Chinese).

## Skills and reference an agent needs

To write video prompts or break down scenes, an agent needs two things. **The skill is not bundled in this repository.**

| What | Where it comes from | Used for |
|---|---|---|
| `h3-prompt-writing` skill | **Official, by MiniMax**: [MiniMax-AI/MiniMax-H3 › skills/h3-prompt-writing](https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills/h3-prompt-writing) | the MiniMax H3 prompt format (field names, section order, timing notation) |
| Enhanced specification | By WarmBloodAban, published with the Singularity weights: [Minimax-h3_Singularity on Hugging Face](https://huggingface.co/WarmBloodAban/Minimax-h3_Singularity/tree/main) (Apache-2.0 on the model page). A copy is kept in [docs/](docs/MiniMax_H3_Singularity_Prompt_Writing_Specification_Enhanced_EN.md). It is **not** an official MiniMax document | the writing rules: reference roles, action chains, camera, lighting, acting, failure modes, checklist |

Install the official skill with the [skills CLI](https://github.com/vercel-labs/skills); it goes into the agent's skills folder (for Claude Code, `~/.claude/skills/`):

```bash
npx skills add https://github.com/MiniMax-AI/MiniMax-H3 --skill h3-prompt-writing
```

[`CLAUDE.md`](CLAUDE.md) says when each is required (every H3 prompt: skill plus the whole specification) and holds the rest of the working rules; [`AGENTS.md`](AGENTS.md) covers working with several agents.

## Repository layout

```
frontend/        Next.js canvas and cut room
backend/         FastAPI backend, workflow builders, canvas MCP
comfyui_nodes/   ComfyUI nodes of this project, plus third-party packs vendored under third_party/
tools/           install checks, node installer, quality-check scripts
docs/            deployment guide, weight list
```

## Notes

- Model weights are not distributed with the repository. Sources and file names are in [docs/H3_WEIGHTS.md](docs/H3_WEIGHTS.md) and DEPLOY.md.
- The packs under `comfyui_nodes/third_party/` come from their own authors and keep their original files; read each pack's own notes before using it.
- This project is for non-commercial use.
- A complete install on a clean machine has not been walked through yet; DEPLOY.md marks the steps that were not tested. Please open an issue if you hit a problem.
