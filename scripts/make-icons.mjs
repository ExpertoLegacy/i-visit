import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(size, pixelAt) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = pixelAt(x, y);
      const offset = y * (stride + 1) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [7, 13, 24];
const INK = [230, 237, 247];
const ACCENT = [61, 220, 151];

function render(size) {
  const margin = size * 0.14;
  const finder = size * 0.24;
  const module = finder / 7;
  const boxes = [
    [margin, margin],
    [size - margin - finder, margin],
    [margin, size - margin - finder],
  ];

  return (px, py) => {
    // Green corner accent mark.
    const accentBox = [size - margin - finder * 0.55, size - margin - finder * 0.55, finder * 0.55];
    if (px >= accentBox[0] && py >= accentBox[1] && px < accentBox[0] + accentBox[2] && py < accentBox[1] + accentBox[2]) {
      return ACCENT;
    }

    for (const [bx, by] of boxes) {
      const dx = px - bx;
      const dy = py - by;
      if (dx < 0 || dy < 0 || dx >= finder || dy >= finder) continue;
      const u = Math.floor(dx / module);
      const v = Math.floor(dy / module);
      if (u > 6 || v > 6) continue;
      const ring = !(u >= 1 && u <= 5 && v >= 1 && v <= 5);
      const core = u >= 2 && u <= 4 && v >= 2 && v <= 4;
      if (ring || core) return INK;
    }
    return BG;
  };
}

const outDir = path.join(import.meta.dirname, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const png = encodePng(size, render(size));
  const file = path.join(outDir, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${path.relative(process.cwd(), file)} (${png.length} bytes)`);
}
