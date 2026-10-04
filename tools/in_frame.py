"""Is that thing actually in this shot?

Plate audits kept turning into two people disagreeing about what a grey box
contains. One of us said a door was in frame and matching; the other said the
render had invented it. Both were guessing from a thumbnail. The camera knows.

Given a camera position, an aim point and a lens, this answers for each named
point whether it falls inside the horizontal field of view, and which side of
frame it lands on. It is deliberately 2D: the arguments that come up are about
walls and furniture around the room, not about height.

    python in_frame.py --cam -1.45 2.95 --aim 0.35 -1.40 --lens 20 \
        door:2.97,2.60 mirror:2.96,0.30 shelf:2.78,1.20

Prints one line per point. Anything OUT that shows up in the render was
invented by the model, and the rule is that the grey box wins: either build it
into the set, or say in the prompt that it is behind the camera.
"""

import argparse
import math


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cam", nargs=2, type=float, required=True, metavar=("X", "Y"))
    ap.add_argument("--aim", nargs=2, type=float, required=True, metavar=("X", "Y"))
    ap.add_argument("--lens", type=float, required=True, help="focal length in mm")
    ap.add_argument("--sensor", type=float, default=36.0, help="sensor width in mm")
    ap.add_argument("points", nargs="+", help="label:x,y")
    a = ap.parse_args()

    half = math.degrees(2 * math.atan((a.sensor / 2) / a.lens)) / 2
    fx, fy = a.aim[0] - a.cam[0], a.aim[1] - a.cam[1]
    fl = math.hypot(fx, fy)
    if fl < 1e-9:
        raise SystemExit("camera and aim point are the same place")
    fx, fy = fx / fl, fy / fl

    print(f"lens {a.lens:.0f}mm on a {a.sensor:.0f}mm sensor -> "
          f"{half * 2:.1f} deg wide, {half:.1f} deg either side of the axis")
    worst = 0.0
    for spec in a.points:
        label, _, coords = spec.partition(":")
        px, py = (float(v) for v in coords.split(","))
        dx, dy = px - a.cam[0], py - a.cam[1]
        d = math.hypot(dx, dy)
        if d < 1e-9:
            print(f"  {label:24} is at the camera")
            continue
        ang = math.degrees(math.acos(max(-1.0, min(1.0, (dx * fx + dy * fy) / d))))
        side = "left" if (fx * dy - fy * dx) > 0 else "right"
        verdict = "IN " if ang < half else "OUT"
        if verdict == "OUT":
            worst = max(worst, ang - half)
        print(f"  {label:24} {d:5.2f} m  {ang:5.1f} deg off axis  {verdict}  ({side} of frame)")
    if worst:
        print(f"\nfurthest thing outside the frame clears the edge by {worst:.1f} deg")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
