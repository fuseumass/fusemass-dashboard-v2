#!/usr/bin/env python3
"""Print judging table check-in QR signs for table numbers.

Each QR encodes sha256("<table number>") as hex, e.g. table 12 ->
sha256("12"). When a participant scans it from the dashboard ("Scan table
QR"), the backend hashes the numbers in the current room layout, finds the
table and checks it against their assigned table. No database access or
projects are needed; the admin "Table signs" page prints the same codes.

Usage:
  pip install qrcode pillow
  python3 table_qr.py --count 120 --out table-signs
  python3 table_qr.py --count 20 --start 101   # tables 101-120

Output: one PNG per table plus all-tables.pdf (one Letter page per table).
"""
import argparse
import os
import hashlib
import sys

import qrcode
from PIL import Image, ImageDraw, ImageFont

PAGE = (1275, 1650)  # US Letter at 150 dpi
FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
]


def font(size):
    for path in FONT_PATHS:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def table_token(number):
    """Must match tableToken in backend/utils/judging/tables.js."""
    return hashlib.sha256(str(number).encode()).hexdigest()


def centered(draw, y, text, size):
    face = font(size)
    width = draw.textlength(text, font=face)
    draw.text(((PAGE[0] - width) / 2, y), text, font=face, fill="black")


def sign(number):
    page = Image.new("RGB", PAGE, "white")
    draw = ImageDraw.Draw(page)
    centered(draw, 90, "Table %d" % number, 170)
    code = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=2, box_size=20)
    code.add_data(table_token(number))
    code.make(fit=True)
    image = code.make_image(fill_color="black", back_color="white").convert("RGB")
    image = image.resize((900, 900), Image.NEAREST)
    page.paste(image, ((PAGE[0] - 900) // 2, 380))
    centered(draw, 1370, "Table check-in", 64)
    centered(draw, 1460, "Open your dashboard and tap Scan table QR", 40)
    return page


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--count", type=int, required=True, help="number of tables (prints 1..count)")
    parser.add_argument("--start", type=int, default=1, help="first table number (default 1)")
    parser.add_argument("--out", default="table-signs", help="output folder (default ./table-signs)")
    args = parser.parse_args()
    if args.count < 1 or args.start < 1:
        sys.exit("--count and --start must be at least 1")

    os.makedirs(args.out, exist_ok=True)
    pages = []
    for number in range(args.start, args.start + args.count):
        page = sign(number)
        page.save(os.path.join(args.out, "table-%03d.png" % number))
        pages.append(page)

    pdf = os.path.join(args.out, "all-tables.pdf")
    pages[0].save(pdf, save_all=True, append_images=pages[1:], resolution=150)
    print("Wrote %d signs to %s (PDF: %s)" % (len(pages), args.out, pdf))

if __name__ == "__main__":
    main()
