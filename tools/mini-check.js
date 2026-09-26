#!/usr/bin/env node
/**
 * mini-check.js — 最小验证：插件加载后，HUD 的「判定」是否变成音乐
 *
 * 用来确认「从后台取 tid」这个修复真的生效（此前 tid 恒为 0）。
 */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 9364;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'bmt-mini');
const BV = process.argv[2] || 'BV1Rwe4zvEUq';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  try { execSync('taskkill /F /IM msedge.exe /T', { stdio: 'ignore' }); } catch (e) {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(PROFILE, { recursive: true });

  const child = spawn(EDGE, [
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
    '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  let ver = null;
  for (let i = 0; i < 80; i++) { await sleep(300); try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch (e) {} }
  if (!ver) { console.log('CDP 未就绪'); process.exit(1); }
  console.log('浏览器: ' + ver.Browser);

  const nr = await fetch(`http://127.0.0.1:${PORT}/json/new?` + encodeURIComponent('https://www.bilibili.com/video/' + BV), { method: 'PUT' });
  const target = await nr.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0; const pend = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (me, pa) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: pa || {} })); });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return '(异常)';
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable'); await send('Page.enable');
  try { await fetch('http://127.0.0.1:' + PORT + '/json/activate/' + target.id); } catch (e) {} 

  console.log('等待播放器…');
  for (let i = 0; i < 40; i++) { await sleep(700); try { if (await ev('!!document.querySelector("video")')) break; } catch (e) {} }
  console.log('等时长就绪…');
  for (let i = 0; i < 30; i++) { await sleep(600); const d = await ev('(function(){var v=document.querySelector("video");return (v&&isFinite(v.duration))?v.duration:0})()'); if (d > 0) { console.log('  时长 ' + Number(d).toFixed(1) + 's'); break; } }
  await ev('(function(){var v=document.querySelector("video"); v.muted=false; v.play(); return 1})()');
  console.log('已开始播放\n');

  for (let i = 0; i < 8; i++) {
    await sleep(4000);
    const hud = await ev('(function(){var e=document.querySelector(".bmt-hud");return e?e.innerText.replace(/\\n/g," | "):"(无面板)"})()');
    console.log('[' + String((i + 1) * 4).padStart(2) + 's] ' + hud);
  }

  console.log('\n--- 扩展存储（SW 可能已休眠，找不到是正常的）---');
  const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const sw = ts.find(t => t.type === 'service_worker' && t.url.includes('background.js'));
  if (!sw) { console.log('✗ 找不到 SW'); }
  else {
    const ws2 = new WebSocket(sw.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws2.addEventListener('open', res); ws2.addEventListener('error', rej); });
    let i2 = 0; const p2 = new Map();
    ws2.addEventListener('message', e2 => { const m = JSON.parse(e2.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id); } });
    const s2 = (me, pa) => new Promise(r => { const i = ++i2; p2.set(i, r); ws2.send(JSON.stringify({ id: i, method: me, params: pa || {} })); });
    const r2 = await s2('Runtime.evaluate', {
      expression: `(async()=>{ const d = await chrome.storage.local.get(['videoStats','settings']);
        return JSON.stringify({ 版本: chrome.runtime.getManifest().version,
          videoStats: Object.entries(d.videoStats||{}).map(([k,v])=>({k, count:v.playCount, music:v.isMusic, conf:v.musicConfidence, title:String(v.title).slice(0,36)})) }); })()`,
      returnByValue: true, awaitPromise: true
    });
    console.log(r2.result && r2.result.result ? r2.result.result.value : JSON.stringify(r2).slice(0, 300));
  }

  console.log('\n（完成）');
  process.exit(0);
})().catch(e => { console.log('失败: ' + (e && e.message || e)); process.exit(1); });
