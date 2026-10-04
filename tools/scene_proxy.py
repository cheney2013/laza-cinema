#!/usr/bin/env python
"""
Render simple geometric scene proxies to steer FLUX.2 structure.

Prose is unreliable for geometry. "A sash window propped open a few inches" produced an
incoherent floating diagonal pane; rewritten as a vertical sash it produced a clean window
with no visible opening at all. Neither wording puts the gap where the story needs it.

A crude grey render of the geometry does, because it is fed to FLUX.2 as a reference latent
rather than as words. It does not need to be pretty — flat blocks in the right places are
enough to fix layout, and the prompt supplies material, light and detail.

    python tools/scene_proxy.py sash-window out.png --gap 0.14 --width 1280 --height 720

Wire the result into a shot with `"depth_ref": "proxies/out.png"`.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

# Mid-grey reads as "no strong opinion" to the reference latent; the shapes carry the signal.
WALL, FRAME, GLASS, GAP, SILL = 96, 210, 140, 28, 190


def sash_window(w: int, h: int, gap: float, sill: float = 0.22) -> Image.Image:
    """
    A vertical sash window whose lower pane is raised, leaving a dark gap above the sill.

    `gap` is the opening height as a fraction of the image — the one measurement the prompt
    could never pin down. Dark = far/through, light = near/solid.
    """
    img = Image.new("L", (w, h), WALL)
    d = ImageDraw.Draw(img)

    m = int(w * 0.10)                       # outer margin
    sill_y = int(h * (1.0 - sill))          # top of the sill slab
    gap_h = int(h * gap)
    gap_top = sill_y - gap_h                # opening sits directly on the sill

    # Window reveal / outer frame
    d.rectangle([m, int(h * 0.05), w - m, sill_y], fill=FRAME)

    # Glazed area above the opening
    gx0, gx1 = m + int(w * 0.035), w - m - int(w * 0.035)
    gy0, gy1 = int(h * 0.085), gap_top
    if gy1 > gy0:
        d.rectangle([gx0, gy0, gx1, gy1], fill=GLASS)
        # Mullions — two columns, one transom. Gives the model something square to lock onto.
        bar = max(3, w // 190)
        for f in (1 / 3, 2 / 3):
            x = int(gx0 + (gx1 - gx0) * f)
            d.rectangle([x - bar, gy0, x + bar, gy1], fill=FRAME)
        ty = int(gy0 + (gy1 - gy0) * 0.5)
        d.rectangle([gx0, ty - bar, gx1, ty + bar], fill=FRAME)
        # Bottom rail of the raised sash — the edge the cat squeezes under
        d.rectangle([gx0, gy1 - int(h * 0.035), gx1, gy1], fill=FRAME)

    # The opening itself: dark, because you see straight through it
    d.rectangle([gx0, gap_top, gx1, sill_y], fill=GAP)

    # Sill slab
    d.rectangle([int(m * 0.55), sill_y, w - int(m * 0.55), int(sill_y + h * 0.075)], fill=SILL)

    # Soften so it reads as structure rather than hard graphics
    return img.filter(ImageFilter.GaussianBlur(radius=max(1, w // 400))).convert("RGB")


BUILDERS = {"sash-window": sash_window}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("kind", choices=sorted(BUILDERS))
    ap.add_argument("out", type=Path)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--gap", type=float, default=0.14,
                    help="opening height as a fraction of image height")
    args = ap.parse_args()

    img = BUILDERS[args.kind](args.width, args.height, args.gap)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    img.save(args.out)
    print(f"wrote {args.out} ({args.width}x{args.height}, gap={args.gap})")


if __name__ == "__main__":
    main()
