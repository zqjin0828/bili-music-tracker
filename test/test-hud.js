#!/usr/bin/env node
/**
 * test-hud.js — 调试面板（HUD）的特殊状态渲染
 *
 * 背景：
 *   旧 HUD 只显示「累计 / 状态 / 判定 / 会话」四行，特殊状态一律看不到。
 *   最典型的是「歌已在收藏夹里」—— 用户看到累计 100% 却始终不计数，
 *   HUD 里没有任何解释，只能靠猜。
 *
 * 本测试直接调用 src/hud.js 的纯函数，覆盖各个特殊分支：
 *   已收藏 / 非音乐 / 已排除 / 静音 / 合辑 / 索引不可用或过期 /
 *   夹满 / 上报被拒 / AI 降级 / 丢弃统计 / 转义安全 等。
 */

'use strict';

const Hud = require('../src/hud.js');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '\n      ' + extra : '')); }
}

/** 造一个「一切正常、刚开始播放」的基础 ctx，测试里按需覆盖字段 */
function base(over) {
  const ctx = {
    have: 10, need: 93, duration: 310, pct: 11, reached: false,
    detection: { isMusic: true, confidence: 0.92, tid: 31, tname: '音乐', isCompilation: false, manualOverride: false },
    parsed: { songName: '千本桜', version: 'original', artist: '初音ミク' },
    playState: { paused: false, ended: false, muted: false, rate: 1, background: false },
    session: { counted: false, sampleMs: 500, dropped: { seek: 0, mutedSec: 0, noAdvance: 0 } },
    fav: { known: true, faved: false, source: 'none', folder: '歌', checkedAgoMs: 4000 },
    index: { known: true, ok: true, stale: false, count: 276, title: '歌', ageMs: 240000 },
    folders: null,
    counts: { video: 1, song: 1 },
    lastReport: null,
    ai: null,
    settings: { threshold: 5, minWatchSeconds: 30, mutedCounts: true },
    notice: null
  };
  return Object.assign(ctx, over || {});
}

/** 断言 HTML 里包含某段文本（去掉标签后） */
function has(ctx, needle) {
  return Hud.toText(ctx).indexOf(needle) >= 0;
}

console.log('\n▶ test-hud.js  —  调试面板特殊状态');

// ---------- 1. 结论行：已收藏（本次投诉的核心场景） ----------
console.log('\n【1】已收藏 → 必须明确说明「不计数」');
{
  const ctx = base({
    have: 93, pct: 100, reached: true,
    fav: { known: true, faved: true, source: 'index', folder: '歌', checkedAgoMs: 4000 },
    session: { counted: false, sampleMs: 500, dropped: { seek: 0, mutedSec: 0, noAdvance: 0 } },
    lastReport: { counted: false, reason: 'already-faved', favedSource: 'index', videoPlayCount: 7, at: Date.now(), agoMs: 3000 }
  });
  const t = Hud.toText(ctx);
  ok(t.indexOf('不计数：已在「歌」收藏夹') >= 0, '顶部结论 = 不计数：已在「歌」收藏夹', t);
  ok(has(ctx, '收藏 已在「歌」'), '收藏行显示 已在「歌」');
  ok(has(ctx, '依据 后台索引'), '标注了判定依据（后台索引）');
  ok(has(ctx, '上报 ✕ 已在收藏夹，跳过计数'), '上报行回显后台拒绝原因');
  ok(t.indexOf('已计入：有效收听达标') < 0, '不会误报「已计入」');
  ok(Hud.render(ctx).indexOf('is-warn') >= 0, '结论行带 warn 染色类');
}

// ---------- 2. 已收藏但还没播（刚进页面就能看到） ----------
console.log('\n【2】刚进页面、还没播 → 也应当场告知已收藏');
{
  const ctx = base({
    have: 0, pct: 0,
    fav: { known: true, faved: true, source: 'dom', folder: '歌', checkedAgoMs: 900 }
  });
  const t = Hud.toText(ctx);
  ok(t.indexOf('不计数：已在「歌」收藏夹') >= 0, '未播放也显示已收藏结论', t);
  ok(has(ctx, '依据 页面收藏按钮'), '依据 = 页面收藏按钮（DOM 优先）');
}

// ---------- 3. 非音乐 ----------
console.log('\n【3】未判定为音乐');
{
  const ctx = base({
    detection: { isMusic: false, confidence: 0.18, tid: 21, tname: '日常', isCompilation: false, manualOverride: false }
  });
  const t = Hud.toText(ctx);
  ok(t.indexOf('不计数：未判定为音乐') >= 0, '结论 = 不计数：未判定为音乐', t);
  ok(has(ctx, '判定 非音乐 0.18'), '判定行标记非音乐 + 置信度');
  ok(has(ctx, '可在弹窗里「标为音乐」修正'), '给出可操作修正建议');
  ok(Hud.render(ctx).indexOf('is-bad') >= 0, '非音乐用 bad（红）染色');
}

// ---------- 4. 已被排除 ----------
console.log('\n【4】被用户排除');
{
  const ctx = base({
    lastReport: { counted: false, reason: 'excluded', at: Date.now(), agoMs: 1000 }
  });
  const t = Hud.toText(ctx);
  ok(t.indexOf('不计数：已被你排除') >= 0, '结论 = 不计数：已被你排除', t);
}

// ---------- 5. 静音不计时 ----------
console.log('\n【5】静音且关闭了「静音也计时」');
{
  const ctx = base({
    playState: { paused: false, ended: false, muted: true, rate: 1, background: false },
    settings: { threshold: 5, minWatchSeconds: 30, mutedCounts: false }
  });
  const t = Hud.toText(ctx);
  ok(t.indexOf('不计数：静音') >= 0, '结论 = 不计数：静音', t);
  ok(t.indexOf('「静音也计时」已关闭') >= 0, '说明了是设置导致的');
}
{
  const ctx = base({
    playState: { paused: false, ended: false, muted: true, rate: 1, background: false },
    settings: { threshold: 5, minWatchSeconds: 30, mutedCounts: true }
  });
  const t = Hud.toText(ctx);
  ok(t.indexOf('不计数：静音') < 0, '开启「静音也计时」时不报不计数');
}

// ---------- 6. 合辑 ----------
console.log('\n【6】合辑只计视频级');
{
  const ctx = base({
    detection: { isMusic: true, confidence: 0.9, tid: 31, tname: '音乐', isCompilation: true, manualOverride: false }
  });
  const t = Hud.toText(ctx);
  ok(t.indexOf('仅计视频级：合辑不进歌曲榜') >= 0, '结论 = 仅计视频级', t);
}

// ---------- 7. 索引状态 ----------
console.log('\n【7】索引可用性');
{
  const ctx = base({ index: { known: true, ok: false, stale: false, count: null, title: '歌', ageMs: null } });
  const t = Hud.toText(ctx);
  ok(t.indexOf('不可用') >= 0 && t.indexOf('已收藏检测降级') >= 0, '索引不可用 → 明确提示已降级', t);
  ok(Hud.render(ctx).indexOf('is-bad') >= 0, '索引不可用用 bad（红）');
}
{
  const ctx = base({ index: { known: true, ok: true, stale: true, count: 276, title: '歌', ageMs: 26 * 3600 * 1000 } });
  const t = Hud.toText(ctx);
  ok(t.indexOf('已过期') >= 0 && t.indexOf('宁可多计一次') >= 0, '索引过期 → 说明降级策略', t);
  ok(Hud.render(ctx).indexOf('is-warn') >= 0, '索引过期用 warn（黄）');
}
{
  const ctx = base({ index: { known: true, ok: true, stale: false, count: 276, title: '歌', ageMs: 240000 } });
  const t = Hud.toText(ctx);
  ok(t.indexOf('索引 276 首「歌」') >= 0, '索引正常 → 显示条数与夹名', t);
}

// ---------- 8. 上报结果（成功） ----------
console.log('\n【8】上报成功');
{
  const ctx = base({
    session: { counted: true, sampleMs: 500, dropped: { seek: 0, mutedSec: 0, noAdvance: 0 } },
    counts: { video: 3, song: 3 },
    lastReport: { counted: true, videoPlayCount: 3, songPlayCount: 3, at: Date.now(), agoMs: 2000 }
  });
  const t = Hud.toText(ctx);
  ok(t.indexOf('已计入：有效收听达标') >= 0, '结论 = 已计入', t);
  ok(has(ctx, '上报 ✓ 已计入（视频 3 / 歌曲 3）'), '上报行给出视频/歌曲次数');
  ok(has(ctx, '会话 ✓ 已计入'), '会话行标记已计入');
}

// ---------- 9. 阈值进度 ----------
console.log('\n【9】阈值进度');
{
  const t1 = Hud.toText(base({ counts: { video: 3, song: 2 } }));
  ok(t1.indexOf('已听 视频 3/5') >= 0 && t1.indexOf('还差 2 次') >= 0, '未达标 → 显示还差几次', t1);
  const ctx2 = base({ counts: { video: 5, song: 5 }, reached: true });
  const t2 = Hud.toText(ctx2);
  ok(t2.indexOf('已达标') >= 0, '达标 → 显示已达标');
  ok(Hud.render(ctx2).indexOf('is-ok') >= 0, '达标用 ok（绿）');
}

// ---------- 10. 收藏夹容量 ----------
console.log('\n【10】收藏夹容量');
{
  const full = base({ folders: { title: '歌', nextName: '歌2', cap: { count: 1000, cap: 1000, remain: 0, ratio: 1, level: 'full' } } });
  const tf = Hud.toText(full);
  ok(tf.indexOf('已满 1000/1000') >= 0 && tf.indexOf('歌2') >= 0, '夹满 → 提示目标改为「歌2」', tf);
  ok(Hud.render(full).indexOf('is-bad') >= 0, '夹满用 bad（红）');

  const near = base({ folders: { title: '歌', nextName: '歌2', cap: { count: 950, cap: 1000, remain: 50, ratio: 0.95, level: 'warn' } } });
  ok(Hud.toText(near).indexOf('快满了') >= 0, '≥90% → 提示快满');
  ok(Hud.render(near).indexOf('is-warn') >= 0, '快满用 warn（黄）');

  const okCap = base({ folders: { title: '歌', nextName: '歌2', cap: { count: 276, cap: 1000, remain: 724, ratio: 0.276, level: 'ok' } } });
  ok(Hud.toText(okCap).indexOf('容量 276/1000') >= 0, '正常 → 显示 276/1000');
}

// ---------- 11. 丢弃统计 ----------
console.log('\n【11】为什么累计不涨');
{
  const ctx = base({
    session: { counted: false, sampleMs: 500, dropped: { seek: 3, mutedSec: 12.5, noAdvance: 2 } }
  });
  const t = Hud.toText(ctx);
  ok(t.indexOf('拖进度 3 次') >= 0, '统计「拖进度」次数', t);
  ok(t.indexOf('静音 12.5s') >= 0, '统计静音秒数');
  ok(t.indexOf('进度停滞 2 次') >= 0, '统计进度停滞次数');
}

// ---------- 12. AI ----------
console.log('\n【12】AI 判定状态');
{
  const applied = base({
    ai: { channel: 'queue', applied: true, songName: 'God knows...', version: 'Live', confidence: 0.91, reason: '标题含 Live 标记' }
  });
  const ta = Hud.toText(applied);
  ok(ta.indexOf('AI ✓ 已应用 God knows... · Live') >= 0 && ta.indexOf('(91%)') >= 0, 'AI 应用 → 显示曲名/版本/把握', ta);
  ok(Hud.render(applied).indexOf('is-ok') >= 0, 'AI 应用用 ok（绿）');

  const failed = base({ ai: { channel: 'direct', failed: '请求超时' } });
  ok(Hud.toText(failed).indexOf('已降级为规则结果') >= 0, 'AI 失败 → 说明已降级');

  const queued = base({ ai: { channel: 'queue', queued: true } });
  ok(Hud.toText(queued).indexOf('已入队') >= 0, 'AI 入队 → 提示队列中');

  const off = base({ ai: { channel: 'off' } });
  ok(Hud.toText(off).indexOf('AI ') < 0, 'AI 关闭时不显示该行');
}

// ---------- 13. 兜底与边界 ----------
console.log('\n【13】兜底与边界');
{
  const noDet = base({ detection: null });
  ok(Hud.toText(noDet).indexOf('等待元数据') >= 0, '判定未就绪 → 等待元数据');

  const noDur = base({ duration: 0 });
  ok(Hud.toText(noDur).indexOf('按最少 30s 兜底') >= 0, '时长未知 → 说明按最少秒数兜底');

  const noCounts = base({ counts: { video: null, song: null } });
  ok(Hud.toText(noCounts).indexOf('已听 ') < 0, '没有次数数据时不显示已听行');

  const bg = base({ playState: { paused: true, ended: false, muted: false, rate: 2, background: true } });
  const tb = Hud.toText(bg);
  ok(tb.indexOf('暂停 · 后台') >= 0 && tb.indexOf('2x') >= 0, '状态行显示 暂停/后台/倍速', tb);

  const notice = base({ notice: { text: '已收藏 → 本次跳过 1 张提醒卡', level: 'warn' } });
  ok(Hud.toText(notice).indexOf('已收藏 → 本次跳过 1 张提醒卡') >= 0, '临时提示可透传显示');
}

// ---------- 14. 转义安全 ----------
console.log('\n【14】HTML 转义');
{
  const evil = base({
    parsed: { songName: '<img src=x onerror=alert(1)>', version: '</div>', artist: '"quoted"' }
  });
  const html = Hud.render(evil);
  ok(html.indexOf('<img src=x') < 0, '曲目名中的标签被转义，不注入');
  ok(html.indexOf('&lt;img') >= 0, '转义为实体 &lt;img');
  ok(html.indexOf('&quot;quoted&quot;') >= 0, '引号被转义');

  const evilFolder = base({ fav: { known: true, faved: true, source: 'index', folder: '<b>x</b>' } });
  ok(Hud.render(evilFolder).indexOf('<b>x</b>') < 0, '收藏夹名也被转义');
}

// ---------- 15. 工具函数 ----------
console.log('\n【15】格式化工具');
{
  ok(Hud.fmtSec(93.44) === '93.4s', 'fmtSec 保留一位小数');
  ok(Hud.fmtSec(NaN) === '?', 'fmtSec 对 NaN 返回 ?');
  ok(Hud.fmtAgo(4000) === '刚刚', 'fmtAgo <8s → 刚刚');
  ok(Hud.fmtAgo(120000) === '2 分钟前', 'fmtAgo 分钟');
  ok(Hud.fmtAgo(26 * 3600 * 1000) === '1.1 天前', 'fmtAgo 超过一天');
  ok(Hud.fmtAgo(null) === '', 'fmtAgo null → 空串');
}

// ---------- 16. 优先级 ----------
console.log('\n【16】结论优先级');
{
  // 已收藏 > 非音乐：已收藏时不必再纠结音乐判定
  const both = base({
    fav: { known: true, faved: true, source: 'index', folder: '歌', checkedAgoMs: 1000 },
    detection: { isMusic: false, confidence: 0.1, tid: 0, tname: '', isCompilation: false, manualOverride: false }
  });
  ok(Hud.toText(both).indexOf('不计数：已在「歌」收藏夹') >= 0, '已收藏优先于非音乐', Hud.toText(both));

  // 非音乐 > 合辑
  const nm = base({ detection: { isMusic: false, confidence: 0.1, tid: 0, tname: '', isCompilation: true, manualOverride: false } });
  ok(Hud.toText(nm).indexOf('不计数：未判定为音乐') >= 0, '非音乐优先于合辑');

  // 一切正常 → 无结论行
  const clean = base();
  const h = Hud.render(clean);
  ok(h.indexOf('bmt-hud-head') < 0, '正常状态不出现结论行');
}

// ---------- 17. 常规行仍然齐全（不回退） ----------
console.log('\n【17】常规行不回退');
{
  const t = Hud.toText(base());
  ok(t.indexOf('曲目 千本桜 · original (初音ミク)') >= 0, '曲目行含版本与艺人', t);
  ok(t.indexOf('本次 10s / 需 93s') >= 0, '本次行格式正确（与已听次数区分口径）');
  ok(t.indexOf('状态 播放中 · 前台 · 有声') >= 0, '状态行完整');
  ok(t.indexOf('判定 音乐 0.92 · tid=31 音乐') >= 0, '判定行含 tid 与分区名', t);
  ok(t.indexOf('会话 未计入') >= 0, '会话行显示未计入');
  ok(t.indexOf('tick 500ms') >= 0, '保留采样间隔脚注');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) process.exit(1);
