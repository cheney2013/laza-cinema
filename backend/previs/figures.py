"""
Two figures for the argument scene, built from checked bones.

Staging: he stays seated at the desk, she stands across it and leans in over
it. Height contrast is what makes the over-the-shoulder pair read — a seated
man and a standing woman give each shot a clear low/high angle without moving
the camera off the axis.

World convention:
    he sits at the origin facing +Y; she stands at +Y facing -Y.
    His right hand side is +X. Hers is -X.
"""

from __future__ import annotations

from rig import (FEMALE, MALE, Skeleton, add, dist, norm, place, solve_middle)

SEAT_Z = 0.45
DESK_TOP_Z = 0.765
DESK_Y = (0.31, 1.01)
DESK_HALF_X = 0.85


def seated_argument(p=MALE):
    """Seated, turned up toward her: right hand flat on the desk, left hand
    gripping the chair seat edge, chin lifted. Braced, not collapsed."""
    s = Skeleton()

    pelvis = s.joint("pelvis", (0.0, 0.02, SEAT_Z + 0.05))
    # leaning BACK a little — he is being leaned on, and gives ground
    lean = norm((0.06, -0.20, 0.978))
    chest = s.joint("chest", place(pelvis, lean, p.spine))
    s.bone("pelvis", "chest", p.spine)

    sh_r = s.joint("shoulder_r", add(chest, (p.shoulder_half, 0.01, -0.02)))
    sh_l = s.joint("shoulder_l", add(chest, (-p.shoulder_half, 0.01, 0.02)))

    # head placed on the spine line, then tipped up toward her
    head = s.joint("head", place(chest, norm((0.02, 0.34, 0.94)), 0.235))
    neck = dist(chest, head)
    if not (p.neck_min <= neck <= p.neck_max):
        raise AssertionError(f"seated neck {neck:.3f} out of range")

    # right hand planted flat on the desk top, palm down — a brace
    hand_r = s.joint("hand_r", (0.40, 0.52, DESK_TOP_Z + 0.03))
    wrist_r = s.joint("wrist_r", place(hand_r, norm((0.12, -0.55, 0.24)), p.hand))
    s.bone("wrist_r", "hand_r", p.hand)
    elbow_r = s.joint("elbow_r", solve_middle(sh_r, wrist_r, p.upper_arm,
                                              p.forearm, (0.85, -0.20, -0.49)))
    s.bone("shoulder_r", "elbow_r", p.upper_arm)
    s.bone("elbow_r", "wrist_r", p.forearm)

    # left hand gripping the front edge of the chair seat
    wrist_l = s.joint("wrist_l", (-0.28, 0.02, SEAT_Z + 0.05))
    elbow_l = s.joint("elbow_l", solve_middle(sh_l, wrist_l, p.upper_arm,
                                              p.forearm, (-0.90, -0.35, -0.25)))
    s.bone("shoulder_l", "elbow_l", p.upper_arm)
    s.bone("elbow_l", "wrist_l", p.forearm)
    hand_l = s.joint("hand_l", place(wrist_l, norm((-0.10, 0.30, -0.95)), p.hand))
    s.bone("wrist_l", "hand_l", p.hand)

    # both feet planted, knees apart — a braced sit, not a crossed-leg lounge
    for side, sx in (("l", -1.0), ("r", 1.0)):
        hip = s.joint(f"hip_{side}", (0.12 * sx, 0.06, SEAT_Z + 0.02))
        knee = s.joint(f"knee_{side}",
                       place(hip, (0.20 * sx, 0.96, -0.19), p.thigh))
        s.bone(f"hip_{side}", f"knee_{side}", p.thigh)
        ankle = s.joint(f"ankle_{side}",
                        place(knee, (0.05 * sx, 0.16, -0.986), p.shin))
        s.bone(f"knee_{side}", f"ankle_{side}", p.shin)
        if (abs(knee[0]) < DESK_HALF_X and DESK_Y[0] < knee[1] < DESK_Y[1]
                and knee[2] > DESK_TOP_Z - 0.06):
            raise AssertionError(f"{side} knee intersects the desk")

    return s, {"prop": p, "head_yaw_deg": 6.0, "head_pitch_hint": "lifted"}


def standing_argument(p=FEMALE):
    """Standing across the desk, leaning in hard: right hand planted on the far
    edge of the desk, left hand raised mid-gesture, head down at him."""
    s = Skeleton()

    HIP_Z = 0.86
    pelvis = s.joint("pelvis", (0.06, 1.52, HIP_Z))
    lean = norm((-0.03, -0.438, 0.899))          # 26 deg forward over the desk
    chest = s.joint("chest", place(pelvis, lean, p.spine))
    s.bone("pelvis", "chest", p.spine)

    sh_r = s.joint("shoulder_r", add(chest, (-p.shoulder_half, 0.0, -0.015)))
    sh_l = s.joint("shoulder_l", add(chest, (p.shoulder_half, 0.0, 0.015)))

    head = s.joint("head", place(chest, norm((-0.02, -0.30, 0.954)), 0.215))
    neck = dist(chest, head)
    if not (p.neck_min <= neck <= p.neck_max):
        raise AssertionError(f"standing neck {neck:.3f} out of range")

    # right hand planted on the far edge of the desk — the confrontational lean
    hand_r = s.joint("hand_r", (-0.26, 0.99, DESK_TOP_Z + 0.03))
    wrist_r = s.joint("wrist_r", place(hand_r, norm((-0.06, 0.42, 0.90)), p.hand))
    s.bone("wrist_r", "hand_r", p.hand)
    elbow_r = s.joint("elbow_r", solve_middle(sh_r, wrist_r, p.upper_arm,
                                              p.forearm, (-0.85, 0.10, 0.52)))
    s.bone("shoulder_r", "elbow_r", p.upper_arm)
    s.bone("elbow_r", "wrist_r", p.forearm)

    # left hand up, open, mid-gesture toward him
    wrist_l = s.joint("wrist_l", (0.34, 1.06, 1.30))
    elbow_l = s.joint("elbow_l", solve_middle(sh_l, wrist_l, p.upper_arm,
                                              p.forearm, (0.75, 0.15, -0.65)))
    s.bone("shoulder_l", "elbow_l", p.upper_arm)
    s.bone("elbow_l", "wrist_l", p.forearm)
    hand_l = s.joint("hand_l", place(wrist_l, norm((0.10, -0.86, 0.50)), p.hand))
    s.bone("wrist_l", "hand_l", p.hand)

    # standing legs, weight forward on the front foot
    for side, sx in (("l", 1.0), ("r", -1.0)):
        hip = s.joint(f"hip_{side}", (0.06 + 0.10 * sx, 1.52, HIP_Z))
        lead = 1.0 if side == "r" else 0.0        # her right foot is forward
        knee = s.joint(f"knee_{side}",
                       place(hip, (0.02 * sx, -0.14 - 0.10 * lead, -0.98),
                             p.thigh))
        s.bone(f"hip_{side}", f"knee_{side}", p.thigh)
        ankle = s.joint(f"ankle_{side}",
                        place(knee, (0.01 * sx, -0.10 - 0.16 * lead, -0.98),
                              p.shin))
        s.bone(f"knee_{side}", f"ankle_{side}", p.shin)
        if ankle[2] < -0.02:
            raise AssertionError(f"{side} foot is below the floor")

    return s, {"prop": p, "head_yaw_deg": -4.0, "head_pitch_hint": "down"}


def check_axis(cameras, a, b, min_offset=0.30):
    """The 180-degree rule, as an assertion.

    `a` and `b` are the two performers' positions. Every camera must sit on the
    same side of the line through them, or screen direction flips between shots
    and the cut reads as the pair having swapped places. Prose cannot enforce
    this; arithmetic can.
    """
    ax, ay = a[0], a[1]
    dx, dy = b[0] - ax, b[1] - ay
    report, sides = [], []
    for name, loc in cameras:
        # z-component of the 2D cross product: which side of the axis
        side = dx * (loc[1] - ay) - dy * (loc[0] - ax)
        sides.append(side)
        report.append(f"{name:16} offset {side:+.3f}")
    signs = {s > 0 for s in sides}
    if len(signs) > 1:
        raise AssertionError(
            "cameras straddle the axis — the cut would flip screen direction:\n  "
            + "\n  ".join(report))
    weak = [r for r, s in zip(report, sides) if abs(s) < min_offset]
    if weak:
        raise AssertionError(
            "camera(s) too close to the axis to read as a clean angle:\n  "
            + "\n  ".join(weak))
    return "180-degree rule holds; all cameras on one side:\n  " + "\n  ".join(report)


if __name__ == "__main__":
    for label, fn in (("SEATED (male)", seated_argument),
                      ("STANDING (female)", standing_argument)):
        skel, meta = fn()
        print(f"=== {label} ===")
        print(skel.check())
        print()


def standing_back_off(p=FEMALE):
    """She has straightened out of the lean and stepped back from the desk,
    arms folded, weight on her back foot. Closed off, still facing him."""
    s = Skeleton()

    HIP_Z = 0.88
    STAND_Y = 2.05                      # a step further back than the lean
    pelvis = s.joint("pelvis", (0.10, STAND_Y, HIP_Z))
    lean = norm((-0.02, 0.10, 0.995))   # weight back, very slight recline
    chest = s.joint("chest", place(pelvis, lean, p.spine))
    s.bone("pelvis", "chest", p.spine)

    sh_r = s.joint("shoulder_r", add(chest, (-p.shoulder_half, -0.01, -0.015)))
    sh_l = s.joint("shoulder_l", add(chest, (p.shoulder_half, -0.01, 0.015)))

    head = s.joint("head", place(chest, norm((-0.03, -0.16, 0.986)), 0.215))
    neck = dist(chest, head)
    if not (p.neck_min <= neck <= p.neck_max):
        raise AssertionError(f"back-off neck {neck:.3f} out of range")

    # folded arms: each hand tucks under the opposite elbow, across the ribs
    wrist_r = s.joint("wrist_r", (0.24, STAND_Y - 0.20, 1.16))
    elbow_r = s.joint("elbow_r", solve_middle(sh_r, wrist_r, p.upper_arm,
                                              p.forearm, (-0.80, -0.30, -0.52)))
    s.bone("shoulder_r", "elbow_r", p.upper_arm)
    s.bone("elbow_r", "wrist_r", p.forearm)
    hand_r = s.joint("hand_r", place(wrist_r, norm((0.80, -0.10, 0.20)), p.hand))
    s.bone("wrist_r", "hand_r", p.hand)

    wrist_l = s.joint("wrist_l", (-0.04, STAND_Y - 0.22, 1.22))
    elbow_l = s.joint("elbow_l", solve_middle(sh_l, wrist_l, p.upper_arm,
                                              p.forearm, (0.80, -0.30, -0.52)))
    s.bone("shoulder_l", "elbow_l", p.upper_arm)
    s.bone("elbow_l", "wrist_l", p.forearm)
    hand_l = s.joint("hand_l", place(wrist_l, norm((-0.80, -0.10, 0.18)), p.hand))
    s.bone("wrist_l", "hand_l", p.hand)

    for side, sx in (("l", 1.0), ("r", -1.0)):
        hip = s.joint(f"hip_{side}", (0.10 + 0.10 * sx, STAND_Y, HIP_Z))
        knee = s.joint(f"knee_{side}",
                       place(hip, (0.02 * sx, -0.06, -0.998), p.thigh))
        s.bone(f"hip_{side}", f"knee_{side}", p.thigh)
        ankle = s.joint(f"ankle_{side}",
                        place(knee, (0.01 * sx, -0.04, -0.999), p.shin))
        s.bone(f"knee_{side}", f"ankle_{side}", p.shin)
        if ankle[2] < -0.02:
            raise AssertionError(f"{side} foot below the floor")

    return s, {"prop": p, "head_yaw_deg": -6.0, "head_pitch_hint": "level"}


def standing_risen(p=MALE):
    """He has pushed up out of the chair and is standing behind the desk, one
    hand still resting on the desk top, the other loose at his side."""
    s = Skeleton()

    HIP_Z = 0.92
    STAND_Y = -0.30                     # pushed the chair back
    pelvis = s.joint("pelvis", (0.02, STAND_Y, HIP_Z))
    lean = norm((0.02, 0.16, 0.987))    # slight forward carry
    chest = s.joint("chest", place(pelvis, lean, p.spine))
    s.bone("pelvis", "chest", p.spine)

    sh_r = s.joint("shoulder_r", add(chest, (p.shoulder_half, 0.0, -0.02)))
    sh_l = s.joint("shoulder_l", add(chest, (-p.shoulder_half, 0.0, 0.02)))

    head = s.joint("head", place(chest, norm((0.02, 0.14, 0.99)), 0.235))
    neck = dist(chest, head)
    if not (p.neck_min <= neck <= p.neck_max):
        raise AssertionError(f"risen neck {neck:.3f} out of range")

    # Standing, his shoulder is ~0.65 m above the desk and ~0.65 m back from it;
    # the IK refused any fingertip contact from here, which is correct — the
    # reach simply is not there. Both arms hang instead, hands half closed.
    elbow_r = s.joint("elbow_r", place(sh_r, (0.10, -0.04, -0.99), p.upper_arm))
    s.bone("shoulder_r", "elbow_r", p.upper_arm)
    wrist_r = s.joint("wrist_r", place(elbow_r, (0.03, 0.22, -0.975), p.forearm))
    s.bone("elbow_r", "wrist_r", p.forearm)
    hand_r = s.joint("hand_r", place(wrist_r, norm((0.02, 0.18, -0.98)), p.hand))
    s.bone("wrist_r", "hand_r", p.hand)

    # left arm hanging loose
    elbow_l = s.joint("elbow_l", place(sh_l, (-0.10, -0.06, -0.99), p.upper_arm))
    s.bone("shoulder_l", "elbow_l", p.upper_arm)
    wrist_l = s.joint("wrist_l", place(elbow_l, (-0.02, 0.20, -0.98), p.forearm))
    s.bone("elbow_l", "wrist_l", p.forearm)
    hand_l = s.joint("hand_l", place(wrist_l, norm((-0.02, 0.16, -0.99)), p.hand))
    s.bone("wrist_l", "hand_l", p.hand)

    for side, sx in (("l", -1.0), ("r", 1.0)):
        hip = s.joint(f"hip_{side}", (0.02 + 0.10 * sx, STAND_Y, HIP_Z))
        knee = s.joint(f"knee_{side}",
                       place(hip, (0.02 * sx, 0.05, -0.999), p.thigh))
        s.bone(f"hip_{side}", f"knee_{side}", p.thigh)
        ankle = s.joint(f"ankle_{side}",
                        place(knee, (0.01 * sx, 0.03, -0.999), p.shin))
        s.bone(f"knee_{side}", f"ankle_{side}", p.shin)
        if ankle[2] < -0.02:
            raise AssertionError(f"{side} foot below the floor")

    return s, {"prop": p, "head_yaw_deg": 4.0, "head_pitch_hint": "level"}


def _seated_at_desk(p, lean, head_dir, head_len, hand_r_at, hand_l_at,
                    pen_dir=(0.10, -0.55, 0.83), palm_dir=(-0.05, -0.60, 0.80)):
    """Shared body for the two writing-desk poses: both hands are contacts on
    the desk top, so both wrists are solved back from where the hands rest."""
    s = Skeleton()
    pelvis = s.joint("pelvis", (0.0, 0.02, SEAT_Z + 0.05))
    chest = s.joint("chest", place(pelvis, norm(lean), p.spine))
    s.bone("pelvis", "chest", p.spine)
    sh_r = s.joint("shoulder_r", add(chest, (p.shoulder_half, 0.01, -0.02)))
    sh_l = s.joint("shoulder_l", add(chest, (-p.shoulder_half, 0.01, 0.02)))

    head = s.joint("head", place(chest, norm(head_dir), head_len))
    neck = dist(chest, head)
    if not (p.neck_min <= neck <= p.neck_max):
        raise AssertionError(f"desk-pose neck {neck:.3f} out of range")

    for side, sh, at, out_dir, pole in (
            ("r", sh_r, hand_r_at, pen_dir, (0.85, -0.30, -0.44)),
            ("l", sh_l, hand_l_at, palm_dir, (-0.85, -0.30, -0.44))):
        hand = s.joint(f"hand_{side}", at)
        wrist = s.joint(f"wrist_{side}", place(hand, norm(out_dir), p.hand))
        s.bone(f"wrist_{side}", f"hand_{side}", p.hand)
        s.joint(f"elbow_{side}",
                solve_middle(sh, wrist, p.upper_arm, p.forearm, pole))
        s.bone(f"shoulder_{side}", f"elbow_{side}", p.upper_arm)
        s.bone(f"elbow_{side}", f"wrist_{side}", p.forearm)

    for side, sx in (("l", -1.0), ("r", 1.0)):
        hip = s.joint(f"hip_{side}", (0.12 * sx, 0.06, SEAT_Z + 0.02))
        knee = s.joint(f"knee_{side}", place(hip, (0.16 * sx, 0.96, -0.20), p.thigh))
        s.bone(f"hip_{side}", f"knee_{side}", p.thigh)
        ankle = s.joint(f"ankle_{side}", place(knee, (0.04 * sx, 0.14, -0.99), p.shin))
        s.bone(f"knee_{side}", f"ankle_{side}", p.shin)
    return s


def seated_writing(p=MALE):
    """Head down over the open notebook, pen in the right hand, left palm flat
    on the page to hold it. The pose the film opens on."""
    s = _seated_at_desk(
        p, lean=(0.0698, 0.3083, 0.9488), head_dir=(0.03, 0.55, 0.83),
        head_len=0.235,
        hand_r_at=(0.14, 0.46, DESK_TOP_Z + 0.035),
        hand_l_at=(-0.28, 0.46, DESK_TOP_Z + 0.025),
        palm_dir=(-0.50, -0.60, 0.63))
    return s, {"prop": p, "head_yaw_deg": 4.0, "head_pitch_hint": "down"}


def seated_looks_up(p=MALE):
    """He has heard her in the corridor: chin up, pen hand lifted off the page,
    left hand still flat on the notebook he is about to close."""
    s = _seated_at_desk(
        p, lean=(0.05, 0.10, 0.994), head_dir=(0.16, 0.44, 0.88),
        head_len=0.235,
        hand_r_at=(0.18, 0.50, DESK_TOP_Z + 0.035),
        hand_l_at=(-0.20, 0.56, DESK_TOP_Z + 0.025),
        pen_dir=(0.20, -0.50, 0.84))
    return s, {"prop": p, "head_yaw_deg": 22.0, "head_pitch_hint": "lifted"}


def seated_upright_hand_on_book(p=MALE, pen_in_hand=False):
    """He has heard her and sits up: spine upright, right hand resting flat on
    the closed notebook, left hand flat on the desk beside it, chin lifted and
    turned toward the door. Used for segment 1's last two shots so the panels
    and the render agree that he is upright, not hunched over the desk -- the
    look-up pose reached half a metre forward for the page and read as a lean
    from the doorway camera."""
    s = _seated_at_desk(
        p, lean=(0.02, 0.02, 0.9996), head_dir=(0.18, 0.40, 0.90),
        head_len=0.235,
        hand_r_at=(0.10, 0.46, DESK_TOP_Z + 0.048),
        # Beside the right hand on the notebook: out at x -0.30 the arm ran
        # vertically down the frame edge of the doorway wide and read as hanging
        # below the desk (2026-09-05), and the render then dropped it into his lap.
        hand_l_at=(-0.07, 0.53, DESK_TOP_Z + 0.030),
        # Pen still in the right hand at the start of the closing shot; laid down
        # by the time the book is shut.
        pen_dir=(0.20, -0.50, 0.84) if pen_in_hand else (0.0, 0.0, 1.0))
    return s, {"prop": p, "head_yaw_deg": 24.0, "head_pitch_hint": "lifted"}


def standing_arrival(p=FEMALE, hand_r_at=(-0.34, 0.06, 1.24), wrist_dir=(0.55, 0.10, -0.83),
                     elbow_hint=(-0.75, 0.25, -0.61)):
    """Stopped in a doorway, one hand still on the door frame at her side.
    `hand_r_at` (authored frame, facing -Y) moves that hand: seg01 puts it on the
    door leaf she is pushing open, with `wrist_dir` pointing back toward her body.
    Authored facing -Y like every other standing pose; turn it with
    rig.place_skeleton to point her into the room."""
    s = Skeleton()
    HIP_Z = 0.88
    pelvis = s.joint("pelvis", (0.0, 0.0, HIP_Z))
    chest = s.joint("chest", place(pelvis, norm((0.0, -0.06, 0.998)), p.spine))
    s.bone("pelvis", "chest", p.spine)
    sh_r = s.joint("shoulder_r", add(chest, (-p.shoulder_half, 0.0, -0.015)))
    sh_l = s.joint("shoulder_l", add(chest, (p.shoulder_half, 0.0, 0.015)))

    head = s.joint("head", place(chest, norm((0.0, -0.14, 0.99)), 0.215))
    if not (p.neck_min <= dist(chest, head) <= p.neck_max):
        raise AssertionError("arrival neck out of range")

    # right hand raised to the door frame beside her
    hand_r = s.joint("hand_r", tuple(hand_r_at))
    wrist_r = s.joint("wrist_r", place(hand_r, norm(wrist_dir), p.hand))
    s.bone("wrist_r", "hand_r", p.hand)
    s.joint("elbow_r", solve_middle(sh_r, wrist_r, p.upper_arm, p.forearm,
                                    elbow_hint))
    s.bone("shoulder_r", "elbow_r", p.upper_arm)
    s.bone("elbow_r", "wrist_r", p.forearm)

    # left arm hanging
    elbow_l = s.joint("elbow_l", place(sh_l, (0.09, -0.05, -0.995), p.upper_arm))
    s.bone("shoulder_l", "elbow_l", p.upper_arm)
    wrist_l = s.joint("wrist_l", place(elbow_l, (0.02, -0.16, -0.987), p.forearm))
    s.bone("elbow_l", "wrist_l", p.forearm)
    hand_l = s.joint("hand_l", place(wrist_l, norm((0.0, -0.20, -0.98)), p.hand))
    s.bone("wrist_l", "hand_l", p.hand)

    for side, sx in (("l", 1.0), ("r", -1.0)):
        hip = s.joint(f"hip_{side}", (0.10 * sx, 0.0, HIP_Z))
        knee = s.joint(f"knee_{side}", place(hip, (0.02 * sx, -0.05, -0.999), p.thigh))
        s.bone(f"hip_{side}", f"knee_{side}", p.thigh)
        ankle = s.joint(f"ankle_{side}", place(knee, (0.01 * sx, -0.03, -0.999), p.shin))
        s.bone(f"knee_{side}", f"ankle_{side}", p.shin)
    return s, {"prop": p, "head_yaw_deg": 0.0, "head_pitch_hint": "level"}


def _standing_base(p, stand_xy, lean, head_dir, head_len=0.215, stride=0.0):
    """Shared trunk and legs for the standing poses in the study.

    `stride` splits the feet front-to-back: 0 is standing still, larger values
    read as mid-step. Authored facing -Y like every other standing pose; turn it
    with rig.place_skeleton.
    """
    s = Skeleton()
    HIP_Z = 0.88
    pelvis = s.joint("pelvis", (stand_xy[0], stand_xy[1], HIP_Z))
    chest = s.joint("chest", place(pelvis, norm(lean), p.spine))
    s.bone("pelvis", "chest", p.spine)
    s.joint("shoulder_r", add(chest, (-p.shoulder_half, 0.0, -0.015)))
    s.joint("shoulder_l", add(chest, (p.shoulder_half, 0.0, 0.015)))
    head = s.joint("head", place(chest, norm(head_dir), head_len))
    if not (p.neck_min <= dist(chest, head) <= p.neck_max):
        raise AssertionError("standing neck out of range")

    for side, sx, lead in (("l", 1.0, -1.0), ("r", -1.0, 1.0)):
        hip = s.joint(f"hip_{side}", (stand_xy[0] + 0.10 * sx, stand_xy[1], HIP_Z))
        knee = s.joint(f"knee_{side}",
                       place(hip, (0.02 * sx, -0.05 - stride * lead, -0.99), p.thigh))
        s.bone(f"hip_{side}", f"knee_{side}", p.thigh)
        ankle = s.joint(f"ankle_{side}",
                        place(knee, (0.01 * sx, -0.04 - stride * lead * 1.6, -0.98),
                              p.shin))
        s.bone(f"knee_{side}", f"ankle_{side}", p.shin)
        if ankle[2] < -0.03:
            raise AssertionError(f"{side} foot below the floor")
    return s


def _hang_arm(s, p, side, out, fore, hand_dir):
    sh = s.joints[f"shoulder_{side}"]
    elbow = s.joint(f"elbow_{side}", place(sh, out, p.upper_arm))
    s.bone(f"shoulder_{side}", f"elbow_{side}", p.upper_arm)
    wrist = s.joint(f"wrist_{side}", place(elbow, fore, p.forearm))
    s.bone(f"elbow_{side}", f"wrist_{side}", p.forearm)
    s.joint(f"hand_{side}", place(wrist, norm(hand_dir), p.hand))
    s.bone(f"wrist_{side}", f"hand_{side}", p.hand)


def walking_in(p=FEMALE):
    """Mid-step, crossing the room. Arms swing loosely opposite the legs."""
    s = _standing_base(p, (0.0, 0.0), (0.0, -0.10, 0.995), (0.0, -0.16, 0.99),
                       stride=0.30)
    _hang_arm(s, p, "r", (0.06, -0.34, -0.94), (0.02, -0.30, -0.95), (0.0, -0.34, -0.94))
    _hang_arm(s, p, "l", (-0.06, 0.30, -0.95), (-0.02, 0.26, -0.96), (0.0, 0.28, -0.96))
    return s, {"prop": p, "head_yaw_deg": 0.0, "head_pitch_hint": "level"}


def standing_hand_to_pocket(p=FEMALE):
    """Stopped at the desk. Her right hand has gone to the pocket of her
    cardigan; the folded paper is about to come out of it."""
    s = _standing_base(p, (0.0, 0.0), (0.0, -0.06, 0.998), (0.0, -0.14, 0.99))
    hand_r = s.joint("hand_r", (-0.17, -0.09, 1.02))          # at the pocket
    wrist_r = s.joint("wrist_r", place(hand_r, norm((-0.10, -0.20, 0.97)), p.hand))
    s.bone("wrist_r", "hand_r", p.hand)
    s.joint("elbow_r", solve_middle(s.joints["shoulder_r"], wrist_r,
                                    p.upper_arm, p.forearm, (-0.90, -0.30, -0.32)))
    s.bone("shoulder_r", "elbow_r", p.upper_arm)
    s.bone("elbow_r", "wrist_r", p.forearm)
    _hang_arm(s, p, "l", (0.08, -0.06, -0.99), (0.02, -0.14, -0.99), (0.0, -0.16, -0.99))
    return s, {"prop": p, "head_yaw_deg": 0.0, "head_pitch_hint": "level"}


def standing_lays_paper(p=FEMALE, side="r", hand_at=None):
    """Leaning in over the desk, one hand out flat, setting a sheet of paper
    down on the timber. `side` picks the hand; `hand_at` (authored frame, facing
    -Y) moves it -- seg02 lays the sheet on the side of the notebook the insert
    camera reads as its right, which is her left."""
    s = _standing_base(p, (0.0, 0.0), (-0.02, -0.34, 0.94), (-0.02, -0.30, 0.95))
    sx = -1.0 if side == "r" else 1.0
    hand = s.joint(f"hand_{side}", tuple(hand_at) if hand_at else (-0.20 * -sx, -0.46, 0.80))
    wrist = s.joint(f"wrist_{side}", place(hand, norm((-0.06 * -sx, 0.36, 0.93)), p.hand))
    s.bone(f"wrist_{side}", f"hand_{side}", p.hand)
    s.joint(f"elbow_{side}", solve_middle(s.joints[f"shoulder_{side}"], wrist,
                                          p.upper_arm, p.forearm, (-0.86 * -sx, 0.12, 0.50)))
    s.bone(f"shoulder_{side}", f"elbow_{side}", p.upper_arm)
    s.bone(f"elbow_{side}", f"wrist_{side}", p.forearm)
    other = "l" if side == "r" else "r"
    ox = 1.0 if other == "l" else -1.0
    _hang_arm(s, p, other, (0.10 * ox, -0.10, -0.99), (0.02 * ox, -0.18, -0.98), (0.0, -0.20, -0.98))
    return s, {"prop": p, "head_yaw_deg": 0.0, "head_pitch_hint": "down"}


def standing_at_desk(p=FEMALE):
    """Stopped at the desk, upright, both hands hanging at her sides. The state
    segment 2 ends on (the letter already laid down), so segment 3's first panel
    opens on it; the lean of standing_argument() is that shot's action."""
    s = _standing_base(p, (0.0, 0.0), (0.0, -0.04, 0.999), (0.0, -0.12, 0.99))
    _hang_arm(s, p, "r", (0.08, -0.06, -0.99), (0.02, -0.14, -0.99), (0.0, -0.16, -0.99))
    _hang_arm(s, p, "l", (-0.08, -0.06, -0.99), (-0.02, -0.14, -0.99), (0.0, -0.16, -0.99))
    return s, {"prop": p, "head_yaw_deg": 0.0, "head_pitch_hint": "down"}


def seated_hand_on_book(p=MALE):
    """Him, chair pushed back a little, one hand flat on the closed notebook,
    chin up toward her. The pose segment 1 ended on."""
    s = Skeleton()
    pelvis = s.joint("pelvis", (0.0, 0.02, SEAT_Z + 0.05))
    chest = s.joint("chest", place(pelvis, norm((0.05, -0.12, 0.99)), p.spine))
    s.bone("pelvis", "chest", p.spine)
    sh_r = s.joint("shoulder_r", add(chest, (p.shoulder_half, 0.01, -0.02)))
    sh_l = s.joint("shoulder_l", add(chest, (-p.shoulder_half, 0.01, 0.02)))
    head = s.joint("head", place(chest, norm((0.02, 0.30, 0.95)), 0.235))
    if not (p.neck_min <= dist(chest, head) <= p.neck_max):
        raise AssertionError("seated neck out of range")

    hand_r = s.joint("hand_r", (0.00, 0.44, DESK_TOP_Z + 0.03))   # near corner of the closed book
    wrist_r = s.joint("wrist_r", place(hand_r, norm((0.30, -0.52, 0.80)), p.hand))
    s.bone("wrist_r", "hand_r", p.hand)
    s.joint("elbow_r", solve_middle(sh_r, wrist_r, p.upper_arm, p.forearm,
                                    (0.86, -0.28, -0.42)))
    s.bone("shoulder_r", "elbow_r", p.upper_arm)
    s.bone("elbow_r", "wrist_r", p.forearm)

    wrist_l = s.joint("wrist_l", (-0.28, 0.02, SEAT_Z + 0.05))
    s.joint("elbow_l", solve_middle(sh_l, wrist_l, p.upper_arm, p.forearm,
                                    (-0.90, -0.35, -0.25)))
    s.bone("shoulder_l", "elbow_l", p.upper_arm)
    s.bone("elbow_l", "wrist_l", p.forearm)
    s.joint("hand_l", place(wrist_l, norm((-0.10, 0.30, -0.95)), p.hand))
    s.bone("wrist_l", "hand_l", p.hand)

    for side, sx in (("l", -1.0), ("r", 1.0)):
        hip = s.joint(f"hip_{side}", (0.12 * sx, 0.06, SEAT_Z + 0.02))
        knee = s.joint(f"knee_{side}", place(hip, (0.18 * sx, 0.96, -0.20), p.thigh))
        s.bone(f"hip_{side}", f"knee_{side}", p.thigh)
        ankle = s.joint(f"ankle_{side}", place(knee, (0.04 * sx, 0.14, -0.99), p.shin))
        s.bone(f"knee_{side}", f"ankle_{side}", p.shin)
    return s, {"prop": p, "head_yaw_deg": 8.0, "head_pitch_hint": "lifted"}
