"""Frame native-resolution PNG captures for the project documentation.

Usage: python tools/prepare_screenshots.py tmp/screenshots-3x
Requires Pillow. Input captures use a 3x device scale, 100% application zoom,
and the real application UI. The screenshot pixels are never resampled.
"""

from argparse import ArgumentParser
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


def frame(source: Image.Image, *, dark: bool = False) -> Image.Image:
    margin = 72
    radius = 24
    width, height = source.size
    size = (width + 2 * margin, height + 2 * margin)
    background = "#16181c" if dark else "#f0f2f5"
    border = "#41454d" if dark else "#cdd2da"
    result = Image.new("RGBA", size, background)

    shadow = Image.new("RGBA", size)
    ImageDraw.Draw(shadow).rounded_rectangle(
        (margin, margin + 12, margin + width - 1, margin + height + 11),
        radius,
        fill=(0, 0, 0, 54 if dark else 28),
    )
    result = Image.alpha_composite(result, shadow.filter(ImageFilter.GaussianBlur(18)))

    mask = Image.new("L", source.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1), radius, fill=255)
    result.paste(source.convert("RGB"), (margin, margin), mask)
    ImageDraw.Draw(result).rounded_rectangle(
        (margin, margin, margin + width - 1, margin + height - 1),
        radius,
        outline=border,
        width=2,
    )
    return result.convert("RGB")


def main() -> None:
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, default=Path("UI/screenshots"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    sizes = {
        "writing-light": (3840, 2400),
        "writing-dark": (3840, 2400),
        "writing-source": (3840, 2400),
        "writing-narrow": (2700, 1800),
    }
    captures = {}
    for name, expected in sizes.items():
        with Image.open(args.input / f"{name}.png") as capture:
            if capture.format != "PNG" or capture.size != expected:
                raise ValueError(f"{name}: expected lossless PNG at {expected}, got {capture.format} {capture.size}")
            captures[name] = capture.convert("RGB")

    for name, capture in captures.items():
        output = args.output / f"{name}.png"
        frame(capture, dark=name == "writing-dark").save(output, optimize=True)
        print(f"{output}: {Image.open(output).size}, {output.stat().st_size:,} bytes")

    # A genuine crop of the light capture, with no enlargement or sharpening.
    crop = captures["writing-light"].crop(tuple(value * 3 for value in (352, 96, 1160, 376)))
    detail = args.output / "writing-detail.png"
    frame(crop).save(detail, optimize=True)
    print(f"{detail}: {Image.open(detail).size}, {detail.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
