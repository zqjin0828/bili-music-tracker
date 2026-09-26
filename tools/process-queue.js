#!/usr/bin/env node
/**
 * process-queue.js — WorkBuddy 侧队列处理器（通道 A）
 *
 * 用法：
 *   node tools/process-queue.js --in queue.json --out results.json \
 *        [--endpoint https://api.deepseek.com/v1/chat/completions] \
 *        [--key sk-xxx] [--model deepseek-chat] [--dry-run]
 *
 * 或走环境变量：
 *   BMT_ENDPOINT / BMT_API_KEY / BMT_MODEL
 *
 * 做什么：
 *   1. 读入插件导出的队列 JSON
 *   2. 逐条构造 prompt（复用 src/ai.js，保证与插件口径完全一致）
 *   3. 调用云端 API，校验响应
 *   4. 输出 results.json，可直接在 popup 里「导入 AI 结果」
 *
 * 设计原则：单条失败不影响其他条；全程打印进度；无 key 时可用 --dry-run 检查 prompt。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 复用插件的模块（它们都是 UMD 风格，可在 Node 里直接 require）
const ROOT = path.resolve(__dirname, '..');
const Parser = require(path.join(ROOT, 'src', 'parser.js'));
global.BiliParser = Parser;
const Ai = require(path.join(ROOT, 'src', 'ai.js'));

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const args = { model: 'gpt-4o-mini', timeout: 30000, concurrency: 1, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--in') args.input = next();
    else if (a === '--out') args.output = next();
    else if (a === '--endpoint') args.endpoint = next();
    else if (a === '--key') args.key = next();
    else if (a === '--model') args.model = next();
    else if (a === '--timeout') args.timeout = Number(next()) || 30000;
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(next()) || 1);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  args.endpoint = args.endpoint || process.env.BMT_ENDPOINT || '';
  args.key = args.key || process.env.BMT_API_KEY || '';
  args.model = process.env.BMT_MODEL || args.model;
  return args;
}

const HELP = `
处理 B 站听歌追踪器的 AI 待判定队列

  --in <file>          队列 JSON（插件「复制队列」导出的内容）
  --out <file>         结果 JSON 输出路径（默认 ai-results.json）
  --endpoint <url>     OpenAI 兼容端点，如 https://api.deepseek.com/v1/chat/completions
  --key <sk-xxx>       API Key（也可用环境变量 BMT_API_KEY）
  --model <name>       模型名，默认 gpt-4o-mini
  --concurrency <n>    并发数，默认 1（保守，避免限流）
  --timeout <ms>       单次超时，默认 30000
  --dry-run            只打印 prompt，不调用 API
  -h, --help           显示帮助

示例：
  BMT_API_KEY=sk-xxx node tools/process-queue.js \\
    --in queue.json --out results.json \\
    --endpoint https://api.deepseek.com/v1/chat/completions --model deepseek-chat
`;

// ---------- API 调用 ----------

async function callApi(info, args) {
  const messages = Ai.buildMessages(info);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), args.timeout);

  try {
    const resp = await fetch(args.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + args.key
      },
      body: JSON.stringify({
        model: args.model,
        messages,
        temperature: 0,
        max_tokens: 300
      }),
      signal: ctrl.signal
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
    }
    const json = await resp.json();
    const content = json && json.choices && json.choices[0]
      && json.choices[0].message && json.choices[0].message.content;
    if (!content) return { ok: false, error: '空响应' };

    const parsed = Ai.parseResponse(content, null);
    if (!parsed.ok) return { ok: false, error: `解析失败: ${parsed.error}`, raw: content.slice(0, 200) };

    return {
      ok: true,
      result: parsed.result,
      usage: (json && json.usage) || {},
      model: (json && json.model) || args.model
    };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? '超时' : String(e && e.message || e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 主流程 ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { console.log(HELP); return; }
  if (!args.input) { console.error('缺少 --in 参数。用 --help 查看用法。'); process.exit(1); }

  const raw = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const items = Array.isArray(raw) ? raw : (raw.items || []);
  if (!items.length) { console.log('队列为空，无需处理。'); return; }

  console.log(`待判定 ${items.length} 条`);
  if (args.dryRun) {
    const info = {
      title: items[0].title, desc: items[0].desc, up: items[0].up,
      tid: items[0].tid, tname: items[0].tname, duration: items[0].duration, part: items[0].part
    };
    const msgs = Ai.buildMessages(info);
    console.log('\n--- system ---\n' + msgs[0].content);
    console.log('\n--- user ---\n' + msgs[1].content);
    console.log('\n[dry-run] 未调用 API。');
    return;
  }

  if (!args.endpoint) { console.error('缺少 --endpoint（或环境变量 BMT_ENDPOINT）'); process.exit(1); }
  if (!args.key) { console.error('缺少 --key（或环境变量 BMT_API_KEY）'); process.exit(1); }

  const output = { processedAt: new Date().toISOString(), model: args.model, results: {} };
  let okCount = 0, failCount = 0, totalIn = 0, totalOut = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const label = `[${i + 1}/${items.length}] ${String(it.title || '').slice(0, 40)}`;
    process.stdout.write(label + ' ... ');

    const r = await callApi({
      title: it.title, desc: it.desc, up: it.up,
      tid: it.tid, tname: it.tname, duration: it.duration, part: it.part
    }, args);

    if (r.ok) {
      okCount++;
      totalIn += (r.usage && r.usage.prompt_tokens) || 0;
      totalOut += (r.usage && r.usage.completion_tokens) || 0;
      output.results[it.key] = {
        result: r.result,
        title: it.title,
        ruleResult: it.ruleResult,
        at: Date.now(),
        model: r.model
      };
      console.log(`${r.result.isMusic ? '🎵' : '🚫'} ${r.result.version || '-'} ${r.result.songName || '-'} (${Math.round(r.result.confidence * 100)}%)`);
    } else {
      failCount++;
      console.log('✗ ' + r.error);
    }
  }

  const outPath = args.output || 'ai-results.json';
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log('\n========================================');
  console.log(`成功 ${okCount} 条，失败 ${failCount} 条`);
  if (totalIn || totalOut) {
    console.log(`tokens: 输入 ${totalIn} / 输出 ${totalOut}`);
  }
  console.log(`结果已写入 ${outPath}`);
  console.log('→ 在插件 popup 的 AI 面板里点「导入 AI 结果」即可生效');
}

main().catch(e => { console.error('致命错误:', e); process.exit(1); });
