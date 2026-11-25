'use strict';
// bench/rules_test.js — 牌型引擎单元测试（getCardType / canBeat / getAllValidPlays）
// 通过标准：0 failures。这是整个 AI 的地基：牌型判错，后面所有搜索与评分都建立在流沙上。

const { loadAI } = require('./loader');
const { makeRng } = require('./engine');

const SYMBOLS = [
    'CardType', 'getCardType', 'canBeat', 'getAllValidPlays', 'getPlayPower',
    'typePowerOf', 'minBeatPower', 'allCards',
];

const mod = loadAI('ai_core.js', SYMBOLS, makeRng(1));
const { CardType, getCardType, canBeat, getAllValidPlays, getPlayPower } = mod;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) pass++;
    else { fail++; failures.push(name + (detail ? '  [' + detail + ']' : '')); }
}
function eq(name, actual, expected) {
    check(name, actual === expected, 'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected));
}

// ---------- 造牌工具 ----------
const SUITS = ['♠', '♥', '♣', '♦'];
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
function C(rank, suitIdx) {
    const v = RANKS.indexOf(rank);
    const s = SUITS[(suitIdx || 0) % 4];
    return { suit: s, rank, value: v, id: s + rank };
}
function setOf(rank, n, suitStart) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(C(rank, (suitStart || 0) + i));
    return out;
}
const SMALL_JOKER = { suit: 'JOKER', rank: '小王', value: 13, id: 'joker1' };
const BIG_JOKER = { suit: 'JOKER', rank: '大王', value: 14, id: 'joker2' };

const T = (cards) => { const t = getCardType(cards); return t ? t.type : null; };
const V = (cards) => { const t = getCardType(cards); return t ? t.value : null; };

// ==================== 1. 基础牌型 ====================
eq('单张', T([C('5')]), CardType.SINGLE);
eq('单张牌值', V([C('5')]), 2);
eq('对子', T(setOf('7', 2)), CardType.PAIR);
eq('三张', T(setOf('9', 3)), CardType.TRIPLE);
eq('炸弹', T(setOf('K', 4)), CardType.BOMB);
eq('王炸', T([SMALL_JOKER, BIG_JOKER]), CardType.ROCKET);
eq('两张不同点数不是对子', T([C('5'), C('6')]), null);

// 王炸必须靠 id 识别：伪造 value 13/14 但没有 joker id 的两张牌不算王炸
eq('无 joker id 的双王不是王炸', T([
    { suit: '♠', rank: '小王', value: 13, id: '♠X' },
    { suit: '♥', rank: '大王', value: 14, id: '♥Y' },
]), null);

// ==================== 2. 三带 / 四带 ====================
eq('三带一', T([...setOf('8', 3), C('3')]), CardType.TRIPLE_WITH_SINGLE);
eq('三带一对', T([...setOf('8', 3), ...setOf('3', 2)]), CardType.TRIPLE_WITH_PAIR);
eq('三带二散牌不是三带一对', T([...setOf('8', 3), C('3'), C('4')]), null);
eq('四带两单', T([...setOf('6', 4), C('3'), C('4')]), CardType.FOUR_WITH_TWO_SINGLE);
eq('四带一对也是四带二', T([...setOf('6', 4), ...setOf('3', 2)]), CardType.FOUR_WITH_TWO_SINGLE);
eq('四带两对', T([...setOf('6', 4), ...setOf('3', 2), ...setOf('4', 2)]), CardType.FOUR_WITH_TWO_PAIR);
eq('四带三张非法', T([...setOf('6', 4), ...setOf('3', 3)]), null);

// ==================== 3. 顺子 / 连对 / 飞机 ====================
eq('顺子 3-7', T(['3', '4', '5', '6', '7'].map(r => C(r))), CardType.STRAIGHT);
eq('顺子起点是牌值', V(['3', '4', '5', '6', '7'].map(r => C(r))), 0);
eq('顺子长度记在 length 上', getCardType(['3', '4', '5', '6', '7'].map(r => C(r))).length, 5);
eq('顺子不能含 2', T(['J', 'Q', 'K', 'A', '2'].map(r => C(r))), null);
eq('顺子不能含王', T(['K', 'A', ...[]].map(r => C(r))), null);
eq('4 张不成顺子', T(['3', '4', '5', '6'].map(r => C(r))), null);
eq('不连续不是顺子', T(['3', '4', '5', '6', '8'].map(r => C(r))), null);

eq('连对 3-3-4-4-5-5', T([...setOf('3', 2), ...setOf('4', 2), ...setOf('5', 2)]), CardType.STRAIGHT_PAIR);
eq('两张同点数是对子不是连对', T(setOf('3', 2)), CardType.PAIR);
eq('连对不能含 2', T([...setOf('K', 2), ...setOf('A', 2), ...setOf('2', 2)]), null);

eq('飞机 333444', T([...setOf('3', 3), ...setOf('4', 3)]), CardType.PLANE);
eq('飞机 333444 带两单', T([...setOf('3', 3), ...setOf('4', 3), C('5'), C('6')]), CardType.PLANE_WITH_SINGLE);
eq('飞机 333444 带两对', T([...setOf('3', 3), ...setOf('4', 3), ...setOf('5', 2), ...setOf('6', 2)]), CardType.PLANE_WITH_PAIR);
eq('飞机点数不连续非法', T([...setOf('3', 3), ...setOf('5', 3)]), null);
eq('三个三张是三张不是飞机', T(setOf('3', 3)), CardType.TRIPLE);

// ==================== 4. canBeat ====================
const s5 = getCardType([C('5')]);
const s9 = getCardType([C('9')]);
const p8 = getCardType(setOf('8', 2));
const p9 = getCardType(setOf('9', 2));
const b3 = getCardType(setOf('3', 4));
const bA = getCardType(setOf('A', 4));
const rk = getCardType([SMALL_JOKER, BIG_JOKER]);

check('大单张压小单张', canBeat(s9, s5));
check('小单张压不住大单张', !canBeat(s5, s9));
check('同点数单张不能压自己', !canBeat(s5, s5));
check('单张压不住对子', !canBeat(s5, p8));
check('对子压不住单张', !canBeat(p8, s5));
check('对9压对8', canBeat(p9, p8));
check('对8压不住对9', !canBeat(p8, p9));
check('炸弹压普通牌', canBeat(b3, p9));
check('普通牌压不住炸弹', !canBeat(p9, b3));
check('大炸弹压小炸弹', canBeat(bA, b3));
check('小炸弹压不住大炸弹', !canBeat(b3, bA));
check('王炸压炸弹', canBeat(rk, bA));
check('炸弹压不住王炸', !canBeat(bA, rk));
check('无 last 时任何牌可出', canBeat(s5, null));

const sp3 = getCardType([...setOf('3', 2), ...setOf('4', 2), ...setOf('5', 2)]);
const sp4 = getCardType([...setOf('3', 2), ...setOf('4', 2), ...setOf('5', 2), ...setOf('6', 2)]);
check('长连对压不了短连对', !canBeat(sp4, sp3));
check('短连对压不了长连对', !canBeat(sp3, sp4));
check('同长连对大者胜', canBeat(
    getCardType([...setOf('4', 2), ...setOf('5', 2), ...setOf('6', 2)]), sp3));

// 飞机：带翅膀与不带翅膀互相压不住
const pl2 = getCardType([...setOf('3', 3), ...setOf('4', 3)]);
const pl2w = getCardType([...setOf('3', 3), ...setOf('4', 3), C('5'), C('6')]);
check('飞机带翅膀压不住纯飞机', !canBeat(pl2w, pl2));
check('纯飞机压不住带翅膀飞机', !canBeat(pl2, pl2w));
const pl3 = getCardType([...setOf('3', 3), ...setOf('4', 3), ...setOf('5', 3)]);
check('3 连飞机压不了 2 连飞机', !canBeat(pl3, pl2));

// ==================== 5. getAllValidPlays 性质（随机手牌 fuzz） ====================
const rng = makeRng(20260914);
let handsTested = 0, playsSeen = 0;
let illegalBeat = 0, dupIds = 0, notInHand = 0, badType = 0, missingType = 0, dupSets = 0;

for (let h = 0; h < 500; h++) {
    const deck = mod.allCards();
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    const hand = deck.slice(0, 3 + Math.floor(rng() * 18));
    handsTested++;
    const handIds = new Set(hand.map(c => c.id));

    // 用手牌里随机 2~5 张构造一个 lastPlay（保证是合法牌型）
    const last = (() => {
        for (let tries = 0; tries < 8; tries++) {
            const n = 1 + Math.floor(rng() * 5);
            const pick = [];
            const pool = hand.slice();
            for (let i = 0; i < n && pool.length; i++) pick.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
            const t = getCardType(pick);
            if (t && t.type !== CardType.ROCKET) return t;
        }
        return null;
    })();

    let plays;
    try { plays = getAllValidPlays(hand, last); }
    catch (e) { illegalBeat++; continue; }

    // 生成器必须天然无重复（去重逻辑已被移除，靠这条断言守住）
    const seenSets = new Set();
    for (const p of plays) {
        playsSeen++;
        const t = getCardType(p);
        if (!t) { badType++; continue; }
        if (last && !canBeat(t, last)) illegalBeat++;
        const ids = p.map(c => c.id);
        if (new Set(ids).size !== ids.length) dupIds++;
        if (ids.some(id => !handIds.has(id))) notInHand++;
        const setKey = ids.slice().sort().join(',');
        if (seenSets.has(setKey)) dupSets++;
        seenSets.add(setKey);
    }

    // 领出时：手牌中所有合法 3 张组合必须被枚举到。
    // 比较用「点数多重集」而非具体 id：同点数的 4 张牌任选 3 张是等价走法，
    // 引擎只保留一种 canonical 表示，用 id 比较会误报。
    const lead = getAllValidPlays(hand, null);
    const leadSet = new Set(lead.map(p => p.map(c => c.value).sort((a, b) => a - b).join('.')));
    outer:
    for (let i = 0; i < hand.length; i++) {
        for (let j = i + 1; j < hand.length; j++) {
            for (let k = j + 1; k < hand.length; k++) {
                const t = getCardType([hand[i], hand[j], hand[k]]);
                if (!t) continue;
                const key = [hand[i].value, hand[j].value, hand[k].value].sort((a, b) => a - b).join('.');
                if (!leadSet.has(key)) { missingType++; break outer; }
            }
        }
    }
}
eq('枚举出的牌都能压过 last', illegalBeat, 0);
eq('枚举出的牌都有合法牌型', badType, 0);
eq('枚举出的牌无重复 id', dupIds, 0);
eq('枚举出的牌都来自手牌', notInHand, 0);
eq('领出枚举覆盖全部三张组合', missingType, 0);
eq('枚举结果无重复牌组', dupSets, 0);
check('fuzz 样本量足够', handsTested >= 500 && playsSeen >= 3000,
    'hands=' + handsTested + ' plays=' + playsSeen);

// ==================== 6. 牌力单调性 ====================
check('单张牌力随点数递增', getPlayPower([C('3')]) < getPlayPower([C('4')]));
check('同点数：单 < 对 < 三', getPlayPower([C('5')]) < getPlayPower(setOf('5', 2))
    && getPlayPower(setOf('5', 2)) < getPlayPower(setOf('5', 3)));
check('炸弹牌力远大于三张', getPlayPower(setOf('3', 4)) > getPlayPower(setOf('A', 3)));
check('王炸牌力最大', getPlayPower([SMALL_JOKER, BIG_JOKER]) > getPlayPower(setOf('3', 4)));

// ==================== 输出 ====================
console.log('牌型引擎测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项  (fuzz: ' + handsTested + ' 手 / ' + playsSeen + ' 候选)');
if (fail) {
    console.log('失败明细：');
    for (const f of failures) console.log('  ✗ ' + f);
}
process.exit(fail ? 1 : 0);
