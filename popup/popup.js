/**
 * popup.js — 扩展弹窗逻辑
 */

'use strict';

let store = null;
let currentTab = 'songs';
let threshold = 5;
let favStatus = null;   // { hasIndex, mediaId, folderTitle, count, fetchedAt, stale, skipFaved }

// ---------- 工具 ----------

const $ = (id) => document.getElementById(id);

function favNameOf() {
  return (store && store.settings && store.settings.favFolderName) || '歌';
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

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  if (sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function toast(text) {
  let el = document.querySelector('.saved-tip');
  if (!el) {
    el = document.createElement('div');
    el.className = 'saved-tip';
    document.body.appendChild(el);
  }
  el.textContent = text;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1800);
}

// ---------- 数据加载 ----------

async function load() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (res && res.ok) {
    store = res.data;
    threshold = store.settings.threshold || 5;
    // ★ v1.3：同时拉索引状态
    try {
      const fr = await chrome.runtime.sendMessage({ type: 'FAV_GET_STATUS' });
      if (fr && fr.ok) favStatus = fr.data;
    } catch (e) { favStatus = null; }
    render();
    renderFavBar();
  }
}

// ---------- 收藏夹索引状态条 ----------

function renderFavBar() {
  const el = $('favBar');
  if (!el) return;
  const s = favStatus;
  const name = favNameOf();

  if (!s) {
    el.innerHTML = `<div class="favbar-line"><span class="favbar-text">收藏夹索引：未初始化</span>
      <button class="mini-btn" data-act="favRefresh">建立索引</button></div>`;
    return;
  }
  if (!s.hasIndex) {
    el.innerHTML = `<div class="favbar-line"><span class="favbar-text">收藏夹索引：未建立（无法判断是否已收藏）</span>
      <button class="mini-btn" data-act="favRefresh">建立索引</button></div>`;
    return;
  }

  const when = s.fetchedAt ? fmtTime(s.fetchedAt) : '';
  const staleTag = s.stale ? ' <span class="badge suspect">已过期</span>' : '';
  const weeklyTag = s.weeklyEnabled
    ? `<span class="favbar-sub">每周全量重建 · 上次 ${s.weeklyAt ? fmtTime(s.weeklyAt) : '未做过'}</span>`
    : '<span class="favbar-sub">每周重建已关闭</span>';

  // ★ 容量条：主夹 + 各溢出夹
  let capHtml = '';
  const cap = s.cap;
  if (cap) {
    const pct = Math.min(100, Math.round(cap.ratio * 100));
    const cls = cap.level === 'full' ? 'danger' : cap.level === 'warn' ? 'warn' : '';
    const tip = cap.level === 'full'
      ? `已满！新建「${escapeHtml(s.nextName || name + '2')}」继续收藏`
      : cap.level === 'warn'
        ? `快满了，仅剩 ${cap.remain} 首`
        : `还可再收 ${cap.remain} 首`;
    capHtml = `
      <div class="cap-wrap ${cls}">
        <div class="cap-bar"><div class="cap-fill" style="width:${pct}%"></div></div>
        <div class="cap-text">容量 ${cap.count} / ${cap.cap} · ${tip}</div>
      </div>`;
  }

  // 溢出夹链
  let chainHtml = '';
  if (Array.isArray(s.chain) && s.chain.length > 1) {
    chainHtml = `<div class="favbar-sub">收藏夹链：${s.chain.map(f => {
      const tag = f.level === 'full' ? '（满）' : '';
      return `「${escapeHtml(f.title)}」${f.count}${tag}`;
    }).join(' → ')}</div>`;
  }

  el.innerHTML = `
    <div class="favbar-line">
      <span class="favbar-text">
        「${escapeHtml(s.folderTitle || name)}」已索引 <b>${s.count}</b> 首 · ${when}${staleTag}
        ${s.skipFaved ? '' : '<span class="badge suspect">未启用跳过</span>'}
      </span>
      <button class="mini-btn" data-act="favRefresh">刷新</button>
    </div>
    ${capHtml}
    ${chainHtml}
    <div class="favbar-line">
      ${weeklyTag}
      <button class="mini-btn" data-act="favNewFolder" data-name="${escapeHtml(s.nextName || (name + '2'))}">新建「${escapeHtml(s.nextName || (name + '2'))}」</button>
    </div>
  `;
}

// ---------- 渲染 ----------

function render() {
  if (!store) return;
  const { videoStats, songStats } = store;

  const videos = Object.entries(videoStats)
    .map(([k, v]) => Object.assign({ key: k }, v));
  const songs = Object.entries(songStats)
    .map(([k, v]) => Object.assign({ key: k }, v));

  // 统计
  const reachedCount =
    videos.filter(v => v.playCount >= threshold).length +
    songs.filter(s => s.playCount >= threshold).length;

  $('statVideos').textContent = videos.length;
  $('statSongs').textContent = songs.length;
  $('statReached').textContent = reachedCount;

  // 列表
  const list = currentTab === 'songs' ? songs : videos;
  list.sort((a, b) => (b.playCount - a.playCount) || (b.lastPlayedAt - a.lastPlayedAt));

  const listEl = $('list');
  const emptyEl = $('empty');

  if (!list.length) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    $('hint').textContent = '提示：需要在 B 站视频页实际播放并累计有效收听时长才会记录。';
    return;
  }
  emptyEl.classList.add('hidden');

  listEl.innerHTML = list.slice(0, 60).map((item, i) => {
    const isSong = currentTab === 'songs';
    const reached = item.playCount >= threshold;
    const progress = Math.min(100, Math.round((item.playCount / threshold) * 100));
    const rankCls = i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '';

    const title = isSong
      ? escapeHtml(truncate(item.songName || '(未命名)', 30))
      : escapeHtml(truncate(item.title || '(无标题)', 30));

    const badges = [];
    if (isSong && item.version) badges.push(`<span class="badge ver">${escapeHtml(item.version)}</span>`);
    if (isSong && item.version && item.version !== 'original' && item.version !== '原唱') {
      badges.push('<span class="badge ai" title="该版本单独计数">独立版本</span>');
    }
    if (isSong && item.artist) badges.push(`<span class="badge ver">${escapeHtml(truncate(item.artist, 10))}</span>`);
    if (reached) badges.push('<span class="badge reached">已达标</span>');
    // ★ v1.3：已收藏标记
    if (!isSong && item.faved) {
      const srcTip = item.favedSource === 'index' ? '来自收藏夹索引'
        : item.favedSource === 'dom' ? '页面收藏状态'
        : item.favedSource === 'manual' ? '你手动标记的' : '';
      badges.push(`<span class="badge faved" title="${escapeHtml(srcTip)}">✓ 已在「${escapeHtml(favNameOf())}」</span>`);
    }
    if (!isSong && item.excluded) badges.push('<span class="badge excluded">已排除</span>');
    if (!isSong && item.isMusic === false && !item.excluded) {
      badges.push('<span class="badge suspect">疑似非音乐</span>');
    }
    if (!isSong && item.aiStatus === 'applied') {
      const t = item.aiSongName
        ? `AI：${item.aiSongName}${item.aiVersion ? ' · ' + item.aiVersion : ''}${item.aiConfidence ? `（${Math.round(item.aiConfidence * 100)}%）` : ''}`
        : 'AI 已判定';
      badges.push(`<span class="badge ai" title="${escapeHtml(item.aiReason || '')}">🤖 ${escapeHtml(truncate(t, 34))}</span>`);
    }

    const metaBits = [];
    if (isSong) {
      metaBits.push(`${(item.videos || []).length} 个视频`);
    } else {
      if (item.up) metaBits.push(escapeHtml(truncate(item.up, 12)));
      if (item.duration) metaBits.push(fmtDuration(item.duration));
      if (item.tname) metaBits.push(escapeHtml(item.tname));
    }
    if (item.lastPlayedAt) metaBits.push(fmtTime(item.lastPlayedAt));

    // 操作按钮
    const actions = [];
    if (!isSong) {
      if (item.bvid) {
        const url = `https://www.bilibili.com/video/${item.bvid}${item.page > 1 ? '/?p=' + item.page : ''}`;
        actions.push(`<button class="mini-btn" data-act="open" data-url="${escapeHtml(url)}">打开</button>`);
      }
      if (item.excluded) {
        actions.push(`<button class="mini-btn" data-act="include" data-key="${escapeHtml(item.key)}">恢复</button>`);
      } else {
        actions.push(`<button class="mini-btn" data-act="exclude" data-key="${escapeHtml(item.key)}">排除</button>`);
      }
      if (!item.isMusic) {
        actions.push(`<button class="mini-btn" data-act="music" data-key="${escapeHtml(item.key)}">标为音乐</button>`);
      }
      if (reached && item.notified) {
        actions.push(`<button class="mini-btn" data-act="reset-notified" data-key="${escapeHtml(item.key)}" data-level="video">重置提醒</button>`);
      }
      if (item.aiStatus === 'applied') {
        actions.push(`<button class="mini-btn" data-act="recheck" data-key="${escapeHtml(item.key)}">重新判定</button>`);
      }
      // ★ v1.3：手动标注收藏状态
      if (item.faved) {
        actions.push(`<button class="mini-btn" data-act="mark-not-faved" data-key="${escapeHtml(item.key)}" data-level="video">取消收藏标记</button>`);
      } else {
        actions.push(`<button class="mini-btn" data-act="mark-faved" data-key="${escapeHtml(item.key)}" data-level="video">标为已收藏</button>`);
      }
      actions.push(`<button class="mini-btn danger" data-act="delete" data-key="${escapeHtml(item.key)}" data-level="video">删除</button>`);
    } else {
      const lastVideo = (item.videos || [])[(item.videos || []).length - 1];
      if (lastVideo) {
        const bv = String(lastVideo).split('_p')[0];
        const url = `https://www.bilibili.com/video/${bv}`;
        actions.push(`<button class="mini-btn" data-act="open" data-url="${escapeHtml(url)}">打开最近</button>`);
      }
      if (reached && item.notified) {
        actions.push(`<button class="mini-btn" data-act="reset-notified" data-key="${escapeHtml(item.key)}" data-level="song">重置提醒</button>`);
      }
      actions.push(`<button class="mini-btn danger" data-act="delete" data-key="${escapeHtml(item.key)}" data-level="song">删除</button>`);
    }

    return `
      <div class="item">
        <div class="rank ${rankCls}">${i + 1}</div>
        <div class="item-main">
          <div class="item-title">${title}</div>
          <div class="item-meta">${badges.join('')} ${metaBits.join(' · ')}</div>
          ${!reached ? `<div class="progress-wrap"><div class="progress-bar" style="width:${progress}%"></div></div>` : ''}
          <div class="item-actions">${actions.join('')}</div>
        </div>
        <div class="item-right">
          <div class="count ${reached ? '' : 'dim'}">${item.playCount}<span class="count-unit"> 次</span></div>
        </div>
      </div>
    `;
  }).join('');

  const pending = list.filter(x => x.playCount < threshold).length;
  $('hint').textContent = `阈值 ${threshold} 次 · 还有 ${pending} 首未达标 · 数据仅保存在本机`;
}

// ---------- 事件 ----------

document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('.tab');
  if (tabBtn) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tabBtn.classList.add('active');
    currentTab = tabBtn.dataset.tab;
    render();
    return;
  }

  const btn = e.target.closest('.mini-btn');
  if (!btn) return;
  const act = btn.dataset.act;
  const key = btn.dataset.key;
  const level = btn.dataset.level || (currentTab === 'songs' ? 'song' : 'video');

  if (act === 'open') {
    chrome.tabs.create({ url: btn.dataset.url });
    return;
  }

  // ★ v1.3：手动标注收藏状态
  if (act === 'mark-faved' || act === 'mark-not-faved') {
    await chrome.runtime.sendMessage({ type: 'SET_OVERRIDE', key, value: act, level: 'video' });
    toast(act === 'mark-faved' ? '已标为已收藏，不再计数' : '已取消收藏标记');
    await load();
    return;
  }

  if (act === 'favRefresh') {
    toast('正在建立索引…');
    const r = await chrome.runtime.sendMessage({ type: 'FAV_REFRESH_INDEX', force: true });
    if (r && r.ok) {
      const d = r.data || {};
      const chainN = d.chainLen > 1 ? `（${d.chainLen} 个夹）` : '';
      toast(`索引完成：${d.count} 首${chainN}${d.allFull ? ' · 收藏夹已满' : ''}`);
    } else {
      toast('索引失败：' + ((r && (r.error || (r.data && r.data.error))) || '未知错误'));
    }
    await load();
    return;
  }

  // ★ 新建溢出收藏夹（「歌」满了之后）
  if (act === 'favNewFolder') {
    const name = btn.dataset.name || (favNameOf() + '2');
    const ok = confirm(
      `新建收藏夹「${name}」？\n\n` +
      'B站单个自建收藏夹上限 1000 首，满了之后新建一个即可继续收藏。\n' +
      '建好后插件会自动把它纳入索引与收藏目标，无需再改设置。'
    );
    if (!ok) return;
    toast('正在新建…');
    const r = await chrome.runtime.sendMessage({ type: 'FAV_CREATE_FOLDER', title: name });
    if (r && r.ok) {
      toast(`已新建「${name}」`);
      // 建完打开新夹
      try {
        const fr = await chrome.runtime.sendMessage({ type: 'FAV_GET_STATUS' });
        const mid = (fr && fr.data && fr.data.mid) || '';
        const id = r.data && r.data.id;
        const url = mid
          ? `https://space.bilibili.com/${mid}/favlist${id ? '?fid=' + id : ''}`
          : 'https://www.bilibili.com/account/favlist';
        chrome.tabs.create({ url });
      } catch (e) { /* ignore */ }
    } else {
      const err = (r && (r.error || r.code)) || '未知错误';
      alert(
        `新建失败：${err}\n\n` +
        '可能原因：未登录 / 收藏夹数量已达上限 / 触发风控。\n' +
        '可去网页端「我的收藏 → 新建收藏夹」手动创建，建好后点「刷新」即可。'
      );
    }
    await load();
    return;
  }

  if (act === 'delete') {
    const ok = confirm('确定删除这条记录吗？此操作不可恢复。');
    if (!ok) return;
    await chrome.runtime.sendMessage({ type: 'SET_OVERRIDE', key, value: 'delete', level });
    toast('已删除');
    await load();
    return;
  }

  if (act === 'recheck') {
    await recheckItem(key);
    return;
  }

  if (act === 'music' || act === 'not-music' || act === 'exclude' || act === 'include' || act === 'reset-notified') {
    await chrome.runtime.sendMessage({ type: 'SET_OVERRIDE', key, value: act, level });
    toast('已更新');
    await load();
    return;
  }
});

// ---------- 设置面板 ----------

$('btnSettings').addEventListener('click', () => {
  const sp = $('settingsPanel');
  const mp = $('mainPanel');
  const showing = !sp.classList.contains('hidden');
  if (showing) {
    sp.classList.add('hidden');
    mp.classList.remove('hidden');
  } else {
    fillSettings();
    sp.classList.remove('hidden');
    mp.classList.add('hidden');
  }
});

function fillSettings() {
  const s = store.settings;
  $('setThreshold').value = s.threshold;
  $('setFavName').value = s.favFolderName || '歌';
  // ★ v1.3.1：已收藏检测 / 多夹 / 索引刷新
  if ($('setSkipFaved')) $('setSkipFaved').checked = s.skipFaved !== false;
  if ($('setFavOverflow')) $('setFavOverflow').checked = s.favOverflowEnabled !== false;
  if ($('setFavWeekly')) $('setFavWeekly').checked = s.favIndexWeeklyEnabled !== false;
  if ($('setFavRefreshMin')) $('setFavRefreshMin').value = s.favIndexRefreshMinutes || 30;
  $('setVideoLevel').checked = !!s.videoLevel;
  $('setSongLevel').checked = !!s.songLevel;
  $('setMergeSimilar').checked = s.mergeSimilarVersions !== false;
  $('setIncludeSuspect').checked = !!s.includeSuspect;
  $('setMutedCounts').checked = !!s.mutedCounts;
  $('setMinSec').value = s.minWatchSeconds;
  $('setRatio').value = s.minWatchRatio;
  $('setDebugHud').checked = s.debugHud !== false;

  // AI
  $('setAiChannel').value = s.aiChannel || 'off';
  $('setAiEndpoint').value = s.aiEndpoint || '';
  $('setAiKey').value = s.aiApiKey || '';
  $('setAiModel').value = s.aiModel || 'gpt-4o-mini';
  $('setAiConf').value = s.aiConfidenceThreshold || 0.85;
  $('setAiTimeout').value = s.aiTimeout || 10000;
  $('setAiCache').checked = s.aiCacheEnabled !== false;
  syncAiBoxes();
  refreshAiStatus();
}

function syncAiBoxes() {
  const ch = $('setAiChannel').value;
  $('aiDirectBox').classList.toggle('hidden', ch !== 'direct');
  $('aiQueueBox').classList.toggle('hidden', ch !== 'queue');
}

$('setAiChannel').addEventListener('change', () => {
  syncAiBoxes();
  if ($('setAiChannel').value === 'queue') refreshAiStatus();
});

async function refreshAiStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'AI_GET_STATUS' });
    if (!res || !res.ok) return;
    const d = res.data;
    $('queueCount').textContent = d.pendingCount;
    const st = d.stats || {};
    const parts = [];
    if (st.calls) parts.push(`已调用 ${st.calls} 次`);
    if (d.cacheCount) parts.push(`缓存 ${d.cacheCount} 条`);
    if (st.failed) parts.push(`失败 ${st.failed} 次`);
    if (st.tokensIn || st.tokensOut) parts.push(`tokens ${st.tokensIn || 0}/${st.tokensOut || 0}`);
    $('aiStatsText').textContent = parts.length ? parts.join(' · ') : '尚未调用 AI';
  } catch (e) { /* 忽略 */ }
}

$('btnSave').addEventListener('click', async () => {
  const patch = {
    threshold: Math.max(1, Math.min(99, Number($('setThreshold').value) || 5)),
    favFolderName: ($('setFavName').value || '歌').trim(),
    // ★ v1.3.1
    skipFaved: $('setSkipFaved') ? $('setSkipFaved').checked : true,
    favOverflowEnabled: $('setFavOverflow') ? $('setFavOverflow').checked : true,
    favIndexWeeklyEnabled: $('setFavWeekly') ? $('setFavWeekly').checked : true,
    favIndexRefreshMinutes: Math.max(5, Math.min(1440, Number($('setFavRefreshMin') && $('setFavRefreshMin').value) || 30)),
    videoLevel: $('setVideoLevel').checked,
    songLevel: $('setSongLevel').checked,
    mergeSimilarVersions: $('setMergeSimilar').checked,
    includeSuspect: $('setIncludeSuspect').checked,
    mutedCounts: $('setMutedCounts').checked,
    minWatchSeconds: Math.max(5, Math.min(600, Number($('setMinSec').value) || 30)),
    minWatchRatio: Math.max(0.05, Math.min(1, Number($('setRatio').value) || 0.3)),
    debugHud: $('setDebugHud').checked,

    // AI
    aiChannel: $('setAiChannel').value || 'off',
    aiEndpoint: ($('setAiEndpoint').value || '').trim(),
    aiApiKey: ($('setAiKey').value || '').trim(),
    aiModel: ($('setAiModel').value || 'gpt-4o-mini').trim(),
    aiConfidenceThreshold: Math.max(0.1, Math.min(1, Number($('setAiConf').value) || 0.85)),
    aiTimeout: Math.max(3000, Math.min(60000, Number($('setAiTimeout').value) || 10000)),
    aiCacheEnabled: $('setAiCache').checked
  };
  await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', patch });
  toast('设置已保存，刷新B站页面生效');
  await load();
});

$('btnReset').addEventListener('click', async () => {
  const ok = confirm('恢复默认设置？AI 配置也会被清空（统计数据不受影响）。');
  if (!ok) return;
  await chrome.runtime.sendMessage({
    type: 'SET_SETTINGS',
    patch: {
      threshold: 5, favFolderName: '歌', videoLevel: true, songLevel: true,
      mergeSimilarVersions: true, includeSuspect: false, mutedCounts: true,
      minWatchSeconds: 30, minWatchRatio: 0.3, debugHud: true,
      aiChannel: 'off', aiEndpoint: '', aiApiKey: '', aiModel: 'gpt-4o-mini',
      aiConfidenceThreshold: 0.85, aiTimeout: 10000, aiApplyMode: 'auto', aiCacheEnabled: true
    }
  });
  toast('已恢复默认');
  await load();
  fillSettings();
});

// ---------- AI：测试连接 ----------

$('btnAiTest').addEventListener('click', async () => {
  const el = $('aiTestResult');
  el.className = 'test-result';
  el.textContent = '测试中…';

  const patch = {
    aiEndpoint: ($('setAiEndpoint').value || '').trim(),
    aiApiKey: ($('setAiKey').value || '').trim(),
    aiModel: ($('setAiModel').value || 'gpt-4o-mini').trim(),
    aiTimeout: Math.max(3000, Math.min(60000, Number($('setAiTimeout').value) || 10000))
  };

  if (!patch.aiEndpoint) { el.className = 'test-result err'; el.textContent = '请先填写端点'; return; }
  if (!patch.aiApiKey) { el.className = 'test-result err'; el.textContent = '请先填写 Key'; return; }

  try {
    const res = await chrome.runtime.sendMessage({ type: 'AI_TEST_CONNECTION', patch });
    if (res && res.ok) {
      const r = res.data.result;
      el.className = 'test-result ok';
      el.textContent = `✓ 成功（${res.data.ms}ms）→ ${r.version || '-'} ${r.songName || '-'}`;
    } else {
      el.className = 'test-result err';
      el.textContent = '✗ ' + ((res && res.data && res.data.error) || (res && res.error) || '失败');
    }
  } catch (e) {
    el.className = 'test-result err';
    el.textContent = '✗ ' + String(e && e.message || e);
  }
});

// ---------- AI：队列操作 ----------

$('btnQueueCopy').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'AI_EXPORT_QUEUE' });
  if (!res || !res.ok) { toast('读取队列失败'); return; }
  if (!res.data.count) { toast('队列是空的'); return; }
  try {
    await navigator.clipboard.writeText(JSON.stringify(res.data, null, 2));
    toast(`已复制 ${res.data.count} 条，粘贴给我即可`);
  } catch (e) {
    // 降级为下载
    downloadJson(res.data, `bili-queue-${todayStamp()}.json`);
    toast('剪贴板不可用，已改为下载文件');
  }
});

$('btnQueueExport').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'AI_EXPORT_QUEUE' });
  if (!res || !res.ok) { toast('读取队列失败'); return; }
  downloadJson(res.data, `bili-queue-${todayStamp()}.json`);
  toast(`已导出 ${res.data.count} 条`);
});

$('btnQueueClear').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'AI_EXPORT_QUEUE' });
  const n = (res && res.data && res.data.count) || 0;
  if (!n) { toast('队列是空的'); return; }
  const ok = confirm(`确定清空 ${n} 条待判定项吗？已生效的 AI 结果不会被撤销。`);
  if (!ok) return;
  await chrome.runtime.sendMessage({ type: 'AI_CLEAR_QUEUE' });
  toast('队列已清空');
  refreshAiStatus();
});

$('btnResultImport').addEventListener('click', () => $('fileResults').click());

$('fileResults').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    const payload = json.results ? json : { results: json };
    const res = await chrome.runtime.sendMessage({ type: 'AI_IMPORT_RESULTS', data: payload });
    if (res && res.ok) {
      const d = res.data;
      toast(`已应用 ${d.applied} 条${d.skipped.length ? `，跳过 ${d.skipped.length} 条` : ''}`);
    } else {
      alert('导入失败：' + ((res && res.error) || '未知错误'));
    }
    await load();
    refreshAiStatus();
  } catch (err) {
    alert('导入失败：文件格式不正确');
  }
  e.target.value = '';
});

// ---------- AI：单条重新判定 ----------

async function recheckItem(key) {
  const res = await chrome.runtime.sendMessage({ type: 'AI_RECHECK', key });
  if (res && res.ok) {
    const src = res.data && res.data.source;
    toast(src === 'queue' ? '已重新入队，等待处理' : '已用直连模式重新判定');
  } else {
    alert('重新判定失败：' + ((res && res.error) || '未知错误'));
  }
  await load();
  refreshAiStatus();
}

// ---------- 工具 ----------

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- 导入导出 ----------

$('btnExport').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'EXPORT_DATA' });
  if (!res || !res.ok) return;
  const payload = {
    exportedAt: new Date().toISOString(),
    version: '1.0.0',
    data: res.data
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `bili-music-tracker-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('已导出');
});

$('btnImport').addEventListener('click', () => $('fileImport').click());

$('fileImport').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    const data = json.data || json;
    if (json.data) {
      const ok = confirm('导入将合并/覆盖现有数据，确定继续吗？');
      if (!ok) return;
      await chrome.runtime.sendMessage({ type: 'IMPORT_DATA', data: data.settings ? data : data });
    } else {
      await chrome.runtime.sendMessage({ type: 'IMPORT_DATA', data });
    }
    toast('导入完成');
    await load();
  } catch (err) {
    alert('导入失败：文件格式不正确');
  }
  e.target.value = '';
});

$('btnClear').addEventListener('click', async () => {
  const ok = confirm('确定清空全部统计数据吗？此操作不可恢复，建议先导出备份。');
  if (!ok) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_ALL' });
  toast('已清空');
  await load();
});

// ---------- 启动 ----------

load();
