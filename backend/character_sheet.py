"""
Character reference sheets.

A sheet is the thing every downstream shot hangs off: one image that pins a
character's face, build and costume so a generator draws the same person in
every take.  H3 T2VA renders four synchronized panels in one denoising pass:

    | front full | strict profile | rear full | face close-up |

stable than the previous turntable-and-extract route: there is no rotation rate
to guess, no cut to land, and no chance of sampling the back panel at a profile.
The midpoint is exported into the legacy sheet dimensions so existing callers
can adopt the new representation without an API migration.

**Identity and costume must be split explicitly, and both sides stated in the
positive.** This is the part that is easy to get wrong. Painted-on clown
make-up belongs to IDENTITY — leave it unassigned and a change of costume
washes it off. A cloak belongs to COSTUME — leave it unassigned and it survives
as a character trait into every later shot. Say what each side contains;
never write "not the coat", because a named thing is a thing to draw.

The face reference, when supplied, must be a HEAD CROP. A full-body reference
carries its clothing into the result no matter what the prompt says: measured
repeatedly — a sheet of a man in one uniform, prompted for a different uniform,
comes back in the original one, and the same request against a head-only crop
obeys immediately.
"""

from __future__ import annotations

import io
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

FPS = 24.0
LENGTH_FRAMES = 124           # 5.17s on H3's 17k+5 grid
SHEET_FRAME = 60              # stable midpoint; verified against frames 2/60/120

SHEET_WIDTH = 1536
SHEET_HEIGHT = 1024


@dataclass
class SheetRequest:
    """
    `identity` is what the character IS and survives every costume change.
    `costume` is what they are WEARING for this production.
    """

    identity: str
    costume: str
    subject_noun: str = "person"
    face_image_url: Optional[str] = None
    #: Key props the costume names, each {"image_url", "description"}. A prop
    #: written only in prose comes back different in every sheet and every
    #: shot; given its own reference it stays the one object the film uses.
    props: Optional[list] = None
    #: Qwen route: the approved sheet this one is derived from; <image 1>.
    base_sheet_url: Optional[str] = None
    width: int = 1376
    height: int = 768
    steps: int = 4
    seed: int = 12345


def build_prompt(req: SheetRequest) -> str:
    """Build the field-tested H3 T2VA four-synchronized-panel prompt."""
    identity = req.identity.strip().rstrip(".")
    costume = req.costume.strip().rstrip(".")

    if req.face_image_url:
        subject = (
            f"<Subject 1> is THE STAR, an adult {req.subject_noun} - the face, eyes, hair, "
            "head proportions and identity exactly the person of <Picture 1>; take no room, "
            "furniture, lighting or background from the picture - only the person.\n"
        )
        retention = (
            "<Subject 1> (appears in all four panels): fully_preserved - the face, eyes, hair "
            "and head proportions from <Picture 1>, and the described identity, costume, figure "
            "and proportions, identical in every panel, the same person in the same moment.\n"
            "<Picture 1>: fully_preserved - the person only: face, eyes, hair and head "
            "proportions; nothing of its room, lighting or background.\n"
        )
    else:
        subject = f"<Subject 1> is THE STAR, an adult {req.subject_noun} described below.\n"
        retention = (
            "<Subject 1> (appears in all four panels): fully_preserved - the same face, hair, "
            "costume, figure and proportions are identical in every panel, the same person in "
            "the same moment.\n"
        )

    first_prop_picture = 2 if req.face_image_url else 1
    for i, prop in enumerate(req.props or []):
        pn, sn = first_prop_picture + i, 2 + i
        text = str(prop["description"]).strip().rstrip(".")
        subject += (
            f"<Subject {sn}> is {text}, exactly as shown in <Picture {pn}>; take only its "
            f"design, materials, proportions and colours from that picture.\n"
        )
        retention += (
            f"<Subject {sn}> (appears wherever carried or worn in all four panels): "
            f"fully_preserved - its design, materials, proportions and colours are those of "
            f"<Picture {pn}>, from every angle.\n"
            f"<Picture {pn}>: fully_preserved - <Subject {sn}> only; nothing of its backdrop, "
            f"hand or supporting surface.\n"
        )

    return (
        "subject_definitions:\n"
        f"{subject}"
        "<Subject 2> is the CHARACTER REFERENCE made from four synchronized views of <Subject 1>.\n"
        f"WHO <Subject 1> IS, which stays the same whatever they wear: {identity}.\n"
        f"WHAT <Subject 1> IS WEARING in this production, which is costume and nothing more: {costume}.\n"
        "\nsummary:\n"
        "A short film: <Subject 2> - four synchronized views of the same person, <Subject 1>.\n"
        "\nretention_analysis:\n"
        f"{retention}"
        "\ndetailed_description:\n"
        "[Shot 1] The frame is divided by THREE VERTICAL BARS into FOUR SYNCHRONIZED "
        "PANELS side by side, all running at once, all showing <Subject 1> at the same moment "
        "against a plain neutral mid-grey studio background under flat even studio lighting: "
        "the first panel the FULL-BODY FRONT view from the top of the head to the soles of both "
        "shoes; the second panel the FULL-BODY SIDE PROFILE view from head to shoes, held in "
        "strict side profile for the whole take - the face and body stay turned toward frame-left "
        "from the first frame to the last; the third panel the FULL-BODY REAR view from head to "
        "shoes; the fourth panel a MEDIUM CLOSE-UP of the face. The identity, costume, props, "
        "body proportions and every fitting are identical in every panel. The four bodies and "
        "the close-up remain motionless and perfectly synchronized. One continuous take, no "
        "cuts, to the last frame.\n"
        "\noverall_soundscape:\n"
        "The dead quiet of a padded studio.\n"
        "\nnon_diegetic_music:\nN/A\n"
    )

#: The house sheet layout (义哥, 2026-09-22): full-body front, full-body back,
#: waist-up front. The waist-up panel is written as a crop line -- "from the
#: waist up" alone came back cut at the thighs on one sheet and at the chest on
#: the next.
QWEN_LAYOUT = (
    "Left: full body from the top of the head to the soles of the shoes, standing straight "
    "and facing the camera, arms relaxed at the sides. Middle: full body from head to shoes, "
    "standing straight with the back to the camera. Right: a closer view from the waist up, "
    "facing the camera: the top of the head just below the top edge of the picture and the "
    "bottom edge cutting straight across the waist just below the belt, so the whole chest, "
    "both arms and both hands are in the picture and the thighs are out of it, the face "
    "clearly readable."
)
QWEN_NEGATIVE = ("text, logo, watermark, cartoon, painting, three-quarter view, side profile, "
                 "extra people, a fourth figure, two different people")


def build_qwen_prompt(req: SheetRequest) -> str:
    """The same sheet as a Qwen-Image-2.1 prompt: one still, three views.

    Reference order is `<image N>` order: the face crop first when there is one,
    then each prop -- the same order the H3 route uses for `<Picture N>`.
    """
    noun = req.subject_noun
    identity = req.identity.strip().rstrip(".")
    costume = req.costume.strip().rstrip(".")
    parts = [
        f"A character reference sheet photograph of one real {noun}, shown three times side by "
        "side, exactly three figures of the same person and nobody else, on a plain mid-grey seamless studio background under soft even studio light, sharp "
        "focus, realistic skin texture, photographic, no text."
    ]
    if req.base_sheet_url:
        parts.append(f"<image 1> is this {noun}'s approved character reference sheet. The {noun} "
                     "in the new sheet is the very same one: the same face, hair, build and exactly "
                     "the same clothes as in <image 1>, every garment unchanged in colour, pattern, "
                     "pockets, buttons, cut, fit and how it is worn; take the layout only from the "
                     "description below.")
    elif req.face_image_url:
        parts.append(f"The {noun}'s face, eyes, hair and head proportions are exactly those of the "
                     "person in <image 1>; take nothing else from that picture, not its clothes, "
                     "its room or its light.")
    parts.append(f"Who the {noun} is, whatever they wear: {identity}.")
    parts.append(f"What they are wearing: {costume}.")
    first = 2 if (req.base_sheet_url or req.face_image_url) else 1
    for i, prop in enumerate(req.props or []):
        n = first + i
        text = str(prop["description"]).strip().rstrip(".")
        parts.append(f"<image {n}> shows {text}: it appears in every view where it would be seen, "
                     f"with exactly the design, materials, proportions and colours of <image {n}>.")
    parts.append(QWEN_LAYOUT)
    parts.append(f"The same {noun}, the same clothes and the same props in all three views.")
    return " ".join(parts)


def _frame(video_path: Path, n: int):
    from PIL import Image

    proc = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", str(video_path),
            "-vf", f"select=eq(n\\,{n})", "-vframes", "1",
            "-f", "image2pipe", "-vcodec", "png", "-",
        ],
        capture_output=True,
    )
    if not proc.stdout:
        raise RuntimeError(f"could not read frame {n} from {video_path.name}")
    return Image.open(io.BytesIO(proc.stdout)).convert("RGB")


def _centre_on_figure(img, panel_w: int, panel_h: int, tighten: float = 1.0):
    """
    Crop a panel around the figure rather than around the frame.

    The subject stands in the middle of a wide plate with a lot of empty
    cyclorama either side; a centre crop of the FRAME would work only while the
    figure is exactly centred, and it is not — it drifts as the model turns it.
    Found by column energy against the backdrop instead.
    """
    from PIL import Image
    import numpy as np

    a = np.asarray(img.convert("L"), dtype=np.float32)
    # Backdrop is flat, so vertical structure marks the figure.
    energy = np.abs(np.diff(a, axis=0)).mean(axis=0)
    thresh = energy.max() * 0.18
    cols = np.where(energy > thresh)[0]
    cx = int((cols[0] + cols[-1]) / 2) if len(cols) else img.width // 2

    scale = (panel_h / img.height) * tighten
    resized = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    cx = int(cx * scale)
    left = max(0, min(resized.width - panel_w, cx - panel_w // 2))
    top = max(0, (resized.height - panel_h) // 2)
    out = Image.new("RGB", (panel_w, panel_h), (128, 128, 130))
    out.paste(resized.crop((left, top, left + panel_w, top + panel_h)), (0, 0))
    return out


def compose(video_path: Path, width: int = SHEET_WIDTH, height: int = SHEET_HEIGHT) -> bytes:
    """Extract the stable synchronized four-panel frame without distorting it."""
    from PIL import Image

    frame = _frame(video_path, SHEET_FRAME)
    sheet = Image.new("RGB", (width, height), (128, 128, 130))
    scale = min(width / frame.width, height / frame.height)
    resized = frame.resize(
        (max(1, round(frame.width * scale)), max(1, round(frame.height * scale))),
        Image.LANCZOS,
    )
    sheet.paste(resized, ((width - resized.width) // 2, (height - resized.height) // 2))

    buf = io.BytesIO()
    sheet.save(buf, format="PNG")
    return buf.getvalue()
