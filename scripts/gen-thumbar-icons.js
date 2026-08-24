const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 32;
const SCALE = 4;
const SS = SIZE * SCALE;

const CRC_TABLE = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function createCanvas(size) {
  return new Uint8ClampedArray(size * size * 4);
}

function setPixel(canvas, size, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  canvas[i] = r;
  canvas[i + 1] = g;
  canvas[i + 2] = b;
  canvas[i + 3] = a;
}

function sign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function pointInTriangle(px, py, x0, y0, x1, y1, x2, y2) {
  const d1 = sign(px, py, x0, y0, x1, y1);
  const d2 = sign(px, py, x1, y1, x2, y2);
  const d3 = sign(px, py, x2, y2, x0, y0);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function fillTriangle(canvas, size, tri, r, g, b) {
  const [x0, y0, x1, y1, x2, y2] = tri;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2)));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (pointInTriangle(x + 0.5, y + 0.5, x0, y0, x1, y1, x2, y2)) {
        setPixel(canvas, size, x, y, r, g, b, 255);
      }
    }
  }
}

function fillRoundedRect(canvas, size, rx0, ry0, rx1, ry1, radius, r, g, b) {
  const minX = Math.max(0, Math.floor(rx0));
  const maxX = Math.min(size - 1, Math.ceil(rx1));
  const minY = Math.max(0, Math.floor(ry0));
  const maxY = Math.min(size - 1, Math.ceil(ry1));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (px < rx0 || px > rx1 || py < ry0 || py > ry1) continue;
      let inside = true;
      const corners = [
        [rx0 + radius, ry0 + radius],
        [rx1 - radius, ry0 + radius],
        [rx0 + radius, ry1 - radius],
        [rx1 - radius, ry1 - radius]
      ];
      if (px < rx0 + radius && py < ry0 + radius) {
        inside = Math.hypot(px - corners[0][0], py - corners[0][1]) <= radius;
      } else if (px > rx1 - radius && py < ry0 + radius) {
        inside = Math.hypot(px - corners[1][0], py - corners[1][1]) <= radius;
      } else if (px < rx0 + radius && py > ry1 - radius) {
        inside = Math.hypot(px - corners[2][0], py - corners[2][1]) <= radius;
      } else if (px > rx1 - radius && py > ry1 - radius) {
        inside = Math.hypot(px - corners[3][0], py - corners[3][1]) <= radius;
      }
      if (inside) setPixel(canvas, size, x, y, r, g, b, 255);
    }
  }
}

function downsample(ssCanvas, ssSize, outSize, factor) {
  const out = Buffer.alloc(outSize * outSize * 4);
  for (let y = 0; y < outSize; y++) {
    for (let x = 0; x < outSize; x++) {
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = ((y * factor + sy) * ssSize + (x * factor + sx)) * 4;
          const a = ssCanvas[i + 3];
          rSum += ssCanvas[i] * a;
          gSum += ssCanvas[i + 1] * a;
          bSum += ssCanvas[i + 2] * a;
          aSum += a;
        }
      }
      const count = factor * factor;
      const outA = Math.round(aSum / count);
      const outI = (y * outSize + x) * 4;
      if (aSum > 0) {
        out[outI] = Math.round(rSum / aSum);
        out[outI + 1] = Math.round(gSum / aSum);
        out[outI + 2] = Math.round(bSum / aSum);
      } else {
        out[outI] = 0;
        out[outI + 1] = 0;
        out[outI + 2] = 0;
      }
      out[outI + 3] = outA;
    }
  }
  return out;
}

function renderIcon(drawFn) {
  const canvas = createCanvas(SS);
  drawFn(canvas, SS);
  return downsample(canvas, SS, SIZE, SCALE);
}

function savePNG(name, drawFn) {
  const rgba = renderIcon(drawFn);
  const png = encodePNG(SIZE, SIZE, rgba);
  const outDir = path.join(__dirname, '..', 'app', 'icons');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), png);
  console.log('written', name);
}

const WHITE = [244, 244, 244];

savePNG('thumb-play.png', (canvas, s) => {
  const u = s / 32;
  fillTriangle(canvas, s, [10 * u, 6 * u, 10 * u, 26 * u, 25 * u, 16 * u], ...WHITE);
});

savePNG('thumb-pause.png', (canvas, s) => {
  const u = s / 32;
  fillRoundedRect(canvas, s, 8 * u, 6 * u, 13.5 * u, 26 * u, 2 * u, ...WHITE);
  fillRoundedRect(canvas, s, 18.5 * u, 6 * u, 24 * u, 26 * u, 2 * u, ...WHITE);
});

savePNG('thumb-next.png', (canvas, s) => {
  const u = s / 32;
  fillTriangle(canvas, s, [6 * u, 7 * u, 6 * u, 25 * u, 18 * u, 16 * u], ...WHITE);
  fillRoundedRect(canvas, s, 21 * u, 7 * u, 25 * u, 25 * u, 1.4 * u, ...WHITE);
});

savePNG('thumb-prev.png', (canvas, s) => {
  const u = s / 32;
  fillTriangle(canvas, s, [26 * u, 7 * u, 26 * u, 25 * u, 14 * u, 16 * u], ...WHITE);
  fillRoundedRect(canvas, s, 7 * u, 7 * u, 11 * u, 25 * u, 1.4 * u, ...WHITE);
});
