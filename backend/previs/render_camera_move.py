"""Render a shot's camera move as a low-resolution grey video, to be referenced.

Prose and timecodes only approximate a camera rate; a reference video pins it.
The video carries the move and the blocking and nothing else: a small grey
render of the set, so it cannot argue with the photographic plate about what
anything is made of.

    blender --background --factory-startup <set.blend> \
        --python backend/previs/render_camera_move.py -- \
        --scene <move.json> --frames 260 --hold 24 --pan 156 \
        --out DIR/move.mp4 [--scale 0.5] [--figures]

The scene config (JSON, kept with the set, not in the repository):

    {
      "units_per_metre": 1.0,           # model units per metre
      "sensor": 36.0, "lens": 48.0,
      "eye": [x, y, z],                 # camera position
      "start_aim": [x, y, z],           # held on before the pan
      "end_aim": [x, y, z],             # where the pan lands
      "set_edits": {...},               # see scene_config.py
      "figures": {
        "ground": z,                    # floor height the walker stands on
        "boxes": [{"name", "centre", "size", "color"}],   # static blocks
        "walker": {
          "name": "W", "height": h, "footprint": [w, d], "color": [...],
          "path": [[x, y], ...],
          "keys": [["pan_end", -40], ["end", -12], ...],  # anchor + offset
          "face": [dx, dy], "face_until": ["pan_end", 26],
          "heading_before": [dx, dy], "heading_after": [dx, dy]
        }
      }
    }

Key anchors are "start" (0), "hold" (--hold), "pan_end" (--hold + --pan) and
"end" (--frames).  Blocks, not mannequins, and one pose that translates -- a
previs carries a trajectory, never a gait.  Keep block colours muted: a
saturated block in a reference video is a colour the generation can pick up.
"""

import math
import os
import subprocess
import sys

import bpy
from mathutils import Euler, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "vendor"))
import scene_config  # noqa: E402
from scene_config import ease  # noqa: E402

ARGS = scene_config.script_args()
arg = scene_config.make_arg(ARGS)
CFG = scene_config.load(arg("--scene"))
S = float(CFG.get("units_per_metre", 1.0))

FRAMES = int(arg("--frames", "260"))
HOLD = int(arg("--hold", "24"))        # frames held before the pan starts
PAN = int(arg("--pan", "156"))         # frames the pan itself takes
OUT = os.path.abspath(arg("--out", "move.mp4"))
# The start and end of the arc can be overridden: what the grey camera must
# match at its first frame is the frame the previous generated segment actually
# ended on, not the previs framing, and a seam is only invisible if they agree.
START_AIM = arg("--start-aim")
END_AIM = arg("--end-aim")
DIST = arg("--dist")            # metres from the start aim, overriding the camera
# --dist measures back from the START aim; when the shot opens elsewhere give
# the camera outright with --eye.
EYE_ARG = arg("--eye")
FIGURES = "--figures" in ARGS
# Handheld has to live in this clip: the generation copies the camera from the
# video, so a perfectly smooth grey move produces a perfectly smooth take no
# matter what the prompt says.  Degrees.
SHAKE_DRIFT = float(arg("--shake-drift", "0.0"))    # slow wander, 3-6 s periods
SHAKE_TREMOR = float(arg("--shake-tremor", "0.0"))  # the tremor under it, 4-7 Hz
# Better than either: real recorded handheld, from Camera Shakify's CC0 data
# vendored in previs/vendor.
SHAKIFY = arg("--shakify")
SHAKIFY_SCALE = float(arg("--shakify-scale", "1.0"))
# Shake only once the move has arrived, faded in over a few frames.
SHAKIFY_FROM = arg("--shakify-from")
SHAKIFY_RAMP = int(arg("--shakify-ramp", "10"))
SCALE = float(arg("--scale", "0.5"))
FPS = 24
# Workbench renders every frame razor sharp, so a fast pan strobes at 24 fps and
# the generation copies the judder.  --motion-blur N renders N sub-frames across
# the shutter and averages them.
MB = max(int(arg("--motion-blur", "1")), 1)
# Fraction of a frame: 0.5 is a 180-degree shutter; 1.0 blends into the next.
SHUTTER = float(arg("--shutter", "0.5"))

scene = bpy.context.scene
scene_config.apply_set_edits(scene, CFG)

W, H = int(1376 * SCALE) // 2 * 2, int(768 * SCALE) // 2 * 2
scene.render.resolution_x, scene.render.resolution_y = W, H
scene_config.workbench_grey(scene)

cd = bpy.data.cameras.new("move")
cd.sensor_width = float(CFG.get("sensor", 36.0))
cd.lens = float(CFG["lens"])
cd.clip_start, cd.clip_end = 0.05, 300.0
cam = bpy.data.objects.new("move", cd)
scene.collection.objects.link(cam)
scene.camera = cam
EYE = Vector(CFG["eye"])
start = Vector(scene_config.vec3(START_AIM) if START_AIM else CFG["start_aim"])
end = Vector(scene_config.vec3(END_AIM) if END_AIM else CFG["end_aim"])
if EYE_ARG:
    EYE = Vector(scene_config.vec3(EYE_ARG))
elif DIST:
    d = (EYE - start)
    d.z = 0.0
    EYE = start + d.normalized() * (float(DIST) * S) + Vector((0, 0, EYE.z - start.z))
ROT_A = (EYE - start).to_track_quat("Z", "Y")
ROT_B = (EYE - end).to_track_quat("Z", "Y")
cam.location = EYE


# ── figures ─────────────────────────────────────────────────────────────────
ANCHORS = {"start": 0, "hold": HOLD, "pan_end": HOLD + PAN, "end": FRAMES}


def frame_of(key):
    anchor, offset = key
    return ANCHORS[anchor] + int(offset)


def box(name, centre, size, colour):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=centre)
    o = bpy.context.object
    o.name = name
    # primitive_cube_add(size=1.0) is one unit across, so the scale IS the size.
    o.scale = tuple(size)
    o.color = tuple(colour)
    return o


FIG = CFG.get("figures", {})
WALK = FIG.get("walker")
walker = None
if WALK:
    WALK_PATH = [tuple(p) for p in WALK["path"]]
    WALK_KEYS = [frame_of(k) for k in WALK["keys"]]
    # --walker-path "x,y;x,y;..." [--walker-keys f,f,...] overrides the marks so
    # one config can serve a move that walks the other way.
    if arg("--walker-path"):
        WALK_PATH = [tuple(float(v) for v in seg.split(","))
                     for seg in arg("--walker-path").split(";")]
        keys_arg = arg("--walker-keys")
        WALK_KEYS = ([int(v) for v in keys_arg.split(",")] if keys_arg
                     else [int(FRAMES * i / (len(WALK_PATH) - 1.0))
                           for i in range(len(WALK_PATH))])
    # Until face_until the walker faces a fixed direction (e.g. still turned to
    # a door it is shutting); a path direction cannot say that when it barely moves.
    FACE = tuple(WALK.get("face")) if WALK.get("face") else None
    FACE_UNTIL = (int(arg("--face-until")) if arg("--face-until")
                  else frame_of(WALK["face_until"]) if WALK.get("face_until") else -1)
    HEADING_BEFORE = tuple(WALK.get("heading_before", (0.0, -1.0)))
    HEADING_AFTER = tuple(WALK.get("heading_after", (0.0, -1.0)))


def lerp(a, b, t):
    return a + (b - a) * t


def walker_at(f):
    face = FACE if (FACE and f <= FACE_UNTIL) else None
    if f <= WALK_KEYS[0]:
        return WALK_PATH[0], (face or HEADING_BEFORE)
    for i in range(len(WALK_PATH) - 1):
        if f <= WALK_KEYS[i + 1]:
            t = ease((f - WALK_KEYS[i]) / max(WALK_KEYS[i + 1] - WALK_KEYS[i], 1))
            a, b = WALK_PATH[i], WALK_PATH[i + 1]
            p = (lerp(a[0], b[0], t), lerp(a[1], b[1], t))
            d = (b[0] - a[0], b[1] - a[1])
            n = math.hypot(*d)
            heading = (d[0] / n, d[1] / n) if n > 1e-6 else HEADING_BEFORE
            return p, (face or heading)
    return WALK_PATH[-1], (face or HEADING_AFTER)


if FIGURES:
    for b in FIG.get("boxes", ()):
        box(b["name"], b["centre"], b["size"], b["color"])
    if WALK:
        name = WALK.get("name", "Walker")
        walker = bpy.data.objects.new(name + "Root", None)
        scene.collection.objects.link(walker)
        h = float(WALK["height"])
        body = box(name + "_body", (0.0, 0.0, h / 2.0),
                   (WALK["footprint"][0], WALK["footprint"][1], h), WALK["color"])
        body.parent = walker


def shakify_offsets(name, scale, frames, fps):
    """Per-frame (location, rotation) offsets sampled from the recorded curves.

    The curves are keyed every frame at their own fps and loop when the shot is
    longer than the take they were recorded from.  Location comes out in metres,
    so it is converted to model units; rotation is already radians.
    """
    import shake_data
    _label, src_fps, curves = shake_data.SHAKE_LIST[name]
    length = max(max(k for k, _v in pts) for pts in curves.values()) + 1

    def sample(channel, axis, f):
        pts = curves.get((channel, axis))
        if not pts:
            return 0.0
        t = (f * src_fps / fps) % length
        i = int(t)
        a = dict(pts).get(i, 0.0)
        b = dict(pts).get((i + 1) % length, a)
        return a + (b - a) * (t - i)

    out = []
    for f in range(frames):
        loc = Vector((sample("location", 0, f), sample("location", 1, f),
                      sample("location", 2, f))) * scale * S
        rot = Euler((sample("rotation_euler", 0, f) * scale,
                     sample("rotation_euler", 1, f) * scale,
                     sample("rotation_euler", 2, f) * scale), "XYZ")
        out.append((loc, rot))
    return out


SHAKE_TABLE = (shakify_offsets(SHAKIFY, SHAKIFY_SCALE, FRAMES, FPS)
               if SHAKIFY else None)


def shake_at(f):
    """The recorded shake at a fractional frame, interpolated between samples."""
    i = min(int(math.floor(f)), FRAMES - 1)
    j = min(i + 1, FRAMES - 1)
    t = f - math.floor(f)
    (la, ra), (lb, rb) = SHAKE_TABLE[i], SHAKE_TABLE[j]
    return (la.lerp(lb, t),
            Euler((ra.x + (rb.x - ra.x) * t, ra.y + (rb.y - ra.y) * t,
                   ra.z + (rb.z - ra.z) * t), "XYZ"))


seq = os.path.join(os.path.dirname(OUT), "_move_frames")
os.makedirs(seq, exist_ok=True)
# one render per sub-frame; frame f's MB sub-frames are written consecutively
SUBFRAMES = ([f + (s / (MB - 1) - 0.5) * SHUTTER for f in range(FRAMES) for s in range(MB)]
             if MB > 1 else [float(f) for f in range(FRAMES)])
GROUND = float(FIG.get("ground", 0.0))
for k, f in enumerate(SUBFRAMES):
    f = min(max(f, 0.0), FRAMES - 1.0)
    if f <= HOLD:
        u = 0.0
    elif f >= HOLD + PAN:
        u = 1.0
    else:
        u = ease((f - HOLD) / float(PAN))
    q = ROT_A.slerp(ROT_B, u)
    eye = EYE
    if SHAKE_TABLE is not None:
        if SHAKIFY_FROM is None:
            w = 1.0
        else:
            w = ease((f - int(SHAKIFY_FROM)) / float(max(SHAKIFY_RAMP, 1)))
        if w > 0.0:
            dloc, drot = shake_at(f)
            drot = Euler((drot.x * w, drot.y * w, drot.z * w), "XYZ")
            m = q.to_matrix().to_4x4() @ drot.to_matrix().to_4x4()
            q = m.to_quaternion()
            eye = EYE + (q.to_matrix() @ (dloc * w))
    if SHAKE_DRIFT or SHAKE_TREMOR:
        t = f / float(FPS)
        # Sines at incommensurable periods, so the wander never repeats inside
        # a shot and never lands on a beat.
        dyaw = (SHAKE_DRIFT * (0.6 * math.sin(2 * math.pi * t / 5.3 + 0.7)
                               + 0.4 * math.sin(2 * math.pi * t / 3.1 + 2.2))
                + SHAKE_TREMOR * (0.6 * math.sin(2 * math.pi * t * 5.7 + 1.1)
                                  + 0.4 * math.sin(2 * math.pi * t * 4.3)))
        dpitch = (SHAKE_DRIFT * (0.5 * math.sin(2 * math.pi * t / 4.7 + 1.9)
                                 + 0.5 * math.sin(2 * math.pi * t / 6.2))
                  + SHAKE_TREMOR * (0.5 * math.sin(2 * math.pi * t * 6.3 + 0.4)
                                    + 0.5 * math.sin(2 * math.pi * t * 4.9 + 2.7)))
        q = (q.to_matrix().to_4x4()
             @ Euler((math.radians(dpitch), math.radians(dyaw), 0.0),
                     "XYZ").to_matrix().to_4x4()).to_quaternion()
    cam.rotation_euler = q.to_euler()
    cam.location = eye
    if walker is not None:
        (wx, wy), (dx, dy) = walker_at(f)
        walker.location = (wx, wy, GROUND)
        walker.rotation_euler = (0.0, 0.0, math.atan2(dy, dx) - math.pi / 2.0)
    scene.render.filepath = os.path.join(seq, "f%05d" % k)
    bpy.ops.render.render(write_still=True)

cmd = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS * MB),
       "-i", os.path.join(seq, "f%05d.png")]
if MB > 1:
    # average each frame's MB sub-frames: tmix looks back MB renders, and the
    # last sub-frame of frame f is render MB*f + MB-1
    cmd += ["-vf", "tmix=frames=%d,select='eq(mod(n\\,%d)\\,%d)',setpts=N/%d/TB"
            % (MB, MB, MB - 1, FPS)]
cmd += ["-r", str(FPS), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", OUT]
subprocess.run(cmd, check=True)
for name in os.listdir(seq):
    os.remove(os.path.join(seq, name))
os.rmdir(seq)
print("wrote", OUT, "%dx%d" % (W, H), FRAMES, "frames")
