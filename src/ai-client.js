/**
 * ai-client.js — AI 客户端（Service Worker 侧）
 *
 * 职责：
 *  1. 三层调度：规则高置信 → 直接采纳；低置信 → 查缓存；缓存未命中 → 走 AI
 *  2. 通道 B（直连）：fetch OpenAI 兼容端点，带超时 + 指数退避
 *  3. 通道 A（队列）：写入 pendingQueue，等待外部（WorkBuddy）回填
 *  4. 结果应用：乐观计数 + 回溯修正（幂等）
 *
 * 依赖：BiliAi（prompt/解析/校验）、BiliParser（归一化）
 * 所有网络与存储操作都包在 try/catch 里 —— AI 永远不能让插件不可用。
 */

'use strict';

// 注意：Service Worker 里 importScripts 共享全局作用域，但顶层 const 不会挂到 self 上。
// 所以这里显式赋值到 globalThis，保证 background.js 能拿到 AIClient。
const AIClient = (function () {
  const Ai = (typeof BiliAi !== 'undefined') ? BiliAi : null;
  const Parser = (typeof BiliParser !== 'undefined') ? BiliParser : null;

  // 规则置信度高于此值时跳过 AI
  const HIGH_CONFIDENCE = 0.85;

  // ---------- 直连 API 调用 ----------

  /**
   * 调用 OpenAI 兼容的 chat/completions 端点
   * @param {object} info 视频信息
   * @param {object} settings
   * @returns {Promise<{ok:boolean, result?:object, error?:string, ms:number}>}
   */
  async function callDirect(info, settings) {
    const t0 = Date.now();
    const endpoint = normalizeEndpoint(settings.aiEndpoint);
    if (!endpoint) return { ok: false, error: 'no-endpoint', ms: 0 };
    if (!settings.aiApiKey) return { ok: false, error: 'no-apikey', ms: 0 };
    if (!Ai) return { ok: false, error: 'no-ai-module', ms: 0 };

    const timeout = Math.max(3000, Number(settings.aiTimeout) || 10000);
    const messages = Ai.buildMessages(info);
    const body = {
      model: settings.aiModel || 'gpt-4o-mini',
      messages,
      temperature: 0,
      max_tokens: 300
    };

    // 温度 0 提升稳定性；部分国产模型不支持 response_format，故不强依赖
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        let resp;
        try {
          resp = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + settings.aiApiKey
            },
            body: JSON.stringify(body),
            signal: ctrl.signal
          });
        } finally {
          clearTimeout(timer);
        }

        if (resp.status === 429 || resp.status >= 500) {
          lastErr = 'http-' + resp.status;
          // 指数退避：1s, 2s
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        if (!resp.ok) {
          lastErr = 'http-' + resp.status;
          break;
        }

        const json = await resp.json();
        const text = extractContent(json);
        if (!text) { lastErr = 'empty-content'; break; }

        const parsed = Ai.parseResponse(text, null);
        if (!parsed.ok) { lastErr = parsed.error || 'invalid'; break; }

        const usage = (json && json.usage) || {};
        return {
          ok: true,
          result: parsed.result,
          ms: Date.now() - t0,
          model: json && json.model,
          usage: { in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0 }
        };
      } catch (e) {
        lastErr = (e && e.name === 'AbortError') ? 'timeout' : String(e && e.message || e);
        if (e && e.name === 'AbortError') break;  // 超时不再重试
        await sleep(800 * (attempt + 1));
      }
    }
    return { ok: false, error: lastErr || 'unknown', ms: Date.now() - t0 };
  }

  /**
   * 从各种兼容格式里取出正文
   * OpenAI / DeepSeek / 智谱 / Moonshot 都在 choices[0].message.content
   */
  function extractContent(json) {
    try {
      const c = json && json.choices && json.choices[0];
      if (!c) return '';
      const m = c.message || c.delta || {};
      let content = m.content;
      // 有些模型返回数组形式的 content
      if (Array.isArray(content)) {
        content = content.map(p => (typeof p === 'string' ? p : p && p.text) || '').join('');
      }
      return String(content || '').trim();
    } catch (e) {
      return '';
    }
  }

  function normalizeEndpoint(url) {
    const s = String(url || '').trim();
    if (!s) return '';
    let u = s;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    // 用户可能只填了域名，自动补路径
    if (!/\/chat\/completions\/?$/.test(u) && !/\/v\d+\//.test(u)) {
      u = u.replace(/\/+$/, '') + '/v1/chat/completions';
    }
    // 统一去掉尾部斜杠，避免拼接出 //chat
    return u.replace(/\/+$/, '');
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ---------- 三层调度 ----------

  /**
   * 决定是否该问 AI
   * @returns {{ask:boolean, reason:string}}
   */
  function shouldAskAi(detection, settings) {
    if (!settings || settings.aiChannel === 'off') return { ask: false, reason: 'ai-off' };
    const conf = Number(detection && detection.confidence) || 0;
    const threshold = Number(settings.aiConfidenceThreshold);
    const limit = isFinite(threshold) ? threshold : HIGH_CONFIDENCE;
    if (conf >= limit) return { ask: false, reason: 'high-confidence' };
    return { ask: true, reason: 'low-confidence' };
  }

  // ---------- 应用 AI 结果（纯函数，便于单测） ----------

  /**
   * 计算把 AI 结果应用到统计数据上需要的操作。
   * 返回一组描述性操作，由 background 执行，便于测试与幂等校验。
   *
   * @param {object} ctx
   *   { aiResult, ruleResult, oldSongKey, oldVideoKey, videoEntry, songEntry,
   *     settings, aiRevision }
   * @returns {{ops:Array, note:string}}
   */
  function planApply(ctx) {
    const ops = [];
    const per = {};

    const ai = ctx.aiResult;
    const rule = ctx.ruleResult || {};
    if (!ai) return { ops, note: 'no-ai-result' };

    // 幂等：同一条 AI 结果不重复应用
    if (Number(ctx.videoEntry && ctx.videoEntry.appliedAiRevision) === Number(ctx.aiRevision)) {
      return { ops, note: 'already-applied' };
    }

    const mergeSimilar = ctx.settings ? ctx.settings.mergeSimilarVersions !== false : true;

    // ---- 1. isMusic 变化 ----
    if (!!ai.isMusic !== !!rule.isMusic) {
      if (!ai.isMusic) {
        // AI 认为是非音乐 → 回溯扣减
        ops.push({ type: 'video.isMusic', value: false });
        ops.push({ type: 'video.decrement', by: 1 });
        if (ctx.oldSongKey) ops.push({ type: 'song.decrement', key: ctx.oldSongKey, by: 1 });
        per.noteMusic = 'ai-not-music';
      } else {
        // 规则漏判 → 补记
        ops.push({ type: 'video.isMusic', value: true });
        ops.push({ type: 'video.increment', by: 1 });
        const newKey = Ai ? Ai.makeSongKeyFromAi(ai, mergeSimilar) : '';
        if (newKey) ops.push({ type: 'song.increment', key: newKey, by: 1, seed: songSeed(ai, ctx) });
        per.noteMusic = 'ai-is-music';
      }
    }

    // ---- 2. songKey 变化（歌名或版本变了） ----
    const newSongKey = (ai.isMusic && Ai) ? Ai.makeSongKeyFromAi(ai, mergeSimilar) : '';
    if (ai.isMusic && newSongKey && ctx.oldSongKey && newSongKey !== ctx.oldSongKey) {
      // 把旧 key 上的一次计数迁到新 key（不改变总数，只换归属）
      ops.push({ type: 'song.migrate', from: ctx.oldSongKey, to: newSongKey, by: 1, seed: songSeed(ai, ctx) });
      per.noteKey = 'song-key-migrated';
    } else if (ai.isMusic && newSongKey && !ctx.oldSongKey) {
      ops.push({ type: 'song.increment', key: newSongKey, by: 1, seed: songSeed(ai, ctx) });
    }

    // ---- 3. 合辑判定变化 ----
    if (!!ai.isCompilation !== !!rule.isCompilation) {
      if (ai.isCompilation && ctx.oldSongKey) {
        // 改判为合辑 → 撤掉歌曲级计数（合辑不该进歌曲榜）
        ops.push({ type: 'song.decrement', key: ctx.oldSongKey, by: 1 });
        ops.push({ type: 'song.migrate', from: ctx.oldSongKey, to: '__deleted__', by: 1, drop: true });
        per.noteComp = 'became-compilation';
      }
      ops.push({ type: 'video.isCompilation', value: !!ai.isCompilation });
    }

    // ---- 4. 标记已应用 ----
    ops.push({ type: 'video.markApplied', revision: ctx.aiRevision });

    return { ops, note: Object.values(per).join(',') || 'no-change' };
  }

  function songSeed(ai, ctx) {
    return {
      songName: ai.songName || '',
      version: ai.version || '',
      artist: ai.artist || '',
      fromVideoKey: ctx.oldVideoKey || ''
    };
  }

  return {
    callDirect,
    extractContent,
    normalizeEndpoint,
    shouldAskAi,
    planApply,
    HIGH_CONFIDENCE
  };
})();

// 显式导出到全局，兼容 Service Worker 的 importScripts
if (typeof globalThis !== 'undefined') globalThis.AIClient = AIClient;

if (typeof module !== 'undefined' && module.exports) module.exports = AIClient;
