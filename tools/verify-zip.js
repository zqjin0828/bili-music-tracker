#!/usr/bin/env node
/**
 * 验证 dist zip：逐条解压并与源文件做字节比对（手写解压器，不引入依赖）。
 * 用法: node tools/verify-zip.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const ZIP = path.join(ROOT, 'dist', `bili-music-tracker-v${manifest.version}.zip`);

if (!fs.existsSync(ZIP)) {
  console.error('找不到 zip: ' + ZIP);
  process.exit(1);
}

const buf = fs.readFileSync(ZIP);

// ---------- 最小 ZIP 读取器（只处理 store / deflate） ----------
function readEntries(b) {
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);

  const out = [];
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(off) !== 0x02014b50) throw new Error('bad CDH at ' + off);
    const method = b.readUInt16LE(off + 10);
    const csize = b.readUInt32LE(off + 20);
    const usize = b.readUInt32LE(off + 24);
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const cmtLen = b.readUInt16LE(off + 32);
    const lho = b.readUInt32LE(off + 42);
    const name = b.slice(off + 46, off + 46 + nameLen).toString('utf8');

    // local header
    if (b.readUInt32LE(lho) !== 0x04034b50) throw new Error('bad LH at ' + lho);
    const lNameLen = b.readUInt16LE(lho + 26);
    const lExtraLen = b.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = b.slice(dataStart, dataStart + csize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);

    out.push({ name, method, size: usize, data });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

const entries = readEntries(buf);
console.log('zip: ' + path.relative(ROOT, ZIP));
console.log('条目数: ' + entries.length + '\n');

let bad = 0, checked = 0;
const packed = new Set();

for (const e of entries) {
  if (e.name.endsWith('/')) continue;
  packed.add(e.name);
  const src = path.join(ROOT, e.name);
  if (!fs.existsSync(src)) {
    console.log('  ✗ 包内有但源文件不存在: ' + e.name);
    bad++;
    continue;
  }
  const want = fs.readFileSync(src);
  if (Buffer.compare(want, e.data) !== 0) {
    console.log('  ✗ 字节不一致: ' + e.name +
      ' (源 ' + want.length + ' vs 包内 ' + e.data.length + ')');
    bad++;
    continue;
  }
  checked++;
}

console.log('字节比对: ' + checked + ' 个文件一致，' + bad + ' 个异常\n');

// ---------- 断言关键文件都在 ----------
const MUST = [
  'manifest.json', 'background.js',
  'popup/popup.html', 'popup/popup.css', 'popup/popup.js',
  'src/parser.js', 'src/detector.js', 'src/fav-index.js',
  'src/ai.js', 'src/ai-client.js', 'src/hud.js',   // ★ 本次新增
  'src/content.js', 'src/card.css',
  'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'
];
const missing = MUST.filter(f => !packed.has(f));
if (missing.length) {
  console.log('  ✗ 关键文件缺失: ' + missing.join(', '));
  bad += missing.length;
} else {
  console.log('  ✓ 16 个关键文件全部在包内（含本次新增的 src/hud.js）');
}

// ---------- 包内引用完整性（双向自检的「反向」） ----------
const IMPORT_RE = /importScripts\s*\(([^)]*)\)/g;
const SRC_RE = /<script[^>]+src\s*=\s*["']([^"']+)["']/gi;
const LINK_RE = /<link[^>]+href\s*=\s*["']([^"']+)["']/gi;
const refProblems = [];

function collectRefs(name, text) {
  const refs = [];
  let m;
  while ((m = IMPORT_RE.exec(text))) {
    (m[1].match(/["']([^"']+)["']/g) || []).forEach(q => refs.push(q.slice(1, -1)));
  }
  while ((m = SRC_RE.exec(text))) refs.push(m[1]);
  while ((m = LINK_RE.exec(text))) refs.push(m[1]);
  return refs;
}

for (const e of entries) {
  if (!/\.(js|html)$/i.test(e.name)) continue;
  const text = e.data.toString('utf8');
  for (const ref of collectRefs(e.name, text)) {
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:')) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(e.name), ref));
    if (!packed.has(resolved)) refProblems.push(e.name + ' → ' + ref);
  }
}

if (refProblems.length) {
  console.log('  ✗ 包内引用指向了不存在的文件:');
  refProblems.forEach(p => console.log('      ' + p));
  bad += refProblems.length;
} else {
  console.log('  ✓ 包内 js/html 的全部相对引用都存在于包内');
}

// ---------- manifest 版本 ----------
const mf = JSON.parse(entries.find(e => e.name === 'manifest.json').data.toString('utf8'));
console.log('  ' + (mf.version === manifest.version ? '✓' : '✗') +
  ' manifest 版本一致: ' + mf.version);
if (mf.version !== manifest.version) bad++;

console.log('\n' + (bad === 0 ? '全部通过 ✓' : '发现 ' + bad + ' 个问题 ✗'));
process.exit(bad === 0 ? 0 : 1);
