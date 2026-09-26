/**
 * test-ai.js — ai.js 自测
 * 运行： node test/test-ai.js
 */

const path = require('path');
require(path.join(__dirname, '..', 'src', 'parser.js'));
const Parser = globalThis.BiliParser;
const Ai = require(path.join(__dirname, '..', 'src', 'ai.js'));

let pass = 0, fail = 0;

function eq(a, b, label) {
  if (String(a) === String(b)) pass++;
  else { fail++; console.log(`  ✗ ${label}\n      got: ${JSON.stringify(a)}\n      exp: ${JSON.stringify(b)}`); }
}
function truthy(v, label) {
  if (v) pass++; else { fail++; console.log(`  ✗ ${label} (got ${JSON.stringify(v)})`); }
}
function falsy(v, label) {
  if (!v) pass++; else { fail++; console.log(`  ✗ ${label} (got ${JSON.stringify(v)})`); }
}

// ============ prompt 构建 ============
console.log('\n=== prompt 构建 ===');

const msgs = Ai.buildMessages({
  title: '【ピアノ】千本桜', up: 'piano ch', tid: 59, tname: '演奏',
  duration: 260, desc: 'x'.repeat(900)
});
eq(msgs.length, 2, 'messages 两条（system + user）');
eq(msgs[0].role, 'system', '第一条是 system');
eq(msgs[1].role, 'user', '第二条是 user');
truthy(msgs[1].content.indexOf('【ピアノ】千本桜') >= 0, 'user 内容含标题');
truthy(msgs[1].content.indexOf('【示例】') >= 0, 'user 内容含 few-shot');
truthy(msgs[1].content.indexOf('【现在处理】') >= 0, 'user 内容含当前输入标记');
falsy(msgs[1].content.indexOf('x'.repeat(600)) >= 0, 'desc 被截断到 500 字');

const msgs2 = Ai.buildMessages({ title: 'abc', part: 'P3 某首歌' });
truthy(msgs2[1].content.indexOf('P3 某首歌') >= 0, '支持 part 字段');

// ============ JSON 提取 ============
console.log('\n=== JSON 提取 ===');

let r = Ai.extractJson('{"isMusic":true,"songName":"千本桜"}');
eq(r.isMusic, true, '纯 JSON');
eq(r.songName, '千本桜', '纯 JSON 歌名');

r = Ai.extractJson('```json\n{"isMusic":true}\n```');
eq(r.isMusic, true, 'markdown 代码块');

r = Ai.extractJson('好的，我的判断是：\n{"isMusic":false,"confidence":0.9}\n以上。');
eq(r.isMusic, false, '前后有说明文字');

r = Ai.extractJson('{"isMusic":true,}');
eq(r.isMusic, true, '尾随逗号');

r = Ai.extractJson('{"a":"含{花括号}的字符串","isMusic":true}');
eq(r.isMusic, true, '字符串内的花括号不破坏解析');

r = Ai.extractJson('{"name":"说 \\"引号\\" 测试","isMusic":true}');
eq(r.isMusic, true, '转义引号');

r = Ai.extractJson('完全不是 JSON');
eq(r, null, '非 JSON 返回 null');

r = Ai.extractJson('');
eq(r, null, '空字符串返回 null');

r = Ai.extractJson('{"nested":{"a":{"b":1}},"isMusic":true}');
eq(r.isMusic, true, '嵌套对象');

// ============ 版本归一化 ============
console.log('\n=== 版本归一化 ===');

eq(Ai.normalizeVersion('翻唱'), '翻唱', '标准值直接通过');
eq(Ai.normalizeVersion('original'), 'original', 'original 通过');
eq(Ai.normalizeVersion('オリジナル'), 'original', 'オリジナル → original');
eq(Ai.normalizeVersion('本家'), 'original', '本家 → original');
eq(Ai.normalizeVersion('原唱'), 'original', '原唱 → original');
eq(Ai.normalizeVersion('歌ってみた'), '翻唱', '歌ってみた → 翻唱');
eq(Ai.normalizeVersion('カバー'), '翻唱', 'カバー → 翻唱');
eq(Ai.normalizeVersion('cover'), '翻唱', 'cover → 翻唱');
eq(Ai.normalizeVersion('ピアノ'), '钢琴版', 'ピアノ → 钢琴版');
eq(Ai.normalizeVersion('piano version'), '钢琴版', 'piano version → 钢琴版');
eq(Ai.normalizeVersion('カラオケ'), '纯音乐', 'カラオケ → 纯音乐');
eq(Ai.normalizeVersion('instrumental'), '纯音乐', 'instrumental → 纯音乐');
eq(Ai.normalizeVersion('ライブ'), 'Live', 'ライブ → Live');
eq(Ai.normalizeVersion('リミックス'), 'Remix', 'リミックス → Remix');
eq(Ai.normalizeVersion('替え歌'), '替え歌', '替え歌 通过');
eq(Ai.normalizeVersion('パロディ'), '替え歌', 'パロディ → 替え歌');
eq(Ai.normalizeVersion('AI翻唱'), 'AI翻唱', 'AI翻唱 通过');
eq(Ai.normalizeVersion('AI Cover'), 'AI翻唱', 'AI Cover → AI翻唱（大小写）');
eq(Ai.normalizeVersion(''), '', '空值返回空');
eq(Ai.normalizeVersion(null), '', 'null 返回空');
eq(Ai.normalizeVersion('日式摇滚版'), '其他', '无法识别的值 → 其他');
eq(Ai.normalizeVersion('抒情吉他弹唱'), '吉他版', '含关键词 → 模糊匹配到吉他版');

// 归一化后的值必须在合法枚举内
const weird = ['随便什么', 'abc', '翻唱版', 'live现场', '纯音乐ver'];
weird.forEach(w => {
  truthy(Ai.VALID_VERSIONS.indexOf(Ai.normalizeVersion(w)) >= 0,
    `「${w}」归一化结果在合法枚举内`);
});

// ============ 响应校验 ============
console.log('\n=== 响应校验 ===');

const fallback = {
  isMusic: true, isCompilation: false,
  songName: '千本桜', artist: '初音ミク', version: '翻唱', confidence: 0.7
};

r = Ai.validateResult({
  isMusic: true, isCompilation: false, songName: '千本桜',
  artist: '初音ミク', version: 'original', confidence: 0.95, reason: 'ok'
}, fallback);
truthy(r.ok, '完整响应校验通过');
eq(r.result.version, 'original', 'version 保留');
eq(r.result.confidence, 0.95, 'confidence 保留');
eq(r.result.reason, 'ok', 'reason 保留');

r = Ai.validateResult({ songName: 'x' }, null);
falsy(r.ok, '缺 isMusic 且 fallback 也无 → 失败');

r = Ai.validateResult({ songName: 'x' }, fallback);
truthy(r.ok, '缺 isMusic 但 fallback 有 → 用 fallback 补');

r = Ai.validateResult(null, fallback);
falsy(r.ok, 'null 输入失败');

r = Ai.validateResult({ isMusic: 'yes' }, fallback);
truthy(r.ok, 'isMusic 非布尔 → 用 fallback 补');
eq(r.result.isMusic, true, 'isMusic 来自 fallback');
truthy(r.result.confidence <= 0.5, '补来的 isMusic 置信度被压低');

r = Ai.validateResult({ isMusic: false, songName: '不该保留' }, fallback);
eq(r.result.songName, '', '非音乐 → 清空歌名');
eq(r.result.version, '', '非音乐 → 清空版本');

r = Ai.validateResult({ isMusic: true, songName: '', artist: '' }, fallback);
eq(r.result.songName, '千本桜', '歌名为空 → 用 fallback 补');
eq(r.result.fromFallbackName, true, '标记来自 fallback');

r = Ai.validateResult({ isMusic: true, confidence: 99 }, fallback);
eq(r.result.confidence, 1, 'confidence 超范围被夹紧');
r = Ai.validateResult({ isMusic: true, confidence: -5 }, fallback);
eq(r.result.confidence, 0, 'confidence 负值被夹紧');
r = Ai.validateResult({ isMusic: true, confidence: 'abc' }, fallback);
eq(r.result.confidence, 0.5, 'confidence 非数字 → 默认 0.5');

r = Ai.validateResult({
  isMusic: true, songName: 'x', version: '乱七八糟的版本', reason: 'y'.repeat(500)
}, fallback);
truthy(Ai.VALID_VERSIONS.indexOf(r.result.version) >= 0, '非法 version 被归一化');
truthy(r.result.reason.length <= 200, 'reason 被截断');

// ============ 端到端：parseResponse ============
console.log('\n=== 端到端解析 ===');

r = Ai.parseResponse('```json\n{"isMusic":true,"songName":"Lemon","artist":"米津玄師","version":"original","confidence":0.9}\n```', fallback);
truthy(r.ok, '代码块包裹的响应解析成功');
eq(r.result.songName, 'Lemon', '歌名正确');
eq(r.result.artist, '米津玄師', '歌手正确');

r = Ai.parseResponse('模型胡言乱语', fallback);
falsy(r.ok, '非 JSON 响应失败');
eq(r.error, 'json-parse-failed', '错误类型正确');

// ============ 与规则结果的对比 ============
console.log('\n=== 与规则结果对比 ===');

const rule1 = { isMusic: true, isCompilation: false, songName: '千本桜', version: 'original' };

let d = Ai.diffFromRule({ isMusic: true, isCompilation: false, songName: '千本桜', version: 'original' }, rule1);
falsy(d.changed, '完全一致 → 无差异');

d = Ai.diffFromRule({ isMusic: false, isCompilation: false, songName: '', version: '' }, rule1);
truthy(d.changed, 'isMusic 不同 → 有差异');
truthy(d.fields.indexOf('isMusic') >= 0, '标记了 isMusic 字段');

d = Ai.diffFromRule({ isMusic: true, isCompilation: false, songName: '千本桜', version: '钢琴版' }, rule1);
truthy(d.changed, 'version 不同 → 有差异（关键：钢琴版不该并入原曲）');

d = Ai.diffFromRule({ isMusic: true, isCompilation: false, songName: '千本桜', version: 'Live' }, rule1);
falsy(d.changed, 'Live 会并入 original → 不算差异');

d = Ai.diffFromRule({ isMusic: true, isCompilation: false, songName: '别的歌', version: 'original' }, rule1);
truthy(d.changed, '歌名不同 → 有差异');

d = Ai.diffFromRule({ isMusic: true, isCompilation: false, songName: '千 本 桜', version: 'original' }, rule1);
falsy(d.changed, '歌名仅空格差异 → 不算差异（归一化比较）');

d = Ai.diffFromRule(null, rule1);
falsy(d.changed, 'null 输入安全');

// ============ AI songKey 生成 ============
console.log('\n=== AI songKey 生成 ===');

const k1 = Ai.makeSongKeyFromAi({ songName: '千本桜', version: 'original' }, true);
const k2 = Parser.makeSongKey(Parser.parseTitle('【初音ミク】千本桜'));
eq(k1, k2, 'AI 产出的 key 与规则引擎口径一致');

const k3 = Ai.makeSongKeyFromAi({ songName: '千本桜', version: '钢琴版' }, true);
const k4 = Parser.makeSongKey(Parser.parseTitle('【ピアノ】千本桜'));
eq(k3, k4, '钢琴版 key 一致（关键：AI 与规则能对上）');

eq(Ai.makeSongKeyFromAi({ songName: '', version: '翻唱' }, true), '', '无歌名 → 空 key');
eq(Ai.makeSongKeyFromAi({ songName: 'x', version: '其他' }, true), 'x|original', '「其他」版本 → 归入 original');
falsy(Ai.makeSongKeyFromAi(null, true), 'null 输入 → 空 key');

// ============ 缓存有效性 ============
console.log('\n=== 缓存有效性 ===');

const cacheEntry = { result: { isMusic: true }, title: '千本桜' };
truthy(Ai.isCacheValid(cacheEntry, { title: '千本桜' }), '标题未变 → 缓存有效');
falsy(Ai.isCacheValid(cacheEntry, { title: '新标题' }), '标题变了 → 缓存失效');
falsy(Ai.isCacheValid(null, { title: 'x' }), 'null 缓存 → 无效');
falsy(Ai.isCacheValid({ title: 'x' }, { title: 'x' }), '无 result → 无效');
truthy(Ai.isCacheValid(cacheEntry, {}), '无标题信息 → 默认有效');

// ============ 降级形状转换 ============
console.log('\n=== 降级形状 ===');

const shaped = Ai.toRuleShape(
  { isMusic: true, isCompilation: false, songName: '千本桜', artist: '', version: '其他', confidence: 0.9, reason: 'r' },
  {}
);
eq(shaped.version, '', '「其他」版本 → 空（避免污染 key）');
eq(shaped.fromAi, true, '标记 fromAi');
eq(shaped.isMusic, true, 'isMusic 保留');

console.log(`\n${'='.repeat(40)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
