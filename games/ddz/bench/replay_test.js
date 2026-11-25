'use strict';
// bench/replay_test.js — 回放一致性 + 记牌器不变量
//
// 验证两件事：
//  1. 给定一串动作日志，能完整重建出与原始一致的局面（回放是复盘/学习的基础）。
//  2. 记牌器在整局中始终满足不变量：
//     · remain[v] >= 0
//     · sum(remain) == 54 - 已出牌张数
//     · seen 的牌面多重集 == 已出牌的多重集

const { loadAI } = require('./loader');
const { makeRng, makeDeal, bestLandlord } = require('./engine');

const SYMBOLS = [
    'CardType', 'getCardType', 'canBeat', 'getAllValidPlays', 'MasterMemory',
    'evaluateHandStrength', 'AICore', 'cfg',
];
const mod = loadAI('ai_core.js', SYMBOLS, makeRng(11), {
    search: { deterministic: true, nodeBudget: 1500, mctsIterations: 40, mctsWorlds: 1 },
    blind: {
        worlds: { endgame: { easy: 1, medium: 1, hard: 1, grandmaster: 1, legendary: 1 },
                  mcts: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 },
                  sim: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 },
                  call: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 } },
        endgameTimeBudgetMs: { easy: 50, medium: 50, hard: 100, grandmaster: 100, legendary: 100 },
        mctsTimeBudgetMs: { easy: 0, medium: 0, hard: 100, grandmaster: 100, legendary: 100 },
        beatProbSamples: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 },
        beatProbCandidates: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 }
    },
});
const { AICore, MasterMemory, getCardType, getAllValidPlays } = mod;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) pass++;
    else { fail++; failures.push(name + (detail ? '  [' + detail + ']' : '')); }
}

const rng = makeRng(4242);
let games = 0, replays = 0;

for (let g = 0; g < 10; g++) {
    const deal = makeDeal(rng);
    const L = bestLandlord(deal.hands, rng, mod.evaluateHandStrength);
    const players0 = deal.hands.map(p => p.map(c => ({ ...c })));
    players0[L].push(...deal.lordCards);
    players0[L].sort((a, b) => a.value - b.value);

    const memory = new MasterMemory();
    const state = {
        players: players0.map(p => p.map(c => ({ ...c }))),
        landlord: L, currentPlayer: L, lastPlay: null, lastPlayerId: -1,
        passCount: 0, baseScore: 1, phase: 'playing',
        lordCards: deal.lordCards, callScores: [0, 0, 0],
        firstPlayMade: false, lordPlayCount: 0, farmerPlayed: false,
    };

    // ---- 记录一局 ----
    const log = [];
    let playedIds = [];
    let done = false;
    for (let t = 0; t < 200 && !done; t++) {
        const cp = state.currentPlayer;
        if (state.players[cp].length === 0) { done = true; break; }
        if (state.passCount >= 2) { state.lastPlay = null; state.lastPlayerId = -1; state.passCount = 0; }
        const needBeat = state.lastPlay && state.lastPlayerId !== cp;
        const core = new AICore(cp, 'medium', memory);
        let chosen;
        try { chosen = core.playDecision(state); } catch (e) { check('决策不抛异常', false, e.message); break; }
        if (!Array.isArray(chosen)) { check('决策返回数组', false); break; }
        if (chosen.length > 0) {
            const ids = new Set(chosen.map(c => c.id));
            const legal = needBeat
                ? getAllValidPlays(state.players[cp], state.lastPlay)
                : getAllValidPlays(state.players[cp], null);
            if (!legal.find(p => p.length === chosen.length && p.every(c => ids.has(c.id)))) {
                check('出的牌合法', false); break;
            }
            log.push({ seat: cp, cards: chosen.map(c => c.id), pass: false });
            playedIds = playedIds.concat(chosen.map(c => c.id));
            state.players[cp] = state.players[cp].filter(c => !ids.has(c.id));
            state.lastPlay = getCardType(chosen); state.lastPlayerId = cp; state.passCount = 0;
            memory.recordPlayerPlay(cp, chosen);
        } else {
            log.push({ seat: cp, cards: [], pass: true });
            state.passCount++;
        }
        state.currentPlayer = (cp + 1) % 3;
    }
    games++;

    // ---- 不变量检查（整局） ----
    let sum = 0, neg = 0;
    for (let v = 0; v <= 14; v++) { sum += memory.getRemain(v); if (memory.getRemain(v) < 0) neg++; }
    check('remain 无负数', neg === 0, 'neg=' + neg);
    check('sum(remain) == 54 - 已出牌数', sum === 54 - playedIds.length,
        'sum=' + sum + ' played=' + playedIds.length);
    check('seen 数量 == 已出牌数', memory.seen.size === playedIds.length,
        'seen=' + memory.seen.size + ' played=' + playedIds.length);
    check('totalCardsPlayed 总和 == 已出牌数',
        memory.totalCardsPlayed.reduce((a, b) => a + b, 0) === playedIds.length);

    // ---- 回放：从日志重建局面 ----
    const allCards = [];
    for (const s of ['♠', '♥', '♣', '♦']) for (const r of ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2']) {
        allCards.push({ suit: s, rank: r, value: ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'].indexOf(r), id: s + r });
    }
    allCards.push({ suit: 'JOKER', rank: '小王', value: 13, id: 'joker1' });
    allCards.push({ suit: 'JOKER', rank: '大王', value: 14, id: 'joker2' });
    const byId = new Map(allCards.map(c => [c.id, c]));

    const rp = players0.map(p => p.map(c => ({ ...c })));
    const rmem = new MasterMemory();
    let rpCur = L, rpLast = null, rpLastId = -1, rpPass = 0, ok = true;
    for (const step of log) {
        if (step.pass) { rpPass++; }
        else {
            const cards = step.cards.map(id => byId.get(id)).filter(Boolean);
            if (cards.length !== step.cards.length) { ok = false; break; }
            const ids = new Set(cards.map(c => c.id));
            // 出的每一张都必须在该座位的原手牌里
            if (cards.some(c => !rp[step.seat].some(h => h.id === c.id))) { ok = false; break; }
            rp[step.seat] = rp[step.seat].filter(c => !ids.has(c.id));
            rpLast = getCardType(cards); rpLastId = step.seat; rpPass = 0;
            rmem.recordPlayerPlay(step.seat, cards);
        }
        if (rpPass >= 2) { rpLast = null; rpLastId = -1; rpPass = 0; }
        rpCur = (rpCur + 1) % 3;
    }
    replays++;
    check('回放重建的手牌与原始一致', ok && JSON.stringify(rp.map(p => p.map(c => c.id).sort()))
        === JSON.stringify(state.players.map(p => p.map(c => c.id).sort())));
    check('回放重建的记牌器与原始一致',
        JSON.stringify(rmem.remain) === JSON.stringify(memory.remain));
    check('回放重建的 seen 与原始一致', rmem.seen.size === memory.seen.size);
}

console.log('回放一致性测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项  (' + games + ' 局 / ' + replays + ' 次回放)');
if (fail) { console.log('失败明细：'); for (const f of failures.slice(0, 12)) console.log('  ✗ ' + f); }
process.exit(fail ? 1 : 0);
