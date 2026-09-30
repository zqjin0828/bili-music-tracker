#!/usr/bin/env node
/**
 * analyze-tids.js — 用「已人工核对的音乐清单」反推：哪些分区真的有音乐
 *
 * 数据来源：
 *   final.json（≥5 次，我逐条复核过）+ final34.json（3-4 次）
 *   的 tierA/single + tierB/compilation = 430 首确认音乐
 *
 * 目的：给 detector.js 的 MUSIC_TIDS / NEGATIVE_TIDS 提供依据，
 *       而不是靠猜分区编号含义。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FAV = 'C:/Users/Public/WorkBuddy/2026-09-18-01-36-00/bili-fav-from-history';
const OUT = __dirname;

const f5 = JSON.parse(fs.readFileSync(path.join(FAV, 'final.json'), 'utf8'));
const f34 = JSON.parse(fs.readFileSync(path.join(FAV, 'final34.json'), 'utf8'));
const cache = JSON.parse(fs.readFileSync(path.join(FAV, 'enrich-cache.json'), 'utf8'));

const music = [...f5.tierA, ...f5.tierB, ...f34.single, ...f34.compilation];
const nonMusic = [...(f5.excluded || []), ...(f34.nonMusic || [])];

// 统计每个 tid 的音乐 / 非音乐数量
function tally(rows) {
  const t = {};
  for (const r of rows) {
    const tid = (cache[r.id] && cache[r.id].ok) ? cache[r.id].data.tid : (r.tid || 0);
    t[tid] = (t[tid] || 0) + 1;
  }
  return t;
}

const mT = tally(music);
const nT = tally(nonMusic);

const allTids = [...new Set([...Object.keys(mT), ...Object.keys(nT)].map(Number))]
  .sort((a, b) => (mT[b] || 0) - (mT[a] || 0));

console.log('=== 各分区的音乐占比（音乐 ' + music.length + ' / 非音乐 ' + nonMusic.length + '）===');
console.log('tid    音乐   非音乐   音乐占比   判定');
console.log('─'.repeat(62));

const musicTids = [];
const negativeTids = [];
const unknown = [];

for (const tid of allTids) {
  const m = mT[tid] || 0, n = nT[tid] || 0;
  const total = m + n;
  const ratio = total ? m / total : 0;
  let verdict;
  if (total < 2) verdict = '样本太少';
  else if (ratio >= 0.75) { verdict = '★ 音乐区'; musicTids.push(tid); }
  else if (ratio <= 0.15) { verdict = '非音乐'; negativeTids.push(tid); }
  else { verdict = '混合'; unknown.push({ tid, m, n, ratio }); }

  console.log(
    String(tid).padEnd(6) +
    String(m).padStart(4) + '   ' +
    String(n).padStart(5) + '    ' +
    (total ? (ratio * 100).toFixed(0) + '%' : '—').padStart(6) + '     ' +
    verdict
  );
}

console.log('\n=== 建议 MUSIC_TIDS（音乐占比 ≥75% 且有样本）===');
console.log('  ' + musicTids.sort((a, b) => a - b).join(', '));

console.log('\n=== 建议 NEGATIVE_TIDS（音乐占比 ≤15%）===');
console.log('  ' + negativeTids.sort((a, b) => a - b).join(', '));

console.log('\n=== 混合区（需保留分区中性）===');
for (const u of unknown.sort((a, b) => b.m - a.m)) {
  console.log('  tid=' + String(u.tid).padEnd(5) + ' 音乐 ' + String(u.m).padStart(3) +
    ' / 非音乐 ' + String(u.n).padStart(4) + '  (' + (u.ratio * 100).toFixed(0) + '%)');
}

// 对照当前的 detector 列表
const D = require(path.join(OUT, 'src', 'detector.js'));
global.BiliParser = require(path.join(OUT, 'src', 'parser.js'));
console.log('\n=== 与当前 detector.js 对照 ===');
const curMusic = [...D.MUSIC_TIDS].sort((a, b) => a - b);
const curNeg = [...D.NEGATIVE_TIDS].sort((a, b) => a - b);
console.log('  当前 MUSIC_TIDS    : ' + curMusic.join(', '));
console.log('  当前 NEGATIVE_TIDS : ' + curNeg.join(', '));

const missing = musicTids.filter(t => !curMusic.includes(t));
const wrongNeg = musicTids.filter(t => curNeg.includes(t));
console.log('\n  ⚠ 有音乐但未列为音乐区: ' + (missing.join(', ') || '无'));
console.log('  ⚠ 有音乐却被列为否决区: ' + (wrongNeg.join(', ') || '无'));

const lost = missing.reduce((s, t) => s + (mT[t] || 0), 0);
const lost2 = wrongNeg.reduce((s, t) => s + (mT[t] || 0), 0);
console.log('\n  受影响曲目：未列为音乐区 ' + lost + ' 首，被否决区误伤 ' + lost2 + ' 首');
