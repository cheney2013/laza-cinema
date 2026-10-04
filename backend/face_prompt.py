"""Write the face-swap edit prompt from what a vision model sees, instead of by hand.

The swap's reference frame is made by Qwen-Image 2.1 from two pictures (the clip's frame, the new
person's photo). Measured 2026-10-04, that edit only works when its prompt says what is in the
frame, what the new hair is, that the hair length stays the clip's, and what must not change
(docs/CHARSWAP.md). This module asks the model for short labelled facts about each picture and
fills that sentence structure with them. The facts come from the text encoder Qwen-Image 2.1
already loads (ComfyUI's TextGenerate), so no extra model is needed.
"""
from __future__ import annotations

import re

FRAME_ASK = (
    "Look at this photograph and answer with exactly these eight lines, each one short phrase, "
    "nothing else.\n"
    "PERSON: <age group and gender, e.g. a woman in her forties>\n"
    "CLOTHES: <what is worn, e.g. a grey wool coat with a wide collar over a dark shirt>\n"
    "SETTING: <where, with the light and colours, e.g. beside a rain-streaked window in dim blue light>\n"
    "POSE: <the body posture, e.g. crawling on hands and knees with one knee forward, or looking back over her shoulder>\n"
    "VIEW: <from which side the camera sees the person: from the front, from behind or from the side, from above or at eye level, "
    "and whether the face can be seen, e.g. from behind and above, the head cut off by the top of the frame>\n"
    "LIMBS: <where the hands and the knees are and whether the arms are straight or bent, e.g. both palms flat on the floor "
    "beside the head with the arms straight and the knees under the hips>\n"
    "OTHER: <anything in the frame that is not the person or the setting and has to stay, such as another person or the "
    "viewer's own arms at the edge of the frame, or the word none>\n"
    "HAIR: <length, bangs and how it is worn, e.g. a short bob ending at the chin, no bangs>"
)

PHOTO_ASK = (
    "Look at this photograph of a person and answer with exactly these two lines, each one short "
    "phrase, nothing else.\n"
    "HAIR: <the hair colour and the bangs only, not the length, e.g. black hair with full see-through bangs>\n"
    "FACE: <a few words on the face and expression, e.g. a small face, dark eyes and a gentle "
    "closed-mouth smile>"
)

FRAME_FIELDS = ("person", "clothes", "setting", "pose", "hair")        # `view`, `limbs` and `other` are asked too, but optional


_NO_FACE_WORDS = ("behind", "back of", "from the back", "not visible", "not shown", "cannot be seen",
                  "can't be seen", "hidden", "no face", "face is not", "faces away")


def _from_behind(view: str) -> bool:
    """Whether the described view shows no face: the person is seen from behind, or the head is bowed
    so that only the top of it shows. Then the new person is drawn without a face (2026-10-04: a clip
    that opened on a bowed head, "from above, face not visible", still got the photo's smile in the
    prompt and Qwen drew the girl looking up)."""
    text = view.lower()
    return any(word in text for word in _NO_FACE_WORDS)
PHOTO_FIELDS = ("hair", "face")


def parse_fields(text: str, wanted: tuple[str, ...]) -> dict[str, str]:
    """`KEY: value` lines to a dict (keys lowercased); anything else, and empty values, ignored."""
    found: dict[str, str] = {}
    for line in text.splitlines():
        key, sep, value = line.partition(":")
        key = key.strip().strip("*#- ").lower()
        value = value.strip().strip("*").strip().rstrip(".")
        if sep and key in wanted and value and key not in found:
            found[key] = value
    return found


def compose_face_prompt(frame: dict[str, str], photo: dict[str, str]) -> str | None:
    """The 换头 Qwen edit prompt from the two fact sheets: the face, and the new person's hair colour
    and bangs; the hair length stays the clip's. None when a fact the sentence needs is missing."""
    if any(not frame.get(k) for k in FRAME_FIELDS) or any(not photo.get(k) for k in PHOTO_FIELDS):
        return None
    view = frame.get("view", "")
    seen = f", {view}" if view else ""
    limbs = frame.get("limbs", "")
    pose = frame["pose"] + (f" ({limbs})" if limbs else "")
    hair_and_face = photo["hair"] if _from_behind(view) else f"{photo['hair']}, {photo['face']}"
    return (
        f"Edit <image 1>, a photograph of {frame['person']} wearing {frame['clothes']}, "
        f"{pose}{seen}, {frame['setting']}. Replace the face and hairstyle of the person with "
        f"the face of the person in <image 2> and that person's hair colour and bangs: "
        f"{hair_and_face}. The hair stays {frame['hair']}, like the hair in "
        f"<image 1>; no hair is tied back and nothing hangs down the back. Keep everything else in "
        f"<image 1> exactly as it is: {frame['clothes']}, the turn of the shoulders and the "
        f"angle of the head{', ' + limbs if limbs else ''}, the setting, the lighting, the colours and the framing."
    )


# 换人: the whole person comes from the photo, clothes included, so the photo is asked about its clothes too.
PERSON_PHOTO_ASK = (
    "Look at this photograph of a person and answer with exactly these three lines, each one short "
    "phrase, nothing else.\n"
    "CLOTHES: <what the person wears, e.g. a cream halter-neck dress with a ruffled neckline>\n"
    "HAIR: <colour, length, bangs and how it is worn, e.g. black hair to the shoulders with full bangs>\n"
    "FACE: <a few words on the face and expression, e.g. a small face, dark eyes and a gentle "
    "closed-mouth smile>"
)
PERSON_PHOTO_FIELDS = ("clothes", "hair", "face")


def compose_person_prompt(frame: dict[str, str], photo: dict[str, str]) -> str | None:
    """The Qwen edit prompt for a whole-person swap: the person of the photo, in the photo's clothes,
    in the clip's frame, pose, setting and light. None when a fact the sentence needs is missing."""
    if any(not frame.get(k) for k in ("person", "pose", "setting")) or any(not photo.get(k) for k in PERSON_PHOTO_FIELDS):
        return None
    view = frame.get("view", "")
    seen = f", {view}" if view else ""
    # Where the hands and knees are is said in the pose and again in the keep list: asked only for "kneeling with
    # head down", Qwen drew a kneeling bow with the hands tucked under, not the clip's palms spread on the floor.
    limbs = frame.get("limbs", "")
    pose = frame["pose"] + (f" ({limbs})" if limbs else "")
    # What else is in the frame is kept by name: with only "the setting" in the keep list Qwen removed the viewer's
    # own arms from the bottom edge of a first-person frame (2026-10-04).
    other = frame.get("other", "")
    other = "" if not other or other.lower().startswith(("none", "no ", "nothing", "n/a")) else other
    keep_other = f", {other}" if other else ""
    # The photo usually shows the person from the front. When the clip shows the back, the new person
    # has to be drawn from the back too, or Viggle is handed a front view for a back-view clip and
    # returns a mosaic (2026-10-04, a person crawling away from the camera).
    shown = f", shown {view} in the same pose as in <image 1>" if view else ""
    look = photo["hair"] if _from_behind(view) else f"{photo['face']}, {photo['hair']}"
    keep_view = f", the camera view ({view})" if view else ""
    return (
        f"Edit <image 1>, a photograph of a person, {pose}{seen}, {frame['setting']}. Replace "
        f"the person with the person in <image 2>{shown}: {look}, wearing "
        f"{photo['clothes']} exactly as in <image 2>. Nothing of the original person may remain: not "
        f"the face, not the hair, not the clothes. Keep everything else in <image 1> exactly as it is: "
        f"the pose of the body, the arms and the legs{(' (' + limbs + ')') if limbs else ''}{keep_view}{keep_other}, the setting, the lighting, the "
        f"colours and the framing."
    )


# 换人 with several people in the frame: the user pointed at the ones to replace. Each pointed-at
# person is cropped out of the frame and described, so the edit can name them by place and clothes.
POINT_ASK = (
    "In the middle of this picture there is one person. Answer with exactly these two lines, each "
    "one short phrase, nothing else.\n"
    "WEARS: <the hair and the clothes, e.g. short black hair, a charcoal grey hooded sweatshirt and black trousers>\n"
    "VIEW: <from which side the camera sees the person and whether the face can be seen, e.g. from the front, "
    "the face visible, or from behind, the face not visible>"
)
POINT_FIELDS = ("wears", "view")


def side_of_frame(x: float) -> str:
    """Where a point at fraction x from the left edge is, in words."""
    if x < 1 / 3:
        return "on the left"
    if x < 2 / 3:
        return "in the middle"
    return "on the right"


def compose_people_prompt(targets: list[dict]) -> str:
    """The Qwen edit prompt for replacing the pointed-at people of a frame (<image 1>); <image 2> is the
    first target's photo, <image 3> the second's, and so on.

    Each target is {"x": 0-1, "wears": str, "view": str, "photo": {"clothes", "hair", "face"}}; the facts
    may be empty, in which case the sentence names the person by place alone and takes the look from the
    photo as it is. Everyone not pointed at is named in the keep clause and stays as they are.
    """
    sentences = []
    for i, t in enumerate(targets):
        n = i + 2
        wears = t.get("wears") or ""
        who = f", who has {wears}," if wears else ","
        photo = t.get("photo") or {}
        view = t.get("view") or ""
        look = photo.get("hair", "") if _from_behind(view) else ", ".join(
            v for v in (photo.get("face", ""), photo.get("hair", "")) if v)
        clothes = photo.get("clothes", "")
        detail = ""
        if look or clothes:
            parts = [look] if look else []
            if clothes:
                parts.append(f"wearing {clothes} exactly as in <image {n}>")
            detail = ": " + ", ".join(parts)
        sentences.append(
            f"Replace the person {side_of_frame(t['x'])} of the frame, about {round(t['x'] * 100)}% from the left "
            f"edge{who} with the person in <image {n}>{detail}.")
    return (
        "Edit <image 1>. " + " ".join(sentences)
        + " Nothing of the replaced people may remain: not the faces, not the hair, not the clothes. "
        "Everyone else in <image 1> stays exactly as they are, with their own face, hair and clothes, and so does anyone "
        "seen only as arms or a torso at the edge of the frame; no person is added and none is removed. "
        "Keep everything else in <image 1> exactly as it is: the positions and the poses of all the people, "
        "the way each of them faces or turns away from the camera, the setting, the lighting, the colours "
        "and the framing."
    )


# ── The H3 swap with the Character-Swap LoRA: one instruction, not a six-section prompt ───────────────
#
# akatz-ai/MiniMax-H3-Character-Swap-LoRA is trained on a plain instruction ("Replace only ... in <Video 1> with the
# character in <Picture 1>. Keep ... Preserve the source video's camera, background, lighting, objects, and all other
# people."). Measured 2026-10-04 on the same clips, it kept the clip's shot size and background and the move of the
# clip, where the six-section prompts written from the vision model's facts redrew the setting and came back closer
# than the clip. The only fact the prompt needs is who is replaced.

_NEGATIVE = (r"\b(?:no|not|never|without|nothing|nobody|empty|must not|does not|do not|isn't|aren't|doesn't|don't|"
             r"cannot|none)\b")


def _fact(value: str) -> str:
    """A fact line for the instruction: the model's words, or "" when they say something is absent (the H3 prompt
    rules forbid naming what is not in the frame, so such a fact is dropped and the sentence falls back)."""
    import re

    text = (value or "").strip().strip(".")
    return "" if not text or re.search(_NEGATIVE, text, flags=re.I) else text


# One short noun phrase, no label: asked for "WHO: <phrase>" the model answered with the phrase alone (2026-10-04, an
# overhead frame of a girl in a sailor uniform), nothing was parsed, the instruction said "the main performer" and the
# LoRA changed the hair and the face but left the sailor uniform on. Naming the clip's own clothes is what tells the
# LoRA that the whole person is replaced.
# A subject, not a person: asked for "the main person" about a frame of a dog on a lawn the model answered "There is no person
# visible", the instruction fell back to "the main performer" and the LoRA left the dog alone and added the new character beside
# it (2026-10-04).
H3_WHO_ASK = (
    "Look at this frame of a video and name the main subject, a person or an animal, with its hair or fur and its clothes or "
    "collar, as one short noun phrase and nothing else, e.g. the girl with long black hair in a navy sailor uniform, or the "
    "brown dog with a red collar"
)


def parse_who(text: str) -> str:
    """The noun phrase of an answer to H3_WHO_ASK: its first non-empty line without a label ("WHO:") or quotes."""
    for line in (text or "").splitlines():
        line = line.strip().strip("*#- \"'`").rstrip(".")
        if line.lower().startswith("who:"):
            line = line[4:].strip().strip("\"'")
        if line:
            # "The dog with ..." comes back capitalised: it goes in the middle of a sentence
            return line[0].lower() + line[1:] if line.split(" ", 1)[0] in ("The", "A", "An") else line
    return ""

KEEP_LINE = ("Preserve the source video's camera, background, lighting, objects, and all other people.")

# A person put where an animal trotted. The animal's skeleton (four legs, a horizontal spine) is not a person's: asked only
# to "replace the dog" the LoRA drew a person bent over on four limbs (2026-10-04), and told "walking upright" it copied the
# photo's frontal stance at the start and the end of the clip, where the dog stood side-on with only its head turned
# (the same day). Saying how the body and the head are turned at the start and at the end fixed both.
H3_KIND_ASK = "Is the main subject of this image a person or an animal? Answer with one word: person or animal."
H3_FACING_ASK = (
    "Look at the main subject of this frame. Which way is its body turned: toward the left edge of the frame, toward the "
    "right edge, toward the camera, or away from the camera? And is its head turned toward the camera? Answer exactly in "
    "this form and nothing else: BODY: left|right|camera|away; HEAD: camera|other"
)


def parse_kind(text: str) -> str:
    """"person" or "animal" from the answer to H3_KIND_ASK, "" when it says neither."""
    words = re.findall(r"[a-z]+", (text or "").lower())
    for w in words:
        if w in ("person", "human", "man", "woman", "people"):
            return "person"
        if w in ("animal", "dog", "cat", "horse", "bird"):
            return "animal"
    return ""


def parse_facing(text: str) -> tuple[str, bool]:
    """(body, head_to_camera) from the answer to H3_FACING_ASK; body is left/right/camera/away or "" when unreadable."""
    t = (text or "").lower()
    body = re.search(r"body\W+(left|right|camera|away)", t)
    head = re.search(r"head\W+(camera|other)", t)
    return (body.group(1) if body else "", bool(head and head.group(1) == "camera"))


def _stance(body: str, head_to_camera: bool) -> str:
    if body in ("left", "right"):
        text = f"stands in profile, side-on to the camera and facing the {body} edge of the frame"
        return text + (", with only the head turned toward the camera" if head_to_camera else "")
    if body == "camera":
        return "stands facing the camera"
    if body == "away":
        return "stands with the back to the camera"
    return ""


def compose_upright_pose(subject: str, start: tuple[str, bool], end: tuple[str, bool]) -> tuple[str, str]:
    """(the clause that follows "with the character in <Picture 1>", the sentence after it) for a person replacing an animal
    that moves on four legs. `start`/`end` are parse_facing results of the first and last frame."""
    clause = f"shown walking upright on two legs at the same pace as {subject or 'the animal'}, the whole body visible from head to feet"
    a, b = _stance(*start), _stance(*end)
    if a and b and a == b:
        sentence = f"At the start and at the end of the shot the character {a}."
    elif a and b:
        sentence = f"At the start of the shot the character {a}, and at the end the character {b}."
    else:
        only = a or b
        sentence = f"At the {'start' if a else 'end'} of the shot the character {only}." if only else ""
    return clause, sentence


def _places(xs: list) -> list[str]:
    """The place of each pointed-at person in words. One person: the thirds of the frame. Several: by rank from the left
    ("on the left", "on the right"; with three or more also "in the middle"), because the thirds put two neighbours
    at 35% and 70% in "the middle" and "on the right" (2026-10-04, the woman on the left was called "in the middle")."""
    if len(xs) < 2 or any(x is None for x in xs):
        return [side_of_frame(x) if x is not None else "" for x in xs]
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    rank = {i: r for r, i in enumerate(order)}
    last = len(xs) - 1
    return ["on the left" if rank[i] == 0 else "on the right" if rank[i] == last else "in the middle" for i in range(len(xs))]


def compose_h3_swap_instruction(targets: list[dict], pose: tuple[str, str] | None = None) -> str:
    """The Character-Swap LoRA's instruction. `targets` is one dict per replaced person, in the order of the pictures:
    {"who": "the girl with long black hair in a navy sailor uniform"} or, with points on the frame,
    {"x": 0-1, "wears": "..."} (the person is then named by place and clothes). A missing fact falls back to
    "the main performer"."""
    places = _places([t.get("x") for t in targets or [{}]])
    named = []
    for t, place in zip(targets or [{}], places):
        place = t.get("place") or place            # a caller that renders one person at a time names the place itself
        who = _fact(t.get("who", ""))
        if not who and "x" in t:
            wears = _fact(t.get("wears", ""))
            who = f"the person {place} of the frame" + (f", who has {wears}," if wears else "")
        named.append(who or "the main subject")
    if len(named) == 1:
        clause, sentence = pose or ("", "")
        replace = f"Replace only {named[0]} in <Video 1> with the character in <Picture 1>" + (f", {clause}." if clause else ".")
        if sentence:
            replace += " " + sentence
        keep = "Keep the replacement character's identity, outfit, and art style from <Picture 1>."
    else:
        parts = [f"{who} with the character in <Picture {i}>" for i, who in enumerate(named, start=1)]
        replace = f"Replace only {parts[0]}" + "".join(f", {p}" for p in parts[1:-1]) + f" and {parts[-1]}, all in <Video 1>."
        keep = "Keep each replacement character's identity, outfit, and art style from its own picture."
    return f"{replace} {keep} {KEEP_LINE}"
