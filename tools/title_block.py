"""A title block with fixed margins, built from a clean logo asset and one line of real text.

The cover plate is expected to be clean (no title baked into it). The block is a transparent image as tall as the cover (1536 by default) with the logo at the top and
one small line at the bottom, both inset by the same margin on all four sides, so it can be set on
the left edge or the right edge of a cover and the spacing is the same either way. Changing the small
line is then a rerun of `build`, and `place` lays the block onto the cover plate. No image editor is
involved, so size, gap and position never drift.

    # each time the line changes
    python tools/title_block.py build --logo logo.png --line "FILM 1【中字】" --out block.png
    python tools/title_block.py place --plate plate_clean.png --block block.png --side left --out cover_new.png

Layout of the block (all in pixels of its own height H):
    margin M on every side; the logo is `content-width` wide, anchored to the top margin;
    the line is `line-width` wide (default: as wide as the logo; wider makes the text bigger),
    anchored to the bottom margin; the gap between them is whatever is left (build refuses a gap
    under --min-gap). block width = max(content-width, line-width) + 2 * M.
    --line-height-scale stretches the line vertically without changing its width (taller text).
"""
from __future__ import annotations

import argparse
import re
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

WIN_FONTS = "C:/Windows/Fonts/"
DEFAULT_LATIN = WIN_FONTS + "impact.ttf"
DEFAULT_CJK = WIN_FONTS + "NotoSansSC-VF.ttf"

_CJK = re.compile(r"[\u3000-\u9fff\uff00-\uffef]")


# ── text ─────────────────────────────────────────────────────────────────────────

def _runs(text: str) -> list[tuple[str, bool]]:
    """Split into (text, is_cjk) runs."""
    runs: list[tuple[str, bool]] = []
    for ch in text:
        cjk = bool(_CJK.match(ch))
        if runs and runs[-1][1] == cjk:
            runs[-1] = (runs[-1][0] + ch, cjk)
        else:
            runs.append((ch, cjk))
    return runs


def _font(path: str, size: int, weight: int | None = None) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(path, size)
    if weight is not None:
        try:
            font.set_variation_by_axes([weight])
        except Exception:  # a static font has no weight axis
            pass
    return font


def render_line(text: str, width: int, latin_font: str = DEFAULT_LATIN, cjk_font: str = DEFAULT_CJK,
                cjk_scale: float = 0.9, tracking: float = 0.05, cjk_weight: int = 900,
                height_scale: float = 1.0) -> Image.Image:
    """`text` white on transparent, exactly `width` wide, trimmed to its ink.

    `height_scale` stretches the finished line vertically (1.4 = 40% taller, same width): the way to a
    taller line when the width is fixed, at the cost of the letters becoming narrower in proportion.

    Runs (Latin / CJK) are in their own font, scaled together, and set so the vertical CENTRE OF EACH
    RUN'S INK is on one line. Aligning by the fonts' own origin looks wrong: capitals and square
    characters have different heights, so one run sits high or low next to the other.
    """
    runs = _runs(text)

    def measure(size: int):
        parts, total = [], 0.0
        for chunk, cjk in runs:
            font = _font(cjk_font, max(1, round(size * cjk_scale)), cjk_weight) if cjk else _font(latin_font, size)
            parts.append((chunk, font))
            total += sum(font.getlength(ch) + tracking * size for ch in chunk)
        return total, parts

    lo, hi = 8, 800
    while lo < hi:                                    # the largest size whose line still fits the width
        mid = (lo + hi + 1) // 2
        if measure(mid)[0] <= width:
            lo = mid
        else:
            hi = mid - 1
    total, parts = measure(lo)
    height = round(lo * 2.0)
    centre = height / 2
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    x = (width - total) / 2
    for chunk, font in parts:
        left, top, right, bottom = font.getbbox(chunk, anchor="ls")   # ink box relative to the baseline
        baseline = centre - (top + bottom) / 2                         # puts the ink's centre on `centre`
        for ch in chunk:
            draw.text((x, baseline), ch, font=font, fill=(246, 246, 246, 255), anchor="ls")
            x += font.getlength(ch) + tracking * lo
    ys, xs = np.where(np.asarray(canvas)[..., 3] > 8)
    line = canvas.crop((0, int(ys.min()), width, int(ys.max()) + 1))
    if height_scale != 1.0:
        line = line.resize((line.width, max(1, round(line.height * height_scale))), Image.LANCZOS)
    return line


def distress_line(line: Image.Image, amount: float = 0.03, seed: int = 7) -> Image.Image:
    """A little speckle taken out of the letters so a flat line sits beside a worn logo."""
    arr = np.asarray(line).astype(np.float32)
    if amount > 0:
        rng = np.random.default_rng(seed)
        noise = ndimage.gaussian_filter(rng.random(arr.shape[:2]).astype(np.float32), 0.8)
        arr[..., 3] *= np.where(noise > np.quantile(noise, 1 - amount), 0.35, 1.0)
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


# ── build / place ──────────────────────────────────────────────────────────────────

def build_block(logo: Image.Image, line: str, height: int = 1536, margin: int = 104, content_width: int = 620,
                latin_font: str = DEFAULT_LATIN, cjk_font: str = DEFAULT_CJK, distress: float = 0.03,
                min_gap: int = 32, line_width: int | None = None, line_height_scale: float = 1.0) -> tuple[Image.Image, dict]:
    """The block: transparent, `height` tall, `max(content_width, line_width) + 2 * margin` wide.

    The logo is `content_width` wide; the line is `line_width` wide (default: the logo's width). A wider
    line is a taller line: that is how the small text is made bigger. Both start at the left margin.
    Returns the block and the layout used."""
    line_width = line_width or content_width
    inner = max(content_width, line_width)
    logo_rgba = logo.convert("RGBA")
    logo_h = round(content_width * logo_rgba.height / logo_rgba.width)
    logo_img = logo_rgba.resize((content_width, logo_h), Image.LANCZOS)
    block = Image.new("RGBA", (inner + 2 * margin, height), (0, 0, 0, 0))
    block.alpha_composite(logo_img, (margin, margin))
    layout = {"width": block.width, "height": height, "margin": margin, "logo_box": (margin, margin, margin + content_width, margin + logo_h)}
    if line:
        text = distress_line(render_line(line, line_width, latin_font, cjk_font, height_scale=line_height_scale), distress)
        top = height - margin - text.height
        gap = top - (margin + logo_h)
        if gap < min_gap:
            raise ValueError(f"the line does not fit under the logo: gap {gap}px < {min_gap}px "
                             f"(lower content_width/margin or shorten the line)")
        block.alpha_composite(text, (margin, top))
        layout.update(line_box=(margin, top, margin + line_width, top + text.height), gap=gap)
    return block, layout


def place_block(plate: Image.Image, block: Image.Image, side: str = "left") -> Image.Image:
    """The block on the plate's left or right edge, full height (scaled to the plate's height if it differs)."""
    if side not in ("left", "right"):
        raise ValueError("side must be 'left' or 'right'")
    base = plate.convert("RGBA")
    if block.height != base.height:
        scale = base.height / block.height
        block = block.resize((round(block.width * scale), base.height), Image.LANCZOS)
    x = 0 if side == "left" else base.width - block.width
    base.alpha_composite(block, (x, 0))
    return base.convert("RGB")


# ── command line ───────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="build the title block (transparent PNG)")
    b.add_argument("--logo", required=True)
    b.add_argument("--line", default="")
    b.add_argument("--height", type=int, default=1536)
    b.add_argument("--margin", type=int, default=104)
    b.add_argument("--content-width", type=int, default=620, help="width of the logo")
    b.add_argument("--line-width", type=int, default=None, help="width of the small line (default: the logo's); wider = bigger text")
    b.add_argument("--latin-font", default=DEFAULT_LATIN)
    b.add_argument("--cjk-font", default=DEFAULT_CJK)
    b.add_argument("--line-height-scale", type=float, default=1.0,
                   help="stretch the small line vertically (1.4 = 40%% taller, same width)")
    b.add_argument("--distress", type=float, default=0.03)
    b.add_argument("--min-gap", type=int, default=32)
    b.add_argument("--out", required=True)

    p = sub.add_parser("place", help="set the block on the left or right edge of a plate")
    p.add_argument("--plate", required=True)
    p.add_argument("--block", required=True)
    p.add_argument("--side", choices=("left", "right"), default="left")
    p.add_argument("--out", required=True)

    args = ap.parse_args(argv)
    if args.cmd == "build":
        block, layout = build_block(Image.open(args.logo), args.line, args.height, args.margin, args.content_width,
                                    args.latin_font, args.cjk_font, args.distress, args.min_gap, args.line_width, args.line_height_scale)
        block.save(args.out)
        print({k: v for k, v in layout.items()})
    else:
        place_block(Image.open(args.plate), Image.open(args.block), args.side).save(args.out)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
