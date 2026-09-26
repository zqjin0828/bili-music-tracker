#!/usr/bin/env node
/**
 * validate-detector.js — 用「人工核对过的清单」评估判定器准确率
 *
 * 数据：430 首确认音乐 + 1933 首非音乐（都来自我逐条核对过的结果）
 * 这是唯一能真实衡量判定器好坏的样本，比凭空写正反例可靠得多。
 *
 * 用法：node tools/validate-detector.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
global.BiliParser = require(path.join(ROOT, 'src', 'parser.js'));
const D = require(path.join(ROOT, 'src', 'detector.js'));

const FAV = '__HOME__/WorkBuddy/2026-09-18-01-36-00/bili-fav-from-history';
const f5 = JSON.parse(fs.readFileSync(path.join(FAV, 'final.json'), 'utf8'));
const f34 = JSON.parse(fs.readFileSync(path.join(FAV, 'final34.json'), 'utf8'));
const cache = JSON.parse(fs.readFileSync(path.join(FAV, 'enrich-cache.json'), 'utf8'));

const musicRows = [...f5.tierA, ...f5.tierB, ...f34.single, ...f34.compilation];
const nonRows = [...(f5.excluded || []), ...(f34.nonMusic || [])];

function evaluate(rows, expected) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const errors = [];
  for (const r of rows) {
    const c = cache[r.id];
    if (!c || !c.ok) continue;
    const d = c.data;
    const res = D.detectMusic({
      tid: d.tid, title: d.title, upName: d.owner || '',
      duration: d.duration || 0, tname: d.tname || ''
    });
    const got = res.isMusic;
    if (expected && got) tp++;
    else if (expected && !got) { fn++; errors.push({ r, d, res, kind: '漏判(音乐被判非音乐)' }); }
    else if (!expected && got) { fp++; errors.push({ r, d, res, kind: '误纳(非音乐被判音乐)' }); }
    else tn++;
  }
  return { tp, fp, fn, tn, errors };
}

const m = evaluate(musicRows, true);
const n = evaluate(nonRows, false);

const recall = m.tp / (m.tp + m.fn);
const precision = (m.tp + m.fp) ? m.tp / (m.tp + m.fp) : 1;
const totalAcc = (m.tp + n.tn) / (m.tp + m.fn + n.tp + n.fp);

console.log('════════════════════════════════════════════════');
console.log('判定器评估（对 430 首音乐 + 1933 首非音乐）');
console.log('════════════════════════════════════════════════');
console.log('  音乐样本  : ' + (m.tp + m.fn) + '   判对 ' + m.tp + '   漏判 ' + m.fn +
  '   → 召回率 ' + (recall * 100).toFixed(1) + '%');
console.log('  非音乐样本: ' + (n.tn + n.fp) + '   判对 ' + n.tn + '   误纳 ' + n.fp +
  '   → 非音乐正确率 ' + ((n.tn / (n.tn + n.fp)) * 100).toFixed(1) + '%');
console.log('  总体准确率: ' + (totalAcc * 100).toFixed(1) + '%');

// ---------- 阈值扫描：用「原始分」找最优点 ----------
// 判定器现在用原始分决策，所以扫描 score 而不是 confidence
const sMusic = [];
const sNon = [];
for (const r of musicRows) {
  const c = cache[r.id]; if (!c || !c.ok) continue;
  const d = c.data;
  sMusic.push(D.detectMusic({ tid: d.tid, title: d.title, upName: d.owner || '', duration: d.duration || 0, tname: d.tname || '' }).score);
}
for (const r of nonRows) {
  const c = cache[r.id]; if (!c || !c.ok) continue;
  const d = c.data;
  sNon.push(D.detectMusic({ tid: d.tid, title: d.title, upName: d.owner || '', duration: d.duration || 0, tname: d.tname || '' }).score);
}

console.log('\n=== 原始分阈值扫描（挑 F1 最高点）===');
console.log('阈值    召回率   非音乐正确率   精确率     F1');
let best = null;
for (let th = 0.5; th <= 6.0; th += 0.5) {
  const t = Number(th.toFixed(2));
  const tp = sMusic.filter(s => s >= t).length;
  const fn = sMusic.length - tp;
  const fp = sNon.filter(s => s >= t).length;
  const tn = sNon.length - fp;
  const rec = tp / (tp + fn);
  const nonAcc = tn / (tn + fp);
  const prec = (tp + fp) ? tp / (tp + fp) : 1;
  const f1 = (prec + rec) ? 2 * prec * rec / (prec + rec) : 0;
  const mark = (best === null || f1 > best.f1) ? '  ← 最佳 F1' : '';
  if (best === null || f1 > best.f1) best = { t, f1, rec, nonAcc, prec };
  console.log(
    t.toFixed(1).padEnd(7) +
    (rec * 100).toFixed(1).padStart(5) + '%   ' +
    (nonAcc * 100).toFixed(1).padStart(6) + '%    ' +
    (prec * 100).toFixed(1).padStart(6) + '%   ' +
    f1.toFixed(3) + mark
  );
}
console.log('\n推荐原始分阈值: ' + best.t +
  '   (召回 ' + (best.rec * 100).toFixed(1) +
  '%, 非音乐正确率 ' + (best.nonAcc * 100).toFixed(1) +
  '%, 精确率 ' + (best.prec * 100).toFixed(1) + '%)');

console.log('\n=== 原始分分布 ===');
{
  const buckets = [-6, -2, 0, 1.5, 2.5, 3.5, 5, 8, 99];
  const out = [];
  for (let i = 0; i < buckets.length - 1; i++) {
    const lo = buckets[i], hi = buckets[i + 1];
    out.push(lo + '~' + (hi > 90 ? '∞' : hi) + ':' +
      sMusic.filter(s => s >= lo && s < hi).length + '/' +
      sNon.filter(s => s >= lo && s < hi).length);
  }
  console.log('  (音乐数/非音乐数)  ' + out.join('  '));
}

if (m.errors.length) {
  console.log('\n--- 漏判的音乐（前 20）---');
  m.errors.slice(0, 20).forEach(e => {
    console.log('  ' + e.r.id + '  tid=' + String(e.d.tid).padEnd(5) + String(e.d.duration) + 's  conf=' + e.res.confidence);
    console.log('      ' + String(e.d.title).slice(0, 58));
    console.log('      ' + JSON.stringify(e.res.reasons).slice(0, 120));
  });
  if (m.errors.length > 20) console.log('  …还有 ' + (m.errors.length - 20) + ' 首');
}

if (n.errors.length) {
  console.log('\n--- 误纳的非音乐（前 15）---');
  n.errors.slice(0, 15).forEach(e => {
    console.log('  ' + e.r.id + '  tid=' + String(e.d.tid).padEnd(5) + String(e.d.duration) + 's  conf=' + e.res.confidence);
    console.log('      ' + String(e.d.title).slice(0, 58));
  });
  if (n.errors.length > 15) console.log('  …还有 ' + (n.errors.length - 15) + ' 个');
}

// 按分区统计漏判分布，定位还剩哪些分区没覆盖
const byTid = {};
for (const e of m.errors) byTid[e.d.tid] = (byTid[e.d.tid] || 0) + 1;
if (Object.keys(byTid).length) {
  console.log('\n--- 漏判的分区分布（用于继续补分区表）---');
  Object.entries(byTid).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .forEach(([t, c]) => console.log('  tid=' + String(t).padEnd(6) + c + ' 首'));
}

process.exit(0);
