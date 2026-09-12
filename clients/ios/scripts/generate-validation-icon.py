#!/usr/bin/env python3
"""Generate/check the original opaque validation badge. No external image assets."""
import argparse
from pathlib import Path
import struct
import zlib


def icon_png():
    # A geometric A with three amber test indicators. RGB, no alpha channel.
    rows = bytearray()
    for y in range(1024):
        rows.append(0)
        for x in range(1024):
            color = (15, 26, 43)
            if 190 <= y <= 740:
                radius = (y - 170) * 0.45
                outer = abs(x - 512) <= radius
                inner = abs(x - 512) < max(0, radius - 86)
                if outer and (not inner or 552 <= y <= 626):
                    color = (123, 235, 213)
            if y >= 825:
                color = (29, 43, 63)
                if any((x - cx) ** 2 + (y - 914) ** 2 <= 29 ** 2 for cx in (410, 512, 614)):
                    color = (255, 194, 82)
            rows.extend(color)

    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 1024, 1024, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b''))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    path = Path(__file__).resolve().parents[1] / 'ArcanosVoice/Resources/ValidationAssets.xcassets/ValidationAppIcon.appiconset/ValidationAppIcon.png'
    expected = icon_png()
    if args.check:
        if path.read_bytes() != expected:
            raise SystemExit('FAIL: validation icon differs from its source generator')
        print('PASS: original opaque 1024x1024 validation icon')
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            raise SystemExit('Refusing to overwrite an existing icon; use --check')
        path.write_bytes(expected)
