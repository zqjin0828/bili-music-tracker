/**
 * test-service-worker.js — Service Worker 环境自检
 *
 * 为什么需要这个测试：
 *   background.js 跑在 Service Worker 里，用 importScripts 加载依赖。
 *   Service Worker 的顶层 `const` 不会挂到 self 上，容易导致「模块加载了但变量拿不到」
 *   这种只在浏览器里才暴露的问题。这个测试用一个最小 VM 环境复刻 SW 行为，
 *   在 Node 里就能把这类问题抓出来。
 *
 * 覆盖：
 *   - importScripts 链能否正确暴露 BiliParser / BiliAi / AIClient
 *   - background.js 顶层代码能否执行
 *   - getStore 默认值
 *   - recordPlay → 高置信跳过 AI / 低置信入队
 *   - exportQueue → importAiResults → 计数被回溯修正
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;

function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '\n      ' + extra : ''}`); }
}
function eq(got, exp, label) {
  ok(got === exp, label, got === exp ? '' : `got: ${JSON.stringify(got)}  exp: ${JSON.stringify(exp)}`);
}

function makeServiceWorkerContext() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    chrome: {
      storage: {
        local: {
          _d: {},
          async get(keys) {
            const o = {};
            for (const k of (Array.isArray(keys) ? keys : [keys])) o[k] = this._d[k];
            return o;
          },
          async set(p) { Object.assign(this._d, p); }
        }
      },
      runtime: {
        onMessage: { addListener() {} },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} }
      },
      action: {
        async setBadgeText() {}, async setBadgeBackgroundColor() {},
        async setBadgeTextColor() {}, async setIcon() {},
        onClicked: { addListener() {} }
      },
      tabs: { async query() { return []; }, async sendMessage() {}, async create() {} }
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch, AbortController,
    Promise, Date, Math, JSON, Object, Array, String, Number, Boolean,
    isFinite, parseInt, parseFloat, RegExp, Error, Map, Set, Symbol, AbortSignal
  };
  const ctx = vm.createContext(sandbox);
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  // importScripts 在 SW 里共享全局作用域 —— 这里在同一个 context 里执行，行为一致
  sandbox.importScripts = (...files) => {
    for (const f of files) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    }
  };
  return ctx;
}

async function asyncMain() {

console.log('\n=== 加载 background.js ===');
const ctx = makeServiceWorkerContext();
let loadError = null;
try {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
} catch (e) {
  loadError = e;
}
ok(!loadError, 'background.js 顶层代码执行无异常', loadError && loadError.message);

console.log('\n=== importScripts 依赖暴露 ===');
eq(typeof ctx.BiliParser, 'object', 'BiliParser 可见');
eq(typeof ctx.BiliAi, 'object', 'BiliAi 可见');
eq(typeof ctx.AIClient, 'object', 'AIClient 可见（顶层 const 必须显式挂到 globalThis）');
ok(!!ctx.BiliAi && typeof ctx.BiliAi.buildMessages === 'function', 'BiliAi.buildMessages 可调用');
ok(!!ctx.AIClient && typeof ctx.AIClient.planApply === 'function', 'AIClient.planApply 可调用');

console.log('\n=== 默认设置 ===');

  const store = await vm.runInContext('getStore()', ctx);
  eq(store.schemaVersion, 2, 'schemaVersion 为 2');
  eq(store.settings.aiChannel, 'off', 'AI 默认关闭（不打扰用户）');
  eq(store.settings.threshold, 5, '默认阈值 5');
  eq(store.settings.favFolderName, '歌', '默认收藏夹名');
  eq(store.settings.aiCacheEnabled, true, '默认开启缓存');
  eq(store.settings.mergeSimilarVersions, true, '默认合并近似版本');

  console.log('\n=== recordPlay：高置信 → 不调 AI ===');
  const r1 = await vm.runInContext(`recordPlay({
    bvid:'BVTEST1', cid:1, page:1, title:'【初音ミク】千本桜【オリジナル】',
    desc:'', up:'P', tid:30, tname:'VOCALOID·UTAU', duration:240, watchedSeconds:200,
    isMusic:true, musicConfidence:0.95, isCompilation:false,
    songKey:'千本桜|original', songName:'千本桜', version:'original', artist:'初音ミク'
  })`, ctx);
  eq(r1.counted, true, '已计数');
  eq(r1.videoPlayCount, 1, '视频级计数为 1');
  eq(r1.songPlayCount, 1, '歌曲级计数为 1');
  eq(r1.ai, null, '高置信不触发 AI');

  console.log('\n=== recordPlay：低置信 + 队列模式 → 入队 ===');
  await vm.runInContext(
    `setStore({ settings: Object.assign({}, DEFAULT_SETTINGS, { aiChannel: 'queue' }) })`, ctx);
  const r2 = await vm.runInContext(`recordPlay({
    bvid:'BVTEST2', cid:2, page:1, title:'某个拿不准的标题', desc:'简介文本',
    up:'U', tid:3, tname:'音乐', duration:300, watchedSeconds:280,
    isMusic:true, musicConfidence:0.55, isCompilation:false,
    songKey:'某个拿不准的标题|original', songName:'某个拿不准的标题', version:'original', artist:''
  })`, ctx);
  eq(r2.ai && r2.ai.source, 'queue', '进入队列通道');
  eq(r2.ai && r2.ai.queued, true, '队列标记为已入队');

  console.log('\n=== 队列导出 ===');
  const q = await vm.runInContext('exportQueue()', ctx);
  eq(q.count, 1, '队列有 1 条');
  eq(q.items[0].key, 'BVTEST2', '队列条目的 key 正确');
  eq(q.items[0].desc, '简介文本', '简介被采集（AI 判定的关键输入）');
  eq(q.items[0].ruleResult.confidence, 0.55, '保留规则结果供 AI 参考');
  eq(q.items[0].optimisticSongKey, '某个拿不准的标题|original', '记录乐观计数的 songKey');

  console.log('\n=== 导入 AI 结果 → 回溯修正 ===');
  await vm.runInContext(`importAiResults({ results: { 'BVTEST2': { result: {
    isMusic:false, isCompilation:false, songName:'', artist:'', version:'',
    confidence:0.97, reason:'非音乐'
  } } } })`, ctx);

  const st = await vm.runInContext('getStore()', ctx);
  eq(st.videoStats['BVTEST2'], undefined, 'AI 判为非音乐 → 视频计数扣到 0 并删除');
  eq(st.songStats['某个拿不准的标题|original'], undefined, '歌曲级计数同步撤销');
  eq(Object.keys(st.pendingQueue).length, 0, '已处理的条目从队列移除');
  eq(st.aiStats.calls, 1, 'AI 调用次数记录为 1');
  eq(st.aiCache['BVTEST2'] && st.aiCache['BVTEST2'].result.isMusic, false, '结果写入永久缓存');

  console.log('\n=== 缓存命中：再次上报同标题不重复调用 ===');
  // 重新入队场景：同一 BV 号再次播放，标题未变 → 缓存有效
  const cached = await vm.runInContext(`lookupCache('BVTEST2', '某个拿不准的标题')`, ctx);
  ok(!!cached && cached.isMusic === false, '缓存命中，返回已判定结果');
  const staleCache = await vm.runInContext(`lookupCache('BVTEST2', '标题被UP改了')`, ctx);
  eq(staleCache, null, '标题变了 → 缓存失效');

  console.log('\n=== 队列幂等：同一结果重复导入不重复扣减 ===');
  // 先重新造一条记录
  await vm.runInContext(`recordPlay({
    bvid:'BVTEST3', cid:3, page:1, title:'另一首歌', desc:'',
    up:'U', tid:3, tname:'音乐', duration:300, watchedSeconds:280,
    isMusic:true, musicConfidence:0.55, isCompilation:false,
    songKey:'另一首歌|original', songName:'另一首歌', version:'original', artist:''
  })`, ctx);
  const payload = `{ results: { 'BVTEST3': { result: {
    isMusic:true, isCompilation:false, songName:'正确的歌名', artist:'', version:'original',
    confidence:0.95, reason:'AI 纠正歌名'
  } } } }`;
  await vm.runInContext(`importAiResults(${payload})`, ctx);
  await vm.runInContext(`importAiResults(${payload})`, ctx);   // 第二次导入同一结果
  const st3 = await vm.runInContext('getStore()', ctx);
  eq(st3.songStats['正确的歌名|original'].playCount, 1, '重复导入不重复计数（幂等）');
}

// ---------- 汇总 ----------

asyncMain().then(() => {
  console.log('\n========================================');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail > 0 ? 1 : 0);
}).catch(e => {
  console.log('  ✗ 测试抛异常: ' + (e && e.stack || e));
  console.log('\n========================================');
  console.log(`通过 ${pass} 项，失败 ${fail + 1} 项`);
  process.exit(1);
});
