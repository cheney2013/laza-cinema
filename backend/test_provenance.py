"""
Provenance recovery, tested against the graphs this app actually builds.

The parser reads graphs produced by `workflow_builders`, so the builders are the
fixture: round-tripping through them means a change to how references are mounted
breaks this test instead of silently costing an upscale its texture references.
"""
import provenance
import workflow_builders as wb


def test_recovers_references_from_a_reference_to_video_graph():
    wf = wb.build_h3_video_workflow(
        prompt="[Shot 1] A woman turns to the window.",
        width=1376,
        height=768,
        length=124,
        steps=4,
        seed=81000,
        image_reference_filenames=["style_a.png", "style_b.png", "style_c.png"],
    )
    record = provenance.describe_generation(wf)

    assert record["prompt"].startswith("[Shot 1]")
    assert record["width"] == 1376 and record["height"] == 768 and record["length"] == 124
    assert record["seed"] == 81000
    # Order is meaning: it decides which reference is <Picture 1>.
    assert record["reference_images"] == ["style_a.png", "style_b.png", "style_c.png"]


def test_recovers_guide_frames_mounted_around_the_references():
    wf = wb.build_h3_video_workflow(
        prompt="[Shot 2] The door closes.",
        width=1376,
        height=768,
        length=124,
        steps=4,
        image_reference_filenames=["style_a.png"],
        first_frame_filename="first.png",
        last_frame_filename="last.png",
    )
    record = provenance.describe_generation(wf)

    assert record["first_frame"] == "first.png"
    assert record["last_frame"] == "last.png"
    assert record["reference_images"] == ["style_a.png"]


def test_recovers_the_lightweight_image_to_video_path():
    # A first frame and nothing else takes a different node with a resize in the
    # middle, which the link walk has to see through.
    wf = wb.build_h3_video_workflow(
        prompt="[Shot 3] Steam rises off the cup.",
        width=1376,
        height=768,
        length=73,
        steps=4,
        first_frame_filename="first.png",
    )
    assert wf["31"]["class_type"] == "MiniMaxH3ImageToVideo"

    record = provenance.describe_generation(wf)
    assert record["first_frame"] == "first.png"
    assert record["prompt"].startswith("[Shot 3]")


def test_reports_model_and_loras():
    wf = wb.build_h3_video_workflow(prompt="x", width=768, height=768, length=73, steps=4)
    record = provenance.describe_generation(wf)
    assert record["model"]
    assert isinstance(record["loras"], list)


def test_says_nothing_rather_than_guessing_on_a_foreign_graph():
    record = provenance.describe_generation({"1": {"class_type": "KSampler", "inputs": {"seed": 5}}})
    assert record["prompt"] is None
    assert record["reference_images"] == []
    assert record["first_frame"] is None


def test_survives_a_graph_that_is_not_a_graph():
    assert provenance.describe_generation({})["prompt"] is None
    assert provenance.describe_generation({"1": "not a node"})["reference_images"] == []


def test_upscale_anchors_an_i2v_shot_on_its_own_first_frame():
    """
    An I2V shot has no references, so without its guide frames the refine pass
    re-encodes with no image anchoring at all — while the generation was pinned
    on a first frame. MMH3UltimateUpscale carries keyframes through per chunk and
    per tile, so the anchor survives the split.
    """
    wf = wb.build_h3_latent_upscale_workflow(
        latent_filename="H3_Latent_0a107ed1_00001_.safetensors",
        length=73,
        first_frame_filename="style_shot2_firstframe.png",
    )
    guide = wf["71"]
    assert guide["class_type"] == "MiniMaxH3AddGuide"
    assert guide["inputs"]["frame_idx"] == 0
    assert guide["inputs"]["positive"] == ["30", 0]
    assert guide["inputs"]["latent"] == ["30", 1]
    assert wf["70"]["inputs"]["image"] == "style_shot2_firstframe.png"
    # The sampler must read the anchored conditioning, not the bare encode.
    assert wf["44"]["inputs"]["conditioning"] == ["71", 0]
    # <Picture 1> is a reference label; nothing is mounted under one here.
    assert "<Picture" not in wf["30"]["inputs"]["prompt"]


def test_upscale_keeps_the_reference_path_untouched():
    wf = wb.build_h3_latent_upscale_workflow(
        latent_filename="H3_Latent_b094672c_00001_.safetensors",
        length=311,
        reference_filenames=["style_a.png", "style_b.png"],
    )
    assert wf["30"]["inputs"]["ref_images.ref_image_0"] == ["400", 0]
    assert wf["30"]["inputs"]["ref_images.ref_image_1"] == ["401", 0]
    assert wf["30"]["inputs"]["ref_image_size"] == "max"
    # The pack's own example workflow uses this exact text for the refine encode.
    assert wf["30"]["inputs"]["prompt"] == wb.REFINE_PROMPT
    assert wf["44"]["inputs"]["conditioning"] == ["30", 0]
    assert "71" not in wf


def test_upscale_anchors_both_ends_when_the_shot_had_both():
    wf = wb.build_h3_latent_upscale_workflow(
        latent_filename="x.safetensors",
        length=124,
        reference_filenames=["style_a.png"],
        first_frame_filename="first.png",
        last_frame_filename="last.png",
    )
    assert wf["71"]["inputs"]["frame_idx"] == 0
    assert wf["73"]["inputs"]["frame_idx"] == -1
    # Chained, so both anchors survive into the sampler.
    assert wf["73"]["inputs"]["positive"] == ["71", 0]
    assert wf["44"]["inputs"]["conditioning"] == ["73", 0]
    # References are still mounted, so the label in REFINE_PROMPT is real.
    assert wf["30"]["inputs"]["prompt"] == wb.REFINE_PROMPT


def test_an_explicit_prompt_still_wins():
    wf = wb.build_h3_latent_upscale_workflow(
        latent_filename="x.safetensors", length=73, prompt="my own refine text"
    )
    assert wf["30"]["inputs"]["prompt"] == "my own refine text"


def test_upscale_from_a_plain_video_encodes_it_in_the_graph():
    # A trim or an edit has no saved latent: the clip itself is encoded, the
    # chain path's own way, over its whole length, and the preserve mask cleared.
    wf = wb.build_h3_latent_upscale_workflow(
        latent_filename="", source_latent_w=86, source_latent_h=48, length=192,
        reference_filenames=["style_a.png"], source_video="D:/in/upscale_src_x.mp4",
    )
    assert "10" not in wf
    assert wf["900"]["class_type"] == "VHS_LoadVideoPath"
    assert wf["900"]["inputs"]["video"] == "D:/in/upscale_src_x.mp4"
    assert wf["901"]["inputs"] == {"width": 1376, "height": 768, "length": 192}
    ctx = wf["902"]["inputs"]
    assert wf["902"]["class_type"] == "MiniMaxH3ExistingVideoMaskedContext"
    assert ctx["context_length"] == 192 and ctx["source_fps"] == 24.0
    assert wf["903"]["class_type"] == "MiniMaxH3ClearAVNoiseMask"
    assert wf["11"]["inputs"]["samples"] == ["903", 0]
    # References still ride along exactly as on the latent path.
    assert wf["30"]["inputs"]["ref_images.ref_image_0"] == ["400", 0]
    assert not any(v == ["10", 0] for n in wf.values() for v in n["inputs"].values())
