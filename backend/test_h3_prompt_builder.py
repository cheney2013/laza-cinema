"""
Unit tests for MiniMax H3 Structured Prompt Builder & Fallback Synthesizer.
"""

import re

from h3_prompt_builder import (
    build_smart_fallback_h3_prompt,
    is_already_structured_h3_prompt,
    is_generic_or_empty_prompt,
)


def assert_video_entry_scoped_to_structure(res: str) -> None:
    """§2.3: <Video N> covers whole-video relationships only. Background, lighting, on-screen
    people and their motion are visible content and must live under <Subject N> instead — a
    <Video N> entry spanning them reads as "keep this video's pixels"."""
    forbidden = ("background", "lighting", "environment", "body movement", "scene layout")
    for entry in re.findall(r"^<Video \d+> \(([^)]*)\)", res, re.M):
        scope = entry.lower()
        for word in forbidden:
            assert word not in scope, f"visible content {word!r} in <Video N> scope: {entry!r}"


def test_continuation_has_no_template():
    try:
        build_smart_fallback_h3_prompt(prompt="", mode="continuation", num_ref_videos=1)
    except ValueError:
        pass
    else:
        raise AssertionError("an empty continuation prompt must be refused")
    assert build_smart_fallback_h3_prompt(
        prompt="she walks on", mode="continuation", num_ref_videos=1) == "she walks on"


def test_general_edit_empty_prompt():
    res = build_smart_fallback_h3_prompt(prompt="", mode="edit", num_ref_videos=1)
    assert "[video editing + audio reuse]" in res
    assert "<Subject 1> is the visible content of <Video 1>" in res
    assert_video_entry_scoped_to_structure(res)


def test_no_invented_relationship_markers_anywhere():
    """§4.1 fixes the marker vocabulary; anything outside it breaks the output format."""
    valid_visible = {"fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference"}
    valid_audio = {"fully_copy", "partially_copy", "reference", "weak_reference"}
    for mode in ("edit",):
        res = build_smart_fallback_h3_prompt(
            prompt="", mode=mode, num_ref_images=1, num_ref_videos=1, num_ref_audios=1,
        )
        block = res.split("retention_analysis:")[1].split("detailed_description:")[0]
        for line in block.strip().splitlines():
            marker = line.split(":", 1)[1].strip().split(" ", 1)[0]
            allowed = valid_audio if line.startswith("<Audio") else valid_visible
            assert marker in allowed, f"{mode}: invalid relationship marker {marker!r}"


def test_fl2va_empty_prompt():
    res = build_smart_fallback_h3_prompt(
        prompt="",
        mode="fl2va",
        has_first_frame=True,
        has_last_frame=True,
        duration=7.3,
    )
    assert "How the reference pictures align with the target video" in res
    assert "Picture 1 (from Shot 1) aligns with the 0.00-second mark" in res
    assert "Picture 2 (from Shot 1) aligns with the 7.30-second mark" in res
    assert "integrated_multimodal_description:" in res
    assert "overall_soundscape:" in res
    assert "non_diegetic_music:" in res


def test_i2va_empty_prompt():
    res = build_smart_fallback_h3_prompt(
        prompt="",
        mode="i2va",
        has_first_frame=True,
        duration=5.1,
    )
    assert "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced." in res
    assert "integrated_multimodal_description:" in res
    assert "overall_soundscape:" in res
    assert "non_diegetic_music:" in res


def test_already_structured_prompt_preserved():
    existing = """subject_definitions:
<Subject 1> is custom custom.

summary:
[video editing] custom summary.

retention_analysis:
<Subject 1>: fully_preserved.

detailed_description:
[Shot 1] Custom scene.

overall_soundscape:
Custom sound.

non_diegetic_music:
N/A"""
    res = build_smart_fallback_h3_prompt(
        prompt=existing,
        mode="edit",
    )
    assert res == existing


if __name__ == "__main__":
    test_continuation_has_no_template()
    test_general_edit_empty_prompt()
    test_no_invented_relationship_markers_anywhere()
    test_fl2va_empty_prompt()
    test_i2va_empty_prompt()
    test_already_structured_prompt_preserved()
    print("All H3 Prompt Builder tests passed successfully!")


def test_a_prompt_somebody_wrote_is_sent_as_written_in_every_mode():
    text = "Replace only the girl in <Video 1> with the character in <Picture 1>. Preserve the camera and the background."
    for mode in ("edit", "ref2va", "i2va", "fl2va", "t2va"):
        assert build_smart_fallback_h3_prompt(
            prompt=text, mode=mode, num_ref_images=1, num_ref_videos=1) == text, mode
    assert build_smart_fallback_h3_prompt(prompt="  [edit] go on  ", mode="edit", num_ref_videos=1) == "[edit] go on"


def test_a_blank_prompt_is_still_filled_in():
    res = build_smart_fallback_h3_prompt(prompt="", mode="edit", num_ref_videos=1)
    assert "subject_definitions" in res or "[video editing" in res

