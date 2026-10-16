/**
 * 最小 PNG 编码器（RGBA / 8 位），只用 Node 内置的 zlib，不引入任何第三方依赖。
 * 被 tools/make-icons.js 和测试用的图片生成脚本共用。
 */

'use strict';

const zlib = require('zlib');

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  CRC_TABLE = table;
  return table;
}

function crc32(buf) {
  const table = crcTable();
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

/** 把 RGBA 像素缓冲编码成 PNG */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: None
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 画一张带渐变斜纹的纯色图，用于测试时区分不同图片 */
function swatch(width, height, color) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const stripe = (x + y) % 24 < 12 ? 1 : 0.82;
      const edge = x < 2 || y < 2 || x >= width - 2 || y >= height - 2 ? 0.55 : 1;
      rgba[i] = Math.round(color[0] * stripe * edge);
      rgba[i + 1] = Math.round(color[1] * stripe * edge);
      rgba[i + 2] = Math.round(color[2] * stripe * edge);
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

module.exports = { encodePng: encodePng, swatch: swatch, crc32: crc32 };
