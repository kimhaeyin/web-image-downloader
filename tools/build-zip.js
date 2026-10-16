/**
 * 把 extension/ 目录打包成可以直接加载的 ZIP。
 *
 * 要求：ZIP 内部直接是 manifest.json 等文件，不能多套一层目录。
 * 这里自己写 ZIP 容器（而不是用 Compress-Archive），是为了让条目分隔符、
 * 编码标志和压缩方式在不同平台上都保持一致，打包结果可复现。
 *
 * 用法：node tools/build-zip.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'docs', 'downloads');
const OUT_FILE = path.join(OUT_DIR, 'imagegrab.zip');

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 换行符归一
// ---------------------------------------------------------------------------

/**
 * 把文本文件的 CRLF 统一成 LF。
 *
 * 仓库用 .gitattributes 约定一律 LF，但磁盘上的实际换行符取决于本地的
 * core.autocrlf、检出时机和编辑器设置。打包前统一一次，才能保证在任何
 * 平台上打出的都是同一份字节，官网显示的 SHA-256 也就不会漂移。
 *
 * 含 NUL 字节的按二进制处理，原样返回（PNG 数据里可能恰好出现 0D 0A）。
 */
function normalizeEol(buf) {
  if (buf.indexOf(0) >= 0) return buf;
  return Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

// ---------------------------------------------------------------------------
// 收集文件
// ---------------------------------------------------------------------------

/** 递归列出 extension/ 下的所有文件，返回相对路径（统一使用 / 分隔） */
function listFiles(dir, prefix) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      out.push.apply(out, listFiles(abs, rel));
    } else if (entry.isFile()) {
      if (entry.name.startsWith('.')) continue; // 跳过隐藏文件
      out.push(rel);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ZIP 写入
// ---------------------------------------------------------------------------

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

function buildZip(files) {
  const chunks = [];
  const central = [];
  const normalized = [];
  let offset = 0;

  // 固定时间戳，保证同样的输入产生同样的 ZIP 字节
  const stamp = dosDateTime(new Date(2024, 0, 1, 0, 0, 0));

  for (const rel of files) {
    const abs = path.join(SRC_DIR, rel);
    const raw = fs.readFileSync(abs);
    const data = normalizeEol(raw);
    if (!data.equals(raw)) normalized.push(rel);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // 压不下去的就用存储方式，避免越压越大
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(rel, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(stamp.time, 12);
    cd.writeUInt16LE(stamp.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return { zip: Buffer.concat([Buffer.concat(chunks), centralBuf, eocd]), normalized: normalized };
}

// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error('找不到 extension 目录：' + SRC_DIR);
    process.exit(1);
  }

  const manifestPath = path.join(SRC_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('extension 目录下缺少 manifest.json，无法打包');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const files = listFiles(SRC_DIR, '');
  const built = buildZip(files);
  const zip = built.zip;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, zip);

  console.log('插件版本：' + manifest.version);
  console.log('打包文件数：' + files.length);
  files.forEach(function (f) {
    console.log('  + ' + f);
  });
  if (built.normalized.length) {
    console.log(
      '换行符已从 CRLF 归一为 LF：' + built.normalized.length + ' 个文件' +
      '（' + built.normalized.join(', ') + '）'
    );
  }
  console.log('输出：' + path.relative(ROOT, OUT_FILE) + '（' + zip.length + ' 字节）');
}

main();
