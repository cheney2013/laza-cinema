# ComfyUI-H3-LivePreview

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
3. Restart ComfyUI. Encoding uses PyAV (`av`), which ComfyUI already requires; no separate ffmpeg is needed.

## Use

There is nothing to add to a workflow. Once the pack is installed, every MiniMax H3 sampler shows the clip
taking shape on its own node while it samples: a preview area appears at the bottom of the sampler node and is
refreshed every step. When the run ends, the preview is removed and the node returns to its size. If the sampler
sits inside a subgraph, open the subgraph to see it.

Only models whose latent format is MiniMax H3 are affected; other models are untouched.

The pack relies on a few ComfyUI internals (verified on ComfyUI 0.38.0). If one is missing it logs which and stays
inactive.

## Output

For prompt `<id>` and sampler step `<n>`:

    output/h3_live_preview/<id>_s<nn>.mp4

Each clip is announced on the ComfyUI websocket:

```json
{"type": "h3_live_preview",
 "data": {"prompt_id": "...", "step": 7, "total": 8, "filename": "..._s07.mp4", "subfolder": "h3_live_preview"}}
```

Older steps of a prompt are deleted as new ones arrive. The last sampler step is not decoded (the real
decode follows immediately).

## Behaviour

- One decode at a time. A step that arrives while the worker is busy replaces the queued one, so the
  sampler never waits.
- Half spatial resolution, 24 fps, H.264 `ultrafast` CRF 28 (MPEG-4 if the PyAV build has no x264), lowered process priority on every platform.
- CPU threads: half the cores, at most 8.
- Frames stream to the encoder one at a time; peak memory stays low even for long clips.
- The worker process exits once the prompt's sampling ends, returning its memory before the next model loads.
- After three consecutive failed decodes (for example a missing `taeh3`) the pack stops trying.

## Settings

There is nothing to configure. To skip the preview for one prompt, queue it with `extra_data: {"h3_live_preview": false}`; to turn it off altogether, disable or remove the pack.

## License

Apache-2.0.
