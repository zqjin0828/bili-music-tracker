/**
 * src/fav-index.js — 收藏夹索引 & 「已收藏」判定
 *
 * 解决的问题：
 *   ⚠️ 原逻辑只判断「听了 N 遍就提醒收藏」，**不知道这首歌是否已经在收藏夹里**。
 *   于是一首早就收藏过的歌，每次再听都会被继续计数、反复弹提醒卡片。
 *
 * 本模块提供三层判定（从快到准，逐层兜底）：
 *
 *   L1 — 本地索引（主力，零延迟）
 *        启动/定时拉取目标收藏夹（默认「歌」）的全部 BV，存成 Set。
 *        判断 has(bvid) 即可，纯本地、无网络、无风控风险。
 *
 *   L2 — 页面 DOM（实时兜底）
 *        读取播放器下方收藏按钮的状态。用户刚点完收藏，L1 索引还没刷新时，
 *        能立刻感知到「已收藏」，避免立刻又弹一次提醒。
 *
 *   L3 — 后台接口（按需刷新）
 *        background 定时（默认 30 分钟）或「用户点了收藏后」触发重新拉取索引。
 *
 * 为什么不用 fav/resource/ids?bvid=xxx：
 *   实测该接口要求 WBI 签名，未签名返回 {"code":-400}。
 *   而 fav/resource/list 无需签名——直接拉全量建索引更简单可靠。
 *   实测「歌」收藏夹 276 条 BV，一次拉取 12 个请求（20/页）即可完成。
 */

'use strict';

(function () {
  const GE_FOLDER_TITLE_DEFAULT = '歌';

  // 名字相近但**不是**目标收藏夹的，必须排除（实测存在「歌？」这种夹）
  const FOLDER_EXCLUDE_SUFFIX = /[?？!！。.、*＊\s]+$/;

  /**
   * ★ 收藏夹容量上限（实测 + 官方行为）
   *
   *   B站「自建收藏夹」每个最多 1000 个视频；「默认收藏夹」5 万个。
   *   满了之后界面上加收藏会提示「添加失败，该收藏夹已满」，
   *   ★ 但接口可能静默失败（返回成功但没写进去）—— 所以必须自己提前预警。
   *
   *   ⚠️ 关于「自建收藏夹个数上限」：网上有 50 / 99 / 100 多种说法，
   *     B站从未公开，且随版本变动。这里给一个保守的当前值 + 在界面上提示
   *     「以页面实际报错为准」，不要向用户保证具体数字。
   */
  const FOLDER_CAP = {
    CUSTOM: 1000,      // 自建收藏夹单项容量上限
    DEFAULT: 50000,    // 默认收藏夹容量上限
    // 自建收藏夹数量上限：B站未公开，给个保守估计用于「快满了」提示
    MAX_FOLDERS: 100,
    // 接近上限（剩余不足这个比例）就提醒用户准备新夹
    WARN_RATIO: 0.9
  };

  const FavIndex = {
    FOLDER_CAP,

    /**
     * ★ 计算收藏夹容量状态
     * @param {number} count 当前收录数
     * @param {object} folder { media_count, attr, title }
     * @returns {{count, cap, remain, ratio, level, label}}
     *   level: 'ok' | 'warn'（≥90%）| 'full'（已满）
     */
    capStatus(count, folder) {
      const f = folder || {};
      // attr 含默认收藏夹标记时用大上限；否则按自建夹算
      // B站 attr 位含义未公开，这里用「标题是默认收藏夹」或超大 count 来判
      const isDefault = /^默认收藏夹/.test(String(f.title || ''))
        || (Number(f.media_count) > FOLDER_CAP.CUSTOM * 2);
      const cap = isDefault ? FOLDER_CAP.DEFAULT : FOLDER_CAP.CUSTOM;
      const c = Math.max(0, Number(count) || 0);
      const remain = Math.max(0, cap - c);
      const ratio = cap > 0 ? c / cap : 0;
      let level = 'ok';
      if (c >= cap) level = 'full';
      else if (ratio >= FOLDER_CAP.WARN_RATIO) level = 'warn';
      return { count: c, cap, remain, ratio, level, isDefault };
    },

    /**
     * ★ 在多收藏夹模式下，按顺序找出「第一个没满的目标夹」
     *
     * 支持两种配置：
     *   · 单夹模式：favFolderName = '歌'          → 等价于列表 ['歌']
     *   · 滚动模式：favFolderName = '歌' + 溢出夹
     *     溢出夹命名约定：'歌2'、'歌3'…（去掉尾部数字后仍是同名）
     *
     * @param {Array} folders 收藏夹列表（含 media_count）
     * @param {string} name   基础名（默认「歌」）
     * @param {object} opts   { allowOverflow: boolean }
     * @returns {{folder, reason, chain, full: Array}}
     */
    pickUsableFolder(folders, name, opts) {
      const o = opts || {};
      const base = String(name || GE_FOLDER_TITLE_DEFAULT).trim();
      const list = Array.isArray(folders) ? folders : [];

      // 主夹
      const main = FavIndex.pickFolder(list, base);
      const chain = [];
      const full = [];

      if (main.folder) chain.push(main.folder);

      // 溢出夹：同名 + 尾部数字（「歌2」「歌3」…），按数字升序
      const escapeRe = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)$');
      const extra = list
        .map(f => ({ f, m: escapeRe.exec(String(f.title || '').trim()) }))
        .filter(x => x.m && !FOLDER_EXCLUDE_SUFFIX.test(String(x.f.title || '').trim()))
        .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
        .map(x => x.f);
      for (const f of extra) chain.push(f);

      if (!chain.length) {
        return { folder: null, reason: 'not-found', chain: [], full: [] };
      }

      // 依次找第一个没满的
      for (const f of chain) {
        const st = FavIndex.capStatus(f.media_count || 0, f);
        if (st.level !== 'full') {
          return {
            folder: f,
            reason: f === chain[0] ? (main.reason || 'exact') : 'overflow-folder',
            chain: chain.map(x => ({ id: x.id, title: x.title, count: x.media_count || 0 })),
            full: full.map(x => ({ id: x.id, title: x.title, count: x.media_count || 0 })),
            baseName: base
          };
        }
        full.push(f);
      }

      // 全都满了 → 返回最后一个（让调用方提示用户去建新夹）
      const last = chain[chain.length - 1];
      return {
        folder: last,
        reason: 'all-full',
        chain: chain.map(x => ({ id: x.id, title: x.title, count: x.media_count || 0 })),
        full: chain.map(x => ({ id: x.id, title: x.title, count: x.media_count || 0 })),
        baseName: base
      };
    },

    /**
     * ★ 生成新溢出夹的名字：「歌」→「歌2」→「歌3」…
     * @param {Array} folders 现有收藏夹
     * @param {string} base   基础名
     * @returns {string}
     */
    nextOverflowName(folders, base) {
      const b = String(base || GE_FOLDER_TITLE_DEFAULT).trim();
      const list = Array.isArray(folders) ? folders : [];
      const re = new RegExp('^' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)$');
      let max = 1;
      const hasBase = list.some(f => String(f.title || '').trim() === b);
      if (hasBase) max = 1;
      for (const f of list) {
        const m = re.exec(String(f.title || '').trim());
        if (m) max = Math.max(max, Number(m[1]));
      }
      return b + (max + 1);
    },
    /**
     * 在页面上下文里拉取收藏夹全量 BV
     * 注意：必须在 bilibili.com 页面上下文执行（隔离世界 get 不到 Cookie 语义）
     *       这里通过 background 代发请求，避免内容脚本跨域/Cookie 问题。
     * @param {number} mediaId
     * @param {object} opts { maxPages, pageSize, onProgress }
     * @returns {Promise<{bvids: string[], aids: string[], total: number, hasMore: boolean}>}
     */
    async fetchFolderBvids(mediaId, opts) {
      const o = opts || {};
      const maxPages = o.maxPages || 60;
      const pageSize = o.pageSize || 20;
      const bvids = [];
      const aids = [];
      let hasMore = false;
      let total = 0;

      for (let pn = 1; pn <= maxPages; pn++) {
        const res = await chrome.runtime.sendMessage({
          type: 'FAV_FETCH_PAGE',
          mediaId,
          pn,
          ps: pageSize
        });

        if (!res || !res.ok || !res.data) {
          return { bvids, aids, total, hasMore, error: (res && res.error) || 'fetch-failed' };
        }
        const d = res.data;
        if (!d.list || !d.list.length) break;

        for (const m of d.list) {
          if (m.bvid) bvids.push(m.bvid);
          if (m.aid) aids.push(String(m.aid));
        }
        total += d.list.length;
        hasMore = !!d.has_more;

        if (o.onProgress) {
          try { o.onProgress({ pn, got: total, hasMore }); } catch (e) {}
        }
        if (!hasMore) break;

        // 温和限速，避免触发风控
        await new Promise(r => setTimeout(r, 180));
      }

      return {
        bvids: Array.from(new Set(bvids)),
        aids: Array.from(new Set(aids)),
        total,
        hasMore
      };
    },

    /**
     * 从收藏夹列表里挑出目标收藏夹（默认「歌」）
     * 精确匹配优先；「歌？」这类只差一个标点的会被排除。
     * @param {Array} folders
     * @param {string} wanted
     * @returns {{folder: object|null, reason: string, candidates: Array}}
     */
    pickFolder(folders, wanted) {
      const name = String(wanted || GE_FOLDER_TITLE_DEFAULT).trim();
      const list = Array.isArray(folders) ? folders : [];

      // 1) 精确匹配
      const exact = list.filter(f => String(f.title || '').trim() === name);
      if (exact.length === 1) {
        return { folder: exact[0], reason: 'exact', candidates: exact };
      }
      if (exact.length > 1) {
        // 多个同名：取内容最多的（最可能是主夹）
        const sorted = exact.slice().sort((a, b) => (b.media_count || 0) - (a.media_count || 0));
        return { folder: sorted[0], reason: 'exact-multi', candidates: sorted };
      }

      // 2) 去掉尾部标点后匹配（但排除纯标点差异造成的误配）
      const loose = list.filter(f => {
        const t = String(f.title || '').trim();
        if (FOLDER_EXCLUDE_SUFFIX.test(t)) return false;   // 「歌？」直接排除
        return t.replace(/\s+/g, '') === name.replace(/\s+/g, '');
      });
      if (loose.length) {
        const sorted = loose.slice().sort((a, b) => (b.media_count || 0) - (a.media_count || 0));
        return { folder: sorted[0], reason: 'loose', candidates: sorted };
      }

      // 3) 包含匹配（兜底，仍然排除带疑问/感叹号的）
      const partial = list.filter(f => {
        const t = String(f.title || '').trim();
        if (FOLDER_EXCLUDE_SUFFIX.test(t)) return false;
        return t.includes(name);
      });
      if (partial.length) {
        const sorted = partial.slice().sort((a, b) => (b.media_count || 0) - (a.media_count || 0));
        return { folder: sorted[0], reason: 'partial', candidates: sorted };
      }

      return { folder: null, reason: 'not-found', candidates: list };
    },

    /**
     * ★ 核心：判断某视频是否已在收藏夹里
     *
     * 判定顺序：本地索引 → 页面 DOM（可选）
     *
     * @param {string} bvid
     * @param {object} index  { bvids: Set|Array, fetchedAt: number, mediaId: number }
     * @param {object} opts   { domCheck: boolean, maxAgeMs: number, extraIndexes: Array }
     * @returns {{faved: boolean, source: string, stale: boolean}}
     */
    isFaved(bvid, index, opts) {
      const o = opts || {};
      const now = Date.now();
      const maxAge = o.maxAgeMs || 24 * 3600 * 1000;

      if (!bvid) return { faved: false, source: 'no-bvid', stale: false };

      // ★ 多索引支持：主索引 + 溢出索引（「歌2」「歌3」…）任一中命中即为已收藏
      const indexes = [index].concat(Array.isArray(o.extraIndexes) ? o.extraIndexes : []);
      let anyStale = true;
      let anyFresh = false;

      for (const ix of indexes) {
        if (!ix) continue;
        const set = ix.bvids;
        const isStale = !ix.fetchedAt || (now - ix.fetchedAt > maxAge);
        if (!isStale) anyFresh = true;
        else continue;
        if (!(set instanceof Set) && !Array.isArray(set)) continue;
        const hit = set instanceof Set ? set.has(bvid) : set.indexOf(bvid) >= 0;
        if (hit) return { faved: true, source: 'index:' + (ix.folderTitle || '?'), stale: false };
      }
      const stale = !anyFresh;

      // 索引未命中或索引过期 → DOM 兜底
      if (o.domCheck !== false && typeof document !== 'undefined') {
        const dom = FavIndex.readDomFavState();
        if (dom.faved) return { faved: true, source: 'dom:' + dom.detail, stale };
      }

      return { faved: false, source: 'none', stale };
    },

    /**
     * 读取页面上的收藏按钮状态（DOM 兜底）
     * B 站收藏后按钮会带上 on / active 类，或图标变色。
     * @returns {{faved: boolean, detail: string}}
     */
    readDomFavState() {
      try {
        const sels = [
          '.video-fav',
          '.video-toolbar-left .video-fav',
          '.toolbar-left .video-fav',
          '[class*="video-fav"]'
        ];
        for (const sel of sels) {
          const nodes = document.querySelectorAll(sel);
          for (const el of nodes) {
            const cls = String(el.className || '');
            const txt = (el.textContent || '').trim();
            // 收藏后：类名含 on / active / actived；文案通常仍是「收藏」
            if (/\b(on|active|actived|faved|selected)\b/.test(cls)) {
              return { faved: true, detail: 'class' };
            }
            // 部分版本文案会变成「已收藏」
            if (/已收藏|已加入/.test(txt)) {
              return { faved: true, detail: 'text' };
            }
          }
        }
      } catch (e) { /* 忽略 */ }
      return { faved: false, detail: 'none' };
    },

    /**
     * 归一化文件夹列表（把接口返回压成精简结构）
     */
    normalizeFolders(raw) {
      const list = (raw && raw.list) || [];
      return list.map(f => ({
        id: f.id,
        title: f.title || '',
        media_count: f.media_count || 0,
        attr: f.attr
      }));
    }
  };

  // 暴露到内容脚本作用域
  if (typeof window !== 'undefined') {
    window.BiliFavIndex = FavIndex;
  }
  // 供 Service Worker importScripts 使用
  if (typeof self !== 'undefined' && typeof module === 'undefined') {
    self.BiliFavIndex = FavIndex;
  }
})();
