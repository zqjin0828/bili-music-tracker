/**
 * background.js — Service Worker
 *
 * 职责：
 *  1. 维护 videoStats / songStats 的持久化（chrome.storage.local）
 *  2. 阈值判定，达标后置 notified 并回传通知
 *  3. 更新扩展图标 badge
 *  4. 提供 popup 所需的查询/修改接口
 *  5. AI 三层调度：队列（WorkBuddy 中转）+ 直连 API + 结果回填
 */

'use strict';

importScripts('src/parser.js', 'src/ai.js', 'src/ai-client.js');

const SCHEMA_VERSION = 2;

const DEFAULT_SETTINGS = {
  threshold: 5,
  videoLevel: true,
  songLevel: true,
  minWatchRatio: 0.30,
  minWatchSeconds: 30,
  notifyMode: 'card',        // card | badge | both
  includeSuspect: false,
  mutedCounts: true,
  favFolderName: '歌',
  mergeSimilarVersions: true, // Live/重制版并入原曲计数
  debugHud: true,             // 页面左下角显示累计进度（Alt+M 可切换）

  // ---- AI ----
  aiChannel: 'off',            // off | queue | direct
  aiEndpoint: '',
  aiApiKey: '',
  aiModel: 'gpt-4o-mini',
  aiConfidenceThreshold: 0.85,
  aiTimeout: 10000,
  aiApplyMode: 'auto',         // auto | suggest
  aiCacheEnabled: true
};

// ---------- 存储层 ----------

async function getStore() {
  const data = await chrome.storage.local.get([
    'schemaVersion', 'settings', 'videoStats', 'songStats',
    'pendingQueue', 'aiResults', 'aiCache', 'aiStats'
  ]);
  return {
    schemaVersion: data.schemaVersion || SCHEMA_VERSION,
    settings: Object.assign({}, DEFAULT_SETTINGS, data.settings || {}),
    videoStats: data.videoStats || {},
    songStats: data.songStats || {},
    pendingQueue: data.pendingQueue || {},
    aiResults: data.aiResults || {},
    aiCache: data.aiCache || {},
    aiStats: data.aiStats || { calls: 0, cached: 0, failed: 0, tokensIn: 0, tokensOut: 0 }
  };
}

async function setStore(patch) {
  await chrome.storage.local.set(patch);
}

// ---------- badge ----------

async function refreshBadge() {
  const { videoStats, songStats, settings } = await getStore();
  let max = 0;
  for (const v of Object.values(videoStats)) {
    if (v.excluded) continue;
    max = Math.max(max, v.playCount || 0);
  }
  for (const s of Object.values(songStats)) {
    max = Math.max(max, s.playCount || 0);
  }
  const text = max >= settings.threshold ? String(max) : (max > 0 ? String(max) : '');
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({
    color: max >= settings.threshold ? '#fb7299' : '#9499a0'
  });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }
}

// ---------- 核心：记录一次有效播放 ----------

/**
 * @param {object} payload
 *   bvid, cid, page, title, up, tid, tname, duration,
 *   watchedSeconds, musicConfidence, isMusic, autoDetected
 */
async function recordPlay(payload) {
  const { settings, videoStats, songStats } = await getStore();
  const now = Date.now();

  const videoKey = payload.page && payload.page > 1
    ? `${payload.bvid}_p${payload.page}`
    : payload.bvid;

  const isCompilation = !!payload.isCompilation;

  // ---------- 视频级 ----------
  let vEntry = videoStats[videoKey];
  if (!vEntry) {
    vEntry = {
      bvid: payload.bvid,
      cid: payload.cid || 0,
      page: payload.page || 1,
      title: payload.title || '',
      up: payload.up || '',
      tid: payload.tid || 0,
      tname: payload.tname || '',
      duration: payload.duration || 0,
      playCount: 0,
      totalWatchSeconds: 0,
      firstPlayedAt: now,
      lastPlayedAt: now,
      musicConfidence: payload.musicConfidence || 0,
      isMusic: !!payload.isMusic,
      isCompilation: isCompilation,
      notified: false,
      excluded: false,
      manualOverride: null,   // null | 'music' | 'not-music'
      ruleRevision: 0,
      appliedAiRevision: 0,
      aiTitle: ''
    };
  }

  // 标题等元数据以最新为准
  vEntry.title = payload.title || vEntry.title;
  vEntry.up = payload.up || vEntry.up;
  vEntry.tid = payload.tid || vEntry.tid;
  vEntry.tname = payload.tname || vEntry.tname;
  vEntry.duration = payload.duration || vEntry.duration;
  vEntry.cid = payload.cid || vEntry.cid;
  vEntry.isCompilation = vEntry.isCompilation || isCompilation;
  vEntry.musicConfidence = Math.max(vEntry.musicConfidence || 0, payload.musicConfidence || 0);
  vEntry.isMusic = vEntry.manualOverride === 'music' ? true
    : vEntry.manualOverride === 'not-music' ? false
    : (payload.isMusic || vEntry.isMusic);

  const effectiveMusic = vEntry.isMusic;

  // 排除 / 非音乐（且设置里不允许疑似计入）→ 不累计
  if (vEntry.excluded) {
    await setStore({ videoStats });
    return { counted: false, reason: 'excluded' };
  }
  if (!effectiveMusic && !settings.includeSuspect) {
    await setStore({ videoStats });
    return { counted: false, reason: 'not-music' };
  }

  vEntry.playCount += 1;
  vEntry.totalWatchSeconds += Math.round(payload.watchedSeconds || 0);
  vEntry.lastPlayedAt = now;
  videoStats[videoKey] = vEntry;

  // ---------- 歌曲级（跨视频合并） ----------
  // 合辑/歌单/电台不是单曲，跳过歌曲级计数，避免污染歌曲榜
  let songResult = null;
  const skipSongLevel = isCompilation || vEntry.isCompilation;
  if (settings.songLevel && !skipSongLevel && typeof payload.songKey === 'string' && payload.songKey) {
    let sEntry = songStats[payload.songKey];
    if (!sEntry) {
      sEntry = {
        songName: payload.songName || '',
        version: payload.version || '',
        artist: payload.artist || '',
        playCount: 0,
        videos: [],
        firstPlayedAt: now,
        lastPlayedAt: now,
        notified: false
      };
    }
    sEntry.playCount += 1;
    sEntry.lastPlayedAt = now;
    if (payload.songName) sEntry.songName = payload.songName;
    if (payload.version) sEntry.version = payload.version;
    if (!sEntry.videos.includes(videoKey)) sEntry.videos.push(videoKey);
    if (sEntry.videos.length > 50) sEntry.videos = sEntry.videos.slice(-50);
    songStats[payload.songKey] = sEntry;
    songResult = { key: payload.songKey, entry: sEntry };
  }

  await setStore({ videoStats, songStats });
  await refreshBadge();

  // ---------- AI 复核（三层架构的第 2/3 层） ----------
  // 乐观策略：已经用规则结果记了数，这里再异步请 AI 判定，
  // 结果回来后按需回溯修正（见 applyAiResult）
  let aiInfo = null;
  try {
    aiInfo = await maybeQueueForAi(
      payload,
      videoKey,
      vEntry,
      {
        isMusic: vEntry.isMusic,
        isCompilation: vEntry.isCompilation,
        songName: payload.songName || '',
        artist: payload.artist || '',
        version: payload.version || '',
        confidence: payload.musicConfidence || 0
      },
      settings
    );
  } catch (e) {
    console.warn('[BiliMusicTracker] AI 调度异常（已降级为纯规则）', e);
  }

  // ---------- 阈值判定 ----------
  const notifications = [];

  if (settings.videoLevel && vEntry.playCount >= settings.threshold && !vEntry.notified) {
    vEntry.notified = true;
    notifications.push({
      level: 'video',
      playCount: vEntry.playCount,
      title: vEntry.title,
      up: vEntry.up,
      songName: (payload.songName || vEntry.title),
      version: payload.version || '',
      key: videoKey,
      bvid: vEntry.bvid,
      page: vEntry.page,
      aiSongName: vEntry.aiSongName || '',
      aiVersion: vEntry.aiVersion || '',
      aiConfidence: vEntry.aiConfidence || 0,
      aiReason: vEntry.aiReason || ''
    });
  }

  if (settings.songLevel && songResult
      && songResult.entry.playCount >= settings.threshold
      && !songResult.entry.notified) {
    songResult.entry.notified = true;
    notifications.push({
      level: 'song',
      playCount: songResult.entry.playCount,
      title: songResult.entry.songName,
      up: '',
      songName: songResult.entry.songName,
      version: songResult.entry.version,
      artist: songResult.entry.artist,
      key: payload.songKey,
      bvid: (songResult.entry.videos[songResult.entry.videos.length - 1] || '').split('_p')[0]
    });
  }

  if (notifications.length) {
    await setStore({ videoStats, songStats });
    // 通知所有 bilibili 标签页，让当前页弹卡片
    const tabs = await chrome.tabs.query({ url: 'https://*.bilibili.com/*' });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'THRESHOLD_REACHED',
        notifications,
        settings
      }).catch(() => { /* 某些页无 content script，忽略 */ });
    }
  }

  return {
    counted: true,
    videoPlayCount: vEntry.playCount,
    songPlayCount: songResult ? songResult.entry.playCount : null,
    notifications,
    ai: aiInfo
  };
}

// ---------- AI：三层调度 ----------

/**
 * 记录一次播放后，决定是否需要请 AI 复核。
 * 结果写进 pendingQueue（通道 A）或直接调用（通道 B）。
 */
async function maybeQueueForAi(payload, videoKey, videoEntry, ruleResult, settings) {
  if (settings.aiChannel === 'off') return null;

  const decision = AIClient.shouldAskAi(
    { confidence: ruleResult.confidence },
    settings
  );
  if (!decision.ask) return null;

  // 缓存命中 → 直接用缓存结果，不入队
  if (settings.aiCacheEnabled && videoEntry.aiTitle) {
    const cached = await lookupCache(videoKey, videoEntry.aiTitle);
    if (cached) return { source: 'cache', result: cached };
  }

  const item = {
    key: videoKey,
    bvid: payload.bvid,
    page: payload.page || 1,
    title: payload.title || '',
    desc: (payload.desc || '').slice(0, 1000),
    up: payload.up || '',
    tid: payload.tid || 0,
    tname: payload.tname || '',
    duration: payload.duration || 0,
    part: payload.part || '',
    ruleResult: {
      isMusic: !!ruleResult.isMusic,
      isCompilation: !!ruleResult.isCompilation,
      songName: ruleResult.songName || '',
      artist: ruleResult.artist || '',
      version: ruleResult.version || '',
      confidence: ruleResult.confidence || 0
    },
    // 乐观计数时用的 songKey，回填时用于回溯修正
    optimisticSongKey: payload.songKey || '',
    ruleRevision: Number(videoEntry.ruleRevision || 0) + 1,
    addedAt: Date.now(),
    status: 'pending'
  };

  const store = await getStore();

  if (settings.aiChannel === 'queue') {
    // 通道 A：入队等待 WorkBuddy 处理
    item.ruleRevision = Number(videoEntry.ruleRevision || 0) + 1;
    store.pendingQueue[videoKey] = item;
    // 记下本次乐观计数对应的 revision，供回溯修正
    videoEntry.ruleRevision = item.ruleRevision;
    videoEntry.aiTitle = payload.title || '';
    await setStore({
      pendingQueue: store.pendingQueue,
      videoStats: store.videoStats
    });
    return { source: 'queue', queued: true };
  }

  if (settings.aiChannel === 'direct') {
    // 通道 B：立即调用
    const res = await AIClient.callDirect({
      title: item.title, desc: item.desc, up: item.up,
      tid: item.tid, tname: item.tname, duration: item.duration, part: item.part
    }, settings);

    videoEntry.aiTitle = payload.title || '';
    videoEntry.ruleRevision = item.ruleRevision;

    if (res.ok) {
      await applyAiResult(videoKey, res.result, item, settings, 'direct');
      return { source: 'direct', result: res.result };
    }
    // 失败：不入队，保持规则结果（优雅降级）
    await setStore({ videoStats: store.videoStats });
    const st = await getStore();
    st.aiStats.failed = (st.aiStats.failed || 0) + 1;
    await setStore({ aiStats: st.aiStats });
    return { source: 'direct', failed: res.error };
  }
  return null;
}

async function lookupCache(videoKey, title) {
  const store = await getStore();
  if (!store.settings.aiCacheEnabled) return null;
  const entry = store.aiCache[videoKey];
  if (!entry || !entry.result) return null;
  if (!BiliAi.isCacheValid(entry, { title })) return null;
  return entry.result;
}

/**
 * 应用一条 AI 结果：写入 aiResults / aiCache，并按 planApply 修正计数
 */
async function applyAiResult(videoKey, aiResult, item, settings, source) {
  const store = await getStore();
  const now = Date.now();

  const vEntry = store.videoStats[videoKey];
  if (!vEntry) return { ok: false, error: 'no-video-entry' };

  const revision = Number(vEntry.ruleRevision || 0);

  // 写入 aiResults + 永久缓存
  store.aiResults[videoKey] = {
    result: aiResult,
    model: settings.aiModel || '',
    at: now,
    source,
    title: item.title || '',
    appliedRevision: revision
  };
  if (settings.aiCacheEnabled) {
    store.aiCache[videoKey] = {
      result: aiResult,
      model: settings.aiModel || '',
      at: now,
      source,
      title: item.title || ''
    };
  }
  store.aiStats.calls = (store.aiStats.calls || 0) + 1;

  // 计算需要执行的修正操作
  const plan = AIClient.planApply({
    aiResult,
    ruleResult: item.ruleResult,
    oldSongKey: item.optimisticSongKey,
    oldVideoKey: videoKey,
    videoEntry: vEntry,
    settings,
    aiRevision: revision
  });

  const result = executeOps(plan.ops, store, videoKey);

  // 记录 AI 判断的元信息
  vEntry.aiStatus = 'applied';
  vEntry.aiReason = aiResult.reason || '';
  vEntry.aiConfidence = aiResult.confidence;
  vEntry.aiVersion = aiResult.version || '';
  vEntry.aiSongName = aiResult.songName || '';
  vEntry.appliedAiRevision = revision;
  vEntry.isMusic = !!aiResult.isMusic;
  vEntry.isCompilation = !!aiResult.isCompilation;
  vEntry.musicConfidence = Math.max(vEntry.musicConfidence || 0, aiResult.confidence || 0);

  await setStore({
    videoStats: store.videoStats,
    songStats: store.songStats,
    aiResults: store.aiResults,
    aiCache: store.aiCache,
    aiStats: store.aiStats
  });
  await refreshBadge();

  return { ok: true, note: plan.note, applied: result };
}

/**
 * 执行 planApply 产出的操作列表
 * 所有操作都做边界保护：计数不会变负，归零则删条目
 */
function executeOps(ops, store, videoKey) {
  const applied = [];
  const v = store.videoStats[videoKey];

  for (const op of ops) {
    switch (op.type) {
      case 'video.isMusic':
        if (v) v.isMusic = op.value;
        break;
      case 'video.isCompilation':
        if (v) v.isCompilation = op.value;
        break;
      case 'video.increment':
        if (v) v.playCount = (v.playCount || 0) + (op.by || 1);
        break;
      case 'video.decrement':
        if (v) {
          v.playCount = Math.max(0, (v.playCount || 0) - (op.by || 1));
          if (v.playCount === 0) {
            // 扣到 0 就删掉，不留空壳
            delete store.videoStats[videoKey];
          }
        }
        break;
      case 'song.increment':
        adjustSong(store, op.key, op.by || 1, op.seed, videoKey);
        break;
      case 'song.decrement':
        adjustSong(store, op.key, -(op.by || 1), null, videoKey);
        break;
      case 'song.migrate':
        if (op.drop) {
          adjustSong(store, op.from, -(op.by || 1), null, videoKey);
        } else {
          migrateSong(store, op.from, op.to, op.by || 1, op.seed, videoKey);
        }
        break;
      case 'video.markApplied':
        if (v) v.appliedAiRevision = op.revision;
        break;
      default:
        break;
    }
    applied.push(op.type);
  }
  return applied;
}

function adjustSong(store, key, delta, seed, videoKey) {
  if (!key) return;
  let s = store.songStats[key];
  if (delta > 0) {
    if (!s) {
      s = {
        songName: (seed && seed.songName) || '',
        version: (seed && seed.version) || '',
        artist: (seed && seed.artist) || '',
        playCount: 0,
        videos: [],
        firstPlayedAt: Date.now(),
        lastPlayedAt: Date.now(),
        notified: false
      };
      store.songStats[key] = s;
    }
    s.playCount += delta;
    s.lastPlayedAt = Date.now();
    if (videoKey && !s.videos.includes(videoKey)) {
      s.videos.push(videoKey);
      if (s.videos.length > 50) s.videos = s.videos.slice(-50);
    }
  } else if (s) {
    s.playCount = Math.max(0, (s.playCount || 0) + delta);
    if (videoKey) {
      const i = s.videos.indexOf(videoKey);
      // 只有该视频没有其他计数来源时才摘掉，避免误删
      if (i >= 0 && s.videos.length > s.playCount) s.videos.splice(i, 1);
    }
    if (s.playCount === 0) delete store.songStats[key];
  }
}

function migrateSong(store, from, to, by, seed, videoKey) {
  if (!from || !to || from === to) return;
  const src = store.songStats[from];
  if (!src) return;
  adjustSong(store, to, by, {
    songName: (seed && seed.songName) || src.songName,
    version: (seed && seed.version) || src.version,
    artist: (seed && seed.artist) || src.artist
  }, videoKey);
  adjustSong(store, from, -by, null, videoKey);
}

// ---------- 队列处理（通道 A 的插件侧） ----------

/**
 * 导出队列：给 WorkBuddy / 剪贴板
 */
async function exportQueue() {
  const store = await getStore();
  const items = Object.values(store.pendingQueue).filter(i => i.status === 'pending');
  return {
    exportedAt: new Date().toISOString(),
    count: items.length,
    items
  };
}

/**
 * 导入 AI 结果并应用到统计
 * @param {object} payload { results: { key: {result, note} } }
 */
async function importAiResults(payload) {
  const store = await getStore();
  const results = (payload && payload.results) || {};
  const applied = [];
  const skipped = [];

  for (const [videoKey, entry] of Object.entries(results)) {
    const item = store.pendingQueue[videoKey] || {
      key: videoKey,
      title: (entry && entry.title) || '',
      ruleResult: (store.videoStats[videoKey] && {
        isMusic: store.videoStats[videoKey].isMusic,
        isCompilation: store.videoStats[videoKey].isCompilation,
        confidence: store.videoStats[videoKey].musicConfidence || 0
      }) || {},
      optimisticSongKey: '',
      ruleRevision: (store.videoStats[videoKey] || {}).ruleRevision || 0
    };

    const aiResult = (entry && entry.result) || entry;
    if (!aiResult || typeof aiResult.isMusic !== 'boolean') {
      skipped.push({ key: videoKey, reason: 'invalid-result' });
      continue;
    }

    const r = await applyAiResult(videoKey, aiResult, item, store.settings, 'queue');
    if (r.ok) {
      applied.push(videoKey);
      delete store.pendingQueue[videoKey];
    } else {
      skipped.push({ key: videoKey, reason: r.error });
    }
  }

  await setStore({ pendingQueue: store.pendingQueue });
  return { ok: true, applied: applied.length, skipped };
}

// ---------- 视频元数据（供内容脚本判定用）----------

/**
 * ★ 为什么必须由后台去取元数据：
 *
 *   内容脚本运行在「隔离世界（isolated world）」，**看不到页面设置的
 *   `window.__INITIAL_STATE__`** —— 那是页面 JS 的全局变量，内容脚本读不到。
 *   于是 `readMeta()` 里那段解析虽然写得没错，实际永远拿不到 tid，
 *   `meta.tid` 恒为 0。
 *
 *   而「分区 tid」是判定音乐最强的一路信号（权重 3）。它一直没生效，
 *   导致大量真歌被判成非音乐 → 默认设置下不计数 → 用户「明明听了却不算」。
 *
 *   改为由 Service Worker 调 B 站公开接口取权威元数据（含 tid/tname/时长/
 *   UP/简介）。顺带拿到简介，AI 判定通道也能用上。
 */
const videoMetaCache = new Map();   // bvid -> { at, data }

async function fetchVideoMeta(bvid) {
  if (!bvid) return null;
  const hit = videoMetaCache.get(bvid);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.data;   // 6 小时内复用

  try {
    const url = 'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let json;
    try {
      const r = await fetch(url, { signal: ctrl.signal, credentials: 'include' });
      json = await r.json();
    } finally {
      clearTimeout(timer);
    }
    if (!json || json.code !== 0 || !json.data) {
      videoMetaCache.set(bvid, { at: Date.now(), data: null });
      return null;
    }
    const d = json.data;
    const data = {
      bvid,
      aid: d.aid,
      cid: d.cid,
      tid: d.tid,
      tname: d.tname || '',
      title: d.title || '',
      owner: (d.owner && d.owner.name) || '',
      duration: d.duration || 0,
      desc: String(d.desc || '').slice(0, 1000),
      pages: (d.pages || []).map(p => ({ cid: p.cid, page: p.page, part: p.part, duration: p.duration }))
    };
    videoMetaCache.set(bvid, { at: Date.now(), data });
    return data;
  } catch (e) {
    console.warn('[BiliMusicTracker] 取元数据失败', bvid, e);
    videoMetaCache.set(bvid, { at: Date.now(), data: null });
    return null;
  }
}

// ---------- 消息路由 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'RECORD_PLAY': {
          const res = await recordPlay(msg.payload || {});
          sendResponse({ ok: true, data: res });
          break;
        }

        case 'GET_STATE': {
          const store = await getStore();
          sendResponse({ ok: true, data: store });
          break;
        }

        case 'GET_SETTINGS': {
          const { settings } = await getStore();
          sendResponse({ ok: true, data: settings });
          break;
        }

        // 内容脚本取不到分区（隔离世界读不到 __INITIAL_STATE__），
        // 由后台调接口取权威元数据
        case 'GET_VIDEO_META': {
          const meta = await fetchVideoMeta(msg.bvid);
          sendResponse({ ok: !!meta, data: meta });
          break;
        }

        case 'SET_SETTINGS': {
          const store = await getStore();
          const merged = Object.assign({}, store.settings, msg.patch || {});
          await setStore({ settings: merged });
          await refreshBadge();
          sendResponse({ ok: true, data: merged });
          break;
        }

        case 'SET_OVERRIDE': {
          // popup 里人工纠偏
          const store = await getStore();
          const { key, value, level } = msg;
          if (level === 'song') {
            const s = store.songStats[key];
            if (s) {
              if (value === 'delete') delete store.songStats[key];
              else s.notified = value === 'reset-notified' ? false : s.notified;
            }
          } else {
            const v = store.videoStats[key];
            if (v) {
              if (value === 'delete') {
                delete store.videoStats[key];
              } else if (value === 'music' || value === 'not-music') {
                v.manualOverride = value;
                v.isMusic = value === 'music';
                v.notified = false;
              } else if (value === 'exclude') {
                v.excluded = true;
              } else if (value === 'include') {
                v.excluded = false;
              } else if (value === 'reset-notified') {
                v.notified = false;
              }
            }
          }
          await setStore({ videoStats: store.videoStats, songStats: store.songStats });
          await refreshBadge();
          sendResponse({ ok: true });
          break;
        }

        case 'RENAME_SONG': {
          const store = await getStore();
          const { oldKey, newName, newVersion } = msg;
          const old = store.songStats[oldKey];
          if (old) {
            const Parser = null; // background 里不加载 parser，用简版归一化
            const norm = (s) => String(s || '').replace(/[\s\-_~～·・、,，。.！!？?：:；;'"“”‘’()（）\[\]【】《》〈〉]/g, '').toLowerCase();
            const newKey = `${norm(newName)}|${newVersion || old.version || 'original'}`;
            if (newKey === oldKey) {
              old.songName = newName;
              if (newVersion) old.version = newVersion;
            } else {
              const target = store.songStats[newKey] || {
                songName: newName,
                version: newVersion || old.version || '',
                artist: old.artist || '',
                playCount: 0,
                videos: [],
                firstPlayedAt: old.firstPlayedAt,
                lastPlayedAt: old.lastPlayedAt,
                notified: false
              };
              target.playCount += old.playCount;
              target.videos = Array.from(new Set(target.videos.concat(old.videos)));
              target.lastPlayedAt = Math.max(target.lastPlayedAt, old.lastPlayedAt);
              target.songName = newName;
              if (newVersion) target.version = newVersion;
              store.songStats[newKey] = target;
              delete store.songStats[oldKey];
            }
            await setStore({ songStats: store.songStats });
            await refreshBadge();
          }
          sendResponse({ ok: true });
          break;
        }

        case 'EXPORT_DATA': {
          const store = await getStore();
          sendResponse({ ok: true, data: store });
          break;
        }

        // ---------- AI 相关 ----------

        case 'AI_EXPORT_QUEUE': {
          const payload = await exportQueue();
          sendResponse({ ok: true, data: payload });
          break;
        }

        case 'AI_IMPORT_RESULTS': {
          const r = await importAiResults(msg.data || {});
          sendResponse({ ok: true, data: r });
          break;
        }

        case 'AI_CLEAR_QUEUE': {
          const store = await getStore();
          await setStore({ pendingQueue: {} });
          sendResponse({ ok: true, cleared: Object.keys(store.pendingQueue).length });
          break;
        }

        case 'AI_TEST_CONNECTION': {
          const store = await getStore();
          const settings = Object.assign({}, store.settings, msg.patch || {});
          const res = await AIClient.callDirect({
            title: '【初音ミク】千本桜【オリジナル】', desc: '',
            up: 'テスト', tid: 30, tname: 'VOCALOID·UTAU', duration: 240
          }, settings);
          sendResponse({ ok: res.ok, data: res });
          break;
        }

        case 'AI_RECHECK': {
          // 手动重新判定某条视频：清缓存 + 重新入队/调用
          const store = await getStore();
          const { key } = msg;
          const v = store.videoStats[key];
          if (!v) { sendResponse({ ok: false, error: '视频不存在' }); break; }
          delete store.aiCache[key];
          delete store.aiResults[key];
          if (v.manualOverride) { sendResponse({ ok: false, error: '已人工标记，不再自动判定' }); break; }

          v.appliedAiRevision = -1;    // 允许重新应用
          const item = {
            key,
            bvid: v.bvid,
            page: v.page || 1,
            title: v.title || '',
            desc: '',
            up: v.up || '',
            tid: v.tid || 0,
            tname: v.tname || '',
            duration: v.duration || 0,
            ruleResult: {
              isMusic: !!v.isMusic,
              isCompilation: !!v.isCompilation,
              songName: '',
              artist: '',
              version: '',
              confidence: v.musicConfidence || 0
            },
            optimisticSongKey: '',
            ruleRevision: Number(v.ruleRevision || 0),
            addedAt: Date.now(),
            status: 'pending'
          };

          if (store.settings.aiChannel === 'queue') {
            store.pendingQueue[key] = item;
            await setStore({ pendingQueue: store.pendingQueue, videoStats: store.videoStats, aiCache: store.aiCache, aiResults: store.aiResults });
            sendResponse({ ok: true, data: { source: 'queue' } });
          } else if (store.settings.aiChannel === 'direct') {
            await setStore({ videoStats: store.videoStats, aiCache: store.aiCache, aiResults: store.aiResults });
            const res = await AIClient.callDirect({
              title: item.title, desc: '', up: item.up,
              tid: item.tid, tname: item.tname, duration: item.duration
            }, store.settings);
            if (res.ok) {
              await applyAiResult(key, res.result, item, store.settings, 'direct');
              sendResponse({ ok: true, data: { source: 'direct', result: res.result } });
            } else {
              sendResponse({ ok: false, error: res.error });
            }
          } else {
            sendResponse({ ok: false, error: 'AI 未启用' });
          }
          break;
        }

        case 'AI_GET_STATUS': {
          const store = await getStore();
          const pending = Object.values(store.pendingQueue).filter(i => i.status === 'pending');
          sendResponse({
            ok: true,
            data: {
              pendingCount: pending.length,
              cacheCount: Object.keys(store.aiCache).length,
              resultCount: Object.keys(store.aiResults).length,
              stats: store.aiStats,
              channel: store.settings.aiChannel
            }
          });
          break;
        }

        case 'IMPORT_DATA': {
          const incoming = msg.data || {};
          if (!incoming || typeof incoming !== 'object') {
            sendResponse({ ok: false, error: '数据格式不正确' });
            break;
          }
          await setStore({
            schemaVersion: SCHEMA_VERSION,
            settings: Object.assign({}, DEFAULT_SETTINGS, incoming.settings || {}),
            videoStats: incoming.videoStats || {},
            songStats: incoming.songStats || {},
            pendingQueue: incoming.pendingQueue || {},
            aiResults: incoming.aiResults || {},
            aiCache: incoming.aiCache || {},
            aiStats: incoming.aiStats || { calls: 0, cached: 0, failed: 0, tokensIn: 0, tokensOut: 0 }
          });
          await refreshBadge();
          sendResponse({ ok: true });
          break;
        }

        case 'CLEAR_ALL': {
          await setStore({
            videoStats: {},
            songStats: {}
          });
          await refreshBadge();
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'unknown message: ' + (msg && msg.type) });
      }
    } catch (e) {
      console.error('[BiliMusicTracker] background error:', e);
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // 异步响应
});

// ---------- 安装/更新 ----------

chrome.runtime.onInstalled.addListener(async (details) => {
  const store = await getStore();
  const patch = {};
  if (!store.settings.threshold) patch.settings = DEFAULT_SETTINGS;
  if (!store.schemaVersion) patch.schemaVersion = SCHEMA_VERSION;
  if (Object.keys(patch).length) await setStore(patch);
  await refreshBadge();
  if (details.reason === 'install') {
    console.log('[BiliMusicTracker] 安装完成，默认阈值 5 次');
  }
});

// Service Worker 唤醒时同步一次 badge
chrome.runtime.onStartup.addListener(refreshBadge);
refreshBadge();
