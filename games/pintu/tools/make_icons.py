#!/usr/bin/env python3
"""生成 PWA 图标（生成时需要 cairosvg / PIL，运行时零依赖）。

用法:
    python3 tools/make_icons.py

产出:
    icons/icon-192.png            普通图标 (any)
    icons/icon-512.png            普通图标 (any)
    icons/icon-maskable-192.png   自适应图标 (maskable, 内容置于安全区)
    icons/icon-maskable-512.png   自适应图标 (maskable, 内容置于安全区)
    icons/icon-180.png            iOS apple-touch-icon (不透明)
    icons/favicon-32.png          浏览器标签页图标
    icons/favicon-16.png          浏览器标签页图标
    icons/favicon.ico             多尺寸 favicon (16/32/48)
    icons/icon.svg                矢量源文件
"""

import os
import io

import cairosvg
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "icons")

# ---------- 调色板（与 index.html 主题一致） ----------
BG_TOP = "#1d2f3d"
BG_BOTTOM = "#0b1218"
GLOW = "#4c9aff"
GOLD_TOP = "#ffe9a8"
GOLD_MID = "#ffd166"
GOLD_BOTTOM = "#ff9f43"

# 3x3 拼图画面（落日色系，呼应内置演示图）
TILES_3 = [
    ["#3a1d5c", "#8c3f6e", "#ff7e5f"],
    ["#5b2a63", "#d8536a", "#ffb35c"],
    ["#1c2f52", "#2c5a86", "#7a4a7a"],
]
# 2x2 精简版（小尺寸图标）：深色块 + 右上角金色高亮，保证 16px 下依然醒目
TILES_2 = [
    ["#24384c", None],
    ["#1b2836", "#33506b"],
]

BASE = 512.0  # 设计画布


def _tile(x, y, size, fill, radius):
    """画一个拼图小块"""
    return (
        f'<rect x="{x + 1.5}" y="{y + 1.5}" width="{size - 3}" height="{size - 3}" '
        f'rx="{radius}" fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="3"/>'
        f'<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="{radius}" fill="{fill}"/>'
    )


def _sparkle(cx, cy, r, fill, opacity=0.9):
    """四角星（胜利彩纸的抽象化）"""
    return (
        f'<path d="M {cx} {cy - r} Q {cx + r * 0.22} {cy - r * 0.22} {cx + r} {cy} '
        f'Q {cx + r * 0.22} {cy + r * 0.22} {cx} {cy + r} '
        f'Q {cx - r * 0.22} {cy + r * 0.22} {cx - r} {cy} '
        f'Q {cx - r * 0.22} {cy - r * 0.22} {cx} {cy - r} Z" '
        f'fill="{fill}" fill-opacity="{opacity}"/>'
    )


def _grid3(hot=(1, 1)):
    """3x3 拼图网格，hot 位置的小块被"拿起"(放大+金色+阴影)"""
    cell, gap = 96.0, 14.0
    total = 3 * cell + 2 * gap
    origin = (BASE - total) / 2
    out = []
    for r in range(3):
        for c in range(3):
            if (r, c) == hot:
                continue
            x = origin + c * (cell + gap)
            y = origin + r * (cell + gap)
            out.append(_tile(x, y, cell, TILES_3[r][c], cell * 0.16))

    hsize = cell * 1.26
    hx = origin + hot[1] * (cell + gap) - (hsize - cell) / 2
    hy = origin + hot[0] * (cell + gap) - (hsize - cell) / 2
    out.append(
        f'<rect x="{hx}" y="{hy + hsize * 0.11}" width="{hsize}" height="{hsize}" '
        f'rx="{hsize * 0.19}" fill="#000000" fill-opacity="0.5"/>'
    )
    out.append(
        f'<rect x="{hx}" y="{hy}" width="{hsize}" height="{hsize}" rx="{hsize * 0.19}" '
        f'fill="url(#gold)" stroke="#fff4d6" stroke-width="{hsize * 0.05}"/>'
    )
    # 彩纸点缀（保持在安全区内）
    out.append(_sparkle(origin + total - cell * 0.42, origin - cell * 0.30, 19, GOLD_MID, 0.95))
    out.append(_sparkle(origin - cell * 0.34, origin + cell * 0.45, 12, "#ffffff", 0.7))
    out.append(_sparkle(origin + total + cell * 0.30, origin + total * 0.55, 10, GOLD_TOP, 0.85))
    return "".join(out)


def _grid2(hot=(0, 1)):
    """2x2 精简网格（小尺寸用）：不重叠，保证 16px 下仍可辨识"""
    cell, gap = 190.0, 20.0
    total = 2 * cell + gap
    origin = (BASE - total) / 2
    out = []
    for r in range(2):
        for c in range(2):
            x = origin + c * (cell + gap)
            y = origin + r * (cell + gap)
            if (r, c) == hot:
                out.append(
                    f'<rect x="{x + 1.5}" y="{y + 1.5}" width="{cell - 3}" height="{cell - 3}" '
                    f'rx="{cell * 0.16}" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="3"/>'
                    f'<rect x="{x}" y="{y}" width="{cell}" height="{cell}" rx="{cell * 0.16}" '
                    f'fill="url(#gold)" stroke="#fff4d6" stroke-width="{cell * 0.05}"/>'
                )
            else:
                out.append(_tile(x, y, cell, TILES_2[r][c], cell * 0.16))
    return "".join(out)


def build_svg(variant="any"):
    """variant: any | maskable | small"""
    if variant == "any":
        bg = (
            f'<rect width="{BASE}" height="{BASE}" rx="{BASE * 0.219}" fill="url(#bg)"/>'
            f'<rect width="{BASE}" height="{BASE}" rx="{BASE * 0.219}" fill="url(#glow)"/>'
        )
        content = _grid3()
    elif variant == "maskable":
        # 背景满幅（系统会裁切成任意形状），内容缩到中心安全区
        bg = (
            f'<rect width="{BASE}" height="{BASE}" fill="url(#bg)"/>'
            f'<rect width="{BASE}" height="{BASE}" fill="url(#glow)"/>'
        )
        k = 0.74
        content = (
            f'<g transform="translate({BASE / 2} {BASE / 2}) scale({k}) '
            f'translate({-BASE / 2} {-BASE / 2})">{_grid3()}</g>'
        )
    else:  # small
        bg = (
            f'<rect width="{BASE}" height="{BASE}" rx="{BASE * 0.219}" fill="url(#bg)"/>'
            f'<rect width="{BASE}" height="{BASE}" rx="{BASE * 0.219}" fill="url(#glow)"/>'
        )
        content = _grid2()

    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{BASE}" height="{BASE}" viewBox="0 0 {BASE} {BASE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="{BG_TOP}"/>
      <stop offset="1" stop-color="{BG_BOTTOM}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.38" r="0.62">
      <stop offset="0" stop-color="{GLOW}" stop-opacity="0.28"/>
      <stop offset="1" stop-color="{GLOW}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="gold" x1="0.15" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="{GOLD_TOP}"/>
      <stop offset="0.5" stop-color="{GOLD_MID}"/>
      <stop offset="1" stop-color="{GOLD_BOTTOM}"/>
    </linearGradient>
  </defs>
  {bg}
  {content}
</svg>
"""


def render(svg, size):
    png = cairosvg.svg2png(bytestring=svg.encode("utf-8"), output_width=size, output_height=size)
    if png is None:
        raise RuntimeError(f"SVG 渲染失败: {size}px")
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
    render(small_svg, 32).save(os.path.join(OUT_DIR, "favicon-32.png"))
    render(small_svg, 16).save(os.path.join(OUT_DIR, "favicon-16.png"))

    # iOS apple-touch-icon：不支持透明通道，压平背景
    render(any_svg, 180).convert("RGB").save(os.path.join(OUT_DIR, "icon-180.png"))

    # 多尺寸 favicon（源图需 >= 最大目标尺寸）
    render(small_svg, 48).save(os.path.join(OUT_DIR, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])

    print("图标已生成到:", OUT_DIR)
    for f in sorted(os.listdir(OUT_DIR)):
        p = os.path.join(OUT_DIR, f)
        print(f"  {f:28s} {os.path.getsize(p):>7d} B")


if __name__ == "__main__":
    main()
