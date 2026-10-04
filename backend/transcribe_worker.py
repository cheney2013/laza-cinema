"""Transcribe one audio file into subtitle cues, printed as JSON on stdout.

Run as a child process, not imported: a separate process hands its memory back
(VRAM included) the moment it exits, and a crash in it cannot take the backend down.

    python transcribe_worker.py <audio> [--model large-v3] [--language zh]

Whisper's own segments are decoding windows, not sentences: one can hold four
sentences, and a sentence can straddle two. So the cues are rebuilt from word
timestamps -- a sentence per cue, split further at pauses and at a readable
length -- rather than taken as they come.
"""
import argparse
import json
import os
import sys
from pathlib import Path

SENTENCE_END = tuple(".?!。？！…")
CLAUSE_END = tuple(",;:，；：、")
# A pause this long between two words is a new line even without punctuation.
PAUSE_S = 0.6
MAX_CUE_S = 6.0
MIN_CUE_S = 1.0
# Speaker changes: 1.5 s windows every 0.5 s, grouped below this cosine distance.
SPEAKER_WINDOW_S = 1.5
SPEAKER_HOP_S = 0.5
# Voice (cosine) distance plus SPEAKER_PITCH_WEIGHT per octave of pitch difference.
# Tuned on two tests with known speakers, scored on whether each change of
# speaker between neighbouring lines was found: a two-person dialogue scene and an
# 18-line synthetic back-and-forth. 1.05 / 0.3 sits in the middle of a plateau
# (0.95-1.2 all score the same, two speakers found) and scores 26/30 + 40/42,
# against 26/30 + 38/42 without pitch.
SPEAKER_DISTANCE = 1.05
SPEAKER_PITCH_WEIGHT = 0.3
TURN_GAP_S = 0.2
# Characters on one subtitle. Chinese carries far more per character.
MAX_CHARS = {"zh": 18, "ja": 18, "ko": 20}
MAX_CHARS_DEFAULT = 42
# Without a hint Whisper often writes Mandarin in traditional characters and
# without punctuation; a short prompt in the style wanted fixes both.
PROMPTS = {"zh": "以下是普通话的句子，使用简体中文和标点符号。"}
CJK = ("zh", "ja", "ko")


def expose_cuda_libraries() -> None:
    """Put the pip-installed cuBLAS/cuDNN DLLs where CTranslate2 looks for them.

    It resolves them through PATH at first use, not through the package, so
    without this the GPU path fails on "cublas64_12.dll is not found".
    """
    try:
        import nvidia
    except ImportError:
        return
    for root in getattr(nvidia, "__path__", []):
        for bin_dir in Path(root).glob("*/bin"):
            os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(str(bin_dir))


# Lines Whisper writes when it hears music or noise instead of speech: the
# credits of the subtitle sites it was trained on. None of these is ever a
# line of the film.
HALLUCINATIONS = (
    "请不吝点赞", "订阅转发", "打赏支持", "明镜与点点", "点点栏目", "字幕由", "字幕志愿者",
    "Amara.org", "Translated by", "Subtitles by", "中文字幕",
    "Teksting av", "Tekstet av", "Undertekster", "Untertitel", "Sottotitoli", "Subtítulos",
    "Sous-titres", "Ondertiteling",
)
# Pieces of the style prompt; a line that repeats one heard the prompt, not the film.
PROMPT_ECHOES = ("以下是普通话", "简体中文", "标点符号")
# Separation works on this many seconds at a time (HDemucs holds a window of
# ~10 s in memory; whole minutes at once run the CPU out of RAM).
SEPARATE_CHUNK_S = 10.0
SEPARATE_OVERLAP_S = 1.0


def separate_vocals(path: str, out_path: str) -> bool:
    """Write the voice alone (16 kHz mono) to out_path; False if it cannot be done.

    Music under dialogue is what defeats Whisper and its VAD: on a 15 s monologue
    over a loud score (2026-09-22) the VAD kept 4 of the 12 spoken seconds and
    Whisper wrote a subtitle-site credit instead. torchaudio's HDemucs (MUSDB-HQ
    + extra data) takes the vocals stem out first, on the CPU so it never
    competes with ComfyUI.
    """
    try:
        import soundfile as sf
        import torch
        import torchaudio.functional as AF
        from torchaudio.pipelines import HDEMUCS_HIGH_MUSDB_PLUS as bundle
    except ImportError:
        return False
    model = bundle.get_model().eval()
    rate = bundle.sample_rate
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    wav = torch.from_numpy(x.T)
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    wav = wav[:2]
    if sr != rate:
        wav = AF.resample(wav, sr, rate)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std

    vocals_index = model.sources.index("vocals")
    total = wav.shape[1]
    chunk, overlap = int(SEPARATE_CHUNK_S * rate), int(SEPARATE_OVERLAP_S * rate)
    out = torch.zeros(2, total)
    weight = torch.zeros(total)
    fade = torch.linspace(0, 1, overlap) if overlap else None
    start = 0
    with torch.no_grad():
        while start < total:
            end = min(total, start + chunk)
            piece = model(wav[None, :, start:end])[0, vocals_index]
            w = torch.ones(end - start)
            if fade is not None:
                n = min(overlap, end - start)
                if start > 0:
                    w[:n] = fade[:n]
                if end < total:
                    w[-n:] = torch.minimum(w[-n:], fade[:n].flip(0))
            out[:, start:end] += piece * w
            weight[start:end] += w
            print(f"progress {0.01 + 0.03 * end / total:.3f}", file=sys.stderr, flush=True)
            if end == total:
                break
            start = end - overlap
    vocals = (out / weight.clamp_min(1e-6)) * std + mean
    mono = AF.resample(vocals.mean(0, keepdim=True), rate, 16000)[0].numpy()
    sf.write(out_path, mono, 16000)
    return True


def is_hallucination(text: str) -> bool:
    t = text.replace(" ", "")
    return any(h.replace(" ", "") in t for h in HALLUCINATIONS + PROMPT_ECHOES)


def run_model(path: str, model_name: str, language, device: str, vocals=None):
    """Transcribe path; returns (segments, info, the audio file they came from).

    The mix is tried first, as it is: on clean dialogue that is the best result,
    and taking the voice out first loses words there (a phone line,
    2026-09-22: "Ben, I... Ben," dropped). Only when the pass shows the
    music-under-dialogue failure -- a subtitle-site credit, the style prompt
    echoed back, or nothing heard -- is the voice separated (`vocals()` writes it
    and returns its path, or None) and the file tried again: with VAD and the
    prompt, then without either, since under music the VAD drops speech it
    cannot hear and the prompt pulls Whisper towards the credit lines.
    The candidate with the most real text wins.
    """
    from faster_whisper import WhisperModel

    compute = "int8_float16" if device == "cuda" else "int8"
    model = WhisperModel(model_name, device=device, compute_type=compute)
    # Loading the model is most of the wait before the first sentence; say it happened.
    print("progress 0.050", file=sys.stderr, flush=True)
    segments, info = decode(model, path, language, vad=True, prompt=True, share=(0.08, 0.4))
    best = (segments, info, path)
    if failed(segments):
        print("first pass looks like music, not speech; retrying", file=sys.stderr, flush=True)
        voice = vocals() if vocals else None
        attempts = ([(voice, True, (0.45, 0.6))] if voice else []) + \
            [(voice or path, False, (0.6, 0.9))]
        for source, with_vad, share in attempts:
            got, got_info = decode(model, source, info.language or language, vad=with_vad,
                                   prompt=with_vad, share=share)
            if spoken_chars(got) > spoken_chars(best[0]):
                best = (got, got_info, source)
            if not failed(got):
                break
    print("progress 0.900", file=sys.stderr, flush=True)
    segments, info, source = best
    return [seg for seg in segments if not is_hallucination(seg.text)], info, source


def failed(segments: list) -> bool:
    return not segments or any(is_hallucination(seg.text) for seg in segments)


def spoken_chars(segments: list) -> int:
    return sum(len(s.text.strip()) for s in segments if not is_hallucination(s.text))


def decode(model, path: str, language, vad: bool, prompt: bool, share: tuple[float, float]):
    options = dict(
        vad_filter=vad,
        beam_size=5,
        word_timestamps=True,
        # Carrying the previous window's text forward is what sends Whisper into
        # repeating one line over a stretch of music or silence.
        condition_on_previous_text=False,
    )
    segments, info = model.transcribe(path, language=language or None,
                                      initial_prompt=PROMPTS.get(language or "") if prompt else None,
                                      **options)
    # Language detection has already run; the decoding has not. A detected
    # language with a prompt of its own is worth restarting for.
    if prompt and not language and info.language in PROMPTS:
        segments, info = model.transcribe(path, language=info.language,
                                          initial_prompt=PROMPTS[info.language], **options)

    duration = info.duration or 0.0
    kept = []
    lo, hi = share
    # Segments are a lazy generator: the work, and a missing CUDA library, both
    # happen while iterating. Each one reports how far through the audio it is.
    for segment in segments:
        # Words invented over noise: the model itself thinks there was no speech.
        if not (segment.no_speech_prob > 0.6 and segment.avg_logprob < -1.0):
            kept.append(segment)
        if duration > 0:
            print(f"progress {lo + (hi - lo) * min(1.0, segment.end / duration):.3f}",
                  file=sys.stderr, flush=True)
    return kept, info


def join(words: list, language: str) -> str:
    text = "".join(w.word for w in words)
    return text.replace(" ", "").strip() if language in CJK else " ".join(text.split())


def speech_words(segments: list) -> list:
    return [w for s in segments for w in (s.words or []) if w.word.strip()]


def label_speakers(audio_path: str, words: list) -> list[int] | None:
    """A speaker label per word, or None when the voices cannot be told apart.

    Short overlapping windows over the speech are embedded (SpeechBrain ECAPA,
    on the CPU so it never competes with ComfyUI) and grouped by average-linkage
    on voice distance plus pitch difference. Only changes of voice are used, never
    who is who, so the labels need to be consistent within one run and nothing more.

    Embedding whole sentences instead of word-aligned windows was tried and
    scored worse on both tests (20/30 and 36/42); lines under a second are what
    fail either way, and pitch is what rescues some of them.
    """
    if len(words) < 2:
        return None
    try:
        import numpy as np
        import torch
        from faster_whisper.audio import decode_audio
        from scipy.cluster.hierarchy import fcluster, linkage
        from speechbrain.inference.speaker import EncoderClassifier
    except ImportError:
        return None

    rate = 16000
    audio = decode_audio(audio_path, sampling_rate=rate)
    total = len(audio) / rate
    starts = []
    # Windows only where somebody is talking: the words say where that is.
    for word in words:
        centre = (word.start + word.end) / 2
        start = max(0.0, min(total - SPEAKER_WINDOW_S, centre - SPEAKER_WINDOW_S / 2))
        if not starts or start - starts[-1] >= SPEAKER_HOP_S:
            starts.append(start)
    if len(starts) < 3:
        return None

    encoder = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb", run_opts={"device": "cpu"})
    size = int(SPEAKER_WINDOW_S * rate)
    embeddings = []
    for i in range(0, len(starts), 64):
        batch = [audio[int(s * rate): int(s * rate) + size] for s in starts[i:i + 64]]
        batch = [np.pad(b, (0, size - len(b))) for b in batch]
        with torch.no_grad():
            embeddings.append(encoder.encode_batch(torch.from_numpy(np.stack(batch))).squeeze(1).numpy())
        print(f"progress {0.9 + 0.09 * min(1.0, (i + 64) / len(starts)):.3f}", file=sys.stderr, flush=True)
    vectors = np.concatenate(embeddings)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True) + 1e-9

    from scipy.spatial.distance import pdist

    distance = pdist(vectors, "cosine")
    # Pitch survives on short lines, where 1.5 s of voice embeds poorly: a child's
    # "Hey" (320 Hz) and a man's reply (110 Hz) are a full octave apart. Octaves
    # of difference are added to the voice distance.
    pitch = np.array([median_f0(audio[int(s * rate): int(s * rate) + size], rate) for s in starts])
    octaves = np.log2(np.where(pitch > 0, pitch, np.nan))
    gap = np.abs(octaves[:, None] - octaves[None, :])[np.triu_indices(len(starts), 1)]
    distance = distance + SPEAKER_PITCH_WEIGHT * np.nan_to_num(gap, nan=0.0)
    labels = fcluster(linkage(distance, "average"), SPEAKER_DISTANCE, "distance")
    # A group of one or two windows is a cough or a clash of voices, not a person:
    # fold it into the nearest real group.
    groups, counts = np.unique(labels, return_counts=True)
    real = groups[counts >= 3]
    if len(real) <= 1:
        return None
    centroids = {g: vectors[labels == g].mean(axis=0) for g in real}
    for g in groups[counts < 3]:
        for i in np.flatnonzero(labels == g):
            labels[i] = max(real, key=lambda r: float(vectors[i] @ centroids[r]))

    centres = np.array(starts) + SPEAKER_WINDOW_S / 2
    out = []
    for word in words:
        middle = (word.start + word.end) / 2
        near = np.abs(centres - middle) <= SPEAKER_WINDOW_S / 2
        pool = labels[near] if near.any() else labels[[int(np.abs(centres - middle).argmin())]]
        values, votes = np.unique(pool, return_counts=True)
        out.append(int(values[votes.argmax()]))
    # One word voiced differently from both neighbours is noise, not a turn.
    for i in range(1, len(out) - 1):
        if out[i - 1] == out[i + 1] != out[i]:
            out[i] = out[i - 1]
    # The windows are 1.5 s wide, so a change of voice is detected a word or two
    # late ("It's late. What time | is it?"). Move it back to where the turn was
    # really taken: a sentence end first, else a pause or a clause mark.
    for i in range(1, len(out)):
        if out[i] == out[i - 1] or turn_boundary(words, i, SENTENCE_END):
            continue
        for marks, reach in ((SENTENCE_END, 4), (SENTENCE_END + CLAUSE_END, 3)):
            j = next((j for j in range(i - 1, max(0, i - reach) - 1, -1)
                      if j > 0 and out[j - 1] == out[i - 1] and turn_boundary(words, j, marks)), None)
            if j is not None:
                for k in range(j, i):
                    out[k] = out[i]
                break
    return out


def median_f0(x, rate: int, fmin: float = 70.0, fmax: float = 500.0) -> float:
    """Median pitch of the voiced frames in x (YIN), or 0 when too little is voiced."""
    import numpy as np

    frame, hop = int(0.04 * rate), int(0.01 * rate)
    low, high = int(rate / fmax), int(rate / fmin)
    found = []
    for start in range(0, len(x) - frame, hop):
        f = x[start:start + frame] - x[start:start + frame].mean()
        if float(f @ f) < 1e-4 * frame:
            continue
        diff = np.array([np.sum((f[:-lag] - f[lag:]) ** 2) for lag in range(low, high)])
        normalised = diff * np.arange(1, len(diff) + 1) / (np.cumsum(diff) + 1e-12)
        lag = int(np.argmin(normalised))
        if normalised[lag] < 0.25:
            found.append(rate / (lag + low))
    return float(np.median(found)) if len(found) >= 5 else 0.0


def turn_boundary(words: list, i: int, marks: tuple) -> bool:
    """Whether a speaker could plausibly take over at word i."""
    previous = words[i - 1]
    return words[i].start - previous.end >= TURN_GAP_S or previous.word.strip().endswith(marks)


def build_cues(words: list, language: str, speakers: list[int] | None = None) -> list[dict]:
    max_chars = MAX_CHARS.get(language, MAX_CHARS_DEFAULT)
    cues: list[list] = []
    current: list = []

    def flush() -> None:
        nonlocal current
        if current:
            cues.append(current)
        current = []

    for index, word in enumerate(words):
        # A different voice is a new line. A turn is taken after a pause or at a
        # punctuation mark; a voice "change" inside running words is the
        # embedding wobbling ("What time | is it?") and is ignored.
        if current and speakers is not None and speakers[index] != speakers[index - 1]:
            if turn_boundary(words, index, SENTENCE_END + CLAUSE_END):
                flush()
        if current:
            gap = word.start - current[-1].end
            length = len(join(current + [word], language))
            # The word that finishes a sentence may run a little over, rather
            # than leave "morning." alone on a line of its own.
            ends = word.word.strip().endswith(SENTENCE_END)
            too_long = length > (max_chars * 1.3 if ends else max_chars)
            too_slow = word.end - current[0].start > MAX_CUE_S
            if gap >= PAUSE_S or too_long or too_slow:
                # Over the limit: break at the last clause mark if there is one,
                # so a line does not end on "and the".
                if (too_long or too_slow) and gap < PAUSE_S:
                    cut = max((i for i, w in enumerate(current[:-1])
                               if w.word.strip().endswith(CLAUSE_END)), default=None)
                    if cut is not None:
                        head, current = current[: cut + 1], current[cut + 1:]
                        cues.append(head)
                    else:
                        flush()
                else:
                    flush()
        current.append(word)
        if word.word.strip().endswith(SENTENCE_END):
            flush()
    flush()

    out = []
    for cue in cues:
        text = join(cue, language)
        # A trailing comma on a subtitle line reads as noise.
        text = text.rstrip("".join(CLAUSE_END)).strip()
        if text:
            out.append({"start": cue[0].start, "end": cue[-1].end, "text": text})
    # A word's own timing is too brief to read ("Okay." is 0.2 s): hold each
    # line a minimum time, never into the next one.
    for index, cue in enumerate(out):
        limit = out[index + 1]["start"] if index + 1 < len(out) else cue["end"] + MIN_CUE_S
        cue["end"] = max(cue["end"], min(cue["start"] + MIN_CUE_S, limit))
        cue["start"], cue["end"] = round(cue["start"], 3), round(cue["end"], 3)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--language", default=None)
    parser.add_argument("--no-separate", action="store_true",
                        help="never take the voice out of the music, even when the mix fails")
    args = parser.parse_args()
    expose_cuda_libraries()

    vocals_path = Path(args.audio).with_name(Path(args.audio).stem + "_vocals.wav")

    def vocals():
        if args.no_separate:
            return None
        try:
            return str(vocals_path) if separate_vocals(args.audio, str(vocals_path)) else None
        except Exception as exc:  # the mix itself is still worth a try
            print(f"vocal separation skipped: {exc}", file=sys.stderr, flush=True)
            return None

    try:
        # ComfyUI usually holds most of the card, and the CUDA runtime may be absent;
        # fall back to the CPU rather than fail the request.
        try:
            device = "cuda"
            segments, info, audio = run_model(args.audio, args.model, args.language, device, vocals)
        except Exception:
            device = "cpu"
            print("progress 0.000", file=sys.stderr, flush=True)
            segments, info, audio = run_model(args.audio, args.model, args.language, device, vocals)
        words = speech_words(segments)
        try:
            speakers = label_speakers(audio, words)
        except Exception as exc:
            # Subtitles without speaker breaks beat no subtitles.
            print(f"speaker split skipped: {exc}", file=sys.stderr, flush=True)
            speakers = None
    finally:
        vocals_path.unlink(missing_ok=True)
    cues = build_cues(words, info.language, speakers)
    sys.stdout.write(json.dumps(
        {"language": info.language, "device": device, "segments": cues}, ensure_ascii=False))


if __name__ == "__main__":
    main()
