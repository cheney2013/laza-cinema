"""
Unit test to verify MiniMax H3 workflow construction across all generation & editing modes.
Modes: T2VA, I2VA, FL2VA, L2VA, Video Editing (Ref2VA with <Video 1> + <Picture 1>), Motion Transfer.
"""
import json
import workflow_builders as wb


def test_t2va_workflow():
    wf = wb.build_h3_video_workflow(
        prompt="[Shot 1] Cinematic night street...",
        width=1376,
        height=768,
        length=124,
        steps=4,
    )
    # Check core node graph
    assert "31" in wf  # ReferenceToVideo or ImageToVideo
    assert wf["31"]["class_type"] == "MiniMaxH3ReferenceToVideo"
    assert "60" in wf and wf["60"]["class_type"] == "CreateVideo"
    assert "61" in wf and wf["61"]["class_type"] == "SaveVideo"
    assert wf["62"]["class_type"] == "MiniMaxH3MotionContextSaveLatent"
    assert wf["62"]["inputs"]["latent"] == ["44", 0]
    assert wf["60"]["inputs"]["fps"] == 24.0


def test_i2va_workflow():
    wf = wb.build_h3_video_workflow(
        prompt="[Shot 1] Woman smiling...",
        first_frame_filename="start.png",
        width=1376,
        height=768,
        length=124,
        steps=4,
    )
    # When single first_frame without other refs, uses lightweight MiniMaxH3ImageToVideo
    assert "99" in wf and wf["99"]["class_type"] == "LoadImage"
    assert "98" in wf and wf["98"]["class_type"] == "ImageScale"
    assert wf["31"]["class_type"] == "MiniMaxH3ImageToVideo"
    assert wf["31"]["inputs"]["first_frame"] == ["98", 0]


def test_fl2va_workflow():
    wf = wb.build_h3_video_workflow(
        prompt="Picture 1 aligns with 0.00s; Picture 2 aligns with 5.10s...",
        first_frame_filename="frame_start.png",
        last_frame_filename="frame_end.png",
        width=1376,
        height=768,
        length=124,
        steps=4,
    )
    # FL2VA routes into MiniMaxH3ReferenceToVideo, and both frames are anchored
    # on the target timeline rather than mounted as <Picture N> references.
    assert wf["31"]["class_type"] == "MiniMaxH3ReferenceToVideo"
    r2v_inputs = wf["31"]["inputs"]
    assert not [k for k in r2v_inputs if k.startswith("ref_images.")]

    assert wf["71"]["class_type"] == "MiniMaxH3AddGuide"
    assert wf["71"]["inputs"]["frame_idx"] == 0
    assert wf["71"]["inputs"]["positive"] == ["31", 0]
    assert wf["71"]["inputs"]["latent"] == ["31", 1]
    assert wf[wf["71"]["inputs"]["image"][0]]["inputs"]["image"] == "frame_start.png"

    assert wf["73"]["class_type"] == "MiniMaxH3AddGuide"
    assert wf["73"]["inputs"]["frame_idx"] == -1
    assert wf["73"]["inputs"]["positive"] == ["71", 0]
    assert wf[wf["73"]["inputs"]["image"][0]]["inputs"]["image"] == "frame_end.png"

    # The sampler must consume the guided conditioning, not node 31's raw output
    assert wf["41"]["inputs"]["conditioning"] == ["73", 0]


def test_first_frame_does_not_renumber_picture_labels():
    """A first frame alongside <Picture 1>/<Picture 2> must not shift them."""
    wf = wb.build_h3_video_workflow(
        prompt="<Picture 1> is the hero car; <Picture 2> is the police cruiser...",
        first_frame_filename="opening_frame.png",
        image_reference_filenames=["hero_car.png", "police_car.png"],
        video_reference_filenames=["previs.mp4"],
        width=1152,
        height=640,
        length=124,
        steps=4,
    )
    r2v_inputs = wf["31"]["inputs"]
    # each reference is a LoadImage wired straight into the node (no scaling node between)
    pic0 = wf[r2v_inputs["ref_images.ref_image_0"][0]]
    pic1 = wf[r2v_inputs["ref_images.ref_image_1"][0]]
    assert pic0["inputs"]["image"] == "hero_car.png"     # <Picture 1>
    assert pic1["inputs"]["image"] == "police_car.png"   # <Picture 2>
    assert "ref_images.ref_image_2" not in r2v_inputs
    # ...and the first frame is an anchor instead
    assert wf["71"]["class_type"] == "MiniMaxH3AddGuide"
    assert wf["41"]["inputs"]["conditioning"] == ["71", 0]


def test_silent_reference_video_gets_no_audio_mount():
    common = dict(
        prompt="<Video 1> is a grey-box previsualisation...",
        video_reference_filenames=["previs.mp4"],
        width=1152,
        height=640,
        length=124,
        steps=4,
    )
    wf = wb.build_h3_video_workflow(**common, silent_video_references=["previs.mp4"])
    assert wf["31"]["inputs"]["ref_videos.ref_video_0"] == ["350", 0]
    assert "ref_video_audios.ref_video_audio_0" not in wf["31"]["inputs"]

    # Unknown or present audio keeps the previous behaviour
    wf = wb.build_h3_video_workflow(**common)
    assert wf["31"]["inputs"]["ref_video_audios.ref_video_audio_0"] == ["350", 1]


def test_ref2va_video_editing_and_revoicing():
    wf = wb.build_h3_video_workflow(
        prompt="subject_definitions:\n<Subject 1> is the character in <Picture 1> with motion from <Video 1>...",
        video_reference_filenames=["source_scene.mp4"],
        image_reference_filenames=["character_concept.png"],
        audio_reference_filenames=["target_voice.wav"],
        width=1376,
        height=768,
        length=124,
        steps=8,
    )
    assert wf["31"]["class_type"] == "MiniMaxH3ReferenceToVideo"
    r2v_inputs = wf["31"]["inputs"]

    # Image ref mounted
    assert "ref_images.ref_image_0" in r2v_inputs
    load_node = r2v_inputs["ref_images.ref_image_0"][0]      # a LoadImage, wired straight in
    assert wf[load_node]["inputs"]["image"] == "character_concept.png"

    # Video ref mounted with video components + synchronized audio
    assert "ref_videos.ref_video_0" in r2v_inputs
    assert "ref_video_audios.ref_video_audio_0" in r2v_inputs
    vid_comp_id = r2v_inputs["ref_videos.ref_video_0"][0]
    aud_comp_id = r2v_inputs["ref_video_audios.ref_video_audio_0"][0]
    assert vid_comp_id == aud_comp_id  # Comes from GetVideoComponents
    assert wf[vid_comp_id]["class_type"] == "GetVideoComponents"

    # Standalone audio ref mounted
    assert "ref_audios.ref_audio_0" in r2v_inputs
    aud_node = r2v_inputs["ref_audios.ref_audio_0"][0]
    assert wf[aud_node]["inputs"]["audio"] == "target_voice.wav"


def test_temporal_reshot_workflow_preserves_planner_assembler_contract():
    wf = wb.build_h3_temporal_reshot_workflow(
        source_video="source.mp4",
        prompt="Replace the selected action with a careful turn toward camera.",
        start_frame=48,
        frame_count=72,
        context_before=39,
        context_after=22,
        edge_blend_frames=3,
        image_reference_filenames=["character.png"],
        steps=20,
        seed=123,
        sage="disabled",
    )
    assert wf["rs:plan"]["class_type"] == "FL_MiniMaxH3TemporalReshotPlanner"
    settings = json.loads(wf["rs:plan"]["inputs"]["reshot_settings"])
    assert settings == {
        "version": 1, "start_frame": 48, "frame_count": 72,
        "context_before": 39, "context_after": 22, "edge_blend_frames": 3,
    }
    assert wf["rs:plan"]["inputs"]["ref_images.ref_image_0"] == ["rs:ref:0", 0]
    assert wf["rs:sample"]["inputs"]["shot_plan"] == ["rs:plan", 0]
    assert wf["rs:assemble"]["inputs"]["latent"] == ["rs:sample", 0]
    assert wf["rs:save"]["inputs"]["video"] == ["rs:assemble", 0]


def test_m4a_is_never_mounted_as_an_image_or_video():
    wf = wb.build_h3_video_workflow(
        prompt="Use <Audio 1> as the music reference.",
        image_reference_filenames=["mistaken.m4a"],
        video_reference_filenames=["mistaken.m4a"],
        audio_reference_filenames=["music.m4a"],
    )
    r2v_inputs = wf["31"]["inputs"]
    assert not any(key.startswith("ref_images.") for key in r2v_inputs)
    assert not any(key.startswith("ref_videos.") for key in r2v_inputs)
    audio_node = r2v_inputs["ref_audios.ref_audio_0"][0]
    assert wf[audio_node]["class_type"] == "LoadAudio"
    assert wf[audio_node]["inputs"]["audio"] == "music.m4a"


def test_h3_latent_upscale_workflow():
    """The refine pass: MMH3UltimateUpscale re-samples a finished latent once at
    the new size. Guards the parts that were chosen by measurement rather than
    taste, so a later edit cannot quietly undo them."""
    for scale, sw, sh in [(1.5, 48, 86), (2.0, 48, 86), (1.5, 86, 48),
                          (0.5, 48, 86), (-1, 48, 86), (3.0, 120, 68)]:
        wf = wb.build_h3_latent_upscale_workflow(
            latent_filename="H3_Latent_00001_.latent",
            scale_by=scale,
            source_latent_w=sw, source_latent_h=sh,
            reference_filenames=["ref_a.png", "ref_b.png"],
        )

        assert wf["10"]["class_type"] == "MiniMaxH3MotionContextLoadLatent"
        assert wf["10"]["inputs"]["latent_path"] == "H3_Latent_00001_.latent"

        # Node 11 only repacks the loader's {"samples": [video, audio]} list into a
        # NestedTensor; without it consumers hit "'list' object has no attribute
        # 'unbind'". It must not scale -- MMH3UltimateUpscale does the upscaling.
        assert wf["11"]["class_type"] == "MiniMaxH3LatentUpscaleBy"
        assert wf["11"]["inputs"]["scale_by"] == 1.0
        assert wf["11"]["inputs"]["samples"] == ["10", 0]

        up = wf["501"]["inputs"]
        assert wf["501"]["class_type"] == "MMH3LatentUpscaleWithModelParams"
        assert up["model_name"].endswith(".safetensors")

        # Target must clear the source on BOTH axes (below 1.0 the upscaler
        # rejects the job), and an odd latent dimension decodes as a ~10px
        # grey-blue band (#a6aab9) along the bottom edge.
        tw, th = up["width"] // 16, up["height"] // 16
        assert tw >= sw and th >= sh, f"scale={scale} src=({sw},{sh}) -> {tw}x{th} rejected"
        assert tw % 2 == 0 and th % 2 == 0, f"odd target {tw}x{th} reintroduces the band"

        # The node pack requires the conditioning's generation size to match the
        # upscale target, so the refine prompt is re-encoded at the NEW size.
        r2v = wf["30"]
        assert r2v["class_type"] == "MiniMaxH3ReferenceToVideo"
        assert (r2v["inputs"]["width"], r2v["inputs"]["height"]) == (up["width"], up["height"])
        # 'max', not 'match': the references are read for texture at a size larger
        # than the one they were generated against. They measurably add detail --
        # 0 / 1 / 7 references improve it monotonically -- so they are not optional.
        assert r2v["inputs"]["ref_image_size"] == "max"
        assert r2v["inputs"]["prompt"] == wb.REFINE_PROMPT
        assert wf["400"]["inputs"]["image"] == "ref_a.png"
        assert wf["401"]["inputs"]["image"] == "ref_b.png"
        assert r2v["inputs"]["ref_images.ref_image_0"] == ["400", 0]
        assert r2v["inputs"]["ref_images.ref_image_1"] == ["401", 0]

        # One step at sigma 0.6, chosen by eye over the whole ladder.
        assert wf["505"]["class_type"] == "ManualSigmas"
        assert wf["505"]["inputs"]["sigmas"] == wb.REFINE_SIGMAS == "0.6000, 0.0000"
        assert wf["504"]["inputs"]["sampler_name"] == "sa_solver"

        # Sigma shift drops to 6 here; generation uses 12.
        assert wf["21"]["class_type"] == "MiniMaxH3SigmaShift"
        assert wf["21"]["inputs"]["shift_video"] == 6.0

        # MMH3UltimateUpscale drives the loop and must receive every param node.
        ult = wf["44"]
        assert ult["class_type"] == "MMH3UltimateUpscale"
        assert ult["inputs"]["latent"] == ["11", 0]
        assert ult["inputs"]["conditioning"] == ["30", 0]
        assert ult["inputs"]["latent_upscale_param"] == ["501", 0]
        assert ult["inputs"]["cfg"] == 1.0
        # The whole clip is one span: no temporal split node unless chunk_frames asks for one.
        assert "temporal_split_param" not in ult["inputs"]
        assert "502" not in wf

        # Spatial tiling costs a full model re-stage per tile (787s vs 285s when
        # measured); it is off unless a frame will not fit.
        assert "spatial_split_param" not in ult["inputs"]
        assert not any(n["class_type"] == "MMH3SpatialSplitParams" for n in wf.values())

        # Both the video and its latent come off the sampler, so the result can be
        # refined again without regenerating.
        assert wf["50"]["inputs"]["samples"] == ["44", 0]
        assert wf["62"]["inputs"]["latent"] == ["44", 0]
        assert wf["60"]["class_type"] == "CreateVideo"
        assert wf["61"]["class_type"] == "SaveVideo"
        assert wf["62"]["class_type"] == "MiniMaxH3MotionContextSaveLatent"

    # Asking for temporal chunks wires the split node in, and only then.
    chunked = wb.build_h3_latent_upscale_workflow(
        latent_filename="H3_Latent_00001_.latent",
        source_latent_w=86, source_latent_h=48, chunk_frames=119,
    )
    assert chunked["502"]["class_type"] == "MMH3TemporalSplitParams"
    assert chunked["44"]["inputs"]["temporal_split_param"] == ["502", 0]

    # Asking for tiles wires the third param node in, and only then.
    tiled = wb.build_h3_latent_upscale_workflow(
        latent_filename="H3_Latent_00001_.latent",
        source_latent_w=86, source_latent_h=48, spatial_tile=512,
    )
    assert tiled["503"]["class_type"] == "MMH3SpatialSplitParams"
    assert tiled["44"]["inputs"]["spatial_split_param"] == ["503", 0]


def test_h3_refine_defaults_are_the_measured_ones():
    """The refine pass inherits the generator's fused checkpoint and the int8
    VAE. Both were chosen on measurements that are easy to lose in a later edit."""
    wf = wb.build_h3_latent_upscale_workflow(
        latent_filename="H3_Latent_00001_.latent", source_latent_w=86, source_latent_h=48)
    # Turbo is merged into the checkpoint: stacking it live again would double it.
    assert not any("Lora" in n["class_type"] for n in wf.values())
    assert wf["1"]["inputs"]["unet_name"].startswith("minimax_h3_fused_refdelta")
    # 1.6x faster to decode than fp16, at 42-45 dB against it.
    assert wf["4"]["inputs"]["vae_name"] == "minimax_h3_video_vae_int8_convrot.safetensors"
    assert wf["5"]["inputs"]["vae_name"] == "minimax_h3_audio_vae_fp32.safetensors"


def test_reference_video_downscale_keeps_aspect_ratio():
    """A reference video larger than the generation box is scaled down to fit,
    with its aspect ratio kept and nothing cropped away."""
    from comfyui_client import ComfyUIClient

    # The fit is inside the generation box, never beyond it, and never up.
    assert ComfyUIClient._fit_inside((1920, 1080), 1376, 768) == (1368, 768)
    assert ComfyUIClient._fit_inside((3840, 2160), 1376, 768) == (1368, 768)
    assert ComfyUIClient._fit_inside((1080, 1920), 1376, 768) == (432, 768)
    assert ComfyUIClient._fit_inside((1000, 1000), 1376, 768) == (768, 768)
    # Already inside the box: left alone, because a reference is conditioning
    # and upscaling it costs memory without adding detail.
    assert ComfyUIClient._fit_inside((640, 360), 1376, 768) is None
    assert ComfyUIClient._fit_inside((1376, 768), 1376, 768) is None
    assert ComfyUIClient._fit_inside((0, 0), 1376, 768) is None

    # The /8 snap must not visibly move the framing.
    for src in [(1920, 1080), (1080, 1920), (2048, 858), (1440, 1080)]:
        fitted = ComfyUIClient._fit_inside(src, 1376, 768)
        assert fitted, src
        drift = abs((fitted[0] / fitted[1]) - (src[0] / src[1])) / (src[0] / src[1])
        assert drift < 0.005, f"{src} -> {fitted} moved the ratio by {drift:.2%}"

    wf = wb.build_h3_video_workflow(
        prompt="x",
        video_reference_filenames=["previs.mp4"],
        video_reference_sizes=[(1368, 768)],
        width=1376, height=768, length=124, steps=4, seed=1,
    )
    assert wf["300"]["class_type"] == "LoadVideo"
    assert wf["350"]["class_type"] == "GetVideoComponents"
    scale = wf["380"]
    assert scale["class_type"] == "ImageScale"
    assert scale["inputs"]["image"] == ["350", 0]
    assert (scale["inputs"]["width"], scale["inputs"]["height"]) == (1368, 768)
    # Crop must stay disabled: the size already matches the source ratio, so
    # cropping would throw away picture the blocking depends on.
    assert scale["inputs"]["crop"] == "disabled"
    # Frames route through the resize; the native audio stream does not.
    assert wf["31"]["inputs"]["ref_videos.ref_video_0"] == ["380", 0]
    assert wf["31"]["inputs"]["ref_video_audios.ref_video_audio_0"] == ["350", 1]


def test_reference_video_passthrough_when_not_oversized():
    """No size requested (or the source already fits) leaves the graph as it
    was, so existing callers are unaffected."""
    for sizes in (None, [None]):
        wf = wb.build_h3_video_workflow(
            prompt="x",
            video_reference_filenames=["previs.mp4"],
            video_reference_sizes=sizes,
            width=1376, height=768, length=124, steps=4, seed=1,
        )
        assert "380" not in wf, sizes
        assert wf["31"]["inputs"]["ref_videos.ref_video_0"] == ["350", 0]
        assert wf["31"]["inputs"]["ref_video_audios.ref_video_audio_0"] == ["350", 1]


def test_reference_video_sizes_track_filenames_not_positions():
    """Image files are dropped from the video list, so a size must follow its
    filename rather than its index in the caller's list."""
    wf = wb.build_h3_video_workflow(
        prompt="x",
        video_reference_filenames=["still.png", "previs.mp4"],
        video_reference_sizes=[None, (640, 360)],
        width=1376, height=768, length=124, steps=4, seed=1,
    )
    assert wf["300"]["inputs"]["file"] == "previs.mp4"
    assert (wf["380"]["inputs"]["width"], wf["380"]["inputs"]["height"]) == (640, 360)
    assert wf["31"]["inputs"]["ref_videos.ref_video_0"] == ["380", 0]


if __name__ == "__main__":
    test_t2va_workflow()
    test_i2va_workflow()
    test_fl2va_workflow()
    test_first_frame_does_not_renumber_picture_labels()
    test_silent_reference_video_gets_no_audio_mount()
    test_ref2va_video_editing_and_revoicing()
    test_h3_latent_upscale_workflow()
    test_h3_refine_defaults_are_the_measured_ones()
    test_reference_video_downscale_keeps_aspect_ratio()
    test_reference_video_passthrough_when_not_oversized()
    test_reference_video_sizes_track_filenames_not_positions()
    print("All MiniMax H3 workflow tests passed successfully!")


def test_continuation_also_saves_untrimmed_clip():
    # The motion-context overlap is cut off the result; the whole decode is saved
    # as well (H3_Full_<tag>) so the seam can be seen and edited on the canvas.
    wf = wb.build_h3_video_workflow(
        prompt="p", motion_context_latent="H3_Latent_abc_00001_.safetensors", pair_tag="abc",
    )
    assert wf["60"]["inputs"]["images"] == ["82", 0]
    assert wf["63"]["inputs"]["images"] == ["50", 0]
    assert wf["64"]["inputs"]["filename_prefix"] == "H3_Full_abc"
    plain = wb.build_h3_video_workflow(prompt="p", pair_tag="abc")
    assert "64" not in plain


def test_first_frame_of_a_continuation_goes_after_the_context_window():
    # The first context_length frames are regenerated from the previous clip, so a guide
    # at frame 0 would be overwritten there. It goes on the first frame after the window.
    kw = dict(prompt="p", first_frame_filename="start.png", image_reference_filenames=["ref.png"])
    plain = wb.build_h3_video_workflow(**kw)
    assert plain["71"]["inputs"]["frame_idx"] == 0
    latent = wb.build_h3_video_workflow(motion_context_latent="H3_Latent_abc_00001_.safetensors", pair_tag="abc", **kw)
    assert latent["71"]["inputs"]["frame_idx"] == 22
    short = wb.build_h3_video_workflow(motion_context_latent="H3_Latent_abc_00001_.safetensors",
                                       motion_context_length=10, pair_tag="abc", **kw)
    assert short["71"]["inputs"]["frame_idx"] == 10


def test_video_depth_keeps_size_and_rate_and_drops_audio():
    wf = wb.build_video_depth_workflow("ref.mp4", 59.94)
    assert wf["vd:3"]["inputs"]["image"] == ["vd:2", 0]
    assert wf["vd:5"]["inputs"]["width"] == ["vd:4", 0]
    assert wf["vd:6"]["inputs"]["fps"] == 59.94
    assert "audio" not in wf["vd:6"]["inputs"]


def test_control_video_is_read_at_24_fps():
    import inspect
    src = inspect.getsource(wb.build_h3_video_workflow)
    assert '"force_rate": 24' in src.split("control_video_filename,", 1)[1].split("ModelPatchLoader", 1)[0]
