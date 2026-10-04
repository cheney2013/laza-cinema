"""The swap node repaints one frame of the clip with the photo's person and uses it as the Viggle
reference. 换人 takes the whole person, 换头 the face, hair colour and bangs. The frame choice, the
crop, the prompt and the request sent to Qwen are what can go wrong without anything failing loudly."""
import asyncio
from pathlib import Path
from unittest import mock

import face_prompt
import main
from face_crop import bust_crop_box, frontal_score, pick_best, yaw_ratio
from main import (CharswapRequest, _charswap_face_reference, charswap_face_frame_seconds,
                  charswap_face_prompt, charswap_inspect_report)


# ── which moment of the clip is repainted ────────────────────────────────────

def test_frame_defaults_to_the_middle_of_the_clip():
    assert charswap_face_frame_seconds(-1.0, 5.0) == 2.5


def test_requested_frame_is_used():
    assert charswap_face_frame_seconds(3.5, 5.17) == 3.5


def test_a_time_past_the_end_is_pulled_back_inside_the_clip():
    assert charswap_face_frame_seconds(9.0, 5.0) == 4.95
    assert charswap_face_frame_seconds(5.0, 5.0) == 4.95


def test_a_very_short_clip_never_goes_negative():
    assert charswap_face_frame_seconds(-1.0, 0.02) == 0.0
    assert charswap_face_frame_seconds(1.0, 0.02) == 0.0


def test_a_frontal_face_scores_above_a_turned_one_of_the_same_size():
    straight = frontal_score(0.16, yaw_ratio(100, 140, 120))      # nose between the eyes
    turned = frontal_score(0.16, yaw_ratio(100, 140, 134))
    profile = frontal_score(0.16, yaw_ratio(100, 140, 142))
    assert straight > turned > 0
    assert profile == 0


def test_a_bigger_face_beats_a_smaller_one_at_the_same_angle():
    assert frontal_score(0.20, 0.1) > frontal_score(0.10, 0.1)


def test_pick_best_takes_the_highest_score_and_none_without_a_face():
    report = [{"t": 0.0, "score": 0.0}, {"t": 1.0, "score": 0.05}, {"t": 2.0, "score": 0.09}, {"t": 3.0, "score": 0.07}]
    assert pick_best(report) == 2.0
    assert pick_best([{"t": 0.0, "score": 0.0}]) is None
    assert pick_best([]) is None


# ── the crop of the photo ────────────────────────────────────────────────────

def test_a_small_face_in_a_full_length_photo_is_cropped_to_a_bust():
    # The 1279x2275 photo that failed: the face is 179 px wide, 14% of the picture.
    left, top, w, h = bust_crop_box((495, 939, 179, 208), 1279, 2275)
    assert (w, h) == (430, 591)                       # 3:4 portrait, 2.4 face widths wide
    assert left < 495 and left + w > 495 + 179        # the whole face is inside, centred
    assert top < 939 and top + h > 939 + 208          # hair above the forehead, shoulders below


def test_a_face_that_already_fills_the_picture_is_left_alone():
    assert bust_crop_box((100, 80, 400, 450), 1000, 1200) is None


def test_the_crop_stays_inside_the_picture():
    for face in [(5, 5, 60, 70), (940, 1100, 60, 70), (0, 0, 100, 100), (900, 1500, 90, 90)]:
        left, top, w, h = bust_crop_box(face, 1000, 1600)
        assert left >= 0 and top >= 0 and left + w <= 1000 and top + h <= 1600, face


def test_the_wide_crop_shows_more_body_than_the_bust_crop():
    face = (495, 939, 179, 208)
    bust = bust_crop_box(face, 1279, 2275)
    wide = bust_crop_box(face, 1279, 2275, wide=True)
    assert wide[2] > bust[2] and wide[3] > bust[3]
    assert wide[1] + wide[3] <= 2275 and wide[0] >= 0


# ── the edit prompt ──────────────────────────────────────────────────────────

FRAME_TEXT = (
    "PERSON: a woman in her forties\n"
    "CLOTHES: a grey wool coat with a wide collar over a dark shirt\n"
    "SETTING: beside a rain-streaked window in dim blue light\n"
    "POSE: looking back over her shoulder at the camera\n"
    "HAIR: a short bob ending at the chin, no bangs."
)
PHOTO_TEXT = "HAIR: black hair with full see-through bangs\nFACE: a small face and a gentle smile"


def test_request_defaults():
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/b.png")
    assert req.mode == "person"
    assert req.face_frame_seconds < 0
    assert req.face_prompt == ""


def test_each_mode_has_its_own_generic_default_and_the_callers_prompt_wins():
    assert charswap_face_prompt("", "head") == main.CHARSWAP_FACE_PROMPT
    assert charswap_face_prompt("", "person") == main.CHARSWAP_PERSON_PROMPT
    assert "Nothing of the original person may remain" in main.CHARSWAP_PERSON_PROMPT
    for prompt in (main.CHARSWAP_FACE_PROMPT, main.CHARSWAP_PERSON_PROMPT):
        assert "<image 1>" in prompt and "<image 2>" in prompt
    mine = "  Edit <image 1>, a woman in a grey wool coat. Give her the hair of <image 2>.  "
    assert charswap_face_prompt(mine, "head") == mine.strip()
    assert charswap_face_prompt("   ", "head") == charswap_face_prompt("", "head")


def test_labelled_lines_are_parsed_and_noise_is_ignored():
    got = face_prompt.parse_fields("Here you go:\n**PERSON**: a man.\n- clothes: a red coat\nHAIR:\nnonsense", face_prompt.FRAME_FIELDS)
    assert got == {"person": "a man", "clothes": "a red coat"}      # empty HAIR and free text dropped


def test_the_first_value_of_a_repeated_key_wins():
    assert face_prompt.parse_fields("HAIR: short\nHAIR: long", ("hair",)) == {"hair": "short"}


def test_head_prompt_says_what_is_in_the_frame_what_the_new_hair_is_and_what_stays():
    frame = face_prompt.parse_fields(FRAME_TEXT, face_prompt.FRAME_FIELDS)
    photo = face_prompt.parse_fields(PHOTO_TEXT, face_prompt.PHOTO_FIELDS)
    prompt = face_prompt.compose_face_prompt(frame, photo)
    assert prompt.startswith("Edit <image 1>, a photograph of a woman in her forties wearing a grey wool coat")
    assert "<image 2>" in prompt and "black hair with full see-through bangs" in prompt
    assert "The hair stays a short bob ending at the chin, no bangs, like the hair in <image 1>" in prompt
    assert "nothing hangs down the back" in prompt
    assert "Keep everything else in <image 1> exactly as it is: a grey wool coat with a wide collar over a dark shirt, the turn of the shoulders" in prompt
    assert "the a " not in prompt


def test_a_missing_fact_gives_no_head_prompt():
    frame = face_prompt.parse_fields(FRAME_TEXT, face_prompt.FRAME_FIELDS)
    del frame["hair"]
    assert face_prompt.compose_face_prompt(frame, {"hair": "black", "face": "small"}) is None
    assert face_prompt.compose_face_prompt({}, {}) is None


def test_person_prompt_takes_face_hair_and_clothes_from_the_photo():
    frame = face_prompt.parse_fields(FRAME_TEXT, face_prompt.FRAME_FIELDS)
    photo = face_prompt.parse_fields(
        "CLOTHES: a cream halter-neck dress\nHAIR: black hair with full bangs\nFACE: a small face and a smile",
        face_prompt.PERSON_PHOTO_FIELDS)
    prompt = face_prompt.compose_person_prompt(frame, photo)
    assert "Replace the person with the person in <image 2>: a small face and a smile, black hair with full bangs, wearing a cream halter-neck dress exactly as in <image 2>" in prompt
    assert "Nothing of the original person may remain" in prompt
    assert "grey wool coat" not in prompt                      # the clip's clothes are not kept
    assert "looking back over her shoulder at the camera" in prompt


def test_person_prompt_needs_the_photos_clothes():
    frame = face_prompt.parse_fields(FRAME_TEXT, face_prompt.FRAME_FIELDS)
    assert face_prompt.compose_person_prompt(frame, {"hair": "black", "face": "small"}) is None


# ── the reference step ───────────────────────────────────────────────────────

def _reference(mode="head", face_prompt_text="mine <image 1> <image 2>", seconds=1.0, auto_result=None,
               best=None, crop=False, duration=5.0, seed=95051):
    """Run the reference step with the model calls stood in. Returns (url, seconds, prompt), what was
    cut from the clip, what Qwen was asked, and the `wide` flag the crop was given."""
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png", mode=mode,
                          face_frame_seconds=seconds, face_prompt=face_prompt_text, seed=seed)
    cut, asked, wide = [], [], []

    async def fake_qwen(job_arg, qwen_req):
        asked.append(qwen_req)
        return {"url": "/uploads/q.png", "seed": qwen_req.seed}

    async def fake_auto(frame_name, photo_path, mode_arg="head", job=None):
        return auto_result

    def fake_crop(src, dst, wide_arg=False):
        wide.append(wide_arg)
        return crop

    with mock.patch.object(main, "_extract_video_still", side_effect=lambda s_, t_, sec: cut.append((Path(t_).name, sec))), \
            mock.patch.object(main, "_run_qwen_image_job", side_effect=fake_qwen), \
            mock.patch.object(main, "_auto_face_prompt", side_effect=fake_auto), \
            mock.patch.object(main.face_crop, "best_face_frame", return_value=best), \
            mock.patch.object(main.face_crop, "crop_to_bust", side_effect=fake_crop), \
            mock.patch.object(main, "save_state"):
        out = asyncio.run(_charswap_face_reference({"id": "j1"}, req, Path("a.mp4"), duration, Path("who.png")))
    return out, cut, asked, wide


def test_the_cut_frame_and_the_photo_go_to_qwen_in_picture_order():
    out, cut, asked, _ = _reference(seconds=3.5)
    assert out == ("/uploads/q.png", 3.5, "mine <image 1> <image 2>")
    assert cut == [("charswap_face_src_j1.png", 3.5)]
    # Picture order is the model's <image N> numbering: the frame is edited, the photo is the person.
    assert asked[0].reference_urls == ["/uploads/charswap_face_src_j1.png", "/uploads/who.png"]
    assert asked[0].seed == 95051


def test_a_cropped_photo_is_what_qwen_gets_when_there_is_a_crop():
    _, _, asked, _ = _reference(crop=True)
    assert asked[0].reference_urls[1] == "/uploads/charswap_face_crop_j1.png"


def test_a_negative_frame_time_takes_the_best_face_frame_else_the_middle():
    for best, expect in ((4.2, 4.2), (None, 2.5)):
        out, cut, _, _ = _reference(seconds=-1.0, best=best)
        assert out[1] == expect and cut == [("charswap_face_src_j1.png", expect)]


def test_the_crop_is_wide_for_the_whole_person_and_a_bust_for_the_head():
    assert _reference(mode="person")[3] == [True]
    assert _reference(mode="head")[3] == [False]


def test_an_empty_prompt_is_written_automatically():
    out, _, asked, _ = _reference(face_prompt_text="", auto_result="Edit <image 1>, written by the model <image 2>")
    assert asked[0].prompt == out[2] == "Edit <image 1>, written by the model <image 2>"


def test_the_callers_prompt_is_never_overwritten_by_the_automatic_one():
    _, _, asked, _ = _reference(face_prompt_text="my own <image 1> <image 2>", auto_result="automatic")
    assert asked[0].prompt == "my own <image 1> <image 2>"


def test_when_the_vision_step_fails_the_modes_generic_prompt_is_used():
    for mode in ("head", "person"):
        _, _, asked, _ = _reference(mode=mode, face_prompt_text="", auto_result=None)
        assert asked[0].prompt == charswap_face_prompt("", mode)


def test_the_automatic_prompt_is_asked_for_in_the_requests_mode():
    seen = []

    async def fake_auto(frame_name, photo_path, mode="head", job=None):
        seen.append(mode)
        return None

    for mode in ("person", "head"):
        req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png",
                              mode=mode, face_frame_seconds=1.0)

        async def fake_qwen(job_arg, qwen_req):
            return {"url": "/uploads/q.png", "seed": 1}

        with mock.patch.object(main, "_extract_video_still"), \
                mock.patch.object(main, "_run_qwen_image_job", side_effect=fake_qwen), \
                mock.patch.object(main, "_auto_face_prompt", side_effect=fake_auto), \
                mock.patch.object(main.face_crop, "crop_to_bust", return_value=False), \
                mock.patch.object(main, "save_state"):
            asyncio.run(_charswap_face_reference({"id": "j2"}, req, Path("a.mp4"), 5.0, Path("who.png")))
        assert seen[-1] == mode


# ── the inspection report ────────────────────────────────────────────────────

def _survey(*rows):
    return [{"t": t, "face_ratio": ratio, "yaw": 0.0, "score": score} for t, ratio, score in rows]


def test_inspect_warns_about_a_clip_that_opens_on_the_back_of_a_head():
    survey = _survey((0.0, 0, 0), (0.5, 0, 0), (1.5, 0.16, 0.02), (3.0, 0.16, 0.09))
    report = charswap_inspect_report(survey, 5.17, 124, 0.14)
    assert report["best_frame_seconds"] == 3.0
    assert any("seen from behind" in w for w in report["warnings"])
    assert any("crops it to a bust" in w for w in report["warnings"])


def test_inspect_says_so_when_there_is_no_face_at_all():
    report = charswap_inspect_report(_survey((0.0, 0, 0), (1.0, 0, 0)), 2.0, 48, None)
    assert report["best_frame_seconds"] is None
    assert any("No face found in any sampled frame" in w for w in report["warnings"])
    assert any("No face found in the photo" in w for w in report["warnings"])


def test_inspect_is_quiet_when_everything_is_fine():
    survey = _survey((0.0, 0.2, 0.15), (1.0, 0.2, 0.15))
    assert charswap_inspect_report(survey, 2.0, 48, 0.4)["warnings"] == []


def test_inspect_notes_a_clip_longer_than_one_pass():
    survey = _survey((0.0, 0.2, 0.15))
    assert any("124" in w for w in charswap_inspect_report(survey, 10.0, 240, 0.4)["warnings"])


# ── cancelling a swap ────────────────────────────────────────────────────────

from comfyui_client import ComfyUIError  # noqa: E402


def _cancel_during(stage):
    """Run the reference step with the job marked cancelled by `stage` ("extract", "describe" or
    "qwen"); return the Qwen calls made and the error raised."""
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png",
                          mode="head", face_frame_seconds=1.0)
    job = {"id": "jc", "status": "running"}
    asked = []

    def cancel():
        job["status"] = "cancelled"

    def extract(source, target, seconds):
        if stage == "extract":
            cancel()

    async def fake_auto(frame_name, photo_path, mode="head", job=None):
        if stage == "describe":
            cancel()
        return "auto <image 1> <image 2>"

    async def fake_qwen(job_arg, qwen_req):
        asked.append(qwen_req)
        if stage == "qwen":
            cancel()
        return {"url": "/uploads/q.png", "seed": 1}

    error = None
    with mock.patch.object(main, "_extract_video_still", side_effect=extract), \
            mock.patch.object(main, "_run_qwen_image_job", side_effect=fake_qwen), \
            mock.patch.object(main, "_auto_face_prompt", side_effect=fake_auto), \
            mock.patch.object(main.face_crop, "crop_to_bust", return_value=False), \
            mock.patch.object(main, "save_state"):
        try:
            asyncio.run(_charswap_face_reference(job, req, Path("a.mp4"), 5.0, Path("who.png")))
        except ComfyUIError as exc:
            error = exc
    return asked, error


def test_a_cancel_before_the_description_stops_the_swap_before_qwen():
    asked, error = _cancel_during("extract")
    assert error is not None and "cancelled" in str(error) and asked == []


def test_a_cancel_during_the_description_stops_the_swap_before_qwen():
    asked, error = _cancel_during("describe")
    assert error is not None and asked == []


def test_a_cancel_during_qwen_stops_the_swap_before_viggle():
    asked, error = _cancel_during("qwen")
    assert len(asked) == 1 and error is not None


def test_stop_if_cancelled_is_silent_for_a_live_job():
    main._stop_if_cancelled({"status": "running"})
    try:
        main._stop_if_cancelled({"status": "cancelled"})
    except ComfyUIError:
        return
    raise AssertionError("a cancelled job must stop")


def test_a_cancelled_description_is_not_swallowed_as_a_failed_vision_step():
    job = {"id": "jd", "status": "running"}

    async def go():
        async def upload(data, name):
            return name

        async def describe(name, ask, max_length=220, on_queued=None):
            job["status"] = "cancelled"
            raise ComfyUIError("Execution interrupted")

        with mock.patch.object(main.comfyui, "upload_image", side_effect=upload), \
                mock.patch.object(main.comfyui, "describe_image", side_effect=describe), \
                mock.patch.object(Path, "read_bytes", return_value=b"x"):
            return await main._auto_face_prompt("f.png", Path("p.png"), "head", job)

    try:
        asyncio.run(go())
    except ComfyUIError:
        return
    raise AssertionError("the cancel must reach the job runner, not become a fallback prompt")


def test_a_failed_vision_step_still_falls_back_when_nobody_cancelled():
    job = {"id": "je", "status": "running"}

    async def go():
        async def upload(data, name):
            return name

        async def describe(name, ask, max_length=220, on_queued=None):
            raise ComfyUIError("out of memory")

        with mock.patch.object(main.comfyui, "upload_image", side_effect=upload), \
                mock.patch.object(main.comfyui, "describe_image", side_effect=describe), \
                mock.patch.object(Path, "read_bytes", return_value=b"x"):
            return await main._auto_face_prompt("f.png", Path("p.png"), "head", job)

    assert asyncio.run(go()) is None


def test_the_qwen_job_records_its_prompt_so_a_cancel_can_interrupt_it(tmp_path):
    job = {"id": "jq", "status": "running"}
    req = main.QwenImageRequest(prompt="p", reference_urls=[])
    seen = {}

    async def fake_generate(**kwargs):
        seen["on_queued"] = kwargs["on_queued"]
        kwargs["on_queued"]("prompt-9")
        return b"png"

    with mock.patch.object(main.comfyui, "generate_qwen_image_21", side_effect=fake_generate), \
            mock.patch.object(main, "UPLOAD_DIR", tmp_path), \
            mock.patch.object(main, "save_state"):
        asyncio.run(main._run_qwen_image_job(job, req))
    assert job["prompt_id"] == "prompt-9"


# ── the view of the person: the new person is drawn from the same side ───────

BACK_FRAME_TEXT = (
    "PERSON: an adult\n"
    "CLOTHES: a green sweatshirt and beige linen trousers, bare feet\n"
    "SETTING: on a pale oak floor in even daylight\n"
    "POSE: crawling on hands and knees with the left knee forward\n"
    "VIEW: from behind and above, the head cut off by the top of the frame\n"
    "HAIR: not visible"
)


def test_the_view_line_is_parsed_but_not_required():
    got = face_prompt.parse_fields(BACK_FRAME_TEXT, face_prompt.FRAME_FIELDS + ("view",))
    assert got["view"] == "from behind and above, the head cut off by the top of the frame"
    frame = face_prompt.parse_fields(FRAME_TEXT, face_prompt.FRAME_FIELDS)      # no VIEW line at all
    photo = face_prompt.parse_fields(PHOTO_TEXT, face_prompt.PHOTO_FIELDS)
    assert face_prompt.compose_face_prompt(frame, photo) is not None


def test_a_person_seen_from_behind_is_drawn_from_behind_and_without_a_face():
    frame = face_prompt.parse_fields(BACK_FRAME_TEXT, face_prompt.FRAME_FIELDS + ("view",))
    photo = face_prompt.parse_fields(
        "CLOTHES: a cream halter-neck dress\nHAIR: black hair to the shoulders\nFACE: a small face and a smile",
        face_prompt.PERSON_PHOTO_FIELDS)
    prompt = face_prompt.compose_person_prompt(frame, photo)
    assert "crawling on hands and knees with the left knee forward, from behind and above, the head cut off by the top of the frame" in prompt
    assert "shown from behind and above, the head cut off by the top of the frame in the same pose as in <image 1>" in prompt
    assert "black hair to the shoulders, wearing a cream halter-neck dress exactly as in <image 2>" in prompt
    assert "a small face and a smile" not in prompt            # there is no face to draw from behind
    assert "the camera view (from behind and above" in prompt
    assert "green sweatshirt" not in prompt and "a photograph of a person," in prompt   # the clip's person is replaced, not described


def test_a_person_seen_from_the_front_keeps_the_face_in_the_prompt():
    frame = face_prompt.parse_fields(
        BACK_FRAME_TEXT.replace("from behind and above, the head cut off by the top of the frame", "from the front at eye level, the face visible"),
        face_prompt.FRAME_FIELDS + ("view",))
    photo = face_prompt.parse_fields(
        "CLOTHES: a cream halter-neck dress\nHAIR: black hair\nFACE: a small face and a smile", face_prompt.PERSON_PHOTO_FIELDS)
    assert "a small face and a smile, black hair" in face_prompt.compose_person_prompt(frame, photo)


def test_head_mode_also_says_from_which_side_the_person_is_seen():
    frame = face_prompt.parse_fields(
        FRAME_TEXT + "\nVIEW: from the front at eye level, the face visible", face_prompt.FRAME_FIELDS + ("view",))
    photo = face_prompt.parse_fields(PHOTO_TEXT, face_prompt.PHOTO_FIELDS)
    prompt = face_prompt.compose_face_prompt(frame, photo)
    assert "looking back over her shoulder at the camera, from the front at eye level, the face visible" in prompt
    assert "a small face and a gentle smile" in prompt


def test_the_frame_question_asks_for_the_view():
    assert "VIEW:" in face_prompt.FRAME_ASK and "eight lines" in face_prompt.FRAME_ASK


# ── a ready-made reference, and several people in one clip ───────────────────

import face_crop  # noqa: E402


def _run_job(req, tmp_path, job=None, viggle=None):
    """Run a swap job with every outside step stubbed; return what was called and the result."""
    calls = {"repaint": 0, "people": 0, "auto": 0, "viggle": []}

    async def fake_repaint(job, request, video, duration, still):
        calls["repaint"] += 1
        return "/uploads/repainted.png", 1.0, "repaint prompt"

    async def fake_people(job, request, video, duration):
        calls["people"] += 1
        return "/uploads/people.png", 0.5, "people prompt"

    async def fake_auto(*args, **kwargs):
        calls["auto"] += 1
        return "auto"

    async def resolve(url):
        return tmp_path / url.rsplit("/", 1)[-1]

    async def upload_video(data, name):
        return name

    async def upload_image(data, name):
        calls.setdefault("uploaded", []).append(name)
        return name

    async def default_viggle(**kwargs):
        calls["viggle"].append(kwargs["reference_filename"])
        return b"mp4"

    viggle = viggle or default_viggle

    async def free(**kwargs):
        return True

    for name in ("a.mp4", "who.png", "given.png", "repainted.png", "people.png"):
        (tmp_path / name).write_bytes(b"x")
    job = job if job is not None else {"id": "jj", "status": "running"}
    with mock.patch.object(main, "require_node"), \
            mock.patch.object(main, "resolve_upload", side_effect=resolve), \
            mock.patch.object(main, "_probe_video_geometry", return_value=(1376, 768, 120)), \
            mock.patch.object(main, "_probe_fps", return_value=24.0), \
            mock.patch.object(main, "_has_audio_stream", return_value=False), \
            mock.patch.object(main, "_charswap_face_reference", side_effect=fake_repaint), \
            mock.patch.object(main, "_charswap_people_reference", side_effect=fake_people), \
            mock.patch.object(main, "_auto_face_prompt", side_effect=fake_auto), \
            mock.patch.object(main, "UPLOAD_DIR", tmp_path), \
            mock.patch.object(main, "save_state"), \
            mock.patch.object(main.comfyui, "upload_video", side_effect=upload_video), \
            mock.patch.object(main.comfyui, "upload_image", side_effect=upload_image), \
            mock.patch.object(main.comfyui, "charswap_viggle", side_effect=viggle), \
            mock.patch.object(main.comfyui, "free_memory", side_effect=free):
        result = asyncio.run(main._run_charswap_job(job, req))
    return calls, result


def test_a_ready_made_reference_goes_to_viggle_without_any_repaint(tmp_path):
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/given.png", mode="reference")
    calls, result = _run_job(req, tmp_path)
    assert calls["repaint"] == 0 and calls["people"] == 0 and calls["auto"] == 0
    assert calls["viggle"] == ["given.png"]
    assert result["mode"] == "reference" and result["face_prompt"] == ""
    assert result["reference"]["url"] == result["reference"]["source_url"] == "/uploads/given.png"


def test_a_single_person_swap_still_repaints_one_frame(tmp_path):
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png", mode="person")
    calls, result = _run_job(req, tmp_path)
    assert calls["repaint"] == 1 and calls["people"] == 0
    assert calls["viggle"] == ["repainted.png"] and result["face_prompt"] == "repaint prompt"


def test_pointed_people_take_the_people_route_and_the_repaint_goes_to_viggle(tmp_path):
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png", mode="person",
                          targets=[{"x": 0.7, "y": 0.5, "image_url": "/uploads/who.png"}])
    calls, result = _run_job(req, tmp_path)
    assert calls["people"] == 1 and calls["repaint"] == 0
    assert calls["viggle"] == ["people.png"] and result["face_frame_seconds"] == 0.5


def test_pointed_people_need_person_mode():
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png", mode="head",
                          targets=[{"x": 0.7, "y": 0.5, "image_url": "/uploads/who.png"}])
    try:
        asyncio.run(main._run_charswap_job({"id": "jt", "status": "running"}, req))
    except ValueError as exc:
        assert "person mode" in str(exc)
        return
    raise AssertionError("targets in head mode must be refused")


def test_a_target_point_must_lie_on_the_frame_and_there_are_at_most_four():
    import pydantic
    for bad in ({"x": 1.2, "y": 0.5}, {"x": 0.5, "y": -0.1}):
        try:
            main.CharswapTarget(image_url="/uploads/p.png", **bad)
        except pydantic.ValidationError:
            continue
        raise AssertionError(f"{bad} is off the frame")
    five = [{"x": 0.1 * i, "y": 0.5, "image_url": "/uploads/p.png"} for i in range(1, 6)]
    try:
        CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/p.png", targets=five)
    except pydantic.ValidationError:
        return
    raise AssertionError("five targets are one too many")


PHOTO_FACTS = {"clothes": "a teal shirt dress", "hair": "short curly auburn hair", "face": "round glasses and a wide smile"}


def test_the_people_prompt_names_each_replaced_person_and_keeps_the_rest():
    prompt = face_prompt.compose_people_prompt([
        {"x": 0.25, "wears": "dark hair and a mustard cardigan", "view": "from the front, the face visible", "photo": PHOTO_FACTS},
        {"x": 0.75, "wears": "short black hair and a grey hoodie", "view": "from the front, the face visible",
         "photo": {"clothes": "a red plaid shirt", "hair": "a bald head", "face": "a short beard"}},
    ])
    assert prompt.startswith("Edit <image 1>. Replace the person on the left")
    assert "Replace the person on the left of the frame, about 25% from the left edge, who has dark hair and a mustard cardigan, with the person in <image 2>" in prompt
    assert "round glasses and a wide smile, short curly auburn hair, wearing a teal shirt dress exactly as in <image 2>" in prompt
    assert "the person on the right of the frame, about 75% from the left edge" in prompt and "<image 3>" in prompt
    assert "Everyone else in <image 1> stays exactly as they are" in prompt
    assert "no person is added and none is removed" in prompt and "arms or a torso" in prompt
    assert "the positions and the poses of all the people" in prompt


def test_the_people_prompt_draws_no_face_for_a_person_seen_from_behind():
    prompt = face_prompt.compose_people_prompt([
        {"x": 0.5, "wears": "a white blouse", "view": "from behind, the face not visible", "photo": PHOTO_FACTS}])
    assert "the person in the middle of the frame" in prompt
    assert "short curly auburn hair, wearing a teal shirt dress" in prompt
    assert "round glasses" not in prompt


def test_the_people_prompt_still_works_when_the_vision_model_said_nothing():
    prompt = face_prompt.compose_people_prompt([{"x": 0.9, "wears": "", "view": "", "photo": {}}])
    assert "Replace the person on the right of the frame, about 90% from the left edge, with the person in <image 2>." in prompt
    assert "stays exactly as they are" in prompt


def test_the_strip_around_a_click_is_moved_not_shrunk_at_the_edge():
    left, top, w, h = face_crop.point_crop_box(0.5, 0.5, 1000, 500)
    assert (w, h) == (280, 400) and left == 360 and top == 50
    left, top, w, h = face_crop.point_crop_box(0.02, 0.98, 1000, 500)
    assert (left, top, w, h) == (0, 100, 280, 400)
    left, top, w, h = face_crop.point_crop_box(0.99, 0.01, 1000, 500)
    assert (left + w, top) == (1000, 0)


def test_the_people_reference_uses_the_pointed_frame_and_the_photos_in_order(tmp_path):
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/p1.png", mode="person",
                          seed=5, face_frame_seconds=-1,
                          targets=[{"x": 0.3, "y": 0.5, "image_url": "/uploads/p1.png"},
                                   {"x": 0.7, "y": 0.5, "image_url": "/uploads/p2.png"}])
    job = {"id": "jp", "status": "running"}
    asked, cut = [], []

    async def resolve(url):
        return tmp_path / url.rsplit("/", 1)[-1]

    async def describe(frame_name, target, photo_path, index, job_arg):
        return {"x": target.x, "wears": f"person {index}", "view": "from the front", "photo": PHOTO_FACTS}

    async def qwen(job_arg, qwen_req):
        asked.append(qwen_req)
        return {"url": "/uploads/q.png", "seed": 5}

    with mock.patch.object(main, "resolve_upload", side_effect=resolve), \
            mock.patch.object(main, "_extract_video_still", side_effect=lambda src, dst, sec: cut.append(sec)), \
            mock.patch.object(main, "_describe_target", side_effect=describe), \
            mock.patch.object(main, "_run_qwen_image_job", side_effect=qwen), \
            mock.patch.object(main.face_crop, "crop_to_bust", return_value=False), \
            mock.patch.object(main, "UPLOAD_DIR", tmp_path), \
            mock.patch.object(main, "save_state"):
        url, seconds, prompt = asyncio.run(main._charswap_people_reference(job, req, Path("a.mp4"), 5.0))
    assert url == "/uploads/q.png" and seconds == 0.0 and cut == [0.0]
    assert asked[0].reference_urls == ["/uploads/charswap_face_src_jp.png", "/uploads/p1.png", "/uploads/p2.png"]
    assert "<image 2>" in prompt and "<image 3>" in prompt and asked[0].seed == 5


def test_the_people_reference_takes_the_callers_own_prompt_without_describing_anyone(tmp_path):
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/p1.png", mode="person",
                          face_prompt="my own", face_frame_seconds=2.0,
                          targets=[{"x": 0.3, "y": 0.5, "image_url": "/uploads/p1.png"}])
    job = {"id": "jq", "status": "running"}
    asked = []

    async def resolve(url):
        return tmp_path / url.rsplit("/", 1)[-1]

    async def qwen(job_arg, qwen_req):
        asked.append(qwen_req)
        return {"url": "/uploads/q.png", "seed": 1}

    async def describe(*args, **kwargs):
        raise AssertionError("nobody should be described when the prompt is given")

    with mock.patch.object(main, "resolve_upload", side_effect=resolve), \
            mock.patch.object(main, "_extract_video_still"), \
            mock.patch.object(main, "_describe_target", side_effect=describe), \
            mock.patch.object(main, "_run_qwen_image_job", side_effect=qwen), \
            mock.patch.object(main.face_crop, "crop_to_bust", return_value=False), \
            mock.patch.object(main, "UPLOAD_DIR", tmp_path), \
            mock.patch.object(main, "save_state"):
        _, seconds, prompt = asyncio.run(main._charswap_people_reference(job, req, Path("a.mp4"), 5.0))
    assert prompt == "my own" and seconds == 2.0 and asked[0].prompt == "my own"


# ── a restart must not run a finished swap again ─────────────────────────────

def _comfy_swap(state, files=(("out.mp4", ""),)):
    outputs = {"9": {"videos": [{"filename": n, "subfolder": sub, "type": "output"} for n, sub in files]}}

    async def prompt_state(prompt_id):
        return state, outputs if state == "success" else {}

    async def video_bytes(filename, subfolder="", kind="output"):
        return b"mp4:" + filename.encode()

    return prompt_state, video_bytes


RESULT = {"url": "/uploads/charswap_j1.mp4", "filename": "charswap_j1.mp4", "mode": "person",
          "reference": {"url": "/uploads/q.png", "source_url": "/uploads/p.png"},
          "face_frame_seconds": 1.0, "face_prompt": "p"}


def _collect(job, state, tmp_path):
    prompt_state, video_bytes = _comfy_swap(state)
    with mock.patch.object(main.comfyui, "prompt_state", side_effect=prompt_state), \
            mock.patch.object(main.comfyui, "get_video_bytes", side_effect=video_bytes), \
            mock.patch.object(main, "UPLOAD_DIR", tmp_path):
        return asyncio.run(main._collect_finished(job))


def test_a_finished_viggle_render_is_collected_not_rendered_again(tmp_path):
    job = {"id": "j1", "type": "charswap", "charswap_recovery": {"result": RESULT, "viggle_prompt_id": "pv"}}
    assert _collect(job, "success", tmp_path) == RESULT
    assert (tmp_path / "charswap_j1.mp4").read_bytes() == b"mp4:out.mp4"


def test_a_swap_still_rendering_or_failed_is_run_again(tmp_path):
    for state in ("running", "error", "interrupted"):
        job = {"id": "j1", "type": "charswap", "charswap_recovery": {"result": RESULT, "viggle_prompt_id": "pv"}}
        assert _collect(job, state, tmp_path) is None, state
    assert not (tmp_path / "charswap_j1.mp4").exists()


def test_a_swap_that_had_not_reached_viggle_is_run_again(tmp_path):
    for recovery in (None, {"result": RESULT, "viggle_prompt_id": None}, {"viggle_prompt_id": "pv"}):
        job = {"id": "j1", "type": "charswap", **({"charswap_recovery": recovery} if recovery is not None else {})}
        assert _collect(job, "success", tmp_path) is None, recovery


def test_a_run_from_the_start_forgets_an_earlier_runs_render():
    job = {"id": "j2", "status": "running", "charswap_recovery": {"result": RESULT, "viggle_prompt_id": "old"}}
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png", mode="reference")
    asyncio.run(_expect_missing_video(job, req))
    assert "charswap_recovery" not in job


async def _expect_missing_video(job, req):
    try:
        await main._run_charswap_job(job, req)
    except FileNotFoundError:
        pass


def test_the_viggle_prompt_id_is_recorded_for_a_restart(tmp_path):
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/given.png", mode="reference")
    job = {"id": "jj", "status": "running"}
    seen = {}

    async def viggle(**kwargs):
        kwargs["on_queued"]("prompt-v")
        seen["recovery"] = dict(job["charswap_recovery"])
        return b"mp4"

    calls, result = _run_job(req, tmp_path, job=job, viggle=viggle)
    assert seen["recovery"]["viggle_prompt_id"] == "prompt-v"
    assert seen["recovery"]["result"] == result and job["prompt_id"] == "prompt-v"


def test_a_requeued_swap_waits_for_its_render_and_returns_it_without_running_again(tmp_path):
    job = {"id": "j1", "type": "charswap", "charswap_recovery": {"result": RESULT, "viggle_prompt_id": "pv"}}
    ran = []

    async def runner(j):
        ran.append(j["id"])
        return {}

    prompt_state, video_bytes = _comfy_swap("success")
    with mock.patch.object(main.comfyui, "prompt_state", side_effect=prompt_state),             mock.patch.object(main.comfyui, "get_video_bytes", side_effect=video_bytes),             mock.patch.object(main, "UPLOAD_DIR", tmp_path):
        result = asyncio.run(main._after_prompt("pv", runner)(job))
    assert result == RESULT and ran == [] and job["prompt_id"] == "pv"


def test_a_person_swap_looks_for_the_face_in_the_middle_half_of_the_clip():
    survey = [{"t": 0.5, "score": 0.2}, {"t": 2.5, "score": 0.1}, {"t": 4.9, "score": 0.5}]
    with mock.patch.object(face_crop, "survey_faces", return_value=(survey, 5.0, 120)):
        assert face_crop.best_face_frame(Path("a.mp4")) == 4.9
        assert face_crop.best_face_frame(Path("a.mp4"), central=(0.25, 0.75)) == 2.5
        assert face_crop.best_face_frame(Path("a.mp4"), central=(0.6, 0.8)) is None


def test_the_reference_frame_search_is_central_for_a_person_swap_only(tmp_path):
    seen = []

    def best(video, samples=24, central=None):
        seen.append(central)
        return 2.0

    for mode, want in (("person", (0.25, 0.75)), ("head", None)):
        req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png",
                              mode=mode, face_frame_seconds=-1)
        job = {"id": "jc", "status": "running"}

        async def fake_auto(*args, **kwargs):
            return "auto"

        async def fake_qwen(job_arg, qwen_req):
            return {"url": "/uploads/q.png", "seed": 1}

        with mock.patch.object(main.face_crop, "best_face_frame", side_effect=best),                 mock.patch.object(main, "_extract_video_still"),                 mock.patch.object(main, "_run_qwen_image_job", side_effect=fake_qwen),                 mock.patch.object(main, "_auto_face_prompt", side_effect=fake_auto),                 mock.patch.object(main.face_crop, "crop_to_bust", return_value=False),                 mock.patch.object(main, "save_state"):
            asyncio.run(_charswap_face_reference(job, req, Path("a.mp4"), 5.0, Path("who.png")))
        assert seen[-1] == want, mode


def test_a_view_that_shows_no_face_gets_a_prompt_without_the_face():
    for view in ("from behind and above, the head cut off by the top of the frame",
                 "from above, face not visible", "from the front, the face hidden by her hair",
                 "from above, the face cannot be seen"):
        assert face_prompt._from_behind(view), view
    for view in ("from the front at eye level, the face visible", "from the side, the face visible", ""):
        assert not face_prompt._from_behind(view), view
    frame = face_prompt.parse_fields(BACK_FRAME_TEXT.replace(
        "from behind and above, the head cut off by the top of the frame", "from above, face not visible"),
        face_prompt.FRAME_FIELDS + ("view",))
    photo = face_prompt.parse_fields(
        "CLOTHES: an orange hooded coat\nHAIR: a teal bob\nFACE: large purple eyes and a cheerful smile",
        face_prompt.PERSON_PHOTO_FIELDS)
    prompt = face_prompt.compose_person_prompt(frame, photo)
    assert "purple eyes" not in prompt and "a teal bob, wearing an orange hooded coat" in prompt


# ── the H3-native engine ─────────────────────────────────────────────────────

import job_scheduler  # noqa: E402

H3_SCENE = {"style": "2D Japanese anime with clean outlines", "setting": "on a pale oak floor in warm daylight",
            "camera": "a locked-off first-person shot looking down", "wears": "a navy sailor uniform and long black hair",
            "other": "the viewer's own crossed forearms and a grey t-shirt at the bottom edge"}
H3_POSES = [{"pose": "kneeling on all fours with the head bowed", "view": "from above, face not visible"},
            {"pose": "crawling toward the camera", "view": "from above"},
            {"pose": "looking up at the camera on all fours", "view": "from above, the face turned up"}]
H3_PHOTO = {"clothes": "an orange hooded raincoat, denim shorts and yellow boots",
            "hair": "a short teal bob with a yellow hairclip", "face": "large violet eyes"}


def test_the_h3_length_is_the_largest_5_plus_17k_the_clip_supplies():
    assert [main.charswap_h3_length(n) for n in (124, 125, 140, 141, 175, 200)] == [124, 124, 124, 141, 175, 192]
    assert main.charswap_h3_length(60) == 56 and main.charswap_h3_length(22) == 22


def test_the_h3_size_follows_the_clip_never_goes_above_it_and_sits_on_the_32_grid():
    assert main.charswap_h3_size(1376, 768, small=False) == (1376, 768)
    assert main.charswap_h3_size(1376, 768, small=True) == (864, 480)
    assert main.charswap_h3_size(768, 1376, small=True) == (480, 864)
    assert main.charswap_h3_size(1920, 1080, small=False) == (1376, 768)
    assert main.charswap_h3_size(640, 360, small=False) == (640, 352)      # never up
    assert all(v % 32 == 0 for size in (main.charswap_h3_size(1000, 563, False), main.charswap_h3_size(1000, 563, True)) for v in size)


def test_the_h3_engine_snaps_the_length_chains_windows_for_a_long_clip_and_refuses_a_short_one():
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png", engine="h3")
    sent = _run_h3(req, frames=140)[0][0]
    assert sent.length == 124 and sent.chunk_frames == 0
    long = _run_h3(req, frames=300)[0][0]
    assert long.length == 294 and long.chunk_frames == main.H3_ENGINE_MAX_FRAMES      # 5 + 17k, in windows of 226
    try:
        _run_h3(req, frames=12)
    except ValueError as exc:
        assert "too short" in str(exc)
        return
    raise AssertionError("12 frames must be refused")


def test_the_h3_engine_refuses_head_mode_and_unknown_options():
    base = dict(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png", engine="h3")
    for extra in ({"mode": "head"}, {"mode": "reference"}, {"h3_accel": "fast"}, {"h3_size": "huge"}):
        try:
            _run_h3(CharswapRequest(**base, **extra))
        except ValueError:
            continue
        raise AssertionError(f"{extra} must be refused")
    try:
        _run_h3(CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png", engine="sora"))
    except ValueError as exc:
        assert "engine" in str(exc)
        return
    raise AssertionError("an unknown engine must be refused")


def test_the_viggle_engine_is_the_default_and_never_reaches_the_h3_path(tmp_path):
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png", mode="reference")
    assert req.engine == "viggle" and req.h3_accel == "turbo8" and req.h3_size == "source"
    with mock.patch.object(main, "_run_charswap_h3", side_effect=AssertionError("h3 must not run")):
        calls, _ = _run_job(req, tmp_path)
    assert calls["viggle"]


def test_a_restart_collects_a_finished_h3_render_without_describing_or_rendering_again(tmp_path):
    job = {"id": "jh", "type": "charswap", "prompt_id": "ph",
           "charswap_recovery": {"engine": "h3", "result": {"mode": "h3", "face_frame_seconds": -1.0, "face_prompt": "p"}}}
    outputs = {"9": {"videos": [{"filename": "H3_Video_x.mp4", "subfolder": "", "type": "output"}]}}

    async def prompt_state(prompt_id):
        return "success", outputs

    with mock.patch.object(main.comfyui, "prompt_state", side_effect=prompt_state):
        result = asyncio.run(main._collect_finished(job))
    assert result["url"] == "/comfy_output/H3_Video_x.mp4" and result["mode"] == "h3" and result["face_prompt"] == "p"

    async def describing(prompt_id):          # the last prompt was a description: there is no video to collect
        return "success", {"4": {"text": ["a woman"]}}

    with mock.patch.object(main.comfyui, "prompt_state", side_effect=describing):
        assert asyncio.run(main._collect_finished(job)) is None


H3_PEOPLE_SUBJECTS = [
    {"x": 0.25, "wears": "dark hair and a mustard cardigan",
     "photo": {"clothes": "a teal shirt dress", "hair": "short curly auburn hair", "face": "round glasses"},
     "poses": [{"pose": "standing facing the camera", "view": "from the front"}, {"pose": "turning the head toward the other person"},
               {"pose": "standing shoulder to shoulder, facing the camera"}]},
    {"x": 0.75, "wears": "short black hair and a grey hoodie",
     "photo": {"clothes": "a red plaid shirt", "hair": "a bald head", "face": "a short beard"}, "poses": []}]


def test_where_the_hands_and_knees_are_goes_into_the_pose_and_the_keep_list():
    frame = face_prompt.parse_fields(
        BACK_FRAME_TEXT + "\nLIMBS: both palms flat on the floor beside the head with the arms straight",
        face_prompt.FRAME_FIELDS + ("view", "limbs"))
    photo = face_prompt.parse_fields(
        "CLOTHES: an orange hooded coat\nHAIR: a teal bob\nFACE: purple eyes", face_prompt.PERSON_PHOTO_FIELDS)
    prompt = face_prompt.compose_person_prompt(frame, photo)
    pose = "crawling on hands and knees with the left knee forward (both palms flat on the floor beside the head with the arms straight)"
    assert pose in prompt
    assert "the arms and the legs (both palms flat on the floor beside the head with the arms straight)" in prompt
    assert "LIMBS:" in face_prompt.FRAME_ASK
    plain = face_prompt.compose_person_prompt(
        face_prompt.parse_fields(BACK_FRAME_TEXT, face_prompt.FRAME_FIELDS + ("view",)), photo)
    assert "()" not in plain and "the arms and the legs, the camera view" in plain      # no limbs fact: as before


def test_whatever_else_is_in_the_frame_is_named_in_the_keep_list():
    photo = face_prompt.parse_fields(
        "CLOTHES: an orange hooded coat\nHAIR: a teal bob\nFACE: purple eyes", face_prompt.PERSON_PHOTO_FIELDS)
    frame = face_prompt.parse_fields(
        BACK_FRAME_TEXT + "\nOTHER: the viewer's own crossed forearms at the bottom edge",
        face_prompt.FRAME_FIELDS + ("view", "limbs", "other"))
    assert "the viewer's own crossed forearms at the bottom edge, the setting" in face_prompt.compose_person_prompt(frame, photo)
    assert "OTHER:" in face_prompt.FRAME_ASK
    for none in ("none", "None.", "nothing else", "N/A"):
        frame = face_prompt.parse_fields(BACK_FRAME_TEXT + f"\nOTHER: {none}", face_prompt.FRAME_FIELDS + ("view", "limbs", "other"))
        assert "the camera view (from behind and above, the head cut off by the top of the frame), the setting" in face_prompt.compose_person_prompt(frame, photo), none


# ── the H3 engine with the Character-Swap LoRA ───────────────────────────────

H3_WHO = "the girl with long black hair in a navy sailor uniform"


def test_the_instruction_names_who_is_replaced_and_keeps_the_rest_the_loras_own_way():
    prompt = face_prompt.compose_h3_swap_instruction([{"who": H3_WHO}])
    assert prompt == (
        "Replace only the girl with long black hair in a navy sailor uniform in <Video 1> with the character in <Picture 1>. "
        "Keep the replacement character's identity, outfit, and art style from <Picture 1>. "
        "Preserve the source video's camera, background, lighting, objects, and all other people.")


def test_the_instruction_falls_back_to_the_main_performer_and_drops_a_fact_that_names_an_absence():
    refusal = "There is no person visible in the provided image. The image shows a dog walking in a grassy field."
    for who in ("", None, "nobody in particular", "none", refusal):
        assert "Replace only the main subject in <Video 1>" in face_prompt.compose_h3_swap_instruction([{"who": who}])
    assert "Replace only the main subject in <Video 1>" in face_prompt.compose_h3_swap_instruction([])


def test_pointed_people_are_named_by_place_and_clothes_one_picture_each():
    prompt = face_prompt.compose_h3_swap_instruction([
        {"x": 0.25, "wears": "dark hair and a mustard cardigan"}, {"x": 0.75}])
    assert prompt.startswith(
        "Replace only the person on the left of the frame, who has dark hair and a mustard cardigan, with the character in "
        "<Picture 1> and the person on the right of the frame with the character in <Picture 2>, all in <Video 1>.")
    assert "Keep each replacement character's identity, outfit, and art style from its own picture." in prompt
    assert prompt.endswith("all other people.")


def test_the_who_answer_is_the_first_line_with_or_without_a_label():
    """The model answers the phrase alone, or with a label, or on a second line after a blank one."""
    phrase = "the girl with short black hair in a navy sailor uniform"
    for answer in (phrase, "WHO: " + phrase, "who: " + phrase + ".", "\n\n" + phrase + "\nand more text",
                   "\"" + phrase + "\"", "**" + phrase + "**"):
        assert face_prompt.parse_who(answer) == phrase, answer
    assert face_prompt.parse_who("") == "" and face_prompt.parse_who(None) == "" and face_prompt.parse_who("WHO:") == ""
    assert "noun phrase" in face_prompt.H3_WHO_ASK and "sailor uniform" in face_prompt.H3_WHO_ASK
    assert "a person or an animal" in face_prompt.H3_WHO_ASK and "brown dog" in face_prompt.H3_WHO_ASK


def _run_h3(req, frames=124, size=(1376, 768), targets=None, lora_missing=False):
    """Run the H3 engine with the outside steps stubbed; return the VideoRequest it sent, the targets asked
    for and the result."""
    sent, asked, recoveries = [], [], []

    async def resolve(url):
        return Path(url.rsplit("/", 1)[-1])

    async def fake_targets(job, request, video, duration):
        asked.append(duration)
        return targets if targets is not None else [{"who": H3_WHO}]

    async def fake_video(job, request):
        sent.append(request)
        recoveries.append(job.get("charswap_recovery"))
        name = "H3_Video_x.mp4" if len(sent) == 1 else f"H3_Video_{len(sent)}.mp4"
        return {"url": f"/comfy_output/{name}", "filename": name, "comfy_filename": name}

    job = {"id": "jh", "status": "running"}
    with mock.patch.object(main, "resolve_upload", side_effect=resolve), \
            mock.patch.object(main, "_probe_video_geometry", return_value=(size[0], size[1], frames)), \
            mock.patch.object(main, "_probe_fps", return_value=24.0), \
            mock.patch.object(main, "_charswap_h3_targets", side_effect=fake_targets), \
            mock.patch.object(main, "_h3_swap_lora_missing", return_value=lora_missing), \
            mock.patch.object(main, "_run_video_job", side_effect=fake_video), \
            mock.patch.object(main, "require_node"), \
            mock.patch.object(main, "save_state"):
        result = asyncio.run(main._run_charswap_job(job, req))
    job["recoveries"] = recoveries
    return sent, asked, result, job


def test_the_h3_engine_sends_the_instruction_with_the_swap_lora_on_the_official_base_at_eight_steps():
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png", engine="h3", seed=7)
    sent, asked, result, job = _run_h3(req)
    r = sent[0]
    assert (r.mode, r.ref_video_urls, r.ref_image_urls, r.audio_strategy) == ("edit", ["/uploads/a.mp4"], ["/uploads/who.png"], "copy_source")
    assert (r.motion_preset, r.accel_lora, r.length, r.width, r.height, r.seed) == ("ref2va", "turbo8", 124, 1376, 768, 7)
    assert r.style_loras == [{"name": main.H3_SWAP_LORA, "strength": 1.0}] and r.raw_prompt is True
    assert r.prompt.startswith("Replace only the girl with long black hair in a navy sailor uniform in <Video 1>")
    assert result["mode"] == "h3" and result["face_prompt"] == r.prompt and result["url"] == "/comfy_output/H3_Video_x.mp4"
    assert job["charswap_recovery"]["engine"] == "h3" and len(asked) == 1


def test_the_h3_engine_options_combine():
    for accel, size, want in (("turbo8", "small", ("turbo8", 864, 480)), ("taomate3", "small", ("taomate3", 864, 480)),
                              ("turbo8", "source", ("turbo8", 1376, 768))):
        req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png",
                              engine="h3", h3_accel=accel, h3_size=size)
        r = _run_h3(req)[0][0]
        assert (r.accel_lora, r.width, r.height) == want, (accel, size)


def test_the_h3_engine_uses_the_callers_prompt_and_asks_the_vision_model_nothing():
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png", engine="h3", face_prompt="my own")
    sent, asked, result, _ = _run_h3(req)
    assert sent[0].prompt == "my own" and asked == [] and result["face_prompt"] == "my own"


def test_pointed_people_are_swapped_one_render_each_the_last_clip_being_the_next_source():
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/p1.png", engine="h3",
                          face_frame_seconds=0.5,
                          targets=[{"x": 0.35, "y": 0.5, "image_url": "/uploads/p1.png"},
                                   {"x": 0.7, "y": 0.5, "image_url": "/uploads/p2.png"}])
    sent, _, result, job = _run_h3(req, targets=[{"x": 0.35, "wears": "a mustard cardigan"}, {"x": 0.7, "wears": "a grey hoodie"}])
    assert len(sent) == 2
    first, second = sent
    assert first.ref_video_urls == ["/uploads/a.mp4"] and first.ref_image_urls == ["/uploads/p1.png"]
    assert second.ref_video_urls == ["/comfy_output/H3_Video_x.mp4"] and second.ref_image_urls == ["/uploads/p2.png"]
    assert first.prompt.startswith("Replace only the person on the left of the frame, who has a mustard cardigan, in <Video 1> with the character in <Picture 1>.")
    assert second.prompt.startswith("Replace only the person on the right of the frame, who has a grey hoodie, in <Video 1> with the character in <Picture 1>.")
    assert all("<Picture 2>" not in r.prompt for r in sent)                  # one person, one picture, in every render
    assert result["url"] == "/comfy_output/H3_Video_2.mp4"                   # the last render is the result
    assert result["face_prompt"] == first.prompt + "\n\n" + second.prompt
    # a restart collects only the last render: in the middle of several it starts again
    assert job["recoveries"][0] is None and job["recoveries"][1]["engine"] == "h3"


def test_one_pointed_person_is_one_render():
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/p1.png", engine="h3", face_frame_seconds=0.5,
                          targets=[{"x": 0.7, "y": 0.5, "image_url": "/uploads/p1.png"}])
    sent, _, result, job = _run_h3(req, targets=[{"x": 0.7, "wears": "a grey hoodie"}])
    assert len(sent) == 1 and sent[0].ref_video_urls == ["/uploads/a.mp4"]
    assert "the person on the right of the frame, who has a grey hoodie" in sent[0].prompt
    assert job["recoveries"][0]["engine"] == "h3"


def test_a_hand_written_prompt_names_one_person_so_it_cannot_cover_several_pointed_ones():
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/p1.png", engine="h3", face_prompt="my own",
                          targets=[{"x": 0.3, "y": 0.5, "image_url": "/uploads/p1.png"},
                                   {"x": 0.7, "y": 0.5, "image_url": "/uploads/p2.png"}])
    try:
        _run_h3(req)
    except ValueError as exc:
        assert "one person" in str(exc)
    else:
        raise AssertionError("a hand-written prompt for several people must be refused")
    one = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/p1.png", engine="h3", face_prompt="my own",
                          targets=[{"x": 0.3, "y": 0.5, "image_url": "/uploads/p2.png"}])
    sent = _run_h3(one)[0]
    assert len(sent) == 1 and sent[0].prompt == "my own" and sent[0].ref_image_urls == ["/uploads/p2.png"]


def test_the_h3_engine_says_so_when_the_swap_lora_is_not_installed():
    req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/who.png", engine="h3")
    try:
        _run_h3(req, lora_missing=True)
    except ValueError as exc:
        assert main.H3_SWAP_LORA in str(exc) and "huggingface.co/akatz-ai" in str(exc)
        return
    raise AssertionError("a missing LoRA must be refused with the file name and where to get it")


def test_the_swap_lora_check_looks_in_the_installs_loras_folder(tmp_path):
    (tmp_path / "output").mkdir()
    loras = tmp_path / "models" / "loras" / "h3"
    loras.mkdir(parents=True)
    with mock.patch.object(main, "COMFYUI_OUTPUT_DIR", str(tmp_path / "output")):
        assert main._h3_swap_lora_missing() is True
        (loras / "h3_character_swap_pro4500_1000.safetensors").write_bytes(b"x")
        assert main._h3_swap_lora_missing() is False
    with mock.patch.object(main, "COMFYUI_OUTPUT_DIR", ""):
        assert main._h3_swap_lora_missing() is False            # an install it cannot find is not reported missing


def test_the_targets_of_the_h3_swap_are_named_by_one_question_or_by_the_points(tmp_path):
    asked = []

    async def upload(data, name):
        return name

    async def describe(name, ask, max_length=220, on_queued=None):
        asked.append(ask)
        return "the man with a grey beard in a brown coat"           # the phrase alone, as the model answers it

    async def target(frame, tgt, photo, index, job):
        assert photo is None                    # the picture of the new person is not described for this engine
        return {"x": tgt.x, "wears": "a grey hoodie", "view": "", "photo": {}}

    def run(req):
        job = {"id": "jt", "status": "running"}
        (tmp_path / "charswap_h3_frame_jt.png").write_bytes(b"x")
        (tmp_path / "charswap_face_src_jt.png").write_bytes(b"x")
        with mock.patch.object(main, "UPLOAD_DIR", tmp_path), \
                mock.patch.object(main, "_extract_video_still"), \
                mock.patch.object(main.comfyui, "upload_image", side_effect=upload), \
                mock.patch.object(main.comfyui, "describe_image", side_effect=describe), \
                mock.patch.object(main, "_describe_target", side_effect=target):
            return asyncio.run(main._charswap_h3_targets(job, req, Path("a.mp4"), 5.0))

    single = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/p.png", engine="h3")
    assert run(single) == [{"who": "the man with a grey beard in a brown coat"}] and asked == [face_prompt.H3_WHO_ASK]
    pointed = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/p.png", engine="h3",
                              targets=[{"x": 0.7, "y": 0.5, "image_url": "/uploads/p.png"}])
    assert run(pointed) == [{"x": 0.7, "wears": "a grey hoodie"}] and len(asked) == 1


def test_a_vision_step_that_fails_leaves_the_person_unnamed_not_the_swap_failed(tmp_path):
    async def upload(data, name):
        raise RuntimeError("no GPU")

    (tmp_path / "charswap_h3_frame_jf.png").write_bytes(b"x")
    with mock.patch.object(main, "UPLOAD_DIR", tmp_path), mock.patch.object(main, "_extract_video_still"), \
            mock.patch.object(main.comfyui, "upload_image", side_effect=upload):
        req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/p.png", engine="h3")
        got = asyncio.run(main._charswap_h3_targets({"id": "jf", "status": "running"}, req, Path("a.mp4"), 5.0))
    assert got == [{}] and "the main subject" in face_prompt.compose_h3_swap_instruction(got)


def test_the_scheduler_sees_an_h3_swap_as_an_h3_render_and_a_viggle_swap_as_viggle():
    default = job_scheduler.describe("charswap", {"engine": "h3"})
    assert default["family"] == "h3:ref2va"
    taomate = job_scheduler.describe("charswap", {"engine": "h3", "h3_accel": "taomate3"})
    small = job_scheduler.describe("charswap", {"engine": "h3", "h3_size": "small"})
    assert default["units"] > taomate["units"] and default["units"] > small["units"]
    assert job_scheduler.describe("charswap", {"engine": "viggle"})["family"] == "viggle"
    assert job_scheduler.describe("charswap", {})["family"] == "viggle"


def test_several_pointed_people_are_placed_by_rank_not_by_thirds():
    near = face_prompt.compose_h3_swap_instruction([{"x": 0.35, "wears": "a mustard cardigan"}, {"x": 0.7, "wears": "a grey hoodie"}])
    assert "the person on the left of the frame, who has a mustard cardigan, with the character in <Picture 1>" in near
    assert "the person on the right of the frame, who has a grey hoodie, with the character in <Picture 2>" in near
    assert "in the middle" not in near
    swapped = face_prompt.compose_h3_swap_instruction([{"x": 0.8}, {"x": 0.1}])           # the pictures keep their order
    assert "the person on the right of the frame with the character in <Picture 1>" in swapped
    assert "the person on the left of the frame with the character in <Picture 2>" in swapped
    three = face_prompt._places([0.2, 0.5, 0.9])
    assert three == ["on the left", "in the middle", "on the right"]
    assert face_prompt._places([0.5]) == ["in the middle"] and face_prompt._places([0.1]) == ["on the left"]


def test_the_who_phrase_starts_in_lower_case_to_sit_in_the_middle_of_the_sentence():
    assert face_prompt.parse_who("The dog with brown fur and a red collar") == "the dog with brown fur and a red collar"
    assert face_prompt.parse_who("A girl in a sailor uniform.") == "a girl in a sailor uniform"
    assert face_prompt.parse_who("Mireille in a white dress") == "Mireille in a white dress"       # a name keeps its capital



def test_a_person_replacing_an_animal_walks_upright_and_the_start_and_end_stance_are_written():
    assert face_prompt.parse_kind("Animal") == "animal" and face_prompt.parse_kind("The subject is a dog.") == "animal"
    assert face_prompt.parse_kind("person") == "person" and face_prompt.parse_kind("") == ""
    assert face_prompt.parse_facing("BODY: right; HEAD: camera") == ("right", True)
    assert face_prompt.parse_facing("BODY: away; HEAD: other") == ("away", False)
    assert face_prompt.parse_facing("no idea") == ("", False)
    pose = face_prompt.compose_upright_pose("the brown dog with a red collar", ("right", False), ("right", True))
    text = face_prompt.compose_h3_swap_instruction([{"who": "the brown dog with a red collar"}], pose)
    assert text.startswith("Replace only the brown dog with a red collar in <Video 1> with the character in <Picture 1>, "
                           "shown walking upright on two legs at the same pace as the brown dog with a red collar, ")
    assert ("At the start of the shot the character stands in profile, side-on to the camera and facing the right edge "
            "of the frame, and at the end the character stands in profile, side-on to the camera and facing the right edge "
            "of the frame, with only the head turned toward the camera.") in text
    assert text.endswith(face_prompt.KEEP_LINE)
    same = face_prompt.compose_upright_pose("a dog", ("left", False), ("left", False))[1]
    assert same.startswith("At the start and at the end of the shot the character stands in profile")
    assert face_prompt.compose_upright_pose("a dog", ("", False), ("", False))[1] == ""
    assert face_prompt.compose_h3_swap_instruction([{"who": "a man"}]) == (
        "Replace only a man in <Video 1> with the character in <Picture 1>. Keep the replacement character's identity, "
        "outfit, and art style from <Picture 1>. " + face_prompt.KEEP_LINE)


def test_the_h3_pose_step_asks_only_when_auto_finds_an_animal_replaced_by_a_person(tmp_path):
    from main import CharswapRequest
    answers = {}
    asked = []

    async def upload(data, name):
        return name

    async def describe(name, ask, max_length=220, on_queued=None):
        asked.append(ask)
        if ask == face_prompt.H3_KIND_ASK:
            return answers[name]
        return "BODY: right; HEAD: other"

    def run(pose, kinds):
        answers.clear(); asked.clear()
        answers.update({"charswap_h3_frame_jp.png": kinds[0], "p.png": kinds[1]})
        (tmp_path / "charswap_h3_frame_jp.png").write_bytes(b"x")
        (tmp_path / "p.png").write_bytes(b"x")
        for n in ("first", "last"):
            (tmp_path / f"charswap_h3_{n}_jp.png").write_bytes(b"x")

        async def resolve(url):
            return tmp_path / "p.png"
        req = CharswapRequest(video_url="/uploads/a.mp4", character_image_url="/uploads/p.png", engine="h3", pose=pose)
        with mock.patch.object(main, "UPLOAD_DIR", tmp_path), mock.patch.object(main, "_extract_video_still"), \
                mock.patch.object(main, "resolve_upload", side_effect=resolve), \
                mock.patch.object(main.comfyui, "upload_image", side_effect=upload), \
                mock.patch.object(main.comfyui, "describe_image", side_effect=describe):
            return asyncio.run(main._charswap_h3_pose({"id": "jp", "status": "running"}, req, Path("a.mp4"), 5.0, "a dog"))

    assert "walking upright" in run("auto", ("animal", "person"))[0]
    assert run("auto", ("person", "person")) is None and run("auto", ("animal", "animal")) is None
    assert run("follow", ("animal", "person")) is None and asked == []
    assert "walking upright" in run("upright", ("person", "person"))[0]
    assert face_prompt.H3_KIND_ASK not in asked
