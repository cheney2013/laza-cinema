from pathlib import Path

from PIL import Image

import character_sheet as cs


def test_four_panel_prompt_without_references():
    prompt = cs.build_prompt(cs.SheetRequest(
        identity="an adult woman with black hair",
        costume="a rust-red cardigan, grey T-shirt, dark jeans and black flats",
        subject_noun="woman",
    ))

    assert "FOUR SYNCHRONIZED PANELS" in prompt
    assert "FULL-BODY FRONT" in prompt
    assert "FULL-BODY SIDE PROFILE" in prompt
    assert "FULL-BODY REAR" in prompt
    assert "MEDIUM CLOSE-UP" in prompt
    assert "<Picture 1>" not in prompt
    assert "turns on the spot" not in prompt
    assert "[Shot 2]" not in prompt


def test_four_panel_prompt_with_one_person_reference_and_prop():
    prompt = cs.build_prompt(cs.SheetRequest(
        identity="an adult man with short dark hair",
        costume="a grey shirt and dark jeans, wearing a steel wristwatch",
        subject_noun="man",
        face_image_url="/uploads/person.png",
        props=[{"image_url": "/uploads/watch.png", "description": "the wristwatch"}],
    ))

    assert "identity exactly the person of <Picture 1>" in prompt
    assert "<Subject 2> is the wristwatch, exactly as shown in <Picture 2>" in prompt
    assert "<Picture 2>: fully_preserved" in prompt
    assert "identical in every panel" in prompt


def test_qwen_prompt_has_the_three_house_views():
    prompt = cs.build_qwen_prompt(cs.SheetRequest(
        identity="an adult man with short dark hair",
        costume="a grey shirt and dark jeans",
        subject_noun="man",
    ))
    assert "facing the camera" in prompt
    assert "back to the camera" in prompt
    assert "just below the belt" in prompt
    assert "<image 1>" not in prompt
    assert "three-quarter" in cs.QWEN_NEGATIVE


def test_qwen_prompt_numbers_face_then_props():
    prompt = cs.build_qwen_prompt(cs.SheetRequest(
        identity="an adult man", costume="a grey shirt", subject_noun="man",
        face_image_url="/uploads/face.png",
        props=[{"image_url": "/uploads/watch.png", "description": "the wristwatch on his left wrist"}],
    ))
    assert "exactly those of the person in <image 1>" in prompt
    assert "<image 2> shows the wristwatch on his left wrist" in prompt


def test_qwen_fixed_size_keeps_the_sheet_canvas():
    import workflow_builders as wb
    g = wb.build_qwen_image_21_workflow("x", ["face.png"], width=1536, height=1024, fixed_size=True)
    assert g["qi:6"]["inputs"]["latent_image"] == ["qi:5", 0]
    assert g["qi:5"]["inputs"]["width"] == 1536
    g = wb.build_qwen_image_21_workflow("x", ["face.png"])
    assert g["qi:6"]["inputs"]["latent_image"] == ["qi:4", 2]


def test_compose_extracts_midpoint_and_preserves_aspect_ratio(monkeypatch):
    source = Image.new("RGB", (1376, 768), (40, 50, 60))
    seen = []

    def fake_frame(_path, frame_number):
        seen.append(frame_number)
        return source

    monkeypatch.setattr(cs, "_frame", fake_frame)
    data = cs.compose(Path("unused.mp4"), 1536, 1024)

    import io
    result = Image.open(io.BytesIO(data))
    assert seen == [cs.SHEET_FRAME]
    assert result.size == (1536, 1024)
    # 16:9 content is letterboxed in the legacy 3:2 API output, not stretched.
    assert result.getpixel((768, 512)) == (40, 50, 60)
    assert result.getpixel((768, 0)) == (128, 128, 130)


def test_qwen_prompt_derives_from_base_sheet():
    prompt = cs.build_qwen_prompt(cs.SheetRequest(
        identity="an adult man", costume="a plaid shirt", subject_noun="man",
        base_sheet_url="/uploads/sheet.png",
        props=[{"image_url": "/uploads/watch.png", "description": "the wristwatch on his left wrist"}],
    ))
    assert "<image 1> is this man's approved character reference sheet" in prompt
    assert "<image 2> shows the wristwatch" in prompt
    assert "exactly those of the person in <image 1>" not in prompt


def test_seed_moves_off_the_seed_a_reference_was_made_with():
    import workflow_builders as wb
    import io, json
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo
    info = PngInfo()
    info.add_text("prompt", json.dumps({"qi:6": {"class_type": "KSampler", "inputs": {"seed": 81000}}}))
    buf = io.BytesIO()
    Image.new("RGB", (8, 8)).save(buf, "PNG", pnginfo=info)
    ref = buf.getvalue()
    plain = io.BytesIO(); Image.new("RGB", (8, 8)).save(plain, "PNG")
    assert wb.sampler_seeds_in_png(ref) == {81000}
    assert wb.seed_clear_of_references(81000, [ref]) == 81001
    assert wb.seed_clear_of_references(5, [ref]) == 5
    assert wb.seed_clear_of_references(81000, [plain.getvalue(), b"not a png"]) == 81000
