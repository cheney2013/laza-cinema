"""Compose previs stills into one 1376x768 storyboard sheet.

H3 reads a single sheet better than a stack of separate reference images: the
panel order carries the shot order, and it costs one reference slot instead of
five. Layout is 3 across the top and the rest below for five panels, 2+2 for four,
panels boxed
in white on a near-black backing, which is what segments 1-4 used.

    python make_sheet.py OUT.png panel1.png panel2.png ...
"""

import sys

from PIL import Image

W, H = 1376, 768
MARGIN, GAP, BORDER = 18, 14, 3
BACKING = (16, 16, 18)
FRAME = (238, 238, 238)


def row(images, box):
    """Fit `images` side by side inside (x, y, w, h), keeping aspect."""
    x, y, w, h = box
    n = len(images)
    cell_w = (w - GAP * (n - 1)) / n
    scale = min(cell_w / images[0].width, h / images[0].height)
    pw, ph = int(images[0].width * scale), int(images[0].height * scale)
    total = pw * n + GAP * (n - 1)
    ox = x + (w - total) / 2
    oy = y + (h - ph) / 2
    return [(im.resize((pw, ph), Image.LANCZOS), (int(ox + i * (pw + GAP)), int(oy)))
            for i, im in enumerate(images)]


def main(out, paths):
    panels = [Image.open(p).convert("RGB") for p in paths]
    # Split as evenly as the count allows: 5 goes 3+2, 4 goes 2+2. A 3+1 sheet
    # gives the lone panel a different scale from the rest, which reads as a
    # different lens rather than a different shot.
    per_row = 3 if len(panels) > 4 else (len(panels) + 1) // 2
    top, bottom = panels[:per_row], panels[per_row:]
    sheet = Image.new("RGB", (W, H), BACKING)
    inner_h = (H - 2 * MARGIN - GAP) / 2
    placed = row(top, (MARGIN, MARGIN, W - 2 * MARGIN, inner_h))
    if bottom:
        placed += row(bottom, (MARGIN, MARGIN + inner_h + GAP, W - 2 * MARGIN, inner_h))
    for im, (x, y) in placed:
        box = Image.new("RGB", (im.width + 2 * BORDER, im.height + 2 * BORDER), FRAME)
        box.paste(im, (BORDER, BORDER))
        sheet.paste(box, (x - BORDER, y - BORDER))
    sheet.save(out)
    print(f"{out}  {len(panels)} panels")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
