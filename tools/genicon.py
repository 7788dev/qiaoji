"""Builds the 巧记 application icon from the brand artwork.

Inputs:
    UI/brand/icon-source.png   1024px master, the refined brand icon

Outputs:
    build/appicon.png          1024px icon with transparent corners
    build/windows/icon.ico     multi-resolution icon embedded in the executable
    frontend/src/assets/mark.png   small mark for the in-app title bar
    UI/brand/logo.png          icon + 巧记 wordmark lockup, for docs

The master is a flat RGB render, so the rounded corners have to be cut here.
The plate is a superellipse-cornered square that touches all four edges; the
exponent below was fitted to the artwork rather than guessed, which is why the
mask lines up with the painted edge instead of clipping or leaving a halo.

Run from the repository root:

    python tools/genicon.py
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

SOURCE = "UI/brand/icon-source.png"
SIZE = 1024

# Fitted to the artwork: corner reach along each edge, as a fraction of the
# side, and the superellipse exponent.
CORNER_RATIO = 153 / 1024
CORNER_EXPONENT = 1.75

# Supersampling factor for the alpha mask. The master is already anti-aliased;
# this keeps the cut edge just as smooth.
SS = 4

ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
MARK_SIZE = 128

INK = (27, 31, 38, 255)  # the near-black used by the mark

CJK_FONTS = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\Dengb.ttf",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\msyh.ttc",
]


def load_cjk(size: int) -> ImageFont.FreeTypeFont:
    for path in CJK_FONTS:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    raise SystemExit("no CJK font found; install Microsoft YaHei or SimHei")


def squircle_mask(size: int) -> Image.Image:
    """Alpha mask for a superellipse-cornered square filling the frame."""
    big = size * SS
    radius = CORNER_RATIO * big
    mask = Image.new("L", (big, big), 0)
    px = mask.load()

    n = CORNER_EXPONENT
    inv = 1.0 / n
    # Only the four corner squares need per-pixel work; the cross-shaped middle
    # is solid, so it is filled with rectangles instead.
    r = int(radius) + 1
    draw = ImageDraw.Draw(mask)
    draw.rectangle((r, 0, big - r, big), fill=255)
    draw.rectangle((0, r, big, big - r), fill=255)

    for cx, cy, sx, sy in (
        (r, r, -1, -1),
        (big - r, r, 1, -1),
        (r, big - r, -1, 1),
        (big - r, big - r, 1, 1),
    ):
        for dy in range(r):
            fy = (dy / radius) ** n
            if fy >= 1.0:
                continue
            reach = radius * (1.0 - fy) ** inv
            for dx in range(r):
                if dx <= reach:
                    px[cx + sx * dx, cy + sy * dy] = 255

    return mask.resize((size, size), Image.LANCZOS)


def build_icon() -> Image.Image:
    master = Image.open(SOURCE).convert("RGB")
    if master.size != (SIZE, SIZE):
        master = master.resize((SIZE, SIZE), Image.LANCZOS)
    icon = master.convert("RGBA")
    icon.putalpha(squircle_mask(SIZE))
    return icon


def build_mark(icon: Image.Image) -> Image.Image:
    """
    The in-app mark keeps its plate.

    Stripping the plate was tried first, but the artwork is near-black ink on
    white paper: without the plate it is invisible against the dark theme. The
    plate is what makes one asset work on both themes, which is also why every
    other desktop app shows its plated icon in the title bar.
    """
    return icon.resize((MARK_SIZE, MARK_SIZE), Image.LANCZOS)


def build_lockup(icon: Image.Image) -> Image.Image:
    mark = 176
    gap = 44
    pad = 40
    text = "巧记"

    font = load_cjk(136)
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    l, t, r, b = probe.textbbox((0, 0), text, font=font)
    text_w, text_h = r - l, b - t

    width = pad * 2 + mark + gap + text_w
    height = pad * 2 + mark
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    canvas.paste(icon.resize((mark, mark), Image.LANCZOS), (pad, pad), icon.resize((mark, mark), Image.LANCZOS))

    ImageDraw.Draw(canvas).text(
        (pad + mark + gap - l, (height - text_h) / 2 - t),
        text,
        font=font,
        fill=INK,
    )
    return canvas


def main() -> None:
    if not os.path.exists(SOURCE):
        raise SystemExit(f"missing {SOURCE}")

    os.makedirs("build/windows", exist_ok=True)
    os.makedirs("frontend/src/assets", exist_ok=True)
    os.makedirs("UI/brand", exist_ok=True)

    icon = build_icon()
    icon.save("build/appicon.png")
    print("wrote build/appicon.png (1024x1024)")

    # Each ICO frame is resampled from the master rather than from a smaller
    # frame, so the 16px entry stays legible instead of turning to mush.
    frames = [icon.resize((s, s), Image.LANCZOS) for s in ICO_SIZES]
    frames[-1].save(
        "build/windows/icon.ico",
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=frames[:-1],
    )
    print(f"wrote build/windows/icon.ico ({', '.join(str(s) for s in ICO_SIZES)})")

    mark = build_mark(icon)
    mark.save("frontend/src/assets/mark.png")
    print(f"wrote frontend/src/assets/mark.png ({MARK_SIZE}x{MARK_SIZE})")

    lockup = build_lockup(icon)
    lockup.save("UI/brand/logo.png")
    print(f"wrote UI/brand/logo.png ({lockup.width}x{lockup.height})")


if __name__ == "__main__":
    main()
