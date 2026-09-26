#!/usr/bin/env node
/**
 * test-background.js — 复现并验证「后台播放不计入」的修复
 *
 * 背景：
 *   Chrome 会节流隐藏标签页的定时器（隐藏 5 分钟后约每分钟 1 次）。
 *   旧实现按「墙钟 tick 间隔」累计，并丢弃 > 3000ms 的间隔：
 *       if (delta > 0 && delta < 3000) accumulated += delta
 *   于是后台播放的 delta≈60000 被当成异常丢弃 → 累计恒为 0。
 *
 * 本测试用两种实现跑同一段「播放剧本」，对比结果。
 */

'use strict';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '\n      ' + extra : '')); }
}

// ---------- 两种累计实现 ----------

/** 旧实现：按墙钟间隔累计，丢弃 > 3s 的间隔 */
function makeOld() {
  return {
    acc: 0, lastTickTs: 0,
    tick(now, ct, playing) {
      if (playing) {
        if (this.lastTickTs) {
          const delta = now - this.lastTickTs;
          if (delta > 0 && delta < 3000) this.acc += delta;
        }
        this.lastTickTs = now;
      } else this.lastTickTs = 0;
    }
  };
}

/** 新实现：按 currentTime 增量累计，用墙钟识别 seek */
function makeNew() {
  return {
    acc: 0, lastTickTs: 0, lastCt: 0,
    tick(now, ct, playing, rate) {
      rate = rate || 1;
      if (!this.lastTickTs) { this.lastTickTs = now; this.lastCt = ct; return; }
      if (playing) {
        const wallSec = (now - this.lastTickTs) / 1000;
        const ctSec = ct - this.lastCt;
        if (wallSec > 0 && wallSec < 24 * 3600 && ctSec > 0) {
          const expected = wallSec * rate;
          const cap = Math.max(expected * 1.2 + 1, 1.5);
          this.acc += Math.min(ctSec, cap) * 1000;
        }
      }
      this.lastCt = ct;
      this.lastTickTs = now;
    }
  };
}

// ---------- 播放剧本 ----------

/**
 * 模拟：视频从 0 播放到 playSec 秒，采样间隔按 tickEveryMs 给。
 * 返回该实现累计的毫秒数。
 */
function run(impl, playSec, tickEveryMs) {
  const rate = 1;
  let now = 1700000000000;
  // 初始采样点（建立基准）
  impl.tick(now, 0, false, rate);
  for (let t = 0; t <= playSec * 1000; t += tickEveryMs) {
    now += tickEveryMs;
    const ct = Math.min(playSec, t / 1000);
    impl.tick(now, ct, true, rate);
  }
  return impl.acc;
}

console.log('\n=== 场景1：前台播放 120 秒（tick 500ms）===');
{
  const oldAcc = run(makeOld(), 120, 500);
  const newAcc = run(makeNew(), 120, 500);
  console.log('    旧实现 ' + (oldAcc / 1000).toFixed(1) + 's   新实现 ' + (newAcc / 1000).toFixed(1) + 's');
  ok(Math.abs(oldAcc / 1000 - 120) < 3, '旧实现前台正常（≈120s）');
  ok(Math.abs(newAcc / 1000 - 120) < 3, '新实现前台正常（≈120s）');
}

console.log('\n=== 场景2：后台播放 120 秒（tick 被节流到 60s）★ 核心用例 ===');
{
  const oldAcc = run(makeOld(), 120, 60000);
  const newAcc = run(makeNew(), 120, 60000);
  console.log('    旧实现 ' + (oldAcc / 1000).toFixed(1) + 's   新实现 ' + (newAcc / 1000).toFixed(1) + 's');
  ok(oldAcc === 0, '旧实现后台累计为 0（复现 bug）');
  ok(Math.abs(newAcc / 1000 - 120) < 5, '新实现后台正常累计（≈120s）', 'got ' + (newAcc / 1000).toFixed(1));
}

console.log('\n=== 场景3：后台播放 120 秒（tick 节流到 1s）===');
{
  const oldAcc = run(makeOld(), 120, 1000);
  const newAcc = run(makeNew(), 120, 1000);
  console.log('    旧实现 ' + (oldAcc / 1000).toFixed(1) + 's   新实现 ' + (newAcc / 1000).toFixed(1) + 's');
  ok(Math.abs(oldAcc / 1000 - 120) < 3, '旧实现在 1s 节流下仍正常（这是它「有时能用」的原因）');
  ok(Math.abs(newAcc / 1000 - 120) < 3, '新实现正常');
}

console.log('\n=== 场景4：拖动进度条不应虚增 ===');
{
  const impl = makeNew();
  let now = 1700000000000;
  impl.tick(now, 0, false, 1);
  // 正常播放 10 秒
  for (let i = 1; i <= 20; i++) { now += 500; impl.tick(now, i * 0.5, true, 1); }
  const beforeSeek = impl.acc;
  // 拖到 200 秒处（只过 500ms 墙钟）
  now += 500; impl.tick(now, 200, true, 1);
  const afterSeek = impl.acc;
  const gained = (afterSeek - beforeSeek) / 1000;
  console.log('    拖动后多计入 ' + gained.toFixed(2) + 's（应远小于 200）');
  ok(gained < 2, '拖动不会被当成「听完了」', 'got ' + gained.toFixed(2) + 's');
}

console.log('\n=== 场景5：暂停期间不计入 ===');
{
  const impl = makeNew();
  let now = 1700000000000;
  impl.tick(now, 0, false, 1);
  for (let i = 1; i <= 20; i++) { now += 500; impl.tick(now, i * 0.5, true, 1); }   // 播 10s
  const beforePause = impl.acc;
  for (let i = 0; i < 40; i++) { now += 500; impl.tick(now, 10, false, 1); }        // 暂停 20s
  const afterPause = impl.acc;
  console.log('    暂停 20 秒后累计变化 ' + ((afterPause - beforePause) / 1000).toFixed(1) + 's');
  ok(Math.abs(afterPause - beforePause) < 100, '暂停期间不累计');
}

console.log('\n=== 场景6：2 倍速播放按真实进度计 ===');
{
  const impl = makeNew();
  let now = 1700000000000;
  impl.tick(now, 0, false, 2);
  // 墙钟 60 秒，2 倍速 → 进度推进 120 秒
  for (let i = 1; i <= 120; i++) { now += 500; impl.tick(now, i * 1.0, true, 2); }
  const acc = impl.acc / 1000;
  console.log('    2 倍速播放 60 秒墙钟 → 计入 ' + acc.toFixed(1) + 's');
  ok(acc > 100, '倍速播放按进度计入（>100s）', 'got ' + acc.toFixed(1));
}

console.log('\n=== 场景7：阈值口径（粉雪案例）===');
{
  // 粉雪时长约 310s，默认 minSec=30、ratio=0.3
  const dur = 310, minSec = 30, ratio = 0.3;
  const need = Math.max(minSec, dur * ratio);
  console.log('    时长 ' + dur + 's → 实际需要 ' + need.toFixed(0) + 's（不是 30s）');
  ok(need === 93, '门槛为 93 秒', 'got ' + need);
  // 只听了 35 秒 → 不足
  ok(35 < need, '只听了 35 秒确实不足以计数（与前台/后台无关）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail > 0 ? 1 : 0);
