import speech


def test_lengths_sit_on_the_h3_grid():
    for text in ["好", "你好，我回来了。", "I'm home, and the lights are off again.", "字" * 80]:
        frames = speech.estimate_frames(text)
        assert frames % 17 == 5
        assert frames >= 2 * speech.FPS


def test_longer_lines_get_longer_clips():
    assert speech.estimate_frames("字" * 40) > speech.estimate_frames("字" * 5)


def test_language_detection():
    assert speech.detect_language("你好") == "Chinese"
    assert speech.detect_language("こんにちは") == "Japanese"
    assert speech.detect_language("hello") == "English"


def test_prompt_without_reference_is_t2va():
    prompt = speech.build_speech_prompt("你好。", "a tired middle-aged man with a low raspy voice")
    assert prompt.startswith("integrated_multimodal_description: [Shot 1]")
    assert "<d>[Chinese] 你好。</d>" in prompt
    assert "(S1)" in prompt and "<Audio" not in prompt


def test_prompt_with_reference_is_full_reference():
    prompt = speech.build_speech_prompt("hi.", has_ref_audio=True)
    sections = ["subject_definitions:", "summary:", "retention_analysis:",
                "detailed_description:", "overall_soundscape:", "non_diegetic_music:"]
    positions = [prompt.index(s) for s in sections]
    assert positions == sorted(positions)
    assert "<Audio 1> is the voice-timbre reference" in prompt
    retention = prompt[prompt.index("retention_analysis:"):prompt.index("detailed_description:")]
    assert "(S1)" not in retention


def test_empty_line_is_refused():
    try:
        speech.build_speech_prompt("  ")
    except ValueError:
        return
    raise AssertionError("expected ValueError")
