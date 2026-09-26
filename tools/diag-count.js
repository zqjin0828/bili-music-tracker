#!/usr/bin/env node
/**
 * diag-count.js — 诊断「HUD 显示已计入，但扩展存储为空」
 *
 * 做法：
 *   1. 加载插件、打开一首歌、播放
 *   2. 捕获**页面控制台**（内容脚本的 log 会打印上报结果与原因）
 *   3. 打印 HUD 全文（含「判定」行）
 *   4. 直接读扩展存储，并打印 recordPlay 的返回
 */

'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9362;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'bmt-diag');
const BV = 'BV1Rwe4zvEUq';

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    this.events = [];
    this.ready = new Promise((res, rej) => {
      ws.addEventListener('open', () => res());
      ws.addEventListener('error', () => rej(new Error('ws error')));
    });
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.method) { this.events.push(m); return; }
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
      }, 25000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
      throw new Error('页面异常: ' + (d || '?'));
    }
    return r.result.value;
  }
  async json(expr) {
    const s = await this.eval('(async()=>{try{' + expr + '}catch(e){return JSON.stringify({__err:String(e)})}})()');
    try { return JSON.parse(s); } catch (e) { return { __err: 'parse:' + s }; }
  }
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const c = new Cdp(ws);
  await c.ready;
  return c;
}

async function main() {
  try { execSync('taskkill /F /IM msedge.exe /T', { stdio: 'ignore' }); } catch (e) { /* ignore */ }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  fs.mkdirSync(PROFILE, { recursive: true });

  const child = spawn(EDGE, [
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
    '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  let ver = null;
  for (let i = 0; i < 80; i++) { await sleep(300); try { ver = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); break; } catch (e) { /* wait */ } }
  if (!ver) { console.log('CDP 未就绪'); process.exit(1); }

  const nr = await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent('https://www.bilibili.com/video/' + BV), { method: 'PUT' });
  const target = await nr.json();
  const page = await connect(target);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');

  console.log('=== 等待播放器 ===');
  for (let i = 0; i < 40; i++) { await sleep(700); try { if (await page.eval('!!document.querySelector("video")')) break; } catch (e) { /* ignore */ } }
  for (let i = 0; i < 20; i++) { await sleep(500); try { const d = await page.eval('(function(){var v=document.querySelector("video");return (v&&isFinite(v.duration))?v.duration:0})()'); if (d > 0) { console.log('  时长 ' + d.toFixed(1) + 's'); break; } } catch (e) { /* ignore */ } }

  await page.eval('(function(){var v=document.querySelector("video"); v.muted=false; v.play(); return 1})()');
  console.log('  已开始播放\n');

  // 观察 50 秒
  for (let i = 0; i < 10; i++) {
    await sleep(5000);
    let hud = '';
    try { hud = await page.eval('(function(){var e=document.querySelector(".bmt-hud");return e?e.innerText.replace(/\\n/g," | "):"(无面板)"})()'); } catch (e) { hud = '(读取失败)'; }
    console.log('[' + String((i + 1) * 5).padStart(2) + 's] ' + hud);
  }

  console.log('\n=== 页面控制台（内容脚本日志）===');
  for (const ev of page.events) {
    if (ev.method === 'Runtime.consoleAPICalled') {
      const args = (ev.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || a.type));
      console.log('  [' + ev.params.type + '] ' + args.join(' ').slice(0, 300));
    }
    if (ev.method === 'Log.entryAdded') {
      console.log('  [log] ' + String(ev.params.entry.text).slice(0, 200));
    }
  }

  console.log('\n=== 内容脚本读到的元数据与判定 ===');
  const meta = await page.eval(`(function(){
    var st = window.__INITIAL_STATE__;
    var vd = st && (st.videoData || (st.videoInfo && st.videoInfo.videoData));
    var v = document.querySelector('video');
    return JSON.stringify({
      有INITIAL_STATE: !!st,
      有videoData: !!vd,
      tid: vd ? vd.tid : null,
      tname: vd ? vd.tname : null,
      title: vd ? String(vd.title||'').slice(0,50) : null,
      up: vd ? (vd.owner && vd.owner.name) : null,
      apiDuration: vd ? vd.duration : null,
      elDuration: v ? v.duration : null
    });
  })()`);
  console.log('  ' + meta);

  console.log('\n=== 扩展存储 ===');
  const ts = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const sw = ts.find(t => t.type === 'service_worker' && t.url.includes('background.js'));
  if (!sw) { console.log('  ✗ 找不到 Service Worker'); }
  else {
    const s = await connect(sw);
    const store = await s.json(`
      const d = await chrome.storage.local.get(null);
      return JSON.stringify({
        keys: Object.keys(d),
        videoStats: d.videoStats || {},
        settings_aiChannel: (d.settings||{}).aiChannel,
        settings_includeSuspect: (d.settings||{}).includeSuspect
      });`);
    console.log('  存储键: ' + JSON.stringify(store.keys));
    console.log('  aiChannel=' + store.settings_aiChannel + '  includeSuspect=' + store.settings_includeSuspect);
    const vs = store.videoStats || {};
    console.log('  videoStats 条目数: ' + Object.keys(vs).length);
    for (const [k, val] of Object.entries(vs)) {
      console.log('    ' + k + '  playCount=' + val.playCount + ' isMusic=' + val.isMusic + ' conf=' + val.musicConfidence + ' title=' + String(val.title).slice(0, 40));
    }

    // 直接手测 recordPlay 看返回什么
    console.log('\n=== 手动调 recordPlay 看返回 ===');
    const r = await s.json(`
      const res = await recordPlay({
        bvid: 'BV1Rwe4zvEUq', cid: 1, page: 1, title: 'ksm:我现在肺痒痒【夢ノ結唱POPY】',
        desc: '', up: '愛音爱音愛', tid: 31, tname: '翻唱', duration: 86,
        watchedSeconds: 40, isMusic: true, musicConfidence: 0.75, isCompilation: false,
        songKey: 'test|original', songName: 'test', version: 'original', artist: ''
      });
      const d = await chrome.storage.local.get(['videoStats']);
      return JSON.stringify({ result: res, count: Object.keys(d.videoStats||{}).length });`);
    console.log('  ' + JSON.stringify(r));
  }

  console.log('\n（诊断完成）');
  process.exit(0);
}

main().catch(e => { console.error('失败: ' + (e && e.stack || e)); process.exit(1); });
