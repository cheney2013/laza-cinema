# ComfyUI-H3-ClipPreview

<p align="center"><b>English</b> · <a href="README.zh-CN.md">简体中文</a></p>

Whole-clip sampling preview for MiniMax H3, decoded on the CPU.

While an H3 render samples, the pack takes the sampler's current latent after every step and decodes
the **entire clip** with the `taeh3` tiny autoencoder in a separate low-priority process. The result
is written as a short MP4, so you watch the video take shape step by step instead of a single
colour-block frame. Decoding runs on the CPU, so the preview needs no VRAM; the only GPU-side cost is one
device-to-host copy of the latent per step.

## Install

1. Copy this folder to `ComfyUI/custom_nodes/`.
2. Place `taeh3.safetensors` in `ComfyUI/models/vae_approx/` (the official taeh3 weights from
   [madebyollin/taehv](https://github.com/madebyollin/taehv)).
3. Make sure `ffmpeg` is on `PATH`.
4. Restart ComfyUI.

The pack adds no nodes: it wraps ComfyUI's preview callback and applies only to models whose latent
format is MiniMax H3. Other models are untouched.

## Output

For prompt `<id>` and sampler step `<n>`:

    output/h3_clip_preview/<id>_s<nn>.mp4

Each clip is announced on the ComfyUI websocket:

```json
{"type": "h3_clip_preview",
 "data": {"prompt_id": "...", "step": 7, "total": 8, "filename": "..._s07.mp4", "subfolder": "h3_clip_preview"}}
```

Older steps of a prompt are deleted as new ones arrive. The last sampler step is not decoded (the real
decode follows immediately).

## Behaviour

- One decode at a time. A step that arrives while the worker is busy replaces the queued one, so the
  sampler never waits.
- Half spatial resolution, 24 fps, H.264 `ultrafast` CRF 28, 8 CPU threads, below-normal priority.
- Frames stream to ffmpeg one at a time; peak memory stays low even for long clips.
- The worker process exits once the prompt's sampling ends, returning its memory before the next model loads.
- After three consecutive failed decodes (missing `taeh3`, ffmpeg broken) the pack stops trying.

## Settings

| Setting | Effect |
|---|---|
| `H3_CLIP_PREVIEW=0` (environment, before starting ComfyUI) | Disable the pack |
| `extra_data: {"h3_clip_preview": false}` on a prompt | Skip the preview for that prompt |

## License

Apache-2.0.
