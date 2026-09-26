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

importScripts('src/parser.js', 'src/ai.js', 'src/ai-client.js', 'src/fav-index.js');

const SCHEMA_VERSION = 3;

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

  // ---- 已收藏检测（v1.3 新增）----
  skipFaved: true,            // ★ 已在收藏夹的视频不再计数、不再提醒
  favIndexRefreshMinutes: 30, // 索引自动刷新间隔（分钟）
  favIndexMaxAgeHours: 24,    // 索引超过此时长视为过期，判定时降级用 DOM
  favIndexWeeklyEnabled: true,// ★ 每周强制全量重建一次索引（防长期漂移）
  favOverflowEnabled: true,   // ★ 「歌」满了自动切到「歌2」「歌3」…

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
    'pendingQueue', 'aiResults', 'aiCache', 'aiStats',
    'favIndex', 'favFolders', 'favIndexes', 'favIndexWeeklyAt'
  ]);
  return {
    schemaVersion: data.schemaVersion || SCHEMA_VERSION,
    settings: Object.assign({}, DEFAULT_SETTINGS, data.settings || {}),
    videoStats: data.videoStats || {},
    songStats: data.songStats || {},
    pendingQueue: data.pendingQueue || {},
    aiResults: data.aiResults || {},
    aiCache: data.aiCache || {},
    aiStats: data.aiStats || { calls: 0, cached: 0, failed: 0, tokensIn: 0, tokensOut: 0 },
    // { mediaId, folderTitle, bvids: [], aids: [], count, fetchedAt, hasMore }
    favIndex: data.favIndex || null,
    // ★ 多夹索引：主夹 + 溢出夹（「歌2」「歌3」…）
    //   { [mediaId]: { mediaId, folderTitle, bvids, aids, count, total, hasMore, fetchedAt } }
    favIndexes: data.favIndexes || null,
    // 每周强制重建的时间戳
    favIndexWeeklyAt: data.favIndexWeeklyAt || 0,
    // 收藏夹列表缓存（供 popup 选择目标夹）
    favFolders: data.favFolders || null
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

// ---------- 收藏夹索引（v1.3）----------

/**
 * 收藏夹索引的意义：
 *
 *   Service Worker 里可以带 Cookie 跨域 fetch B 站接口（有 host_permissions），
 *   所以由后台统一拉取，内容脚本只管读结果。
 *
 *   ★ 为什么用「拉全量建索引」而不是「按 bvid 查」：
 *     接口 /x/v3/fav/resource/ids?bvid=xxx 需要 WBI 签名，未签名实测返回 -400。
 *     而 /x/v3/fav/resource/list?media_id=xx 不需要签名，分页拉全量即可。
 *     「歌」收藏夹 276 条 → 14 页（ps=20），成本可接受，且判定时零延迟。
 */

const FAV_API = 'https://api.bilibili.com/x/v3/fav';

async function favApiGet(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      credentials: 'include',
      headers: { 'Accept': 'application/json, text/plain, */*' }
    });
    const j = await r.json();
    return j;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取当前账号的所有收藏夹列表
 * @returns {Promise<{ok: boolean, folders: Array, error?: string}>}
 */
async function fetchFavFolders() {
  const store = await getStore();
  const mid = await getSelfMid();
  const url = `${FAV_API}/folder/created/list-all?up_mid=${mid || ''}`;

  try {
    const j = await favApiGet(url);
    if (!j || j.code !== 0 || !j.data || !j.data.list) {
      return { ok: false, folders: [], error: (j && j.message) || 'bad-response' };
    }
    const folders = BiliFavIndex.normalizeFolders(j.data);
    await setStore({ favFolders: { list: folders, fetchedAt: Date.now() } });
    return { ok: true, folders };
  } catch (e) {
    return { ok: false, folders: [], error: String(e && e.message || e) };
  }
}

let selfMidCache = null;
async function getSelfMid() {
  if (selfMidCache) return selfMidCache;
  try {
    const j = await favApiGet('https://api.bilibili.com/x/web-interface/nav');
    if (j && j.code === 0 && j.data && j.data.mid) {
      selfMidCache = j.data.mid;
      return selfMidCache;
    }
  } catch (e) { /* 未登录或失败 */ }
  return '';
}

/**
 * 拉单个收藏夹的全量 BV（分页）
 * @returns {Promise<{ok, bvids, aids, total, hasMore, error}>}
 */
async function fetchFolderAllBvids(mediaId) {
  const bvids = [];
  const aids = [];
  const MAX_PAGES = 80;
  const PS = 20;
  let hasMore = false;
  let total = 0;

  for (let pn = 1; pn <= MAX_PAGES; pn++) {
    const u = `${FAV_API}/resource/list?media_id=${mediaId}&pn=${pn}&ps=${PS}` +
      '&order=mtime&type=0&tid=0&platform=web';
    let j;
    try {
      j = await favApiGet(u);
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), bvids, aids, total, hasMore };
    }
    if (!j || j.code !== 0 || !j.data || !Array.isArray(j.data.medias)) {
      return { ok: false, error: (j && j.message) || 'bad-response', bvids, aids, total, hasMore };
    }
    if (!j.data.medias.length) break;

    for (const m of j.data.medias) {
      if (m.bvid) bvids.push(m.bvid);
      if (m.id) aids.push(String(m.id));
    }
    total += j.data.medias.length;
    hasMore = !!j.data.has_more;
    if (!hasMore) break;
    await new Promise(r => setTimeout(r, 160));   // 限速防风控
  }

  return {
    ok: true,
    bvids: Array.from(new Set(bvids)),
    aids: Array.from(new Set(aids)),
    total,
    hasMore
  };
}

/**
 * ★ 构建/刷新收藏夹索引（v1.3.1：支持多夹滚动 + 容量检测）
 *
 * 索引范围 = 主夹（「歌」）+ 所有溢出夹（「歌2」「歌3」…）。
 * 这样「歌」满了之后用户新建「歌2」，插件会自动把它也纳入索引与收藏目标。
 *
 * @param {object} opts { folderName, force }
 * @returns {Promise<object>} { ok, mediaId, folderTitle, count, error, cap }
 */
async function refreshFavIndex(opts) {
  const o = opts || {};
  const store = await getStore();
  const wanted = o.folderName || store.settings.favFolderName || '歌';

  // 1) 拿收藏夹列表（优先用缓存，除非 force）
  let folders = (store.favFolders && store.favFolders.list) || [];
  if (!folders.length || o.force) {
    const r = await fetchFavFolders();
    if (!r.ok) return { ok: false, error: r.error };
    folders = r.folders;
  }

  // 2) 选目标夹链：主夹 + 溢出夹（排除「歌？」这类干扰项）
  const allowOverflow = store.settings.favOverflowEnabled !== false;
  let picked;
  if (allowOverflow) {
    picked = BiliFavIndex.pickUsableFolder(folders, wanted, {});
  } else {
    const single = BiliFavIndex.pickFolder(folders, wanted);
    picked = { folder: single.folder, reason: single.reason, chain: single.folder ? [single.folder] : [], full: [] };
  }
  if (!picked.folder || !picked.chain.length) {
    return { ok: false, error: 'folder-not-found', wanted, candidates: folders.map(f => f.title) };
  }

  // 3) 逐个夹拉全量并建索引
  const indexes = {};
  const summary = [];
  let primary = null;

  for (const f of picked.chain) {
    const r = await fetchFolderAllBvids(f.id);
    if (!r.ok) {
      summary.push({ id: f.id, title: f.title, error: r.error });
      continue;
    }
    const ix = {
      mediaId: f.id,
      folderTitle: f.title,
      matchReason: picked.reason,
      bvids: r.bvids,
      aids: r.aids,
      count: r.bvids.length,
      total: r.total,
      hasMore: r.hasMore,
      fetchedAt: Date.now()
    };
    indexes[f.id] = ix;
    if (!primary) primary = ix;

    const cap = BiliFavIndex.capStatus(f.media_count || r.bvids.length, f);
    summary.push({
      id: f.id, title: f.title, count: ix.count,
      cap: cap.cap, remain: cap.remain, level: cap.level, ratio: cap.ratio
    });
  }

  if (!primary) {
    return { ok: false, error: 'fetch-failed', detail: summary };
  }

  // 4) 落盘：favIndex 为主夹（向后兼容），favIndexes 为全量
  const patch = { favIndex: primary, favIndexes: indexes };
  if (o.weekly) patch.favIndexWeeklyAt = Date.now();
  await setStore(patch);
  await refreshBadge();

  const primarySummary = summary.find(s => s.id === primary.mediaId) || null;

  return {
    ok: true,
    mediaId: primary.mediaId,
    folderTitle: primary.folderTitle,
    matchReason: picked.reason,
    count: primary.count,
    total: primary.total,
    hasMore: primary.hasMore,
    // ★ 新增：容量与多夹信息
    cap: primarySummary,
    folders: summary,
    chainLen: picked.chain.length,
    allFull: picked.reason === 'all-full'
  };
}

/**
 * ★ 判断索引是否需要刷新（含「每周强制全量重建」）
 *
 * 为什么需要每周强刷：
 *   增量刷新只知道「加了什么」，如果用户在 B 站网页端手动删了收藏，
 *   我们无从感知（没有增量接口），索引会永久偏大 → 已删的歌被判成
 *   「已收藏」而不再计数。所以每周做一次全量重建，纠正漂移。
 */
function needsFavRefresh(store) {
  const s = store.settings;
  const ix = store.favIndex;

  // 从未建过 → 必刷
  if (!ix || !ix.fetchedAt) return { need: true, reason: 'no-index' };

  // 每周强制全量重建
  if (s.favIndexWeeklyEnabled !== false) {
    const weeklyAt = store.favIndexWeeklyAt || 0;
    const WEEK = 7 * 24 * 3600 * 1000;
    if (!weeklyAt || Date.now() - weeklyAt > WEEK) {
      return { need: true, reason: 'weekly', weeklyAt };
    }
  }

  // 超过 maxAge 小时 → 刷
  if (isIndexStale(ix, s.favIndexMaxAgeHours)) return { need: true, reason: 'stale' };

  return { need: false, reason: 'fresh' };
}

/** 索引是否过期 */
function isIndexStale(index, maxAgeHours) {
  if (!index || !index.fetchedAt) return true;
  const max = (maxAgeHours || 24) * 3600 * 1000;
  return (Date.now() - index.fetchedAt) > max;
}

/** 把某个 bvid 加进本地索引（用户刚收藏时调用，避免等下次全量刷新）*/
async function addBvidToIndex(bvid) {
  if (!bvid) return;
  const store = await getStore();
  const ix = store.favIndex || {
    mediaId: null, folderTitle: store.settings.favFolderName || '歌',
    bvids: [], aids: [], count: 0, total: 0, hasMore: false, fetchedAt: Date.now()
  };
  ix.bvids = Array.isArray(ix.bvids) ? ix.bvids : [];
  if (ix.bvids.indexOf(bvid) < 0) {
    ix.bvids.push(bvid);
    ix.count = ix.bvids.length;
    ix.lastManualAddAt = Date.now();
    await setStore({ favIndex: ix });
  }
}

/** 从本地索引里移除某个 bvid（用户取消收藏时调用）*/
async function removeBvidFromIndex(bvid) {
  if (!bvid) return;
  const store = await getStore();
  const ix = store.favIndex;
  if (!ix || !Array.isArray(ix.bvids)) return;
  const i = ix.bvids.indexOf(bvid);
  if (i >= 0) {
    ix.bvids.splice(i, 1);
    ix.count = ix.bvids.length;
    ix.lastManualRemoveAt = Date.now();
    await setStore({ favIndex: ix });
  }
}

/**
 * 后台定时刷新（基于 alarm，Service Worker 会被唤醒）
 *
 * 两个 alarm：
 *   · favIndexRefresh   —— 常规增量刷新（默认每 30 分钟）
 *   · favIndexWeekly    —— ★ 每周全量重建（纠正「用户在网页端手删收藏」造成的漂移）
 *
 * chrome.alarms 的最小周期是 1 分钟；周级周期用 periodInMinutes = 7*24*60。
 */
async function scheduleFavIndexRefresh() {
  const store = await getStore();
  const mins = Math.max(5, Number(store.settings.favIndexRefreshMinutes) || 30);
  try {
    await chrome.alarms.clear('favIndexRefresh');
    await chrome.alarms.create('favIndexRefresh', { periodInMinutes: mins });

    // ★ 每周全量重建
    if (store.settings.favIndexWeeklyEnabled !== false) {
      await chrome.alarms.clear('favIndexWeekly');
      await chrome.alarms.create('favIndexWeekly', {
        periodInMinutes: 7 * 24 * 60,     // 7 天
        delayInMinutes: 60                 // 装完先等 1 小时，别和首次建索引撞车
      });
    }
  } catch (e) {
    // alarms 权限未声明时静默降级（改用 onStartup + 消息触发）
    console.warn('[BiliMusicTracker] alarms 不可用，索引仅靠手动/启动刷新', e);
  }
}

// ---------- 记录一次有效播放（核心：reportPlay 之上的收口）----------

/**
 * @param {object} payload
 *   bvid, cid, page, title, up, tid, tname, duration,
 *   watchedSeconds, musicConfidence, isMusic, autoDetected
 */
async function recordPlay(payload) {
  const { settings, videoStats, songStats, favIndex, favIndexes } = await getStore();
  const now = Date.now();

  const videoKey = payload.page && payload.page > 1
    ? `${payload.bvid}_p${payload.page}`
    : payload.bvid;

  const isCompilation = !!payload.isCompilation;

  // ---------- ★ 已收藏检测（v1.3 核心 / v1.3.1 多夹）----------
  // 若该视频已在**任意目标收藏夹**（「歌」或溢出夹「歌2」「歌3」…）里，
  // 直接不计、不提醒。
  // 索引可能过期，所以还叠加 DOM（内容脚本传来的实时状态）双路判定。
  const indexBvids = new Set();
  const seenIx = new Set();
  const pushIx = (ix) => {
    if (!ix || !Array.isArray(ix.bvids)) return;
    if (seenIx.has(ix.mediaId)) return;
    seenIx.add(ix.mediaId);
    for (const b of ix.bvids) indexBvids.add(b);
  };
  pushIx(favIndex);
  if (favIndexes && typeof favIndexes === 'object') {
    for (const k of Object.keys(favIndexes)) pushIx(favIndexes[k]);
  }
  // 兼容内容脚本透传的索引
  if (Array.isArray(payload.favIndexes)) for (const ix of payload.favIndexes) pushIx(ix);

  const inIndex = indexBvids.has(payload.bvid);
  const inDom = !!payload.domFaved;
  const alreadyFaved = inIndex || inDom;

  // 记录判定来源，便于排查
  const favedSource = inIndex ? 'index' : (inDom ? 'dom' : 'none');

  if (settings.skipFaved && alreadyFaved) {
    // 仍然更新视频条目的元信息与「已知收藏」标记，但不加计数
    let vEntrySkip = videoStats[videoKey];
    if (!vEntrySkip) {
      vEntrySkip = {
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
        manualOverride: null,
        ruleRevision: 0,
        appliedAiRevision: 0,
        aiTitle: ''
      };
    }
    vEntrySkip.title = payload.title || vEntrySkip.title;
    vEntrySkip.up = payload.up || vEntrySkip.up;
    vEntrySkip.cid = payload.cid || vEntrySkip.cid;
    vEntrySkip.duration = payload.duration || vEntrySkip.duration;
    vEntrySkip.faved = true;
    vEntrySkip.favedSource = favedSource;
    vEntrySkip.favedCheckedAt = now;
    // 已收藏 → 视为已提醒过，避免后续再弹
    vEntrySkip.notified = true;
    videoStats[videoKey] = vEntrySkip;
    await setStore({ videoStats });
    return {
      counted: false,
      reason: 'already-faved',
      favedSource,
      videoPlayCount: vEntrySkip.playCount
    };
  }

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
      aiTitle: '',
      faved: false,
      favedSource: 'none'
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
  // 记录本次的收藏检测结果（false 也要记，便于 popup 展示「未收藏」）
  vEntry.faved = vEntry.faved || false;
  vEntry.favedSource = favedSource;
  vEntry.favedCheckedAt = now;

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
          // ★ 刷新间隔/每周重建可能被改了 → 重排 alarm
          const p = msg.patch || {};
          if ('favIndexRefreshMinutes' in p || 'favIndexWeeklyEnabled' in p) {
            await scheduleFavIndexRefresh();
          }
          // ★ 收藏夹名/溢出开关变了 → 立刻按新配置重建索引
          if ('favFolderName' in p || 'favOverflowEnabled' in p) {
            refreshFavIndex({ force: true }).catch(() => {});
          }
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
              } else if (value === 'mark-faved') {
                // ★ 手动标记为「已收藏」：立刻停止计数并写进索引
                v.faved = true;
                v.favedSource = 'manual';
                v.favedCheckedAt = Date.now();
                v.notified = true;
                await addBvidToIndex(v.bvid);
              } else if (value === 'mark-not-faved') {
                v.faved = false;
                v.favedSource = 'manual';
                v.favedCheckedAt = Date.now();
                await removeBvidFromIndex(v.bvid);
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

        // ---------- 收藏夹索引（v1.3）----------

        // 拉取收藏夹某一页（内容脚本按需分页）
        case 'FAV_FETCH_PAGE': {
          const { mediaId, pn, ps } = msg;
          const u = `${FAV_API}/resource/list?media_id=${mediaId}&pn=${pn || 1}&ps=${ps || 20}` +
            '&order=mtime&type=0&tid=0&platform=web';
          try {
            const j = await favApiGet(u);
            if (!j || j.code !== 0 || !j.data) {
              sendResponse({ ok: false, error: (j && j.message) || 'bad-response' });
              break;
            }
            sendResponse({
              ok: true,
              data: {
                list: (j.data.medias || []).map(m => ({ bvid: m.bvid, aid: m.id, title: m.title })),
                has_more: !!j.data.has_more,
                info: j.data.info ? { id: j.data.info.id, title: j.data.info.title, count: j.data.info.media_count } : null
              }
            });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
          }
          break;
        }

        // 收藏夹列表
        case 'FAV_GET_FOLDERS': {
          const force = !!msg.force;
          const store = await getStore();
          let folders = (store.favFolders && store.favFolders.list) || [];
          if (!folders.length || force) {
            const r = await fetchFavFolders();
            if (!r.ok) { sendResponse({ ok: false, error: r.error, data: { list: folders } }); break; }
            folders = r.folders;
          }
          const picked = BiliFavIndex.pickFolder(folders, store.settings.favFolderName);
          sendResponse({
            ok: true,
            data: {
              list: folders,
              picked: picked.folder ? { id: picked.folder.id, title: picked.folder.title, reason: picked.reason } : null
            }
          });
          break;
        }

        // 手动刷新索引
        case 'FAV_REFRESH_INDEX': {
          const r = await refreshFavIndex({ force: !!msg.force, folderName: msg.folderName });
          sendResponse({ ok: !!r.ok, data: r, error: r.error });
          break;
        }

        // 查询索引状态
        case 'FAV_GET_STATUS': {
          const store = await getStore();
          const ix = store.favIndex;
          const folders = (store.favFolders && store.favFolders.list) || [];
          const base = store.settings.favFolderName || '歌';

          // ★ 容量：以「已索引的夹链」逐个算，主夹单独给出
          const chain = [];
          if (store.favIndexes && typeof store.favIndexes === 'object') {
            for (const k of Object.keys(store.favIndexes)) {
              const one = store.favIndexes[k];
              const meta = folders.find(f => f.id === one.mediaId) || { title: one.folderTitle, media_count: one.count };
              const cs = BiliFavIndex.capStatus(one.count, meta);
              chain.push({
                mediaId: one.mediaId, title: one.folderTitle, count: one.count,
                cap: cs.cap, remain: cs.remain, ratio: cs.ratio, level: cs.level
              });
            }
          }

          const primaryCap = ix ? BiliFavIndex.capStatus(ix.count, { title: ix.folderTitle, media_count: ix.count }) : null;
          const need = needsFavRefresh(store);

          sendResponse({
            ok: true,
            data: {
              hasIndex: !!ix,
              mediaId: ix ? ix.mediaId : null,
              folderTitle: ix ? ix.folderTitle : null,
              count: ix ? ix.count : 0,
              fetchedAt: ix ? ix.fetchedAt : null,
              weeklyAt: store.favIndexWeeklyAt || 0,
              stale: isIndexStale(ix, store.settings.favIndexMaxAgeHours),
              needRefresh: need.need,
              needReason: need.reason,
              skipFaved: store.settings.skipFaved,
              refreshMinutes: store.settings.favIndexRefreshMinutes,
              weeklyEnabled: store.settings.favIndexWeeklyEnabled !== false,
              overflowEnabled: store.settings.favOverflowEnabled !== false,
              // ★ 容量信息
              cap: primaryCap,
              chainCount: chain.length,
              chain,
              // 下一个溢出夹的推荐名
              nextName: BiliFavIndex.nextOverflowName(folders, base),
              folders
            }
          });
          break;
        }

        // 取自己的 mid（内容脚本拼收藏夹页 URL 用）
        case 'FAV_GET_SELF_MID': {
          const mid = await getSelfMid();
          sendResponse({ ok: !!mid, data: { mid: mid || '' } });
          break;
        }

        // ★ 内容脚本确认用户刚收藏成功 → 立刻写进本地索引
        case 'FAV_MARK_ADDED': {
          const bvid = msg.bvid;
          if (!bvid) { sendResponse({ ok: false, error: 'no-bvid' }); break; }
          const store = await getStore();

          // 优先写进指定的溢出夹索引，否则写主夹
          const targetId = msg.mediaId || (store.favIndex && store.favIndex.mediaId);
          const indexes = Object.assign({}, store.favIndexes || {});
          let wrote = false;
          if (targetId && indexes[targetId]) {
            const one = Object.assign({}, indexes[targetId]);
            one.bvids = Array.isArray(one.bvids) ? one.bvids.slice() : [];
            if (one.bvids.indexOf(bvid) < 0) {
              one.bvids.push(bvid);
              one.count = one.bvids.length;
              one.lastManualAddAt = Date.now();
            }
            indexes[targetId] = one;
            wrote = true;
          }

          const patch = {};
          if (wrote) patch.favIndexes = indexes;
          // 主索引也要同步（它决定 badge 与旧字段）
          const ix = store.favIndex ? Object.assign({}, store.favIndex) : null;
          if (ix) {
            ix.bvids = Array.isArray(ix.bvids) ? ix.bvids.slice() : [];
            if (ix.bvids.indexOf(bvid) < 0) {
              ix.bvids.push(bvid);
              ix.count = ix.bvids.length;
              ix.lastManualAddAt = Date.now();
            }
            patch.favIndex = ix;
          }
          if (Object.keys(patch).length) await setStore(patch);

          // 顺带把该视频条目标成已收藏
          const videoStats = store.videoStats;
          if (videoStats[bvid]) {
            videoStats[bvid].faved = true;
            videoStats[bvid].favedSource = 'manual-add';
            videoStats[bvid].favedCheckedAt = Date.now();
            videoStats[bvid].notified = true;
            await setStore({ videoStats });
          }
          await refreshBadge();
          sendResponse({ ok: true, data: { bvid, wroteTo: targetId || null, wrote } });
          break;
        }

        // ★ 估算目标收藏夹的容量状态（建夹前用）
        case 'FAV_CAP_CHECK': {
          const store = await getStore();
          const folders = (store.favFolders && store.favFolders.list) || [];
          const base = store.settings.favFolderName || '歌';
          const picked = BiliFavIndex.pickUsableFolder(folders, base, {});
          sendResponse({
            ok: true,
            data: {
              base,
              chain: picked.chain,
              full: picked.full,
              reason: picked.reason,
              allFull: picked.reason === 'all-full',
              nextName: BiliFavIndex.nextOverflowName(folders, base),
              customCap: BiliFavIndex.FOLDER_CAP.CUSTOM
            }
          });
          break;
        }

        // ★ 新建收藏夹（用于「歌」满了之后开「歌2」）
        case 'FAV_CREATE_FOLDER': {
          const title = String(msg.title || '').trim();
          if (!title) { sendResponse({ ok: false, error: 'empty-title' }); break; }
          const privacy = Number(msg.privacy) || 0;   // 0=公开 1=私密
          try {
            const csrf = await (async () => {
              try {
                const c = await chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'bili_jct' });
                return (c && c.value) || '';
              } catch (e) { return ''; }
            })();
            if (!csrf) { sendResponse({ ok: false, error: 'no-csrf' }); break; }

            const body = new URLSearchParams();
            body.set('title', title);
            body.set('privacy', String(privacy));
            body.set('csrf', csrf);

            const r = await fetch(`${FAV_API}/folder/add`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: body.toString()
            });
            const j = await r.json();
            if (!j || j.code !== 0) {
              sendResponse({ ok: false, error: (j && j.message) || 'create-failed', code: j && j.code });
              break;
            }
            // 建完立刻刷新收藏夹列表缓存
            const fr = await fetchFavFolders();
            const newId = j.data && (j.data.id || j.data.media_id);
            if (msg.refreshIndex !== false) {
              refreshFavIndex({ force: true }).catch(() => {});
            }
            sendResponse({
              ok: true,
              data: {
                id: newId,
                title,
                folders: fr.ok ? fr.folders : []
              }
            });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
          }
          break;
        }

        // 查询单个 bvid 是否在索引里（供 popup / 内容脚本即时校验）
        case 'FAV_CHECK_BVID': {
          const store = await getStore();
          const bvid = msg.bvid;
          const ix = store.favIndex;
          const stale = isIndexStale(ix, store.settings.favIndexMaxAgeHours);

          // ★ 多夹：在任意目标夹里命中即视为已收藏
          let hitTitle = '';
          let inIdx = !!(ix && Array.isArray(ix.bvids) && ix.bvids.indexOf(bvid) >= 0);
          if (inIdx) hitTitle = ix.folderTitle;
          if (!inIdx && store.favIndexes && typeof store.favIndexes === 'object') {
            for (const k of Object.keys(store.favIndexes)) {
              const one = store.favIndexes[k];
              if (one && Array.isArray(one.bvids) && one.bvids.indexOf(bvid) >= 0) {
                inIdx = true; hitTitle = one.folderTitle; break;
              }
            }
          }

          sendResponse({
            ok: true,
            data: {
              bvid,
              faved: inIdx,
              source: inIdx ? 'index' : 'none',
              folderTitle: hitTitle || null,
              indexCount: ix ? ix.count : 0,
              stale
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
  if (!store.schemaVersion || store.schemaVersion < SCHEMA_VERSION) {
    patch.schemaVersion = SCHEMA_VERSION;
    // v2 → v3：给已有视频条目补 faved 字段（默认 false，待下次检测刷新）
    for (const v of Object.values(store.videoStats)) {
      if (typeof v.faved === 'undefined') {
        v.faved = false;
        v.favedSource = 'migrated';
      }
    }
    patch.videoStats = store.videoStats;
  }
  if (Object.keys(patch).length) await setStore(patch);
  await refreshBadge();
  await scheduleFavIndexRefresh();

  // 安装/更新后异步建一次索引（不阻塞）
  refreshFavIndex({ force: false }).catch(e => {
    console.warn('[BiliMusicTracker] 初始索引构建失败（稍后可手动刷新）', e);
  });

  if (details.reason === 'install') {
    console.log('[BiliMusicTracker] 安装完成，默认阈值 5 次');
  }
});

// 定时刷新收藏夹索引
try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm) return;
    if (alarm.name === 'favIndexRefresh') {
      refreshFavIndex({ force: false }).catch(() => {});
    } else if (alarm.name === 'favIndexWeekly') {
      // ★ 每周全量重建：force=true 重新拉收藏夹列表，并记录 weeklyAt
      console.log('[BiliMusicTracker] 每周索引全量重建开始');
      refreshFavIndex({ force: true, weekly: true }).catch(() => {});
    }
  });
} catch (e) { /* alarms 权限缺失时忽略 */ }

// Service Worker 唤醒时同步一次 badge + 检查索引新鲜度
chrome.runtime.onStartup.addListener(async () => {
  await refreshBadge();
  const store = await getStore();
  const need = needsFavRefresh(store);
  if (need.need) {
    refreshFavIndex({ force: need.reason === 'weekly', weekly: need.reason === 'weekly' }).catch(() => {});
  }
});

refreshBadge();
// Service Worker 冷启动时，若需要刷新则补建
(async () => {
  try {
    const store = await getStore();
    const need = needsFavRefresh(store);
    if (need.need) {
      refreshFavIndex({ force: need.reason === 'weekly', weekly: need.reason === 'weekly' }).catch(() => {});
    }
  } catch (e) { /* ignore */ }
})();
