#!/usr/bin/env python3
"""Prepare visual reference folders for brand/identity analysis.

Creates numbered manifests, inventory, palette samples, thumbnails, contact
sheets, and row sheets using FFmpeg so the agent can inspect every image.
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path


SUPPORTED_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
    ".tif",
    ".tiff",
    ".avif",
}


def run(cmd: list[str], *, cwd: Path | None = None, capture: bool = False) -> str:
    try:
        result = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            check=True,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
        )
    except subprocess.CalledProcessError as exc:
        details = exc.stderr or exc.stdout or str(exc)
        raise SystemExit(f"Command failed: {' '.join(cmd)}\n{details}") from exc
    return result.stdout if capture else ""


def ffprobe(ffprobe_bin: str, path: Path) -> dict[str, str]:
    output = run(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,codec_name,pix_fmt",
            "-of",
            "json",
            str(path),
        ],
        capture=True,
    )
    data = json.loads(output)
    streams = data.get("streams") or [{}]
    return streams[0]


def hex_rgb(rgb: tuple[int, int, int]) -> str:
    return "#%02X%02X%02X" % rgb


def palette_sample(ffmpeg_bin: str, path: Path, bins: int = 16) -> list[str]:
    raw = subprocess.check_output(
        [
            ffmpeg_bin,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-frames:v",
            "1",
            "-vf",
            "scale=64:64:force_original_aspect_ratio=decrease,"
            "pad=64:64:(ow-iw)/2:(oh-ih)/2:color=white",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ]
    )
    counts: Counter[tuple[int, int, int]] = Counter()
    step = 256 // bins
    half = step // 2
    for index in range(0, len(raw), 3):
        r, g, b = raw[index], raw[index + 1], raw[index + 2]
        quantized = ((r // step) * step + half, (g // step) * step + half, (b // step) * step + half)
        counts[quantized] += 1

    colors: list[str] = []
    for rgb, _count in counts.most_common(24):
        r, g, b = rgb
        near_white = r > 232 and g > 232 and b > 232
        if near_white and colors:
            continue
        colors.append(hex_rgb(rgb))
        if len(colors) == 8:
            break
    return colors


def write_contact_html(files: list[Path], out_path: Path) -> None:
    figures = []
    for index, path in enumerate(files, start=1):
        figures.append(
            f'<figure><div class="imgwrap"><img src="{path.resolve().as_uri()}" '
            f'loading="lazy"></div><figcaption>{index:02d}. {path.name}</figcaption></figure>'
        )
    html = f"""<!doctype html>
<meta charset="utf-8">
<title>Visual Reference Contact Sheet</title>
<style>
body{{margin:0;background:#171615;color:#f3eee5;font:12px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;}}
main{{padding:18px;display:grid;grid-template-columns:repeat(4,1fr);gap:14px;}}
figure{{margin:0;background:#24211e;border:1px solid #3a342e;border-radius:8px;overflow:hidden;}}
.imgwrap{{height:260px;display:flex;align-items:center;justify-content:center;background:#0e0d0c;}}
img{{max-width:100%;max-height:100%;object-fit:contain;display:block;}}
figcaption{{padding:8px 9px;color:#d6cab9;word-break:break-word;min-height:36px;}}
</style>
<main>{''.join(figures)}</main>
"""
    out_path.write_text(html, encoding="utf-8")


def make_thumb(ffmpeg_bin: str, src: Path, dest: Path, label: str) -> None:
    vf = (
        "scale=300:250:force_original_aspect_ratio=decrease,"
        "pad=320:285:(ow-iw)/2:(oh-ih)/2:color=0x111111,"
        f"drawtext=text='{label}':fontcolor=white:fontsize=24:"
        "box=1:boxcolor=black@0.65:boxborderw=8:x=8:y=8"
    )
    run(
        [
            ffmpeg_bin,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(src),
            "-frames:v",
            "1",
            "-vf",
            vf,
            str(dest),
        ]
    )


def xstack_sheet(ffmpeg_bin: str, images: list[Path], dest: Path, cols: int) -> None:
    if not images:
        return
    if len(images) == 1:
        shutil.copyfile(images[0], dest)
        return
    rows = (len(images) + cols - 1) // cols
    inputs: list[str] = []
    for path in images:
        inputs.extend(["-i", str(path)])
    labels = "".join(f"[{i}:v]" for i in range(len(images)))
    layout_parts = []
    for i in range(len(images)):
        x = (i % cols) * 336
        y = (i // cols) * 301
        layout_parts.append(f"{x}_{y}")
    filt = f"{labels}xstack=inputs={len(images)}:layout={'|'.join(layout_parts)}:fill=0x24211e[v]"
    run(
        [
            ffmpeg_bin,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            *inputs,
            "-filter_complex",
            filt,
            "-map",
            "[v]",
            "-frames:v",
            "1",
            str(dest),
        ]
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare visual references for identity analysis.")
    parser.add_argument("source", help="Folder containing visual reference images")
    parser.add_argument("--out", required=True, help="Output directory for generated analysis assets")
    parser.add_argument("--cols", type=int, default=4, help="Columns in contact sheets")
    parser.add_argument("--row-size", type=int, default=4, help="Images per row sheet")
    args = parser.parse_args()

    source = Path(args.source).expanduser().resolve()
    out = Path(args.out).expanduser().resolve()
    if not source.is_dir():
        raise SystemExit(f"Source is not a directory: {source}")

    ffmpeg_bin = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
    ffprobe_bin = shutil.which("ffprobe") or "/opt/homebrew/bin/ffprobe"
    if not Path(ffmpeg_bin).exists() and shutil.which(ffmpeg_bin) is None:
        raise SystemExit("ffmpeg not found. Install FFmpeg or adapt the skill with a local image tool fallback.")
    if not Path(ffprobe_bin).exists() and shutil.which(ffprobe_bin) is None:
        raise SystemExit("ffprobe not found. Install FFmpeg or adapt the skill with a local image tool fallback.")

    files = sorted(
        [path for path in source.iterdir() if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS],
        key=lambda path: path.name.lower(),
    )
    if not files:
        raise SystemExit(f"No supported image files found in {source}")

    out.mkdir(parents=True, exist_ok=True)
    thumbs = out / "thumbs"
    rows = out / "rows"
    thumbs.mkdir(exist_ok=True)
    rows.mkdir(exist_ok=True)

    with (out / "manifest.tsv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, delimiter="\t")
        writer.writerow(["number", "filename", "path"])
        for index, path in enumerate(files, start=1):
            writer.writerow([f"{index:02d}", path.name, str(path)])

    with (out / "inventory.tsv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, delimiter="\t")
        writer.writerow(["number", "filename", "width", "height", "aspect", "codec", "pix_fmt"])
        for index, path in enumerate(files, start=1):
            info = ffprobe(ffprobe_bin, path)
            width = int(info.get("width") or 0)
            height = int(info.get("height") or 0)
            aspect = f"{width / height:.3f}" if height else ""
            writer.writerow([f"{index:02d}", path.name, width, height, aspect, info.get("codec_name", ""), info.get("pix_fmt", "")])

    with (out / "palette-samples.tsv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, delimiter="\t")
        writer.writerow(["number", "filename", "sampled_hex_colors"])
        for index, path in enumerate(files, start=1):
            writer.writerow([f"{index:02d}", path.name, ", ".join(palette_sample(ffmpeg_bin, path))])

    write_contact_html(files, out / "contact-sheet.html")

    thumb_paths: list[Path] = []
    for index, path in enumerate(files, start=1):
        dest = thumbs / f"{index:03d}.png"
        make_thumb(ffmpeg_bin, path, dest, f"{index:02d}")
        thumb_paths.append(dest)

    xstack_sheet(ffmpeg_bin, thumb_paths, out / "contact-sheet.png", args.cols)

    for start in range(0, len(thumb_paths), args.row_size):
        group = thumb_paths[start : start + args.row_size]
        first = start + 1
        last = start + len(group)
        xstack_sheet(ffmpeg_bin, group, rows / f"row-{first:02d}-{last:02d}.png", args.row_size)

    print(f"Prepared {len(files)} images")
    print(f"Output: {out}")
    print(f"Manifest: {out / 'manifest.tsv'}")
    print(f"Contact sheet: {out / 'contact-sheet.png'}")
    print(f"HTML sheet: {out / 'contact-sheet.html'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
