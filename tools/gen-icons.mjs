// Generates the PWA icon set into client/public/ — no image libraries needed.
// Design: the ledger glyph — three ruled lines on the ink-blue ground, the top
// line in reconciled green. Matches the favicon.svg mark.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'client', 'public');
mkdirSync(outDir, { recursive: true });

const BG = [24, 34, 51]; // #182233 — theme ink
const GREEN = [30, 127, 92]; // #1E7F5C — reconciled
const PAPER = [240, 239, 235]; // warm paper white

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rows) {
  // rows: Buffer of RGBA pixels, top-down, size*4 bytes per row
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    rows.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function render(size, { pad = 0 } = {}) {
  const img = Buffer.alloc(size * size * 4);
  const put = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, BG);

  // Ledger lines: three horizontal bars, centred, rounded ends as square caps.
  const inset = Math.round(size * (pad ? pad : 0.22));
  const width = size - inset * 2;
  const barH = Math.max(2, Math.round(size * 0.055));
  const gap = Math.round(size * 0.11);
  const top = Math.round(size / 2 - (barH * 3 + gap * 2) / 2);
  for (let line = 0; line < 3; line++) {
    const y0 = top + line * (barH + gap);
    const colour = line === 0 ? GREEN : PAPER;
    const w = line === 2 ? Math.round(width * 0.6) : width; // bottom line shorter
    for (let y = y0; y < y0 + barH; y++) for (let x = inset; x < inset + w; x++) put(x, y, colour);
  }
  return png(size, img);
}

const jobs = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-192.png', 192, { pad: 0.3 }],
  ['icon-maskable-512.png', 512, { pad: 0.3 }],
  ['apple-touch-icon.png', 180, {}],
];
for (const [name, size, opts] of jobs) {
  writeFileSync(join(outDir, name), render(size, opts));
  console.log('wrote', name);
}
