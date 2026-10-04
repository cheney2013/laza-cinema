"""Bring the segment prompts into line with the H3 full-reference format.

Two violations run through all four files and the checker in
`check_h3_prompt.py` counts twenty-seven of them:

  * the character sheets and the scene plates are declared as standalone
    `<Picture N>` entries. A standalone Picture means "this image is a frame or
    a composition anchor for a shot" (ref-en 2.2), so the prompt was handing
    the model five competing spatial authorities -- against the rule this
    project paid three scene plates to learn, that one image governs space.
    Images that only define a character or a set's materials must be cited
    inside the `<Subject N>` that uses them, with no entry of their own.

  * every dialogue line is written `<d>[English] "..."` with no `</d>`, no
    speaker ID, and the words in quotes. base-en 5.4 wants the speaker's ID and
    delivery outside the tag and only the language marker and the words inside
    it, and an unclosed tag leaves the rest of the shot inside the dialogue.

Quotes around text that is visible in the frame -- the letterhead in segment 2
-- are a different rule and stay. Conflating the two would undo a fix that took
three versions to land.

    python tools/fix_h3_prompt_format.py path/to/*_prompt.txt

Writes in place after a .bak, then run the checker.
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

#: The environment subject that replaces the two standalone scene plates.
SUBJECT3 = (
    "<Subject 3> is the study room, its architecture and its furnishings. Its "
    "south-facing finishes -- the dark sage green wall with off-white "
    "wainscoting, the tall rain-streaked sash window, the dark oak bookcases, "
    "the twin black pendant lamps, the knotty pine desk and the wide pine "
    "floorboards -- come from <Picture 4>. Its north- and east-facing finishes "
    "-- the cast-iron fireplace with its timber mantelpiece and mantel clock, "
    "the white four-panel door, the dark-framed circular mirror, the framed "
    "print, the east bookcases with their archive boxes and the single wooden "
    "chair -- come from <Picture 5>. Both images define materials and surfaces "
    "only."
)

RETAIN3 = (
    "<Subject 3> (appears in [Shot 1] to [Shot 5]): fully_preserved - the wall "
    "finishes, wainscoting, fireplace and mantelpiece, white four-panel door, "
    "circular mirror, framed print, bookcases, sash window, desk timber and "
    "floorboards referenced from <Picture 4> and <Picture 5> are retained."
)


def fix(path: Path) -> tuple[int, int]:
    text = path.read_text(encoding="utf-8")
    before = text

    # 1. drop the standalone Picture entries for the two character sheets and
    #    the two scene plates; Picture 1, the storyboard, is a real anchor and
    #    stays.
    dropped = 0
    for n in (2, 3, 4, 5):
        pat = re.compile(rf"^<Picture {n}> is .*?(?=\n<|\n\n)", re.S | re.M)
        text, k = pat.subn("", text)
        dropped += k
    text = re.sub(r"\n{3,}", "\n\n", text)

    # 2. the two subjects cite their own source image, which ref-en 2.2 asks
    #    for and both lines already did; add the environment subject after them
    if "<Subject 3>" not in text:
        text = re.sub(r"(^<Subject 2> is the man[^\n]*\n)",
                      r"\1" + SUBJECT3 + "\n", text, count=1, flags=re.M)

    # 3. retention_analysis: drop the four Picture lines, add Subject 3
    for n in (2, 3, 4, 5):
        text = re.sub(rf"^<Picture {n}> \([^\n]*\n", "", text, flags=re.M)
    if "<Subject 3> (appears" not in text:
        text = re.sub(r"(^<Subject 2> \(appears[^\n]*\n)", r"\1" + RETAIN3 + "\n",
                      text, count=1, flags=re.M)

    # 4. the shots referred to the plates directly; they now refer to the
    #    subject that owns them
    text = text.replace("match <Picture 5> and <Picture 4>", "match <Subject 3>")
    text = text.replace("match <Picture 4> and <Picture 5>", "match <Subject 3>")
    text = text.replace("matches <Picture 4> and <Picture 5>", "matches <Subject 3>")
    text = text.replace("match <Picture 4>", "match <Subject 3>")
    text = text.replace("match <Picture 5>", "match <Subject 3>")
    text = text.replace("matches <Picture 4>", "matches <Subject 3>")
    text = text.replace("matches <Picture 5>", "matches <Subject 3>")

    # 5. dialogue, line by line rather than with one clever regex. The first
    #    attempt tried to match the introducing clause, the tag, the words and
    #    the tail in a single pattern and produced `<d><Subject 1> [English].`
    #    -- a reminder that a format fix which mangles the thing it is fixing
    #    is worse than the violation.
    speakers: dict[str, str] = {}
    out_lines = []
    for line in text.split("\n"):
        if "<d>" in line and "</d>" not in line:
            m = re.search(r'<d>(\[[A-Za-z]+\])\s*"([^"]+)"', line)
            if m:
                tag, words = m.group(1), m.group(2).strip()
                if words and words[-1] not in ".?!":
                    words += "."
                # who is speaking: the last subject named before the tag
                before = line[:m.start()]
                who_m = list(re.finditer(r"<Subject \d+>", before))
                if who_m:
                    who = who_m[-1].group(0)
                    sid = speakers.setdefault(who, f"S{len(speakers) + 1}")
                    if f"{who} ({sid})" not in line:
                        line = (before[:who_m[-1].start()]
                                + f"{who} ({sid})"
                                + before[who_m[-1].end():]
                                + line[m.start():])
                        m = re.search(r'<d>(\[[A-Za-z]+\])\s*"([^"]+)"', line)
                line = line[:m.start()] + f"<d>{tag} {words}</d>" + line[m.end():]
                # the guide's examples state the lips close after the line, so
                # a mouth does not carry on moving once the words end
                if "<Subject 1> (" in line:
                    line = line.replace("</d>", "</d> She closes her lips.", 1)
                else:
                    line = line.replace("</d>", "</d> He closes his lips.", 1)
        out_lines.append(line)
    text = "\n".join(out_lines)

    fixed = len(re.findall(r"</d>", text))
    if text != before:
        shutil.copyfile(path, path.with_suffix(path.suffix + ".bak"))
        path.write_text(text, encoding="utf-8")
    return dropped, fixed


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        raise SystemExit(__doc__)
    for a in argv[1:]:
        p = Path(a)
        dropped, closed = fix(p)
        print(f"{p.name}: 去掉 {dropped} 个越权 <Picture>, 闭合 {closed} 条台词")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
