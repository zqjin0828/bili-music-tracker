/**
 * test-integration.js — 端到端流程验证
 *
 * 目的：不依赖浏览器，直接验证 background 的核心逻辑链：
 *   上报播放 → 入队 → AI 结果回来 → 计数被修正
 *
 * 做法：用一个极简的 chrome.storage.local + chrome.runtime 模拟器，
 * 把 background.js 的 recordPlay / applyAiResult / importAiResults 跑起来。
 *
 * 注意：background.js 用 importScripts 加载依赖、并在顶层注册事件监听，
 * 所以这里不 require 它，而是把关键函数抽出来在同样环境下验证 ——
 * 保证与真实实现走的是同一套 ai-client / ai 模块。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const Parser = require(path.join(ROOT, 'src', 'parser.js'));
global.BiliParser = Parser;
const Ai = require(path.join(ROOT, 'src', 'ai.js'));
global.BiliAi = Ai;
const AIClient = require(path.join(ROOT, 'src', 'ai-client.js'));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '\n      ' + extra : ''}`); }
}
function eq(got, exp, label) {
  ok(got === exp, label, got === exp ? '' : `got: ${JSON.stringify(got)}  exp: ${JSON.stringify(exp)}`);
}

// ---------- 迷你 store（复刻 background 的 executeOps 语义） ----------

function makeStore() {
  return { videoStats: {}, songStats: {} };
}

function adjustSong(store, key, delta, seed, videoKey) {
  if (!key) return;
  let s = store.songStats[key];
  if (delta > 0) {
    if (!s) {
      s = {
        songName: (seed && seed.songName) || '',
        version: (seed && seed.version) || '',
        artist: (seed && seed.artist) || '',
        playCount: 0, videos: [],
        firstPlayedAt: Date.now(), lastPlayedAt: Date.now(), notified: false
      };
      store.songStats[key] = s;
    }
    s.playCount += delta;
    if (videoKey && !s.videos.includes(videoKey)) s.videos.push(videoKey);
  } else if (s) {
    s.playCount = Math.max(0, (s.playCount || 0) + delta);
    if (s.playCount === 0) delete store.songStats[key];
  }
}

function executeOps(ops, store, videoKey) {
  const v = store.videoStats[videoKey];
  for (const op of ops) {
    switch (op.type) {
      case 'video.isMusic': if (v) v.isMusic = op.value; break;
      case 'video.isCompilation': if (v) v.isCompilation = op.value; break;
      case 'video.increment': if (v) v.playCount = (v.playCount || 0) + (op.by || 1); break;
      case 'video.decrement':
        if (v) {
          v.playCount = Math.max(0, (v.playCount || 0) - (op.by || 1));
          if (v.playCount === 0) delete store.videoStats[videoKey];
        }
        break;
      case 'song.increment': adjustSong(store, op.key, op.by || 1, op.seed, videoKey); break;
      case 'song.decrement': adjustSong(store, op.key, -(op.by || 1), null, videoKey); break;
      case 'song.migrate':
        if (op.drop) {
          adjustSong(store, op.from, -(op.by || 1), null, videoKey);
        } else {
          const src = store.songStats[op.from];
          if (src) {
            adjustSong(store, op.to, op.by || 1, op.seed || {
              songName: src.songName, version: src.version, artist: src.artist
            }, videoKey);
            adjustSong(store, op.from, -(op.by || 1), null, videoKey);
          }
        }
        break;
      case 'video.markApplied': if (v) v.appliedAiRevision = op.revision; break;
      default: break;
    }
  }
}

// 复刻 importAiResults 的核心：把 AI 结果应用到统计
function applyAi(store, videoKey, aiResult, item, revision) {
  const v = store.videoStats[videoKey];
  const plan = AIClient.planApply({
    aiResult,
    ruleResult: item.ruleResult,
    oldSongKey: item.optimisticSongKey,
    oldVideoKey: videoKey,
    videoEntry: v || {},
    settings: { mergeSimilarVersions: true },
    aiRevision: revision
  });
  executeOps(plan.ops, store, videoKey);
  return plan;
}

// ---------- 测试 ----------

console.log('\n=== 场景1：规则误判为音乐，AI 纠正为非音乐 ===');
{
  const store = makeStore();
  const key = 'BV1game';
  // 规则乐观计数：误判成音乐，记了 1 次
  store.videoStats[key] = {
    bvid: 'BV1game', title: '艾尔登法环 全boss无伤攻略', duration: 1800,
    playCount: 1, isMusic: true, isCompilation: false,
    musicConfidence: 0.55, ruleRevision: 1, appliedAiRevision: 0
  };
  store.songStats['艾尔登法环 全boss无伤攻略|original'] = {
    songName: '艾尔登法环 全boss无伤攻略', version: 'original', artist: '',
    playCount: 1, videos: [key]
  };

  const item = {
    ruleResult: { isMusic: true, isCompilation: false, songName: '艾尔登法环 全boss无伤攻略', version: 'original', confidence: 0.55 },
    optimisticSongKey: '艾尔登法环 全boss无伤攻略|original'
  };

  const plan = applyAi(store, key, {
    isMusic: false, isCompilation: false, songName: '', artist: '', version: '', confidence: 0.98
  }, item, 1);

  eq(store.videoStats[key], undefined, '视频级计数被扣到 0 并删除');
  eq(store.songStats['艾尔登法环 全boss无伤攻略|original'], undefined, '歌曲级计数被扣到 0 并删除');
  eq(plan.note, 'ai-not-music', 'note 正确');
}

console.log('\n=== 场景2：规则漏判，AI 补记为音乐 ===');
{
  const store = makeStore();
  const key = 'BV2miss';
  store.videoStats[key] = {
    bvid: 'BV2miss', title: 'Lemon - 米津玄師', duration: 260,
    playCount: 1, isMusic: false, isCompilation: false,
    musicConfidence: 0.4, ruleRevision: 1, appliedAiRevision: 0
  };

  const item = {
    ruleResult: { isMusic: false, isCompilation: false, songName: '', version: '', confidence: 0.4 },
    optimisticSongKey: ''
  };

  applyAi(store, key, {
    isMusic: true, isCompilation: false, songName: 'Lemon', artist: '米津玄師', version: 'original', confidence: 0.95
  }, item, 1);

  eq(store.videoStats[key].playCount, 2, '规则漏判时未计入，AI 补记后为 2（规则1次+AI补1次）');
  eq(store.videoStats[key].isMusic, true, '标记为音乐');
  ok(!!store.songStats['lemon|original'], '歌曲级新建条目');
  eq(store.songStats['lemon|original'].playCount, 2, '歌曲级计数为 2');
  eq(store.songStats['lemon|original'].artist, '米津玄師', '歌手信息写入');
}

console.log('\n=== 场景3：规则把歌手名当歌名，AI 纠正 → 计数迁移 ===');
{
  const store = makeStore();
  const key = 'BV3mig';
  store.videoStats[key] = {
    bvid: 'BV3mig', title: '【初音ミク】千本桜', duration: 240,
    playCount: 2, isMusic: true, isCompilation: false,
    musicConfidence: 0.6, ruleRevision: 1, appliedAiRevision: 0
  };
  // 规则错误地把「初音ミク」当成歌名，已累积 3 次
  store.songStats['初音ミク|original'] = {
    songName: '初音ミク', version: 'original', artist: '',
    playCount: 3, videos: [key]
  };

  const item = {
    ruleResult: { isMusic: true, isCompilation: false, songName: '初音ミク', version: 'original', confidence: 0.6 },
    optimisticSongKey: '初音ミク|original'
  };

  applyAi(store, key, {
    isMusic: true, isCompilation: false, songName: '千本桜', artist: '初音ミク', version: 'original', confidence: 0.95
  }, item, 1);

  eq(store.songStats['千本桜|original'].playCount, 1, '新 key 得到 1 次');
  eq(store.songStats['千本桜|original'].artist, '初音ミク', '新 key 的歌手正确');
  eq(store.songStats['初音ミク|original'].playCount, 2, '旧 key 从 3 扣到 2');
  eq(store.videoStats[key].playCount, 2, '视频级计数不受影响（仍是音乐）');
}

console.log('\n=== 场景4：改判为合辑 → 撤掉歌曲级 ===');
{
  const store = makeStore();
  const key = 'BV4comp';
  store.videoStats[key] = {
    bvid: 'BV4comp', title: '【作業用BGM】アニソンメドレー 50曲', duration: 5400,
    playCount: 1, isMusic: true, isCompilation: false,
    musicConfidence: 0.62, ruleRevision: 1, appliedAiRevision: 0
  };
  store.songStats['アニソンメドレー|original'] = {
    songName: 'アニソンメドレー', version: 'original', artist: '',
    playCount: 1, videos: [key]
  };

  const item = {
    ruleResult: { isMusic: true, isCompilation: false, songName: 'アニソンメドレー', version: 'original', confidence: 0.62 },
    optimisticSongKey: 'アニソンメドレー|original'
  };

  applyAi(store, key, {
    isMusic: true, isCompilation: true, songName: 'アニソンメドレー', artist: '', version: 'original', confidence: 0.9
  }, item, 1);

  eq(store.videoStats[key].isCompilation, true, '标记为合辑');
  eq(store.songStats['アニソンメドレー|original'], undefined, '歌曲级条目被撤掉');
  eq(store.videoStats[key].playCount, 1, '视频级计数保留');
}

console.log('\n=== 场景5：幂等 —— 同一条结果导入两次 ===');
{
  const store = makeStore();
  const key = 'BV5idem';
  store.videoStats[key] = {
    bvid: 'BV5idem', title: 'x', duration: 200,
    playCount: 1, isMusic: true, isCompilation: false,
    musicConfidence: 0.5, ruleRevision: 2, appliedAiRevision: 0
  };
  store.songStats['old|original'] = { songName: 'old', version: 'original', artist: '', playCount: 1, videos: [key] };

  const item = {
    ruleResult: { isMusic: true, isCompilation: false, songName: 'old', version: 'original', confidence: 0.5 },
    optimisticSongKey: 'old|original'
  };
  const aiResult = {
    isMusic: true, isCompilation: false, songName: 'new', artist: '', version: 'original', confidence: 0.9
  };

  // 第一次：revision = 2
  store.videoStats[key].appliedAiRevision = 0;
  applyAi(store, key, aiResult, item, 2);
  const afterFirst = { newCount: store.songStats['new|original'].playCount };

  // 第二次：同样 revision = 2，videoEntry 已标记 appliedAiRevision = 2
  const plan2 = applyAi(store, key, aiResult, item, 2);

  eq(store.songStats['new|original'].playCount, afterFirst.newCount, '第二次不重复增加');
  eq(plan2.ops.length, 0, '第二次不产生操作');
  eq(plan2.note, 'already-applied', '标注为已应用');
}

console.log('\n=== 场景6：AI 结果与规则完全一致 → 无修正 ===');
{
  const store = makeStore();
  const key = 'BV6same';
  store.videoStats[key] = {
    bvid: 'BV6same', title: '晴天 - 周杰伦', duration: 269,
    playCount: 1, isMusic: true, isCompilation: false,
    musicConfidence: 0.6, ruleRevision: 1, appliedAiRevision: 0
  };
  store.songStats['晴天|original'] = { songName: '晴天', version: 'original', artist: '周杰伦', playCount: 1, videos: [key] };

  const item = {
    ruleResult: { isMusic: true, isCompilation: false, songName: '晴天', version: 'original', confidence: 0.6 },
    optimisticSongKey: '晴天|original'
  };

  const plan = applyAi(store, key, {
    isMusic: true, isCompilation: false, songName: '晴天', artist: '周杰伦', version: 'original', confidence: 0.96
  }, item, 1);

  eq(store.songStats['晴天|original'].playCount, 1, '计数不变');
  eq(store.videoStats[key].playCount, 1, '视频计数不变');
  eq(plan.note, 'no-change', 'note 为 no-change');
}

console.log('\n=== 场景7：队列 JSON 与处理脚本的格式兼容 ===');
{
  const demoPath = path.join(ROOT, 'tools', 'demo-queue.json');
  const raw = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
  ok(Array.isArray(raw.items), '队列文件有 items 数组');
  eq(raw.items.length, 2, '两条待判定');

  const it = raw.items[0];
  ok(typeof it.key === 'string' && it.key, 'item 有 key');
  ok(typeof it.title === 'string' && it.title, 'item 有 title');
  ok(it.ruleResult && typeof it.ruleResult.isMusic === 'boolean', 'item 有 ruleResult');

  // 模拟 process-queue 输出的结果形状，验证能被 applyAi 消费
  const store = makeStore();
  const key = it.key;
  store.videoStats[key] = {
    bvid: it.bvid, title: it.title, duration: it.duration,
    playCount: 1, isMusic: it.ruleResult.isMusic, isCompilation: it.ruleResult.isCompilation,
    musicConfidence: it.ruleResult.confidence, ruleRevision: 1, appliedAiRevision: 0
  };
  store.songStats[it.optimisticSongKey] = {
    songName: it.ruleResult.songName, version: it.ruleResult.version,
    artist: it.ruleResult.artist, playCount: 1, videos: [key]
  };

  // AI 判定这是合辑
  const plan = applyAi(store, key, {
    isMusic: true, isCompilation: true, songName: '夏のアニソンメドレー', artist: '', version: 'original', confidence: 0.9
  }, it, 1);

  ok(plan.ops.length > 0, '真实队列条目能触发修正');
  eq(store.songStats[it.optimisticSongKey], undefined, '合辑条目被撤掉');
}

console.log('\n=== 场景8：降级 —— AI 失败时统计不受影响 ===');
{
  const store = makeStore();
  const key = 'BV8fail';
  store.videoStats[key] = {
    bvid: 'BV8fail', title: '某首日语歌', duration: 240,
    playCount: 1, isMusic: true, isCompilation: false,
    musicConfidence: 0.6, ruleRevision: 1, appliedAiRevision: 0
  };
  store.songStats['某首日语歌|original'] = {
    songName: '某首日语歌', version: 'original', artist: '', playCount: 1, videos: [key]
  };

  // planApply 传入 null 结果（模拟 AI 失败/超时）
  const plan = AIClient.planApply({
    aiResult: null,
    ruleResult: { isMusic: true, confidence: 0.6 },
    oldSongKey: '某首日语歌|original',
    oldVideoKey: key,
    videoEntry: store.videoStats[key],
    settings: {},
    aiRevision: 1
  });

  eq(plan.ops.length, 0, 'AI 失败不产生操作');
  eq(store.videoStats[key].playCount, 1, '计数保持原样');
  eq(store.songStats['某首日语歌|original'].playCount, 1, '歌曲计数保持原样');
}

console.log('\n========================================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
