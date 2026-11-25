'use strict';
// bench/engine.js — 无头斗地主对局驱动（评测基建）
//
// 设计要点（相对旧版的修正）：
//  1. AI 返回非法牌时 **不再静默替换成 plays[0]** —— 旧版会把 AI 回归藏起来。
//     现在直接把该局标记为 invalid 并计数。
//  2. 支持「座位/角色平衡」的成对对局：每副牌跑 6 局，A 与 B 各占地主 3 次、各占
//     每个座位 2 次，消除地主优势带来的系统性偏置。
//  3. 提供 fast / prod 两套确定性参数档，供 bench/run.js 使用。

const { loadAI } = require('./loader');

function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
}

const SUITS = ['♠', '♥', '♣', '♦'];
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];

function makeDeck() {
    const deck = [];
    for (const suit of SUITS) for (let i = 0; i < RANKS.length; i++) {
        deck.push({ suit, rank: RANKS[i], value: i, id: suit + RANKS[i] });
    }
    deck.push({ suit: 'JOKER', rank: '小王', value: 13, id: 'joker1' });
    deck.push({ suit: 'JOKER', rank: '大王', value: 14, id: 'joker2' });
    return deck;
}

// 固定牌局：同 seed 必然同牌局
function makeDeal(rng) {
    const deck = makeDeck();
    shuffle(deck, rng);
    const hands = [[], [], []];
    for (let i = 0; i < 51; i++) hands[i % 3].push(deck.pop());
    const lordCards = deck.slice(0, 3);
    hands.forEach(p => p.sort((a, b) => a.value - b.value));
    return { hands, lordCards };
}

// 地主选择：默认「手牌最强者当地主」会让地主胜率高达 ~66%，与真实斗地主不符，
// 会放大角色差异的噪声。评测默认用轮转地主（每副牌轮转），另提供 strongest 模式。
function bestLandlord(hands, rng, evaluateHandStrength) {
    let best = -1e9, idx = 0;
    for (let i = 0; i < 3; i++) {
        const s = evaluateHandStrength(hands[i], null, false, i) + rng() * 6;
        if (s > best) { best = s; idx = i; }
    }
    return idx;
}
function pickLandlord(deal, mode, rng, evaluateHandStrength) {
    if (mode === 'rotate') return null; // 调用方按 deal 序号轮转
    return bestLandlord(deal.hands, rng, evaluateHandStrength);
}

// 跑一局。AI 需提供 { getAllValidPlays, canBeat, getCardType, MasterMemory, makeAgent(id, landlord, memory) }
function playDeal(AI, deal, landlord, opts) {
    opts = opts || {};
    const { getAllValidPlays, canBeat, getCardType, MasterMemory } = AI;
    const players = deal.hands.map(p => p.map(c => ({ ...c })));
    players[landlord].push(...deal.lordCards);
    players[landlord].sort((a, b) => a.value - b.value);

    const memory = new MasterMemory();
    const agents = [0, 1, 2].map(i => AI.makeAgent(i, landlord, memory));

    const state = {
        players,
        landlord,
        currentPlayer: landlord,
        lastPlay: null,
        lastPlayerId: -1,
        passCount: 0,
        baseScore: 1,
        bombCount: 0,
        firstPlayMade: false,
        lordPlayCount: 0,
        farmerPlayed: false,
        lordCards: deal.lordCards,
        callScores: [0, 0, 0],
        phase: 'playing',
    };

    let winner = -1;
    let invalid = null;
    let steps = 0;
    for (let guard = 0; guard < 600; guard++) {
        for (let i = 0; i < 3; i++) if (state.players[i].length === 0) { winner = i; break; }
        if (winner >= 0) break;

        if (state.passCount >= 2) { state.lastPlay = null; state.lastPlayerId = -1; state.passCount = 0; }
        const cp = state.currentPlayer;
        const hand = state.players[cp];
        const needBeat = state.lastPlay && state.lastPlayerId !== cp;
        const plays = getAllValidPlays(hand, state.lastPlay);

        let chosen = null;
        if (plays.length === 0) {
            chosen = [];
        } else {
            try { chosen = agents[cp].playDecision(state); } catch (e) {
                invalid = { seat: cp, reason: 'THROW:' + (e && e.message) };
                break;
            }
            if (!Array.isArray(chosen)) { invalid = { seat: cp, reason: 'NON_ARRAY' }; break; }
            if (chosen.length > 0) {
                const ids = new Set(chosen.map(c => c.id));
                const legal = plays.find(p => p.length === chosen.length && p.every(c => ids.has(c.id)));
                if (!legal) { invalid = { seat: cp, reason: 'ILLEGAL_PLAY' }; break; }
                if (needBeat) {
                    const t = getCardType(chosen);
                    if (!t || !canBeat(t, state.lastPlay)) { invalid = { seat: cp, reason: 'CANNOT_BEAT' }; break; }
                }
            } else if (chosen.length === 0 && !needBeat) {
                invalid = { seat: cp, reason: 'ILLEGAL_PASS_AS_LEAD' }; break;
            }
        }

        if (!chosen || chosen.length === 0) {
            state.passCount++;
        } else {
            const ids = new Set(chosen.map(c => c.id));
            state.players[cp] = state.players[cp].filter(c => !ids.has(c.id));
            state.lastPlay = getCardType(chosen);
            state.lastPlayerId = cp;
            state.passCount = 0;
            if (cp === landlord) state.lordPlayCount++; else state.farmerPlayed = true;
            if (!state.firstPlayMade) state.firstPlayMade = true;
            memory.recordPlayerPlay(cp, chosen);
            if (state.players[cp].length === 0) { winner = cp; break; }
        }
        state.currentPlayer = (cp + 1) % 3;
        steps++;
    }

    if (invalid) return { winner: -1, landlord, landlordWon: false, steps, invalid };
    if (winner < 0) {
        // 未分胜负（理论上不该发生）→ 判剩余牌最少者获胜，并标记
        let best = 0, bestLen = 99;
        for (let i = 0; i < 3; i++) if (state.players[i].length < bestLen) { bestLen = state.players[i].length; best = i; }
        winner = best;
    }
    return { winner, landlord, landlordWon: winner === landlord, steps, invalid: null };
}

// ==================== 确定性参数档 ====================
// fast：迭代受限（不看挂钟）→ 同种子必然同结果，且单局毫秒级，适合大规模配对评测。
// fair：保留世界数/随机因子差异，MCTS 用固定小预算（可复现且够快）。
// diff：在 fair 基础上按难度保留 MCTS 迭代数/世界数（更接近线上，但明显更慢）。
// prod：接近线上真实强度（用挂钟），适合最终验收，但不可复现、很慢。
function profileParams(profile) {
    if (profile === 'prod') return null; // null → 用 DEFAULT_PARAMS
    if (profile === 'diff') {
        const p = profileParams('fair');
        p.search = Object.assign({}, p.search, {
            useDifficultyBudgets: true, difficultyBudgetScale: 0.05
        });
        return p;
    }
    if (profile === 'fair') {
        // fair：保留难度关键差异（MCTS迭代数、盲搜世界数、随机因子），但用确定性模式 → 可复现且有区分度
        return {
            search: {
                deterministic: true, nodeBudget: 5000, mctsIterations: 0, mctsWorlds: 2
            },
            blind: {
                worlds: { 
                    endgame: { easy: 2, medium: 3, hard: 6, grandmaster: 8, legendary: 10 },
                    mcts: { easy: 0, medium: 0, hard: 3, grandmaster: 5, legendary: 6 },
                    sim: { easy: 0, medium: 0, hard: 2, grandmaster: 3, legendary: 4 },
                    call: { easy: 0, medium: 0, hard: 4, grandmaster: 6, legendary: 6 } },
                endgameTimeBudgetMs: { easy: 120, medium: 200, hard: 1500, grandmaster: 2500, legendary: 3500 },
                mctsTimeBudgetMs: { easy: 0, medium: 0, hard: 1800, grandmaster: 3000, legendary: 4500 },
                beatProbSamples: { easy: 0, medium: 0, hard: 6, grandmaster: 8, legendary: 10 },
                beatProbCandidates: { easy: 0, medium: 0, hard: 4, grandmaster: 4, legendary: 5 }
            },
            endgame: { timeBudgetMs: 700, nodeLimit: 200000 },
            mcts: { 
                iterations: { legendary: 30000, grandmaster: 12000, hard: 1800, medium: 0, easy: 0 },
                timeLimit: 4000, timeLimitByDiff: { legendary: 4000, grandmaster: 2500, hard: 1200 } },
            randomFactors: { legendary: 0, grandmaster: 0.05, hard: 0.1, medium: 0.2, easy: 0.5 }
        };
    }
    // fast：迭代受限（不看挂钟）→ 同种子必然同结果，且单局毫秒级，适合大规模配对评测。
    return {
        search: { deterministic: true, nodeBudget: 2500, mctsIterations: 60, mctsWorlds: 2 },
        blind: {
            worlds: { endgame: { easy: 1, medium: 1, hard: 2, grandmaster: 2, legendary: 2 },
                      mcts: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 },
                      sim: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 },
                      call: { easy: 0, medium: 0, hard: 2, grandmaster: 2, legendary: 2 } },
            endgameTimeBudgetMs: { easy: 60, medium: 60, hard: 200, grandmaster: 200, legendary: 200 },
            mctsTimeBudgetMs: { easy: 0, medium: 0, hard: 200, grandmaster: 200, legendary: 200 },
            beatProbSamples: { easy: 0, medium: 0, hard: 2, grandmaster: 2, legendary: 2 },
            beatProbCandidates: { easy: 0, medium: 0, hard: 2, grandmaster: 2, legendary: 2 }
        },
        endgame: { timeBudgetMs: 150, nodeLimit: 8000 },
        mcts: { iterations: { legendary: 60, grandmaster: 60, hard: 60, medium: 0, easy: 0 },
                timeLimit: 200, timeLimitByDiff: { legendary: 200, grandmaster: 200, hard: 200 } }
    };
}

const BENCH_SYMBOLS = [
    'CardType', 'getCardType', 'canBeat', 'getAllValidPlays', 'MasterMemory',
    'evaluateHandStrength', 'extractPlayFeatures', 'scorePlay', 'computePassScore',
    'decomposeHandDP', 'solveEndgame', 'minimaxEndgame', 'mctsSearch',
    'AICore', 'DEFAULT_PARAMS', 'heuristicPlayoutWithMode', 'cfg', 'HandBelief',
];

// 载入一个「配置好的引擎」：Core 构造函数 + 规则工具
function loadEngine(opts) {
    opts = opts || {};
    const seed = opts.seed === undefined ? 1 : opts.seed;
    const params = opts.params === undefined ? profileParams(opts.profile || 'fast') : opts.params;
    const mod = loadAI(opts.file || 'ai_core.js', BENCH_SYMBOLS, makeRng(seed), params);
    const Core = mod.AICore;
    if (!Core) throw new Error('missing AICore in ' + (opts.file || 'ai_core.js'));
    return {
        Core,
        tools: {
            CardType: mod.CardType,
            getCardType: mod.getCardType,
            canBeat: mod.canBeat,
            getAllValidPlays: mod.getAllValidPlays,
            MasterMemory: mod.MasterMemory,
            evaluateHandStrength: mod.evaluateHandStrength,
        },
        mod,
    };
}

module.exports = {
    makeRng, shuffle, makeDeal, makeDeck, pickLandlord, bestLandlord, playDeal,
    profileParams, loadEngine, BENCH_SYMBOLS,
};
