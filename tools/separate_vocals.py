"""Take the voice out of a recording (MelBand-RoFormer, Kim vocals) so a RefMod voice reference carries no background.

    python tools/separate_vocals.py <wav under backend/uploads> [output dir]

Runs the audio-separator CLI from .venv-audio (python -m venv .venv-audio; pip install "audio-separator[gpu]"
audioread). The vocals file lands next to the input's name in the output dir (default: backend/uploads); keep the
original too and register both as RefMod sources (tools/refmod_create.py, POST /refmods/sources).
Then cut the pieces' tails by hand: fade each piece out over ~0.2 s and end with ~0.6 s of silence.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / ".venv-audio" / "Scripts" / "audio-separator.exe"


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = ROOT / "backend" / "uploads" / sys.argv[1]
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "backend" / "uploads"
    models = ROOT / ".venv-audio" / "models"
    subprocess.run([str(CLI), str(src), "--model_filename", "vocals_mel_band_roformer.ckpt",
                    "--output_dir", str(out), "--model_file_dir", str(models),
                    "--single_stem", "Vocals", "--output_format", "WAV"], check=True)


if __name__ == "__main__":
    main()
