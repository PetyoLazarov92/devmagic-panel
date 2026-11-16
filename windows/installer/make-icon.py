#!/usr/bin/env python3
"""The Windows icon (devmagic-panel.ico) from the panel's mark, web/public/favicon.svg:

  <rect width="32" height="32" rx="8" fill="#6d5dfc"/>
  <path d="M9 22V10h5.5a6 6 0 0 1 0 12H9Z" fill="none" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/>
  <circle cx="22.5" cy="22" r="2" fill="#fff"/>

drawn here with distances to its shapes, 8x8 samples a pixel, at every size Windows
asks an icon for, each a PNG inside the .ico. No image library needed: run it again
when the mark changes. Usage: python3 make-icon.py <out.ico>
"""
import math
import struct
import sys
import zlib

SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)
SAMPLES = 8
PURPLE = (0x6D, 0x5D, 0xFC)
WHITE = (0xFF, 0xFF, 0xFF)


def in_rounded_rect(x, y, size=32.0, r=8.0):
    cx = min(max(x, r), size - r)
    cy = min(max(y, r), size - r)
    return 0 <= x <= size and 0 <= y <= size and (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def dist_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def dist_d(px, py):
    """Distance to the D: two straight sides, the left side, and the right half circle."""
    d = min(
        dist_segment(px, py, 9, 22, 9, 10),
        dist_segment(px, py, 9, 10, 14.5, 10),
        dist_segment(px, py, 14.5, 22, 9, 22),
    )
    cx, cy, r = 14.5, 16.0, 6.0
    if px >= cx:
        d = min(d, abs(math.hypot(px - cx, py - cy) - r))
    else:
        d = min(d, math.hypot(px - cx, py - (cy - r)), math.hypot(px - cx, py - (cy + r)))
    return d


def pixel(size, i, j):
    """Straight RGBA of pixel (i, j) at this size, averaged over SAMPLES x SAMPLES points."""
    total = SAMPLES * SAMPLES
    a = r = g = b = 0.0
    for sy in range(SAMPLES):
        for sx in range(SAMPLES):
            x = (i + (sx + 0.5) / SAMPLES) * 32.0 / size
            y = (j + (sy + 0.5) / SAMPLES) * 32.0 / size
            if not in_rounded_rect(x, y):
                continue
            white = dist_d(x, y) <= 1.3 or math.hypot(x - 22.5, y - 22) <= 2.0
            colour = WHITE if white else PURPLE
            a += 1
            r += colour[0]
            g += colour[1]
            b += colour[2]
    if a == 0:
        return (0, 0, 0, 0)
    return (round(r / a), round(g / a), round(b / a), round(255 * a / total))


def png(size):
    rows = bytearray()
    for j in range(size):
        rows.append(0)
        for i in range(size):
            rows.extend(pixel(size, i, j))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


def main(out):
    images = [png(s) for s in SIZES]
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for size, data in zip(SIZES, images):
        side = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    with open(out, "wb") as f:
        f.write(header + entries + b"".join(images))
    print(f"wrote {out}: sizes {', '.join(map(str, SIZES))}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "devmagic-panel.ico")
