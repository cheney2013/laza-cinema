# Comfy Compiler (#15861) pushes MiniMax H3 into Windows shared GPU memory; runs get progressively slower (267 s → 730 s on the same graph)

**Repo:** Comfy-Org/ComfyUI  ·  **Labels:** Potential Bug, Windows, MiniMax H3

## Summary

After updating to a build that includes **#15861 Introduce Comfy Compiler (CORE-389)** (commit `804eb551`), the same MiniMax H3 Ref2VA graph on an RTX 5090 (32 GB) no longer stays inside dedicated VRAM. The ComfyUI process climbs to **27 GB dedicated + 23 GB shared GPU memory** and each successive run gets slower on an unchanged graph: 267 s → 308 s → 390 s for a 141‑frame render, and 730 s for a 73‑frame one. Starting ComfyUI with `--disable-comfy-compiler` restores the previous memory footprint and speed (A/B below).

## Environment

| | |
|---|---|
| ComfyUI | 0.34.0, master `250b2e95` (2026‑09‑04), includes `804eb551` (#15861) and `6e3c0bda` comfy-aimdo 0.5.2 |
| Launcher | ComfyUI Desktop (Windows), default flags, `--port 8189`, no `--lowvram`/`--highvram` |
| OS / driver | Windows 11 Pro 26200, NVIDIA driver 616.64 |
| GPU | RTX 5090, 32 607 MiB |
| PyTorch | 2.12.1+cu130 |
| comfy-aimdo / comfy-kitchen | 0.5.2 / 0.2.31, dynamic VRAM on (`aimdo_setup_hooks: installing 6 hooks`, `NVML pressure enabled`) |
| Model | `minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors` (UNET), `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (TE), int8 convrot video VAE, fp32 audio VAE |
| Graph | native MiniMaxH3ReferenceToVideo, 1376×768, 141 frames (also 73 and 362), 8 steps, 5 reference images scaled to 1376×768, `MiniMaxH3MemoryEfficientSolAttentionPatch` (also reproduced with the SageAttention patch) |

## Steps to reproduce

1. Launch ComfyUI (default flags) on a build containing `804eb551`.
2. Queue the same MiniMax H3 Ref2VA graph (1376×768, 141 frames, 8 steps) three or four times in a row without restarting.
3. Watch `Prompt executed in …` in the log and per‑process GPU memory:
   `Get-Counter '\GPU Process Memory(*)\Shared Usage','\GPU Process Memory(*)\Dedicated Usage'` (PowerShell) or Task Manager → GPU → Shared GPU memory.

## Observed

Log of one session (identical graph, only the prompt text differed; frame counts noted):

```
17:54:06  Prompt executed in 267.43 seconds   (141 f)
18:02:44  Prompt executed in 308.37 seconds   (141 f)
18:12:16  Prompt executed in 558.13 seconds   (141 f, SageAttention patch)
18:20:09  Prompt executed in 389.83 seconds   (141 f)
18:37:46  Prompt executed in 00:12:10         (73 f)
```

At that point the ComfyUI python process showed

```
GPU Process Memory  dedicated usage  27.07 GB
GPU Process Memory  shared usage     22.81 GB
process working set                  32.06 GB
```

`POST /free {"unload_models":true,"free_memory":true}` drops it to 3.8 GB VRAM / 1 GB RSS, and the next cold run is fast again (73 f in 145 s; 362 f in 799 s), so the growth is tied to the resident model/allocator state, not to the graph.

Earlier the same day, on the build before `804eb551` (reflog: updated 2026‑09‑05 14:40 local), the same 141‑frame graph took 100–250 s run after run with no growth, and the previous night 362‑frame renders completed every ~7 minutes back to back.

## A/B with `--disable-comfy-compiler`

Same graph (MiniMaxH3ReferenceToVideo, 1376x768, **362 frames**, 8 steps, 5 reference images, Sol attention patch), ComfyUI Desktop restarted before each arm so both start cold; only the flag differs. Times are ComfyUI's own `Prompt executed in`, which includes the model load.

| flags | wall | s/it (steps 3-7) | GPU memory.used peak (nvidia-smi, 2 s) | process GPU memory after the run | process working set after the run | log |
|---|---|---|---|---|---|---|
| `--disable-comfy-compiler` | 367.4 s | 38.9 | 23.9 GB | 7.5 GB in use (`/system_stats` vram_free 26.6 of 34.2 GB) | n/a | no compiler lines |
| default (compiler on) | 401.4 s | 42.0 | n/a (sampler not attached to this arm) | **16.5 GB dedicated + 25.0 GB shared** | **42.5 GB** | `Comfy model compiler graph breaks: 3` |

So on a fresh process a single run with the compiler on is ~9 % slower and leaves 25 GB in shared GPU memory; with the compiler off the same run stays inside dedicated VRAM at a 23.9 GB peak. In a long-lived process the shared-memory residue is what makes the following runs progressively slower (log excerpt above).

## Expected

Repeated runs of an unchanged graph should take the same time, and a model that fits in 32 GB should not spill 20+ GB into shared (system) memory once the compiler is enabled. The PR description says the memory compiler should *reduce* allocator waste, so this looks like the malloc‑graph / CUDA‑graph path retaining allocations across runs (or the "Comfy model compiler graph breaks" path re‑recording) rather than an inherent cost.

## Notes

- The compiler-on arm logs `Comfy model compiler graph breaks: 3` for a single MiniMax H3 run; the earlier long-lived session (Desktop-launched, INFO level) showed no compiler lines at all, so it is unclear whether the malloc graph was re-recorded on each run there.
- `--disable-cuda-graphs` alone was not tested separately; happy to run it if useful.
- Related but different: #16002 (MiniMax Music 3 crash with CUDA Graph + Dynamic VRAM), #15759 (memory leaks post‑update, pre‑compiler).

## 2026-09-07 追加：VHS 无音轨 mp4 弄死 prompt_worker

现象：ComfyUI HTTP 正常应答、队列显示 running，但什么都不执行；我们的长片段停在 0%。
根因：`comfy_execution/caching.py` 释放内存时 `scan_list_for_ram_usage` 会遍历缓存里**上一个作业**的输出；
VideoHelperSuite 的 `LazyAudioMap` 一被遍历就调 ffmpeg 抽音，源 mp4（viggle_facemasked.mp4）没有音轨 → 抛异常
→ `prompt_worker` 线程死亡，之后所有作业永远排队。
本地补丁（都留了 `.bak_20260907`）：
- `custom_nodes/comfyui-videohelpersuite/videohelpersuite/utils.py`：`LazyAudioMap._load()` 抽音失败记 warning、当作空映射。
- `comfy_execution/caching.py`：`scan_list_for_ram_usage(cache_entry.outputs)` 包 try/except，扫不动的条目跳过（加了 `import logging`）。
两处都是第三方文件，更新 ComfyUI / VHS 会被覆盖，覆盖后按上面重打。
