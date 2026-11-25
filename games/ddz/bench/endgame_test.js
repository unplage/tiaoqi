'use strict';
// bench/endgame_test.js — 盲残局求解器（solveEndgameBlind）质量验证
//
// 旧版 endgame_probe.js 测的是 god-view 的 solveEndgame —— 那个函数运行时从不调用，
// 输出的 "endgameStats null" 说明它测了个不存在的东西。
// 这里改测真正在跑的 solveEndgameBlind：
//   ① 它返回的走法必须合法（是 lastPlay 的合法应牌 / 领出时是合法牌型）
//   ② 领出方不得返回"过牌"
//   ③ 与 god-view（看穿对手手牌）的最优解一致率 —— 这是"隐藏信息让AI变弱多少"的量化
//   ④ 统计残局触发频率（真实对局里到底用上了多少）
//
// 通过标准：0 failures，且一致率不低于阈值。

const { loadAI } = require('./loader');
const { makeRng } = require('./engine');

const SYMBOLS = [
    'CardType', 'getCardType', 'canBeat', 'getAllValidPlays', 'MasterMemory',
    'evaluateHandStrength', 'extractPlayFeatures', 'scorePlay', 'computePassScore',
    'decomposeHandDP', 'solveEndgame', 'solveEndgameBlind', 'minimaxEndgame',
    'endgameValue', 'mctsSearch', 'AICore', 'DEFAULT_PARAMS', 'heuristicPlayoutWithMode',
    'cfg', 'HandBelief',
];
const mod = loadAI('ai_core.js', SYMBOLS, makeRng(17), {
    search: { deterministic: true, nodeBudget: 4000, mctsIterations: 60, mctsWorlds: 2 },
    blind: {
        worlds: { endgame: { easy: 1, medium: 1, hard: 2, grandmaster: 2, legendary: 2 } },
        endgameTimeBudgetMs: { hard: 500, grandmaster: 500, legendary: 500 }
    },
    endgame: { nodeLimit: 60000 },
});
const { CardType, getCardType, canBeat, getAllValidPlays, MasterMemory, HandBelief, solveEndgameBlind, solveEndgame, endgameValue } = mod;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) pass++;
    else { fail++; failures.push(name + (detail ? '  [' + detail + ']' : '')); }
}

// ---------- 造一个残局局面 ----------
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = ['♠', '♥', '♣', '♦'];
function C(rank, i) {
    const v = RANKS.indexOf(rank), s = SUITS[i % 4];
    return { suit: s, rank, value: v, id: s + rank };
}
function buildEndgame(rng, totalCards) {
    const deck = [];
    for (const s of SUITS) for (let i = 0; i < RANKS.length; i++) deck.push({ suit: s, rank: RANKS[i], value: i, id: s + RANKS[i] });
    deck.push({ suit: 'JOKER', rank: '小王', value: 13, id: 'joker1' });
    deck.push({ suit: 'JOKER', rank: '大王', value: 14, id: 'joker2' });
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
    // 三家分牌，尽量均匀
    const players = [[], [], []];
    const per = Math.floor(totalCards / 3);
    for (let i = 0; i < 3; i++) {
        const n = i === 2 ? totalCards - per * 2 : per;
        for (let k = 0; k < n; k++) players[i].push(deck.pop());
        players[i].sort((a, b) => a.value - b.value);
    }
    const landlord = Math.floor(rng() * 3);
    const state = {
        players, landlord, currentPlayer: landlord, lastPlay: null, lastPlayerId: -1,
        passCount: 0, baseScore: 1, bombCount: 0, firstPlayMade: true, lordPlayCount: 1,
        farmerPlayed: true, lordCards: [], callScores: [0, 0, 0], phase: 'playing',
    };
    // 随机加一个"需要跟牌"的上下文
    if (rng() < 0.5) {
        const sid = (landlord + 1) % 3;
        const hand = players[sid];
        if (hand.length >= 1) {
            const pick = hand[Math.floor(rng() * hand.length)];
            state.lastPlay = getCardType([pick]);
            state.lastPlayerId = sid;
            state.currentPlayer = (sid + 1) % 3;
        }
    }
    return state;
}

const rng = makeRng(90210);
let positions = 0, solved = 0, illegal = 0, passAsLead = 0, agree = 0, comparable = 0;
let valueGapSum = 0;

for (let t = 0; t < 120; t++) {
    const total = 9 + Math.floor(rng() * 15);   // 9~23 张
    const state = buildEndgame(rng, total);
    const me = state.currentPlayer;
    const mem = new MasterMemory();
    // 记牌器：已打出的牌 = 54 张里不在任何手牌里的
    const inHand = new Set();
    for (const p of state.players) for (const c of p) inHand.add(c.id);
    const belief = new HandBelief(me, state, mem);

    const needBeat = state.lastPlay && state.lastPlayerId !== me;
    const legal = needBeat ? getAllValidPlays(state.players[me], state.lastPlay) : getAllValidPlays(state.players[me], null);
    if (!legal.length) continue;
    positions++;

    const blind = solveEndgameBlind(state, me, belief, { worlds: 2, timeBudgetMs: 800, memory: mem });
    if (blind === null || blind === undefined) continue;
    solved++;

    // ① 合法性
    // 过牌哨兵：ENDGAME_PASS = { __endgamePass: true }
    const isPass = (!Array.isArray(blind)) || (blind.__endgamePass === true) || blind.length === 0;
    if (isPass) {
        if (!needBeat) passAsLead++;
        continue;   // 过牌在需要跟牌时是合法的
    }
    const ids = new Set(blind.map(c => c.id));
    const ok = legal.find(p => p.length === blind.length && p.every(c => ids.has(c.id)));
    if (!ok) illegal++;

    // ③ 与 god-view 的一致性
    const godPlay = solveEndgame(state, me, { worlds: 1, timeBudgetMs: 800 });
    if (godPlay && Array.isArray(godPlay) && godPlay.length && !godPlay.__endgamePass) {
        const godIds = godPlay.map(c => c.id).sort().join(',');
        const blindIds = blind.map(c => c.id).sort().join(',');
        comparable++;
        if (godIds === blindIds) agree++;
        // ② 值差
        try {
            const gv = endgameValue(state, me, godPlay, {});
            const bv = endgameValue(state, me, blind, {});
            valueGapSum += Math.abs((gv || 0) - (bv || 0));
        } catch (e) {}
    }
}

check('生成了足够的残局样本', positions >= 80, 'positions=' + positions);
check('残局求解器有产出', solved >= positions * 0.7, 'solved=' + solved + '/' + positions);
check('残局求解返回的走法全部合法', illegal === 0, 'illegal=' + illegal);
check('领出时不会返回过牌', passAsLead === 0, 'passAsLead=' + passAsLead);
const agreeRate = comparable ? agree / comparable : 0;
check('盲解与 god-view 一致率 >= 55%（隐藏信息的代价可接受）', agreeRate >= 0.55,
    'agreeRate=' + (agreeRate * 100).toFixed(1) + '% (' + agree + '/' + comparable + ')');
check('可比较样本足够', comparable >= 40, 'comparable=' + comparable);

console.log('残局求解测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项  '
    + '(positions=' + positions + ' solved=' + solved + ' agree=' + (agreeRate * 100).toFixed(1) + '%'
    + ' avgValueGap=' + (comparable ? (valueGapSum / comparable).toFixed(1) : '-') + ')');
if (fail) { console.log('失败明细：'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail ? 1 : 0);
