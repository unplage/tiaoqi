'use strict';
// bench/memory_test.js — 记牌器（MasterMemory）单元测试 + Worker 序列化往返
//
// 关键点：index.html 的 memoryToData/memoryFromData 必须完整传递所有影响信念的字段，
// 否则 Worker 侧的 AI 会比主线程弱（passHints 曾经就被漏掉了）。

const { loadAI } = require('./loader');
const { makeRng } = require('./engine');
const fs = require('fs');
const path = require('path');

const SYMBOLS = ['MasterMemory', 'getCardType', 'canBeat', 'getAllValidPlays'];
const mod = loadAI('ai_core.js', SYMBOLS, makeRng(3));
const { MasterMemory } = mod;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) pass++;
    else { fail++; failures.push(name + (detail ? '  [' + detail + ']' : '')); }
}
function eq(name, a, b) { check(name, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

const C = (rank, i) => {
    const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
    const SUITS = ['♠', '♥', '♣', '♦'];
    const v = RANKS.indexOf(rank), s = SUITS[(i || 0) % 4];
    return { suit: s, rank, value: v, id: s + rank };
};
const setOf = (rank, n) => { const o = []; for (let i = 0; i < n; i++) o.push(C(rank, i)); return o; };

// ==================== 1. 基本记牌 ====================
const mem = new MasterMemory();
eq('初始 54 张牌', mem.getRemainingCounts().reduce((a, b) => a + b, 0), 54);
eq('初始 3 的数量', mem.getRemain(0), 4);
eq('初始 2 的数量', mem.getRemain(12), 4);
eq('初始小王数量', mem.getRemain(13), 1);
eq('初始大王数量', mem.getRemain(14), 1);

mem.recordPlayerPlay(0, [C('5'), C('7')]);
eq('出牌后剩余总数', mem.getRemainingCounts().reduce((a, b) => a + b, 0), 52);
eq('出牌后 5 的数量', mem.getRemain(2), 3);
eq('出牌后 7 的数量', mem.getRemain(4), 3);
check('seen 记录了出的牌', mem.seen.has(C('5').id) && mem.seen.has(C('7').id));
eq('totalCardsPlayed', mem.totalCardsPlayed[0], 2);
eq('playerHistory 长度', mem.playerHistory[0].length, 1);

// 重复记同一张牌不应重复扣减
mem.recordPlayerPlay(0, [C('5')]);
eq('重复记牌不重复扣减', mem.getRemain(2), 3);
eq('重复记牌不累加计数', mem.totalCardsPlayed[0], 2);
eq('重复记牌不改变 remain', mem.getRemain(2), 3);

// ==================== 2. 炸弹 / 王炸可能性的边界 ====================
// 说明：getOutsideBombCount 返回「外面仍可能凑成炸弹的点数个数」。
// 未出牌时 3~2 共 13 个点数都可能，外面 9 被打光后应为 12 个。
const m2 = new MasterMemory();
eq('未出牌时 13 个点数都可能凑炸', m2.getOutsideBombCount([]), 13);
m2.recordPlayerPlay(1, setOf('9', 4));   // 外面打出炸弹 → 9 已耗尽
eq('外面的 9 不再可能组成炸弹', m2.getOutsideBombCount([]), 12);

const m3 = new MasterMemory();
m3.recordPlayerPlay(1, [C('A', 0), C('A', 1), C('A', 2)]);  // A 剩 1 张在外面
eq('A 只剩 1 张时不能凑炸', m3.getOutsideBombCount([]), 12);
m3.recordPlayerPlay(1, [C('A', 3)]);                        // A 全耗尽
eq('A 全部打出后炸点少一个', m3.getOutsideBombCount([]), 12);

const m4 = new MasterMemory();
check('未出牌时外面可能有王炸', m4.getOutsideRocketPossible([]) === true);

// 自己握着大王 → 外面不可能有王炸
const m5 = new MasterMemory();
check('自己握大王则外面无王炸', m5.getOutsideRocketPossible([{ value: 14 }]) === false);
check('自己握小王则外面无王炸', m5.getOutsideRocketPossible([{ value: 13 }]) === false);

// ==================== 3. getMaxOutside ====================
const m6 = new MasterMemory();
m6.recordPlayerPlay(1, setOf('K', 4));
eq('外面最大点数（大王还在外面）', m6.getMaxOutside([]), 14);
check('自己握 2 时外面最大仍是大王', m6.getMaxOutside([{ value: 12 }]) === 14);
const m6b = new MasterMemory();
m6b.recordPlayerPlay(1, [{ suit: 'JOKER', rank: '大王', value: 14, id: 'joker2' }]);
eq('大王打出后外面最大是小王', m6b.getMaxOutside([]), 13);
m6b.recordPlayerPlay(1, [{ suit: 'JOKER', rank: '小王', value: 13, id: 'joker1' }]);
eq('双王都打出后外面最大是 2', m6b.getMaxOutside([]), 12);
check('自己握双王时外面最大是 2', m6b.getMaxOutside([{ value: 14 }, { value: 13 }]) === 12);

// ==================== 4. passHints 记录与窗口查询 ====================
const m7 = new MasterMemory();
m7.recordPass(1, { type: 'single', value: 10, length: 1 });
check('passHints 记录了过牌上下文', m7.passHints[1].length === 1);
check('passHintsNear 在窗口内命中', m7.passHintsNear(1, 10, 2) >= 1);
check('passHintsNear 窗口外不命中', m7.passHintsNear(1, 3, 2) === 0);

// passHints 上限（防止无限增长）
const m8 = new MasterMemory();
for (let i = 0; i < 200; i++) m8.recordPass(1, { type: 'single', value: i % 13, length: 1 });
check('passHints 数量有上限', m8.passHints[1].length <= 60, 'len=' + m8.passHints[1].length);

// ==================== 5. Worker 序列化往返 ====================
// 直接从 index.html 里抽取 memoryToData / memoryFromData 的实现来测，
// 保证「主线程 → Worker → 主线程」这条链路上字段不丢。
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extractFn(src, name) {
    const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
    const m = re.exec(src);
    if (!m) return null;
    let i = m.index + m[0].length, depth = 1;
    while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
    }
    return src.slice(m.index, i);
}
const fTo = extractFn(html, 'memoryToData');
const fFrom = extractFn(html, 'memoryFromData');
check('index.html 中存在 memoryToData', !!fTo);
check('index.html 中存在 memoryFromData', !!fFrom);

if (fTo && fFrom) {
    const vm = require('vm');
    const ctx = { console, JSON, Set, Map, Array, Object };
    vm.createContext(ctx);
    vm.runInContext(fTo + '\n' + fFrom + '\nglobalThis.__m2d = memoryToData; globalThis.__m2f = memoryFromData;', ctx);

    const m9 = new MasterMemory();
    m9.recordPlayerPlay(0, [C('5'), C('7')]);
    m9.recordPlayerPlay(1, setOf('9', 4));
    m9.recordPass(2, { type: 'single', value: 10, length: 1 });

    const data = ctx.__m2d(m9);
    check('序列化结果含 remain', !!data.remain);
    check('序列化结果含 seen', !!data.seen);
    check('序列化结果含 history', !!data.history);
    check('序列化结果含 playerHistory', !!data.playerHistory);
    check('序列化结果含 passHints', !!data.passHints, 'passHints 丢失 → Worker 信念模型弱于主线程');

    const backMem = new MasterMemory();
    ctx.__m2f(backMem, data);
    const back = backMem;
    eq('往返后 remain 一致', JSON.stringify(back.remain), JSON.stringify(m9.remain));
    eq('往返后 seen 一致', back.seen.size, m9.seen.size);
    eq('往返后 totalCardsPlayed 一致', JSON.stringify(back.totalCardsPlayed), JSON.stringify(m9.totalCardsPlayed));
    eq('往返后 passHints 一致', JSON.stringify(back.passHints), JSON.stringify(m9.passHints));
    eq('往返后 playerHistory 一致', JSON.stringify(back.playerHistory), JSON.stringify(m9.playerHistory));
}

// ==================== 输出 ====================
console.log('记牌器测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) { console.log('失败明细：'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail ? 1 : 0);
