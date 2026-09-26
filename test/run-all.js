#!/usr/bin/env node
/**
 * run-all.js — 跑全部测试套件
 *
 * 用法：node test/run-all.js
 *
 * 设计说明：
 *   原先用 child_process.spawnSync 逐个派生 node 进程，
 *   但在受限沙箱里会报 EBUSY（不允许派生 node 可执行文件）。
 *   改为**在当前进程内 require 各套件**，并临时接管
 *   console.log / process.exit 来收集结果 —— 不依赖子进程，更稳也更快。
 *
 *   各套件本身仍可单独运行（node test/xxx.js）。
 */

'use strict';

const path = require('path');

const SUITES = [
  ['test-parser.js', '标题解析 / 音乐判定 / 日语支持'],
  ['test-ai.js', 'AI prompt / 响应解析 / 版本归一化'],
  ['test-ai-client.js', 'AI 客户端 / 三层调度 / 回溯修正'],
  ['test-integration.js', '端到端流程 / 幂等 / 降级'],
  ['test-service-worker.js', 'Service Worker 环境 / importScripts / 真实 background 链路'],
  ['test-detector-accuracy.js', '判定器准确率（对人工核对样本：召回/精确）'],
  ['test-background.js', '后台标签页计时（定时器节流）/ seek / 倍速 / 阈值口径']
];

const EXIT = { __runAllExit: true };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runSuite(file) {
  const full = path.join(__dirname, file);
  const logs = [];
  const orig = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    exit: process.exit,
    argv: process.argv
  };

  console.log = (...a) => logs.push(a.map(String).join(' '));
  console.error = (...a) => logs.push(a.map(String).join(' '));
  console.warn = () => {};
  process.argv = [process.execPath, full];

  let exitCode = null;
  // 注意：这里**不能抛异常**。异步套件（test-service-worker）在 Promise 的
  // .then() 里调用 process.exit，抛出去会变成 UnhandledPromiseRejection。
  // 只记录退出码即可 —— 各套件都在结尾才调用它，不会有多余代码继续跑。
  process.exit = (c) => { exitCode = (typeof c === 'number' ? c : 0); };

  try {
    delete require.cache[require.resolve(full)];
    require(full);
    // 等待异步套件的 Promise 链跑完
    for (let i = 0; i < 400 && exitCode === null; i++) await sleep(25);
  } catch (e) {
    if (e !== EXIT) {
      logs.push('套件抛出异常: ' + ((e && e.stack) || e));
      exitCode = 1;
    }
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
    process.exit = orig.exit;
    process.argv = orig.argv;
  }

  return { out: logs.join('\n'), code: exitCode };
}

(async () => {
  let totalPass = 0, totalFail = 0;
  const failedSuites = [];

  for (const [file, desc] of SUITES) {
    process.stdout.write('\n▶ ' + file + '  —  ' + desc + '\n');

    let r;
    try {
      r = await runSuite(file);
    } catch (e) {
      process.stdout.write('  ✗ 无法运行: ' + (e && e.message) + '\n');
      failedSuites.push(file);
      continue;
    }

    // 只打印失败行，保持输出精简
    for (const line of r.out.split('\n')) {
      if (line.includes('✗')) process.stdout.write(line + '\n');
    }

    const m = r.out.match(/通过 (\d+) 项，失败 (\d+) 项/);
    if (m) {
      const p = Number(m[1]), f = Number(m[2]);
      totalPass += p; totalFail += f;
      process.stdout.write('  ' + (f === 0 ? '✓' : '✗') + ' 通过 ' + p + ' 项，失败 ' + f + ' 项\n');
      if (f > 0) failedSuites.push(file);
    } else {
      process.stdout.write('  ✗ 无汇总输出（套件异常退出）\n');
      process.stdout.write(r.out.split('\n').slice(0, 20).join('\n') + '\n');
      failedSuites.push(file);
    }
  }

  console.log('\n========================================');
  console.log('总计：通过 ' + totalPass + ' 项，失败 ' + totalFail + ' 项');
  if (failedSuites.length) {
    console.log('失败套件：' + failedSuites.join(', '));
    process.exit(1);
  }
  console.log('全部通过 ✓');
})();
