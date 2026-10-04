"""Per-shot scene-plate coverage: which of the set each shot sees, and how much
of that the plates wired to the segment actually show.

Before a segment is generated, every shot's plate coverage is computed, and
anything a shot looks at that no plate covers gets a plate before the render.

Project every set object's bounding box through a camera, clip to the frame,
take the covered fraction. A plate covers an object for a shot up to
min(area_shot, area_plate); the shot's coverage is

    cover(shot) = sum_o min(area_shot(o), max_p area_plate_p(o)) / sum_o area_shot(o)

over the plates in use, and the report also lists every object that takes more
than --min-area of the shot's frame and appears in none of them.

    blender --background --factory-startup --python plate_coverage.py -- \
        --scene coverage.json --shots SHOTS --plates name,name,pan:120 \
        [--label seg02] [--min-area 0.005] [--json out.json]

SHOTS is a shots.json (list of {name, loc, aim, lens}), a directory holding
one, or a .py file with a literal `SHOTS = [(name, loc, aim, lens, ...), ...]`.

The scene config (JSON, kept with the set, not in the repository):

    {
      "module_path": ".",                     # relative to the config file
      "build": [["module", "function", {kwargs}], ...],   # builds the set
      "resolution": [1376, 768], "sensor": 36.0,
      "pans": {"pan": {"eye": [..], "aim_a": [..], "aim_b": [..],
                       "frames": 175, "lens": 20.0}},
      "plates": {"name": {"eye": [..], "aim": [..], "lens": 20.0}
                 | {"pan": "pan", "frame": 63}},
      "strip_prefixes": {"name": ["Hall"]},   # objects a plate's photo does not show
      "pan_strip_prefixes": ["Hall"],         # same, for ad-hoc "<pan>:<frame>" plates
      "skip_prefixes": ["M_", ...],           # figures, prompt-owned props, helpers
      "exclude_under": "Pivot"                # drop objects parented under this empty
    }

strip_prefixes exists because a plate's camera can geometrically see what its
photograph does not (a room behind a shut door); counting it as covered lets
the model invent it differently every render. exclude_under exists because the
projection has no occlusion test.
"""

import ast
import importlib
import json
import math
import os
import pathlib
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scene_config  # noqa: E402

arg = scene_config.make_arg(scene_config.script_args())
CFG = scene_config.load(arg("--scene"))
sys.path.insert(0, os.path.normpath(os.path.join(CFG["_dir"], CFG.get("module_path", "."))))

SHOTS_SRC = arg("--shots")
LABEL = arg("--label", pathlib.Path(SHOTS_SRC).stem if SHOTS_SRC else "shots")
PLATES = [p.strip() for p in arg("--plates", "").split(",") if p.strip()]
MIN_AREA = float(arg("--min-area", "0.005"))
OUT_JSON = arg("--json")
SENSOR = float(CFG.get("sensor", 36.0))
PANS = CFG.get("pans", {})


def pan_aim(pan, i):
    eye = Vector(pan["eye"])

    def ang(t):
        d = Vector(t) - eye
        return math.atan2(d.y, d.x), math.atan2(d.z, math.hypot(d.x, d.y))
    (y0, p0), (y1, p1) = ang(pan["aim_a"]), ang(pan["aim_b"])
    while y1 > y0:
        y1 -= 2 * math.pi
    t = i / (pan["frames"] - 1)
    e = t * t * (3 - 2 * t)
    yaw, pitch = y0 + (y1 - y0) * e, p0 + (p1 - p0) * e
    return eye + Vector((math.cos(yaw) * math.cos(pitch),
                         math.sin(yaw) * math.cos(pitch),
                         math.sin(pitch)))


def plate_camera(name):
    if ":" in name and name.split(":", 1)[0] in PANS:
        pan_name, frame = name.split(":", 1)
        pan = PANS[pan_name]
        return Vector(pan["eye"]), pan_aim(pan, int(frame)), float(pan["lens"])
    spec = CFG.get("plates", {}).get(name)
    if spec is None:
        return None
    if "pan" in spec:
        pan = PANS[spec["pan"]]
        return Vector(pan["eye"]), pan_aim(pan, int(spec["frame"])), float(spec.get("lens", pan["lens"]))
    return tuple(spec["eye"]), tuple(spec["aim"]), float(spec["lens"])


def load_shots(src):
    if not src:
        raise SystemExit("--shots is required")
    path = pathlib.Path(src)
    if path.is_dir():
        path = path / "shots.json"
    if path.suffix == ".py":
        text = path.read_text(encoding="utf-8")
        body = text[text.index("SHOTS = ["):]
        body = body[:body.index(chr(10) + "]") + 2]
        table = ast.literal_eval(body[len("SHOTS = "):])
        return [(n, loc, aim, lens) for n, loc, aim, lens, *_ in table]
    table = json.loads(path.read_text(encoding="utf-8"))
    return [(t["name"], tuple(t["loc"]), tuple(t["aim"]), float(t["lens"])) for t in table]


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.resolution_x, scene.render.resolution_y = CFG.get("resolution", (1376, 768))
for module, function, kwargs in CFG.get("build", ()):
    getattr(importlib.import_module(module), function)(**kwargs)
ASPECT = scene.render.resolution_x / scene.render.resolution_y
SKIP_PREFIXES = tuple(CFG.get("skip_prefixes", ()))
EXCLUDE_UNDER = CFG.get("exclude_under")


def _under(o, name):
    while o is not None:
        if o.name == name:
            return True
        o = o.parent
    return False


OBJECTS = [o for o in scene.objects
           if o.type == "MESH" and not (SKIP_PREFIXES and o.name.startswith(SKIP_PREFIXES))
           and not (EXCLUDE_UNDER and _under(o, EXCLUDE_UNDER))]


def basis(eye, aim):
    f = (Vector(aim) - Vector(eye)).normalized()
    r = f.cross(Vector((0, 0, 1)))
    r = r.normalized() if r.length > 1e-6 else Vector((1, 0, 0))
    return f, r, r.cross(f).normalized()


def area_of(obj, eye, f, r, u, lens):
    tx = (SENSOR / 2) / lens
    ty = tx / ASPECT
    xs, ys = [], []
    for corner in obj.bound_box:
        p = obj.matrix_world @ Vector(corner) - eye
        d = p.dot(f)
        if d <= 0.05:
            return 0.0
        xs.append(p.dot(r) / d / tx)
        ys.append(p.dot(u) / d / ty)
    x0, x1 = max(-1.0, min(xs)), min(1.0, max(xs))
    y0, y1 = max(-1.0, min(ys)), min(1.0, max(ys))
    if x1 <= x0 or y1 <= y0:
        return 0.0
    return (x1 - x0) * (y1 - y0) / 4.0


def areas(eye, aim, lens):
    f, r, u = basis(eye, aim)
    eye = Vector(eye)
    return {o.name: a for o in OBJECTS if (a := area_of(o, eye, f, r, u, lens)) > 1e-5}


cameras = {p: plate_camera(p) for p in PLATES}
unknown = [p for p, c in cameras.items() if c is None]
if unknown:
    raise SystemExit(f"no camera known for plate(s) {unknown}; add them to the scene config")
plate_areas = {p: areas(*cameras[p]) for p in PLATES}
STRIP = CFG.get("strip_prefixes", {})
PAN_STRIP = tuple(CFG.get("pan_strip_prefixes", ()))
for p, pa in plate_areas.items():
    is_pan = ":" in p and p.split(":", 1)[0] in PANS
    prefixes = PAN_STRIP if is_pan else tuple(STRIP.get(p, ()))
    if prefixes:
        for k in [k for k in pa if k.startswith(prefixes)]:
            del pa[k]
best_plate = {}
for p, pa in plate_areas.items():
    for k, v in pa.items():
        best_plate[k] = max(best_plate.get(k, 0.0), v)

report = []
print(f"{LABEL}  plates: {', '.join(PLATES)}")
print(f"{'shot':<14} {'seen':>6}  uncovered (>{MIN_AREA:.1%} of frame, in no plate)")
for name, loc, aim, lens in load_shots(SHOTS_SRC):
    want = areas(Vector(loc), Vector(aim), lens)
    total = sum(want.values())
    if total <= 0:
        print(f"{name:<14}      --  sees no set object")
        continue
    cover = sum(min(v, best_plate.get(k, 0.0)) for k, v in want.items()) / total
    # "seen" is the gate: how much of the shot's frame is made of objects that
    # appear in some plate at any size. The size-weighted "cover" stays in the
    # JSON only -- a prop that matters gets its own reference image instead of
    # a bigger plate.
    seen = sum(v for k, v in want.items() if best_plate.get(k, 0.0) > 1e-5) / total
    missing = sorted(((k, v) for k, v in want.items()
                      if v >= MIN_AREA and best_plate.get(k, 0.0) <= 1e-5),
                     key=lambda kv: -kv[1])
    # Weak: seen by a plate, but far smaller there than in the shot (texture
    # will be guessed at the shot's scale).
    weak = sorted(((k, v, best_plate.get(k, 0.0)) for k, v in want.items()
                   if v >= MIN_AREA and 1e-5 < best_plate.get(k, 0.0) < v * 0.15),
                  key=lambda t: -t[1])
    miss_txt = ", ".join(f"{k} {v:.1%}" for k, v in missing) or "-"
    print(f"{name:<14} {seen:>6.1%}  {miss_txt}")
    if weak:
        print(f"{'':<14}         weak: " + ", ".join(f"{k} {v:.1%} (plate {b:.1%})" for k, v, b in weak))
    report.append({"shot": name, "seen": seen, "scale_cover": cover,
                   "missing": [{"object": k, "area": v} for k, v in missing],
                   "weak": [{"object": k, "area": v, "plate": b} for k, v, b in weak]})

if OUT_JSON:
    pathlib.Path(OUT_JSON).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {OUT_JSON}")
print("PLATE_COVERAGE_DONE")
