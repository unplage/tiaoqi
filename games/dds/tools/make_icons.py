#!/usr/bin/env python3
"""把 icons/*.svg 渲染成 PWA 所需的 PNG / ICO 图标。

用法: python3 tools/make_icons.py
依赖: cairosvg, Pillow
"""
from __future__ import annotations

import pathlib

import cairosvg
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"


def svg_to_png(src: pathlib.Path, dst: pathlib.Path, size: int) -> None:
    cairosvg.svg2png(url=str(src), write_to=str(dst), output_width=size, output_height=size)
    print(f"  {dst.relative_to(ROOT)}  ({size}x{size})")


def make_ico(png: pathlib.Path, dst: pathlib.Path, sizes: list[int]) -> None:
    images = [Image.open(png).convert("RGBA").resize((s, s), Image.Resampling.LANCZOS) for s in sizes]
    images[0].save(dst, format="ICO", sizes=[(s, s) for s in sizes], append_images=images[1:])
    print(f"  {dst.relative_to(ROOT)}  ({', '.join(str(s) for s in sizes)})")


def main() -> None:
    main_icon = ICONS / "icon.svg"
    maskable = ICONS / "icon-maskable.svg"
    favicon = ICONS / "favicon.svg"

    print("渲染 PWA 图标:")
    svg_to_png(main_icon, ICONS / "icon-192.png", 192)
    svg_to_png(main_icon, ICONS / "icon-512.png", 512)
    svg_to_png(main_icon, ICONS / "apple-touch-icon.png", 180)
    svg_to_png(maskable, ICONS / "icon-maskable-192.png", 192)
    svg_to_png(maskable, ICONS / "icon-maskable-512.png", 512)
    svg_to_png(favicon, ICONS / "favicon-32.png", 32)
    svg_to_png(favicon, ICONS / "favicon-64.png", 64)
    make_ico(ICONS / "favicon-64.png", ROOT / "favicon.ico", [16, 32, 48, 64])
    print("完成。")


if __name__ == "__main__":
    main()
