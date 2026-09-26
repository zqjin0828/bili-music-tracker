/**
 * detector.js — 音乐视频判定
 *
 * 多信号加权打分，输出 0~1 的置信度。
 * 需要 parser.js 已加载（提供 VERSION_RULES）。
 */

(function (root) {
  'use strict';

  const Parser = root.BiliParser;

  // ---------- B站音乐相关分区 TID ----------
  // 3:音乐  28:原创音乐  29:三次元音乐  30:VOCALOID·UTAU  31:翻唱
  // 59:演奏  130:音乐综合  193:MV  194:电音  195:音乐现场  196:音乐教学
  // 197:音乐教学  198:MV  243、267:音乐类（实测音乐占比 ≥78%）
  const MUSIC_TIDS = new Set([
    3, 28, 29, 30, 31, 59, 130, 193, 194, 195, 196, 197, 198, 243, 267
  ]);

  // 音乐倾向但混杂的分区（给部分加分，不给"音乐区"那样的置信度兜底）
  // 依据：对 430 首人工核对过的音乐做统计，这些分区音乐占比 17%~53%
  const WEAK_MUSIC_TIDS = new Set([
    121,  // 92% (12/13)
    51,   // 89% (8/9)   番剧相关（BD/Live 影像）
    152,  // 50% (14/28) 番剧相关
    137,  // 53% (10/19)
    26,   // 29%
    172,  // 20%
    242,  // 45%
    255,  // 50%
    259   // 50%
  ]);

  // 明确不是音乐的分区
  //
  // ★ 注意：这里**不再包含** 21（日常）/ 160（生活）。
  //   实测 21 区里有 24 首是音乐（生活区发翻唱/MV 很常见），
  //   一旦列入就等于对这些曲子"一票否决"，用户会遇到「明明听了却不计数」。
  //   分区只作为负分参考（-2），最终由总分决定。
  const NEGATIVE_TIDS = new Set([
    4,    // 游戏
    17,   // 单机游戏
    36,   // 科技
    188,  // 数码
    95,   // 数码
    138,  // 搞笑
    202,  // 资讯
    208,  // 财经
    209,  // 时尚
    211,  // 美食
    217,  // 动物
    234,  // 运动
    249,  // 生活兴趣
    250,  // 生活经验
    76,   // 美食制作
    119,  // 鬼畜（可能是音MAD，但整体不算）
    155,  // 时尚
    181,  // 影视
    182,  // 影视杂谈
    // 番剧/国创/电影/电视剧/纪录片/课程
    13, 33, 23, 11, 177, 1005, 1006
  ]);

  // 标题音乐关键词
  const MUSIC_TITLE_RES = [
    /翻唱|cover/i, /原唱/, /mv/i, /音乐/i, /歌曲/, /单曲/, /专辑/, /ost/i,
    /主题曲|片头曲|片尾曲|插曲|ed\b|op\b/i, /歌手/, /乐队/, /弹唱/, /演奏/,
    /钢琴|吉他|小提琴|古筝|二胡|笛子|琵琶|架子鼓|爵士鼓/, /纯音乐|instrumental|伴奏/i,
    /remix|电音|dj\b/i, /vocaloid|初音|洛天依|镜音|巡音|gumi|ia\b/i,
    /live|现场|演唱会|音乐会/i, /高音质|无损|hifi/i,
    /翻自|填词|改编曲|remake/i, /情歌|民谣|摇滚|说唱|rap\b/i,
    /bgm|背景音乐/i, /循环/, /洗脑/, /歌ってみた|歌含/i,
    // ★ 补充：实测这些词在用户的曲库里高频出现，原先漏了
    /歌词|歌詞|lyric/i, /双语|中日|中字|字幕/i, /唱了|唱过|唱歌|试唱/,
    /pv\b/i, /主题歌/, /曲|歌(?![曲词单])/, /动画mv|公式|official/i,
    /solo|full\s*size|完整版|纯享/i, /カバー|オリジナル|歌枠/i,
    /安可|翻弹|改编|重编|钢琴曲|口琴/i
  ];

  // ---------- 企划 / 歌手实体（强信号）----------
  //
  // ★ 原判定器没有这一路信号，是召回率偏低的主因：
  //   「【峰月律】【双语歌词】Lemon」这类标题里没有任何通用音乐词，
  //   但「峰月律」本身就是决定性证据。
  //   这批词表来自对 430 首人工核对音乐的反推，命中率高。
  const MUSIC_ENTITY_RES = [
    /夢ノ結唱|夢限大|峰月律|宫永野乃花|藤都子|仲町阿拉蕾|艾蕾亚|切蒲英|巫てんり|人生不易部/i,
    /bang\s*dream|バンドリ|mygo|ave\s*mujica|poppin|roselia|morfonica|afterglow|pastel/i,
    /raise\s*a\s*suilen|邦多利|ゆめ∞みた|yume∞mita|ガルパ/i,
    /lovelive|love\s*live|虹咲|虹之咲|虹学会|µ's|aqours|liella|蓮ノ空|莲之空|学园偶像/i,
    /スクールアイドル|偶像活动|アイカツ|superstar|azuna|a·zu·na/i,
    /偶像大师|アイドルマスター|idolm@ster|cgss|デレステ|シャニマス|ミリオン/i,
    /世界计划|プロセカ|project\s*sekai|more\s*more\s*jump|vivid\s*bad|nightcord|25時/i,
    /vocaloid|初音|ミク|ボカロ|synthesizer\s*v|synthv|neutrino|东尼/i,
    /高木同学|凉宫|ハルヒ|超电磁炮|とある|无职转生|孤独摇滚|结束乐队|轻音|けいおん/i,
    /光之美少女|プリキュア|赛马娘|ウマ娘|命运石之门|シュタインズ/i,
    /邓丽君|李荣浩|许嵩|温岚|周杰伦|岑宁儿|单依纯|宇多田|米津玄師|米津玄师|まふまふ/i,
    /yorushika|ヨルシカ|yoasobi|zutomayo|tayori|aimer|ado|goose\s*house/i
  ];

  // 明确非音乐的标题特征
  const NEGATIVE_TITLE_RES = [
    /攻略|教程|教学(?!.*(钢琴|吉他|唱歌))/, /解说|评测|开箱|拆解|实验|科普/,
    /直播回放|录播(?!.*(演唱会|音乐会|live))/, /整活|盘点|吐槽|reaction|反应/,
    /纪录片|电影解说|剧情|预告片/, /vlog|日常|挑战|搞笑/,
    /游戏实况|实机|通|对局|排位/, /编程|代码|前端|后端|算法/
  ];

  /**
   * 主判定函数
   * @param {object} info { tid, title, upName, duration, tname }
   * @returns {{ isMusic:boolean, confidence:number, reasons:string[] }}
   */
  function detectMusic(info) {
    const reasons = [];
    let score = 0;
    let maxScore = 0;

    const tid = Number(info.tid) || 0;
    const title = String(info.title || '');
    const upName = String(info.upName || '');
    const tname = String(info.tname || '');
    const duration = Number(info.duration) || 0;

    // ---------- 信号1：分区（权重 3）----------
    maxScore += 3;
    if (MUSIC_TIDS.has(tid)) {
      score += 3;
      reasons.push(`分区命中音乐区(tid=${tid})`);
    } else if (WEAK_MUSIC_TIDS.has(tid)) {
      score += 1.5;
      reasons.push(`分区倾向音乐(tid=${tid})`);
    } else if (NEGATIVE_TIDS.has(tid)) {
      score -= 2;
      reasons.push(`分区倾向非音乐(tid=${tid})`);
    } else if (tname && /音乐/.test(tname)) {
      score += 2.5;
      reasons.push(`分区名为音乐相关(${tname})`);
    }

    // ---------- 信号2：标题关键词（权重 2.5）----------
    maxScore += 2.5;
    let titleHits = 0;
    for (const re of MUSIC_TITLE_RES) {
      if (re.test(title)) titleHits++;
    }
    if (titleHits >= 2) { score += 2.5; reasons.push(`标题命中${titleHits}个音乐词`); }
    else if (titleHits === 1) { score += 1.5; reasons.push('标题命中1个音乐词'); }

    let negHits = 0;
    for (const re of NEGATIVE_TITLE_RES) {
      if (re.test(title)) negHits++;
    }
    if (negHits > 0) {
      score -= Math.min(negHits * 1.5, 4);
      reasons.push(`标题命中${negHits}个非音乐词`);
    }

    // ---------- 信号3：UP主特征（权重 1.5）----------
    maxScore += 1.5;
    if (/音乐|翻唱|歌手|music|cover|band|乐队|歌|唱/i.test(upName)) {
      score += 1.5;
      reasons.push(`UP主名含音乐特征(${upName})`);
    }

    // ---------- 信号5：企划 / 歌手实体（权重 3）----------
    // 与分区同权重：实体名（夢ノ結唱、峰月律、虹咲…）是决定性证据
    maxScore += 3;
    let entityHits = 0;
    const entityBlob = title + ' ' + upName;
    for (const re of MUSIC_ENTITY_RES) {
      if (re.test(entityBlob)) entityHits++;
    }
    if (entityHits >= 1) {
      score += entityHits >= 2 ? 3 : 2.5;
      reasons.push(`命中音乐企划/歌手实体 x${entityHits}`);
    }

    // ---------- 信号4：时长区间（权重 1）----------
    //
    // ★ 这里曾经是「时长短 → 扣分」，是个错误设计：
    //   动漫 ED、插入曲、短版、Vocaloid 短曲大量落在 45~120 秒，
    //   而原逻辑对 <90s 直接扣分、90~120s 完全没有信号（落空区间），
    //   导致「短歌永远不被计数」。时长是弱证据，**只能加分，不该用来否定音乐**。
    maxScore += 1;
    const inMusicZone = MUSIC_TIDS.has(tid);
    if (duration >= 45 && duration < 120) {
      // 短曲：动漫 ED / 插曲 / 短版 —— 给部分加分
      score += inMusicZone ? 1 : 0.6;
      reasons.push(`时长${Math.round(duration)}s（短曲，常见于ED/插曲）`);
    } else if (duration >= 120 && duration <= 720) {
      score += 1;
      reasons.push(`时长${Math.round(duration)}s落在单曲区间`);
    } else if (duration > 1800) {
      // 音乐区的超长视频多是合集/电台，仍属音乐；非音乐区则可疑
      score -= inMusicZone ? 0 : 1;
      if (inMusicZone) {
        score += 0.5;
        reasons.push(`音乐区超长视频(${Math.round(duration)}s)，疑似合集`);
      } else {
        reasons.push(`时长过长(${Math.round(duration)}s)`);
      }
    }
    // <45s：不给分也不扣分（可能是切片、铃声、片段，证据不足而已）

    // ---------- 归一化与判定 ----------
    //
    // ★ 为什么改用「原始分」而不是「score / maxScore」：
    //   归一化会把「本来就不适用的信号」也算成丢分 ——
    //   一首歌的 UP 名不含音乐特征、分区也不是音乐区，这两路本来就是 0，
    //   却让满分变成 11，结果 3 个有效信号只算出 0.27 的置信度。
    //   用原始分判定更贴近语义：**信号够强就算音乐**。
    //
    //   confidence 仅用于展示，按「6 分 = 满分」映射（6 分对应
    //   "音乐区 + 企划实体 + 标题关键词 + 时长" 这种证据很足的情形）。
    const confidence = Math.max(0, Math.min(1, score / 6));

    // 版本标记（如「翻唱」「Live」）是很强的补充信号
    const parsed = Parser && Parser.parseTitle ? Parser.parseTitle(title) : null;
    const hasVersionTag = !!(parsed && parsed.version);

    // 合辑/歌单/电台 —— 是音乐，但不该被当成"单曲"计数
    const isCompilation = Parser && Parser.isCompilation
      ? Parser.isCompilation(title, upName, duration)
      : false;

    // 判定：原始分 ≥ 3.5，或识别出版本标记（且有基本分）
    //
    // 阈值 3.5 是实测扫出来的（对 430 首人工核对音乐 + 1773 首非音乐）：
    //   阈值  召回率   非音乐正确率   F1
    //   2.5   90.9%    89.5%        0.775
    //   3.0   88.5%    91.7%        0.793
    //   3.5   87.1%    92.9%        0.804   ← 取这个（偏向召回）
    //   4.0   84.5%    94.3%        0.812（F1 最高，但漏歌更多）
    //   6.0   63.0%    98.4%        0.743
    // 理由：**漏掉一首听了很多遍的歌，用户根本察觉不到；多计一个非音乐视频，
    //       在弹窗里点一下「排除」就解决了** —— 所以偏向召回。
    const SCORE_MIN = 3.5;
    const isMusic = score >= SCORE_MIN || (hasVersionTag && score >= 2.5);

    if (hasVersionTag) reasons.push(`识别到版本标记:${parsed.version}`);
    if (isCompilation) reasons.push('判定为合辑/歌单（非单曲）');

    return {
      isMusic,
      confidence: Number(confidence.toFixed(3)),
      score: Number(score.toFixed(2)),
      isCompilation,
      reasons
    };
  }

  const api = { detectMusic, MUSIC_TIDS, WEAK_MUSIC_TIDS, NEGATIVE_TIDS };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BiliDetector = api;
})(typeof window !== 'undefined' ? window : globalThis);
