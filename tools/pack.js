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

// ★ 自动从 manifest 推导需要打包的文件（避免手工清单漏文件）
//
// 曾经的坑：v1.3 新增 src/fav-index.js 后，硬编码清单没同步更新，
// 打出的包里缺了这个文件 → 加载扩展直接报错。
// 改为自动推导后，新增脚本无需再改这里。
function collectFromManifest(manifest) {
  const set = new Set();

  const addFile = (rel) => { if (rel) set.add(rel.replace(/^\.\//, '')); };

  if (manifest.manifest_version === 3) {
    if (manifest.background && manifest.background.service_worker) {
      addFile(manifest.background.service_worker);
    }
    if (Array.isArray(manifest.background && manifest.background.scripts)) {
      manifest.background.scripts.forEach(addFile);
    }
  } else if (manifest.background) {
    if (manifest.background.page) addFile(manifest.background.page);
    (manifest.background.scripts || []).forEach(addFile);
  }

  for (const cs of manifest.content_scripts || []) {
    (cs.js || []).forEach(addFile);
    (cs.css || []).forEach(addFile);
  }

  if (manifest.action && manifest.action.default_popup) addFile(manifest.action.default_popup);
  if (manifest.options_page) addFile(manifest.options_page);
  if (manifest.options_ui && manifest.options_ui.page) addFile(manifest.options_ui.page);
  if (manifest.devtools_page) addFile(manifest.devtools_page);

  const icons = manifest.icons || {};
  Object.values(icons).forEach(addFile);
  if (manifest.action && manifest.action.default_icon) {
    const di = manifest.action.default_icon;
    if (typeof di === 'string') addFile(di);
    else Object.values(di).forEach(addFile);
  }

  for (const war of manifest.web_accessible_resources || []) {
    (war.resources || []).forEach(addFile);
  }

  return set;
}

// 附带一起打包的文档与工具（非必需，但方便分发时带着说明）
const EXTRA_DOCS = [
  'README.md', 'README.old.md', 'DESIGN.md', 'DESIGN-AI.md', 'AI-SETUP.md',
  'tools/install.ps1', 'tools/process-queue.js', 'tools/demo-queue.json'
];

// ★ 间接依赖收集：manifest 之外还「藏着」两类必打文件
//
// 曾经的坑（v1.3.1 打包时发现）：pack.js 只从 manifest 推导清单，
// 会漏掉两类文件，打出的包加载即坏：
//   1) background.js 里 importScripts(...) 引入的脚本 —— manifest 只声明了
//      background.js，ai.js / ai-client.js / parser.js / fav-index.js 都得追进去
//   2) popup.html 里 <script src> / <link href> 引用的同目录文件 —— manifest
//      只声明了 default_popup: popup/popup.html，popup.js / popup.css 会漏
// 现在递归解析这两类引用并自动并入打包清单。
const IMPORT_RE = /importScripts\s*\(([^)]*)\)/g;
const SRC_RE = /<script[^>]+src\s*=\s*["']([^"']+)["']/gi;
const LINK_RE = /<link[^>]+href\s*=\s*["']([^"']+)["']/gi;

function resolveIndirect(seedSet) {
  const out = new Set(seedSet);
  const queue = [...seedSet];

  while (queue.length) {
    const rel = queue.pop();
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const ext = path.extname(rel).toLowerCase();

    let text = null;
    if (ext === '.js') text = fs.readFileSync(full, 'utf8');
    else if (ext === '.html' || ext === '.htm') text = fs.readFileSync(full, 'utf8');
    if (text === null) continue;

    const found = [];
    if (ext === '.js') {
      let m;
      IMPORT_RE.lastIndex = 0;
      while ((m = IMPORT_RE.exec(text))) {
        // importScripts('a.js', 'b.js') → 拆出每个字符串字面量
        const inner = m[1];
        const litRe = /["']([^"']+)["']/g;
        let lm;
        while ((lm = litRe.exec(inner))) found.push(lm[1]);
      }
    } else {
      let m;
      SRC_RE.lastIndex = 0;
      while ((m = SRC_RE.exec(text))) found.push(m[1]);
      LINK_RE.lastIndex = 0;
      while ((m = LINK_RE.exec(text))) found.push(m[1]);
    }

    for (const ref of found) {
      if (/^(https?:)?\/\//i.test(ref) || ref.startsWith('data:')) continue; // 外链跳过
      // 以引用文件所在目录为基准解析相对路径
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(rel), ref)
      ).replace(/^\.\//, '');
      if (!out.has(resolved)) { out.add(resolved); queue.push(resolved); }
    }
  }
  return out;
}

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

// 从 manifest 自动推导 + 追间接依赖 + 追加文档
const autoSet = resolveIndirect(collectFromManifest(manifest));
const INCLUDE = ['manifest.json', ...Array.from(autoSet).sort(), ...EXTRA_DOCS];

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

// ★ 自检：包里的每个 JS/HTML 文件所引用的本地资源，必须也在包里
// （双向校验 —— 旧版只查「manifest 声明的都打了吗」，查不出反向遗漏）
const packed = new Set(files.map(f => f.name));
const refProblems = [];
for (const f of files) {
  const ext = path.extname(f.name).toLowerCase();
  if (ext !== '.js' && ext !== '.html' && ext !== '.htm') continue;
  const text = f.data.toString('utf8');
  const refs = [];
  if (ext === '.js') {
    let m; IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(text))) {
      const litRe = /["']([^"']+)["']/g; let lm;
      while ((lm = litRe.exec(m[1]))) refs.push(lm[1]);
    }
  } else {
    let m; SRC_RE.lastIndex = 0;
    while ((m = SRC_RE.exec(text))) refs.push(m[1]);
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(text))) refs.push(m[1]);
  }
  for (const ref of refs) {
    if (/^(https?:)?\/\//i.test(ref) || ref.startsWith('data:')) continue;
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(f.name), ref)
    ).replace(/^\.\//, '');
    if (!packed.has(resolved)) refProblems.push(`${f.name} → ${resolved}`);
  }
}
if (refProblems.length) {
  console.error('❌ 打包自检失败：以下被引用的文件未打进包：');
  for (const p of refProblems) console.error('   · ' + p);
  process.exit(1);
}
console.log('自检通过：manifest 声明的 ' + collectFromManifest(manifest).size +
            ' 个文件 + 间接依赖均已打包，包内引用完整');

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
