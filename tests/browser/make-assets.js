/**
 * 为浏览器端测试生成示例图片（本地文件，不依赖任何外部资源）。
 *
 * 用法：node tests/browser/make-assets.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const png = require(path.join(__dirname, '..', '..', 'tools', 'png.js'));

const OUT_DIR = path.join(__dirname, 'assets');

/** 需要生成的文件：文件名 -> [宽, 高, RGB 颜色] */
const ASSETS = {
  'main.png': [800, 800, [59, 130, 246]],
  'main-400.png': [400, 400, [59, 130, 246]],
  'main-800.png': [800, 800, [37, 99, 235]],
  'detail-1.png': [750, 1100, [124, 58, 237]],
  'detail-2.png': [750, 1100, [139, 92, 246]],
  'lazy.png': [600, 600, [16, 185, 129]],
  'bg.png': [900, 600, [245, 158, 11]],
  'icon-32.png': [32, 32, [148, 163, 184]],
  'small-32.png': [32, 32, [100, 116, 139]],
  'pixel-1x1.png': [1, 1, [0, 0, 0]],
  'hero-preview.png': [1200, 750, [37, 99, 235]]
};

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const name of Object.keys(ASSETS)) {
    const cfg = ASSETS[name];
    const rgba = png.swatch(cfg[0], cfg[1], cfg[2]);
    const buf = png.encodePng(cfg[0], cfg[1], rgba);
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, buf);
    console.log('已生成 ' + path.relative(path.join(__dirname, '..', '..'), file) + ' (' + cfg[0] + 'x' + cfg[1] + ', ' + buf.length + ' 字节)');
  }
}

main();
