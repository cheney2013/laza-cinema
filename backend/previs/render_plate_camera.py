"""Render the grey anchor for a plate camera that is never shot from.

A shot has two cameras: the shot's own, and a plate camera placed wherever
covers the most of what the shot sees.  This renders the plate camera's view so
the plate can be generated against it.

    blender --background --factory-startup <set.blend> \
        --python backend/previs/render_plate_camera.py -- \
        --scene <scene.json> --at X,Y,Z --yaw DEG [--pitch DEG] [--lens 18] \
        --out DIR/name.png

The scene config supplies "sensor" (mm, default 36) and "set_edits"
(see scene_config.py).
"""

import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scene_config  # noqa: E402

arg = scene_config.make_arg(scene_config.script_args())
CFG = scene_config.load(arg("--scene"))

AT = Vector(scene_config.vec3(arg("--at")))
YAW = math.radians(float(arg("--yaw", "0")))
PITCH = float(arg("--pitch", "0"))          # degrees looking down
LENS = float(arg("--lens", "18"))
OUT = os.path.abspath(arg("--out", "plate_camera.png"))

scene = bpy.context.scene
scene_config.apply_set_edits(scene, CFG)

# Glass: window meshes often model the panes as opaque faces, which the grey
# render shows as blank walls. The config can name those meshes under
# "glass_objects"; every face larger than "glass_min_area" m^2 in them is
# deleted so the view through the window reaches whatever is modelled outside.
if CFG.get("glass_objects"):
    import bmesh
    min_area = float(CFG.get("glass_min_area", 0.2))
    for name in CFG["glass_objects"]:
        obj = bpy.data.objects.get(name)
        if obj is None or obj.type != "MESH":
            continue
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        k = obj.matrix_world.to_scale()
        s2 = abs(k.x * k.y * k.z) ** (2.0 / 3.0)
        big = [f for f in bm.faces if f.calc_area() * s2 > min_area]
        bmesh.ops.delete(bm, geom=big, context="FACES")
        bm.to_mesh(obj.data)
        bm.free()
        print("glass: cleared", len(big), "faces in", name)

# Cull: some imported meshes merge the house with the whole neighbourhood, whose
# low-poly blocks read through a window as roofs. "cull_outside" names such
# meshes with a "keep" box [[x0,x1],[y0,y1],[z0,z1]]; every face whose centre
# falls outside the box is deleted -- only within "radius" metres of the box
# centre when one is given, so the distant skyline stays.
for entry in CFG.get("cull_outside", []):
    import bmesh
    obj = bpy.data.objects.get(entry["object"])
    if obj is None or obj.type != "MESH":
        continue
    (x0, x1), (y0, y1), (z0, z1) = entry["keep"]
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    mw = obj.matrix_world
    mid = Vector(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    radius = float(entry.get("radius", 1e9))
    out = []
    for f in bm.faces:
        c = mw @ f.calc_center_median()
        inside = x0 <= c.x <= x1 and y0 <= c.y <= y1 and z0 <= c.z <= z1
        if not inside and (c - mid).length < radius:
            out.append(f)
    bmesh.ops.delete(bm, geom=out, context="FACES")
    bm.to_mesh(obj.data)
    bm.free()
    print("cull: removed", len(out), "faces from", entry["object"])

scene.render.resolution_x, scene.render.resolution_y = 1376, 768
scene_config.workbench_grey(scene, ridge=1.0)

cd = bpy.data.cameras.new("plate")
cd.sensor_width = float(CFG.get("sensor", 36.0))
cd.lens = LENS
cd.clip_start, cd.clip_end = 0.05, 300.0
cam = bpy.data.objects.new("plate", cd)
scene.collection.objects.link(cam)
scene.camera = cam
cam.location = AT
cam.rotation_euler = (math.radians(90.0 - PITCH), 0.0, YAW)

os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("wrote", OUT)
