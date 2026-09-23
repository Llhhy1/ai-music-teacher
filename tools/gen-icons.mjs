/**
 * gen-icons.mjs — 零依赖 PNG 图标生成
 * 直接构造 RGBA 像素并用 Node 内置 zlib 压缩成 PNG。
 * 运行：npm run icons
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');
mkdirSync(OUT, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 音符局部坐标：返回该像素是否落在八分音符内 */
function inNote(x, y, S) {
  // 符头（旋转 -18° 的椭圆）
  const hx = 0.335 * S, hy = 0.715 * S;
  const rx = 0.165 * S, ry = 0.118 * S;
  const ang = -0.31;
  const dx = x - hx, dy = y - hy;
  const lx = dx * Math.cos(ang) - dy * Math.sin(ang);
  const ly = dx * Math.sin(ang) + dy * Math.cos(ang);
  if ((lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1) return true;

  // 符干
  const stemX = 0.485 * S, stemW = 0.048 * S;
  const stemTop = 0.215 * S, stemBot = 0.70 * S;
  if (x >= stemX && x <= stemX + stemW && y >= stemTop && y <= stemBot) return true;

  // 符尾：从符干顶端向右下鼓出的一片
  const flagTop = 0.215 * S, flagH = 0.30 * S;
  if (y >= flagTop && y <= flagTop + flagH) {
    const k = (y - flagTop) / flagH;          // 0→1
    const bulge = Math.sin(k * Math.PI * 0.92) * 0.145 * S + 0.02 * S;
    if (x >= stemX + stemW && x <= stemX + stemW + bulge) return true;
  }
  return false;
}

function render(S, { rounded = false } = {}) {
  const rgba = Buffer.alloc(S * S * 4);

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const u = px / S, v = py / S;
      const i = (py * S + px) * 4;

      // 背景：左上紫 → 右下青的对角渐变 + 轻微径向高光
      let r = 30 + (u * 0.6 + v * 0.4) * 40;
      let g = 24 + (u * 0.6 + v * 0.4) * 90;
      let b = 92 + (u * 0.6 + v * 0.4) * 90;
      const glow = Math.max(0, 1 - Math.hypot(u - 0.25, v - 0.2) * 1.6);
      r += glow * 70; g += glow * 40; b += glow * 60;

      let alpha = 255;

      // 圆角遮罩（非 maskable 版本用）
      if (rounded) {
        const rad = 0.19;
        const cx = Math.min(Math.max(u, rad), 1 - rad);
        const cy = Math.min(Math.max(v, rad), 1 - rad);
        const d = Math.hypot(u - cx, v - cy);
        if (d > rad) alpha = 0;
        else if (d > rad - 0.008) alpha = Math.round(255 * (rad - d) / 0.008);
      }

      // 音符（白色，带一点青色高光）
      if (inNote(px, py, S)) {
        r = 245; g = 248; b = 255;
      } else {
        // 背景里的同心声波弧
        const cx2 = 0.78 * S, cy2 = 0.76 * S;
        const d = Math.hypot(px - cx2, py - cy2) / S;
        for (const rr of [0.16, 0.24]) {
          if (Math.abs(d - rr) < 0.011) { r = Math.min(255, r + 55); g = Math.min(255, g + 75); b = Math.min(255, b + 65); }
        }
      }

      rgba[i] = Math.max(0, Math.min(255, r | 0));
      rgba[i + 1] = Math.max(0, Math.min(255, g | 0));
      rgba[i + 2] = Math.max(0, Math.min(255, b | 0));
      rgba[i + 3] = alpha;
    }
  }
  return rgba;
}

for (const S of [192, 512]) {
  writeFileSync(join(OUT, `icon-${S}.png`), encodePNG(S, S, render(S)));
  writeFileSync(join(OUT, `icon-maskable-${S}.png`), encodePNG(S, S, render(S)));
  console.log(`✓ icons/icon-${S}.png`);
}
console.log('图标已生成 →', OUT);
