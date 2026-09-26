#!/usr/bin/env node
/** 验证 Service Worker 能否访问 bilibili 接口 */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 9366;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'bmt-swprobe');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  try { execSync('taskkill /F /IM msedge.exe /T', { stdio: 'ignore' }); } catch (e) {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(EDGE, ['--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
    '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore' });
  child.unref();
  let ver = null;
  for (let i = 0; i < 80; i++) { await sleep(300); try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch (e) {} }
  if (!ver) { console.log('CDP 未就绪'); process.exit(1); }

  // 先打开 B 站页面唤醒 SW
  await fetch(`http://127.0.0.1:${PORT}/json/new?` + encodeURIComponent('https://www.bilibili.com/video/BV1Rwe4zvEUq'), { method: 'PUT' });
  await sleep(9000);

  const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const sw = ts.find(t => t.type === 'service_worker' && t.url.includes('background.js'));
  if (!sw) { console.log('✗ 没找到 SW'); console.log('targets:', ts.map(t => t.type + ':' + t.url.slice(0, 50)).join('\n')); process.exit(1); }
  console.log('✓ 找到 SW');

  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0; const pend = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (me, pa) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: pa || {} })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return '异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 250);
    return r.result && r.result.result ? r.result.result.value : JSON.stringify(r).slice(0, 250);
  };

  console.log('\n[1] SW 直连 api.bilibili.com:');
  console.log('  ' + await ev(`(async()=>{ try{
      const r = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=BV1Rwe4zvEUq');
      const j = await r.json();
      return 'HTTP '+r.status+' code='+j.code+' tid='+(j.data&&j.data.tid)+' title='+String(j.data&&j.data.title).slice(0,30);
    }catch(e){ return '失败: '+String(e); } })()`));

  console.log('\n[2] 插件自己的 fetchVideoMeta:');
  console.log('  ' + await ev(`(async()=>{ try{
      const m = await fetchVideoMeta('BV1Rwe4zvEUq');
      return m ? JSON.stringify({tid:m.tid,tname:m.tname,owner:m.owner,dur:m.duration,descLen:(m.desc||'').length}) : 'null';
    }catch(e){ return '失败: '+String(e); } })()`));

  console.log('\n[3] host_permissions 检查:');
  console.log('  ' + await ev(`JSON.stringify(chrome.runtime.getManifest().host_permissions)`));

  console.log('\n[4] 模拟消息处理:');
  console.log('  ' + await ev(`(async()=>{ return new Promise(res=>{
      try{
        const p = fetchVideoMeta('BV1Rwe4zvEUq').then(m=>res(m?'拿到 meta, tid='+m.tid:'返回 null'));
        setTimeout(()=>res('超时(3s)'), 3000);
      }catch(e){ res('抛出: '+String(e)); }
    }); })()`));

  console.log('\n（完成）');
  process.exit(0);
})().catch(e => { console.log('失败: ' + (e && e.message || e)); process.exit(1); });
