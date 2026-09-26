#!/usr/bin/env node
/**
 * pack.js — 打包扩展为 zip（零依赖，用 zlib + 手写 zip 结构）
 *
 * 用法：node tools/pack.js
 * 产出：dist/bili-music-tracker-<version>.zip
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');

// 打包清单（显式列出，避免把测试和开发文件塞进去）
const INCLUDE = [
  'manifest.json', 'background.js',
  'src/parser.js', 'src/detector.js', 'src/ai.js', 'src/ai-client.js',
  'src/content.js', 'src/card.css',
  'popup/popup.html', 'popup/popup.css', 'popup/popup.js',
  'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png',
  'tools/process-queue.js', 'tools/demo-queue.json',
  'README.md', 'DESIGN.md', 'DESIGN-AI.md', 'AI-SETUP.md'
];

// ---------- CRC32 ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- ZIP 写入 ----------

function dosDateTime(d) {
  // DOS 时间格式：日期高 16 位，时间低 16 位
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time, date };
}

function buildZip(files) {
  const now = new Date();
  const { time, date } = dosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // 压缩后反而更大时用 STORE
    const useDeflate = deflated.length < data.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : data;

    // ---- local file header ----
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);      // signature
    lh.writeUInt16LE(20, 4);              // version needed
    lh.writeUInt16LE(0, 6);               // flags
    lh.writeUInt16LE(method, 8);          // compression
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18); // compressed size
    lh.writeUInt32LE(data.length, 22);    // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);              // extra length

    localParts.push(lh, nameBuf, payload);

    // ---- central directory header ----
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);      // signature
    ch.writeUInt16LE(20, 4);              // version made by
    ch.writeUInt16LE(20, 6);              // version needed
    ch.writeUInt16LE(0, 8);               // flags
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);              // extra
    ch.writeUInt16LE(0, 32);              // comment
    ch.writeUInt16LE(0, 34);              // disk number
    ch.writeUInt16LE(0, 36);              // internal attrs
    ch.writeUInt32LE(0, 38);              // external attrs
    ch.writeUInt32LE(offset, 42);         // local header offset

    centralParts.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);

  // ---- end of central directory ----
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);               // disk number
  eocd.writeUInt16LE(0, 6);               // disk with central dir
  eocd.writeUInt16LE(files.length, 8);    // entries on this disk
  eocd.writeUInt16LE(files.length, 10);   // total entries
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);         // central dir offset
  eocd.writeUInt16LE(0, 20);              // comment length

  return Buffer.concat([Buffer.concat(localParts), centralDir, eocd]);
}

// ---------- 主流程 ----------

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;

const files = [];
let missing = [];
let rawTotal = 0;

for (const rel of INCLUDE) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) { missing.push(rel); continue; }
  const data = fs.readFileSync(full);
  rawTotal += data.length;
  files.push({ name: rel, data });
}

if (missing.length) {
  console.error('缺少文件：' + missing.join(', '));
  process.exit(1);
}

const zip = buildZip(files);
const distDir = path.join(ROOT, 'dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

const outName = `bili-music-tracker-v${version}.zip`;
const outPath = path.join(distDir, outName);
fs.writeFileSync(outPath, zip);

console.log(`打包完成：dist/${outName}`);
console.log(`  文件数   ${files.length}`);
console.log(`  原始大小 ${rawTotal.toLocaleString()} 字节`);
console.log(`  压缩后   ${zip.length.toLocaleString()} 字节`);
console.log(`  压缩率   ${(100 - zip.length / rawTotal * 100).toFixed(1)}%`);
console.log(`  版本     v${version}`);
