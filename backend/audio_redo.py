"""Redo only the sound of a finished H3 render, keeping its picture.

The render's saved AV latent (H3_Latent_<tag>_00001_.safetensors, written by
MiniMaxH3MotionContextSaveLatent) is loaded, its picture frozen, and the audio
re-noised to `denoise` and denoised again for `steps` steps against that picture
(ComfyUI-H3-AudioRefine). Measured on C11a (2026-10-01, 5090, no cache):

  polish  4 steps @ 0.5   170 s   envelope vs the original 0.95, lines kept, level 2-5 dB lower
  reroll  8 steps @ 1.0   250 s   a new soundtrack (envelope 0.62); a spoken line came back
                                  as a whisper that Whisper could not hear, so keep the lines
                                  with audio locks when rerolling

The latent only fits the take that produced it, so everything that fixes its shape
is checked here before ComfyUI is asked to load it.
"""
from __future__ import annotations

import json
import struct
from pathlib import Path
from typing import Optional

PRESETS = {
    "polish": {"steps": 4, "denoise": 0.5},
    "reroll": {"steps": 8, "denoise": 1.0},
}
AUDIO_STEPS_PER_SECOND = 40      # audio latent steps per second of clip (490 for 12.25 s)
VIDEO_VAE_DOWNSCALE = 16


class AudioRedoError(ValueError):
    """The redo cannot be done as asked; the message says what to change."""


def resolve(mode: str, steps: Optional[int] = None, denoise: Optional[float] = None) -> dict:
    if mode not in PRESETS:
        raise AudioRedoError(f'mode is "polish" or "reroll", not {mode!r}')
    cfg = dict(PRESETS[mode], mode=mode)
    if steps:
        cfg["steps"] = int(steps)
    if denoise:
        cfg["denoise"] = float(denoise)
    if not 1 <= cfg["steps"] <= 20:
        raise AudioRedoError(f"steps {cfg['steps']} must be between 1 and 20")
    if not 0.05 <= cfg["denoise"] <= 1.0:
        raise AudioRedoError(f"denoise {cfg['denoise']} must be between 0.05 and 1.0")
    return cfg


def read_shapes(path: Path) -> dict:
    """Tensor shapes from a safetensors header, without torch or reading the data."""
    with open(path, "rb") as f:
        (size,) = struct.unpack("<Q", f.read(8))
        header = json.loads(f.read(size))
    return {k: tuple(v["shape"]) for k, v in header.items() if k != "__metadata__"}


def check_source_latent(path: Path, *, width: int, height: int, length_frames: int) -> None:
    """Refuse a latent that was not saved by a render of this size and length."""
    path = Path(path)
    if not path.is_file():
        raise AudioRedoError(
            f"the saved latent {path.name} is gone from the ComfyUI output folder; "
            "a clip that was edited, trimmed or re-encoded has none. Re-render the node first.")
    try:
        shapes = read_shapes(path)
    except Exception as e:                       # unreadable header
        raise AudioRedoError(f"{path.name} is not a readable H3 latent: {e}") from e
    video, audio = shapes.get("video"), shapes.get("audio")
    if not video or not audio or len(video) != 5 or len(audio) != 4:
        raise AudioRedoError(f"{path.name} does not hold the video + audio streams of an H3 render")
    got_h, got_w = video[3] * VIDEO_VAE_DOWNSCALE, video[4] * VIDEO_VAE_DOWNSCALE
    if (got_w, got_h) != (int(width), int(height)):
        raise AudioRedoError(
            f"{path.name} was saved at {got_w}x{got_h} but the node is {width}x{height}; "
            "the latent only fits the size of the render that saved it.")
    want = round(length_frames / 24.0 * AUDIO_STEPS_PER_SECOND)
    if abs(audio[3] - want) > 2:
        raise AudioRedoError(
            f"{path.name} holds {audio[3]} audio steps ({audio[3] / AUDIO_STEPS_PER_SECOND:.2f} s) but "
            f"{length_frames} frames need about {want}; the node's length changed since that render.")
