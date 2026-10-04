"""Shared pieces of the previs render tools: the scene config and set edits.

The render tools (render_plate_camera.py, render_camera_move.py,
plate_coverage.py) know nothing about any particular film.  Everything that
belongs to a set -- camera positions, figure blocks, which window gets glass,
which objects to hide -- comes from a JSON scene config passed with --scene.
Those configs are content and live beside the set, outside the repository.

Set edits (all optional):

    "set_edits": {
        "hide_collection_prefixes": ["90"],
        "hide_mesh_regex": "bark|canopy|tree",
        "glaze": [{"object": "window_mesh", "opening": [[x0,x1],[y0,y1],[z0,z1]],
                   "name": "WindowGlass", "color": [0.72,0.80,0.88,0.14]}]
    }
"""

import json
import os
import re
import sys


def script_args():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def make_arg(args):
    def arg(name, default=None):
        return args[args.index(name) + 1] if name in args else default
    return arg


def load(path):
    if not path:
        raise SystemExit("--scene <config.json> is required")
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    cfg["_dir"] = os.path.dirname(os.path.abspath(path))
    return cfg


def vec3(text):
    return [float(v) for v in text.split(",")]


def _inside(v, opening):
    (x0, x1), (y0, y1), (z0, z1) = opening
    return x0 <= v.x <= x1 and y0 <= v.y <= y1 and z0 <= v.z <= z1


def glaze(scene, spec):
    """Split the faces of spec['object'] inside the opening into a tinted pane."""
    import bmesh
    import bpy

    src = bpy.data.objects.get(spec["object"])
    if src is None:
        return
    opening = spec["opening"]
    name = spec.get("name", "WindowGlass")
    mw = src.matrix_world
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bm.from_mesh(src.data)
    keep = {f for f in bm.faces if any(_inside(mw @ v.co, opening) for v in f.verts)}
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f not in keep], context="FACES")
    bm.to_mesh(me)
    bm.free()
    glass = bpy.data.objects.new(name, me)
    glass.matrix_world = mw.copy()
    glass.color = tuple(spec.get("color", (0.72, 0.80, 0.88, 0.14)))
    scene.collection.objects.link(glass)
    bm2 = bmesh.new()
    bm2.from_mesh(src.data)
    bmesh.ops.delete(
        bm2, geom=[f for f in bm2.faces
                   if any(_inside(mw @ v.co, opening) for v in f.verts)],
        context="FACES")
    bm2.to_mesh(src.data)
    bm2.free()


def apply_set_edits(scene, cfg):
    import bpy

    edits = cfg.get("set_edits", {})
    prefixes = tuple(edits.get("hide_collection_prefixes", ()))
    if prefixes:
        for coll in bpy.data.collections:
            if coll.name.startswith(prefixes):
                for o in coll.objects:
                    o.hide_render = True
    for spec in edits.get("glaze", ()):
        glaze(scene, spec)
    pattern = edits.get("hide_mesh_regex")
    if pattern:
        rx = re.compile(pattern, re.I)
        for o in bpy.data.objects:
            if o.type == "MESH" and rx.search(o.name):
                o.hide_render = True


def workbench_grey(scene, ridge=None):
    """The flat grey anchor look: studio light, object colour, cavity, outline."""
    scene.render.engine = "BLENDER_WORKBENCH"
    sh = scene.display.shading
    sh.light, sh.color_type = "STUDIO", "OBJECT"
    sh.show_cavity, sh.cavity_type = True, "BOTH"
    if ridge is not None:
        sh.curvature_ridge_factor = sh.curvature_valley_factor = ridge
    sh.show_object_outline = True
    sh.object_outline_color = (0.08, 0.08, 0.08)


def ease(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)
