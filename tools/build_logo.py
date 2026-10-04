"""Build the LAZA CINEMA STUDIO logo assets from one construction (128 grid).

The head is one closed outline, mirrored about x=64: cheek -> a single curve up to the ear tip -> straight
inner edge to the forehead dip. No joins between a circle and ears, so there is no shoulder where they meet.
The play triangle is equilateral, cut out, optically centred. Everything derives from the constants below.

  backend\\.venv\\Scripts\\python tools\\build_logo.py
"""
import math
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ORANGE = "#F4A340"
SOFT = 4.0                               # a round-joined stroke of the fill colour softens the ear tips

# right half of the outline, clockwise from the forehead dip (64, DIP) down to the chin (64, CHIN)
TIP = (101.0, 10.0)                      # right ear tip (left is the mirror image)
FOREHEAD_CTRL = 42.0                     # the dip between the ears: a clear V reads as a cat, a shallow one as a bump
CHEEK = (111.0, 68.0)
CHIN = 108.0
EAR_CTRL = ((107.0, 26.0), (111.0, 48.0))      # control points from tip down to the cheek
JAW_CTRL = ((111.0, 94.0), (92.0, CHIN))       # control points from cheek down to the chin (then x=64)
EAR_BASE = (73.0, 35.0)                  # where the inner ear edge reaches the forehead

PLAY_H = 25.0                            # play triangle height; side = H * 2 / sqrt(3)
PLAY_CY = 75.0
PLAY_SHIFT = 1.5                         # optical: a triangle looks left-heavy, so push it right


def mirror(p):
    return (128 - p[0], p[1])


def cubic(p0, p1, p2, p3, n=24):
    out = []
    for i in range(1, n + 1):
        t = i / n
        u = 1 - t
        out.append((u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                    u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]))
    return out


f = lambda p: f"{p[0]:.2f} {p[1]:.2f}"


def head_path():
    """The outline as an SVG path, starting at the right of the forehead dip."""
    (tc1, tc2), (jc1, jc2) = EAR_CTRL, JAW_CTRL
    m = mirror
    d = f"M{f(EAR_BASE)}L{f(TIP)}C{f(tc1)} {f(tc2)} {f(CHEEK)}C{f(jc1)} {f(jc2)} 64 {CHIN}"
    d += f"C{f(m(jc2))} {f(m(jc1))} {f(m(CHEEK))}C{f(m(tc2))} {f(m(tc1))} {f(m(TIP))}L{f(m(EAR_BASE))}"
    d += f"Q64 {FOREHEAD_CTRL} {f(EAR_BASE)}Z"
    return d


def head_points():
    """The same outline sampled to a polygon, for the ICO raster."""
    (tc1, tc2), (jc1, jc2) = EAR_CTRL, JAW_CTRL
    pts = [EAR_BASE, TIP]
    pts += cubic(TIP, tc1, tc2, CHEEK)
    right_jaw = cubic(CHEEK, jc1, jc2, (64, CHIN))
    pts += right_jaw
    pts += [mirror(p) for p in reversed(right_jaw[:-1])] + [mirror(CHEEK)]
    pts += [mirror(p) for p in reversed(cubic(TIP, tc1, tc2, CHEEK)[:-1])] + [mirror(TIP), mirror(EAR_BASE)]
    a, c, b = mirror(EAR_BASE), (64, FOREHEAD_CTRL), EAR_BASE
    for i in range(1, 13):                                   # the forehead dip, quadratic
        t = i / 12
        pts.append(((1 - t)**2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0],
                    (1 - t)**2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]))
    return pts


def play_points():
    side = PLAY_H * 2 / math.sqrt(3)
    px = 64 - PLAY_H / 3 + PLAY_SHIFT
    return [(px, PLAY_CY - side / 2), (px, PLAY_CY + side / 2), (px + PLAY_H, PLAY_CY)]


HEAD_D = head_path()
PLAY_D = "M" + "L".join(f(p) for p in play_points()) + "Z"


def head_group(fill):
    return f'<path d="{HEAD_D}" fill="{fill}" stroke="{fill}" stroke-width="{SOFT}" stroke-linejoin="round"/>'


def cut(ident):
    return (f'<defs><mask id="{ident}"><rect width="128" height="128" fill="#fff"/>'
            f'<path d="{PLAY_D}" fill="#000" stroke="#000" stroke-width="3" stroke-linejoin="round"/></mask></defs>')


def mark_svg():
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="LAZA CINEMA STUDIO">'
            f'{cut("laza-m")}<g mask="url(#laza-m)">{head_group(ORANGE)}</g></svg>')


WORD = ('<path d="M84 22H92V48H108V56H84Z"/>'
        '<path id="laza-a" d="M118 56L130 22H138L150 56H141.6L134 34.5L126.4 56Z"/>'
        '<path d="M158 22H182V29.5L168.5 48.5H182V56H158V48.5L171.5 29.5H158Z"/>'
        '<use href="#laza-a" transform="translate(72)"/>')


def logo_svg(word="#F4F1EA", sub="#B9B6AE"):
    s = 0.5                                                  # mark box (y 12..111) centred on the cap band (22..56)
    ty = 39 - (12 + 111) / 2 * s
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 244 80" role="img" aria-label="LAZA CINEMA STUDIO">'
            f'{cut("laza-lm")}<g transform="translate(14 {ty:.2f}) scale({s})"><g mask="url(#laza-lm)">{head_group(ORANGE)}</g></g>'
            f'<g fill="{word}">{WORD}</g>'
            '<text x="84" y="73" textLength="138" lengthAdjust="spacing" font-family="\'Segoe UI\',\'Helvetica Neue\',Arial,sans-serif" '
            'font-size="9" font-weight="600" fill="' + sub + '">CINEMA STUDIO</text></svg>')


def logo_tsx():
    return f"""'use client';

import {{ useId }} from 'react';

/**
 * The LAZA CINEMA STUDIO mark: a cat head drawn as one smooth outline (cheek straight up to the ear tip),
 * with a play triangle cut out of it. One flat colour, no gradient. The same geometry as
 * public/laza-mark.svg.
 */
export function LazaMark({{ size = 24, className }}: {{ size?: number; className?: string }}) {{
  const mask = `laza-${{useId().replace(/[^a-zA-Z0-9]/g, '')}}`;
  return (
    <svg width={{size}} height={{size}} viewBox="0 0 128 128" className={{className}} role="img" aria-label="LAZA CINEMA STUDIO">
      <defs>
        <mask id={{mask}}>
          <rect width="128" height="128" fill="#fff" />
          <path d="{PLAY_D}" fill="#000" stroke="#000" strokeWidth="3" strokeLinejoin="round" />
        </mask>
      </defs>
      <g mask={{`url(#${{mask}})`}}>
        <path d="{HEAD_D}" fill="{ORANGE}" stroke="{ORANGE}" strokeWidth="{SOFT}" strokeLinejoin="round" />
      </g>
    </svg>
  );
}}
"""


def ico():
    sizes = [16, 24, 32, 48, 64, 128]
    big, q = 2048, 2048 / 128
    k = 1.10                                                 # fill the frame: small sizes need every pixel
    tr = lambda p: ((64 + (p[0] - 64) * k) * q, (63 + (p[1] - 62) * k) * q)
    head = Image.new("L", (big, big), 0)
    hp = [tr(p) for p in head_points()]
    hd = ImageDraw.Draw(head)
    hd.polygon(hp, fill=255)
    hd.line(hp + [hp[0]], fill=255, width=int(SOFT * k * q), joint="curve")
    play = Image.new("L", (big, big), 0)
    pp = [tr(p) for p in play_points()]
    pd = ImageDraw.Draw(play)
    pd.polygon(pp, fill=255)
    pd.line(pp + [pp[0]], fill=255, width=int(3 * k * q), joint="curve")
    img = Image.new("RGBA", (big, big), ORANGE)
    img.putalpha(ImageChops.subtract(head, play))
    frames = [img.resize((s, s), Image.LANCZOS) for s in sizes]
    frames[-1].save(ROOT / "frontend" / "app" / "favicon.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])


def main():
    out = ROOT / "frontend"
    (out / "public" / "laza-mark.svg").write_text(mark_svg(), encoding="utf-8")
    (out / "public" / "laza-logo.svg").write_text(logo_svg(), encoding="utf-8")
    (out / "public" / "laza-logo-light.svg").write_text(logo_svg("#17171C", "#6B6860"), encoding="utf-8")   # for light backgrounds
    (out / "app" / "icon.svg").write_text(mark_svg(), encoding="utf-8")
    (out / "components" / "Logo.tsx").write_text(logo_tsx(), encoding="utf-8")
    ico()
    print("written; head path", len(HEAD_D), "chars")


if __name__ == "__main__":
    main()
