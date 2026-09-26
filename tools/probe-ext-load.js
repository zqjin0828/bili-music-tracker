#!/usr/bin/env node
/**
 * probe-ext-load.js — 诊断 --load-extension 是否生效
 *
 * 分三步排查：
 *   1. 启动后列出所有 target（看有没有扩展相关的）
 *   2. 打开 B 站页面，看内容脚本有没有注入（.bmt-hud 是否存在）
 *   3. 再看 target 列表（Service Worker 可能被唤醒）
 */

'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BROWSERS = [
  ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
  ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
];

async function probe(name, bin, port) {
  console.log('\n════════ ' + name + ' (端口 ' + port + ') ════════');
  const profile = path.join(os.tmpdir(), 'bmt-probe-' + name.toLowerCase());
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  fs.mkdirSync(profile, { recursive: true });

  const child = spawn(bin, [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--load-extension=' + EXT,
    '--disable-extensions-except=' + EXT,
    '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    'about:blank'
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  let ver = null;
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    try { ver = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json(); break; } catch (e) { /* wait */ }
  }
  if (!ver) { console.log('  ✗ CDP 未就绪'); return; }
  console.log('  版本: ' + ver.Browser);

  const list = async () => (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json());

  console.log('  [启动后 target]');
  for (const t of await list()) console.log('    ' + t.type.padEnd(16) + ' ' + String(t.url).slice(0, 80));

  // 打开 B 站，触发内容脚本 + 唤醒 Service Worker
  console.log('  [打开 B 站视频页…]');
  const bv = 'BV13wKw6GEaz';
  await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('https://www.bilibili.com/video/' + bv), { method: 'PUT' });
  await sleep(9000);

  const ts = await list();
  console.log('  [打开后 target]');
  for (const t of ts) console.log('    ' + t.type.padEnd(16) + ' ' + String(t.url).slice(0, 80));

  const page = ts.find(t => t.type === 'page' && t.url.includes('bilibili'));
  if (!page) { console.log('  ✗ 没找到 B 站页面'); return; }

  // 用 CDP 检查 .bmt-hud 与全局对象
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0; const pend = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (m, p) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const ev = async (e, aw) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: !!aw, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable');

  console.log('  [页面检查]');
  console.log('    readyState     : ' + await ev('document.readyState'));
  console.log('    <video> 存在   : ' + await ev('!!document.querySelector("video")'));
  console.log('    .bmt-hud 存在  : ' + await ev('!!document.querySelector(".bmt-hud")'));
  console.log('    内容脚本已运行 : ' + await ev('!!document.querySelector(".bmt-hud") || !!document.querySelector(".bmt-toast") || !!document.querySelector(".bmt-card")'));

  ws.close();
  try { execSync('taskkill /F /PID ' + child.pid + ' /T', { stdio: 'ignore' }); } catch (e) { /* ignore */ }
  try { execSync('taskkill /F /IM ' + path.basename(bin) + ' /T', { stdio: 'ignore' }); } catch (e) { /* ignore */ }
}

(async () => {
  let p = 9360;
  for (const [name, bin] of BROWSERS) {
    if (!fs.existsSync(bin)) { console.log('\n' + name + ': 不存在 (' + bin + ')'); continue; }
    await probe(name, bin, p++);
  }
})();
