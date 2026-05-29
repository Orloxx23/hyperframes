/**
 * Generate a 1024x1024 placeholder PNG to use as the icon source for
 * `tauri icon`. The output sits at `src-tauri/icons/source.png`. The Tauri
 * CLI then derives the per-platform variants (.ico, .icns, sized PNGs).
 *
 * This is a deliberately simple radial gradient + "HF" wordmark — the design
 * team can replace `source.png` later and rerun `tauri icon` to regenerate.
 */

import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DESKTOP_ROOT, ensureDir, log } from "./_shared.ts";

const SIZE = 1024;
const ICONS_DIR = resolve(DESKTOP_ROOT, "src-tauri", "icons");

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

function buildPng(size: number): Buffer {
  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR: width, height, bit depth=8, color type=2 (RGB), filter=0, interlace=0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(2, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  // Build raw scanlines: filter byte 0 + RGB triples.
  // Pattern: indigo→violet radial with a centered light disk to evoke a "frame".
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  const cx = size / 2;
  const cy = size / 2;
  const maxR = Math.sqrt(cx * cx + cy * cy);

  for (let y = 0; y < size; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy) / maxR;
      // Radial gradient from indigo (#1e1b4b) to violet (#3b1d6b) to deep magenta
      const t = Math.min(1, r);
      const rChan = Math.round(0x1e + (0x6b - 0x1e) * t);
      const gChan = Math.round(0x1b + (0x1d - 0x1b) * t);
      const bChan = Math.round(0x4b + (0x6b - 0x4b) * t);

      // Inner disk highlight (frame motif)
      const innerR = size * 0.32;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ringThickness = size * 0.04;
      let rOut = rChan;
      let gOut = gChan;
      let bOut = bChan;
      if (Math.abs(dist - innerR) < ringThickness) {
        const m = 1 - Math.abs(dist - innerR) / ringThickness;
        rOut = Math.round(rChan + (255 - rChan) * m * 0.6);
        gOut = Math.round(gChan + (255 - gChan) * m * 0.6);
        bOut = Math.round(bChan + (255 - bChan) * m * 0.6);
      }

      const off = rowStart + 1 + x * 3;
      raw[off] = rOut;
      raw[off + 1] = gOut;
      raw[off + 2] = bOut;
    }
  }

  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

ensureDir(ICONS_DIR);
const outPath = resolve(ICONS_DIR, "source.png");
const png = buildPng(SIZE);
writeFileSync(outPath, png);
log(`✓ Wrote ${outPath} (${(png.length / 1024).toFixed(1)} KB)`);
log(`Next: bunx tauri icon ${outPath}`);
