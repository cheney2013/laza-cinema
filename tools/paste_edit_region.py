"""Paste only what an image edit changed back into the full-size original.

A Qwen edit of a crop is the way to get sharp small text on a big picture: the editor works at about
one megapixel, so a 2752x1536 frame comes back at half size, but a crop of the part that needs the
change comes back close to its own pixels. What the editor hands back is the whole crop, slightly
resampled, and its "unchanged" pixels are not quite the originals. This pastes back only the pixels
that really changed (the new text, say) with a soft edge, and leaves every other pixel of the
original exactly as it was.

    python tools/paste_edit_region.py --source full.png --edited edited_crop.png \
        --crop 0 0 840 1440 --search 0 1150 840 1440 --out result.png

--crop      the box of --source (x0 y0 x1 y1) that was cut out and given to the editor.
--search    where, inside the crop (crop coordinates), a change is expected. Everything outside is
            ignored, so a colour drift elsewhere in the crop never reaches the result. Default: all.
--threshold how far a pixel (0-255, largest channel) must differ from the original crop to count.
--pad       pixels the pasted area is grown by around the changed pixels, so the new letters' soft
            edges and their shadow come with them.
--feather   blur of the paste mask in pixels.
--shift     move the pasted content by DX DY pixels (down is positive DY) as it goes in: a way to
            correct where the editor put new text (a gap too tight, a line too far left) without
            asking the editor again. The background it leaves behind is the original's.

The edited image is resized to the crop's size first (it may come back at another size). Prints the
changed box, the share of the full image replaced, and checks that no pixel outside the pasted box
differs from the original.
"""
from __future__ import annotations

import argparse
import sys

import numpy as np
from PIL import Image
from scipy import ndimage


def changed_mask(original_crop: np.ndarray, edited_crop: np.ndarray, search: tuple[int, int, int, int],
                 threshold: int) -> np.ndarray:
    """Boolean mask (crop size) of pixels inside `search` whose largest channel differs by more than `threshold`."""
    diff = np.abs(original_crop.astype(np.int16) - edited_crop.astype(np.int16)).max(axis=2)
    mask = diff > threshold
    keep = np.zeros_like(mask)
    x0, y0, x1, y1 = search
    keep[y0:y1, x0:x1] = True
    return mask & keep


def shifted(a: np.ndarray, dx: int, dy: int) -> np.ndarray:
    """`a` moved right by dx and down by dy, zero-filled, same shape (works for 2-D masks and 3-D images)."""
    out = np.zeros_like(a)
    h, w = a.shape[:2]
    src_y0, src_y1 = max(0, -dy), min(h, h - dy)
    src_x0, src_x1 = max(0, -dx), min(w, w - dx)
    if src_y1 > src_y0 and src_x1 > src_x0:
        out[src_y0 + dy:src_y1 + dy, src_x0 + dx:src_x1 + dx] = a[src_y0:src_y1, src_x0:src_x1]
    return out


def paste_back(source: Image.Image, edited: Image.Image, crop: tuple[int, int, int, int],
               search: tuple[int, int, int, int] | None = None, threshold: int = 40, pad: int = 12,
               feather: float = 4.0, shift: tuple[int, int] = (0, 0)) -> tuple[Image.Image, dict]:
    """The source with the edit's changed pixels pasted in, and a report of what was done."""
    src = source.convert("RGB")
    x0, y0, x1, y1 = crop
    if not (0 <= x0 < x1 <= src.width and 0 <= y0 < y1 <= src.height):
        raise ValueError(f"crop {crop} is outside the {src.width}x{src.height} source")
    w, h = x1 - x0, y1 - y0
    original_crop = np.asarray(src.crop(crop))
    edited_crop = np.asarray(edited.convert("RGB").resize((w, h), Image.LANCZOS))
    search = search or (0, 0, w, h)

    mask = changed_mask(original_crop, edited_crop, search, threshold)
    # Specks are not content: a letter is a connected mass of changed pixels, so lone ones go.
    mask = ndimage.binary_opening(mask, iterations=1)
    count = int(mask.sum())
    if count == 0:
        raise ValueError("nothing in the search area differs from the original; nothing to paste")

    grown = ndimage.binary_dilation(mask, iterations=max(0, pad))
    alpha = ndimage.gaussian_filter(grown.astype(np.float32), sigma=max(0.01, feather))
    alpha = np.clip(alpha * 1.0, 0.0, 1.0)
    alpha[~ndimage.binary_dilation(grown, iterations=int(3 * feather) + 1)] = 0.0   # nothing leaks far from the text

    dx, dy = shift
    if dx or dy:
        # What is pasted is the edited pixels under the mask, moved; nothing outside the crop is touched.
        alpha = shifted(alpha, dx, dy)
        edited_crop = shifted(edited_crop, dx, dy)

    out = np.asarray(src).copy()
    region = out[y0:y1, x0:x1].astype(np.float32)
    blended = region * (1 - alpha[..., None]) + edited_crop.astype(np.float32) * alpha[..., None]
    out[y0:y1, x0:x1] = np.clip(np.rint(blended), 0, 255).astype(np.uint8)

    touched = np.argwhere(alpha > 0)
    by0, bx0 = touched.min(axis=0)
    by1, bx1 = touched.max(axis=0) + 1
    box = (x0 + int(bx0), y0 + int(by0), x0 + int(bx1), y0 + int(by1))

    # Everything outside the pasted box must be the original, bit for bit.
    before, after = np.asarray(src), out
    outside = np.ones(before.shape[:2], bool)
    outside[box[1]:box[3], box[0]:box[2]] = False
    outside_changed = int((before != after).any(axis=2)[outside].sum())
    report = {
        "changed_pixels": count,
        "pasted_box": box,
        "share_of_image_replaced": float((before != after).any(axis=2).mean()),
        "pixels_changed_outside_box": outside_changed,
    }
    return Image.fromarray(out), report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", required=True)
    ap.add_argument("--edited", required=True)
    ap.add_argument("--crop", nargs=4, type=int, required=True, metavar=("X0", "Y0", "X1", "Y1"))
    ap.add_argument("--search", nargs=4, type=int, default=None, metavar=("X0", "Y0", "X1", "Y1"))
    ap.add_argument("--threshold", type=int, default=40)
    ap.add_argument("--pad", type=int, default=12)
    ap.add_argument("--feather", type=float, default=4.0)
    ap.add_argument("--shift", nargs=2, type=int, default=(0, 0), metavar=("DX", "DY"))
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    result, report = paste_back(Image.open(args.source), Image.open(args.edited), tuple(args.crop),
                                tuple(args.search) if args.search else None, args.threshold, args.pad, args.feather, tuple(args.shift))
    result.save(args.out)
    print(f"changed pixels: {report['changed_pixels']}")
    print(f"pasted box: {report['pasted_box']}")
    print(f"share of the image replaced: {100 * report['share_of_image_replaced']:.3f}%")
    print(f"pixels changed outside the box: {report['pixels_changed_outside_box']}")
    print(f"wrote {args.out}")
    return 0 if report["pixels_changed_outside_box"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
