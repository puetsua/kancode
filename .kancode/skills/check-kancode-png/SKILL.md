---
name: check-kancode-png
description: Validate the kancode.png icon file for existence, PNG validity, dimensions, chunk integrity, and corruption. Use when the user asks to check, verify, inspect, or validate the kancode.png icon or any PNG file in the project.
---

# Check KanCode PNG

## Usage

Run the validation script against the kancode.png file:

```bash
python .kancode/skills/check-kancode-png/scripts/check_png.py assets/kancode.png
```

The script checks:

- **Existence** — file exists and is not empty
- **PNG signature** — correct magic bytes (`\x89PNG\r\n\x1a\n`)
- **Chunk integrity** — all chunks have valid CRC checksums
- **IHDR metadata** — dimensions, bit depth, color type, compression, filter, interlace
- **IEND presence** — file is not truncated
- **IDAT decompression** — pixel data decompresses without error

## Output

On success the script prints metadata and exits with code 0. On failure it prints `ERROR:` lines and exits with code 1.

## Script

The script at `scripts/check_png.py` uses only Python stdlib (`struct`, `zlib`). It can also be called on any other PNG file by passing the path as an argument.
