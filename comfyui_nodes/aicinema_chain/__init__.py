"""LAZA CINEMA STUDIO: fixes for MiniMax H3 motion-context chains.

  AicinemaSeamMatch   takes the colour / brightness bias and the texture a seam adds back out
                      of the new clip, measured on the overlap it regenerates

See seam_match.py for what was measured and how to wire it.
"""
from .seam_match import AicinemaSeamMatch

NODE_CLASS_MAPPINGS = {"AicinemaSeamMatch": AicinemaSeamMatch}
NODE_DISPLAY_NAME_MAPPINGS = {"AicinemaSeamMatch": "H3 Seam Colour Match (LAZA)"}
