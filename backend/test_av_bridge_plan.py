"""The AV bridge's frame arithmetic, which decides whether a repair can run at all."""
import workflow_builders as wb


def test_lengths_snap_onto_the_h3_video_grid():
    assert wb.snap_h3_length(100) == 107
    assert wb.snap_h3_length(107) == 107
    assert wb.snap_h3_length(108) == 124
    # Nothing shorter than one H3 run exists.
    assert wb.snap_h3_length(1) == 5


def test_preserved_runs_only_land_on_shared_av_boundaries():
    assert wb.snap_h3_preserve(39) == 39
    assert wb.snap_h3_preserve(60) == 39       # 56 is a video run but not an AV one
    assert wb.snap_h3_preserve(90) == 90
    assert wb.snap_h3_preserve(10) == 39       # 39 is the floor


def test_plan_leaves_room_for_the_middle():
    preserve, target, middle = wb.bridge_plan(30, 39)
    assert (preserve, target) == (39, 124)
    assert middle == target - 2 * preserve == 46
    assert target % 17 == 5 % 17

    # A long context is what makes a short repair expensive: the same 30 frames
    # now need a 226-frame run.
    preserve, target, middle = wb.bridge_plan(30, 90)
    assert (preserve, target, middle) == (90, 226, 46)


def test_bridge_graph_wires_the_source_into_both_ends():
    wf = wb.build_h3_av_bridge_workflow("clip.mp4", "prompt", head_end=137, tail_start=167,
                                        preserve=39, target=107)
    head, tail = wf["bridge:head"]["inputs"], wf["bridge:tail"]["inputs"]
    assert head["frame_load_cap"] == 137 and head["skip_first_frames"] == 0
    # The tail runs to the end of the clip (cap 0): the bridge freezes its first 39
    # frames and the assembly lays the rest back. A cap of 39 truncated the output.
    assert tail["frame_load_cap"] == 0 and tail["skip_first_frames"] == 167
    assert wf["bridge:mask"]["inputs"]["preserve_frames"] == 39
    assert wf["bridge:cond"]["inputs"]["length"] == 107
    # The bridge is text-only: a reference image anywhere here would be the bug
    # that made it speak the reference recording's words.
    assert not any(n["class_type"] in ("LoadImage", "LoadAudio") for n in wf.values())
    # The sampler latent is kept, so the repaired span can go through the H3 latent upscale.
    assert wf["bridge:latent"]["class_type"] == "MiniMaxH3MotionContextSaveLatent"
    assert wf["bridge:latent"]["inputs"]["latent"] == ["bridge:run", 0]
    # Assembly comes from the pack, not from a splice of ours.
    assert wf["bridge:out"]["inputs"]["images"] == ["bridge:join_tail", 2]
    assert wf["bridge:out"]["inputs"]["audio"] == ["bridge:join_audio", 0]
