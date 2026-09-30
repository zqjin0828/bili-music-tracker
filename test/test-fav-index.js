/**
 * test-fav-index.js — 验证收藏夹索引模块的核心逻辑
 *
 * 重点验证：
 *   1. pickFolder 在同名/近名收藏夹存在时，选对目标（排除「歌？」）
 *   2. isFaved 的 Set / Array 双支持
 *   3. 真实数据下（276 条 BV）的判定正确性
 */
'use strict';
const fs = require('fs');
const path = require('path');

// 载入模块（它是 IIFE + window/self 双暴露，这里造个假 self）
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'fav-index.js'), 'utf8');
const sandboxSelf = {};
new Function('self', 'window', 'module', src)(sandboxSelf, undefined, undefined);
const FavIndex = sandboxSelf.BiliFavIndex;

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '\n      期望 ' + e + '\n      实际 ' + a); }
}

console.log('==== 1. pickFolder：真实收藏夹列表（含「歌？」干扰）====');
const realFolders = [
  { id: 1000000003, title: '默认收藏夹', media_count: 281, attr: 1 },
  { id: 1000000002, title: '歌？', media_count: 1, attr: 22 },
  { id: 1000000001, title: '歌', media_count: 276, attr: 22 },
  { id: 1000000004, title: '杂项', media_count: 3 },
  { id: 1000000005, title: '鬼畜', media_count: 4 },
  { id: 1000000006, title: '学习', media_count: 19 }
];
const p1 = FavIndex.pickFolder(realFolders, '歌');
eq(p1.folder && p1.folder.id, 1000000001, '选中 media_id=1000000001（真正的「歌」）');
eq(p1.reason, 'exact', '匹配方式为 exact');

console.log('\n==== 2. pickFolder：「歌？」不应被误选 ====');
const onlyQuestion = [
  { id: 1000000002, title: '歌？', media_count: 1 },
  { id: 999, title: '默认收藏夹', media_count: 10 }
];
const p2 = FavIndex.pickFolder(onlyQuestion, '歌');
eq(p2.folder, null, '只有「歌？」时 → 返回 null（不误选）');
eq(p2.reason, 'not-found', '原因是 not-found');

console.log('\n==== 3. pickFolder：多个同名 → 取内容最多的 ====');
const dup = [
  { id: 1, title: '歌', media_count: 5 },
  { id: 2, title: '歌', media_count: 300 }
];
const p3 = FavIndex.pickFolder(dup, '歌');
eq(p3.folder && p3.folder.id, 2, '取 media_count 大的（id=2）');
eq(p3.reason, 'exact-multi', '匹配方式 exact-multi');

console.log('\n==== 4. pickFolder：带空格/全角的宽松匹配 ====');
const loose = [{ id: 7, title: ' 歌 ', media_count: 9 }];
const p4 = FavIndex.pickFolder(loose, '歌');
eq(p4.folder && p4.folder.id, 7, '「 歌 」能匹配上');

console.log('\n==== 5. isFaved：Set 与 Array 双支持 ====');
const setIdx = { bvids: new Set(['BV1a', 'BV1b']), fetchedAt: Date.now() };
eq(FavIndex.isFaved('BV1a', setIdx, { domCheck: false }).faved, true, 'Set 命中');
eq(FavIndex.isFaved('BV9z', setIdx, { domCheck: false }).faved, false, 'Set 未命中');

const arrIdx = { bvids: ['BV1a', 'BV1b'], fetchedAt: Date.now() };
eq(FavIndex.isFaved('BV1b', arrIdx, { domCheck: false }).faved, true, 'Array 命中');

console.log('\n==== 6. isFaved：索引过期标记 ====');
// ★ v1.3.1 行为变更：过期索引**不再参与命中**。
//   原因：索引只增不减地增量刷新，用户若在 B 站网页端手删了收藏，本地索引
//   会永久偏大 → 该计数的歌被误判为「已收藏」而永久跳过计数。
//   过期即视为不可信，交给 L2 DOM 兜底 + 触发后台刷新，更安全。
const oldIdx = { bvids: new Set(['BV1a']), fetchedAt: Date.now() - 48 * 3600 * 1000 };
const r6 = FavIndex.isFaved('BV1a', oldIdx, { domCheck: false, maxAgeMs: 24 * 3600 * 1000 });
eq(r6.faved, false, '★ 过期索引不参与命中（防陈旧数据误判）');
eq(r6.stale, true, '并标记为 stale');

// 新鲜索引仍正常命中（对照组）
const freshIdx6 = { bvids: new Set(['BV1a']), fetchedAt: Date.now() };
eq(FavIndex.isFaved('BV1a', freshIdx6, { domCheck: false, maxAgeMs: 24 * 3600 * 1000 }).faved,
   true, '新鲜索引正常命中（对照）');

console.log('\n==== 7. isFaved：无索引 / 无 bvid 的边界 ====');
eq(FavIndex.isFaved('', setIdx, { domCheck: false }).faved, false, '空 bvid → false');
eq(FavIndex.isFaved('BV1a', null, { domCheck: false }).faved, false, 'null 索引 → false');

console.log('\n==== 8. normalizeFolders ====');
const nf = FavIndex.normalizeFolders({ list: realFolders, count: 6 });
eq(nf.length, 6, '归一化后 6 条');
eq(nf[2].title, '歌', '第 3 条是「歌」');

console.log('\n==== 9. 真实索引数据判定（若存在）====');
const folderFile = path.join(__dirname, '..', '..', '..', '..', 'AppData', 'Local', 'Temp', 'gh-push', 'folder-bvids.json');
// 换个更稳的路径：直接找 probe 输出的样本
const altPath = 'C:/Users/Public/AppData/Local/Temp/gh-push/folder-bvids.json';
let idxPath = fs.existsSync(altPath) ? altPath : (fs.existsSync(folderFile) ? folderFile : null);
if (idxPath) {
  const j = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  const idx = { bvids: new Set(j.bvids || []), fetchedAt: Date.now() };
  console.log('  载入真实索引: ' + (j.bvids || []).length + ' 条 BV');
  const known = (j.bvids || [])[0];
  eq(FavIndex.isFaved(known, idx, { domCheck: false }).faved, true, '已知收藏的 BV 判定为已收藏');
  eq(FavIndex.isFaved('BV000NOTEXIST', idx, { domCheck: false }).faved, false, '随机 BV 判定为未收藏');
} else {
  console.log('  （跳过：未找到 folder-bvids.json）');
}

// ============================================================
// ★ v1.3.1 新增：容量检测 / 多夹滚动 / 溢出夹命名
// ============================================================

console.log('\n==== 10. capStatus：容量上限计算 ====');
const cs1 = FavIndex.capStatus(276, { title: '歌', media_count: 276 });
eq(cs1.cap, 1000, '自建夹上限 1000');
eq(cs1.remain, 724, '剩余 724 首');
eq(cs1.level, 'ok', '276/1000 → ok');
const cs2 = FavIndex.capStatus(900, { title: '歌', media_count: 900 });
eq(cs2.level, 'warn', '900/1000 → warn（≥90%）');
const cs3 = FavIndex.capStatus(1000, { title: '歌', media_count: 1000 });
eq(cs3.level, 'full', '1000/1000 → full');
eq(cs3.remain, 0, '已满时剩余 0');
const cs4 = FavIndex.capStatus(281, { title: '默认收藏夹', media_count: 281 });
eq(cs4.cap, 50000, '默认收藏夹上限 50000');
eq(cs4.isDefault, true, '识别为默认收藏夹');

console.log('\n==== 11. pickUsableFolder：「歌」未满 → 直接用「歌」 ====');
const uf1 = FavIndex.pickUsableFolder(
  [{ id: 1, title: '歌', media_count: 276 }], '歌', {});
eq(uf1.folder && uf1.folder.id, 1, '选中「歌」');
eq(uf1.reason, 'exact', '原因 exact');
eq(uf1.chain.length, 1, '夹链只有 1 个');

console.log('\n==== 12. pickUsableFolder：「歌」满了 → 自动切「歌2」 ====');
const uf2 = FavIndex.pickUsableFolder([
  { id: 1, title: '歌', media_count: 1000 },
  { id: 2, title: '歌2', media_count: 30 },
  { id: 3, title: '歌？', media_count: 1 }
], '歌', {});
eq(uf2.folder && uf2.folder.id, 2, '自动选中「歌2」');
eq(uf2.reason, 'overflow-folder', '原因是 overflow-folder');
eq(uf2.chain.length, 2, '夹链含「歌」「歌2」');
eq(uf2.full.length, 1, '记录 1 个已满夹');
eq(uf2.full[0].id, 1, '已满的是「歌」');
eq(uf2.chain.some(f => f.title === '歌？'), false, '★「歌？」未被纳入夹链');

console.log('\n==== 13. pickUsableFolder：全满 → all-full 提示建新夹 ====');
const uf3 = FavIndex.pickUsableFolder([
  { id: 1, title: '歌', media_count: 1000 },
  { id: 2, title: '歌2', media_count: 1000 }
], '歌', {});
eq(uf3.reason, 'all-full', '原因是 all-full（提示用户建新夹）');
eq(uf3.folder && uf3.folder.id, 2, '仍返回最后一个夹供参考');
eq(uf3.full.length, 2, '两个夹都记为已满');

console.log('\n==== 14. pickUsableFolder：溢出夹按数字升序 ====');
const uf4 = FavIndex.pickUsableFolder([
  { id: 1, title: '歌', media_count: 1000 },
  { id: 3, title: '歌10', media_count: 5 },
  { id: 2, title: '歌3', media_count: 5 },
  { id: 4, title: '歌2', media_count: 5 }
], '歌', {});
eq(uf4.folder && uf4.folder.id, 4, '按数字升序 → 先选「歌2」(id=4)');

console.log('\n==== 15. nextOverflowName：推荐新夹名 ====');
eq(FavIndex.nextOverflowName([{ title: '歌' }], '歌'), '歌2', '只有「歌」→ 推荐「歌2」');
eq(FavIndex.nextOverflowName([{ title: '歌' }, { title: '歌2' }], '歌'), '歌3', '有歌+歌2 → 推荐「歌3」');
eq(FavIndex.nextOverflowName([{ title: '歌' }, { title: '歌2' }, { title: '歌3' }], '歌'), '歌4', '→ 推荐「歌4」');
eq(FavIndex.nextOverflowName([], '歌'), '歌2', '空列表 → 「歌2」');

console.log('\n==== 16. isFaved：多索引入参（主夹 + 溢出夹）====');
const mainIx = { mediaId: 1, folderTitle: '歌', bvids: ['BVAAA'], fetchedAt: Date.now() };
const overIx = { mediaId: 2, folderTitle: '歌2', bvids: ['BVBBB'], fetchedAt: Date.now() };
eq(FavIndex.isFaved('BVAAA', mainIx, { domCheck: false, extraIndexes: [overIx] }).faved, true, '主夹命中');
eq(FavIndex.isFaved('BVBBB', mainIx, { domCheck: false, extraIndexes: [overIx] }).faved, true, '★ 溢出夹也命中');
const r16 = FavIndex.isFaved('BVBBB', mainIx, { domCheck: false, extraIndexes: [overIx] });
eq(r16.source, 'index:歌2', '来源标明是「歌2」');
eq(FavIndex.isFaved('BVCCC', mainIx, { domCheck: false, extraIndexes: [overIx] }).faved, false, '都不在 → 未收藏');

console.log('\n==== 17. isFaved：过期索引不参与命中（防止用陈旧数据误判）====');
const staleIx = { mediaId: 1, folderTitle: '歌', bvids: ['BVAAA'], fetchedAt: Date.now() - 48 * 3600 * 1000 };
const r17 = FavIndex.isFaved('BVAAA', staleIx, { domCheck: false, maxAgeMs: 24 * 3600 * 1000 });
eq(r17.faved, false, '过期索引不算命中');
eq(r17.stale, true, '并标记 stale');

console.log('\n==== 18. FOLDER_CAP 常量 ====');
eq(FavIndex.FOLDER_CAP.CUSTOM, 1000, '自建夹上限常量 1000');
eq(FavIndex.FOLDER_CAP.DEFAULT, 50000, '默认夹上限常量 50000');

console.log('\n========================================');
console.log(` 结果: ${pass} 通过 / ${fail} 失败`);
console.log('========================================');
process.exit(fail ? 1 : 0);
