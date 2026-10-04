"""NLF 3D pose nodes, lifted from kijai's ComfyUI-WanVideoWrapper (MTV/nodes.py).

Only `DownloadAndLoadNLFModel` and `NLFPredict` are carried over. `RenderNLFPoses`
(ComfyUI-SCAIL-Pose) requires an NLFPRED input and a 2D skeleton cannot supply it: 2D
keypoints do not separate front from back, so a back-turned shot comes out facing camera.
Copying the whole 112MB wrapper into this H3-only install would register several hundred
unrelated nodes; these two classes touch nothing else in that package, so they are all
that is taken.
"""
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
