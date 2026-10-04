"""Speech for the canvas's audio node: H3 speaks a line, Seed-VC changes a voice.

H3 has no audio-only mode, so a line is spoken by rendering a small clip of one
person saying it and keeping only the sound. The picture is a still, close-miked
booth so nothing on screen adds sound of its own.

Changing the voice on existing speech is not something H3 can do while keeping
the words and their timing, so that goes through Seed-VC (v1, f0-conditioned
44.1 kHz model), run as a child process from its own venv: its torch is a CUDA
build and the backend's is not, and a crash in it cannot take the backend down.
"""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
import tempfile
from pathlib import Path

SEED_VC_DIR = Path(os.environ.get("SEED_VC_DIR", r"D:\third_party\seed-vc"))
SEED_VC_PYTHON = Path(os.environ.get("SEED_VC_PYTHON", str(SEED_VC_DIR / ".venv" / "Scripts" / "python.exe")))

# The picture is thrown away; a small frame keeps the render cheap.
SPEECH_WIDTH = 640
SPEECH_HEIGHT = 352
FPS = 24

_CJK = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]")
_LATIN_WORD = re.compile(r"[A-Za-z0-9']+")

# Used when the voice is described but no line is given (convert mode builds its
# timbre sample from the description alone).
SAMPLE_LINE_ZH = "今天的风有点大，我们先进屋坐一会儿，等雨停了再走吧。"


def detect_language(text: str) -> str:
    if re.search(r"[\u3040-\u30ff]", text):
        return "Japanese"
    if re.search(r"[\uac00-\ud7af]", text):
        return "Korean"
    if _CJK.search(text):
        return "Chinese"
    return "English"


def snap_length(frames: int) -> int:
    """H3 lengths sit on the 17k+5 grid."""
    frames = max(22, int(frames))
    return frames + (5 - frames % 17) % 17


def estimate_frames(text: str) -> int:
    """A length that fits the line at a calm pace, plus room either side."""
    cjk = len(_CJK.findall(text))
    words = len(_LATIN_WORD.findall(_CJK.sub(" ", text)))
    pauses = len(re.findall(r"[，,。.！!？?；;…]", text))
    seconds = cjk * 0.24 + words * 0.36 + pauses * 0.25 + 1.4
    return snap_length(round(max(2.0, seconds) * FPS))


def _clean(value: str | None) -> str:
    return " ".join(str(value or "").split())


def build_speech_prompt(text: str, voice_description: str = "", delivery: str = "",
                        language: str = "", has_ref_audio: bool = False) -> str:
    """The prompt for one speaker saying one line in a quiet booth.

    Without a reference it is a T2VA prompt; with one it is the six-section
    full-reference form and <Audio 1> is the timbre reference for (S1).
    """
    text = str(text or "").strip()
    if not text:
        raise ValueError("speech needs a line to speak")
    language = language or detect_language(text)
    voice = _clean(voice_description)
    delivery = _clean(delivery)
    speaker = f"the speaker, {voice}," if voice else "the speaker"
    how = f" {delivery}," if delivery else ""
    timbre = " in the voice timbre referenced from <Audio 1>," if has_ref_audio else ""

    shot = (
        "[Shot 1] Live-action, cinematic, a static medium close-up frames one person seated "
        "behind a studio microphone inside a small recording booth lined with grey acoustic "
        "foam, lit by a soft key light from the front left. The camera holds a static shot "
        "for the whole clip. The person sits relaxed with the lips closed, draws one short "
        f"breath through the nose, then {speaker} (S1){timbre}{how} says: "
        f"<d>[{language}] {text}</d> After the last word the person closes the lips and "
        "stays still, eyes resting on the microphone, until the shot ends."
    )
    soundscape = ("Dry, close-miked room tone of the sound-treated booth sits quietly under "
                  "the voice, with one soft inhale before the first word.")

    if not has_ref_audio:
        return (f"integrated_multimodal_description: {shot}\n\n"
                f"overall_soundscape: {soundscape}\n\n"
                "non_diegetic_music: N/A")

    voice_def = voice or "the single speaker in the booth"
    return (
        "subject_definitions:\n"
        f"<Audio 1> is the voice-timbre reference for {voice_def} (S1).\n\n"
        "summary:\n"
        "[reference generation + audio reference] One person in a recording booth speaks a "
        "single line to a microphone, using <Audio 1> as the voice-timbre reference.\n\n"
        "retention_analysis:\n"
        "<Audio 1>: reference - the speaker follows <Audio 1>'s voice timbre, pitch and "
        "texture without copying the original signal or its words.\n\n"
        "detailed_description:\n"
        "The target video is a realistic, evenly lit live-action recording-session shot.\n"
        f"{shot}\n\n"
        f"overall_soundscape:\n{soundscape}\n\n"
        "non_diegetic_music:\nN/A"
    )


def _ffmpeg() -> str:
    return os.environ.get("FFMPEG", "ffmpeg")


def extract_audio(source: Path, output: Path, sample_rate: int = 48000,
                  trim_silence: bool = False) -> None:
    """Write the first audio stream of `source` as 16-bit PCM wav.

    trim_silence cuts leading and trailing silence but keeps a short tail, so a
    generated line starts on the breath and ends shortly after the last word.
    """
    command = [_ffmpeg(), "-y", "-v", "error", "-i", str(source), "-vn", "-map", "0:a:0"]
    if trim_silence:
        edge = ("silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.15:"
                "detection=peak")
        command += ["-af", f"{edge},areverse,{edge},areverse"]
    command += ["-ac", "1", "-ar", str(sample_rate), "-c:a", "pcm_s16le", str(output)]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0 or not output.exists():
        raise RuntimeError(f"audio extract failed: {result.stderr.strip()[-400:]}")


def seed_vc_installed() -> bool:
    return SEED_VC_PYTHON.exists() and (SEED_VC_DIR / "inference.py").exists()


async def convert_voice(source: Path, reference: Path, output: Path, *,
                        diffusion_steps: int = 30, semitone_shift: int = 0,
                        auto_f0_adjust: bool = True, cfg_rate: float = 0.7) -> None:
    """Re-voice `source` with the timbre of `reference`; words and timing stay.

    length_adjust is fixed at 1.0 so the result lines up sample for sample with
    the source, which is the point of converting instead of re-speaking.
    """
    if not seed_vc_installed():
        raise RuntimeError(f"Seed-VC is not installed at {SEED_VC_DIR}")
    with tempfile.TemporaryDirectory(prefix="seedvc_") as tmp:
        tmp_dir = Path(tmp)
        src = tmp_dir / "source.wav"
        ref = tmp_dir / "reference.wav"
        # Seed-VC reads its own sample rate; mono 44.1 kHz avoids a resample surprise.
        await asyncio.to_thread(extract_audio, source, src, 44100)
        await asyncio.to_thread(extract_audio, reference, ref, 44100)
        out_dir = tmp_dir / "out"
        env = {**os.environ, "PYTHONUTF8": "1", "HF_HUB_DISABLE_SYMLINKS_WARNING": "1"}
        process = await asyncio.create_subprocess_exec(
            str(SEED_VC_PYTHON), str(Path(__file__).with_name("seed_vc_runner.py")),
            "--source", str(src), "--target", str(ref), "--output", str(out_dir),
            "--diffusion-steps", str(int(diffusion_steps)), "--length-adjust", "1.0",
            "--inference-cfg-rate", str(float(cfg_rate)), "--f0-condition", "True",
            "--auto-f0-adjust", "True" if auto_f0_adjust else "False",
            "--semi-tone-shift", str(int(semitone_shift)), "--fp16", "True",
            cwd=str(SEED_VC_DIR), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        stdout, _ = await process.communicate()
        produced = sorted(out_dir.glob("*.wav")) if out_dir.exists() else []
        if process.returncode != 0 or not produced:
            tail = stdout.decode("utf-8", "ignore").strip()[-800:]
            raise RuntimeError(f"Seed-VC failed ({process.returncode}): {tail}")
        await asyncio.to_thread(extract_audio, produced[0], output, 48000)
