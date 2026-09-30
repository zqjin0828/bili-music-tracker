/**
 * hud.js — 页面左下角调试面板的渲染
 *
 * 为什么单独成文件：
 *   HUD 是排查「为什么这首没计数」的唯一现场，逻辑较复杂（十几种特殊状态）。
 *   抽成纯函数后可以被单元测试直接覆盖，不必起真实浏览器。
 *
 * 设计原则：
 *   1. **顶部先给结论**。只要处于「不会计数」的状态，第一行就用一句话说清原因
 *      （已收藏 / 非音乐 / 已排除 / 静音），用户不必自己推理。
 *   2. **常规状态只占 4~5 行**，不膨胀；只有出现特殊分支才追加解释行。
 *   3. **染色表达严重度**：ok 绿 / warn 黄 / bad 红 / info 灰。
 *      黄 = 不计数但符合预期（如已收藏），红 = 非预期（如非音乐、索引不可用）。
 *
 * 纯函数，无副作用，不依赖 DOM。
 */

'use strict';

(function () {

  /**
   * 「不计数」原因文案 —— key 与 background.js 返回的 reason 严格对应。
   * level 决定颜色：warn=符合预期的不计数，bad=非预期。
   */
  const REASON_TEXT = {
    'already-faved': { text: '已在收藏夹，跳过计数', level: 'warn' },
    'excluded': { text: '已被你排除，跳过计数', level: 'warn' },
    'not-music': { text: '未判定为音乐，跳过计数', level: 'bad' },
    'muted': { text: '静音未计入（设置里关了「静音也计时」）', level: 'warn' },
    'no-advance': { text: '播放进度未推进，跳过', level: 'warn' },
    'below-threshold': { text: '有效收听时长不足', level: 'warn' },
    'no-video': { text: '未找到播放器元素', level: 'bad' }
  };

  /** 收藏来源的中文名 */
  const SOURCE_TEXT = {
    'index': '后台索引',
    'dom': '页面收藏按钮',
    'manual': '你手动标记的',
    'popup': '弹窗标记',
    'none': '未检测'
  };

  const LEVEL_ORDER = { ok: 0, info: 1, warn: 2, bad: 3 };

  // ---------- 工具 ----------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtSec(n) {
    if (n == null || !isFinite(n)) return '?';
    return (Math.round(n * 10) / 10) + 's';
  }

  function fmtAgo(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '';
    const s = ms / 1000;
    if (s < 8) return '刚刚';
    if (s < 60) return Math.round(s) + ' 秒前';
    const m = s / 60;
    if (m < 60) return Math.round(m) + ' 分钟前';
    const h = m / 60;
    if (h < 24) return (Math.round(h * 10) / 10) + ' 小时前';
    return (Math.round(h / 24 * 10) / 10) + ' 天前';
  }

  function row(label, value, level) {
    return '<div class="bmt-hud-row' + (level ? ' is-' + level : '') + '">' +
      '<b>' + esc(label) + '</b> ' + value + '</div>';
  }

  /** 会换行的说明行（长文案用） */
  function prose(label, value, level) {
    return '<div class="bmt-hud-row bmt-hud-wrap' + (level ? ' is-' + level : '') + '">' +
      (label ? '<b>' + esc(label) + '</b> ' : '') + value + '</div>';
  }

  // ---------- 结论判定 ----------

  /**
   * 算出「当前这首会不会计数、为什么」。
   * 返回 { level, text } 或 null（一切正常、无需特别提示）。
   *
   * 优先级从高到低：已收藏 > 上次上报被拒 > 非音乐 > 静音 > 合辑 > 已计入。
   */
  function computeVerdict(ctx) {
    const det = ctx.detection;
    const fav = ctx.fav || {};
    const sess = ctx.session || {};
    const set = ctx.settings || {};
    const ps = ctx.playState || {};

    // 1) 已收藏 —— 用户最常困惑的一类：累计都 100% 了却不计数
    if (fav.faved) {
      return { level: 'warn', text: '不计数：已在「' + (fav.folder || '歌') + '」收藏夹' };
    }

    // 2) 上次上报被后台拒绝
    const lr = ctx.lastReport;
    if (lr && lr.counted === false && REASON_TEXT[lr.reason]) {
      return {
        level: REASON_TEXT[lr.reason].level,
        text: '不计数：' + REASON_TEXT[lr.reason].text.replace(/，?跳过计数$/, '')
      };
    }

    // 3) 非音乐
    if (det && det.isMusic === false) {
      return { level: 'bad', text: '不计数：未判定为音乐' };
    }

    // 4) 静音
    if (ps.muted && set.mutedCounts === false && !ps.paused) {
      return { level: 'warn', text: '不计数：静音（「静音也计时」已关闭）' };
    }

    // 5) 合辑：只计视频级
    if (det && det.isCompilation) {
      return { level: 'info', text: '仅计视频级：合辑不进歌曲榜' };
    }

    // 6) 正常
    //    注意：session.counted 是「本次会话」的标志，而 lastReport 是「上一次上报」。
    //    重播时 resetSession 会清掉前者但后者还在，所以两者都要看 —— 只要有一次
    //    成功上报，回答就是「已计入」，不会因为刚重置就退回「正在上报」。
    if (lr && lr.counted === true) return { level: 'ok', text: '已计入：有效收听达标' };
    if (sess.counted) return { level: 'ok', text: '已计入：有效收听达标' };
    if (ctx.reached) return { level: 'ok', text: '已达阈值，正在上报…' };
    return null;
  }

  // ---------- 主渲染 ----------

  /**
   * @param {object} ctx
   *  have        已累计秒数
   *  need        本次所需秒数
   *  duration    视频时长（0/未知）
   *  pct         百分比（0~100）
   *  reached     本次是否已达标
   *  detection   { isMusic, confidence, tid, tname, isCompilation, manualOverride }
   *  parsed      { songName, version, artist }
   *  playState   { paused, ended, muted, rate, background }
   *  session     { counted, sampleMs, dropped:{seek,mutedSec,noAdvance} }
   *  fav         { faved, source, folder, checkedAgoMs }
   *  index       { known, ok, stale, count, ageMs }
   *  folders     { title, count, cap, remain, ratio, nextName } | null
   *  counts      { video, song }
   *  lastReport  { counted, reason, videoPlayCount, songPlayCount, agoMs, detail }
   *  ai          { channel, applied, songName, version, confidence, reason, failed, queued, pending }
   *  settings    { threshold, minWatchSeconds, mutedCounts }
   *  notice      { text, level }  ← 由 content.js 塞入的临时提示（如「跳过弹卡」）
   * @returns {string} HTML
   */
  function render(ctx) {
    ctx = ctx || {};
    const det = ctx.detection;
    const parsed = ctx.parsed || {};
    const ps = ctx.playState || {};
    const sess = ctx.session || {};
    const fav = ctx.fav || {};
    const ix = ctx.index || {};
    const cnt = ctx.counts || {};
    const set = ctx.settings || {};
    const rows = [];

    // ===== 顶部结论 =====
    const verdict = computeVerdict(ctx);
    if (verdict) {
      rows.push(
        '<div class="bmt-hud-row bmt-hud-head is-' + verdict.level + '">' +
        esc(verdict.text) + '</div>'
      );
    }

    // ===== ① 曲目 =====
    if (parsed.songName) {
      let t = esc(parsed.songName);
      if (parsed.version) t += ' <span class="bmt-hud-dim">· ' + esc(parsed.version) + '</span>';
      if (parsed.artist) t += ' <span class="bmt-hud-dim">(' + esc(parsed.artist) + ')</span>';
      rows.push(row('曲目', t));
    }

    // ===== ② 本次会话的有效收听（与「已听次数」是两个不同口径，标签必须区分） =====
    const pct = ctx.pct != null ? ctx.pct : 0;
    const acc = fmtSec(ctx.have) + ' / 需 ' + fmtSec(ctx.need) +
      ' <span class="bmt-hud-dim">(' + pct + '%)</span>';
    rows.push(row('本次', acc, ctx.reached ? 'ok' : null));
    if (!(ctx.duration > 0)) {
      rows.push(prose('时长', '未取到，按最少 ' + fmtSec(set.minWatchSeconds || 30) + ' 兜底', 'info'));
    }

    // ===== ③ 播放状态 =====
    const st = ps.ended ? '结束' : (ps.paused ? '暂停' : '播放中');
    let stxt = st + ' · ' + (ps.background ? '后台' : '前台') + ' · ' + (ps.muted ? '静音' : '有声');
    if (ps.rate && ps.rate !== 1) stxt += ' · ' + ps.rate + 'x';
    rows.push(row('状态', stxt));

    // ===== ④ 判定 =====
    if (!det) {
      rows.push(row('判定', '等待元数据…', 'info'));
    } else {
      const c = det.confidence != null ? ' <span class="bmt-hud-dim">' + (+det.confidence).toFixed(2) + '</span>' : '';
      let extra = '';
      if (det.tid) extra += ' <span class="bmt-hud-dim">· tid=' + det.tid + (det.tname ? ' ' + esc(det.tname) : '') + '</span>';
      if (det.manualOverride) extra += ' <span class="bmt-hud-dim">· 手动修正</span>';
      rows.push(row('判定', (det.isMusic ? '音乐' : '非音乐') + c + extra, det.isMusic ? null : 'bad'));
      if (!det.isMusic) {
        rows.push(prose('', '→ 可在弹窗里「标为音乐」修正', 'warn'));
      }
    }

    // ===== ⑤ 已听次数（历史累计，决定何时弹卡） =====
    const th = set.threshold || 5;
    if (cnt.video != null || cnt.song != null) {
      const parts = [];
      if (cnt.video != null) parts.push('视频 ' + cnt.video + '/' + th);
      if (cnt.song != null) parts.push('歌曲 ' + cnt.song + '/' + th);
      const max = Math.max(cnt.video || 0, cnt.song || 0);
      const note = max >= th ? ' （已达标）' : ' （还差 ' + (th - max) + ' 次）';
      rows.push(row('已听', parts.join(' <span class="bmt-hud-dim">·</span> ') + note, max >= th ? 'ok' : null));
    }

    // ===== ⑥ 收藏状态（本次重点） =====
    if (fav.faved) {
      const src = SOURCE_TEXT[fav.source] || fav.source || '未知';
      rows.push(row('收藏', '已在「' + esc(fav.folder || '歌') + '」<span class="bmt-hud-dim">→ 不计数、不提醒</span>', 'warn'));
      rows.push(prose('依据', esc(src) +
        (fav.checkedAgoMs != null ? ' <span class="bmt-hud-dim">· ' + fmtAgo(fav.checkedAgoMs) + '核对</span>' : ''), 'info'));
    } else if (fav.known) {
      rows.push(row('收藏', '未收藏 <span class="bmt-hud-dim">（目标「' + esc(fav.folder || '歌') + '」）</span>', null));
    }

    // ===== ⑦ 索引可用性 =====
    if (ix.known) {
      if (!ix.ok) {
        rows.push(prose('索引', '✕ 不可用 → 已收藏检测降级，可能漏判', 'bad'));
      } else if (ix.stale) {
        rows.push(prose('索引', '! 已过期 ' + fmtAgo(ix.ageMs) + ' → 降级判定，宁可多计一次', 'warn'));
      } else if (ix.count != null) {
        rows.push(row('索引', esc(String(ix.count)) + ' 首' +
          (ix.title ? '「' + esc(ix.title) + '」' : '') +
          (ix.ageMs != null ? ' <span class="bmt-hud-dim">· ' + fmtAgo(ix.ageMs) + '刷新</span>' : ''), 'info'));
      }
    }

    // ===== ⑧ 上次上报结果 =====
    const lr = ctx.lastReport;
    if (lr) {
      if (lr.counted) {
        let t = '✓ 已计入';
        const pc = [];
        if (lr.videoPlayCount != null) pc.push('视频 ' + lr.videoPlayCount);
        if (lr.songPlayCount != null) pc.push('歌曲 ' + lr.songPlayCount);
        if (pc.length) t += '（' + pc.join(' / ') + '）';
        if (lr.agoMs != null) t += ' <span class="bmt-hud-dim">· ' + fmtAgo(lr.agoMs) + '</span>';
        rows.push(row('上报', t, 'ok'));
      } else {
        const m = REASON_TEXT[lr.reason] || { text: '未计数（' + esc(lr.reason) + '）', level: 'warn' };
        let t = '✕ ' + esc(m.text);
        if (lr.agoMs != null) t += ' <span class="bmt-hud-dim">· ' + fmtAgo(lr.agoMs) + '</span>';
        rows.push(row('上报', t, m.level));
        if (lr.detail) rows.push(prose('', esc(lr.detail), 'info'));
      }
    }

    // ===== ⑨ 收藏夹容量 =====
    const fol = ctx.folders;
    if (fol && fol.cap) {
      const name = esc(fol.title || '歌');
      const frac = fol.cap.count + '/' + fol.cap.cap;
      if (fol.cap.ratio >= 1) {
        rows.push(prose('容量', '✕ 「' + name + '」已满 ' + frac +
          ' → 收藏目标改为「' + esc(fol.nextName || '歌2') + '」', 'bad'));
      } else if (fol.cap.ratio >= 0.9) {
        rows.push(prose('容量', '! 「' + name + '」' + frac + '，剩 ' + fol.cap.remain + ' → 快满了', 'warn'));
      } else {
        rows.push(row('容量', frac + ' <span class="bmt-hud-dim">· 剩 ' + fol.cap.remain + '</span>', 'info'));
      }
    }

    // ===== ⑩ 为什么累计不涨（丢弃统计） =====
    //   项目名保持短，避免在 340px 宽度里把词切断；解释另起一行灰色小字。
    const dp = sess.dropped || {};
    const dparts = [];
    if (dp.seek) dparts.push('拖进度 ' + dp.seek + ' 次');
    if (dp.mutedSec) dparts.push('静音 ' + fmtSec(dp.mutedSec));
    if (dp.noAdvance) dparts.push('进度停滞 ' + dp.noAdvance + ' 次');
    if (dparts.length) {
      rows.push(row('丢弃', dparts.join(' <span class="bmt-hud-dim">·</span> '), 'warn'));
      const why = [];
      if (dp.seek) why.push('拖动只计入与墙钟相符的部分（防刷进度）');
      if (dp.mutedSec) why.push('静音不计时已在设置里关闭');
      if (dp.noAdvance) why.push('播放中但进度没推进（卡缓冲 / 循环同一段）');
      if (why.length) rows.push(prose('', esc(why.join('；')), 'info'));
    }

    // ===== ⑪ AI =====
    const ai = ctx.ai;
    if (ai && ai.channel && ai.channel !== 'off') {
      if (ai.applied) {
        let t = '✓ 已应用 ' + esc(ai.songName || '');
        if (ai.version) t += ' · ' + esc(ai.version);
        if (ai.confidence) t += ' <span class="bmt-hud-dim">(' + Math.round(ai.confidence * 100) + '%)</span>';
        rows.push(row('AI', t, 'ok'));
        if (ai.reason) rows.push(prose('', esc(ai.reason), 'info'));
      } else if (ai.failed) {
        rows.push(row('AI', '! 调用失败，已降级为规则结果', 'warn'));
        rows.push(prose('', esc(ai.failed), 'info'));
      } else if (ai.queued) {
        rows.push(row('AI', '队列中 · 本页已入队', 'info'));
      } else if (ai.pending > 0) {
        rows.push(row('AI', '队列中 ' + ai.pending + ' 个待判定', 'info'));
      }
    }

    // ===== ⑫ 会话 =====
    rows.push(row('会话', sess.counted ? '✓ 已计入' : '未计入', sess.counted ? 'ok' : null));

    // ===== 临时提示（如「已收藏，跳过弹卡」）=====
    if (ctx.notice && ctx.notice.text) {
      rows.push(prose('提醒', esc(ctx.notice.text), ctx.notice.level || 'info'));
    }

    // ===== 采样间隔 =====
    if (sess.sampleMs) {
      rows.push('<div class="bmt-hud-row bmt-hud-foot">tick ' + sess.sampleMs + 'ms</div>');
    }

    return rows.join('');
  }

  /** 供 CSS 与测试使用：把一个 ctx 转成纯文本（便于断言） */
  function toText(ctx) {
    return render(ctx)
      .replace(/<span class="bmt-hud-dim">/g, '')
      .replace(/<\/?[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
  }

  const api = { render, toText, computeVerdict, fmtAgo, fmtSec, REASON_TEXT, SOURCE_TEXT };

  if (typeof window !== 'undefined') window.BiliHud = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
