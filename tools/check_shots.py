#!/usr/bin/env python
"""
Lint a shot list against .agents/skills/shot-direction before anything renders.

These checks exist because each corresponding defect shipped at least once: a scene shot
entirely on one camera, a bird flying the wrong way, a subject that changed size two-to-three
fold between cuts, and twice a duplicate animal caused by contradictory placement. Every one
was cheap to catch here and expensive to find after the clip, the upscale and the grade.

    backend/.venv/Scripts/python tools/check_shots.py productions/downpour

Warnings are heuristics over prompt text, not proof — a flagged shot may be fine, and a clean
report does not replace looking at the contact sheet. It catches the mechanical mistakes so
review time goes to the ones only eyes can find.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# A camera is named, not merely a shot size. "Medium shot" alone is what let a scene reference
# supply its own composition for seven consecutive shots.
CAMERA = re.compile(
    r"(EXTREME LOW ANGLE|LOW ANGLE|HIGH ANGLE|OVER-THE-SHOULDER|BIRD'?S-EYE|EYE-LEVEL|"
    r"POINT-OF-VIEW|POV|MACRO|CLOSE-UP|WIDE|TRACKING|LOOKING (UP|DOWN|STEEPLY)|"
    r"FROM (BEHIND|DIRECTLY BEHIND|OUTSIDE|INSIDE))", re.I)

# Movement across space needs a direction relative to the lens.
TRAVERSE = re.compile(r"\b(walks?|runs?|flies|launch\w*|leaves?|enters?|exits?|steps? (in|out)|"
                      r"climbs?|crosses?|pushes? (forward|through)|dives?)\b", re.I)
# Both axes count. The depth axis (toward/away from the lens) is what the crow got wrong.
# The lateral axis is stated as SCREEN LEFT/RIGHT — equally camera-relative, since screen-left
# is defined by the frame, and it is the idiom that holds the 180-degree line on a tracking
# shot where the subject crosses the frame rather than approaching or receding.
REL_CAM = re.compile(r"(AWAY FROM THE CAMERA|TOWARD THE CAMERA|toward us|away from us|"
                     r"never (flies|turns|comes) toward|becoming smaller|recedes|"
                     r"SCREEN (LEFT|RIGHT))", re.I)

# Facing needs something that can be checked as visibly true or false.
FACING = re.compile(r"\b(facing|looks? at|looking (at|toward)|faces)\b", re.I)
FALSIFIABLE = re.compile(r"(NOT visible|no face|no eyes|no muzzle|not? beak|BACK (FULLY )?TURNED|"
                         r"seen from (directly )?behind|outer backs)", re.I)

SCALE = re.compile(r"\bSCALE:", re.I)
CLOSEUP = re.compile(r"(CLOSE-UP|MACRO|fills (most of |almost )?the frame)", re.I)

# Two positions for one character is what produces two of that character.
POSITION = re.compile(r"(far corner|against the wall|beneath the [\w ]*bench|on the bench top|"
                      r"in front of the pots|middle of the earth floor|beside the .*legs|"
                      r"in the right-hand corner|at the threshold|in the doorway)", re.I)
AMBIGUOUS = re.compile(r"\bbeyond the [\w ]*(bench|table|pots)\b", re.I)


def animals_in(shot: dict) -> list[str]:
    return list(shot.get("refs") or [])


# Clauses that forbid a movement rather than describe one. Matching "walk" inside
# "does NOT walk" and demanding a camera-relative direction for it is noise, and a linter
# that cries wolf stops being read.
NEGATED = re.compile(r"(does NOT|never|not?) (walk|pace|turn|move|face|run|fly)", re.I)
# "facing SCREEN LEFT/RIGHT" is screen direction, which is the correct idiom — not the
# vague "facing <object>" that needs a falsifiable test.
SCREEN_DIR = re.compile(r"facing SCREEN (LEFT|RIGHT)", re.I)


def check(shot: dict) -> list[str]:
    out: list[str] = []
    kf = shot.get("keyframe", "")
    mo = shot.get("motion", "")
    refs = animals_in(shot)

    if not CAMERA.search(kf):
        out.append("no camera named — a shot size alone lets the scene ref pick the framing (§1)")

    # Only a character traverses space; falling water or drifting cloud does not,
    # and demanding a camera-relative direction for them is noise.
    traverses = bool(refs) and bool(TRAVERSE.search(NEGATED.sub("", mo)))
    if traverses and not REL_CAM.search(mo):
        out.append("movement across space with no direction relative to camera (§2)")

    if FACING.search(SCREEN_DIR.sub("", kf)) and not FALSIFIABLE.search(kf):
        out.append("facing stated but not falsifiable — name what must NOT be visible (§3)")

    if refs and not SCALE.search(kf) and not CLOSEUP.search(kf):
        out.append("character present, no SCALE anchor, not a close-up (§4)")

    if AMBIGUOUS.search(kf):
        out.append("ambiguous preposition ('beyond the bench' = past it or on it?) (§5)")

    for field in ("keyframe", "end_keyframe"):
        text = shot.get(field)
        if not text:
            continue
        places = sorted({m.group(0).lower() for m in POSITION.finditer(text)})
        if len(places) > 1 and len(refs) < len(places):
            out.append(f"{field}: {len(places)} positions for {len(refs)} character(s) "
                       f"{places} — conflicting placement duplicates the subject (§5)")

    if len(refs) > 1 and "not touching" not in kf.lower() and "separated" not in kf.lower():
        out.append("two characters with no separation clause — i2v fuses overlapping subjects (§9)")

    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("production", type=Path)
    args = ap.parse_args()

    spec = json.loads((args.production / "shots.json").read_text(encoding="utf-8"))
    shots = spec["shots"]

    flagged = 0
    for s in shots:
        problems = check(s)
        if problems:
            flagged += 1
            print(f"\n  shot {s['id']:2d} {s['slug']}")
            for p in problems:
                print(f"      - {p}")

    # A location appearing in several shots must be anchored by the same set reference in
    # all of them. The closing shot of this film was the only exterior missing its scene_ref,
    # and it rendered a different building on a different roof — a per-shot check cannot see
    # that, because the shot is internally fine.
    print("\n  scene anchors:")
    anchors: dict[str, list[int]] = {}
    for s in shots:
        key = str(s.get("scene_ref") or "NONE")
        anchors.setdefault(key, []).append(s["id"])
    loose = anchors.get("NONE", [])
    for a, ids in sorted(anchors.items()):
        print(f"      {a:12s} {ids}")
    if loose:
        print(f"      -> shots {loose} have no scene_ref; confirm each is a location that "
              f"appears only once, otherwise the set will be reinvented")

    # Repeated framing is a property of the scene, not of any one shot.
    print("\n  camera coverage:")
    seen: dict[str, list[int]] = {}
    for s in shots:
        m = CAMERA.search(s.get("keyframe", ""))
        key = m.group(0).upper() if m else "UNSPECIFIED"
        seen.setdefault(key, []).append(s["id"])
    for cam, ids in sorted(seen.items(), key=lambda kv: -len(kv[1])):
        warn = "  ← repeated" if len(ids) > 2 or cam == "UNSPECIFIED" else ""
        print(f"      {cam:24s} {ids}{warn}")

    print(f"\n  {flagged}/{len(shots)} shots flagged")
    sys.exit(1 if flagged else 0)


if __name__ == "__main__":
    main()
