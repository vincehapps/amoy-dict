#!/usr/bin/env python3
"""OCR the Chinese characters from the scanned dictionary pages.

The PDF's text layer carries only the Latin type; the Han glyphs are part of
the scanned image. This script renders each page, crops the strip belonging to
each text line (using the line boxes data/raw/build-lines.json, which
scripts/build-dictionary.mjs writes), runs the recognizer on that strip, and
keeps the Han characters it finds.

Working line by line avoids the two problems of whole-page OCR here: detector
boxes bridging the gutter between the two columns, and boxes merging two
stacked lines of Chinese (which made the same characters bleed into adjacent
entries).

Output: data/raw/ocr-lines.json
  { "meta": {...}, "pages": { "15": { "L|255.6": "向後到退", ... } } }

Run scripts/build-dictionary.mjs first so the line boxes exist.

Usage:
  .venv/bin/python scripts/ocr-chinese.py                  # pages 15-612
  .venv/bin/python scripts/ocr-chinese.py --start 15 --end 40

Requires: rapidocr-onnxruntime, pillow, pdftoppm (poppler).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "English-Amoy-Dictionary.pdf"
LINES = ROOT / "data/raw/build-lines.json"
OUT = ROOT / "data/raw/ocr-lines.json"

CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def load_done(path: Path) -> dict[str, dict[str, str]]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text())
    except json.JSONDecodeError:
        return {}
    return {str(k): v for k, v in raw.get("pages", {}).items()}


def save(path: Path, pages: dict[str, dict[str, str]], dpi: int) -> None:
    payload = {
        "meta": {
            "dpi": dpi,
            "note": "Han characters OCR'd from the page image, keyed by page|column|line-y.",
        },
        "pages": {k: pages[k] for k in sorted(pages, key=int)},
    }
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    tmp.replace(path)


def render(page: int, dpi: int, dest: Path) -> Path:
    subprocess.run(
        [
            "pdftoppm",
            "-f",
            str(page),
            "-l",
            str(page),
            "-r",
            str(dpi),
            "-png",
            "-singlefile",
            str(PDF),
            str(dest),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    out = dest.with_suffix(".png")
    if not out.exists():
        raise RuntimeError(f"pdftoppm produced no image for page {page}")
    return out


def recognise(engine: RapidOCR, crop: np.ndarray) -> str:
    result, _ = engine(crop, use_det=False, use_cls=False, use_rec=True)
    text = " ".join((r[1] if len(r) == 3 else r[0]) for r in (result or []))
    return "".join(CJK.findall(text))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", type=int, default=15)
    parser.add_argument("--end", type=int, default=612)
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("--threads", type=int, default=12)
    parser.add_argument("--out", default=None, help="override output path (for parallel shards)")
    args = parser.parse_args()
    out_path = Path(args.out) if args.out else OUT

    all_lines = json.loads(LINES.read_text())["lines"]
    by_page: dict[int, list[dict]] = {}
    for line in all_lines:
        if args.start <= line["page"] <= args.end:
            by_page.setdefault(line["page"], []).append(line)
    if not by_page:
        print(f"no line boxes in {LINES}; run scripts/build-dictionary.mjs first", flush=True)
        return 1

    pages = load_done(out_path)
    todo = [p for p in range(args.start, args.end + 1) if str(p) not in pages]
    print(
        f"{out_path.name}: {len(pages)} pages cached, {len(todo)} to OCR at {args.dpi} dpi",
        flush=True,
    )
    if not todo:
        return 0

    engine = RapidOCR(intra_op_num_threads=args.threads)
    scale = args.dpi / 72.0
    started = time.time()

    with tempfile.TemporaryDirectory(prefix="amoy-ocr-") as tmpdir:
        for i, page in enumerate(todo, 1):
            began = time.time()
            image_path = render(page, args.dpi, Path(tmpdir) / f"p{page}")
            image = Image.open(image_path).convert("RGB")
            width, height = image.size
            split = width // 2
            lines = by_page.get(page, [])

            found: dict[str, str] = {}
            for line in lines:
                x0, x1 = (0, split) if line["col"] == "L" else (split, width)
                y0 = max(0, int((line["y"] - 2.0) * scale))
                y1 = min(height, int(((line.get("y2") or line["y"] + 7) + 3.0) * scale))
                crop = np.asarray(image.crop((x0, y0, x1, y1)))
                chars = recognise(engine, crop)
                if chars:
                    found[line["key"]] = chars

            image_path.unlink(missing_ok=True)
            pages[str(page)] = found
            elapsed = time.time() - began
            done = i
            per_page = (time.time() - started) / done
            eta = per_page * (len(todo) - done)
            cjk = sum(len(v) for v in found.values())
            print(
                f"page {page}: {len(lines)} strips, {cjk} chars in {elapsed:.1f}s "
                f"({done}/{len(todo)}, eta {eta / 60:.0f} min)",
                flush=True,
            )
            if done % 3 == 0 or done == len(todo):
                save(out_path, pages, args.dpi)

    print(f"done in {(time.time() - started) / 60:.1f} min -> {out_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
