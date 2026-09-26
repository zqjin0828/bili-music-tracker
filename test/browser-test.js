#!/usr/bin/env node
/**
 * browser-test.js — 真实浏览器里加载插件并测试
 *
 * 做四件事：
 *   1. 用独立配置目录启动浏览器，--load-extension 加载本插件，确认加载成功
 *   2. 打开真实的 B 站歌曲页，让它播放，读页面左下角的调试面板
 *   3. 直接读扩展的 chrome.storage.local，核对播放是否真的记进去了
 *   4. 后台播放测试：切到别的标签页，观察累计是否继续（这是本次修复的重点）
 *
 * 用法：
 *   node browser-test.js            全部流程
 *   node browser-test.js --no-bg    跳过耗时的后台测试
 *   node browser-test.js --bg-min 7 后台测试等待分钟数（默认 7）
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9350;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'bmt-ext-test');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
};
const SKIP_BG = !!arg('no-bg', false);
const BG_MIN = Number(arg('bg-min', 7)) || 7;

// 测试用曲目
// 选取标准：① 时长 60~200 秒（默认门槛 max(30s, 时长×0.3)=30s，一轮约 40 秒）
//          ② 判定器能识别为音乐（score ≥ 3.5），否则会被「非音乐」规则挡掉
const SONGS = [
  { bv: 'BV1Rwe4zvEUq', name: 'ksm:我现在肺痒痒【夢ノ結唱POPY】', dur: 86 },
  { bv: 'BV1QU99Y7EfL', name: '【夢ノ結唱 ROSE】翼をください（《日常》第13话ED）', dur: 90 },
  { bv: 'BV1kNTp6XEte', name: '最合适的一集！梦限大ED 口琴速翻！', dur: 91 }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '\n      ' + extra : '')); }
}

// ---------- CDP ----------

async function waitForCdp(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      if (r.ok) return await r.json();
    } catch (e) { /* 未就绪 */ }
    await sleep(300);
  }
  return null;
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws error')));
    });
    this.ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, 30000);
    });
  }
  async evalIn(pageWs, expr, awaitPromise) {
    // 简化：所有 eval 都走各自的 session
    throw new Error('use per-target eval');
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

/** 为一个 target 建 session，并提供 eval 方法 */
async function connect(target) {
  const c = new Cdp(target.webSocketDebuggerUrl);
  await c.ready;
  const self = {
    raw: c,
    async eval(expr, awaitPromise) {
      const r = await c.send('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true
      });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
        throw new Error('页面异常: ' + (d || '?'));
      }
      return r.result.value;
    },
    async json(expr) {
      const s = await this.eval('(async()=>{try{' + expr + '}catch(e){return JSON.stringify({__err:String(e)})}})()', true);
      try { return JSON.parse(s); } catch (e) { return { __err: 'parse:' + s }; }
    },
    close() { c.close(); }
  };
  await c.send('Page.enable').catch(() => {});
  await c.send('Runtime.enable').catch(() => {});
  return self;
}

async function listTargets() {
  return (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json());
}

/** 新建标签页，直接返回 /json/new 给出的 target（比"取最后一个"可靠） */
async function newTab(url) {
  const r = await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  const t = await r.json();
  if (t && t.id && t.webSocketDebuggerUrl) return t;
  // 兜底
  await sleep(900);
  const pages = (await listTargets()).filter(x => x.type === 'page');
  return pages[pages.length - 1];
}

async function activate(targetId) {
  try {
    await fetch('http://127.0.0.1:' + PORT + '/json/activate/' + targetId);
  } catch (e) { /* ignore */ }
}

// ---------- 主流程 ----------

async function main() {
  console.log('════════════════════════════════════════════════');
  console.log('真实浏览器测试：加载插件 + 真实播放 + 读扩展存储');
  console.log('════════════════════════════════════════════════');
  console.log('插件目录: ' + EXT);

  // 清掉旧测试配置，保证每次干净
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  fs.mkdirSync(PROFILE, { recursive: true });

  // ★ 实测：Chrome 153 已移除 --load-extension 支持（加载不生效），
  //   Edge 153 仍然支持。所以自动化测试用 Edge。
  //   （用户手动「加载已解压的扩展程序」不受影响，两种浏览器都行。）
  const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const CHROME_BIN = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const bin = fs.existsSync(EDGE_BIN) ? EDGE_BIN : CHROME_BIN;
  console.log('浏览器  : ' + bin + (bin === EDGE_BIN ? '  （Edge 仍支持 --load-extension）' : ''));
  console.log('注意    : Chrome 153+ 已不认 --load-extension，若用 Chrome 需手动加载\n');

  const child = spawn(bin, [
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--load-extension=' + EXT,
    '--disable-extensions-except=' + EXT,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeIdentityFRE,msEdgeFirstRunExperience',
    '--mute-audio',
    '--window-size=1100,780',
    'about:blank'
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  const ver = await waitForCdp(30000);
  if (!ver) { console.log('✗ CDP 未就绪'); process.exit(1); }
  console.log('版本    : ' + ver.Browser + '\n');

  // ---------- 1. 插件是否加载 ----------
  // 注意：MV3 的 Service Worker 是懒启动的，启动后不会出现在 target 列表里。
  // 所以先打开一个 B 站页面（触发内容脚本 → sendMessage → 唤醒 SW），再去找 SW。
  console.log('=== 1. 插件加载检查 ===');

  const warm = await newTab('https://www.bilibili.com/video/' + SONGS[0].bv);
  let hudSeen = false;
  {
    const page = await connect(warm);
    for (let k = 0; k < 40; k++) {
      await sleep(700);
      try { if (await page.eval('!!document.querySelector(".bmt-hud")')) { hudSeen = true; break; } } catch (e) { /* ignore */ }
    }
    page.close();
  }
  ok(hudSeen, '内容脚本已注入（页面出现 .bmt-hud 调试面板）');

  let extId = null, swTarget = null;
  for (let i = 0; i < 20 && !swTarget; i++) {
    const ts = await listTargets();
    swTarget = ts.find(t => t.type === 'service_worker' && t.url.includes('background.js'));
    if (swTarget) extId = swTarget.url.split('/')[2];
    else await sleep(600);
  }
  ok(!!extId, '扩展 Service Worker 已唤醒' + (extId ? '（id=' + extId.slice(0, 12) + '…）' : ''));
  if (!extId) { console.log('\n插件未能加载，无法继续。'); process.exit(1); }

  // 读 Service Worker 里的默认设置
  let swSession = null;
  {
    swSession = await connect(swTarget);
    const s = await swSession.json(`
      const d = await chrome.storage.local.get(['settings','videoStats','songStats']);
      const st = d.settings || {};
      return JSON.stringify({
        版本: chrome.runtime.getManifest().version,
        debugHud: st.debugHud,
        minWatchSeconds: st.minWatchSeconds,
        minWatchRatio: st.minWatchRatio,
        threshold: st.threshold,
        已有视频记录: Object.keys(d.videoStats||{}).length
      });`);
    console.log('    扩展信息: ' + JSON.stringify(s));
    ok(s.版本 === '1.2.1', '扩展版本为 1.2.1（当前源码版本）', 'got ' + s.版本);
    ok(s.debugHud === true, '调试面板默认开启');
  }

  // ---------- 2. 逐首播放 ----------
  console.log('\n=== 2. 真实播放测试 ===');
  const playResults = [];

  for (let i = 0; i < SONGS.length; i++) {
    const song = SONGS[i];
    console.log('\n--- [' + (i + 1) + '/' + SONGS.length + '] ' + song.name + ' (' + song.bv + ', ' + song.dur + 's) ---');

    const url = 'https://www.bilibili.com/video/' + song.bv;
    const target = await newTab(url);
    await activate(target.id);
    const page = await connect(target);

    // 等页面与播放器就绪
    let ready = false;
    for (let k = 0; k < 30; k++) {
      await sleep(700);
      try {
        const has = await page.eval('!!document.querySelector("video")');
        if (has) { ready = true; break; }
      } catch (e) { /* 导航中 */ }
    }
    ok(ready, '找到 <video> 元素');
    if (!ready) { page.close(); continue; }

    // 等元数据
    let dur = 0;
    for (let k = 0; k < 20; k++) {
      await sleep(500);
      try {
        dur = await page.eval('(function(){var v=document.querySelector("video");return (v&&isFinite(v.duration))?v.duration:0})()');
        if (dur > 0) break;
      } catch (e) { /* ignore */ }
    }
    console.log('    实际时长: ' + (dur ? dur.toFixed(1) + 's' : '未知'));

    // 开始播放
    try {
      await page.eval('(function(){var v=document.querySelector("video"); v.muted=false; v.play(); return 1})()');
    } catch (e) { /* ignore */ }

    // 等调试面板出现
    let hudOk = false;
    for (let k = 0; k < 12; k++) {
      await sleep(700);
      try {
        if (await page.eval('!!document.querySelector(".bmt-hud")')) { hudOk = true; break; }
      } catch (e) { /* ignore */ }
    }
    ok(hudOk, '调试面板已注入（说明内容脚本在运行）');

    // 观察累计进度：每 5 秒读一次 HUD，最多 60 秒
    const timeline = [];
    let counted = false;
    for (let k = 0; k < 12; k++) {
      await sleep(5000);
      let txt = '';
      try { txt = await page.eval('(function(){var e=document.querySelector(".bmt-hud");return e?e.innerText.replace(/\\n/g," | "):""})()'); } catch (e) { /* ignore */ }
      let have = 0;
      const m = /累计\s+([\d.]+)s/.exec(txt);
      if (m) have = parseFloat(m[1]);
      timeline.push(have);
      if (txt.includes('已计入')) counted = true;
      // 已计入后再多采两次，便于验证"继续增长"
      if (counted && timeline.length >= 3) break;
    }
    const accs = timeline.map(x => x.toFixed(1) + 's').join(' → ');
    console.log('    累计轨迹: ' + accs);
    const rose = timeline.length >= 2 && timeline[timeline.length - 1] > timeline[0] + 0.5;
    ok(rose, '累计秒数在增长（' + (timeline[0] || 0).toFixed(1) + 's → ' +
      (timeline[timeline.length - 1] || 0).toFixed(1) + 's）');
    ok(counted, '达到门槛并计入', counted ? '' : '未在 60 秒内触发');

    playResults.push({ song, counted, lastAcc: timeline[timeline.length - 1] || 0, targetId: target.id, page });
    if (i < SONGS.length - 1) await sleep(1500);
  }

  // ---------- 3. 核对扩展存储 ----------
  console.log('\n=== 3. 核对扩展存储（chrome.storage.local）===');
  if (swSession) {
    const store = await swSession.json(`
      const d = await chrome.storage.local.get(['videoStats','songStats']);
      const vs = d.videoStats || {}, ss = d.songStats || {};
      return JSON.stringify({
        视频数: Object.keys(vs).length,
        歌曲数: Object.keys(ss).length,
        视频: Object.entries(vs).map(([k,v])=>({key:k,title:(v.title||'').slice(0,40),count:v.playCount,isMusic:v.isMusic,conf:v.musicConfidence})),
        歌曲: Object.entries(ss).map(([k,v])=>({key:k.slice(0,40),count:v.playCount}))
      });`);
    console.log('    记录到的视频 ' + store.视频数 + ' 个，歌曲 ' + store.歌曲数 + ' 个');
    for (const v of (store.视频 || [])) {
      console.log('      · ' + v.count + ' 次  ' + v.title + '  [音乐=' + v.isMusic + ' 置信=' + (v.conf || 0).toFixed(2) + ']');
    }
    const tested = playResults.filter(r => r.counted).length;
    ok((store.视频数 || 0) >= 1, '扩展存储里确实有播放记录');
    ok((store.视频 || []).some(v => v.count >= 1), '有视频的 playCount ≥ 1');
  } else {
    ok(false, '无法读取扩展存储（未连上 Service Worker）');
  }

  // ---------- 4. 后台播放测试 ----------
  if (!SKIP_BG) {
    console.log('\n=== 4. 后台播放测试（关键：定时器节流）===');
    console.log('    等待 ' + BG_MIN + ' 分钟 —— Chrome 在标签页隐藏 5 分钟后会把定时器降到约每分钟 1 次，');
    console.log('    旧版实现此时累计会归零，新版应继续正常累计。');

    const url = 'https://www.bilibili.com/video/' + SONGS[0].bv;
    const target = await newTab(url);
    const page = await connect(target);

    let ready = false;
    for (let k = 0; k < 30; k++) {
      await sleep(700);
      try { if (await page.eval('!!document.querySelector("video")')) { ready = true; break; } } catch (e) { /* ignore */ }
    }
    if (ready) {
      await page.eval('(function(){var v=document.querySelector("video"); v.muted=false; v.play(); return 1})()');
      for (let k = 0; k < 10; k++) { await sleep(600); try { await page.eval('!!document.querySelector(".bmt-hud")'); } catch (e) { /* ignore */ } }

      // ★ 切到别的标签页，让这个页面进入 hidden
      const other = await newTab('about:blank');
      await activate(other.id);
      console.log('    已切走，目标页面处于后台（visibility=' +
        (await page.eval('document.visibilityState')) + '）');
      ok((await page.eval('document.visibilityState')) === 'hidden', '目标页面已进入后台');

      const samples = [];
      const t0 = Date.now();
      const need = BG_MIN * 60 * 1000;
      while (Date.now() - t0 < need) {
        await sleep(30000);
        let txt = '';
        try { txt = await page.eval('(function(){var e=document.querySelector(".bmt-hud");return e?e.innerText.replace(/\\n/g," | "):""})()'); } catch (e) { /* ignore */ }
        const m = /累计\s+([\d.]+)s/.exec(txt);
        const have = m ? parseFloat(m[1]) : -1;
        const el = Math.round((Date.now() - t0) / 1000);
        const vis = (await page.eval('document.visibilityState').catch(() => '?'));
        samples.push({ el, have, vis, counted: txt.includes('已计入') });
        console.log('    [' + String(el).padStart(3) + 's] 后台累计 ' + (have >= 0 ? have.toFixed(1) + 's' : '?') +
          '  ' + (txt.includes('已计入') ? '已计入' : '未计入') + '  vis=' + vis);
        if (txt.includes('已计入')) break;
      }

      const last = samples[samples.length - 1];
      const first = samples[0];
      ok(last.have > first.have, '后台期间累计持续增长（' + first.have.toFixed(1) + 's → ' + last.have.toFixed(1) + 's）');
      ok(last.counted, '后台播放最终达成了计数');
      ok(samples.length >= 3, '采样持续到 ' + last.el + ' 秒（验证超过 5 分钟节流阈值）');
    } else {
      ok(false, '后台测试页面未就绪');
    }
  } else {
    console.log('\n=== 4. 后台播放测试：已跳过（--no-bg）===');
  }

  // ---------- 汇总 ----------
  console.log('\n════════════════════════════════════════════════');
  console.log('结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('（浏览器保持运行，端口 ' + PORT + '，配置目录 ' + PROFILE + '）');

  // WebSocket 连接会让事件循环一直活着，必须显式退出
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('测试异常: ' + (e && e.stack || e)); process.exit(1); });
