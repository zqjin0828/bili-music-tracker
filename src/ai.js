/**
 * ai.js — AI 判定模块
 *
 * 职责：
 *  1. 构建 prompt（含 few-shot）
 *  2. 解析并校验 LLM 响应，归一化到合法枚举
 *  3. 响应缓存（永久，标题变更时失效）
 *  4. 失败降级 —— 任何异常都不能让插件不可用
 *
 * 无副作用、无 chrome API 依赖，方便单测。
 */

(function (root) {
  'use strict';

  const Parser = root.BiliParser;

  // ---------- 合法版本枚举 ----------
  // 必须与 parser.js 的 VERSION_RULES / VERSION_MERGE 保持一致
  const VALID_VERSIONS = [
    'original', '翻唱', 'AI翻唱', 'Live', 'Remix', '钢琴版', '吉他版',
    'Acoustic', '纯音乐', '中文版', '日语版', '粤语版', '英文版',
    '替え歌', 'Remake', 'Demo', '其他'
  ];

  // 模型可能返回的非标准值 → 归一化映射
  const VERSION_ALIASES = {
    '原唱': 'original', '原创': 'original', '原曲': 'original', '本家': 'original',
    'オリジナル': 'original', 'original song': 'original', 'origin': 'original',
    'cover': '翻唱', '歌ってみた': '翻唱', 'カバー': '翻唱', '翻弹': '翻唱',
    '弾いてみた': '翻唱', '翻自': '翻唱', 'covered': '翻唱',
    'ai': 'AI翻唱', 'ai cover': 'AI翻唱', 'aiカバー': 'AI翻唱',
    'live': 'Live', '现场': 'Live', 'ライブ': 'Live', '演唱会': 'Live',
    'remix': 'Remix', 'リミックス': 'Remix', '混音': 'Remix', '电音版': 'Remix',
    'piano': '钢琴版', 'ピアノ': '钢琴版', 'piano version': '钢琴版',
    'guitar': '吉他版', 'ギター': '吉他版', '弹唱': '吉他版', '吉他弹唱': '吉他版',
    '指弹': '吉他版', '吉他': '吉他版',
    'acoustic': 'Acoustic', 'アコースティック': 'Acoustic', '不插电': 'Acoustic',
    'instrumental': '纯音乐', 'karaoke': '纯音乐', 'カラオケ': '纯音乐',
    'インスト': '纯音乐', '伴奏': '纯音乐', 'inst': '纯音乐',
    'chinese': '中文版', 'japanese': '日语版', 'cantonese': '粤语版',
    'english': '英文版',
    'パロディ': '替え歌', '改编': '替え歌',
    'remake': 'Remake', 'セルフカバー': 'Remake', '重制': 'Remake',
    'demo': 'Demo', 'デモ': 'Demo', '试唱': 'Demo'
  };

  const MAX_DESC_LEN = 500;

  // ---------- prompt 构建 ----------

  const SYSTEM_PROMPT = `你是一个音乐元数据解析器。给定 B 站视频信息，判断它是否为音乐视频，并提取结构化的曲目信息。

【判定规则】
- isMusic: 该视频主体是否为歌曲/音乐（含翻唱、演奏、纯音乐、MV、Live）
  - 教程、游戏实况、vlog、纪录片、影视解说 → false
  - 音乐区但不含具体曲目（如纯聊音乐）→ 视情况判断
- isCompilation: 是否为多首歌的集合（歌单/串烧/作业用BGM/超过30分钟的多曲合集）
- songName: 曲名。没有明确曲名就留空字符串，绝对不要编造
- artist: 演唱者/原作者。分不清就留空字符串
- version: 版本类型，只能从以下枚举选，不要自创：
  original | 翻唱 | AI翻唱 | Live | Remix | 钢琴版 | 吉他版 | Acoustic | 纯音乐 | 中文版 | 日语版 | 粤语版 | 英文版 | 替え歌 | Remake | Demo | 其他
- confidence: 你对本次判断的把握，0~1 的小数

【重要规则】
- 日语的「歌ってみた」「弾いてみた」「カバー」是翻唱，不是原创
- 「オリジナル」「本家」是原唱/原创，归入 original
- 「カラオケ」「インスト」「オフボーカル」是伴奏，归入「纯音乐」
- 「ピアノ」「ギター」是乐器版本，不要归入 original
- 别把 UP 主名字当成歌手，除非标题明确是「歌手 - 歌名」格式
- 只输出 JSON，不要任何解释文字、不要 markdown 代码块`;

  const FEW_SHOT = [
    {
      input: {
        title: '【初音ミク】千本桜【オリジナル】', up: 'ボカロP',
        tid: 30, tname: 'VOCALOID·UTAU', duration: 240, desc: ''
      },
      output: {
        isMusic: true, isCompilation: false, songName: '千本桜', artist: '初音ミク',
        version: 'original', confidence: 0.95, reason: 'VOCALOID区，オリジナル表示原创曲'
      }
    },
    {
      input: {
        title: '【ピアノ】千本桜', up: 'piano ch',
        tid: 59, tname: '演奏', duration: 260, desc: 'ピアノアレンジ'
      },
      output: {
        isMusic: true, isCompilation: false, songName: '千本桜', artist: '',
        version: '钢琴版', confidence: 0.92, reason: 'ピアノ 明示钢琴版，不是原曲'
      }
    },
    {
      input: {
        title: '【作業用BGM】アニソンメドレー 100曲', up: 'music ch',
        tid: 3, tname: '音乐', duration: 7200, desc: '収録曲一覧...'
      },
      output: {
        isMusic: true, isCompilation: true, songName: 'アニソンメドレー', artist: '',
        version: 'original', confidence: 0.9, reason: 'メドレー + 2小时 + 100曲，判为合辑'
      }
    },
    {
      input: {
        title: '艾尔登法环 全boss无伤攻略', up: '游戏UP',
        tid: 4, tname: '游戏', duration: 1800, desc: ''
      },
      output: {
        isMusic: false, isCompilation: false, songName: '', artist: '',
        version: '', confidence: 0.98, reason: '游戏攻略，非音乐'
      }
    },
    {
      input: {
        title: '【歌ってみた】残酷な天使のテーゼ', up: '歌い手',
        tid: 31, tname: '翻唱', duration: 250, desc: '本家様: 高橋洋子'
      },
      output: {
        isMusic: true, isCompilation: false, songName: '残酷な天使のテーゼ', artist: '',
        version: '翻唱', confidence: 0.96, reason: '歌ってみた 是翻唱标记'
      }
    }
  ];

  /**
   * 构造发给 LLM 的 messages
   * @param {object} info { title, desc, up, tid, tname, duration, part }
   */
  function buildMessages(info) {
    const input = {
      title: String(info.title || ''),
      up: String(info.up || ''),
      tid: Number(info.tid) || 0,
      tname: String(info.tname || ''),
      duration: Number(info.duration) || 0,
      desc: truncate(String(info.desc || ''), MAX_DESC_LEN)
    };
    if (info.part) input.part = String(info.part);

    let user = '';
    for (const ex of FEW_SHOT) {
      user += `【示例】\n输入: ${JSON.stringify(ex.input)}\n输出: ${JSON.stringify(ex.output)}\n\n`;
    }
    user += `【现在处理】\n输入: ${JSON.stringify(input)}\n输出:`;

    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user }
    ];
  }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  // ---------- 响应解析与校验 ----------

  /**
   * 从模型回复里提取 JSON 对象
   * 处理：markdown 代码块、前后多余文字、单引号、尾随逗号
   */
  function extractJson(text) {
    if (!text) return null;
    let s = String(text).trim();

    // 去掉 markdown 代码块围栏
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    // 直接尝试
    try { return JSON.parse(s); } catch (e) { /* 继续 */ }

    // 提取第一个平衡的 {...}
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;
    let frag = s.slice(start, end + 1);

    try { return JSON.parse(frag); } catch (e) { /* 继续修 */ }

    // 修常见问题：尾随逗号、单引号
    frag = frag
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/'([^']*?)'/g, '"$1"');
    try { return JSON.parse(frag); } catch (e) { return null; }
  }

  /**
   * 归一化 version 到合法枚举
   */
  function normalizeVersion(v) {
    const raw = String(v || '').trim();
    if (!raw) return '';
    if (VALID_VERSIONS.indexOf(raw) >= 0) return raw;
    const low = raw.toLowerCase();
    if (VERSION_ALIASES[low]) return VERSION_ALIASES[low];
    if (VERSION_ALIASES[raw]) return VERSION_ALIASES[raw];
    // 模糊匹配：raw 里含某个 key
    for (const [k, target] of Object.entries(VERSION_ALIASES)) {
      if (low.indexOf(k) >= 0) return target;
    }
    for (const vv of VALID_VERSIONS) {
      if (low.indexOf(vv.toLowerCase()) >= 0) return vv;
    }
    return '其他';
  }

  /**
   * 校验并归一化 AI 响应
   * @param {object} raw 模型返回的 JSON
   * @param {object} fallback 规则引擎结果，用于补缺字段
   * @returns {{ok:boolean, result?:object, error?:string}}
   */
  function validateResult(raw, fallback) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'not-an-object' };
    }

    const conf = Number(raw.confidence);
    const result = {
      isMusic: typeof raw.isMusic === 'boolean' ? raw.isMusic : null,
      isCompilation: typeof raw.isCompilation === 'boolean' ? raw.isCompilation : false,
      songName: typeof raw.songName === 'string' ? raw.songName.trim() : '',
      artist: typeof raw.artist === 'string' ? raw.artist.trim() : '',
      version: normalizeVersion(raw.version),
      confidence: isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : ''
    };

    // isMusic 是必需的（核心判断）
    if (result.isMusic === null) {
      if (fallback && typeof fallback.isMusic === 'boolean') {
        result.isMusic = fallback.isMusic;
        result.confidence = Math.min(result.confidence, 0.5);
      } else {
        return { ok: false, error: 'missing-isMusic' };
      }
    }

    // 非音乐时清空曲目信息
    if (!result.isMusic) {
      result.songName = '';
      result.artist = '';
      result.version = '';
    }

    // 歌名为空但规则引擎有 → 用规则的（AI 没编造是好事，但我们可以补）
    if (result.isMusic && !result.songName && fallback && fallback.songName) {
      result.songName = fallback.songName;
      result.fromFallbackName = true;
    }

    return { ok: true, result };
  }

  /**
   * 完整流程：从模型原始文本 → 校验后的结果
   */
  function parseResponse(text, fallback) {
    const json = extractJson(text);
    if (!json) return { ok: false, error: 'json-parse-failed', raw: truncate(text, 200) };
    return validateResult(json, fallback);
  }

  // ---------- 与规则结果的对比 ----------

  /**
   * 判断 AI 结果与规则结果是否有实质差异
   * 用于决定是否需要「回溯修正计数」
   * @returns {{changed:boolean, fields:string[]}}
   */
  function diffFromRule(aiResult, ruleResult) {
    const fields = [];
    if (!aiResult || !ruleResult) return { changed: false, fields };

    if (!!aiResult.isMusic !== !!ruleResult.isMusic) fields.push('isMusic');
    if (!!aiResult.isCompilation !== !!ruleResult.isCompilation) fields.push('isCompilation');

    const norm = (s) => Parser ? Parser.normalizeName(s) : String(s || '').toLowerCase();
    const aName = norm(aiResult.songName);
    const rName = norm(ruleResult.songName);
    if (aName && rName && aName !== rName) fields.push('songName');

    const aVer = aiResult.version || 'original';
    const rVer = ruleResult.version || 'original';
    // Live/Remake 会并入 original，比较时先做合并归一
    const mergeV = (v) => {
      if (!Parser || !Parser.VERSION_MERGE) return v;
      return Parser.VERSION_MERGE[v] === 'merge' ? 'original' : v;
    };
    if (mergeV(aVer) !== mergeV(rVer)) fields.push('version');

    return { changed: fields.length > 0, fields };
  }

  /**
   * 用 AI 结果算出最终的 songKey
   * 复用 parser 的归一化逻辑，保证与规则引擎产出的 key 口径一致
   */
  function makeSongKeyFromAi(aiResult, mergeSimilar) {
    if (!Parser || !aiResult || !aiResult.songName) return '';
    return Parser.makeSongKey({
      songName: aiResult.songName,
      version: aiResult.version && aiResult.version !== '其他' ? aiResult.version : '',
      cleanTitle: ''
    }, mergeSimilar);
  }

  // ---------- 缓存 ----------

  /**
   * 缓存是否有效
   * 标题变了 → 失效（UP 可能改了标题，判定前提变了）
   */
  function isCacheValid(entry, info) {
    if (!entry || !entry.result) return false;
    if (info && info.title && entry.title && entry.title !== info.title) return false;
    return true;
  }

  // ---------- 降级：把 AI 结果转成规则结果同构的形状 ----------

  function toRuleShape(aiResult, info) {
    return {
      isMusic: !!aiResult.isMusic,
      isCompilation: !!aiResult.isCompilation,
      songName: aiResult.songName || '',
      artist: aiResult.artist || '',
      version: aiResult.version === '其他' ? '' : (aiResult.version || ''),
      confidence: aiResult.confidence,
      fromAi: true,
      reason: aiResult.reason || ''
    };
  }

  const api = {
    buildMessages,
    extractJson,
    normalizeVersion,
    validateResult,
    parseResponse,
    diffFromRule,
    makeSongKeyFromAi,
    isCacheValid,
    toRuleShape,
    VALID_VERSIONS,
    VERSION_ALIASES,
    SYSTEM_PROMPT,
    FEW_SHOT,
    MAX_DESC_LEN
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BiliAi = api;
})(typeof window !== 'undefined' ? window : globalThis);
