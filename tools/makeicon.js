'use strict';
/**
 * makeicon.js — 纯 Node 生成 1024×1024 PNG 图标（无第三方依赖）
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const SS = 2; // 超采样

const table = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---- 画图 ---- */

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function roundedRectCoverage(x, y, ins, radius) {
  const min = ins;
  const max = SIZE - ins;
  const cx = clamp(x, min + radius, max - radius);
  const cy = clamp(y, min + radius, max - radius);
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.hypot(dx, dy);
  const inside = x >= min && x <= max && y >= min && y <= max;
  if (!inside) return 0;
  const corner = (x < min + radius || x > max - radius) && (y < min + radius || y > max - radius);
  if (!corner) return 1;
  return d <= radius ? 1 : 0;
}

/** 四角星：|x/a|^p + |y/b|^p <= 1 */
function starCoverage(x, y, cx, cy, a, b, p) {
  const nx = Math.abs(x - cx) / a;
  const ny = Math.abs(y - cy) / b;
  return Math.pow(nx, p) + Math.pow(ny, p) <= 1 ? 1 : 0;
}

function render() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const bgTop = hex('#132433');
  const bgBot = hex('#060d14');
  const glowA = hex('#2ee0b8');
  const glowB = hex('#3aa8ff');
  const starA = hex('#ecfff9');
  const starB = hex('#4fd8ff');

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          const bgCov = roundedRectCoverage(fx, fy, 92, 218);
          if (bgCov <= 0) continue;
          // 背景渐变
          const t = fy / SIZE;
          let cr = mix(bgTop[0], bgBot[0], t);
          let cg = mix(bgTop[1], bgBot[1], t);
          let cb = mix(bgTop[2], bgBot[2], t);
          // 右上角光晕
          const gd = Math.hypot((fx - SIZE * 0.72) / (SIZE * 0.62), (fy - SIZE * 0.3) / (SIZE * 0.62));
          const gi = clamp(1 - gd) ** 2;
          cr = mix(cr, glowA[0], gi * 0.42);
          cg = mix(cg, glowA[1], gi * 0.42);
          cb = mix(cb, glowB[2], gi * 0.42);
          // 主星
          const mainCov = starCoverage(fx, fy, SIZE * 0.5, SIZE * 0.48, SIZE * 0.285, SIZE * 0.285, 0.52);
          // 副星
          const subCov = starCoverage(fx, fy, SIZE * 0.7, SIZE * 0.73, SIZE * 0.115, SIZE * 0.115, 0.52);
          // 星晕
          const halo = starCoverage(fx, fy, SIZE * 0.5, SIZE * 0.48, SIZE * 0.38, SIZE * 0.38, 0.5) ? 0.16 : 0;
          if (halo) {
            cr = mix(cr, glowA[0], halo);
            cg = mix(cg, glowA[1], halo);
            cb = mix(cb, glowB[2], halo);
          }
          const starT = clamp((fy - SIZE * 0.2) / (SIZE * 0.6));
          if (mainCov) {
            cr = mix(starA[0], starB[0], starT);
            cg = mix(starA[1], starB[1], starT);
            cb = mix(starA[2], starB[2], starT);
          } else if (subCov) {
            cr = mix(cr, mix(starA[0], starB[0], starT), 0.72);
            cg = mix(cg, mix(starA[1], starB[1], starT), 0.72);
            cb = mix(cb, mix(starA[2], starB[2], starT), 0.72);
          }
          r += cr * bgCov;
          g += cg * bgCov;
          b += cb * bgCov;
          a += bgCov * 255;
        }
      }
      const n = SS * SS;
      const idx = (y * SIZE + x) * 4;
      const alpha = a / n;
      if (alpha <= 0) {
        px[idx] = px[idx + 1] = px[idx + 2] = px[idx + 3] = 0;
      } else {
        px[idx] = Math.round(r / n);
        px[idx + 1] = Math.round(g / n);
        px[idx + 2] = Math.round(b / n);
        px[idx + 3] = Math.round(alpha);
      }
    }
  }
  return px;
}

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
const png = encodePng(SIZE, SIZE, render());
fs.writeFileSync(path.join(out, 'icon.png'), png);
console.log(`icon.png 已生成：${(png.length / 1024).toFixed(1)} KB`);
