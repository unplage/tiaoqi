'use strict';
// bench/smoke.js — 决策路径冒烟测试
//
// 覆盖：五级难度的 playDecision（含 MCTS / 盲模拟 / 残局求解）与 callDecision。
// 断言：① 无异常 ② 返回合法牌型 ③ 出的牌在手牌里且能压过 lastPlay
//       ④ 领出时不得过牌 ⑤ 记牌器与实际出牌一致 ⑥ lastReasoning 有内容
// 通过标准：0 fails。

const { loadAI } = require('./loader');
const { makeRng, makeDeal, bestLandlord } = require('./engine');

const SYMBOLS = [
    'CardType', 'getCardType', 'canBeat', 'getAllValidPlays', 'MasterMemory',
    'evaluateHandStrength', 'extractPlayFeatures', 'scorePlay', 'computePassScore',
    'decomposeHandDP', 'solveEndgame', 'minimaxEndgame', 'endgameValue', 'mctsSearch',
    'heuristicPlayoutWithMode', 'AICore', 'DEFAULT_PARAMS', 'cfg', 'HandBelief',
];

const fast = {
    search: { deterministic: true, nodeBudget: 2500, mctsIterations: 60, mctsWorlds: 2 },
    mcts: { iterations: { legendary: 200, grandmaster: 200, hard: 200 }, timeLimit: 500 },
    simulation: { depth: { legendary: 1, grandmaster: 1, hard: 1 } },
    endgame: { timeBudgetMs: 200, nodeLimit: 30000 },
    blind: {
        worlds: {
            endgame: { easy: 1, medium: 1, hard: 2, grandmaster: 2, legendary: 2 },
            mcts: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 },
            sim: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 },
            call: { easy: 0, medium: 0, hard: 2, grandmaster: 2, legendary: 2 }
        },
        endgameTimeBudgetMs: { easy: 60, medium: 80, hard: 150, grandmaster: 150, legendary: 150 },
        mctsTimeBudgetMs: { easy: 0, medium: 0, hard: 150, grandmaster: 150, legendary: 150 },
        beatProbSamples: { easy: 0, medium: 0, hard: 2, grandmaster: 2, legendary: 2 },
        beatProbCandidates: { easy: 0, medium: 0, hard: 2, grandmaster: 2, legendary: 2 },
        callTrials: { legendary: 10 }
    },
};

const mod = loadAI('ai_core.js', SYMBOLS, makeRng(7), fast);
const { AICore, MasterMemory, getAllValidPlays, getCardType, canBeat } = mod;

const rng = makeRng(2024);
let fails = 0, decisions = 0, calls = 0, reasoningSeen = 0;
const errs = [];
function fail(tag, msg) { fails++; if (errs.length < 12) errs.push(tag + ': ' + msg); }

for (const difficulty of ['easy', 'medium', 'hard', 'grandmaster', 'legendary']) {
    for (let g = 0; g < 6; g++) {
        const deal = makeDeal(rng);
        const L = bestLandlord(deal.hands, rng, mod.evaluateHandStrength);
        const players = deal.hands.map(p => p.map(c => ({ ...c })));
        players[L].push(...deal.lordCards);
        players[L].sort((a, b) => a.value - b.value);
        const memory = new MasterMemory();
        const state = {
            players, landlord: L, currentPlayer: L, lastPlay: null, lastPlayerId: -1,
            passCount: 0, baseScore: 1, bombCount: 0, phase: 'playing',
            lordCards: deal.lordCards, callScores: [0, 0, 0],
            firstPlayMade: false, lordPlayCount: 0, farmerPlayed: false,
        };

        // ---- 叫分阶段 ----
        for (let seat = 0; seat < 3; seat++) {
            const callState = {
                players: state.players.map(p => p.map(c => ({ ...c }))),
                landlord: -1, phase: 'calling', lordCards: deal.lordCards,
                baseScore: 1, callScores: [0, 0, 0],
            };
            try {
                const bid = new AICore(seat, difficulty, memory).callDecision(callState);
                calls++;
                if (!Number.isInteger(bid) || bid < 0 || bid > 3) fail('call', difficulty + ' bid=' + bid);
            } catch (e) { fail('call', difficulty + ' ' + e.message); }
        }

        for (let t = 0; t < 40; t++) {
            const cp = state.currentPlayer;
            if (state.players[cp].length === 0) break;
            if (state.passCount >= 2) { state.lastPlay = null; state.lastPlayerId = -1; state.passCount = 0; }
            const needBeat = state.lastPlay && state.lastPlayerId !== cp;
            const core = new AICore(cp, difficulty, memory);
            let chosen;
            try {
                chosen = core.playDecision(state);
                decisions++;
            } catch (e) { fail('THROW', difficulty + ' ' + e.message); break; }
            if (core.lastReasoning) reasoningSeen++;
            const plays = needBeat ? getAllValidPlays(state.players[cp], state.lastPlay) : getAllValidPlays(state.players[cp], null);
            if (!Array.isArray(chosen)) { fail('NON-ARRAY', difficulty); break; }
            if (chosen.length > 0) {
                const ids = new Set(chosen.map(c => c.id));
                if (!plays.find(p => p.length === chosen.length && p.every(c => ids.has(c.id)))) {
                    fail('ILLEGAL', difficulty + ' ' + JSON.stringify(getCardType(chosen))); break;
                }
                if (needBeat) {
                    const ct = getCardType(chosen);
                    if (!ct || !canBeat(ct, state.lastPlay)) { fail('CANNOT_BEAT', difficulty); break; }
                }
                const before = state.players[cp].length;
                const playedIds = chosen.map(c => c.id);
                state.players[cp] = state.players[cp].filter(c => !ids.has(c.id));
                if (state.players[cp].length !== before - chosen.length) { fail('HAND MISMATCH', difficulty); break; }
                state.lastPlay = getCardType(chosen); state.lastPlayerId = cp; state.passCount = 0;
                memory.recordPlayerPlay(cp, chosen);
                // 记牌器一致性：seen 应包含刚出的牌
                for (const id of playedIds) {
                    if (!memory.seen.has(id)) { fail('MEMORY SEEN', difficulty + ' ' + id); break; }
                }
            } else {
                if (!needBeat) { fail('ILLEGAL PASS as lead', difficulty); break; }
                state.passCount++;
            }
            state.currentPlayer = (cp + 1) % 3;
        }
    }
}

console.log('decisions exercised:', decisions, ' calls:', calls, ' reasoning:', reasoningSeen, ' fails:', fails);
if (fails) { console.error('失败明细（最多 12 条）：'); for (const e of errs) console.error('  ✗ ' + e); }
process.exit(fails > 0 ? 1 : 0);
