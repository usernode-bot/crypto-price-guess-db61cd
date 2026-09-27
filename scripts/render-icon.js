// Renders public/icon.png (the homescreen tile declared in dapp.json) from the
// same geometry as public/favicon.svg. No image dependencies: rasterizes with
// 4x4 supersampling and writes the PNG with zlib. Run: node scripts/render-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const SS = 4;
const FROM = [0x8b, 0x5c, 0xf6]; // violet-500, top-left
const TO = [0x4f, 0x46, 0xe5];   // indigo-600, bottom-right
const LINE = [[120, 352], [208, 264], [280, 320], [392, 184]];
const HALF_STROKE = 22;
const DOT = { x: 392, y: 184, r: 38 };

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function onMark(x, y) {
  if (Math.hypot(x - DOT.x, y - DOT.y) <= DOT.r) return true;
  for (let i = 0; i < LINE.length - 1; i++) {
    if (segDist(x, y, LINE[i], LINE[i + 1]) <= HALF_STROKE) return true;
  }
  return false;
}

const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 3 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        if (onMark(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hits++;
      }
    }
    const a = hits / (SS * SS);
    const t = (x + y) / (2 * SIZE);
    const o = y * (SIZE * 3 + 1) + 1 + x * 3;
    for (let c = 0; c < 3; c++) {
      const bg = FROM[c] + (TO[c] - FROM[c]) * t;
      raw[o + c] = Math.round(bg + (255 - bg) * a);
    }
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, '..', 'public', 'icon.png'), png);
console.log('wrote public/icon.png', png.length, 'bytes');
