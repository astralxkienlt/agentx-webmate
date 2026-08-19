#!/usr/bin/env python3
"""Generate netMind Extension toolbar/favicon assets from the canonical JPG.

The source is a raspberry ribbon “N” on a near-white box. Toolbar icons need
a transparent mark, so near-white pixels are knocked out before resize.
Writes brand/icons (extension overlay) and web/ favicon + nav mark.
Requires Pillow.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "logo" / "logo_netmind_extension.jpg"
BRAND_ICONS = ROOT / "brand" / "icons"
WEB = ROOT / "web"


def knockout_paper(src: Image.Image) -> Image.Image:
    """Turn the light-gray JPG backdrop into an alpha channel."""
    img = src.convert("RGBA")
    pixels = img.load()
    width, height = img.size
    for y in range(height):
        for x in range(width):
            r, g, b, _a = pixels[x, y]
            chroma = max(r, g, b) - min(r, g, b)
            luma = (r + g + b) / 3
            if chroma < 18 and luma > 232:
                pixels[x, y] = (r, g, b, 0)
            elif chroma < 28 and luma > 210:
                alpha = int(255 * (1 - (luma - 210) / 45))
                pixels[x, y] = (r, g, b, max(0, min(255, alpha)))
    return img


def crop_to_mark(mark: Image.Image, padding_ratio: float = 0.14) -> Image.Image:
    bounds = mark.getchannel("A").getbbox()
    if not bounds:
        raise SystemExit("Logo knockout left no visible pixels")
    left, top, right, bottom = bounds
    subject = max(right - left, bottom - top)
    side = round(subject * (1 + padding_ratio))
    cx = (left + right) / 2
    cy = (top + bottom) / 2
    crop_left = round(cx - side / 2)
    crop_top = round(cy - side / 2)
    return mark.crop((crop_left, crop_top, crop_left + side, crop_top + side))


def save_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Missing logo source: {SOURCE}")

    mark = crop_to_mark(knockout_paper(Image.open(SOURCE)))
    for size in (16, 48, 128):
        save_png(mark.resize((size, size), Image.Resampling.LANCZOS), BRAND_ICONS / f"icon{size}.png")

    # The cloud provider's entry in the model picker. Keeps the upstream
    # filename because PROVIDER_ICON_FILES maps it from the provider id
    # webbrain_cloud, which brand.config.json pins in `preserve` — renaming the
    # file here would silently drop the icon, not rebrand it. 64×64 RGBA to
    # match every other icon in icons/providers/.
    save_png(mark.resize((64, 64), Image.Resampling.LANCZOS), BRAND_ICONS / "providers" / "webbrain_cloud.png")

    save_png(mark.resize((64, 64), Image.Resampling.LANCZOS), WEB / "favicon.png")
    save_png(mark.resize((512, 512), Image.Resampling.LANCZOS), WEB / "logo-github.png")
    print(f"Wrote netMind icons from {SOURCE.relative_to(ROOT)} ({mark.size[0]}×{mark.size[1]} mark)")


if __name__ == "__main__":
    main()
