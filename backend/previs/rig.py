"""
A tiny skeleton rig for grey-box previs figures.

Why this exists: the first previs figure was built by dropping capsules between
hand-picked endpoints. Nothing checked that the resulting segments were the
length of a real bone, so the right arm came out 1.8x (upper) and 2.5x
(forearm) too long and the video model faithfully reproduced the deformity.

So: bone lengths are declared once, middle joints are SOLVED rather than
guessed, and every segment is asserted before anything renders.

Pure math, no bpy — importable and testable on its own.
"""

from __future__ import annotations

import math

Vec = tuple[float, float, float]


def sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def add(a: Vec, b: Vec) -> Vec:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def mul(a: Vec, s: float) -> Vec:
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def length(a: Vec) -> float:
    return math.sqrt(dot(a, a))


def norm(a: Vec) -> Vec:
    n = length(a)
    if n < 1e-9:
        raise ValueError("cannot normalise a zero vector")
    return mul(a, 1.0 / n)


def dist(a: Vec, b: Vec) -> float:
    return length(sub(a, b))


# ── anthropometry, in metres, for a roughly 1.78 m adult male ────────────────
UPPER_ARM = 0.33
FOREARM = 0.25
HAND = 0.10
THIGH = 0.42
SHIN = 0.42
FOOT = 0.26
SPINE = 0.52          # pelvis joint -> shoulder centre
SHOULDER_HALF = 0.20
HEAD_R = 0.115
NECK_MIN, NECK_MAX = 0.17, 0.27   # shoulder centre -> head centre; slumping is
                                  # legitimate, dislocation is not


class Proportions:
    """One consistent set of bone lengths. Never scale one body into another —
    limb-to-torso ratios differ, and a uniformly shrunk man reads as a child."""

    def __init__(self, name, height, upper_arm, forearm, hand, thigh, shin,
                 foot, spine, shoulder_half, head_r, neck_range):
        self.name = name
        self.height = height
        self.upper_arm, self.forearm, self.hand = upper_arm, forearm, hand
        self.thigh, self.shin, self.foot = thigh, shin, foot
        self.spine, self.shoulder_half = spine, shoulder_half
        self.head_r = head_r
        self.neck_min, self.neck_max = neck_range

    @property
    def arm_reach(self):
        """Shoulder to fingertip. Anything further away simply cannot be touched."""
        return self.upper_arm + self.forearm + self.hand


MALE = Proportions("male", 1.78, UPPER_ARM, FOREARM, HAND, THIGH, SHIN, FOOT,
                   SPINE, SHOULDER_HALF, HEAD_R, (NECK_MIN, NECK_MAX))

FEMALE = Proportions("female", 1.68, 0.30, 0.23, 0.09, 0.40, 0.40, 0.24,
                     0.48, 0.170, 0.107, (0.16, 0.25))


def place(root: Vec, direction: Vec, bone: float) -> Vec:
    """Forward kinematics: put a joint exactly `bone` away from `root`."""
    return add(root, mul(norm(direction), bone))


def solve_middle(root: Vec, end: Vec, l1: float, l2: float, pole: Vec) -> Vec:
    """Two-bone IK.

    Returns the middle joint (elbow / knee) lying exactly `l1` from `root` and
    `l2` from `end`, bending toward `pole`. Raises if the target is out of
    reach, which is the whole point: an unreachable pose is a broken pose and
    must not be silently drawn as a stretched limb.
    """
    axis = sub(end, root)
    d = length(axis)
    if d > l1 + l2:
        raise ValueError(
            f"target {d:.3f} m away but the limb only reaches {l1 + l2:.3f} m — "
            "move the contact point or the root, do not stretch the bone")
    if d < abs(l1 - l2):
        raise ValueError(f"target {d:.3f} m is inside the limb's minimum reach")

    u = mul(axis, 1.0 / d)
    a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)      # along-axis offset
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))       # perpendicular offset
    base = add(root, mul(u, a))

    perp = sub(pole, mul(u, dot(pole, u)))         # pole, orthogonalised
    if length(perp) < 1e-6:
        raise ValueError("pole vector is parallel to the limb axis")
    return add(base, mul(norm(perp), h))


class Skeleton:
    """Named joints plus the bones that must connect them at a fixed length."""

    def __init__(self) -> None:
        self.joints: dict[str, Vec] = {}
        self.bones: list[tuple[str, str, float, float]] = []

    def joint(self, name: str, position: Vec) -> Vec:
        self.joints[name] = position
        return position

    def bone(self, a: str, b: str, target: float, tol: float = 0.02) -> None:
        self.bones.append((a, b, target, tol))

    def check(self) -> str:
        """Assert every bone. Returns a report; raises on the first violation."""
        lines = [f"{'bone':22} {'actual':>7} {'target':>7} {'ratio':>6}"]
        bad = []
        for a, b, target, tol in self.bones:
            actual = dist(self.joints[a], self.joints[b])
            ratio = actual / target
            flag = "" if abs(ratio - 1.0) <= tol else "  <-- OUT OF SPEC"
            if flag:
                bad.append(f"{a}->{b}: {actual:.3f} m vs {target:.3f} m "
                           f"({ratio:.2f}x)")
            lines.append(f"{a + '->' + b:22} {actual:7.3f} {target:7.3f} "
                         f"{ratio:5.2f}x{flag}")
        report = "\n".join(lines)
        if bad:
            raise AssertionError(
                "skeleton is anatomically invalid:\n  " + "\n  ".join(bad)
                + "\n\n" + report)
        return report


def place_skeleton(skel, yaw_deg: float = 0.0, offset: Vec = (0.0, 0.0, 0.0)):
    """Rotate a finished skeleton about Z and move it.

    Poses are authored along one axis (facing +Y or -Y) because that is where
    the arithmetic is legible. Anyone standing at an angle — in a doorway, at
    the end of a table — is that same pose turned. Turning it afterwards keeps
    every bone length untouched, so the check still holds.
    """
    import math as _m
    c, s = _m.cos(_m.radians(yaw_deg)), _m.sin(_m.radians(yaw_deg))
    out = Skeleton()
    out.bones = list(skel.bones)
    for name, (x, y, z) in skel.joints.items():
        out.joints[name] = (x * c - y * s + offset[0],
                            x * s + y * c + offset[1],
                            z + offset[2])
    return out
