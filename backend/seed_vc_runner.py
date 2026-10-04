"""Run Seed-VC's inference.py under its own venv, with torchaudio's file I/O on soundfile.

torchaudio 2.9+ routes load/save through TorchCodec, which is not installed there
(its Windows wheel wants FFmpeg shared libraries on PATH). Seed-VC only needs to
read and write plain wav, so both calls are pointed at soundfile before its
script runs. Arguments are passed through unchanged; cwd must be the Seed-VC
checkout (speech.convert_voice sets it).
"""
import os
import runpy
import sys

import soundfile
import torch
import torchaudio


def _save(path, tensor, sample_rate, *args, **kwargs):
    data = tensor.detach().cpu().float().numpy()
    soundfile.write(path, data.T if data.ndim == 2 else data, int(sample_rate))


def _load(path, *args, **kwargs):
    data, sample_rate = soundfile.read(path, dtype="float32", always_2d=True)
    return torch.from_numpy(data.T.copy()), sample_rate


torchaudio.save = _save
torchaudio.load = _load

sys.path.insert(0, os.getcwd())
sys.argv = ["inference.py", *sys.argv[1:]]
runpy.run_path(os.path.join(os.getcwd(), "inference.py"), run_name="__main__")
