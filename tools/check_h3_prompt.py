"""Lint an H3 full-reference (Ref2VA) prompt against the format spec and against
the production rules this project paid for.

    python tools/check_h3_prompt.py path/to/shot_prompt.txt
    python tools/check_h3_prompt.py path/to/*_prompt.txt --frames 362
    python tools/check_h3_prompt.py new.txt --baseline approved.txt
    python tools/check_h3_prompt.py shot.txt --whitelist path/to/whitelist.json

Exit status is non-zero when anything is an ERROR, so it can gate a submission. WARNINGs are printed and do not block;
`--strict` promotes them.

Two families of rule live here, and the distinction matters when one of them
seems wrong:

  * FORMAT rules come from the official guides shipped with the h3-prompt-writing
    skill (`references/ref-en.txt`, `references/base-en.txt`). Section numbers in
    the messages point back at them. The guides are the output spec of the
    unreleased H3-Context-IR stage, so violating them is feeding the model a
    shape it was not trained on.

  * PRODUCTION rules come from renders. Each one names the file that records the
    evidence (`docs/H3_PRODUCTION_LINE.md` section, or `backend/previs/CONTINUITY.md`).
    Where a production rule contradicts a format rule -- scene plates as
    standalone <Picture N> entries is the known case -- the render decides, and
    the checker says so rather than failing.

Everything here is a regex heuristic over English prose. A rule that fires on a
sentence that is actually fine is a WARNING to read, not an instruction to
rewrite; a rule that stays silent is not a pass. The renders are still the judge.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # pragma: no cover
        pass

DOC = "docs/H3_PRODUCTION_LINE.md"

#: The six sections of a full-reference rewrite, in the order the guide fixes
#: them (ref-en.txt section 1).
SECTIONS = [
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
]

#: The only relationship markers retention_analysis may use (ref-en.txt 4.1/4.2).
#: newly_generated is not in ref-en; it comes from the Enhanced specification
#: (docs/MiniMax_H3_Singularity_Prompt_Writing_Specification_Enhanced_EN.md
#: section 6) for an element with no meaningful reference, and is accepted too.
MARKERS = {"fully_preserved", "partially_preserved", "attribute_transfer",
           "weak_reference", "fully_copy", "partially_copy", "reference",
           "newly_generated"}

#: Task-type prefixes the summary may carry (ref-en.txt 3).
TASK_TYPES = {"keyframe completion", "reference generation", "video editing",
              "video continuation", "audio reuse", "audio reference"}

#: A standalone <Picture N> is only legal when the image is a frame or a
#: shot-planning anchor (ref-en.txt 2.2).
ANCHOR_WORDS = ("storyboard", "first frame", "last frame", "keyframe",
                "key frame", "composition anchor", "shot-planning",
                "shot planning", "camera setup", "camera position",
                "camera viewpoint", "previs")

#: Phrases that give away an image doing character/scene/style duty.
DEFINER_WORDS = ("character turnaround", "defines only", "scene plate",
                 "materials and surfaces only", "defines the room finishes",
                 "costume", "wardrobe reference", "turnaround sheet")

#: Reference budget (MODEL_CARD / minimax h3 README section 2).
MAX_PICTURES, MAX_VIDEOS, MAX_AUDIOS, MAX_REFS = 9, 3, 3, 12

#: Word budget for detailed_description on generation tasks (ref-en.txt 5.2 says
#: 350-500). Renders in this project degraded past ~700: CONTINUITY.md section 15
#: records a 400-word growth that bought a second door and a boneless arm and no
#: precision; an earlier 1100-word prompt lost a constraint that a 392-word
#: rewrite landed first time.
WORDS_SOFT, WORDS_HARD = 500, 800

#: ref-en 5.2 goes on: "Dialogue-dense content prioritizes fitting the complete
#: spoken timeline rather than mechanically reaching a word count." So both caps
#: grow with the dialogue: every spoken word, plus the speaker/delivery clause
#: that has to wrap each line. Trimming performance description to make room for
#: lines is the failure this prevents (C5, 2026-09-19).
WORDS_PER_LINE_FRAME = 15


def dialogue_allowance(detail: str) -> tuple[int, int]:
    """(extra words the caps allow, number of <d> lines) for this prompt."""
    lines = re.findall(r"<d>(.*?)</d>", detail, flags=re.S)
    spoken = sum(len(re.sub(r"\[[^\]]*\]", " ", l).split()) for l in lines)
    return spoken + WORDS_PER_LINE_FRAME * len(lines), len(lines)

#: On-screen text legibility (DOC section 7). 25-38 characters were fully legible
#: at 8 steps; a 73-character line garbled in the middle.
TEXT_SOFT, TEXT_HARD = 40, 60

#: Camera-motion vocabulary from base-en.txt 4.3. One move per shot is a
#: production rule (shot-direction skill section 5; DOC section 4).
CAMERA_MOVES = {
    "push in": r"push(?:es|ing)? in", "pull out": r"pull(?:s|ing)? (?:out|back)",
    "pan": r"\bpan(?:s|ning)? (?:left|right)", "truck": r"truck(?:s|ing)? (?:left|right)",
    "tilt": r"tilt(?:s|ing)? (?:up|down)", "pedestal": r"pedestal(?:s)? (?:up|down)",
    "arc": r"\barc(?:s|ing)? (?:shot|around|left|right)", "tracking": r"tracking shot|tracks (?:with|alongside|behind)",
    "zoom": r"zoom(?:s|ing)? (?:in|out)", "roll": r"roll(?:s|ing)? (?:clockwise|counterclockwise)",
    "dolly": r"\bdoll(?:y|ies)\b", "crane": r"\bcrane(?:s)? (?:up|down|back)",
}
GENERIC_CAMERA = r"the camera (?:moves|is moving|movement)\b"

#: Words that name an absence. Naming the thing pins it (DOC section 5.3;
#: feedback_h3_no_negation, CONTINUITY.md sections 12 and 16).
NEGATION = r"\b(?:no|not|never|without|nothing|nobody|no one|empty|must not|does not|do not|isn't|aren't|doesn't|don't|cannot)\b"
#: ...but a few idioms are format, not content, and are skipped.
NEGATION_OK = (r"off-screen voiceover", r"lips remain (?:completely )?closed",
               r"does not speak", r"not part of the target video",
               r"no cut", r"without a cut", r"not visible")

#: Character-relative position words. Screen coordinates only (DOC section 5.4).
CHAR_RELATIVE = re.compile(
    r"\b(?:his|her|their)\s+(?:own\s+)?(?:left|right)(?:-hand)?\s+"
    r"(?:side|page|edge|half|of the (?:frame|picture|desk|table))"
    r"|\bto (?:his|her|their) (?:left|right)\b", re.I)

#: Electric light described with a combustion verb renders as combustion
#: (feedback_h3_prop_wording rule 1).
LAMP_BURNS = re.compile(r"\b(?:lamp|bulb|light|lantern|sconce|pendant)s?\b[^.]{0,40}\bburn(?:s|ing)?\b"
                        r"|\bburn(?:s|ing)?\b[^.]{0,40}\b(?:lamp|bulb|sconce|pendant)s?\b", re.I)

#: Hints that visible writing is described rather than quoted (base-en 4.5;
#: DOC section 7).
TEXT_HINTS = re.compile(
    r"\b(?:handwrit(?:ten|ing)|scrawl|scribbl|lettering|letterhead|headline|"
    r"printed (?:heading|text|title)|the words?\b|reads?\b|inscri|caption|"
    r"sign(?:age)? reading|label(?:led)?|typed|written lines?)", re.I)

#: Process verbs opening a shot replay the previous shot (CONTINUITY.md 12).
PROCESS_OPEN = re.compile(
    r"\b(?:arriv(?:es|ing)|reach(?:es|ing) the|stops?\b|comes? to (?:a )?(?:halt|stop|rest)|"
    r"finish(?:es|ing)|enters?\b|walks? in\b|has just|is about to)\b", re.I)

#: Nouns whose repetition inside one shot has produced duplicates
#: (CONTINUITY.md 16: door/doorway/door frame three times -> two doors).
DUP_NOUNS = ("door", "doorway", "notebook", "mug", "cup", "lamp", "letter", "window",
             "mirror", "chair", "desk", "table", "book", "coat", "umbrella", "clock",
             "print", "bookcase", "shelf", "rug", "radiator", "pen")
DUP_LIMIT = 3
#: Surfaces are named as locations ("on the desk") far more often than objects are;
#: they get a looser limit.
DUP_LIMIT_SURFACE = {"desk": 5, "table": 5, "floor": 6, "wall": 6}

#: Colour words, for the one-object-one-colour check (feedback_h3_describe_the_frame:
#: the same coat written stone-coloured / pale in three places is a licence to change).
COLOURS = r"(?:navy|dark[- ]blue|blue|rust[- ]red|red|dark[- ]green|olive|green|white|off-white|cream|black|grey|gray|brown|pale|stone(?:-coloured)?|amber|sage|oak|pine|brass|copper|golden|yellow|orange|pink|purple|indigo|charcoal|ivory|beige|tan)"
COLOUR_NOUNS = ("cardigan", "sweater", "jumper", "shirt", "top", "coat", "jacket", "trousers",
                "jeans", "dress", "notebook", "door", "mug", "lamp", "desk", "wall", "walls",
                "letter", "envelope", "chair", "rug", "floorboards", "curtains", "scarf")

#: "Quiet" sound renders as a dead floor (minimax h3 README section 5: -39 dBFS).
QUIET_WORDS = re.compile(r"\b(?:quiet|faint|soft|softly|subtle|barely|hushed|muted|gentle|low)\b", re.I)


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    stats: dict = field(default_factory=dict)

    def err(self, s: str) -> None:
        self.errors.append(s)

    def warn(self, s: str) -> None:
        self.warnings.append(s)

    def note(self, s: str) -> None:
        self.notes.append(s)


def sections_of(text: str) -> dict[str, str]:
    """Split the prompt into its named sections, in file order."""
    hits = [(m.group(1), m.start()) for m in
            re.finditer(r"^([a-z_]+):", text, re.M)]
    out: dict[str, str] = {}
    for i, (name, start) in enumerate(hits):
        end = hits[i + 1][1] if i + 1 < len(hits) else len(text)
        out[name] = text[start:end]
    return out


def body_of(section: str) -> str:
    """Strip the `name:` label from a section."""
    return re.sub(r"^[a-z_]+:\s*", "", section, count=1)


def shots_of(detail: str) -> list[tuple[int, str, str]]:
    """Return (shot_number, header_line, block_text) for each [Shot N] block."""
    marks = [(int(m.group(1)), m.start()) for m in re.finditer(r"^\[Shot (\d+)\]", detail, re.M)]
    out = []
    for i, (n, start) in enumerate(marks):
        end = marks[i + 1][1] if i + 1 < len(marks) else len(detail)
        block = detail[start:end]
        header = block.split("\n", 1)[0]
        out.append((n, header, block))
    return out


def strip_dialogue(block: str) -> str:
    return re.sub(r"<d>.*?</d>", " ", block, flags=re.S)


#: Any MM:SS.mmm, whatever word introduces it. Used to find the ones that are
#: not cut times.
TIMECODE = re.compile(r"\b(\d{1,2}):(\d{2})\.(\d{1,3})\b")

#: A cut time and only a cut time: `[Shot N] At MM:SS.mmm,` at the head of the
#: block, which is the sole place the spec puts one (base-en 4.2).
CUT_TIMECODE = re.compile(r"^\[Shot \d+\]\s*At (\d{1,2}):(\d{2})\.(\d{1,3})\b")


def _seconds(m: re.Match) -> float:
    return int(m.group(1)) * 60 + int(m.group(2)) + int(m.group(3).ljust(3, "0")) / 1000


def parse_timecode(header: str) -> float | None:
    """The shot's cut time, or None. Only the timestamp at the head of the block
    counts: a timecode further in is a beat inside the shot, which is a different
    thing and is reported separately (see check_shots)."""
    m = CUT_TIMECODE.match(header.strip())
    return _seconds(m) if m else None


# --------------------------------------------------------------------------- checks

def check_structure(found: dict[str, str], r: Report) -> None:
    for name in SECTIONS:
        if name not in found:
            r.err(f"缺段落 `{name}:`（ref-en 第 1 节要求六段齐全）")
    order = [n for n in found if n in SECTIONS]
    if order != [n for n in SECTIONS if n in found]:
        r.err(f"段落顺序不对：{order} —— 应为 {SECTIONS}")


def check_definitions(defs: str, retain: str, detail: str, r: Report) -> None:
    # standalone <Picture N> entries that only define something
    for m in re.finditer(r"^(<Picture (\d+)>)(.*)$", defs, re.M):
        label, body = m.group(1), m.group(3).lower()
        if any(w in body for w in DEFINER_WORDS) and not any(w in body for w in ANCHOR_WORDS):
            if "scene plate" in body or "room finishes" in body or "materials and surfaces" in body:
                # Reported, not failed. ref-en 2.2 says define-only images go inside a
                # <Subject>; three segments rendered with the plates folded in came back
                # with a mirror reflecting a window that does not exist and coats
                # changing on the hooks. Per-wall binding is real work. CONTINUITY.md 21.
                r.note(f"{label} 是独立条目的场景板。规范（ref-en 2.2）说该并进 <Subject>，"
                       f"但成片说独立条目更稳（CONTINUITY.md §21）。保留，不要照规范改回去。")
            else:
                r.warn(f"{label} 是独立条目，却只在定义人物/服装/风格（ref-en 2.2）。"
                       f"独立 Picture 的语义是'目标帧'；人物图要写进 <Subject N> 里引用，"
                       f"否则整镜可能被换成这张板本身（feedback_h3_picture_vs_subject）。")

    # reference budget and contiguous numbering, per kind (numbering is per kind:
    # comfy/text_encoders/minimax.py)
    for kind, cap in (("Picture", MAX_PICTURES), ("Video", MAX_VIDEOS), ("Audio", MAX_AUDIOS)):
        nums = sorted({int(x) for x in re.findall(rf"<{kind} (\d+)>", defs + detail + retain)})
        if nums and nums != list(range(1, len(nums) + 1)):
            r.err(f"<{kind} N> 编号不连续：{nums}。编号按类别各自从 1 起（minimax.py），"
                  f"且等于边的插入顺序 —— 编号错了会静默指向另一张图。")
        if len(nums) > cap:
            r.err(f"<{kind} N> 用了 {len(nums)} 个，上限 {cap}（模型卡）。")
        r.stats[f"{kind.lower()}s"] = len(nums)
    total = r.stats.get("pictures", 0) + r.stats.get("videos", 0) + r.stats.get("audios", 0)
    if total > MAX_REFS:
        r.err(f"参考素材共 {total} 个，上限 {MAX_REFS}。")

    # two spatial authorities: a camera-defining <Video N> next to a standalone
    # anchor-type <Picture N>. One image governs space (CONTINUITY.md 8, 10).
    video_cam = [m.group(1) for m in re.finditer(r"^(<Video \d+>)(.*)$", defs, re.M)
                 if re.search(r"camera|framing|viewpoint|blocking|走位", m.group(2), re.I)]
    pic_anchor = [m.group(1) for m in re.finditer(r"^(<Picture \d+>)(.*)$", defs, re.M)
                  if any(w in m.group(2).lower() for w in ANCHOR_WORDS)]
    if video_cam and pic_anchor:
        r.warn(f"{video_cam} 和 {pic_anchor} 都在管机位/构图。一次生成里只能有一个东西管空间；"
               f"两个空间权威并存时写实的那个永远赢（CONTINUITY.md §8、§10）。")

    # every defined label analysed, every analysed label defined
    defined = set(re.findall(r"^(<(?:Subject|Picture|Video|Audio) \d+>)", defs, re.M))
    analysed = set(re.findall(r"^(<(?:Subject|Picture|Video|Audio) \d+>)", retain, re.M))
    for label in sorted(defined - analysed):
        r.err(f"{label} 在 subject_definitions 里定义了，但 retention_analysis 里没有对应条目")
    for label in sorted(analysed - defined):
        r.err(f"{label} 出现在 retention_analysis，但没有定义")

    used = set(re.findall(r"<(?:Subject|Picture|Video|Audio) \d+>", detail))
    for label in sorted(used - defined):
        if label in defs:
            continue  # cited inside a Subject definition: legal and common
        r.err(f"{label} 在 detailed_description 里用到，但从未定义")


def check_summary(summary: str, r: Report) -> None:
    body = body_of(summary).strip()
    m = re.match(r"\[([^\]]+)\]", body)
    if not m:
        r.err("summary 必须以方括号任务类型开头，如 `[reference generation]`（ref-en 第 3 节）")
        return
    for t in (x.strip() for x in m.group(1).split("+")):
        if t not in TASK_TYPES:
            r.err(f"summary 任务类型 `{t}` 不在规范枚举里：{sorted(TASK_TYPES)}")
    # 2026-09-05（第二段 v5/v6 同 seed A/B）：summary 里讲了整段剧情，演员会抢演后面镜头
    # 的内容。summary 只写场景设定和分镜说明；剧情只在各自的 [Shot] 块里。
    words = len(body.split())
    if words > 70:
        r.warn(f"summary {words} 词。只写场景设定和分镜说明（≤70 词），剧情动作一概留给 [Shot] 块，"
               f"否则演员会抢演后面镜头的内容（H3_PRODUCTION_LINE §10.x）。")
    if re.search(r"\b(walks|speaks|says|reaches|lays|takes|opens|closes|strikes|lifts|draws|pushes)\b", body, re.I):
        r.warn("summary 里出现了动作动词（walks/speaks/lays…）。这是剧情，搬到对应 [Shot] 块里去，"
               "summary 只留设定和分镜说明（H3_PRODUCTION_LINE §10.x）。")


def check_retention(retain: str, r: Report) -> None:
    for m in re.finditer(r"^(<(?:Subject|Picture|Video|Audio) \d+>)([^\n]*)", retain, re.M):
        label, body = m.group(1), m.group(2)
        if not any(k in body for k in MARKERS):
            r.err(f"{label} 的 retention_analysis 没有合法关系标记 ({'/'.join(sorted(MARKERS))})。"
                  f"`transferred` 之类不是枚举值。")
    if re.search(r"\(S\d\)", retain):
        r.err("retention_analysis 里出现了说话人 ID —— ref-en 5.4 明确禁止")
    # a <Video N> that pins camera/blocking but says nothing about architecture
    # leaves the walls ungoverned (feedback_h3_set_fidelity_rule)
    for m in re.finditer(r"^(<Video \d+>)([^\n]*)", retain, re.M):
        body = m.group(2)
        if re.search(r"camera|framing|blocking", body, re.I) and not re.search(
                r"architect|wall|room|set\b|layout|furnish", body, re.I):
            r.warn(f"{m.group(1)} 的保真条目只写了机位/走位，没把墙和布局划给它管。"
                   f"空墙会被补窗（feedback_h3_set_fidelity_rule；{DOC} §6）。")


def check_dialogue(detail: str, r: Report) -> None:
    opens, closes = detail.count("<d>"), detail.count("</d>")
    if opens != closes:
        r.err(f"<d> 有 {opens} 个，</d> 有 {closes} 个 —— 未闭合的 <d> 会把后面的叙述一起"
              f"吞进台词（base-en 4.4）")
    for m in re.finditer(r"<d>(.*?)(?:</d>|$)", detail, re.S):
        inner = m.group(1)
        if '"' in inner or "“" in inner or "”" in inner:
            r.err(f"<d> 内部有引号：{inner[:60]!r} —— base-en 4.4 规定 <d> 里只放语言标记和台词。"
                  f"（画面里可见的文字仍然要加引号，那是另一条规则）")
        if not re.match(r"\s*\[[A-Za-z]", inner):
            r.err(f"<d> 缺语言标记，如 [English]：{inner[:60]!r}")
    for m in re.finditer(r"([^.!?\n]{0,200}?)<d>", detail):
        lead = m.group(1)
        if not re.search(r"\(S\d(?:,S\d)*\)", lead):
            r.err(f"台词前没有说话人 ID (S1) 之类：…{lead[-70:]!r} —— ref-en 5.4 要求发声的"
                  f" subject 写成 `<Subject N> (Sx)`")
    if re.search(r"off-screen voiceover", detail) and not re.search(r"lips remain", detail):
        r.warn("有画外音但没写 `while his/her lips remain completely closed`（base-en 4.4）")
    r.stats["dialogue_lines"] = opens


def check_speakers(defs: str, detail: str, r: Report) -> None:
    """Speaker ids (S1, S2...) against who speaks and which <Audio N> voices them.

    ref-en 5.4: ids are given in the order people first speak, one id per
    speaker. Two failures from a large scene are caught here too: an <Audio N>
    bound to a different-numbered speaker (Audio 1 -> S2 swapped Mark's and
    Ben's voices in C24), and a timbre-only voice reference whose definition
    quotes the lines (C23b: Mark's line then came out at the start of the clip,
    where it sits in the reference recording).
    """
    uses = [(m.group(1), m.group(2), m.start()) for m in
            re.finditer(r"<Subject (\d+)>\s*\((S\d+)\)", detail)]
    order: list[str] = []
    for _, sid, _ in uses:
        if sid not in order:
            order.append(sid)
    want = [f"S{i}" for i in range(1, len(order) + 1)]
    if order and order != want:
        r.err(f"说话人 ID 应按首次开口的先后编号（ref-en 5.4）：现在的先后是 {order}，应为 {want}")
    by_sid: dict[str, set[str]] = {}
    by_subject: dict[str, set[str]] = {}
    for subj, sid, _ in uses:
        by_sid.setdefault(sid, set()).add(subj)
        by_subject.setdefault(subj, set()).add(sid)
    for sid, subjects in by_sid.items():
        if len(subjects) > 1:
            r.err(f"{sid} 同时给了 " + "、".join(f"<Subject {n}>" for n in sorted(subjects)) +
                  " —— 一个说话人 ID 只对应一个人")
    for subj, sids in by_subject.items():
        if len(sids) > 1:
            r.err(f"<Subject {subj}> 用了多个说话人 ID：{sorted(sids)}")
    for m in re.finditer(r"^<Audio (\d+)>(.*)$", defs, re.M):
        n, body = m.group(1), m.group(2)
        bound = re.search(r"<Subject (\d+)>\s*\((S\d+)\)", body)
        if bound:
            subj, sid = bound.group(1), bound.group(2)
            if sid in by_sid and subj not in by_sid[sid]:
                r.err(f"<Audio {n}> 绑的是 <Subject {subj}> ({sid})，但正文里 {sid} 是 "
                      + "、".join(f"<Subject {x}>" for x in sorted(by_sid[sid])))
            if sid != f"S{n}":
                r.warn(f"<Audio {n}> 对应 {sid}：编号交叉，模型容易把第 {n} 条声音配给 S{n}"
                       f"（C24 就这样把马克和本的声音配反了）。把声音参考的连线顺序"
                       f"调成与说话人 ID 一致")
        timbre_only = re.search(r"\btimbre\b", body) and not re.search(r"copy|reuse|fully_copy", body)
        if timbre_only and re.search(r"[\"“”]", body):
            r.warn(f"<Audio {n}> 只参考音色，却在定义里写了台词原文 —— 模型会照参考录音里的时间"
                   f"把台词提前说出来（C23b 的马克台词就是这样提前的）。定义里只写音色")


def is_empty_room_plate(defs: str, detail: str) -> bool:
    """A scene plate of an unoccupied room, panning or locked off.

    The word caps below exist because long prompts dilute the constraints that
    keep PEOPLE right: what a 400-word growth bought was a second door and a
    boneless arm (CONTINUITY.md section 15). A plate has nobody in it, so it has
    no limb to deform and no performance to dilute -- and what it does need is
    exactly the length the caps forbid, because the only thing that stops H3
    copying a grey box's cube silhouettes is describing the real form of every
    object (2026-09-07: plate_bedroom_pan is the best plate in the film and runs
    to 1045 words; the 504-word living-room pan came back as slabs).

    So the caps are lifted for a prompt that has no characters and no dialogue.
    Add either back and they apply again, which is the point: this is a licence
    for empty rooms, not a way around the rule.
    """
    if re.search(r"<Subject \d+> is (?:the|a) ", defs) and not re.search(
            r"<Subject \d+> is the (?:handful|group|set|collection)", defs):
        return False
    return "<d>" not in detail


def check_shots(detail: str, frames: int | None, r: Report,
                defs: str = "", word_cap: bool = False) -> None:
    dd = body_of(detail)
    words = len(dd.split())
    r.stats["dd_words"] = words
    if is_empty_room_plate(defs, detail):
        r.note(f"detailed_description {words} 词。无人场景板不受 {WORDS_SOFT}/{WORDS_HARD} 词限制："
               f"字数上限防的是人物段落被稀释（多一扇门、畸形肢），而板子里没有人；"
               f"板子恰恰要靠详写形态才压得住灰模的方块轮廓（plate_bedroom_pan 1045 词，全片最好的一块）。")
    else:
        extra, n_lines = dialogue_allowance(dd)
        soft, hard = WORDS_SOFT + extra, WORDS_HARD + extra
        why = (f"（{n_lines} 句台词放宽 {extra} 词：ref-en 5.2 台词密集时先放下完整台词）"
               if extra else "")
        if words > hard:
            # Only an error with --word-cap: the director lifts the cap while a
            # shot needs its motion detail, and asks for it back when it doesn't.
            (r.err if word_cap else r.warn)(
                f"detailed_description {words} 词，超过硬上限 {hard}{why}。规范 350–500（ref-en 5.2）；"
                f"超长会稀释每条约束，多出来的字换来的是多一扇门和畸形肢（CONTINUITY.md §15）。")
        elif words > soft:
            r.warn(f"detailed_description {words} 词，超过 {soft}{why}。"
                   f"砍不承载信息的中间态，别删承载表演的描写（CONTINUITY.md §15）。")

    shots = shots_of(dd)
    r.stats["shots"] = len(shots)
    if not shots:
        r.warn("detailed_description 里没有 [Shot N] 块。单镜也该以 [Shot 1] 开头（base-en 4.2）；"
               "没有镜头块时下面的逐镜检查全部跳过。")
        return
    pre = dd[:dd.find("[Shot")].strip()
    if not pre:
        r.warn("[Shot 1] 之前没有风格开场句（ref-en 5.2：全参考模式风格句写在 [Shot 1] 之前）")
    elif len(pre.split()) > 60:
        r.warn(f"风格开场 {len(pre.split())} 词，规范说一两句就够；长开场吃掉镜头的注意力预算。")

    # numbering, timecodes
    nums = [n for n, _, _ in shots]
    if nums != list(range(1, len(nums) + 1)):
        r.err(f"[Shot N] 编号不连续：{nums}")
    if parse_timecode(shots[0][1]) is not None:
        r.err("[Shot 1] 不带切点时间戳（base-en 4.2：第一镜不写时间码）")

    # Timecodes inside a shot. Every MM:SS.mmm in the official material -- the
    # model card, both prompt-writing guides and every example -- sits directly
    # after `[Shot N]` and marks a cut; there is not one instance of a timecode
    # used for a beat inside a shot. The spec puts in-shot timing in prose
    # instead (base-en 4.1, "Develop the Multimodal Description Along the
    # Timeline"). Written lowercase (`at 00:02.000`) it also used to slip past
    # this checker, which is how it spread.
    #
    # A WARNING and not an error, because the renders disagree with the spec and
    # the renders decide (DOC section 0, 原则一). The same-seed pair behind that
    # call is in character_sheet.py's header: the beats are what stop the
    # turntable, and prose in their place brings the overshoot back. So the rule
    # is "know that you are outside the spec", not "never do this".
    for n, header, block in shots:
        cut = CUT_TIMECODE.match(block.strip())
        for m in TIMECODE.finditer(block):
            if cut and m.start() < cut.end():
                continue
            start = max(0, m.start() - 34)
            r.warn(f"[Shot {n}] 镜内时间码 `{m.group(0)}`：…{block[start:m.end() + 26].strip()}… —— "
                   f"官方只在 [Shot N] 切点用 MM:SS.mmm（base-en 4.2），镜内没有这个用法。"
                   f"但它在带参考图的链路上确实管用：定妆板转台同 seed 对照，带节拍的 3.0s 转到背面并停住，"
                   f"同一句改成散文 2.0s 到背面后继续转到 270°（character_sheet.py 抬头）。"
                   f"纯 T2VA 上两版都转飞，所以效果依赖参考图。要用就知道自己在用规范外的东西。")
    last_t = 0.0
    duration = frames / 24.0 if frames else None
    for n, header, _ in shots[1:]:
        t = parse_timecode(header)
        if t is None:
            r.err(f"[Shot {n}] 缺绝对切点 `At MM:SS.mmm,`。区间写法或相对写法会让切点漂"
                  f"（feedback_use_h3_skill：写区间 5.0s 漂到 7.2s）")
            continue
        if t <= last_t:
            r.err(f"[Shot {n}] 切点 {t:.3f}s 没有严格递增（上一镜 {last_t:.3f}s）")
        if duration and t >= duration:
            r.err(f"[Shot {n}] 切点 {t:.3f}s 超出片长 {duration:.3f}s（{frames} 帧）")
        last_t = t
        if not re.search(r"cuts? to|transitions? to|changes? to|switch(?:es)? to|dissolves? to|fades? to", header, re.I):
            r.warn(f"[Shot {n}] 首句没有 `the shot cuts to` 一类切换动词（base-en 4.2）")
    if duration and shots and last_t > duration * 0.92:
        r.warn(f"最后一镜只剩 {duration - last_t:.2f}s。H3 常在片尾前 1.3–1.5s 崩解，末镜要留余量（h3-storyboard §7）。")

    # per-shot content rules
    for n, header, block in shots:
        text = strip_dialogue(block)
        low = text.lower()

        # negations (quoted on-screen text is content, not a claim about the frame)
        clean = re.sub(r'"[^"\n]*"', " ", low)
        for ok in NEGATION_OK:
            clean = re.sub(ok, " ", clean)
        for m in re.finditer(NEGATION, clean):
            s = max(0, m.start() - 30)
            r.warn(f"[Shot {n}] 否定/缺席词 `{m.group(0)}`：…{clean[s:m.end() + 30].strip()}… —— "
                   f"点名一个东西说它不在等于把它画进去；用在场的实物把那块面积占掉"
                   f"（feedback_h3_no_negation；CONTINUITY.md §12、§16）。")

        # character-relative directions
        for m in CHAR_RELATIVE.finditer(text):
            r.warn(f"[Shot {n}] 人物视角方位 `{m.group(0)}`：位置和运动方向一律用画面左右写"
                   f"（feedback_h3_screen_relative）。人物的左右只用于肢体归属。")

        # lamp verbs
        for m in LAMP_BURNS.finditer(text):
            r.warn(f"[Shot {n}] 电灯配了燃烧动词 `{m.group(0).strip()}`：动词会被字面执行，"
                   f"台灯写 burns 成片会冒烟。写 `is switched on … throws a steady pool of light`"
                   f"（feedback_h3_prop_wording）。")

        # camera: one move per shot, named vocabulary
        moves = [k for k, pat in CAMERA_MOVES.items() if re.search(pat, low)]
        if re.search(GENERIC_CAMERA, low):
            r.warn(f"[Shot {n}] `the camera moves` 没有说清运镜类型。用 base-en 4.3 的词表"
                   f"（push in / truck left / arc shot…）加幅度和速度。")
        if len(moves) > 1:
            r.warn(f"[Shot {n}] 同一镜里有 {len(moves)} 种运镜 {moves}。一镜一个运镜；"
                   f"叠加运镜让主体来回摆（shot-direction §5）。")
        for k in moves:
            if k in ("push in", "pull out", "pan", "truck", "tilt", "pedestal", "arc", "zoom") and \
                    not re.search(r"(?:small|large) amplitude|(?:slow|fast) speed", low):
                r.note(f"[Shot {n}] 运镜 `{k}` 没写幅度/速度。中幅度/常速可省，其它情况写全"
                       f"（base-en 4.3），并写清'因此画面里多出什么'。")

        # on-screen text
        quotes = re.findall(r'"([^"\n]{1,200})"', text)
        for q in quotes:
            if len(q) > TEXT_HARD:
                r.err(f"[Shot {n}] 画面文字 {len(q)} 字符：\"{q[:50]}…\" —— 超过 {TEXT_HARD} 中段必走形，"
                      f"拆成多条短行（feedback_h3_onscreen_text）。")
            elif len(q) > TEXT_SOFT:
                r.warn(f"[Shot {n}] 画面文字 {len(q)} 字符：\"{q[:50]}…\" —— 观众要读的句子控制在 "
                       f"{TEXT_SOFT} 字符内最稳。")
        if not quotes and TEXT_HINTS.search(text):
            hint = TEXT_HINTS.search(text).group(0)
            r.warn(f"[Shot {n}] 提到了可见文字（`{hint}`）却没有引号内容。画面上的字必须逐字放进"
                   f"英文双引号，否则只渲成像字的纹理（base-en 4.5）。要么全部声明，要么别让"
                   f"它进画框。")
        r.stats.setdefault("text_chars", []).extend(len(q) for q in quotes)

        # process verbs at shot opening
        first_sentence = re.split(r"(?<=[.!?])\s", text.strip(), maxsplit=2)
        opener = " ".join(first_sentence[:2]) if n > 1 else first_sentence[0] if first_sentence else ""
        m = PROCESS_OPEN.search(opener)
        if m and n > 1:
            r.warn(f"[Shot {n}] 开头用了过程动词 `{m.group(0)}`。每镜开头声明上一镜结束时的静止"
                   f"终态，不写过程，否则上一镜的动作被重演一遍（CONTINUITY.md §12）。")

        # repeated nouns inside one shot
        for noun in DUP_NOUNS:
            c = len(re.findall(rf"\b{noun}s?\b", low))
            if c >= DUP_LIMIT:
                r.warn(f"[Shot {n}] `{noun}` 在一镜里出现 {c} 次。同一物件一镜只点名一次、"
                       f"只有一种状态；反复点名会多画一个（CONTINUITY.md §16）。")

    # one object, one colour across the whole body
    for noun in COLOUR_NOUNS:
        cols = {m.group(1).lower() for m in re.finditer(rf"\b({COLOURS})\s+(?:\w+\s+){{0,2}}{noun}\b", dd, re.I)}
        cols = {c.replace("gray", "grey").replace(" ", "-") for c in cols}
        if len(cols) > 1:
            r.warn(f"`{noun}` 在正文里带了 {len(cols)} 种颜色 {sorted(cols)}。同一物件只能有一个名字和"
                   f"一种颜色，否则等于允许它变（feedback_h3_describe_the_frame）。")


def check_sound(found: dict[str, str], film: bool, r: Report) -> None:
    ss = body_of(found.get("overall_soundscape", "")).strip()
    ndm = body_of(found.get("non_diegetic_music", "")).strip()
    if "<d>" in ss or "<d>" in ndm:
        r.err("overall_soundscape / non_diegetic_music 里不放台词（ref-en 第 6 节）")
    if ss:
        n_sent = len(re.findall(r"[.!?](?:\s|$)", ss))
        if n_sent > 4:
            r.warn(f"overall_soundscape {n_sent} 句，规范 1–4 句（base-en 4.6）")
        qs = QUIET_WORDS.findall(ss)
        if qs:
            r.warn(f"overall_soundscape 用了 {sorted(set(q.lower() for q in qs))}：'quiet/faint/soft' "
                   f"实测渲成 −39 dBFS 的死底噪。要声音在场就写 present / close-miked / clearly audible"
                   f"（minimax h3 README §5）。")
    if ndm:
        if ndm.upper() != "N/A" and re.match(r"^(none|no\b|nothing)", ndm, re.I):
            r.warn(f"non_diegetic_music 写的是 `{ndm[:40]}`：规范里'无配乐'的值是 `N/A`（base-en 4.7）。"
                   f"`None. No … music` 是自然语言否定，不是枚举值。")
        if film and ndm.upper() != "N/A":
            r.err("多段成片（--film）里 non_diegetic_music 必须写成 `N/A`，`None…` 也不行：各段各自发明的配乐剪不到一起"
                  "（HANDOFF.md §4 Sound and Music）。")
        if ndm.upper() != "N/A" and re.search(r"\b(sad|tense|hopeful|melanchol|emotional|dramatic|eerie)\w*", ndm, re.I):
            r.warn("non_diegetic_music 用了情绪形容词。规范要写乐器、速度、力度变化，不写情绪（base-en 4.7）。")


def check_whitelist(detail: str, wl: dict, r: Report) -> None:
    """A whitelist is an obligation list as much as a permission list (CONTINUITY.md 16.3)."""
    props = [p.lower() for p in wl.get("props", [])]
    per_shot = {int(k): [x.lower() for x in v] for k, v in wl.get("shots", {}).items()}
    for n, _, block in shots_of(body_of(detail)):
        text = strip_dialogue(block).lower()
        allowed = per_shot.get(n)
        if allowed is None:
            r.warn(f"[Shot {n}] 白名单里没有这一镜")
            continue
        for p in props:
            present = re.search(rf"\b{re.escape(p)}s?\b", text) is not None
            if present and p not in allowed:
                r.err(f"[Shot {n}] 提到了 `{p}`，白名单说这一镜画框里没有它。分镜图是画框内容的"
                      f"授权依据，画框外的物件一律不写（feedback_previs_is_the_authority）。")
            if not present and p in allowed:
                r.warn(f"[Shot {n}] 白名单说画框里有 `{p}`，正文没点名。在画框里却没被点名的物件，"
                       f"就是模型的创作空间（CONTINUITY.md §16.3）。")


def check_baseline(words: int, baseline: Path, r: Report) -> None:
    text = baseline.read_text(encoding="utf-8")
    dd = body_of(sections_of(text).get("detailed_description", ""))
    base = len(dd.split())
    r.stats["baseline_words"] = base
    if words > base:
        r.err(f"detailed_description 从基线的 {base} 词涨到 {words} 词。改动不得超过上一个通过版的字数：加一句就要删一句（CONTINUITY.md §15）。")


# --------------------------------------------------------------------------- driver

def check(path: Path, frames: int | None = None, film: bool = False,
          whitelist: Path | None = None, baseline: Path | None = None,
          word_cap: bool = False) -> Report:
    r = Report()
    text = path.read_text(encoding="utf-8")
    found = sections_of(text)
    check_structure(found, r)
    defs = found.get("subject_definitions", "")
    retain = found.get("retention_analysis", "")
    detail = found.get("detailed_description", "")
    summary = found.get("summary", "")
    if defs or retain or detail:
        check_definitions(defs, retain, detail, r)
    if summary:
        check_summary(summary, r)
    if retain:
        check_retention(retain, r)
    if detail:
        check_dialogue(detail, r)
        check_speakers(defs, detail, r)
        check_shots(detail, frames, r, defs, word_cap)
        if whitelist:
            check_whitelist(detail, json.loads(whitelist.read_text(encoding="utf-8")), r)
        if baseline:
            check_baseline(r.stats.get("dd_words", 0), baseline, r)
    check_sound(found, film, r)
    return r


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("prompts", nargs="+", type=Path)
    ap.add_argument("--frames", type=int, help="片长（帧，17n+5）。给了才能查切点是否超出片长")
    ap.add_argument("--film", action="store_true",
                    help="多段成片的一段：non_diegetic_music 必须 N/A")
    ap.add_argument("--whitelist", type=Path,
                    help='JSON: {"props": [...], "shots": {"1": [...], ...}}，逐镜校对画框内物件')
    ap.add_argument("--baseline", type=Path, help="上一个通过版；正文字数不得超过它")
    ap.add_argument("--strict", action="store_true", help="WARNING 也算失败")
    ap.add_argument("--word-cap", action="store_true",
                    help="正文超过硬上限算 ERROR（默认只是 WARNING）")
    ap.add_argument("--quiet", action="store_true", help="只打印 ERROR 和统计")
    a = ap.parse_args(argv[1:])

    worst = 0
    for p in a.prompts:
        if not p.is_file():
            print(f"\n{p}  不存在")
            worst = 2
            continue
        rep = check(p, a.frames, a.film, a.whitelist, a.baseline, a.word_cap)
        st = rep.stats
        chars = st.get("text_chars", [])
        print(f"\n{p}")
        print(f"  正文 {st.get('dd_words', 0)} 词 · {st.get('shots', 0)} 镜 · "
              f"台词 {st.get('dialogue_lines', 0)} 句 · 参考图 {st.get('pictures', 0)} / 视频 "
              f"{st.get('videos', 0)} / 音频 {st.get('audios', 0)}"
              + (f" · 画面文字 {len(chars)} 条，最长 {max(chars)} 字符" if chars else "")
              + (f" · 基线 {st['baseline_words']} 词" if "baseline_words" in st else ""))
        for e in rep.errors:
            print(f"  ERROR  {e}")
        if not a.quiet:
            for w in rep.warnings:
                print(f"  WARN   {w}")
            for n in rep.notes:
                print(f"  note   {n}")
        failed = bool(rep.errors) or (a.strict and rep.warnings)
        print(f"  => {'未通过' if failed else '通过'}：{len(rep.errors)} 错误，{len(rep.warnings)} 警告，"
              f"{len(rep.notes)} 说明")
        if failed:
            worst = max(worst, 1)
    return worst


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
