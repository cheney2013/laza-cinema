"""Render a textured view of the delivered house from a given camera.

render_plate_camera.py makes the flat grey anchor. A set that carries its own
packed textures can use the textured model as the anchor instead of clay. This renders the scene's own materials with
EEVEE under a soft world light so every surface reads.

    blender --background --factory-startup <house.blend> \
        --python backend/previs/render_textured_camera.py -- \
        --at 15.60,30.30,6.45 --look 17.20,31.20,6.40 --lens 35 --out DIR/name.png
"""

import os
import sys

import bpy
from mathutils import Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    return ARGS[ARGS.index(name) + 1] if name in ARGS else default


AT = Vector([float(v) for v in arg("--at").split(",")])
LOOK = Vector([float(v) for v in arg("--look").split(",")])
LENS = float(arg("--lens", "35"))
OUT = os.path.abspath(arg("--out", "textured_camera.png"))
WORLD = float(arg("--world", "1.0"))

scene = bpy.context.scene
for coll in bpy.data.collections:
    if coll.name.startswith("90"):
        for o in coll.objects:
            o.hide_render = True

cam_data = bpy.data.cameras.new("TexturedProbe")
cam_data.lens = LENS
cam_data.sensor_width = 36.0
cam_data.clip_start = 0.02
cam = bpy.data.objects.new("TexturedProbe", cam_data)
scene.collection.objects.link(cam)
cam.location = AT
cam.rotation_euler = (AT - LOOK).to_track_quat("Z", "Y").to_euler()
scene.camera = cam

world = scene.world or bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg:
    bg.inputs[0].default_value = (1.0, 1.0, 1.0, 1.0)
    bg.inputs[1].default_value = WORLD

for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        continue
scene.render.resolution_x = 1376
scene.render.resolution_y = 768
scene.render.resolution_percentage = 100
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("wrote", OUT)
