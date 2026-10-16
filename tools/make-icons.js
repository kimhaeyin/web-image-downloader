/**
 * 生成插件图标 PNG（只依赖 Node 内置模块和 tools/png.js）
 *
 * 图形的做法：蓝色到紫色渐变的圆角方块 + 白色相框、太阳与山丘，
 * 每像素做 4x4 超采样以获得平滑边缘。
 *
 * 用法：node tools/make-icons.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const encodePng = require(path.join(__dirname, 'png.js')).encodePng;

const OUT_DIR = path.join(__dirname, '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const SAMPLES = 4; // 每个像素 4x4 超采样

// ---------------------------------------------------------------------------
// 颜色与几何小工具
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 圆角矩形的近似有向距离（中心在原点，halfW/halfH 为半宽半高，r 为圆角半径） */
function sdRoundRect(px, py, halfW, halfH, r) {
  const qx = Math.abs(px) - (halfW - r);
  const qy = Math.abs(py) - (halfH - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

/** 点是否在三角形内（用叉积同号判断） */
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// ---------------------------------------------------------------------------
// 图标绘制：输入归一化坐标（-0.5 ~ 0.5），返回 [r, g, b] 或 null（透明）
// ---------------------------------------------------------------------------

const BLUE = [37, 99, 235];
const VIOLET = [124, 58, 237];
const WHITE = [255, 255, 255];

function sampleAt(x, y) {
  // 1. 圆角方块背景 + 渐变
  if (sdRoundRect(x, y, 0.5, 0.5, 0.22) > 0) return null;
  const t = clamp((x + y + 1) / 2, 0, 1);
  const color = [
    Math.round(lerp(BLUE[0], VIOLET[0], t)),
    Math.round(lerp(BLUE[1], VIOLET[1], t)),
    Math.round(lerp(BLUE[2], VIOLET[2], t))
  ];

  // 2. 白色相框（内缩的圆角矩形描边）
  if (Math.abs(sdRoundRect(x, y, 0.31, 0.31, 0.09)) <= 0.028) return WHITE;

  // 3. 太阳
  if (Math.hypot(x + 0.13, y + 0.12) <= 0.058) return WHITE;

  // 4. 山丘
  if (pointInTriangle(x, y, -0.2, 0.19, 0.0, -0.1, 0.2, 0.19)) return WHITE;

  return color;
}

/** 用超采样把图标渲染成 RGBA 像素缓冲 */
function renderIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SAMPLES);
  const n = SAMPLES * SAMPLES;

  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const u = (pxi * SAMPLES + sx + 0.5) * step;
          const v = (py * SAMPLES + sy + 0.5) * step;
          const c = sampleAt(u - 0.5, v - 0.5);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 255;
          }
        }
      }
      const idx = (py * size + pxi) * 4;
      const alpha = a / n;
      if (alpha <= 0) {
        px[idx] = 0;
        px[idx + 1] = 0;
        px[idx + 2] = 0;
        px[idx + 3] = 0;
      } else {
        // 按覆盖率反推前景色，避免边缘发黑
        const cover = alpha / 255;
        px[idx] = Math.round(r / n / cover);
        px[idx + 1] = Math.round(g / n / cover);
        px[idx + 2] = Math.round(b / n / cover);
        px[idx + 3] = Math.round(alpha);
      }
    }
  }
  return px;
}

// ---------------------------------------------------------------------------

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const rgba = renderIcon(size);
    const buffer = encodePng(size, size, rgba);
    const file = path.join(OUT_DIR, 'icon' + size + '.png');
    fs.writeFileSync(file, buffer);
    console.log('已生成 ' + path.relative(path.join(__dirname, '..'), file) + ' (' + buffer.length + ' 字节)');
  }
}

main();
