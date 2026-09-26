/**
 * test-detector-accuracy.js — 判定器准确率回归测试
 *
 * 样本来自「人工逐条核对过的清单」：427 首确认音乐 + 1773 首非音乐。
 * 这是唯一能真实衡量判定器好坏的样本，比手工编正反例可靠得多。
 *
 * 为什么需要这个测试：
 *   判定器的权重和阈值很容易在微调时「按下葫芦浮起瓢」——
 *   修好一批漏判的同时可能引入大批误纳，靠几个手工用例根本发现不了。
 *
 * 数据文件：test/fixtures/detector-sample.json
 * 如需用新数据重生成，见 tools/validate-detector.js 的说明。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
global.BiliParser = require(path.join(ROOT, 'src', 'parser.js'));
const D = require(path.join(ROOT, 'src', 'detector.js'));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '\n      ' + extra : '')); }
}

const FIXTURE = path.join(__dirname, 'fixtures', 'detector-sample.json');
if (!fs.existsSync(FIXTURE)) {
  console.log('  ⚠ 缺少样本文件 test/fixtures/detector-sample.json，跳过');
  console.log('\n========================================');
  console.log('通过 0 项，失败 0 项（已跳过）');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
console.log('\n样本：音乐 ' + data.music + ' 首，非音乐 ' + data.nonMusic + ' 首');

let tp = 0, fn = 0, fp = 0, tn = 0;
const missed = [];
const wrong = [];

for (const r of data.rows) {
  const res = D.detectMusic({
    tid: r.tid, title: r.t, upName: r.up, duration: r.dur, tname: r.tn
  });
  const want = r.y === 1;
  if (want && res.isMusic) tp++;
  else if (want && !res.isMusic) { fn++; if (missed.length < 8) missed.push(r.t); }
  else if (!want && res.isMusic) { fp++; if (wrong.length < 8) wrong.push(r.t); }
  else tn++;
}

const recall = tp / (tp + fn);
const nonAcc = tn / (tn + fp);
const precision = (tp + fp) ? tp / (tp + fp) : 1;
const f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 0;

console.log('');
console.log('  召回率（音乐没被漏掉）  : ' + (recall * 100).toFixed(1) + '%   (漏判 ' + fn + ')');
console.log('  非音乐正确率            : ' + (nonAcc * 100).toFixed(1) + '%   (误纳 ' + fp + ')');
console.log('  精确率                  : ' + (precision * 100).toFixed(1) + '%');
console.log('  F1                      : ' + f1.toFixed(3));

// ---------- 门槛（略低于当前实测值，留出微调空间）----------
console.log('\n=== 门槛检查 ===');
ok(recall >= 0.85, '召回率 ≥ 85%（实测 ' + (recall * 100).toFixed(1) + '%）',
  fn ? ('漏判示例：\n      ' + missed.join('\n      ')) : '');
ok(nonAcc >= 0.90, '非音乐正确率 ≥ 90%（实测 ' + (nonAcc * 100).toFixed(1) + '%）',
  fp ? ('误纳示例：\n      ' + wrong.join('\n      ')) : '');
ok(f1 >= 0.78, 'F1 ≥ 0.78（实测 ' + f1.toFixed(3) + '）');

// ---------- 关键回归用例（防止权重改动把这些改坏）----------
console.log('\n=== 关键用例 ===');
const C = [
  // 短曲必须算音乐（曾经因为「时长过短」被扣分判否）
  [{ tid: 27, title: '【4K】无职转生 第二季 特殊ED：七星「ツバサ」动画MV【中日歌词】', upName: '', duration: 94, tname: '' }, true, '94 秒的动画 ED → 音乐'],
  [{ tid: 30, title: '【夢ノ結唱 ROSE】翼をください（《日常》第13话ED）', upName: '', duration: 90, tname: '' }, true, '标题含番剧名《日常》不应被否'],
  // 企划实体是决定性证据
  [{ tid: 137, title: '【峰月律】【双语歌词】Lemon /米津玄师', upName: '', duration: 255, tname: '' }, true, '企划实体命中 → 音乐'],
  [{ tid: 242, title: '【中字」楽しいの天才」- Vocal. 天王寺璃奈', upName: '', duration: 108, tname: '' }, true, '角色实体命中 → 音乐'],
  // 生活区也可能有音乐（曾经 tid=21 被一票否决）
  [{ tid: 21, title: '【新编曲】Y.O.L.O!!!!! - Pastel*Palettes 分词可视化', upName: '', duration: 111, tname: '' }, true, '生活区的企划音乐 → 音乐'],
  // 真非音乐仍要挡住
  [{ tid: 4, title: '艾尔登法环 全boss无伤攻略', upName: '游戏UP', duration: 1800, tname: '游戏' }, false, '游戏攻略 → 否'],
  [{ tid: 95, title: 'iPhone 16 开箱评测', upName: '数码UP', duration: 900, tname: '数码' }, false, '数码开箱 → 否'],
  [{ tid: 21, title: '今天做了一道番茄炒蛋', upName: '生活UP', duration: 300, tname: '日常' }, false, '生活日常（无音乐信号）→ 否'],
  [{ tid: 171, title: '【教程】Python从入门到精通 第1讲', upName: '编程UP', duration: 2400, tname: '编程' }, false, '教程 → 否'],
  // 无分区但标题很强
  [{ tid: 0, title: '邓紫棋 - 光年之外 (Live)', upName: '音乐分享', duration: 250, tname: '' }, true, '标题强音乐特征 → 音乐'],
  // ★ 已知漏判（记录现状，不是期望它永远漏）
  //   标题本身没有任何音乐词、分区也非音乐区 —— 纯文本判定无法识别。
  //   这类只能靠用户在弹窗里手动「标为音乐」。
  [{ tid: 26, title: 'LOVE 2007', upName: '蓝叶-alan', duration: 72, tname: '' }, false,
    '已知漏判：标题/UP 名均无音乐特征（靠人工标为音乐兜底）']
];
for (const [info, want, label] of C) {
  const r = D.detectMusic(info);
  ok(r.isMusic === want, label + '  (score=' + r.score + ' conf=' + r.confidence + ')');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail > 0 ? 1 : 0);
