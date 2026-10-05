"""Subtitle translation with the text encoder Qwen-Image 2.1 loads anyway (a Qwen3-VL, through ComfyUI's
TextGenerate). One batch is a run of consecutive titles, so the model sees the neighbours and keeps names
and register steady; the caller (the cut room) sends the film in batches and gets each back as it lands."""
from __future__ import annotations

import re

LANGUAGE_NAMES = {
    "en": "English", "zh": "Simplified Chinese", "ja": "Japanese", "ko": "Korean",
    "fr": "French", "de": "German", "es": "Spanish", "ru": "Russian",
}

MAX_BATCH = 30


def language_name(code: str) -> str:
    return LANGUAGE_NAMES.get(code.lower(), code)


def build_prompt(lines: list[str], source: str, target: str) -> str:
    numbered = "\n".join(f"{i + 1}. {' / '.join(part.strip() for part in line.splitlines() if part.strip())}"
                         for i, line in enumerate(lines))
    return (
        f"You are a film subtitle translator. Translate each numbered subtitle line from {language_name(source)} "
        f"into {language_name(target)}. The lines are consecutive dialogue from one short film, so keep names and "
        "tone consistent. Rules: keep the same numbering and give exactly one output line per input line, never "
        "merging or splitting lines; keep names, numbers and anything in quotation marks that is on-screen text; "
        "write natural spoken language, short enough to read on screen; add no notes, explanations or extra lines. "
        "Output only the numbered lines.\n\n" + numbered
    )


_LINE = re.compile(r"^\s*(\d+)\s*[\.\)、:：]\s*(.*)$")


def parse_numbered(output: str, count: int) -> list[str]:
    """The model's numbered lines back as a list of `count`; a line it skipped or garbled is ''."""
    output = re.sub(r"<think>.*?</think>", "", output, flags=re.S)
    found: dict[int, str] = {}
    last = 0
    for raw in output.splitlines():
        m = _LINE.match(raw)
        if m:
            last = int(m.group(1)) if 1 <= int(m.group(1)) <= count else 0
            if last:
                found[last] = m.group(2).strip()
        elif raw.strip() and last and last in found:
            found[last] += " " + raw.strip()   # a line the model wrapped
    return [found.get(i + 1, "") for i in range(count)]


def max_tokens(lines: list[str]) -> int:
    return min(4096, 160 + 3 * sum(len(line) for line in lines) + 24 * len(lines))


def restore_breaks(source: list[str], translated: list[str]) -> list[str]:
    """build_prompt sent a two-line cue as 'a / b'; where the source had a line break, the " / " in the
    answer goes back to one."""
    return [re.sub(r"\s*[/／]\s*", "\n", t) if "\n" in src.strip() else t for src, t in zip(source, translated)]
