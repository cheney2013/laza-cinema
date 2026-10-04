"""
Cut an H3 chain latent to its first N frames, without decoding and re-encoding.

A cut clip (a trim at a quiet point) has no latent of its own, so the next shot that
carries on from it reads its pictures and the model re-encodes them. The video
latent's time axis is 5n+2 for a 17n+5-frame clip (209 frames -> 62, 175 -> 52), so a
latent can be cut exactly at those lengths: keep the first 5n+2 time steps. The audio
latent runs at 40 steps a second (209 frames -> 348), cut to match.

Checked on C10 (2026-10-02): the cut latent decodes to the first 175 frames of the
original within the VAE's own noise (45.7 dB against the served clip, 46 dB for the
uncut latent; the first ~100 frames identical to the uncut decode), audio correlation
0.9997. No torch or safetensors package needed: the file is a JSON header plus raw
little-endian tensors.
"""
from __future__ import annotations

import argparse
import json
import os
import struct
from pathlib import Path

import numpy as np

FPS = 24.0
AUDIO_STEPS_PER_SECOND = 40.0
DTYPES = {"F32": np.float32, "F16": np.float16, "BF16": None}


def on_grid(frames: int) -> bool:
    return frames >= 5 and (frames - 5) % 17 == 0


def video_steps(frames: int) -> int:
    """Time steps of the video latent for a 17n+5-frame clip."""
    if not on_grid(frames):
        raise ValueError(f"{frames} frames is not on the 17n+5 grid (5, 22, 39, ... 175, 192, 209 ...)")
    return (frames - 5) // 17 * 5 + 2


def audio_steps(frames: int) -> int:
    """Audio latent steps for a clip of `frames`: the NEAREST step to 5/3 of the frame count.

    H3 rounds its audio grid to the nearest step, not down (209 -> 348, 294 -> 490, 175 -> 292).
    The motion-context node reads the grid back as `steps - 5/3 * frames` and accepts only
    0, +1/3 and -1/3; a cut that rounds down lands at -2/3 and it warns "audio grid is
    unexpected" and assumes no overhang (seen 2026-10-02 with the first 175-frame cut)."""
    return int(round(frames * AUDIO_STEPS_PER_SECOND / FPS))


def read(path: Path) -> tuple[dict, dict[str, np.ndarray]]:
    raw = path.read_bytes()
    size = struct.unpack("<Q", raw[:8])[0]
    header = json.loads(raw[8:8 + size])
    base = 8 + size
    tensors = {}
    for name, info in header.items():
        if name == "__metadata__":
            continue
        dtype = DTYPES.get(info["dtype"])
        if dtype is None:
            raise ValueError(f"{name}: dtype {info['dtype']} not handled")
        a, b = info["data_offsets"]
        tensors[name] = np.frombuffer(raw[base + a:base + b], dtype=dtype).reshape(info["shape"])
    return header.get("__metadata__") or {}, tensors


def write(path: Path, metadata: dict, tensors: dict[str, np.ndarray]) -> None:
    header: dict = {}
    if metadata:
        header["__metadata__"] = metadata
    offset = 0
    blobs = []
    names = {np.dtype(np.float32): "F32", np.dtype(np.float16): "F16"}
    for name, arr in tensors.items():
        data = np.ascontiguousarray(arr).tobytes()
        header[name] = {"dtype": names[arr.dtype], "shape": list(arr.shape), "data_offsets": [offset, offset + len(data)]}
        offset += len(data)
        blobs.append(data)
    head = json.dumps(header, separators=(",", ":")).encode()
    head += b" " * ((8 - len(head) % 8) % 8)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "wb") as fh:
        fh.write(struct.pack("<Q", len(head)))
        fh.write(head)
        for blob in blobs:
            fh.write(blob)
    os.replace(tmp, path)


def slice_latent(src: Path, frames: int, dst: Path) -> dict:
    metadata, tensors = read(src)
    v, a = tensors["video"], tensors["audio"]
    nv, na = video_steps(frames), audio_steps(frames)
    if nv > v.shape[2]:
        raise ValueError(f"{src.name} has {v.shape[2]} video steps, {frames} frames needs {nv}")
    if na > a.shape[3]:
        raise ValueError(f"{src.name} has {a.shape[3]} audio steps, {frames} frames needs {na}")
    cut = {"video": v[:, :, :nv], "audio": a[:, :, :, :na]}
    write(dst, metadata, cut)
    return {"src": src.name, "dst": dst.name, "frames": frames,
            "video": [list(v.shape), list(cut["video"].shape)], "audio": [list(a.shape), list(cut["audio"].shape)]}


def latent_video_steps(path: Path) -> int:
    """Time steps of a saved latent's video tensor, read off the header only."""
    with open(path, "rb") as fh:
        size = struct.unpack("<Q", fh.read(8))[0]
        header = json.loads(fh.read(size))
    return int(header["video"]["shape"][2])
