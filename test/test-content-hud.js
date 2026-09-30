#!/usr/bin/env node
/**
 * test-content-hud.js — content.js 与调试面板的联动（集成级）
 *
 * 为什么需要它：
 *   test-hud.js 只验证 hud.js 这个纯函数「怎么渲染」。
 *   但真正会出问题的是**接线**：content.js 有没有把后台返回的
 *   `already-faved` 落到 HUD 现场？进页面时有没有主动查收藏状态？
 *   拖动进度、静音有没有被统计成「丢弃」？
 *
 *   这个测试在最小 VM 里真实加载 src/content.js（连同 parser / detector / hud），
 *   用假的 DOM 与 chrome API 驱动完整流程，最后断言 HUD 的 innerHTML。
 *
 * 覆盖：
 *   - 进页面主动查收藏状态 → HUD 顶部出现「不计数：已在「歌」收藏夹」
 *   - RECORD_PLAY 返回 already-faved → 上报行 + 结论行同步更新
 *   - RECORD_PLAY 成功 → 已听次数、上报行、结论 = 已计入
 *   - 拖动进度 / 静音 → 丢弃统计出现在 HUD
 *   - 索引不可用 / 过期 → 索引行染红或染黄
 *   - 达标但已收藏 → 跳过弹卡并记进 HUD
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '\n      ' + extra : '')); }
}

// ==================== 最小 DOM ====================

class ClassList {
  constructor(el) { this.el = el; }
  _set() {
    this.el._cls = new Set(String(this.el.className || '').split(/\s+/).filter(Boolean));
    return this.el._cls;
  }
  add(...c) { const s = this._set(); c.forEach(x => s.add(x)); this.el.className = [...s].join(' '); }
  remove(...c) { const s = this._set(); c.forEach(x => s.delete(x)); this.el.className = [...s].join(' '); }
  contains(c) { return this._set().has(c); }
}

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.className = '';
    this.id = '';
    this._html = '';
    this._text = '';
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this.isConnected = true;
    this._attrs = {};
    this._listeners = {};
    this.classList = new ClassList(this);
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  fire(t) { (this._listeners[t] || []).forEach(fn => fn({ preventDefault() {} })); }
}

// ==================== 沙箱环境 ====================

function buildEnv(opts) {
  opts = opts || {};
  const RealDate = Date;
  let NOW = 1700000000000;
  const intervals = [];
  const timeouts = [];

  const video = new El('video');
  Object.assign(video, { paused: true, ended: false, muted: false, playbackRate: 1, currentTime: 0, duration: opts.duration != null ? opts.duration : 310 });

  const titleEl = new El('h1');
  titleEl.setAttribute('title', opts.title || '【初音ミク】千本桜【オリジナル】');
  titleEl._text = opts.title || '【初音ミク】千本桜【オリジナル】';

  const body = new El('body');
  const html = new El('html');

  const document = {
    readyState: 'complete',
    visibilityState: opts.hidden ? 'hidden' : 'visible',
    body,
    documentElement: html,
    querySelector(sel) {
      if (sel === 'video') return video;
      if (/h1\.video-title/.test(sel) || sel === 'h1') return titleEl;
      if (/up-name/.test(sel)) return null;
      return null;
    },
    querySelectorAll() { return []; },
    createElement(tag) { return new El(tag); },
    getElementById() { return null; },
    addEventListener() {}, removeEventListener() {}
  };

  // 找出 HUD 元素（content.js 用 className='bmt-hud' 创建后 append 到 body）
  function hudEl() {
    return body.children.find(c => String(c.className).indexOf('bmt-hud') >= 0) || null;
  }

  const sent = [];
  let recordPlayReply = { ok: true, data: { counted: true, videoPlayCount: 1, songPlayCount: 1, notifications: [] } };
  let favCheckReply = { ok: true, data: { bvid: '', faved: false, source: 'none', folderTitle: null, indexCount: 276, stale: false } };
  let favStatusReply = {
    ok: true,
    data: {
      hasIndex: true, folderTitle: '歌', count: 276, fetchedAt: NOW - 240000, stale: false,
      cap: { count: 276, cap: 1000, remain: 724, ratio: 0.276, level: 'ok' },
      nextName: '歌2'
    }
  };
  let onMessageListener = null;

  const chromeApi = {
    runtime: {
      sendMessage: async (msg) => {
        sent.push(msg && msg.type);
        switch (msg && msg.type) {
          case 'GET_SETTINGS':
            return { ok: true, data: Object.assign({
              threshold: 5, videoLevel: true, songLevel: true,
              minWatchRatio: 0.3, minWatchSeconds: 30,
              mutedCounts: true, favFolderName: '歌', debugHud: true
            }, opts.settings || {}) };
          case 'GET_VIDEO_META':
            return { ok: true, data: { bvid: msg.bvid, tid: opts.tid != null ? opts.tid : 31, tname: opts.tname || '音乐', owner: opts.up || 'みくすん', duration: video.duration, desc: '' } };
          case 'FAV_CHECK_BVID':
            return favCheckReply;
          case 'FAV_GET_STATUS':
            return favStatusReply;
          case 'RECORD_PLAY':
            return recordPlayReply;
          case 'SET_SETTINGS':
            return { ok: true };
          default:
            return { ok: true };
        }
      },
      onMessage: { addListener(fn) { onMessageListener = fn; } }
    }
  };

  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
  }

  const window = {
    __INITIAL_STATE__: undefined,
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() {},
    open() {},
    location: { href: 'https://www.bilibili.com/video/BV1a', pathname: '/video/BV1a', search: '' },
    document
  };

  // content.js 会 hook history.pushState/replaceState 以感知 SPA 路由变化
  const history = { pushState() {}, replaceState() {}, state: null };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    chrome: chromeApi,
    window,
    document,
    history,
    location: window.location,
    Event: class { constructor(t) { this.type = t; } },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (fn, ms) => { const t = { fn, ms }; timeouts.push(t); return t; },
    clearTimeout: (t) => { const i = timeouts.indexOf(t); if (i >= 0) timeouts.splice(i, 1); },
    setInterval: (fn, ms) => { const t = { fn, ms }; intervals.push(t); return t; },
    clearInterval: (t) => { const i = intervals.indexOf(t); if (i >= 0) intervals.splice(i, 1); },
    Date: FakeDate,
    Promise, Math, JSON, Object, Array, String, Number, Boolean,
    isFinite, parseInt, parseFloat, RegExp, Error, TypeError, Map, Set, Symbol,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    URL, encodeURIComponent, decodeURIComponent
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  // 加载模块（顺序与 manifest 一致，hud 在 content 之前）
  for (const f of ['src/parser.js', 'src/detector.js', 'src/hud.js', 'src/content.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }

  return {
    sandbox, chromeApi,
    video, body, hudEl,
    sent,
    /** 让 content.js 里所有 setInterval(tick,500) 跑 n 次，并推进时钟 */
    tick(n, opts2) {
      opts2 = opts2 || {};
      for (let i = 0; i < n; i++) {
        NOW += 500;
        if (opts2.step != null) video.currentTime += opts2.step;
        intervals.filter(t => t.ms === 500).forEach(t => t.fn());
      }
    },
    flush: () => new Promise(r => setTimeout(r, 30)),
    setRecordPlayReply(v) { recordPlayReply = v; },
    setFavCheck(v) { favCheckReply = v; },
    setFavStatus(v) { favStatusReply = v; },
    NOW: () => NOW,
    onMessageListener: () => onMessageListener
  };
}

// ==================== 断言辅助 ====================

function hudText(env) {
  const el = env.hudEl();
  if (!el) return '';
  return String(el.innerHTML)
    .replace(/<span class="bmt-hud-dim">/g, '')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

console.log('\n▶ test-content-hud.js  —  content.js ↔ 调试面板联动');

(async () => {

  // ---------- 1. 进页面即主动查收藏状态 ----------
  console.log('\n【1】加载后主动查收藏状态（不必等播完）');
  {
    const env = buildEnv();
    env.setFavCheck({ ok: true, data: { bvid: 'BV1a', faved: true, source: 'index', folderTitle: '歌', indexCount: 276, stale: false } });
    await env.flush();
    env.tick(2);                     // 让 tick 跑起来，HUD 才会被创建
    await env.flush();

    ok(env.sent.indexOf('FAV_CHECK_BVID') >= 0, '加载后主动发了 FAV_CHECK_BVID');
    ok(env.sent.indexOf('FAV_GET_STATUS') >= 0, '加载后主动发了 FAV_GET_STATUS');
    const t = hudText(env);
    ok(t.indexOf('不计数：已在「歌」收藏夹') >= 0, 'HUD 顶部结论 = 不计数：已在「歌」收藏夹', t);
    ok(t.indexOf('收藏 已在「歌」') >= 0, '收藏行显示已在「歌」');
    ok(t.indexOf('依据 后台索引') >= 0, '依据 = 后台索引');
    ok(t.indexOf('索引 276 首「歌」') >= 0, '索引行显示条数与夹名');
  }

  // ---------- 2. 未收藏时不应误报 ----------
  console.log('\n【2】未收藏 → 不误报');
  {
    const env = buildEnv();
    env.setFavCheck({ ok: true, data: { bvid: 'BV1a', faved: false, source: 'none', folderTitle: null, indexCount: 276, stale: false } });
    await env.flush();
    env.tick(2);
    await env.flush();
    const t = hudText(env);
    ok(t.indexOf('不计数：已在') < 0, '没有「不计数：已在」结论', t);
    ok(t.indexOf('收藏 未收藏') >= 0, '收藏行显示未收藏', t);
  }

  // ---------- 3. RECORD_PLAY 返回 already-faved → 上报行同步 ----------
  console.log('\n【3】后台判成已收藏 → HUD 立刻反映');
  {
    const env = buildEnv({ duration: 100 });
    env.setFavCheck({ ok: true, data: { bvid: 'BV1a', faved: false, source: 'none', folderTitle: null, indexCount: 276, stale: false } });
    env.setRecordPlayReply({
      ok: true,
      data: { counted: false, reason: 'already-faved', favedSource: 'index', videoPlayCount: 7 }
    });
    await env.flush();

    // 播放到达标：duration=100 → need = max(30, 30) = 30s
    env.video.paused = false;
    env.tick(80, { step: 0.5 });     // 累计 40s，超过 need=30
    await env.flush();

    ok(env.sent.indexOf('RECORD_PLAY') >= 0, '已触发 RECORD_PLAY');
    const t = hudText(env);
    ok(t.indexOf('上报 ✕ 已在收藏夹，跳过计数') >= 0, '上报行回显后台拒绝原因', t);
    ok(t.indexOf('不计数：已在「歌」收藏夹') >= 0, '结论行改为不计数', t);
  }

  // ---------- 4. RECORD_PLAY 成功 → 次数与结论 ----------
  console.log('\n【4】上报成功 → 已听次数 / 结论 = 已计入');
  {
    const env = buildEnv({ duration: 100 });
    env.setRecordPlayReply({
      ok: true,
      data: { counted: true, videoPlayCount: 3, songPlayCount: 3, notifications: [] }
    });
    await env.flush();
    env.video.paused = false;
    env.tick(80, { step: 0.5 });
    await env.flush();

    const t = hudText(env);
    ok(t.indexOf('已计入：有效收听达标') >= 0, '结论 = 已计入', t);
    ok(t.indexOf('已听 视频 3/5') >= 0 && t.indexOf('歌曲 3/5') >= 0, '已听行显示 3/5', t);
    ok(t.indexOf('还差 2 次') >= 0, '提示还差几次', t);
    ok(t.indexOf('上报 ✓ 已计入') >= 0, '上报行标记已计入', t);
    ok(t.indexOf('会话 ✓ 已计入') >= 0, '会话行标记已计入', t);
  }

  // ---------- 5. 丢弃统计：拖动进度 ----------
  console.log('\n【5】拖动进度 → HUD 解释秒数为何不涨');
  {
    const env = buildEnv({ duration: 600 });
    await env.flush();
    env.video.paused = false;
    env.tick(4, { step: 0.5 });        // 正常播放 2s
    // 一次大幅拖动：墙钟 0.5s，进度跳 100s
    env.tick(1, { step: 100 });
    const t = hudText(env);
    ok(t.indexOf('丢弃') >= 0, '出现「丢弃」行', t);
    ok(t.indexOf('拖进度') >= 0, '统计到拖动进度', t);
  }

  // ---------- 6. 静音且不允许静音计时 ----------
  console.log('\n【6】静音（关闭「静音也计时」）→ 结论 + 静音秒数');
  {
    const env = buildEnv({ settings: { mutedCounts: false } });
    await env.flush();
    env.video.paused = false;
    env.video.muted = true;
    env.tick(6, { step: 0.5 });
    const t = hudText(env);
    ok(t.indexOf('不计数：静音') >= 0, '结论 = 不计数：静音', t);
    ok(t.indexOf('静音') >= 0 && t.indexOf('静音不计时已在设置里关闭') >= 0, '说明是设置导致', t);
  }

  // ---------- 7. 索引不可用 / 过期 ----------
  console.log('\n【7】索引降级');
  {
    const env = buildEnv();
    env.setFavStatus({ ok: true, data: { hasIndex: false, count: 0, stale: false, cap: null, nextName: '歌2' } });
    env.setFavCheck({ ok: true, data: { bvid: 'BV1a', faved: false, source: 'none', indexCount: 0, stale: false } });
    await env.flush();
    env.tick(2);
    await env.flush();
    const t1 = hudText(env);
    ok(t1.indexOf('索引 ✕ 不可用') >= 0, '索引不可用 → 红字提示已降级', t1);
    ok(String(env.hudEl().innerHTML).indexOf('is-bad') >= 0, '带 bad 染色类');
  }
  {
    const env = buildEnv();
    env.setFavStatus({
      ok: true,
      data: {
        hasIndex: true, folderTitle: '歌', count: 276, fetchedAt: env.NOW() - 26 * 3600 * 1000,
        stale: true, cap: { count: 276, cap: 1000, remain: 724, ratio: 0.276, level: 'ok' }, nextName: '歌2'
      }
    });
    await env.flush();
    env.tick(2);
    await env.flush();
    const t2 = hudText(env);
    ok(t2.indexOf('索引 ! 已过期') >= 0, '索引过期 → 黄字说明降级策略', t2);
    ok(t2.indexOf('宁可多计一次') >= 0, '给出降级理由');
  }

  // ---------- 8. 夹满 → 目标改为歌2 ----------
  console.log('\n【8】收藏夹满了');
  {
    const env = buildEnv();
    env.setFavStatus({
      ok: true,
      data: {
        hasIndex: true, folderTitle: '歌', count: 1000, fetchedAt: env.NOW() - 60000, stale: false,
        cap: { count: 1000, cap: 1000, remain: 0, ratio: 1, level: 'full' }, nextName: '歌2'
      }
    });
    await env.flush();
    env.tick(2);
    await env.flush();
    const t = hudText(env);
    ok(t.indexOf('已满 1000/1000') >= 0, '容量行提示已满', t);
    ok(t.indexOf('歌2') >= 0, '提示目标改为「歌2」');
  }

  // ---------- 9. 达标但已收藏 → 跳过弹卡并记入 HUD ----------
  console.log('\n【9】达标时已收藏 → 跳过弹卡 + 记进 HUD');
  {
    const env = buildEnv();
    env.setFavCheck({ ok: true, data: { bvid: 'BV1a', faved: true, source: 'index', folderTitle: '歌', indexCount: 276, stale: false } });
    await env.flush();
    env.tick(2);
    await env.flush();

    const listener = env.onMessageListener();
    ok(typeof listener === 'function', '已注册 onMessage 监听');
    if (listener) {
      await new Promise((resolve) => {
        listener(
          { type: 'THRESHOLD_REACHED', notifications: [{ bvid: 'BV1a', songName: '千本桜', playCount: 5 }] },
          null,
          () => resolve()
        );
        setTimeout(resolve, 40);
      });
      const t = hudText(env);
      ok(t.indexOf('提醒 已收藏 → 本次跳过 1 张提醒卡') >= 0, 'HUD 记录「跳过 N 张提醒卡」', t);
      ok(env.body.children.filter(c => String(c.className).indexOf('bmt-card') >= 0).length === 0,
        '没有真的弹出提醒卡片');
    }
  }

  // ---------- 10. 非音乐 ----------
  console.log('\n【10】非音乐 → 结论 + 修正建议');
  {
    // 选一个判定器确实会判成非音乐的标题（教程类，tid=21 日常）
    const env = buildEnv({ tid: 21, tname: '日常', title: '【编程】Python 爬虫教程 第一讲 环境搭建' });
    await env.flush();
    env.tick(2);
    await env.flush();
    const t = hudText(env);
    ok(t.indexOf('不计数：未判定为音乐') >= 0, '结论 = 不计数：未判定为音乐', t);
    ok(t.indexOf('可在弹窗里「标为音乐」修正') >= 0, '给出修正路径');
    ok(t.indexOf('判定 非音乐') >= 0, '判定行标为非音乐', t);
  }

  // ---------- 11. 曲目行来自真实解析 ----------
  console.log('\n【11】曲目行来自真实解析结果');
  {
    const env = buildEnv({ title: '【初音ミク】千本桜【オリジナル】' });
    await env.flush();
    env.tick(2);
    await env.flush();
    const t = hudText(env);
    ok(t.indexOf('曲目 千本桜') >= 0, 'HUD 显示了真实解析出的曲名', t);
  }

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) process.exit(1);
})();
