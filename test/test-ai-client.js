/**
 * test-ai-client.js — AI 客户端测试
 *
 * 覆盖：
 *  - 端点归一化
 *  - 各种兼容格式的响应正文提取
 *  - shouldAskAi 三层调度决策
 *  - planApply 的回溯修正操作生成
 *  - 幂等性
 */

'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const Parser = require(path.join(ROOT, 'src', 'parser.js'));
global.BiliParser = Parser;
const Ai = require(path.join(ROOT, 'src', 'ai.js'));
global.BiliAi = Ai;
const AIClient = require(path.join(ROOT, 'src', 'ai-client.js'));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '\n      ' + extra : ''}`); }
}
function eq(got, exp, label) {
  ok(got === exp, label, got === exp ? '' : `got: ${JSON.stringify(got)}  exp: ${JSON.stringify(exp)}`);
}

console.log('\n=== 端点归一化 ===');
eq(AIClient.normalizeEndpoint('api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions', '裸域名自动补路径');
eq(AIClient.normalizeEndpoint('https://api.openai.com/v1/'), 'https://api.openai.com/v1', '尾部斜杠去掉');
eq(AIClient.normalizeEndpoint('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1/chat/completions', '完整路径不动');
eq(AIClient.normalizeEndpoint(''), '', '空值返回空');
eq(AIClient.normalizeEndpoint('  '), '', '纯空白返回空');

console.log('\n=== 响应正文提取 ===');
eq(AIClient.extractContent({ choices: [{ message: { content: 'hi' } }] }), 'hi', '标准 OpenAI 格式');
eq(AIClient.extractContent({ choices: [{ delta: { content: 'stream' } }] }), 'stream', '流式 delta 格式');
eq(AIClient.extractContent({
  choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }]
}), 'ab', '数组型 content 拼接');
eq(AIClient.extractContent({}), '', '空对象返回空');
eq(AIClient.extractContent(null), '', 'null 返回空');
eq(AIClient.extractContent({ choices: [] }), '', '空 choices 返回空');
eq(AIClient.extractContent({
  choices: [{ delta: { content: [{ text: 'x' }] } }]
}), 'x', '流式 + 数组混合');

console.log('\n=== 三层调度决策 ===');
eq(AIClient.shouldAskAi({ confidence: 0.9 }, { aiChannel: 'direct' }).ask, false, '高置信度不调 AI');
eq(AIClient.shouldAskAi({ confidence: 0.5 }, { aiChannel: 'direct' }).ask, true, '低置信度调 AI');
eq(AIClient.shouldAskAi({ confidence: 0.5 }, { aiChannel: 'off' }).ask, false, '关闭通道不调 AI');
eq(AIClient.shouldAskAi({ confidence: 0.5 }, { aiChannel: 'queue' }).ask, true, '队列通道照常入队');
eq(AIClient.shouldAskAi({ confidence: 0.85 }, { aiChannel: 'direct' }).ask, false, '正好等于阈值不调（>=）');
eq(AIClient.shouldAskAi({ confidence: 0.84 }, { aiChannel: 'direct' }).ask, true, '略低于阈值调');
eq(AIClient.shouldAskAi({ confidence: 0.5 }, { aiChannel: 'direct', aiConfidenceThreshold: 0.6 }).ask, true, '自定义阈值生效');
eq(AIClient.shouldAskAi({ confidence: 0.5 }, { aiChannel: 'direct', aiConfidenceThreshold: 0.4 }).ask, false, '自定义阈值（高）跳过');
eq(AIClient.shouldAskAi({ confidence: 0.5 }, { aiChannel: 'direct', aiConfidenceThreshold: 'abc' }).ask, true, '非法阈值回落默认');
eq(AIClient.shouldAskAi(null, { aiChannel: 'direct' }).ask, true, '无判定结果 → 调 AI');

console.log('\n=== planApply：AI 判为非音乐 → 回溯扣减 ===');
{
  const plan = AIClient.planApply({
    aiResult: { isMusic: false, isCompilation: false, songName: '', artist: '', version: '', confidence: 0.95 },
    ruleResult: { isMusic: true, isCompilation: false, songName: '某歌', version: 'original', confidence: 0.5 },
    oldSongKey: '某歌|original',
    oldVideoKey: 'BV1',
    videoEntry: { appliedAiRevision: 0 },
    settings: { mergeSimilarVersions: true },
    aiRevision: 1
  });
  const types = plan.ops.map(o => o.type);
  ok(types.includes('video.decrement'), '含视频级扣减');
  ok(types.includes('song.decrement'), '含歌曲级扣减');
  eq(plan.note, 'ai-not-music', 'note 标注为非音乐');
}

console.log('\n=== planApply：规则漏判 → AI 补记 ===');
{
  const plan = AIClient.planApply({
    aiResult: { isMusic: true, isCompilation: false, songName: 'Lemon', artist: '', version: 'original', confidence: 0.9 },
    ruleResult: { isMusic: false, isCompilation: false, songName: '', version: '', confidence: 0.4 },
    oldSongKey: '',
    oldVideoKey: 'BV2',
    videoEntry: { appliedAiRevision: 0 },
    settings: { mergeSimilarVersions: true },
    aiRevision: 1
  });
  const types = plan.ops.map(o => o.type);
  ok(types.includes('video.increment'), '含视频级补记');
  ok(types.includes('song.increment'), '含歌曲级补记');
  const si = plan.ops.find(o => o.type === 'song.increment');
  eq(si.key, 'lemon|original', '补记的 songKey 正确');
}

console.log('\n=== planApply：songKey 迁移（AI 解析出正确歌名） ===');
{
  const plan = AIClient.planApply({
    aiResult: { isMusic: true, isCompilation: false, songName: '千本桜', artist: '初音ミク', version: 'original', confidence: 0.95 },
    ruleResult: { isMusic: true, isCompilation: false, songName: '初音ミク', artist: '', version: 'original', confidence: 0.6 },
    oldSongKey: '初音ミク|original',
    oldVideoKey: 'BV3',
    videoEntry: { appliedAiRevision: 0 },
    settings: { mergeSimilarVersions: true },
    aiRevision: 1
  });
  const mig = plan.ops.find(o => o.type === 'song.migrate');
  ok(!!mig, '含 songKey 迁移操作');
  eq(mig.from, '初音ミク|original', '迁移源正确');
  eq(mig.to, '千本桜|original', '迁移目标正确');
}

console.log('\n=== planApply：改判为合辑 → 撤掉歌曲级 ===');
{
  const plan = AIClient.planApply({
    aiResult: { isMusic: true, isCompilation: true, songName: 'アニソンメドレー', artist: '', version: 'original', confidence: 0.9 },
    ruleResult: { isMusic: true, isCompilation: false, songName: 'アニソンメドレー', version: 'original', confidence: 0.6 },
    oldSongKey: 'アニソンメドレー|original',
    oldVideoKey: 'BV4',
    videoEntry: { appliedAiRevision: 0 },
    settings: { mergeSimilarVersions: true },
    aiRevision: 1
  });
  const types = plan.ops.map(o => o.type);
  ok(types.includes('video.isCompilation'), '标记为合辑');
  const drop = plan.ops.find(o => o.type === 'song.migrate' && o.drop);
  ok(!!drop, '含 drop 型迁移（撤掉歌曲级计数）');
}

console.log('\n=== planApply：幂等性 ===');
{
  const plan = AIClient.planApply({
    aiResult: { isMusic: true, isCompilation: false, songName: 'x', version: 'original', confidence: 0.9 },
    ruleResult: { isMusic: true, isCompilation: false, songName: 'y', version: 'original', confidence: 0.5 },
    oldSongKey: 'y|original',
    oldVideoKey: 'BV5',
    videoEntry: { appliedAiRevision: 3 },   // 已应用过 revision 3
    settings: {},
    aiRevision: 3
  });
  eq(plan.ops.length, 0, '同 revision 不产生操作');
  eq(plan.note, 'already-applied', 'note 标注已应用');
}

console.log('\n=== planApply：无实质变化 ===');
{
  const plan = AIClient.planApply({
    aiResult: { isMusic: true, isCompilation: false, songName: '晴天', artist: '周杰伦', version: 'original', confidence: 0.95 },
    ruleResult: { isMusic: true, isCompilation: false, songName: '晴天', version: 'original', confidence: 0.7 },
    oldSongKey: '晴天|original',
    oldVideoKey: 'BV6',
    videoEntry: { appliedAiRevision: 0 },
    settings: { mergeSimilarVersions: true },
    aiRevision: 1
  });
  const nonMark = plan.ops.filter(o => o.type !== 'video.markApplied');
  eq(nonMark.length, 0, '无修正操作（仅标记）');
  eq(plan.note, 'no-change', 'note 标注无变化');
}

console.log('\n=== planApply：Live 版本合并（不应触发迁移） ===');
{
  const plan = AIClient.planApply({
    aiResult: { isMusic: true, isCompilation: false, songName: '晴天', artist: '', version: 'Live', confidence: 0.9 },
    ruleResult: { isMusic: true, isCompilation: false, songName: '晴天', version: 'original', confidence: 0.6 },
    oldSongKey: '晴天|original',
    oldVideoKey: 'BV7',
    videoEntry: { appliedAiRevision: 0 },
    settings: { mergeSimilarVersions: true },
    aiRevision: 1
  });
  const mig = plan.ops.find(o => o.type === 'song.migrate');
  eq(mig, undefined, 'Live 并入 original，不迁移');
}

console.log('\n=== planApply：关闭版本合并时 Live 应迁移 ===');
{
  const plan = AIClient.planApply({
    aiResult: { isMusic: true, isCompilation: false, songName: '晴天', artist: '', version: 'Live', confidence: 0.9 },
    ruleResult: { isMusic: true, isCompilation: false, songName: '晴天', version: 'original', confidence: 0.6 },
    oldSongKey: '晴天|original',
    oldVideoKey: 'BV8',
    videoEntry: { appliedAiRevision: 0 },
    settings: { mergeSimilarVersions: false },
    aiRevision: 1
  });
  const mig = plan.ops.find(o => o.type === 'song.migrate');
  ok(!!mig, '关闭合并后 Live 单独计数，触发迁移');
  eq(mig.to, '晴天|Live', '迁移目标为 Live 版本 key');
}

console.log('\n=== planApply：边界输入 ===');
eq(AIClient.planApply({ aiResult: null }).note, 'no-ai-result', '无 AI 结果 → 无操作');
eq(
  AIClient.planApply({ aiResult: { isMusic: false } }).ops.filter(o => o.type !== 'video.markApplied').length,
  0, '仅 isMusic=false 无规则结果 → 无修正操作');
ok(Array.isArray(AIClient.planApply({ aiResult: { isMusic: true, songName: 'x' } }).ops), '缺上下文不抛异常');
eq(AIClient.planApply({}).note, 'no-ai-result', '空对象不抛异常');

console.log('\n========================================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
