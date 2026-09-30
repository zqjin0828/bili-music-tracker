/**
 * content.js — 注入 B 站视频页
 *
 * 职责：
 *  1. 找到 <video> 元素，监听播放事件
 *  2. 每 500ms 采样有效播放时长（后台播放照常计时）
 *  3. 从 __INITIAL_STATE__ 读取视频元数据（含简介 desc）
 *  4. 音乐判定 + 标题解析
 *  5. 达成有效播放后上报 background
 *  6. 接收阈值通知，渲染提醒卡片
 *  7. 辅助打开收藏面板
 */

'use strict';

(function () {
  const Parser = window.BiliParser;
  const Detector = window.BiliDetector;
  const Ai = window.BiliAi;   // 可空：仅用于展示 AI 判断依据
  const Hud = window.BiliHud; // 调试面板渲染（纯函数，可单测）

  // ---------- 常量 ----------
  const SAMPLE_MS = 500;          // 采样间隔
  const DETECT_DEBOUNCE_MS = 1200; // URL 变化后等页面元数据就绪

  // ---------- 状态 ----------
  const state = {
    videoEl: null,
    settings: null,
    // 当前视频元数据
    meta: {
      bvid: '', cid: 0, page: 1, title: '', up: '', tid: 0, tname: '',
      duration: 0, part: '', desc: ''
    },
    parsed: null,
    detection: null,
    apiMeta: null,        // 后台取回的权威元数据（tid/tname/UP/简介）
    apiRequested: false,  // 避免重复请求
    // 本次播放会话
    session: {
      accumulatedMs: 0,      // 累积有效播放毫秒
      lastTickTs: 0,         // 上次采样时刻（墙钟）
      lastCt: 0,             // 上次采样的视频进度（秒）★ 新增
      counted: false,        // 本次会话是否已计数
      seeking: false,
      // ★ v1.3.2：为什么累计没涨 —— 让 HUD 能解释「秒数不动」的原因
      dropped: {
        seek: 0,             // 拖动进度条导致被截断的次数
        mutedSec: 0,         // 因静音未计入的秒数
        noAdvance: 0         // 播放中但进度未推进的次数
      }
    },
    // ★ v1.3.2：调试面板的现场数据（原来只有累计秒数，特殊状态一律看不到）
    hud: {
      lastReport: null,      // 上次 RECORD_PLAY 的结果 {counted, reason, ...}
      counts: { video: null, song: null },
      fav: {                 // 当前视频的收藏检测结果
        known: false, faved: false, source: 'none', folder: '', checkedAt: 0
      },
      index: {               // 后台收藏夹索引的可用性
        known: false, ok: false, stale: false, count: null, title: '', ageMs: null
      },
      folders: null,         // 收藏夹容量 {title, cap:{count,cap,remain,ratio}, nextName}
      ai: null,              // AI 判定情况
      notice: null           // 一次性提示（如「已收藏，跳过弹卡」）
    },
    timer: null,
    cards: []
  };

  // ---------- 工具 ----------

  function log(...args) {
    console.log('[BiliMusicTracker]', ...args);
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ---------- 元数据读取 ----------

  /**
   * 优先从 __INITIAL_STATE__ 读取；B 站改版时降级为 DOM 抓取
   */
  function readMeta() {
    const meta = {
      bvid: '', cid: 0, page: 1, title: '', up: '', tid: 0, tname: '',
      duration: 0, part: '', desc: ''
    };

    // ---- 来源1：window.__INITIAL_STATE__ ----
    try {
      const st = window.__INITIAL_STATE__;
      if (st) {
        const vd = st.videoData || (st.videoInfo && st.videoInfo.videoData);
        if (vd) {
          meta.bvid = vd.bvid || '';
          meta.cid = vd.cid || 0;
          meta.tid = vd.tid || 0;
          meta.tname = vd.tname || '';
          meta.title = vd.title || '';
          meta.up = (vd.owner && vd.owner.name) || '';
          meta.duration = vd.duration || 0;
          meta.page = (st.p && Number(st.p)) || 1;
          // 简介：AI 判定的重要依据（常含曲目表、原曲信息）
          meta.desc = vd.desc || '';
        }
        // 分P 时 p 是页号
        if (st.p && !meta.page) meta.page = Number(st.p) || 1;
      }
    } catch (e) {
      // 忽略，降级
    }

    // ---- 来源2：URL 兜底 ----
    if (!meta.bvid) {
      const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
      if (m) meta.bvid = m[1];
    }
    const pMatch = location.search.match(/[?&]p=(\d+)/);
    if (pMatch) meta.page = Number(pMatch[1]) || 1;

    // ---- 来源3：DOM 兜底 ----
    if (!meta.title) {
      const el = document.querySelector('h1.video-title, h1[title], .video-title')
        || document.querySelector('h1');
      if (el) meta.title = (el.getAttribute('title') || el.textContent || '').trim();
    }
    if (!meta.up) {
      const el = document.querySelector('.up-name, .up-info-name, a.up-name');
      if (el) meta.up = (el.textContent || '').trim();
    }
    if (!meta.duration && state.videoEl && isFinite(state.videoEl.duration)) {
      meta.duration = state.videoEl.duration;
    }
    // 简介 DOM 兜底
    if (!meta.desc) {
      const el = document.querySelector('.desc-info-text, .basic-desc-info, .video-desc');
      if (el) meta.desc = (el.textContent || '').trim();
    }

    // ---- 来源4：从 playlist 找当前 P 的 cid ----
    try {
      const st = window.__INITIAL_STATE__;
      const pages = st && st.videoData && st.videoData.pages;
      if (Array.isArray(pages) && pages.length) {
        const cur = pages[meta.page - 1];
        if (cur) {
          if (cur.cid) meta.cid = cur.cid;
          if (cur.duration && !meta.duration) meta.duration = cur.duration;
          if (cur.part && meta.page > 1) {
            // 分P 标题更有辨识度
            meta.part = cur.part;
          }
        }
      }
    } catch (e) { /* ignore */ }

    // ---- 来源5：后台取回的权威元数据（隔离世界读不到 __INITIAL_STATE__，靠这个补 tid）----
    const am = state.apiMeta;
    if (am && am.bvid && am.bvid === meta.bvid) {
      if (!meta.tid && am.tid) meta.tid = am.tid;
      if (!meta.tname && am.tname) meta.tname = am.tname;
      if (!meta.up && am.owner) meta.up = am.owner;
      if (!meta.desc && am.desc) meta.desc = am.desc;
      if (!meta.cid && am.cid) meta.cid = am.cid;
      if (!meta.title && am.title) meta.title = am.title;
    }

    return meta;
  }

  // ---------- 有效播放采样 ----------

  function resetSession() {
    const s = state.session;
    s.accumulatedMs = 0;
    s.counted = false;
    s.seeking = false;
    s.lastTickTs = Date.now();
    s.lastCt = state.videoEl ? state.videoEl.currentTime : 0;
    s.dropped = { seek: 0, mutedSec: 0, noAdvance: 0 };
  }

  /** 当前「需要听多少秒」才算一次 —— HUD 与判定共用，避免口径不一致 */
  function needSeconds() {
    const v = state.videoEl;
    const duration = (v && isFinite(v.duration) && v.duration > 0)
      ? v.duration
      : (state.meta.duration || 0);
    const ratio = (state.settings && state.settings.minWatchRatio) || 0.30;
    const minSec = (state.settings && state.settings.minWatchSeconds) || 30;
    const need = Math.max(minSec, duration * ratio);
    const finish = duration > 0 ? duration * 0.85 : Infinity;
    return { need, finish, duration };
  }

  function evaluateProgress() {
    const s = state.session;
    const v = state.videoEl;
    if (!v || !state.settings) return;

    const haveSec = s.accumulatedMs / 1000;

    if (s.counted) return;

    // 达成条件：
    //  A. 有效收听 >= max(最少秒数, 时长 × 比例)
    //  B. 或已经听完 85% 以上
    const { need, finish } = needSeconds();

    const reached = haveSec >= need || haveSec >= finish;
    if (reached) {
      s.counted = true;
      reportPlay(haveSec);
    }
  }

  function tick() {
    const v = state.videoEl;
    if (!v || !state.settings) return;

    const now = Date.now();
    const s = state.session;
    const ct = v.currentTime;
    const rate = v.playbackRate || 1;

    const playing = !v.paused
      && !v.ended
      && (state.settings.mutedCounts || !v.muted)
      && !s.seeking
      && isFinite(ct);

    if (playing && s.lastTickTs) {
      const wallSec = (now - s.lastTickTs) / 1000;  // 距上次采样经过的墙钟秒
      const ctSec = ct - s.lastCt;                  // 视频进度实际推进的秒

      if (wallSec > 0 && wallSec < 24 * 3600 && ctSec > 0) {
        // ★ 关键修复：改用「视频进度推进量」累计，而不是墙钟 tick 间隔。
        //
        // 旧实现用 (now - lastTickTs) 累计，并丢弃 > 3000ms 的间隔
        //   if (delta > 0 && delta < 3000) accumulated += delta
        // 但 Chrome 会节流后台标签页的定时器：隐藏 5 分钟后降到约每分钟 1 次。
        // 于是 delta≈60000 被当成「异常」丢弃 → 后台播放累计恒为 0。
        //
        // 现在以 currentTime 的增量为准（视频在后台照常推进，不受节流影响），
        // 再用墙钟推算「正常播放本应推进多少」来识别 seek：
        //   · 后台被节流（wallSec 可能 60s）：ctSec≈expected → 全额计入
        //   · 拖动进度条：ctSec 远大于 expected → 只计入与墙钟相符的部分
        const expected = wallSec * rate;
        const cap = Math.max(expected * 1.2 + 1, 1.5);
        s.accumulatedMs += Math.min(ctSec, cap) * 1000;
        // ★ v1.3.2：进度跳变远大于墙钟预期 → 判定为拖动，记一笔供 HUD 解释
        if (ctSec > cap + 0.5) s.dropped.seek += 1;
      }
      // ctSec <= 0：回退或重播同一段，不重复累计（拖动后重新播放会再次累计）
      else if (ctSec <= 0 && !v.paused && !v.ended && !s.seeking) {
        // 播放中但进度没推进 —— 卡缓冲 / 直播流 / 循环同一段
        s.dropped.noAdvance += 1;
      }
    } else if (!playing && !v.paused && !v.ended && v.muted && state.settings.mutedCounts === false && s.lastTickTs) {
      // ★ v1.3.2：静音且设置里不允许静音计时 → 秒数不涨，但用户需要知道原因
      const wallSec = (now - s.lastTickTs) / 1000;
      if (wallSec > 0 && wallSec < 24 * 3600) s.dropped.mutedSec += wallSec;
    }

    s.lastCt = ct;
    s.lastTickTs = now;

    updateHud();
    evaluateProgress();
  }

  // ---------- 上报 background ----------

  /**
   * ★ v1.3：上报前先做「已收藏」二次校验（DOM，实时）
   *
   * 本地索引可能滞后（刚点了收藏，索引还没刷新），所以这里读一次页面上的
   * 收藏按钮状态，随 payload 一起上报。background 会合并「索引 | DOM」判定。
   */
  function readDomFaved() {
    try {
      const F = window.BiliFavIndex;
      if (F && typeof F.readDomFavState === 'function') {
        return !!F.readDomFavState().faved;
      }
      // 兜底：内联一份简易判断
      const nodes = document.querySelectorAll('.video-fav, [class*="video-fav"]');
      for (const el of nodes) {
        const cls = String(el.className || '');
        const txt = (el.textContent || '').trim();
        if (/\b(on|active|actived|faved|selected)\b/.test(cls)) return true;
        if (/已收藏|已加入/.test(txt)) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  async function reportPlay(watchedSeconds) {
    const meta = state.meta;
    const parsed = state.parsed || { songName: meta.title, version: '', artist: '' };
    const det = state.detection || { isMusic: false, confidence: 0 };

    const songKey = (state.settings && state.settings.songLevel)
      ? Parser.makeSongKey(parsed, state.settings.mergeSimilarVersions !== false)
      : '';

    const payload = {
      bvid: meta.bvid,
      cid: meta.cid,
      page: meta.page,
      title: meta.part && meta.page > 1 ? `${meta.title} - P${meta.page} ${meta.part}` : meta.title,
      desc: meta.desc || '',
      part: meta.part || '',
      up: meta.up,
      tid: meta.tid,
      tname: meta.tname,
      duration: meta.duration,
      watchedSeconds,
      isMusic: det.isMusic,
      musicConfidence: det.confidence,
      isCompilation: !!det.isCompilation,
      songKey,
      songName: parsed.songName,
      version: parsed.version,
      artist: parsed.artist,
      // ★ v1.3：带上 DOM 收藏状态，供后台合并判定
      domFaved: readDomFaved()
    };

    try {
      const res = await chrome.runtime.sendMessage({ type: 'RECORD_PLAY', payload });
      if (res && res.ok) {
        const d = res.data || {};

        // ★ v1.3.2：把上报结果落到 HUD 现场，这样「为什么没计数」有据可查。
        //   旧版这里 return 了就完事，HUD 上什么也看不到 —— 用户只看到
        //   「累计 100%」却不见次数增加，完全无从判断。
        state.hud.lastReport = {
          counted: d.counted !== false,
          reason: d.reason || '',
          favedSource: d.favedSource || '',
          videoPlayCount: d.videoPlayCount != null ? d.videoPlayCount : null,
          songPlayCount: d.songPlayCount != null ? d.songPlayCount : null,
          detail: d.detail || '',
          at: Date.now()
        };
        if (d.videoPlayCount != null || d.songPlayCount != null) {
          state.hud.counts = {
            video: d.videoPlayCount != null ? d.videoPlayCount : state.hud.counts.video,
            song: d.songPlayCount != null ? d.songPlayCount : state.hud.counts.song
          };
        }
        // 后台判成已收藏 → 同步到 fav 现场，HUD 顶部结论会立刻变成「不计数：已在…」
        if (d.counted === false && d.reason === 'already-faved') {
          state.hud.fav.known = true;
          state.hud.fav.faved = true;
          state.hud.fav.source = d.favedSource || 'index';
          state.hud.fav.checkedAt = Date.now();
          state.hud.notice = { text: '已在收藏夹 → 已跳过计数与弹卡', level: 'warn' };
        } else if (d.favedSource && d.favedSource !== 'none') {
          state.hud.fav.known = true;
          state.hud.fav.faved = true;
          state.hud.fav.source = d.favedSource;
          state.hud.fav.checkedAt = Date.now();
        }
        // AI 处理情况回填
        const ai = d.ai;
        if (ai) {
          state.hud.ai = Object.assign({}, state.hud.ai, {
            channel: ai.source || (state.hud.ai && state.hud.ai.channel) || 'queue',
            queued: !!ai.queued,
            failed: ai.failed || '',
            pending: ai.pending != null ? ai.pending : (state.hud.ai && state.hud.ai.pending)
          });
        }
        updateHud();

        // ★ 已收藏 → 明确告诉用户「不再计数」，而不是静默丢弃
        if (d.counted === false && d.reason === 'already-faved') {
          showToast('这首已在「歌」收藏夹，不再计数 ✓');
          log('已收藏，跳过计数', d.favedSource);
          return;
        }

        log('已记录一次播放', d);
        const maxCount = Math.max(
          d.videoPlayCount || 0,
          d.songPlayCount || 0
        );
        if (state.settings.threshold && maxCount < state.settings.threshold) {
          showToast(`已听 ${maxCount} / ${state.settings.threshold} 次`);
        }
        // 提示 AI 处理情况（只在队列模式下提示一次，不打扰）
        if (ai && ai.source === 'queue' && ai.queued) {
          log('已加入 AI 判定队列');
        } else if (ai && ai.source === 'direct' && ai.failed) {
          log('AI 判定失败，已降级为规则结果：', ai.failed);
        }
      }
    } catch (e) {
      log('上报失败（扩展可能已更新，刷新页面即可）', e);
      state.hud.lastReport = {
        counted: false, reason: 'no-video',
        detail: '与后台通信失败，刷新页面后重试',
        at: Date.now()
      };
      updateHud();
    }
  }

  // ---------- 提醒卡片 ----------

  function removeCards() {
    state.cards.forEach(c => c.remove && c.remove());
    state.cards = [];
  }

  function showThresholdCard(n) {
    const card = document.createElement('div');
    card.className = 'bmt-card';
    const verText = n.version ? ` · ${n.version}` : '';
    const upText = n.up ? `<div class="bmt-up">${escapeHtml(truncate(n.up, 30))}</div>` : '';
    const favName = (state.settings && state.settings.favFolderName) || '歌';
    const aiName = n.aiSongName || n.songName;
    const aiTag = n.aiVersion
      ? `<div class="bmt-ai">🤖 AI 判定：${escapeHtml(truncate(aiName, 30))}${n.aiVersion ? ' · ' + escapeHtml(n.aiVersion) : ''}${n.aiConfidence ? `（把握 ${Math.round(n.aiConfidence * 100)}%）` : ''}</div>`
      : '';

    card.innerHTML = `
      <div class="bmt-head">
        <span class="bmt-emoji">🎵</span>
        <span class="bmt-title">这首歌你听了 ${n.playCount} 遍了</span>
        <button class="bmt-close" title="关闭">×</button>
      </div>
      <div class="bmt-body">
        <div class="bmt-song">${escapeHtml(truncate(n.songName || n.title, 40))}<span class="bmt-ver">${escapeHtml(verText)}</span></div>
        ${n.title && n.songName && n.title !== n.songName ? `<div class="bmt-video-title">${escapeHtml(truncate(n.title, 50))}</div>` : ''}
        ${upText}
        ${aiTag}
      </div>
      <div class="bmt-actions">
        <button class="bmt-btn bmt-primary">去收藏到「${escapeHtml(favName)}」</button>
        <button class="bmt-btn bmt-ghost">稍后</button>
      </div>
    `;

    card.querySelector('.bmt-close').addEventListener('click', () => {
      card.remove();
      state.cards = state.cards.filter(c => c !== card);
    });
    card.querySelector('.bmt-ghost').addEventListener('click', () => {
      card.remove();
      state.cards = state.cards.filter(c => c !== card);
    });
    card.querySelector('.bmt-primary').addEventListener('click', () => {
      assistFavorites(n);
    });

    document.body.appendChild(card);
    state.cards.push(card);

    // 12 秒后自动淡出（但保留在 DOM 中可鼠标移回）
    setTimeout(() => {
      if (card.isConnected) card.classList.add('bmt-fading');
    }, 12000);
    card.addEventListener('mouseenter', () => card.classList.remove('bmt-fading'));
  }

  function showToast(text) {
    const old = document.getElementById('bmt-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'bmt-toast';
    el.className = 'bmt-toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('bmt-toast-show'), 10);
    setTimeout(() => {
      el.classList.remove('bmt-toast-show');
      setTimeout(() => el.remove(), 300);
    }, 2600);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }
  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // ---------- 收藏辅助 ----------

  /**
   * ★ 构造收藏夹页 URL（v1.3.1 修复）
   *
   * 踩过的坑：
   *   旧代码跳的是 `https://space.bilibili.com/favlist`（**没有 mid**），
   *   实测该地址直接返回 **404「出错啦!」** —— 这就是「收藏后跳过去页面不存在」的原因。
   *
   * 正确形态（实测 200）：
   *   https://space.bilibili.com/<mid>/favlist              我的收藏夹总入口
   *   https://space.bilibili.com/<mid>/favlist?fid=<mediaId> 直接打开某个夹
   *
   * @returns {Promise<string>} 可用的 URL；拿不到 mid 时返回总入口兜底
   */
  async function buildFavUrl(mediaId) {
    let mid = state.selfMid || '';
    if (!mid) {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'FAV_GET_SELF_MID' });
        if (r && r.ok && r.data && r.data.mid) {
          mid = String(r.data.mid);
          state.selfMid = mid;
        }
      } catch (e) { /* ignore */ }
    }
    if (!mid) {
      // 实在拿不到 mid：退回「我的收藏」总页（该页不依赖 mid）
      return 'https://www.bilibili.com/account/favlist';
    }
    const base = `https://space.bilibili.com/${mid}/favlist`;
    return mediaId ? `${base}?fid=${mediaId}` : base;
  }

  /**
   * 半自动收藏：
   *  1) 尝试点击页面原生收藏按钮展开面板
   *  2) 面板出现后，在收藏夹列表里找目标收藏夹（默认「歌」，含溢出夹「歌2」…）并高亮
   *  3) 失败则复制歌名到剪贴板 + 打开**正确的**收藏夹页
   */
  async function assistFavorites(n) {
    const baseName = (state.settings && state.settings.favFolderName) || '歌';

    // 0) ★ 先问后台：当前该往哪个夹收（「歌」满了就自动指向「歌2」）
    let targetName = baseName;
    let targetId = null;
    let capTip = '';
    try {
      const cr = await chrome.runtime.sendMessage({ type: 'FAV_CAP_CHECK' });
      if (cr && cr.ok && cr.data) {
        const d = cr.data;
        if (d.allFull) {
          // 全满 → 提示建新夹
          showFullFolderCard(d.nextName, d.base);
          return;
        }
        // chain 里第一个是主夹；若主夹已满则应指向下一个
        const usable = (d.chain || []).find(f => {
          const st = BiliFavIndex.capStatus ? BiliFavIndex.capStatus(f.count, f) : null;
          return !st || st.level !== 'full';
        });
        if (usable) { targetName = usable.title; targetId = usable.mediaId; }
        const mainFull = (d.chain || []).some(f =>
          BiliFavIndex.capStatus && BiliFavIndex.capStatus(f.count, f).level === 'full');
        if (mainFull && usable && usable.title !== baseName) {
          capTip = `「${baseName}」已满，已切到「${targetName}」`;
        }
      }
    } catch (e) { /* 降级为原名 */ }

    // 1) 找收藏按钮
    const favBtn = document.querySelector(
      '.video-fav, .toolbar-left .video-fav, [class*="fav"] .video-fav, ' +
      '.video-toolbar-left .video-fav, button[class*="fav"]'
    );

    if (favBtn) {
      favBtn.click();
    }

    // 2) 等面板出现（同时匹配主夹与溢出夹）
    const folder = await waitFor(() => {
      const items = document.querySelectorAll(
        '.fav-list li, .folder-list li, .fav-folder-item, [class*="fav"] [class*="folder"] li'
      );
      // 优先精确匹配目标名
      for (const li of items) {
        const txt = (li.textContent || '').trim();
        if (txt === targetName || txt.startsWith(targetName)) return li;
      }
      // 退而求其次：主夹名
      for (const li of items) {
        const txt = (li.textContent || '').trim();
        if (txt.includes(baseName)) return li;
      }
      return null;
    }, 2500);

    if (folder) {
      folder.classList.add('bmt-folder-hit');
      folder.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // ★ 面板里若已有「歌2」，把主夹那个挪后，避免用户点错（视觉上由 .bmt-folder-hit 引导）
      showToast(capTip || `已为你定位到「${targetName}」，勾选它即可收藏`);
      // 收藏动作完成后，把该 bvid 立刻写进本地索引（不等 30 分钟全量刷新）
      watchFavConfirm(n, targetId);
      return;
    }

    // 3) 降级：复制歌名 + 打开正确的收藏夹页
    const songName = n.songName || n.title || '';
    try {
      await navigator.clipboard.writeText(songName);
      showToast(`歌名已复制：「${truncate(songName, 20)}」，请在收藏夹里搜索`);
    } catch (e) {
      showToast('请手动收藏，歌名：' + truncate(songName, 24));
    }
    const url = await buildFavUrl(targetId);
    setTimeout(() => { window.open(url, '_blank'); }, 800);
  }

  /**
   * ★ 收藏成功后立刻把 bvid 加进本地索引（避免重复计数）
   * 轮询页面收藏按钮状态：从「未收藏」变「已收藏」即认为收藏成功。
   */
  function watchFavConfirm(n, mediaId) {
    if (!n || !n.bvid) return;
    if (readDomFaved()) {
      // 点开面板前就已经是已收藏状态
      chrome.runtime.sendMessage({
        type: 'SET_OVERRIDE', key: n.bvid, value: 'mark-faved', level: 'video'
      }).catch(() => {});
      return;
    }
    let tries = 0;
    const iv = setInterval(async () => {
      tries++;
      if (readDomFaved()) {
        clearInterval(iv);
        try {
          await chrome.runtime.sendMessage({
            type: 'FAV_MARK_ADDED', bvid: n.bvid, mediaId: mediaId || null
          });
        } catch (e) { /* ignore */ }
        showToast('已收藏 ✓ 计入索引，之后不再重复计数');
        return;
      }
      if (tries > 150) clearInterval(iv);   // 30 秒后放弃
    }, 200);
  }

  /**
   * ★ 收藏夹全满时的引导卡片：一键新建「歌2」
   */
  function showFullFolderCard(nextName, baseName) {
    const card = document.createElement('div');
    card.className = 'bmt-card';
    card.innerHTML = `
      <div class="bmt-head">
        <span class="bmt-emoji">📁</span>
        <span class="bmt-title">「${escapeHtml(baseName || '歌')}」已满 1000 首</span>
        <button class="bmt-close" title="关闭">×</button>
      </div>
      <div class="bmt-body">
        <div class="bmt-song">要不要新建一个「${escapeHtml(nextName)}」继续收藏？</div>
        <div class="bmt-video-title">B站单个自建收藏夹上限 1000 首。新建后插件会自动把它纳入索引与收藏目标，你不需要再改任何设置。</div>
      </div>
      <div class="bmt-actions">
        <button class="bmt-btn bmt-primary">新建「${escapeHtml(nextName)}」</button>
        <button class="bmt-btn bmt-ghost">我自己去建</button>
      </div>
    `;

    const close = () => { card.remove(); state.cards = state.cards.filter(c => c !== card); };
    card.querySelector('.bmt-close').addEventListener('click', close);
    card.querySelector('.bmt-ghost').addEventListener('click', close);
    card.querySelector('.bmt-primary').addEventListener('click', async () => {
      const btn = card.querySelector('.bmt-primary');
      btn.disabled = true;
      btn.textContent = '新建中…';
      try {
        const r = await chrome.runtime.sendMessage({ type: 'FAV_CREATE_FOLDER', title: nextName });
        if (r && r.ok) {
          showToast(`已新建「${nextName}」，索引刷新中`);
          close();
          setTimeout(() => {
            window.open(
              `https://space.bilibili.com/${state.selfMid || ''}/favlist`,
              '_blank'
            );
          }, 600);
        } else {
          btn.disabled = false;
          btn.textContent = `新建「${nextName}」`;
          const err = (r && (r.error || r.code)) || '未知错误';
          showToast('新建失败：' + err + '（可去网页端手动新建）');
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = `新建「${nextName}」`;
        showToast('新建失败，请去网页端手动新建');
      }
    });

    document.body.appendChild(card);
    state.cards.push(card);
  }

  function waitFor(fn, timeout) {
    return new Promise(resolve => {
      const start = Date.now();
      const iv = setInterval(() => {
        let r = null;
        try { r = fn(); } catch (e) { r = null; }
        if (r) { clearInterval(iv); resolve(r); }
        else if (Date.now() - start > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  // ---------- 音乐判定 ----------

  /**
   * ★ 从后台取权威元数据。
   *
   * 内容脚本在隔离世界里读不到页面的 __INITIAL_STATE__，
   * 所以 tid（判定音乐最强的一路信号）拿不到，恒为 0。
   * 这里改由后台调 B 站接口补齐 tid / tname / UP / 简介。
   *
   * 拿到后重新判定一次；已判定为音乐就不再重复请求。
   */
  async function enrichMetaFromApi(bvid) {
    if (!bvid) return null;
    if (state.apiMeta && state.apiMeta.bvid === bvid) return state.apiMeta;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_VIDEO_META', bvid });
      if (res && res.ok && res.data) {
        state.apiMeta = res.data;
        return res.data;
      }
    } catch (e) {
      log('取元数据失败（降级为纯 DOM 判定）', e);
    }
    return null;
  }

  function analyze() {
    const meta = readMeta();
    state.meta = meta;

    if (!meta.title) {
      // 元数据还没就绪，稍后重试
      return false;
    }

    // 分P 时用分P 名参与解析（更有可能是歌名）
    const titleForParse = (meta.part && meta.page > 1)
      ? `${meta.part} ${meta.title}`
      : meta.title;

    state.parsed = Parser.parseTitle(titleForParse);
    state.detection = Detector.detectMusic({
      tid: meta.tid,
      title: meta.title,
      upName: meta.up,
      duration: meta.duration,
      tname: meta.tname
    });

    log('解析结果', state.parsed, '判定', state.detection);

    // ★ v1.3.2：异步取「这支是否已收藏 / 索引是否可用 / 夹容量」，供 HUD 展示。
    //   以前这些信息只有在播完一轮后由后台间接透露，HUD 还不显示 ——
    //   现在一进页面就知道，不必等到「累计 100% 却不计数」才困惑。
    refreshFavContext().catch(() => { /* ignore */ });

    // ★ v1.3.2：把解析出的曲目立即反映到 HUD
    updateHud();

    // 若分区缺失（隔离世界读不到页面状态），异步补一次 API 元数据后重新判定
    if ((!meta.tid || !meta.up) && !state.apiRequested) {
      state.apiRequested = true;
      enrichMetaFromApi(meta.bvid).then((am) => {
        if (!am) return;
        // 用接口的权威值覆盖，重新跑一次判定
        state.meta = Object.assign({}, state.meta, {
          tid: am.tid || state.meta.tid,
          tname: am.tname || state.meta.tname,
          up: am.owner || state.meta.up,
          duration: state.meta.duration || am.duration,
          desc: am.desc || ''
        });
        state.detection = Detector.detectMusic({
          tid: state.meta.tid,
          title: state.meta.title,
          upName: state.meta.up,
          duration: state.meta.duration,
          tname: state.meta.tname
        });
        log('API 元数据补全后重新判定', state.detection);
        updateHud();
      });
    }

    return true;
  }

  // ---------- 调试面板 ----------
  //
  // 用于直观确认「累计秒数」是否在涨 —— 后台播放也能看到它继续走。
  // 可在设置里关闭；也可按 Alt+M 临时切换。

  let hudEl = null;

  function hudEnabled() {
    return !!(state.settings && state.settings.debugHud);
  }

  /** 换视频时清掉「属于上一支」的现场数据，保留索引/容量这类全局信息 */
  function resetHudForVideo() {
    const h = state.hud;
    h.lastReport = null;
    h.counts = { video: null, song: null };
    h.notice = null;
    h.ai = null;
    h.fav = { known: false, faved: false, source: 'none', folder: '', checkedAt: 0 };
    updateHud();
  }

  function updateHud() {
    if (!hudEnabled()) {
      if (hudEl) { hudEl.remove(); hudEl = null; }
      return;
    }
    const v = state.videoEl;
    if (!v) return;

    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.className = 'bmt-hud';
      document.body.appendChild(hudEl);
    }

    hudEl.innerHTML = Hud.render(buildHudCtx(v));
  }

  /** 把当前状态整理成 BiliHud.render 需要的入参（纯数据，无 DOM 依赖） */
  function buildHudCtx(v) {
    const { need, finish, duration } = needSeconds();
    const s = state.session;
    const have = s.accumulatedMs / 1000;
    const pct = need > 0 ? Math.min(100, Math.round(have / need * 100)) : 0;
    const hud = state.hud;
    const now = Date.now();
    const ago = (ts) => (ts ? Math.max(0, now - ts) : null);

    // 时长未知时 need 会退化成「最少秒数」，此时「听完 85%」这条分支不可用
    const reached = have >= need || (isFinite(finish) && have >= finish);

    const d = state.detection || null;
    // 判定器可能只给 tid，补上 tname 便于阅读
    const det = d ? {
      isMusic: !!d.isMusic,
      confidence: d.confidence,
      tid: state.meta.tid || 0,
      tname: state.meta.tname || '',
      isCompilation: !!d.isCompilation,
      manualOverride: !!d.manualOverride
    } : null;

    return {
      have, need, duration, pct, reached,
      detection: det,
      parsed: state.parsed ? {
        songName: state.parsed.songName,
        version: state.parsed.version,
        artist: state.parsed.artist
      } : null,
      playState: {
        paused: v.paused, ended: v.ended, muted: v.muted,
        rate: v.playbackRate || 1,
        background: document.visibilityState === 'hidden'
      },
      session: {
        counted: s.counted,
        sampleMs: SAMPLE_MS,
        dropped: s.dropped
      },
      fav: {
        known: hud.fav.known,
        faved: hud.fav.faved,
        source: hud.fav.source,
        folder: hud.fav.folder || (state.settings && state.settings.favFolderName) || '歌',
        checkedAgoMs: ago(hud.fav.checkedAt)
      },
      index: {
        known: hud.index.known,
        ok: hud.index.ok,
        stale: hud.index.stale,
        count: hud.index.count,
        title: hud.index.title,
        ageMs: hud.index.ageMs
      },
      folders: hud.folders,
      counts: hud.counts,
      lastReport: hud.lastReport ? Object.assign({}, hud.lastReport, {
        agoMs: ago(hud.lastReport.at)
      }) : null,
      ai: hud.ai,
      settings: state.settings || {},
      notice: hud.notice
    };
  }

  // ---------- 现场数据采集（供 HUD 显示特殊状态） ----------

  /**
   * ★ v1.3.2：取一次「当前视频是否已收藏」+「索引是否可用」+「夹容量」。
   *
   * 旧的 HUD 只有在播完一轮、后台返回 already-faved 之后才间接暴露这件事，
   * 而且还不显示。现在**一进页面就主动查**，用户不播也能看到「这首已收藏」。
   */
  async function refreshFavContext(force) {
    const bvid = state.meta.bvid;
    const fav = state.hud.fav;
    const base = (state.settings && state.settings.favFolderName) || '歌';

    // 同一支视频 60 秒内不重复查（避免每次路由抖动都打后台）
    if (!force && fav.known && bvid && fav.bvid === bvid && Date.now() - fav.checkedAt < 60000) return;

    // ---- 已收藏检测：DOM 实时状态优先，索引兜底 ----
    let domFaved = false;
    try { domFaved = readDomFaved(); } catch (e) { /* ignore */ }

    let idxFaved = false, hitTitle = '', idxStale = false, idxCount = null;
    if (bvid) {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'FAV_CHECK_BVID', bvid });
        const d = (r && r.data) || null;
        if (d) {
          idxFaved = !!d.faved;
          hitTitle = d.folderTitle || '';
          idxStale = !!d.stale;
          idxCount = d.indexCount != null ? d.indexCount : null;
        }
      } catch (e) { /* ignore */ }
    }

    fav.bvid = bvid;
    fav.faved = !!(domFaved || idxFaved);
    fav.source = domFaved ? 'dom' : (idxFaved ? 'index' : 'none');
    fav.folder = hitTitle || base;
    fav.known = !!bvid;
    fav.checkedAt = Date.now();

    // ---- 索引可用性 + 夹容量 ----
    let ixOk = false, ixCount = idxCount, ixTitle = base, ixAgeMs = null, cap = null, nextName = '';
    try {
      const r = await chrome.runtime.sendMessage({ type: 'FAV_GET_STATUS' });
      const d = (r && r.data) || null;
      if (d) {
        ixOk = !!d.hasIndex;
        ixCount = d.count != null ? d.count : idxCount;
        ixTitle = d.folderTitle || base;
        ixAgeMs = d.fetchedAt ? Math.max(0, Date.now() - d.fetchedAt) : null;
        idxStale = d.stale != null ? !!d.stale : idxStale;
        cap = d.cap || null;
        nextName = d.nextName || '';
      }
    } catch (e) { /* ignore */ }

    state.hud.index = {
      known: true,
      ok: ixOk,
      stale: idxStale,
      count: ixCount,
      title: ixTitle,
      ageMs: ixAgeMs
    };
    state.hud.folders = cap ? { title: ixTitle, cap, nextName } : null;

    updateHud();
  }

  window.addEventListener('keydown', (e) => {
    // Alt+M 临时开关调试面板
    if (e.altKey && (e.key === 'm' || e.key === 'M')) {
      if (!state.settings) return;
      state.settings.debugHud = !state.settings.debugHud;
      try { chrome.runtime.sendMessage({ type: 'SET_SETTINGS', patch: { debugHud: state.settings.debugHud } }); } catch (err) { /* ignore */ }
      updateHud();
      showToast(state.settings.debugHud ? '调试面板已开启' : '调试面板已关闭');
    }
  });

  document.addEventListener('visibilitychange', () => {
    log('可见性变化 →', document.visibilityState);
    tick();   // 切换前后各刷一次，避免节流窗口内状态丢失
  });
  window.addEventListener('pagehide', () => { try { tick(); } catch (e) { /* ignore */ } });

  // ---------- 事件绑定 ----------

  function bindVideo(v) {
    if (state.videoEl === v) return;

    // 解绑旧的
    if (state.videoEl && state.unbind) state.unbind();

    state.videoEl = v;
    resetSession();

    const onPlay = () => {
      // 从暂停恢复：把采样基准重置到当前时刻，避免把暂停期间算进来
      state.session.lastTickTs = Date.now();
      state.session.lastCt = v.currentTime;
      log('播放开始');
    };
    const onPause = () => {
      // 暂停前先把这一段结算掉，再清基准
      tick();
      state.session.lastTickTs = Date.now();
      state.session.lastCt = v.currentTime;
    };
    const onSeeking = () => {
      state.session.seeking = true;
    };
    const onSeeked = () => {
      state.session.seeking = false;
      state.session.lastCt = v.currentTime;
      state.session.lastTickTs = Date.now();
    };
    const onEnded = () => {
      // 听完最后一段也算数
      evaluateProgress();
      resetSession();
      updateHud();
    };
    const onLoadedMeta = () => {
      if (isFinite(v.duration) && v.duration > 0) {
        state.meta.duration = v.duration;
      }
      // 时长变了要重新判定
      analyze();
      updateHud();
    };
    // ★ 用 timeupdate 补充采样：正常播放时约 4Hz，比 500ms 定时器更贴实时；
    //   后台被节流时它也会变稀，但累计是基于 currentTime 增量的，不受影响。
    const onTimeUpdate = () => { tick(); };
    const onRateChange = () => {
      state.session.lastCt = v.currentTime;
      state.session.lastTickTs = Date.now();
    };

    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeking', onSeeking);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('ended', onEnded);
    v.addEventListener('loadedmetadata', onLoadedMeta);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('ratechange', onRateChange);

    state.unbind = () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeking', onSeeking);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('loadedmetadata', onLoadedMeta);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('ratechange', onRateChange);
    };

    // 若已经在播放，立刻开始计时
    if (!v.paused) {
      state.session.lastTickTs = Date.now();
      state.session.lastCt = v.currentTime;
    }

    updateHud();
    log('已绑定 video 元素');
  }

  function startTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(tick, SAMPLE_MS);
  }

  let videoWatchObserver = null;

  /**
   * 监听 DOM 变化以发现/替换 video 元素（B站 SPA 会换元素）
   * 用 MutationObserver 替代轮询，更省资源
   */
  function watchForVideo() {
    // 先尝试立即绑定
    const initial = document.querySelector('video');
    if (initial) bindVideo(initial);

    if (videoWatchObserver) videoWatchObserver.disconnect();

    let scheduled = false;
    videoWatchObserver = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      // 合并同一批 DOM 变更，避免频繁查询
      requestAnimationFrame(() => {
        scheduled = false;
        const v = document.querySelector('video');
        if (v && v !== state.videoEl) {
          bindVideo(v);
        }
      });
    });

    videoWatchObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    // 兜底：某些情况下 video 已存在但被替换而不触发 childList（如同元素换 src），
    // 用低频轮询保底，10 秒一次
    setInterval(() => {
      const v = document.querySelector('video');
      if (v && v !== state.videoEl) bindVideo(v);
    }, 10000);
  }

  // SPA 路由变化处理
  const onRouteChange = debounce(async () => {
    log('路由变化', location.href);
    removeCards();
    resetSession();
    resetHudForVideo();
    // 换视频了：清掉上一支的元数据缓存，重新取
    state.apiMeta = null;
    state.apiRequested = false;
    try {
      const bvid = readMeta().bvid;
      if (bvid) await enrichMetaFromApi(bvid);
    } catch (e) { /* 降级 */ }
    if (analyze()) {
      // 元数据就绪
    } else {
      setTimeout(analyze, 1500);
    }
  }, DETECT_DEBOUNCE_MS);

  function hookHistory() {
    const wrap = (type) => {
      const orig = history[type];
      return function (...args) {
        const rv = orig.apply(this, args);
        window.dispatchEvent(new Event('bmt:locationchange'));
        return rv;
      };
    };
    history.pushState = wrap('pushState');
    history.replaceState = wrap('replaceState');
    window.addEventListener('popstate', () => {
      window.dispatchEvent(new Event('bmt:locationchange'));
    });
    window.addEventListener('bmt:locationchange', onRouteChange);
  }

  // ---------- 消息监听 ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'THRESHOLD_REACHED') {
      const list = msg.notifications || [];

      // ★ v1.3：弹卡片前二次校验「是否已收藏」
      //   场景：刚好在达标那一刻用户点了收藏，或者索引刚更新过。
      //   此时不该再打扰用户。用后台索引 + DOM 双重确认。
      (async () => {
        const toShow = [];
        let skippedFaved = 0;
        for (const n of list.slice(0, 2)) {
          const bvid = n.bvid || '';
          let faved = readDomFaved();          // DOM 实时状态优先

          if (!faved && bvid) {
            // 后台索引再确认一次
            try {
              const r = await chrome.runtime.sendMessage({ type: 'FAV_CHECK_BVID', bvid });
              if (r && r.ok && r.data && r.data.faved) faved = true;
            } catch (e) { /* ignore */ }
          }

          if (faved) {
            log('已收藏，跳过提醒卡片', bvid);
            skippedFaved++;
            continue;
          }
          toShow.push(n);
        }

        // ★ v1.3.2：把「跳过了几张卡、为什么」写进 HUD 现场，
        //   否则用户只会觉得「达标了怎么没弹卡」，无处可查。
        if (skippedFaved && !toShow.length) {
          state.hud.fav.known = true;
          state.hud.fav.faved = true;
          state.hud.fav.checkedAt = Date.now();
          state.hud.notice = {
            text: '已收藏 → 本次跳过 ' + skippedFaved + ' 张提醒卡',
            level: 'warn'
          };
          updateHud();
        } else if (skippedFaved) {
          state.hud.notice = {
            text: '已收藏 → 跳过 ' + skippedFaved + ' 张卡，仅弹 ' + toShow.length + ' 张',
            level: 'info'
          };
          updateHud();
        }

        if (toShow.length) toShow.forEach(showThresholdCard);
        else showToast('已在「歌」收藏夹，无需重复收藏 ✓');
        sendResponse({ ok: true, shown: toShow.length });
      })();
      return true;   // 异步响应
    }
    if (msg.type === 'PING') {
      sendResponse({ ok: true, meta: state.meta, detection: state.detection });
      return;
    }
  });

  // ---------- 启动 ----------

  async function init() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      state.settings = (res && res.data) || {
        threshold: 5, videoLevel: true, songLevel: true,
        minWatchRatio: 0.3, minWatchSeconds: 30,
        mutedCounts: true, favFolderName: '歌'
      };
    } catch (e) {
      state.settings = {
        threshold: 5, videoLevel: true, songLevel: true,
        minWatchRatio: 0.3, minWatchSeconds: 30,
        mutedCounts: true, favFolderName: '歌'
      };
    }

    log('已启动，设置', state.settings);

    // ★ 先取一次权威元数据再开始判定。
    //   内容脚本在隔离世界里读不到页面的 __INITIAL_STATE__，
    //   分区 tid（最强的那路信号）拿不到，恒为 0；
    //   等后台把 tid/UP/简介取回来再判定，避免用残缺信息判成"非音乐"。
    try {
      const bvid = readMeta().bvid;
      if (bvid) {
        const am = await enrichMetaFromApi(bvid);
        if (am) log('已取到权威元数据 tid=' + am.tid, am.tname || '');
      }
    } catch (e) {
      log('取元数据失败，降级为纯 DOM 判定', e);
    }

    hookHistory();
    analyze();
    // 元数据可能延迟加载，重试分析
    let retry = 0;
    const retryIv = setInterval(() => {
      retry++;
      if (state.meta.title || retry > 10) {
        clearInterval(retryIv);
        if (!state.meta.title) log('警告：未能读取视频标题，可能页面结构有变化');
      } else {
        analyze();
      }
    }, 1000);

    watchForVideo();
    startTimer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
