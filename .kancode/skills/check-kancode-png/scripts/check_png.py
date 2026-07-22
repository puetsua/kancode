#!/usr/bin/env python3
"""Validate a PNG file: existence, magic bytes, chunk integrity, dimensions, and corruption."""

import struct
import sys
import zlib
from pathlib import Path

PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
COLOR_TYPES = {0: 'Grayscale', 2: 'RGB', 3: 'Indexed', 4: 'Grayscale+Alpha', 6: 'RGBA'}
COMPRESSION_METHODS = {0: 'Deflate/Inflate'}
FILTER_METHODS = {0: 'Adaptive'}
INTERLACE_METHODS = {0: 'No interlace', 1: 'Adam7'}


def validate_png(path: str) -> list[str]:
    """Run all PNG validation checks. Returns list of messages (errors or info)."""
    messages: list[str] = []
    p = Path(path)

    # --- Existence ---
    if not p.exists():
        return [f'ERROR: File not found: {path}']
    if not p.is_file():
        return [f'ERROR: Path is not a file: {path}']

    size = p.stat().st_size
    messages.append(f'File size: {size:,} bytes')

    if size < 67:  # minimum valid PNG (IHDR + 1 pixel + IEND)
        messages.append(f'WARNING: File is suspiciously small ({size} bytes)')

    # --- Read raw bytes ---
    data = p.read_bytes()

    # --- Magic bytes ---
    if not data.startswith(PNG_SIGNATURE):
        messages.append('ERROR: Invalid PNG signature (not a PNG file)')
        return messages
    messages.append('PNG signature: OK')

    # --- Chunk walking ---
    pos = 8  # skip signature
    chunk_count = 0
    found_ihdr = False
    found_iend = False
    width = height = bit_depth = color_type = 0

    while pos < len(data):
        if pos + 8 > len(data):
            messages.append(f'ERROR: Truncated chunk header at offset {pos}')
            break

        length = struct.unpack('>I', data[pos:pos + 4])[0]
        chunk_type = data[pos + 4:pos + 8]

        if pos + 12 + length > len(data):
            messages.append(f'ERROR: Chunk {chunk_type!r} at offset {pos} extends beyond file')
            break

        chunk_data = data[pos + 8:pos + 8 + length]
        expected_crc = struct.unpack('>I', data[pos + 8 + length:pos + 12 + length])[0]
        actual_crc = zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF

        if expected_crc != actual_crc:
            messages.append(f'ERROR: CRC mismatch in chunk {chunk_type!r} at offset {pos}')
        else:
            messages.append(f'  Chunk {chunk_type!r}: {length} bytes, CRC OK')

        # --- IHDR parsing ---
        if chunk_type == b'IHDR':
            found_ihdr = True
            if length < 13:
                messages.append('ERROR: IHDR chunk too small')
            else:
                width, height = struct.unpack('>II', chunk_data[0:8])
                bit_depth = chunk_data[8]
                color_type = chunk_data[9]
                compression = chunk_data[10]
                filter_method = chunk_data[11]
                interlace = chunk_data[12]

                messages.append(f'  Dimensions: {width}x{height}')
                messages.append(f'  Bit depth: {bit_depth}')
                messages.append(f'  Color type: {color_type} ({COLOR_TYPES.get(color_type, "Unknown")})')
                messages.append(f'  Compression: {compression} ({COMPRESSION_METHODS.get(compression, "Unknown")})')
                messages.append(f'  Filter method: {filter_method} ({FILTER_METHODS.get(filter_method, "Unknown")})')
                messages.append(f'  Interlace: {interlace} ({INTERLACE_METHODS.get(interlace, "Unknown")})')

                if width == 0 or height == 0:
                    messages.append('ERROR: Zero dimensions in IHDR')
                if bit_depth not in (1, 2, 4, 8, 16):
                    messages.append(f'ERROR: Invalid bit depth {bit_depth}')
                if color_type not in COLOR_TYPES:
                    messages.append(f'ERROR: Invalid color type {color_type}')
                if compression not in COMPRESSION_METHODS:
                    messages.append(f'ERROR: Unknown compression method {compression}')
                if filter_method not in FILTER_METHODS:
                    messages.append(f'ERROR: Unknown filter method {filter_method}')
                if interlace not in INTERLACE_METHODS:
                    messages.append(f'ERROR: Unknown interlace method {interlace}')

        if chunk_type == b'IEND':
            found_iend = True

        pos += 12 + length
        chunk_count += 1

    messages.append(f'Total chunks: {chunk_count}')

    if not found_ihdr:
        messages.append('ERROR: Missing IHDR chunk')
    if not found_iend:
        messages.append('ERROR: Missing IEND chunk (file may be truncated)')

    # --- IDAT decompression test ---
    idat_data = b''
    pos = 8
    while pos < len(data):
        if pos + 8 > len(data):
            break
        length = struct.unpack('>I', data[pos:pos + 4])[0]
        chunk_type = data[pos + 4:pos + 8]
        if pos + 12 + length > len(data):
            break
        if chunk_type == b'IDAT':
            idat_data += data[pos + 8:pos + 8 + length]
        pos += 12 + length

    if idat_data:
        try:
            decompressed = zlib.decompress(idat_data)
            messages.append(f'IDAT decompression: OK ({len(decompressed)} bytes decompressed)')
        except zlib.error as e:
            messages.append(f'ERROR: IDAT decompression failed: {e}')
    else:
        messages.append('WARNING: No IDAT chunks found (empty image?)')

    return messages


def main() -> None:
    if len(sys.argv) < 2:
        print('Usage: check_png.py <path-to-png>')
        sys.exit(1)

    path = sys.argv[1]
    messages = validate_png(path)
    has_error = any(m.startswith('ERROR') for m in messages)

    for m in messages:
        print(m)

    if has_error:
        print('\nResult: FAIL')
        sys.exit(1)
    else:
        print('\nResult: PASS')


if __name__ == '__main__':
    main()
