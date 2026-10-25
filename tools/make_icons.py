#!/usr/bin/env python3
"""生成多游戏集 PWA 图标（生成时依赖 cairosvg / Pillow）。"""

import os
import io

import cairosvg
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "icons")
BASE = 512.0

BG_TOP = "#0b1220"
BG_BOTTOM = "#1d3960"
GLOW = "#38bdf8"
GOLD_TOP = "#facc15"
GOLD_BOTTOM = "#f59e0b"

TILE_COLORS = ["#2563eb", "#f59e0b", "#10b981", "#8b5cf6"]


def _rounded(x, y, w, h, r, fill, stroke=None, stroke_width=0):
    parts = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}"/>']
    if stroke:
        parts.append(f'<rect x="{x+1}" y="{y+1}" width="{w-2}" height="{h-2}" rx="{r-1}" fill="none" stroke="{stroke}" stroke-width="{stroke_width}" opacity="0.22"/>')
    return "".join(parts)


def _tile_grid(gap=26.0, size=184.0):
    total = 2 * size + gap
    origin = (BASE - total) / 2
    out = []
    for idx in range(4):
        r, c = divmod(idx, 2)
        x = origin + c * (size + gap)
        y = origin + r * (size + gap)
        color = TILE_COLORS[idx]
        out.append(_rounded(x, y, size, size, size * 0.22, color))
        out.append(f'<circle cx="{x + size*0.72}" cy="{y + size*0.28}" r="{size*0.085}" fill="#ffffff" fill-opacity="0.30"/>')
    # 中央ゲーム手柄：深色底 + 两个按键
    pad_w, pad_h = 250, 145
    px = (BASE - pad_w) / 2
    py = (BASE - pad_h) / 2
    out.append(_rounded(px - 4, py + 10, pad_w + 8, pad_h, pad_h * 0.45, "#020617", None))
    out.append(_rounded(px, py, pad_w, pad_h, pad_h * 0.45, "#111827"))
    out.append(f'<rect x="{px+42}" y="{py+65}" width="56" height="16" rx="8" fill="#94a3b8"/>')
    out.append(f'<rect x="{px+62}" y="{py+45}" width="16" height="56" rx="8" fill="#94a3b8"/>')
    out.append(f'<circle cx="{px+176}" cy="{py+45}" r="15" fill="#ef4444"/>')
    out.append(f'<circle cx="{px+212}" cy="{py+75}" r="15" fill="#38bdf8"/>')
    out.append(f'<circle cx="{px+188}" cy="{py+108}" r="11" fill="#f8fafc" fill-opacity="0.45"/>')
    return "".join(out)


def build_svg(variant="any"):
    if variant == "maskable":
        bg = f'<rect width="{BASE}" height="{BASE}" fill="url(#bg)"/><rect width="{BASE}" height="{BASE}" fill="url(#glow)"/>'
        body = f'<g transform="translate({BASE/2} {BASE/2}) scale(0.62) translate({-BASE/2} {-BASE/2})">{_tile_grid()}</g>'
    elif variant == "small":
        bg = f'<rect width="{BASE}" height="{BASE}" rx="{BASE*0.2}" fill="url(#bg)"/>'
        body = (
            f'<rect x="156" y="156" width="200" height="200" rx="48" fill="{TILE_COLORS[0]}"/>'
            f'<rect x="236" y="210" width="20" height="76" rx="10" fill="#fff"/>'
            f'<rect x="208" y="238" width="76" height="20" rx="10" fill="#fff"/>'
            f'<circle cx="306" cy="228" r="18" fill="#f43f5e"/>'
            f'<circle cx="334" cy="262" r="14" fill="#fff" fill-opacity="0.85"/>'
        )
    else:
        bg = f'<rect width="{BASE}" height="{BASE}" rx="{BASE*0.215}" fill="url(#bg)"/><rect width="{BASE}" height="{BASE}" rx="{BASE*0.215}" fill="url(#glow)"/>'
        body = _tile_grid()

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{BASE}" height="{BASE}" viewBox="0 0 {BASE} {BASE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="{BG_TOP}"/>
      <stop offset="1" stop-color="{BG_BOTTOM}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.65">
      <stop offset="0" stop-color="{GLOW}" stop-opacity="0.24"/>
      <stop offset="1" stop-color="{GLOW}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  {bg}
  {body}
</svg>'''


def render(svg, size):
    png = cairosvg.svg2png(bytestring=svg.encode("utf-8"), output_width=size, output_height=size)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    any_svg = build_svg("any")
    mask_svg = build_svg("maskable")
    small_svg = build_svg("small")

    with open(os.path.join(OUT_DIR, "icon.svg"), "w", encoding="utf-8") as f:
        f.write(any_svg)

    render(any_svg, 192).save(os.path.join(OUT_DIR, "icon-192.png"))
    render(any_svg, 512).save(os.path.join(OUT_DIR, "icon-512.png"))
    render(mask_svg, 192).save(os.path.join(OUT_DIR, "icon-maskable-192.png"))
    render(mask_svg, 512).save(os.path.join(OUT_DIR, "icon-maskable-512.png"))
    render(any_svg, 180).convert("RGB").save(os.path.join(OUT_DIR, "icon-180.png"))
    render(small_svg, 32).save(os.path.join(OUT_DIR, "favicon-32.png"))
    render(small_svg, 16).save(os.path.join(OUT_DIR, "favicon-16.png"))
    render(small_svg, 48).save(os.path.join(OUT_DIR, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])

    print("icons generated", OUT_DIR)


if __name__ == "__main__":
    main()
