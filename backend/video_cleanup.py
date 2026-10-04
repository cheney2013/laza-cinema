"""Watermark / burnt-in subtitle removal as an ordinary H3 video edit.

The edit that worked by hand (2026-09-23): mode "edit", the source clip as
<Video 1>, the source's own size, the smallest H3 length that holds it, the
source audio copied, and a six-section prompt that holds everything of
<Video 1> frame for frame except the overlays. This module writes that prompt
without describing the scene, and puts the result back to the source's exact
frame count, size and audio.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

# What each flag removes, in the words the prompt uses.
# Named by how the marks look and where they sit: the first generic wording
# ("any platform logo ...") removed the subtitles in the same run but left every
# watermark in place (2026-09-24); the hand-written prompt that worked described
# the small logo, the ID line under it and the corner label box.
_WATERMARK = ("the platform watermarks laid over the picture near its edges and corners: "
              "a small app logo, a white icon with the app's name beside it, with a line of "
              "small white account-number or ID text under it, which jumps between the "
              "corners and the middle of the left or right edge at different times in the clip; "
              "and a small semi-transparent label box with short text such as \"AI生成\" "
              "or \"AI generated\" in a corner")
# Where to look in every frame for a watermark that moves.
_WATERMARK_PLACES = ("the top left corner, the top right corner, the middle of the left edge, "
                     "the middle of the right edge, the bottom left corner and the bottom right corner")
_SUBTITLES = ("the burnt-in subtitles: every line of caption or subtitle text printed "
              "over the picture")


def build_cleanup_prompt(remove_watermark: bool, remove_subtitles: bool,
                         watermark_hint: str = "", scene_hint: str = "") -> str:
    """Six-section H3 edit prompt removing the chosen overlays from <Video 1>.

    With one flag only, the other kind of overlay is named as kept, so the edit
    does not take the subtitles out along with a watermark (or the reverse).

    Generic wording alone left every watermark in place in three runs; the hand
    prompt that worked named the exact marks and said what the footage shows. So
    `watermark_hint` (the marks as the user sees them, e.g. "左上角的'AI生成'灰框、
    抖音 logo 和下面那行抖音号") and `scene_hint` (one line on what the clip shows)
    are written into the prompt as given when they are set.
    """
    if not (remove_watermark or remove_subtitles):
        raise ValueError("video cleanup needs remove_watermark or remove_subtitles")
    watermark_hint, scene_hint = (watermark_hint or "").strip(), (scene_hint or "").strip()
    if remove_watermark and watermark_hint:
        return _hinted_watermark_prompt(watermark_hint, scene_hint, remove_subtitles)
    removed = [s for flag, s in ((remove_watermark, _WATERMARK),
                                 (remove_subtitles, _SUBTITLES)) if flag]
    removed_text = " and ".join(removed)
    if remove_watermark and remove_subtitles:
        short = "the watermarks and the burnt-in subtitles"
        kept_clause = ""
        kept_shot = ""
    if remove_watermark:
        places = (f" In every frame, at {_WATERMARK_PLACES}, the small logo, the ID text "
                  f"under it and the label box are gone, showing only the scene there.")
    else:
        places = ""
    if remove_watermark and remove_subtitles:
        pass
    elif remove_watermark:
        short = "the platform watermarks"
        kept_clause = ""
        kept_shot = ", and the same subtitles"
    else:
        short = "the burnt-in subtitles"
        kept_clause = (" Any platform logo, account text or corner label in <Video 1> is "
                       "kept exactly as it is.")
        kept_shot = ", and the same logos and labels as <Video 1>, unchanged"

    return f"""subject_definitions:
<Video 1> is the finished footage and it is the target video's own picture. Every person, creature, face, pose, movement and expression, every object, the setting, the light, the framing and the camera come from <Video 1> and are held exactly, frame for frame.{kept_clause}

summary:
[video editing] The same footage as <Video 1> with {short} removed.

retention_analysis:
<Video 1>: partially_preserved - everything in the picture and the sound is exactly that of <Video 1>, frame for frame. What differs: {removed_text} are gone; where they were, whatever lies behind them in the scene shows through, matching its surroundings.

detailed_description:
The same footage as <Video 1>.
[Shot 1] Everything happens exactly as in <Video 1>, with the same framing, light and movement{kept_shot}. Wherever {short} were, in every frame, the frame shows only what is really behind them, continuous with its surroundings in colour, texture and light.{places} Nothing else changes.

overall_soundscape: The sound of <Video 1>, unchanged.

non_diegetic_music: N/A
"""


def _hinted_watermark_prompt(marks: str, scene: str, also_subtitles: bool) -> str:
    """The shape of the hand prompt that worked: what the footage is, the marks by
    name, and a definite statement that those spots show the scene behind them."""
    # Sentence for sentence the hand prompt that worked (H3_Video_c2b92b79). A run
    # with the same seed failed when it (1) held the subtitles "exactly as they are,
    # same words, position, font", which the model took to cover all on-screen text,
    # and (2) listed the marks again in the shot as "none of these ... is anywhere",
    # a negation that pins them. Say what the corners show instead.
    footage = f": {scene}" if scene else ""
    held_subs = "" if also_subtitles else " and the burnt-in subtitle text"
    sub_gone = (" The burnt-in subtitle lines printed over the picture are gone as well, the scene behind them showing through."
                if also_subtitles else "")
    shot_subs = "" if also_subtitles else " and the same subtitles"
    return f"""subject_definitions:
<Video 1> is the finished footage and it is the target video's own picture{footage}. Every person, creature, face, pose, movement and expression, every object, the setting, the light, the framing, the camera{held_subs} come from <Video 1> and are held exactly, frame for frame.

summary:
[video editing] The same footage as <Video 1> with the platform overlays removed.

retention_analysis:
<Video 1>: partially_preserved - everything in the picture and the sound is exactly that of <Video 1>, frame for frame. What differs: {marks}, are gone; where they were, the part of the scene that lies behind them shows through, matching its surroundings.{sub_gone}

detailed_description:
Live-action, the same footage as <Video 1>.
[Shot 1] Everything happens exactly as in <Video 1>, with the same framing, light, movement{shot_subs}. The corners and the edges of the frame show only the scene that is really there, and wherever those marks were, in every frame, the frame shows only the background that lies behind them, continuous with what surrounds it. Nothing else changes.

overall_soundscape: The sound of <Video 1>, unchanged.

non_diegetic_music: N/A
"""


def snap_size(width: int, height: int) -> tuple[int, int]:
    """The size the H3 builder will actually render (multiples of 32, 384-1536)."""
    def snap(v: int) -> int:
        return max(384, min(1536, round(int(v) / 32) * 32))
    return snap(width), snap(height)


def fit_to_source(edited: Path, source: Path, frames: int, width: int, height: int,
                  fps: float, out: Path) -> None:
    """First `frames` frames of `edited` at the source's size, with the source's audio."""
    vf = f"trim=end_frame={int(frames)},setpts=PTS-STARTPTS,scale={int(width)}:{int(height)}:flags=lanczos"
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(edited), "-i", str(source),
           "-map", "0:v:0", "-map", "1:a:0?", "-vf", vf,
           "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-r", f"{fps:g}",
           "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True)
