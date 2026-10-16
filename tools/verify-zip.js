/**
 * 校验 docs/downloads/imagegrab.zip：
 *   1. 解析 ZIP 中央目录，列出内部条目（确认根目录直接是 manifest.json）。
 *   2. 解压每个条目并校验 CRC32 与字节数。
 *   3. 与 extension/ 目录逐文件比对，确认没有缺失、没有多余、内容一致。
 *
 * 用法：node tools/verify-zip.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'extension');
const ZIP_FILE = path.join(ROOT, 'docs', 'downloads', 'imagegrab.zip');

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

/** 解析 ZIP，返回条目数组 */
function readZip(buf) {
  // 从尾部向前找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件：找不到 EOCD');

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录第 ' + i + ' 条记录损坏');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // 本地头里的文件名长度可能与中央目录不同，必须按本地头读取数据起点
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(name + ' 的本地文件头损坏');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);

    entries.push({ name, method, crc, size, data });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function listFiles(dir, prefix) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push.apply(out, listFiles(abs, rel));
    else if (entry.isFile() && !entry.name.startsWith('.')) out.push(rel);
  }
  return out;
}

function main() {
  if (!fs.existsSync(ZIP_FILE)) {
    console.error('找不到 ZIP 文件：' + path.relative(ROOT, ZIP_FILE) + '\n请先执行 npm run build:zip');
    process.exit(1);
  }

  const buf = fs.readFileSync(ZIP_FILE);
  const entries = readZip(buf);
  const problems = [];

  console.log('ZIP 文件：' + path.relative(ROOT, ZIP_FILE) + '（' + buf.length + ' 字节）');
  console.log('条目数量：' + entries.length);
  console.log('');

  // 1) 顶部目录检查
  if (!entries.some(function (e) { return e.name === 'manifest.json'; })) {
    problems.push('ZIP 根目录下没有 manifest.json（可能存在多余的顶层目录）');
  }
  for (const e of entries) {
    if (e.name.indexOf('/') >= 0 && e.name.split('/')[0] === 'extension') {
      problems.push('发现了多余的 extension/ 顶层目录：' + e.name);
    }
  }

  // 2) 逐条校验 CRC 与大小
  let total = 0;
  for (const e of entries) {
    total += e.data.length;
    if (e.data.length !== e.size) problems.push(e.name + ' 解压后大小不符：' + e.data.length + ' != ' + e.size);
    if (crc32(e.data) !== e.crc) problems.push(e.name + ' CRC32 校验失败');
    console.log(
      '  ' + e.name.padEnd(28, ' ') + String(e.size).padStart(8, ' ') + ' 字节  方法=' + (e.method === 8 ? 'deflate' : 'stored')
    );
  }
  console.log('');
  console.log('解压后总大小：' + total + ' 字节');

  // 3) 与源码目录比对
  const zipNames = entries.map(function (e) { return e.name; }).sort();
  const srcNames = listFiles(SRC_DIR, '');
  const missing = srcNames.filter(function (n) { return zipNames.indexOf(n) < 0; });
  const extra = zipNames.filter(function (n) { return srcNames.indexOf(n) < 0; });
  const mismatch = [];
  for (const e of entries) {
    const abs = path.join(SRC_DIR, e.name);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs);
    if (!src.equals(e.data)) mismatch.push(e.name);
  }

  if (missing.length) problems.push('ZIP 缺少文件：' + missing.join(', '));
  if (extra.length) problems.push('ZIP 多出文件：' + extra.join(', '));
  if (mismatch.length) problems.push('文件内容不一致：' + mismatch.join(', '));

  console.log('');
  if (problems.length) {
    console.log('校验未通过：');
    for (const p of problems) console.log('  - ' + p);
    process.exit(1);
  }
  console.log('校验通过：ZIP 内文件与 extension/ 目录完全一致，且根目录可直接加载。');
}

main();
