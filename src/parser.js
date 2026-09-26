/**
 * parser.js — 标题解析与归一化
 *
 * 职责：把 B 站视频标题解析成 { songName, artist, version, quality }
 * 纯函数，无副作用，方便单测。
 */

(function (root) {
  'use strict';

  // ---------- 噪音标签：出现在标题里但不属于歌名的词 ----------
  // 全角/半角括号内的画质、情绪、格式类标签，剥离时整体丢弃
  const NOISE_PATTERNS = [
    // 画质 / 音质
    /4k/i, /8k/i, /1080p?/i, /720p?/i, /高清/, /超清/, /蓝光/, /无损/, /hifi/i,
    /hdr/i, /杜比/, /dolby/i, /母带/, /重制/, /修复/, /修复版/, /高清修复/,
    /高音質/, /高画質/, /フルhd/i, /음질/,
    // 中文情绪 / 场景词
    /单曲循环/, /循环/, /洗脑/, /神曲/, /必听/, /珍藏/, /收藏/, /推荐/,
    /纯享/, /纯音乐版/, /完整版/, /全集/, /合集/, /合辑/, /歌单/, /串烧/,
    /字幕/, /中文字幕/, /中日双语/, /歌词/, /带歌词/, /附歌词/,
    /耳机福利/, /深夜/, /助眠/, /安眠/, /放松/, /治愈/, /BGM/i, /背景音乐/,
    /音乐/, /歌曲/, /music\s*video/i, /官方/, /official/i,
    /转载/, /搬运/, /自制/, /投稿/, /更新/, /新作/, /动态壁纸/,
    /一图流/, /静态/, /动态/, /高清画质/, /试听/, /抢先听/, /首播/,
    // 日语场景 / 用途词
    /作業用/, /作業用bgm/i, /勉強用/, /睡眠用/, /作業用音楽/,
    /メドレー/, /アニソン/, /ボカロ/, /vocaloid/i, /ニコカラ/,
    /歌詞付き/, /歌詞あり/, /和訳/, /日本語訳/, /かなルビ/, /ふりがな/,
    /高音質/, /ループ/, /作業/, /ドライブ/, /カフェ/, /ジャズ/,
    /フリーbgm/i, /著作権フリー/, /bgm素材/i,
    // 节目 / 企划名
    /the\s*first\s*take/i, /アニメ/, /ゲーム/, /映画/, /ドラマ/, /主題歌/,
    /サントラ/, /soundtrack/i, /ost/i,
    // 注意：op/ed/mv 这类短缩写只在「括号整体就是它」时才当噪音处理，
    // 不能全文扫描 —— 否则会误伤英文人名（Ed Sheeran）和词内字母
    // 这部分由 SHORT_TAG_EXACT 处理
    // 视频形式 / 出处标签（这些是"视频类型"，不是歌手）
    /^mv$/i, /^mad$/i, /^amv$/i, /^op$/i, /^ed$/i, /^pv$/i, /^cm$/i,
    /^フル$/, /^full$/i, /^short$/i, /^fullver/i, /^本編/,
    /^練習$/, /^リクエスト$/, /^合唱$/, /^アカペラ$/i, /^弾き語り$/,
    /^東方$/, /^洋楽$/, /^邦楽$/, /^アニソン$/, /^ボカロ$/, /^vocaloid$/i,
    /^歌枠$/, /^生放送$/, /^枠$/, /^切り抜き$/, /^まとめ$/,
    /^高評価$/, /^おすすめ$/, /^人気$/, /^殿堂入り$/,
    /^中日字幕$/, /^日文字幕$/, /^字幕$/, /^歌詞$/, /^和訳$/,
    /^作業用$/, /^作業$/, /^勉強用$/, /^睡眠用$/, /^作業用bgm$/i,
    /^\d+\s*時間$/, /^\d+\s*分$/, /^\d+\s*時間\d+\s*分$/,
    /^playlist$/i, /^メドレー$/, /^medley$/i, /^カバー集$/,
    // 编号 / 时间戳
    /第\s*[0-9０-９一二三四五六七八九十]+\s*[話回弾曲]/, /^\d{1,2}[:：]\d{2}/
  ];

  // ---------- 版本标记：决定 songKey 的分组 ----------
  // 顺序有意义：越具体的版本越靠前，先匹配到的优先
  // 例如「钢琴版纯音乐」应判为「钢琴版」而非泛化的「纯音乐」
  const VERSION_RULES = [
    // ---- AI 相关（必须先于"翻唱"，避免 AI 翻唱被降级）----
    { key: 'AI翻唱', re: /ai\s*翻唱|ai\s*cover|sovits|rvc|ai\s*カバー|ai歌唱|diff[- ]?singer/i },

    // ---- 翻唱 / 翻弹（日语的 歌ってみた / 弾いてみた 都归此类）----
    { key: '翻唱', re: /翻唱|cover|翻自|翻錄|翻录|covered\s*by|歌ってみた|歌って見た|うたってみた|カバー|弾いてみた|弾いて見た|演奏してみた|叩いてみた/i },

    // ---- 现场 ----
    { key: 'Live', re: /live|现场|演唱会|concert|巡演|ライブ|生演奏|生歌/i },

    // ---- 重混 ----
    { key: 'Remix', re: /remix|重混|混音|dj\s*版|电音版|リミックス|アレンジ/i },

    // ---- 乐器版本 ----
    { key: '钢琴版', re: /钢琴版|piano\s*(version|cover)|钢琴改编|钢琴弹奏|ピアノ|piano/i },
    { key: '吉他版', re: /吉他版|guitar\s*(version|cover)|吉他弹唱|指弹|ギター|guitar/i },
    { key: 'Acoustic', re: /acoustic|不插电|アコースティック/i },

    // ---- 无人声 / 伴奏 / 卡拉OK ----
    { key: '纯音乐', re: /纯音乐|instrumental|无人声|伴奏|off\s*vocal|karaoke|カラオケ|インスト|インストゥルメンタル|オフボーカル/i },

    // ---- 语言版本 ----
    { key: '中文版', re: /中文版|中文填词|国语版|中国語版|中国語カバー/i },
    { key: '日语版', re: /日语版|日文版|原曲日语|日本語版|日本語カバー/i },
    { key: '粤语版', re: /粤语版|粤语填词|広東語版/i },
    { key: '英文版', re: /英文版|英文填词|英語版|英語カバー/i },

    // ---- 改编 / 替换歌词 ----
    { key: '替え歌', re: /替え歌|改编歌|改词|パロディ/i },
    { key: 'Remake', re: /remake|重制版?|重置版?|rearrange|リアレンジ|セルフカバー/i },

    // ---- 原唱 / 原创 ----
    { key: '原唱', re: /原唱|原曲|original|オリジナル|本家|原曲者/i },

    // ---- Demo ----
    { key: 'Demo', re: /demo|试唱|小样|デモ/i }
  ];

  /**
   * 版本标记被识别后，如果整个括号内容只是这个标记词（加少量修饰），
   * 就不该把它当歌手名。这个集合用于过滤。
   */
  const VERSION_ONLY_TOKENS = [
    'オリジナル', 'カバー', '歌ってみた', '弾いてみた', 'ピアノ', 'ギター',
    'アコースティック', 'カラオケ', 'インスト', 'ライブ', 'リミックス',
    '替え歌', '本家', '原曲', 'デモ', 'アレンジ', 'パロディ',
    'original', 'cover', 'live', 'karaoke', 'instrumental', 'demo', 'remix'
  ];

  // ---------- 括号内的内容：可能是歌手，也可能是噪音 ----------
  // 注意：《》「」里的内容通常就是歌名本身，不能当噪音剥掉，要单独处理
  const BRACKETS = [
    /【([^】]{1,60})】/g,
    /\[([^\]]{1,60})\]/g,
    /（([^）]{1,60})）/g,
    /\(([^)]{1,60})\)/g,
    /〈([^〉]{1,60})〉/g
  ];

  // 剥括号时用的完整配对（含书名号与日式引号）
  const BRACKET_PAIRS = [
    ['【', '】'], ['[', ']'], ['（', '）'], ['(', ')'], ['〈', '〉'],
    ['《', '》'], ['「', '」'], ['『', '』'], ['“', '”'], ['"', '"']
  ];

  // 歌名候选：被引号/书名号包裹的词 —— 这是歌名最可靠的来源
  // 注意：「」在日语里既用于歌名，也用于节目/出处，需要长度和噪音双重过滤
  const TITLE_QUOTE_RES = [
    /《([^》]{1,60})》/g,
    /〈([^〉]{1,60})〉/g,
    /「([^」]{1,60})」/g,
    /『([^』]{1,60})』/g
  ];

  // feat. / 合作者标注 —— 属于曲目信息但不该进歌名
  const FEAT_RE = /\s*(?:feat\.?|ft\.?|featuring|with)\s*[^)]*$/i;

  // 斜杠后的节目/企划名，如 "残響散歌 / THE FIRST TAKE"
  const SLASH_TAIL_RE = /\s*[/／]\s*(?:the\s*first\s*take|live|mv|official.*)$/i;

  // 斜杠分隔的「歌名 / 歌手」格式，如 "Shape of You / Ed Sheeran"
  const SLASH_ARTIST_RE = /^(.{1,40}?)\s*[/／]\s*(.{1,30})$/;

  // ---------- 合辑 / 歌单 / 电台 的识别 ----------
  // 这类视频是"多首歌的集合"，不是单曲。混进歌曲计数会污染数据。
  const COMPILATION_RES = [
    /メドレー/, /medley/i, /歌单/, /合集/, /合辑/, /串烧/, /联唱/, /連唱/,
    /作業用/, /作業bgm/i, /playlist/i, /プレイリスト/, /选集/, /精選/,
    /全曲/, /完整收录/, /曲集/, /アルバム/, /album/i, /一小时/, /1時間/,
    /長時間/, /耐久/, /radio/i, /ラジオ/, /电台/, /合集|总集篇|总集編/
  ];

  /**
   * 判断是否为合辑/歌单类视频
   */
  function isCompilation(title, upName, duration) {
    const t = String(title || '');
    if (COMPILATION_RES.some(re => re.test(t))) return true;
    // 超长视频（> 30 分钟）在音乐区多半是合辑
    if (duration > 1800) return true;
    return false;
  }

  /**
   * 判断一个短句是否"像歌手名"
   * - 长度 1~30
   * - 不含数字
   * - 不以句子终止符结尾
   * - 不含明显的"歌名句式"（如日语动词/助词结尾）
   */
  function looksLikeArtist(s) {
    const t = String(s || '').trim();
    if (!t || t.length < 1 || t.length > 30) return false;
    if (/^\d/.test(t)) return false;
    if (/[，,！!？?；;：:]/.test(t)) return false;
    if (/(的|了|吗|呢|吧)$/.test(t) && t.length >= 3) return false;
    // 日语歌名常见的句子式结尾 —— 这些不像歌手名
    if (/(て|で|を|が|に|は|も|と|から|まで|ながら|たら|なら)$/.test(t) && t.length >= 4) return false;
    return true;
  }

  /**
   * 给 "A - B" 两侧打分，判断谁是歌手。分值高者为歌手。
   *
   * 打分依据：
   *  【长度】中文/日文歌手名多为 2~6 字；英文乐队名可更长
   *  【语言】纯拉丁字母且首字母大写 → 像英文歌手/乐队（King Gnu、Aimer）
   *  【特征】含乐队/组合/歌手等词 → 强烈指向歌手
   *  【反证】含歌名高频词、含句子式语法 → 指向歌名
   */
  const ARTIST_HINTS = /乐队|組合|组合|合唱团|乐团|歌手|歌姬|アイドル|バンド|ユニット|グループ|band|group|feat|official/i;

  // 歌名高频字（中日英）—— 注意排除「中/上/下/前/后」这类方位字，
  // 它们更常出现在乐队名里（真夜中、世界中）
  const SONG_HINTS = /爱|心|梦|夜|雨|风|花|月|海|天|你|我|他|她|之|的|情|泪|光|星|云|山|河|念|思|歌|曲|谣|恋|愛|君|僕|私|空|虹|雪|桜|永遠|未来|とき|キミ/;
  // 日语歌名常见语法特征（动词/助词/形容词结尾）
  const JA_SONG_GRAMMAR = /(て|で|を|が|に|は|も|と|ない|たい|れる|られる|ながら|たら|なら|です|ます|ください|でしょう|かな|かも)$/;

  function scoreAsArtist(s, version) {
    let sc = 0;
    const t = String(s || '').trim();
    if (!t) return -99;

    const isLatin = /^[A-Za-z0-9\s'&.\-!]+$/.test(t);
    const hasCJK = /[\u3040-\u30ff\u4e00-\u9fa5]/.test(t);
    const cjkCount = (t.match(/[\u3040-\u30ff\u4e00-\u9fa5]/g) || []).length;
    const latinCount = (t.match(/[A-Za-z]/g) || []).length;

    // ---------- 长度 ----------
    if (hasCJK) {
      if (cjkCount >= 2 && cjkCount <= 6) sc += 3;
      else if (cjkCount <= 8) sc += 1;
      else if (cjkCount <= 12) sc -= 1;
      else sc -= 3;
    } else {
      // 纯拉丁：英文乐队名可长（King Gnu / Official髭男dism 混合情况另算）
      if (latinCount >= 3 && latinCount <= 20) sc += 2;
      else sc -= 1;
    }

    // ---------- 语言 / 字符构成 ----------
    if (/^[\u4e00-\u9fa5a-zA-Z0-9]+$/.test(t)) sc += 2;
    else if (isLatin) sc += 1;
    else if (hasCJK && /[\u3040-\u309f\u30a0-\u30ff]/.test(t) && !/[\s·。、]/.test(t)) sc += 1;
    else if (/[\s]/.test(t) && hasCJK) sc -= 1;   // 含空格的中日文串偏可疑
    else sc -= 1;                                  // 含标点

    // ---------- 强特征 ----------
    if (ARTIST_HINTS.test(t)) sc += 4;

    // 英文名首字母大写（King Gnu、Aimer、YOASOBI）
    if (isLatin && /^[A-Z]/.test(t) && !/\s[A-Z]?[a-z]{4,}/.test(t)) sc += 1.5;

    // ---------- 反证：像歌名 ----------
    const hintCount = (t.match(new RegExp(SONG_HINTS.source, 'g')) || []).length;
    if (hintCount > 0 && cjkCount >= 2) sc -= hintCount * 1.5;

    // 日语歌名句式（「秒針を噛む」「ただ君に晴れ」「残酷な天使のテーゼ」式）
    if (JA_SONG_GRAMMAR.test(t)) sc -= 2.5;

    if (/[，。！？、；：'"·]/.test(t)) sc -= 2;
    if (/(的|了|吗|呢|吧)$/.test(t) && t.length >= 3) sc -= 2;
    if (version && t.indexOf(version) >= 0) sc -= 3;
    if (/^\d/.test(t)) sc -= 3;
    // 整个就是版本/格式标记
    if (isVersionOnlyToken(t)) sc -= 5;

    return sc;
  }

  /**
   * 在 "A - B" 中判定歌手
   * @returns {{artist:string, song:string}}
   */
  function splitByDash(left, right, version) {
    const ls = scoreAsArtist(left, version);
    const rs = scoreAsArtist(right, version);

    // 分值接近（差值 <= 3）时不可靠，采用音乐平台最通用的格式约定：
    // 「歌手 - 歌名」，即左边是歌手
    const CLOSE = 3;
    if (Math.abs(ls - rs) <= CLOSE) {
      return { artist: left, song: right };
    }
    if (ls > rs) return { artist: left, song: right };
    return { artist: right, song: left };
  }

  function isNoise(text) {
    if (!text) return true;
    const t = text.trim();
    if (!t) return true;
    // 整个括号内容就是噪音词
    if (NOISE_PATTERNS.some(re => re.test(t))) {
      // 但若同时含版本标记则不丢（如「翻唱版」）
      if (VERSION_RULES.some(v => v.re.test(t))) return false;
      return true;
    }
    return false;
  }

  /**
   * 全角转半角 + 去多余空白
   */
  function normalizeWidth(str) {
    return String(str)
      .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 归一化歌名，用于生成跨视频稳定的 key
   * - 全角转半角、转小写
   * - 去掉标点与空格
   * - 简繁不做转换（避免引入依赖），但去掉常见装饰符号
   */
  function normalizeName(str) {
    return normalizeWidth(str)
      .toLowerCase()
      .replace(/[\s\-_~～·・、,，。.！!？?：:；;'"“”‘’()（）\[\]【】《》〈〉]/g, '')
      .trim();
  }

  /**
   * 从标题的括号内容中猜歌手
   * 规则：括号内容不含噪音词、长度 1~20、不含数字开头的编码（如 BV号）、
   *      不像版本标记、不像纯英文的 "Official Video" 之类
   * 注意：《》里的内容已被识别为歌名，不进入这里（BRACKETS 不含书名号）
   */
  function guessArtistFromBrackets(bracketContents) {
    const candidates = [];
    for (const c of bracketContents) {
      const t = String(c || '').trim();
      if (!t || t.length > 20) continue;
      if (isNoise(t)) continue;
      // 含版本标记的括号通常是版本说明，不是歌手
      if (VERSION_RULES.some(v => v.re.test(t))) continue;
      // 整个括号就是版本词/演奏标记（オリジナル、ピアノ、弾いてみた…）
      if (isVersionOnlyToken(t)) continue;
      // 纯数字或纯符号跳过
      if (/^[\d\s\-_.]+$/.test(t)) continue;
      // 像一个 UP 主的标签（含"的"结尾、"投稿"等）跳过
      if (/的$/.test(t)) continue;
      candidates.push(t);
    }
    // 优先返回通过 looksLikeArtist 校验的最后一个候选（尾置通常是歌手）
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (looksLikeArtist(candidates[i])) return candidates[i];
    }
    return candidates.length ? candidates[candidates.length - 1] : '';
  }

  /**
   * 判断一个短句是否"整体就是版本/演奏标记"
   * 例如 "オリジナル"、"ピアノ"、"弾いてみた"、"Каver" —— 这些是版本说明，不是歌手
   * 允许带少量修饰（如"ピアノver"、"ボカロカバー"）
   */
  function isVersionOnlyToken(t) {
    const s = String(t || '').trim().toLowerCase()
      .replace(/[（(].*?[）)]/g, '')
      .replace(/[ｖv]er\.?$/, '')
      .replace(/\s+/g, '')
      .trim();
    if (!s) return false;

    // 完全等于某个版本标记词
    if (VERSION_ONLY_TOKENS.some(tok => s === tok.toLowerCase())) return true;

    // 由版本词拼接而成（如 "ピアノカバー"、"ボカロオリジナル"）
    let rest = s;
    const sorted = VERSION_ONLY_TOKENS.slice().sort((a, b) => b.length - a.length);
    for (const tok of sorted) {
      const tk = tok.toLowerCase();
      while (rest.indexOf(tk) === 0) rest = rest.slice(tk.length);
    }
    if (rest === '' && s.length > 0) return true;

    // 含版本标记规则且长度很短（说明整段就是版本说明）
    if (s.length <= 6 && VERSION_RULES.some(v => v.re.test(s))) return true;

    return false;
  }

  /**
   * 主解析函数
   * @param {string} rawTitle 原始标题
   * @returns {{songName:string, artist:string, version:string, quality:string, cleanTitle:string}}
   */
  function parseTitle(rawTitle) {
    let title = normalizeWidth(rawTitle || '');
    const bracketContents = [];
    const quotedTitles = [];   // 书名号里的歌名候选

    // 0) 先抓出《》/〈〉里的内容 —— 这些通常就是歌名本身
    for (const re of TITLE_QUOTE_RES) {
      const rx = new RegExp(re.source, re.flags);
      let m;
      while ((m = rx.exec(title)) !== null) {
        const t = String(m[1]).trim();
        if (t && !isNoise(t)) quotedTitles.push(t);
      }
    }

    // 1) 收集所有非书名号括号内容，并把噪音括号从标题中剥离
    for (const re of BRACKETS) {
      title = title.replace(re, (match, inner) => {
        const txt = String(inner).trim();
        bracketContents.push(txt);
        if (isNoise(txt)) return ' ';   // 噪音标签整体丢弃
        return match;                   // 保留可能有意义的（如歌手名）
      });
    }

    // 2) 检测版本标记（先在原标题全文里找）
    let version = '';
    const fullText = normalizeWidth(rawTitle || '');
    for (const rule of VERSION_RULES) {
      if (rule.re.test(fullText)) { version = rule.key; break; }
    }

    // 3) 检测画质标签（仅作展示用）
    let quality = '';
    const qm = fullText.match(/(4k|8k|1080p|720p|高清|超清|蓝光|无损|hifi|hdr)/i);
    if (qm) quality = qm[1].toUpperCase();

    // 4) 去掉所有括号（现在含《》），得到干净主歌名
    let clean = title;
    for (const [open, close] of BRACKET_PAIRS) {
      const re = new RegExp(`\\${open}[^\\${close}]{0,80}\\${close}`, 'g');
      clean = clean.replace(re, ' ');
    }

    // 5) 去掉残留的噪音词与质量词
    for (const re of NOISE_PATTERNS) {
      const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
      clean = clean.replace(new RegExp(re.source, flags), ' ');
    }
    // 保留 "/" 供后续「歌名 / 歌手」拆分使用，只清理竖线和反斜杠
    clean = clean.replace(/[|\\]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

    // 6) 拆除歌手与歌名
    let songName = '';
    let artist = '';

    // 6.0  预清洗：剥离 feat. 合作者标注、斜杠后的节目名
    //      "Neru - 東京テディベア feat.鏡音リン" → "Neru - 東京テディベア"
    //      "Aimer - 残響散歌 / THE FIRST TAKE" → "Aimer - 残響散歌"
    const beforeFeat = clean;
    clean = clean.replace(FEAT_RE, ' ').trim();
    clean = clean.replace(SLASH_TAIL_RE, ' ').trim();
    if (!clean) clean = beforeFeat;

    // 6.1  引号/书名号里的内容优先当歌名（最可靠）
    //      但要用 isVersionOnlyToken 排除「」里是版本说明的情况
    const quoted = quotedTitles.find(t =>
      t && !isNoise(t) && !isVersionOnlyToken(t) && t.length >= 1
    );
    if (quoted) {
      songName = quoted;
      // 引号前缀可能就是歌手："YOASOBI「夜に駆ける」" → artist=YOASOBI
      const idx = clean.indexOf(quoted);
      if (idx > 0) {
        const prefix = clean.slice(0, idx).replace(/[「『《〈\s]+$/g, '').trim();
        if (prefix && looksLikeArtist(prefix) && prefix.length <= 20) {
          artist = prefix;
        }
      }
    }

    // 6.2  歌曲名还没定 → 分析 clean 里的 "A - B" / "歌名 by 歌手" / "歌名 / 歌手"
    if (!songName) {
      const dashMatch = clean.match(/^(.{1,40}?)\s*[-–—]\s*(.{1,60})$/);
      const slashMatch = clean.match(SLASH_ARTIST_RE);
      const byMatch = clean.match(/^(.{1,60}?)\s+by\s+(.{1,40})$/i);

      if (dashMatch) {
        let split = splitByDash(dashMatch[1].trim(), dashMatch[2].trim(), version);
        // 右侧可能还带版本后缀（"米津玄師 ピアノver"），剥离后再判一次
        const rightClean = split.song.replace(/\s*\S*(ピアノ|ギター|カラオケ|アコースティック|ver\.?|バージョン)\S*\s*$/i, '').trim();
        if (rightClean && rightClean !== split.song) {
          // 右侧原本是歌手（带版本后缀），修正
          if (looksLikeArtist(rightClean) && !isVersionOnlyToken(rightClean)) {
            split = { artist: rightClean, song: split.artist };
          } else {
            split.song = rightClean;
          }
        }
        artist = split.artist;
        songName = split.song;
      } else if (byMatch) {
        songName = byMatch[1].trim();
        artist = byMatch[2].trim();
      } else if (slashMatch) {
        // "歌名 / 歌手" 或 "歌手 / 歌名"
        // 歌手名的 scoreAsArtist 通常更高（更简短、更像人名），
        // 但也可能是反向（歌名更短）。用「短的一侧更可能是歌手」兜底。
        const left = slashMatch[1].trim();
        const right = slashMatch[2].trim();
        const ls = scoreAsArtist(left, version);
        const rs = scoreAsArtist(right, version);
        if (Math.abs(ls - rs) <= 2) {
          // 得分接近时用长度判断：短的是歌手
          if (left.length <= right.length) { artist = left; songName = right; }
          else { artist = right; songName = left; }
        } else if (ls > rs) {
          artist = left; songName = right;
        } else {
          artist = right; songName = left;
        }
      }
    }

    // 6.3  歌名从 clean 里拿的，还能从括号里补歌手
    if (!artist) {
      artist = guessArtistFromBrackets(bracketContents);
    }

    // 6.4  clean 里若残留歌手前缀（"五月天 温柔"），抠出来
    if (!artist && songName && clean) {
      const rest = clean.replace(songName, ' ').replace(/\s{2,}/g, ' ').trim();
      // rest 可能是 "五月天" 或 "五月天 高音质"
      const parts = rest.split(/\s+/).filter(Boolean);
      const cand = parts.find(p => looksLikeArtist(p) && !isNoise(p));
      if (cand) artist = cand;
    }

    // 6.5  还没歌名 → 用 clean 整串
    if (!songName) {
      songName = clean;
    }

    // 6.6  歌名被误判成长串（含空格）时，取最长的有意义片段
    if (songName && /\s/.test(songName) && songName.length > 30) {
      const parts = songName.split(/\s+/).filter(Boolean);
      parts.sort((a, b) => b.length - a.length);
      if (parts[0]) songName = parts[0];
    }

    // 7) 兜底：歌名太短或为空
    // 先清掉首尾的横线、斜杠、竖线等分隔符
    songName = String(songName)
      .replace(/^[\s\-–—/／|·]+/, '')
      .replace(/[\s\-–—/／|·]+$/, '')
      .trim();
    if (songName.length < 1) {
      // clean 被清空说明整条标题都是标签（如「【作業用BGM】アニソンメドレー」）
      // 这时取原标题里去掉括号后最长的片段，而不是原始整串
      const fallback = fullText.replace(/[【】\[\]（）()〈〉《》「」『』]/g, ' ')
        .replace(/\s{2,}/g, ' ').trim();
      const parts = fallback.split(/\s+/).filter(Boolean);
      parts.sort((a, b) => b.length - a.length);
      songName = (parts[0] || fallback || fullText).slice(0, 60);
    }

    // 8) 歌名里若还残留版本词，去掉（版本已单独记录）
    for (const rule of VERSION_RULES) {
      songName = songName.replace(new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g'), ' ').trim();
    }
    songName = songName.replace(/\s{2,}/g, ' ').trim();

    // 9) 歌名不能是纯噪音
    if (songName && isNoise(songName) && clean) songName = clean.split(' ')[0] || songName;

    // 10) 合辑判定：让下游知道这不是单曲
    const compilation = isCompilation(fullText, '', 0);

    return {
      songName,
      artist,
      version,
      quality,
      isCompilation: compilation,
      cleanTitle: fullText
    };
  }

  /**
   * 版本合并策略
   * 有些版本差异不改变"是不是同一首歌"的直觉判断：
   *   - Live / 现场版 → 通常视作同一首歌
   *   - Remake / 重制 → 视作同一首歌
   * 而以下版本是"不同的演绎"，应当分开计数：
   *   - 翻唱 / AI翻唱 / Remix / 钢琴版 / 吉他版 / 纯音乐 / 各种语言版 / Demo
   *
   * 'merge'   = 并入原曲 key
   * 'separate' = 独立 key
   */
  const VERSION_MERGE = {
    'Live': 'merge',
    'Remake': 'merge',
    '原唱': 'merge',
    '翻唱': 'separate',
    'AI翻唱': 'separate',
    'Remix': 'separate',
    '钢琴版': 'separate',
    '吉他版': 'separate',
    'Acoustic': 'separate',
    '纯音乐': 'separate',
    '中文版': 'separate',
    '日语版': 'separate',
    '粤语版': 'separate',
    '英文版': 'separate',
    'Demo': 'separate'
  };

  /**
   * 生成歌曲级 key
   * @param {object} parsed parseTitle 的结果
   * @param {boolean} [mergeSimilar=true] 是否合并 Live/Remake 等近似版本
   */
  function makeSongKey(parsed, mergeSimilar) {
    if (mergeSimilar === undefined) mergeSimilar = true;
    const name = normalizeName(parsed.songName) || normalizeName(parsed.cleanTitle).slice(0, 30);
    let ver = parsed.version || 'original';
    if (mergeSimilar && VERSION_MERGE[ver] === 'merge') {
      ver = 'original';
    }
    return `${name}|${ver}`;
  }

  const api = {
    parseTitle,
    makeSongKey,
    normalizeName,
    normalizeWidth,
    isNoise,
    isCompilation,
    isVersionOnlyToken,
    scoreAsArtist,
    splitByDash,
    VERSION_RULES,
    VERSION_MERGE,
    VERSION_ONLY_TOKENS,
    COMPILATION_RES
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BiliParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
