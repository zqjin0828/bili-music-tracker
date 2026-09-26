/**
 * test-parser.js — 用 Node 跑一遍解析逻辑自测
 * 运行： node test/test-parser.js
 */

const path = require('path');
const Parser = require(path.join(__dirname, '..', 'src', 'parser.js'));
const Detector = require(path.join(__dirname, '..', 'src', 'detector.js'));

let pass = 0, fail = 0;

function eq(actual, expected, label) {
  const ok = String(actual) === String(expected);
  if (ok) { pass++; }
  else {
    fail++;
    console.log(`  ✗ ${label}\n      got: ${JSON.stringify(actual)}\n      exp: ${JSON.stringify(expected)}`);
  }
}

function truthy(v, label) {
  if (v) pass++;
  else { fail++; console.log(`  ✗ ${label}  (got ${JSON.stringify(v)})`); }
}

function falsy(v, label) {
  if (!v) pass++;
  else { fail++; console.log(`  ✗ ${label}  (got ${JSON.stringify(v)})`); }
}

// ============ 标题解析 ============
console.log('\n=== 标题解析 ===');

let r;

r = Parser.parseTitle('【初音ミク】千本桜【翻唱】');
eq(r.version, '翻唱', '千本桜 版本');
truthy(/千本桜/.test(r.songName), '千本桜 歌名含千本桜');
truthy(r.artist === '初音ミク' || r.songName, '千本桜 歌手或有歌名');

r = Parser.parseTitle('周杰伦 - 晴天 (Live)');
eq(r.version, 'Live', '晴天 版本');
eq(r.songName, '晴天', '晴天 歌名');
eq(r.artist, '周杰伦', '晴天 歌手');

r = Parser.parseTitle('【4K修复】五月天《温柔》高音质');
truthy(/温柔/.test(r.songName), '温柔 歌名');
truthy(r.artist === '五月天' || r.artist === '', '温柔 歌手');

r = Parser.parseTitle('【翻唱】起风了 - 买辣椒也用券');
eq(r.version, '翻唱', '起风了 版本');
truthy(/起风了/.test(r.songName) || /起风了/.test(r.artist), '起风了 歌名或歌手含起风了');

r = Parser.parseTitle('夜空中最亮的星 Cover by 逃跑计划');
eq(r.version, '翻唱', '夜空中最亮的星 版本');

r = Parser.parseTitle('【纯音乐】River Flows In You 钢琴版');
eq(r.version, '钢琴版', 'River 版本（钢琴优先于纯音乐？按规则顺序应是纯音乐）');

r = Parser.parseTitle('孤勇者 [Official MV]');
truthy(/孤勇者/.test(r.songName), '孤勇者 歌名');
falsy(/Official/.test(r.songName), '孤勇者 剥离 Official');

r = Parser.parseTitle('周深《大鱼》高清无损');
truthy(/大鱼/.test(r.songName), '大鱼 歌名');
eq(r.quality !== '', true, '大鱼 提取到画质标签');

// songKey 归一化测试
const k1 = Parser.makeSongKey(Parser.parseTitle('【翻唱】千本桜'));
const k2 = Parser.makeSongKey(Parser.parseTitle('千本桜【翻唱】'));
eq(k1, k2, '同歌不同标题顺序 → 同 songKey');

const k3 = Parser.makeSongKey(Parser.parseTitle('千本桜 原唱'));
truthy(k1 !== k3, '翻唱与原唱 → 不同 songKey');

const k4 = Parser.makeSongKey(Parser.parseTitle('【A】千本桜【翻唱】'));
const k5 = Parser.makeSongKey(Parser.parseTitle('【B】千本桜【翻唱】'));
eq(k4, k5, '不同UP同版本 → 同 songKey（跨视频合并）');

// ============ 音乐判定 ============
console.log('\n=== 音乐判定 ===');

let d;

d = Detector.detectMusic({
  tid: 31, title: '【翻唱】起风了', upName: '某某音乐', duration: 260, tname: '翻唱'
});
truthy(d.isMusic, '音乐区翻唱 → 是音乐');
truthy(d.confidence > 0.7, `音乐区翻唱置信度高 (${d.confidence})`);

d = Detector.detectMusic({
  tid: 30, title: '【初音ミク】千本桜', upName: 'VOCALOID搬运', duration: 240, tname: 'VOCALOID·UTAU'
});
truthy(d.isMusic, 'VOCALOID区 → 是音乐');

d = Detector.detectMusic({
  tid: 4, title: '艾尔登法环 全boss无伤攻略', upName: '游戏UP', duration: 1800, tname: '游戏'
});
falsy(d.isMusic, '游戏区攻略 → 否');

d = Detector.detectMusic({
  tid: 171, title: '【教程】Python从入门到精通 第1讲', upName: '编程UP', duration: 2400, tname: '编程'
});
falsy(d.isMusic, '教程 → 否');

d = Detector.detectMusic({
  tid: 95, title: 'iPhone 16 开箱评测', upName: '数码UP', duration: 900, tname: '数码'
});
falsy(d.isMusic, '数码开箱 → 否');

d = Detector.detectMusic({
  tid: 21, title: '今天做了一道番茄炒蛋', upName: '生活UP', duration: 300, tname: '日常'
});
falsy(d.isMusic, '生活日常 → 否');

d = Detector.detectMusic({
  tid: 0, title: '邓紫棋 - 光年之外 (Live)', upName: '音乐分享', duration: 250, tname: ''
});
truthy(d.isMusic, '标题强音乐特征+无分区 → 是音乐');

d = Detector.detectMusic({
  tid: 3, title: '某歌曲合集 100首', upName: '某某', duration: 7200, tname: '音乐'
});
truthy(d.isMusic, '音乐区超长合集 → 仍判为音乐（收藏时你自己决定）');
truthy(d.confidence >= 0.6, `音乐区合集置信度达标 (${d.confidence})`);

// ============ 日语标题解析 ============
console.log('\n=== 日语标题解析 ===');

r = Parser.parseTitle('【初音ミク】千本桜【オリジナル】');
eq(r.version, '原唱', '千本桜 オリジナル→原唱');
eq(r.songName, '千本桜', '千本桜 歌名');
eq(r.artist, '初音ミク', '千本桜 歌手（不能是"オリジナル"）');

r = Parser.parseTitle('【ピアノ】千本桜');
eq(r.version, '钢琴版', 'ピアノ→钢琴版（关键：不能并入原曲）');
eq(r.songName, '千本桜', 'ピアノ版 歌名');
eq(r.artist, '', 'ピアノ 不能当歌手');

r = Parser.parseTitle('【弾いてみた】残酷な天使のテーゼ');
eq(r.version, '翻唱', '弾いてみた→翻唱');
eq(r.songName, '残酷な天使のテーゼ', '残酷な天使 歌名');

r = Parser.parseTitle('【歌ってみた】残酷な天使のテーゼ');
eq(r.version, '翻唱', '歌ってみた→翻唱');

r = Parser.parseTitle('【カラオケ】ドライフラワー');
eq(r.version, '纯音乐', 'カラオケ→纯音乐（伴奏）');
eq(r.songName, 'ドライフラワー', 'ドライフラワー 歌名');

r = Parser.parseTitle('【替え歌】おジャ魔女カーニバル');
eq(r.version, '替え歌', '替え歌→替え歌');
eq(r.songName, 'おジャ魔女カーニバル', 'おジャ魔女 歌名');

r = Parser.parseTitle('YOASOBI「夜に駆ける」');
eq(r.songName, '夜に駆ける', 'YOASOBI 歌名拆出');
eq(r.artist, 'YOASOBI', 'YOASOBI 歌手拆出');

r = Parser.parseTitle('Neru - 東京テディベア feat.鏡音リン');
eq(r.artist, 'Neru', 'Neru 歌手');
truthy(/東京テディベア/.test(r.songName), '東京テディベア 歌名');
falsy(/feat/.test(r.songName), 'feat. 已剥离');

r = Parser.parseTitle('Aimer - 残響散歌 / THE FIRST TAKE');
eq(r.artist, 'Aimer', 'Aimer 歌手');
eq(r.songName, '残響散歌', '残響散歌 歌名（节目名已剥离）');

r = Parser.parseTitle('米津玄師 - Lemon');
eq(r.artist, '米津玄師', '米津玄師 歌手');
eq(r.songName, 'Lemon', 'Lemon 歌名');

r = Parser.parseTitle('Official髭男dism - Pretender (Live)');
eq(r.version, 'Live', 'Pretender Live 版本');
eq(r.songName, 'Pretender', 'Pretender 歌名');

// 合辑识别
r = Parser.parseTitle('【作業用BGM】アニソンメドレー');
truthy(r.isCompilation, '作業用BGMメドレー→合辑');
r = Parser.parseTitle('【作業用BGM】アニソンメドレー');
truthy(Parser.isCompilation('【作業用BGM】アニソンメドレー', '', 240), '合辑判定函数');
truthy(Parser.isCompilation('某歌曲合集', '', 240), '中文合集识别');
falsy(Parser.isCompilation('千本桜', '', 240), '单曲不是合辑');
truthy(Parser.isCompilation('某长视频', '', 3600), '超长视频判为合辑');

// 日语 songKey 合并正确性
const jk1 = Parser.makeSongKey(Parser.parseTitle('【ピアノ】千本桜'));
const jk2 = Parser.makeSongKey(Parser.parseTitle('【初音ミク】千本桜'));
truthy(jk1 !== jk2, '钢琴版 与 原曲 → 不同 key（关键修复）');
const jk3 = Parser.makeSongKey(Parser.parseTitle('【歌ってみた】千本桜'));
const jk4 = Parser.makeSongKey(Parser.parseTitle('【弾いてみた】千本桜'));
eq(jk3, jk4, '歌ってみた 与 弾いてみた → 同为翻唱key');

// 格式/出处标签不能当歌手（这批曾出错）
console.log('\n=== 日语标签不误判为歌手 ===');
[['【MAD】残酷な天使のテーゼ', ''], ['【フル】ドライフラワー', ''],
 ['【練習】残酷な天使のテーゼ 弾いてみた', ''], ['【合唱】千本桜', ''],
 ['【東方】Bad Apple!!', ''], ['【洋楽】Shape of You', ''],
 ['【ED】残酷な天使のテーゼ', ''], ['【OP】紅蓮華', '']
].forEach(([title, expectArtist]) => {
  const rr = Parser.parseTitle(title);
  eq(rr.artist, expectArtist, `「${title}」标签不当歌手`);
});

// 英文名不能被 op/ed/mv 噪音词误伤
r = Parser.parseTitle('【洋楽】Shape of You / Ed Sheeran');
eq(r.artist, 'Ed Sheeran', 'Ed Sheeran 不被 ed 噪音词吃掉');
eq(r.songName, 'Shape of You', 'Shape of You 歌名');

// feat. 与节目名剥离
r = Parser.parseTitle('Neru - 東京テディベア feat.鏡音リン');
falsy(/feat/.test(r.songName), 'feat. 已剥离（日语）');
r = Parser.parseTitle('Aimer - 残響散歌 / THE FIRST TAKE');
eq(r.songName, '残響散歌', 'THE FIRST TAKE 已剥离');
falsy(/\/$/.test(r.songName), '歌名尾部无残留斜杠');

// 版本后缀修正（"米津玄師 ピアノver" 这种）
r = Parser.parseTitle('【カバー】Lemon - 米津玄師 ピアノver');
eq(r.songName, 'Lemon', 'カバー+ピアノver 歌名正确');
eq(r.artist, '米津玄師', 'カバー+ピアノver 歌手正确');

// 乐队名（含空格 / 含句号）
r = Parser.parseTitle('【MV】King Gnu - 白日');
eq(r.artist, 'King Gnu', 'King Gnu 乐队名（含空格）');
eq(r.songName, '白日', '白日 歌名');

// ============ 日语音乐判定 ============
console.log('\n=== 日语音乐判定 ===');

d = Detector.detectMusic({ tid: 31, title: '【歌ってみた】残酷な天使のテーゼ', upName: '歌い手', duration: 250, tname: '翻唱' });
truthy(d.isMusic, '日语翻唱 → 是音乐');

d = Detector.detectMusic({ tid: 30, title: '【初音ミク】千本桜', upName: 'ボカロP', duration: 240, tname: 'VOCALOID·UTAU' });
truthy(d.isMusic, 'ボカロ → 是音乐');

d = Detector.detectMusic({ tid: 31, title: '【作業用BGM】アニソンメドレー 100曲', upName: '音楽ch', duration: 5400, tname: '翻唱' });
truthy(d.isMusic, '日语作业用BGM → 仍是音乐');
truthy(d.isCompilation, '日语作业用BGM → 判为合辑');

d = Detector.detectMusic({ tid: 4, title: '【実況】ゲーム攻略 part1', upName: 'ゲーム実況者', duration: 1200, tname: '游戏' });
falsy(d.isMusic, '日语游戏实况 → 否');

d = Detector.detectMusic({ tid: 21, title: '今日の晩ご飯作りました', upName: '日常ch', duration: 400, tname: '日常' });
falsy(d.isMusic, '日语日常vlog → 否');

// ============ 边界情况 ============

r = Parser.parseTitle('');
truthy(r.songName !== undefined, '空标题不崩溃');

r = Parser.parseTitle('【】【】');
truthy(r.songName !== undefined, '纯括号不崩溃');

r = Parser.parseTitle('a');
truthy(r.songName !== undefined, '单字标题不崩溃');

r = Parser.parseTitle('歌名 - ');
truthy(r.songName !== undefined, '尾随横线不崩溃');

console.log(`\n${'='.repeat(40)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
