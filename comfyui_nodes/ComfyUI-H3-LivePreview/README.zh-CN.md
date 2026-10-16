# ComfyUI-H3-LivePreview

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

MiniMax H3 的整段视频采样预览，在 CPU 上解码。

H3 渲染采样时，本包在每一步取出采样器当前的潜变量，交给一个独立的低优先级进程，用 `taeh3` 微型自编码器解码**整段视频**，写成一个短 MP4。这样可以看到画面随采样逐步成形，而不是只有一帧色块。解码在 CPU 上运行，不占显存；GPU 一侧只有每步一次潜变量的设备到主机拷贝。

## 安装

1. 把本文件夹复制到 `ComfyUI/custom_nodes/`。
2. 把 `taeh3.safetensors` 放进 `ComfyUI/models/vae_approx/`（官方 taeh3 权重，来自 [madebyollin/taehv](https://github.com/madebyollin/taehv)）。
3. 重启 ComfyUI。编码使用 PyAV（`av`），ComfyUI 本身已要求安装，不需要另装 ffmpeg。

## 使用

不需要往工作流里加任何东西。安装本包后，每个 MiniMax H3 采样器在采样时，都会在它自己的节点上显示片段逐步成形：节点底部出现一个预览区，每一步刷新一次。任务结束后，预览区移除，节点恢复原来的大小。采样器在子图里时，需要点进子图才能看到。

只对潜空间格式为 MiniMax H3 的模型生效，其他模型不受影响。

本包依赖 ComfyUI 的几个内部接口（已在 ComfyUI 0.38.0 上验证）。缺少任何一个时，会在日志里写明缺哪个并保持停用。

## 输出

对于任务 `<id>` 与采样步 `<n>`：

    output/h3_live_preview/<id>_s<nn>.mp4

每个片段会在 ComfyUI 的 WebSocket 上发出通知：

```json
{"type": "h3_live_preview",
 "data": {"prompt_id": "...", "step": 7, "total": 8, "filename": "..._s07.mp4", "subfolder": "h3_live_preview"}}
```

同一任务较早的步骤会在新片段到达时删除。最后一个采样步不解码（真正的解码紧随其后）。

## 行为

- 同一时刻只解一个。解码进行时到达的新步骤会替换排队中的旧步骤，采样器从不等待。
- 半分辨率，24 fps，H.264 `ultrafast` CRF 28（PyAV 构建不带 x264 时改用 MPEG-4），各平台都降低进程优先级。
- CPU 线程数：核数的一半，最多 8。
- 帧逐帧流式送入编码器，长片段的峰值内存也很低。
- 任务采样结束后解码进程退出，在下一个模型载入前归还内存。
- 连续三次解码失败（例如缺少 `taeh3`）后，本包不再尝试。

## 设置

| 设置 | 作用 |
|---|---|
| `H3_LIVE_PREVIEW=0`（环境变量，启动 ComfyUI 前设置） | 关闭本包 |
| `H3_LIVE_PREVIEW_SCALE=quarter` | 预览分辨率取渲染的四分之一（默认二分之一），解码约快四倍 |
| 任务的 `extra_data: {"h3_live_preview": false}` | 对该任务不做预览 |
| `H3_LIVE_PREVIEW_THREADS=<n>` | 解码使用的 CPU 线程数 |
| `H3_LIVE_PREVIEW_MIN_FREE_GB=<n>`（默认 8） | 可用内存低于该值时跳过该步；解码进程约占 5 GB |

## 许可证

Apache-2.0。
