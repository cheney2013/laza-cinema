"""
MiniMax H3 Structured Prompt Builder & Fallback Synthesizer.

Adheres strictly to the official MiniMax H3 Prompt specifications:
- Base Modes (T2VA, I2VA, FL2VA, L2VA): Keyframe alignment header + 3 core fields.
- Full-Reference Modes (Ref2VA, Continuation, Edit): Exact 6-section format:
  1. subject_definitions:
  2. summary:
  3. retention_analysis:
  4. detailed_description:
  5. overall_soundscape:
  6. non_diegetic_music:
"""

import re
from typing import Optional


GENERIC_PROMPT_PATTERNS = {
    "",
    "cinematic video edit",
    "cinematic video",
    "video edit",
    "high quality video",
    "[edit]",
    "[continuation]",
    "[fl2va]",
    "[i2va]",
    "[l2va]",
    "[t2va]",
    "[ref2va]",
}


def is_already_structured_h3_prompt(prompt: str) -> bool:
    """Check if the prompt is already written in official H3 structured format."""
    if not prompt or not prompt.strip():
        return False
    text = prompt.lower()
    return (
        "subject_definitions:" in text
        or "integrated_multimodal_description:" in text
        or ("how the reference pictures align" in text and "overall_soundscape:" in text)
        or ("for the target video, at 0.00 seconds" in text and "overall_soundscape:" in text)
    )


def is_generic_or_empty_prompt(prompt: Optional[str]) -> bool:
    """Check if the user prompt is essentially blank or a placeholder."""
    if not prompt:
        return True
    clean = prompt.strip().lower()
    if clean in GENERIC_PROMPT_PATTERNS:
        return True
    if re.match(r"^\[[a-z_]+\]\s*$", clean):
        return True
    return False


def build_smart_fallback_h3_prompt(
    prompt: Optional[str] = None,
    mode: Optional[str] = None,
    has_first_frame: bool = False,
    has_last_frame: bool = False,
    num_ref_images: int = 0,
    num_ref_videos: int = 0,
    num_ref_audios: int = 0,
    audio_strategy: str = "copy_source",
    duration: float = 5.1,
) -> str:
    """
    Synthesizes a compliant MiniMax H3 Prompt according to mode and connected assets.
    If `prompt` is already a structured H3 prompt, it is returned intact.
    If `prompt` contains custom user intent text (e.g. "换成图1的角色"), it is embedded
    seamlessly into the structured prompt.
    """
    raw_prompt = (prompt or "").strip()

    # If it is already a fully structured H3 prompt, respect it as-is
    if is_already_structured_h3_prompt(raw_prompt):
        return raw_prompt

    custom_intent = ""
    if not is_generic_or_empty_prompt(raw_prompt):
        # Clean mode prefix like "[edit] ..." if present
        cleaned_intent = re.sub(r"^\[[a-z_]+\]\s*", "", raw_prompt).strip()
        if cleaned_intent:
            custom_intent = cleaned_intent

    # Auto-detect mode if not explicitly provided
    active_mode = (mode or "").lower()
    if not active_mode:
        if has_first_frame and has_last_frame:
            active_mode = "fl2va"
        elif has_first_frame:
            active_mode = "i2va"
        elif has_last_frame:
            active_mode = "l2va"
        elif num_ref_videos > 0:
            active_mode = "edit"
        elif num_ref_images > 0 or num_ref_audios > 0:
            active_mode = "ref2va"
        else:
            active_mode = "t2va"

    dur_str = f"{float(duration or 5.1):.2f}"

    # ─────────────────────────────────────────────────────────────────────────
    # 1. BASE MODES (I2VA / FL2VA / L2VA / T2VA without source video)
    # ─────────────────────────────────────────────────────────────────────────
    if active_mode == "i2va" and num_ref_videos == 0:
        desc = custom_intent or (
            "[Shot 1] Cinematic, realistic video starting precisely from <Picture 1>. "
            "The subject and scene come alive with subtle natural motion, gentle camera tracking with small amplitude, "
            "and coherent physical kinetics. There is no spoken dialogue; the character communicates purely through facial expressions."
        )
        return (
            f"For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n"
            f"integrated_multimodal_description:\n{desc}\n\n"
            f"overall_soundscape:\n"
            f"Natural room tone and environmental ambience matching the visual scene.\n\n"
            f"non_diegetic_music:\nN/A"
        )

    if active_mode == "fl2va" and num_ref_videos == 0:
        desc = custom_intent or (
            "[Shot 1] Cinematic, realistic video smoothly transitioning from the initial framing of Picture 1 "
            "to the final composition of Picture 2. The subject undergoes a natural, coherent motion path with consistent lighting "
            "and physical dynamics. There is no spoken dialogue."
        )
        return (
            f"How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; "
            f"Picture 2 (from Shot 1) aligns with the {dur_str}-second mark of the target video.\n\n"
            f"integrated_multimodal_description:\n{desc}\n\n"
            f"overall_soundscape:\n"
            f"Natural environmental room tone and subtle motion sounds matching the scene.\n\n"
            f"non_diegetic_music:\nN/A"
        )

    if active_mode == "l2va" and num_ref_videos == 0:
        desc = custom_intent or (
            "[Shot 1] Cinematic, realistic video developing toward the composition in <Picture 1>. "
            "The camera gently moves while actions converge smoothly into the exact arrangement and lighting of <Picture 1> at the end of the shot."
        )
        return (
            f"How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the {dur_str}-second mark of the target video.\n\n"
            f"integrated_multimodal_description:\n{desc}\n\n"
            f"overall_soundscape:\n"
            f"Ambient background room tone.\n\n"
            f"non_diegetic_music:\nN/A"
        )

    if active_mode == "t2va" and num_ref_videos == 0 and num_ref_images == 0 and not has_first_frame:
        desc = custom_intent or (
            "[Shot 1] Cinematic, high-quality live-action video with balanced lighting, rich textures, and steady camera movement."
        )
        return (
            f"integrated_multimodal_description:\n{desc}\n\n"
            f"overall_soundscape:\n"
            f"Natural ambient room tone matching the environment.\n\n"
            f"non_diegetic_music:\nN/A"
        )

    # ─────────────────────────────────────────────────────────────────────────
    # 2. FULL-REFERENCE MODES (Ref2VA / Continuation / Edit)
    # Must adhere to the exact 6 sections in order:
    # subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music
    # ─────────────────────────────────────────────────────────────────────────

    # 2.1 CONTINUATION (镜头续写 / 接戏): no template. What carries over from <Video 1>
    # and what each reference is for differ shot to shot, so the prompt is written by hand
    # and sent as written.
    if active_mode == "continuation":
        if not raw_prompt:
            raise ValueError("镜头续写需要手写提示词：写清 <Video 1> 接续关系和每张参考图的用途")
        return raw_prompt

    # 2.2 GENERAL EDIT / RESTRUCTURING (局部编辑)
    # A generic edit keeps the whole frame, so the visible content of <Video 1> is declared as a
    # single scene subject rather than folded into the <Video 1> retention entry.
    reuse_audio = audio_strategy == "copy_source" or num_ref_audios > 0

    subj_def = (
        "<Subject 1> is the visible content of <Video 1>, including its on-screen subjects, their actions, the "
        "environment, the set dressing, and the lighting.\n"
        "<Video 1> is the source video for the target video edit."
    )
    if num_ref_images > 0:
        subj_def += "\n<Subject 2> is the visual reference entity in <Picture 1>."
    if reuse_audio:
        subj_def += "\n<Audio 1> is the synchronized audio track of <Video 1> and is reused in the target video."

    task_parts = ["video editing"]
    if num_ref_images > 0:
        task_parts.append("reference generation")
    if reuse_audio:
        task_parts.append("audio reuse")
    summary_text = (
        f"[{' + '.join(task_parts)}] The target video is an edited version of <Video 1>, retaining <Subject 1>"
        f"{' with guidance from <Subject 2>' if num_ref_images > 0 else ''}."
    )

    retention_text = (
        "<Subject 1> (appears in [Shot 1]): fully_preserved - the on-screen subjects, their actions, the environment, "
        "the set dressing, and the lighting of <Video 1> are retained.\n"
        "<Video 1> (camera movement and cut and pacing structure): fully_preserved - the camera path, shot timing, and "
        "temporal structure are retained."
    )
    if num_ref_images > 0:
        retention_text += "\n<Subject 2> (appears in [Shot 1]): weak_reference - the visual characteristics of <Picture 1> guide the edit."
    if reuse_audio:
        retention_text += "\n<Audio 1>: fully_copy - <Audio 1> is reused 1:1 as the target video's complete final audio track."

    detailed_text = (
        "The target video is rendered in high-end cinematic quality.\n"
        "[Shot 1] <Subject 1> is presented as a refined version of <Video 1>, with crisp textures, cinematic lighting, "
        "and polished audiovisual fidelity, while the on-screen subjects, environment, framing, and camera path stay "
        f"unchanged. {custom_intent if custom_intent else ''}"
    ).strip()

    return (
        f"subject_definitions:\n{subj_def}\n\n"
        f"summary:\n{summary_text}\n\n"
        f"retention_analysis:\n{retention_text}\n\n"
        f"detailed_description:\n{detailed_text}\n\n"
        f"overall_soundscape:\nNatural ambient room tone and synchronized scene Foley.\n\n"
        f"non_diegetic_music:\nN/A"
    )
