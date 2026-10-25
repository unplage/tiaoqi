'use strict';
// 公平性回归测试：AI 的决策不得依赖对手手牌的具体牌面。
// 做法：同一局面、同样的随机种子，构造两份 state ——
//   A：真实对手手牌；B：把两名对手的手牌整体换成完全不同的牌（张数不变）
// 由于 AI 只允许使用公开信息（自己手牌 / 各家张数 / 已出牌 / 底牌），
// 两次决策必须完全一致；若不一致，说明有代码路径偷看了对手手牌。
const { loadAI } = require('./loader');
const { makeRng, makeDeal, bestLandlord } = require('./engine');

const SYMBOLS = ['CardType', 'getCardType', 'canBeat', 'getAllValidPlays', 'MasterMemory',
    'evaluateHandStrength', 'extractPlayFeatures', 'scorePlay', 'computePassScore',
    'decomposeHandDP', 'solveEndgame', 'minimaxEndgame', 'mctsSearch', 'heuristicPlayoutWithMode',
    'AICore', 'DEFAULT_PARAMS', 'cfg', 'HandBelief', 'allCards'];

// 快速档：让测试在几秒内跑完，但仍然覆盖全部决策路径。
// 注意：时间预算必须给得足够宽（由节点/迭代数决定结束），否则同一局面的两次决策
// 会因机器负载不同而在"截断点"上产生差异，造成假阳性。
const fast = process.env.BLIND_FAST ? JSON.parse(process.env.BLIND_FAST) : {
    mcts: { iterations: { legendary: 300, grandmaster: 300, hard: 300 }, timeLimit: 60000 },
    simulation: { depth: { legendary: 1, grandmaster: 1, hard: 1 } },
    endgame: { timeBudgetMs: 60000, nodeLimit: 3000000 },
    blind: {
        worlds: {
            endgame: { easy: 1, medium: 1, hard: 2, grandmaster: 2, legendary: 2 },
            mcts: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 },
            sim: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 },
            call: { easy: 0, medium: 0, hard: 0, grandmaster: 0, legendary: 2 }
        },
        endgameTimeBudgetMs: { easy: 60000, medium: 60000, hard: 60000, grandmaster: 60000, legendary: 60000 },
        mctsTimeBudgetMs: { easy: 0, medium: 0, hard: 60000, grandmaster: 60000, legendary: 60000 },
        beatProbSamples: { easy: 0, medium: 0, hard: 2, grandmaster: 2, legendary: 2 },
        beatProbCandidates: { easy: 0, medium: 0, hard: 2, grandmaster: 2, legendary: 2 },
        callTrials: { legendary: 8 }
    },
};

const DIFFS = ['easy', 'medium', 'hard', 'grandmaster', 'legendary'];
const SEED = 4242;

function makeState(rng, playCount) {
    const deal = makeDeal(rng);
    const L = bestLandlord(deal.hands, rng, (h) => {
        let s = 0; for (const c of h) s += c.value; return s;
    });
    const players = deal.hands.map(p => p.map(c => ({ ...c })));
    players[L].push(...deal.lordCards);
    players[L].sort((a, b) => a.value - b.value);
    const memory = new (loadAI('ai_core.js', ['MasterMemory'], makeRng(1)).MasterMemory)();
    const state = {
        players, landlord: L, currentPlayer: L, lastPlay: null, lastPlayerId: -1, passCount: 0,
        baseScore: 1, bombCount: 0, phase: 'playing', lordCards: deal.lordCards,
        callScores: [0, 0, 0], firstPlayMade: false, lordPlayCount: 0, farmerPlayed: false
    };
    // 模拟已打出的牌：轮流每人出若干张单牌，制造中局/残局局面并填充记牌器
    let turn = L;
    for (let n = 0; n < (playCount || 1); n++) {
        for (let i = 0; i < 3; i++) {
            if (state.players[i].length === 0) continue;
            const card = state.players[i][0];
            state.players[i] = state.players[i].filter(c => c.id !== card.id);
            state.lastPlay = { type: 'single', value: card.value, cards: [card] };
            state.lastPlayerId = i;
            memory.recordPlayerPlay(i, [card]);
            turn = (i + 1) % 3;
        }
    }
    state.currentPlayer = turn;
    return { state, memory, landlord: L };
}

// 把"非自己"的另外两名玩家的手牌整体替换成完全不同的牌（张数保持不变）
// 注意：替换用的牌池 = 全副牌 − 自己的手牌 − 已打出的牌，保证替换后仍是"合法的一手牌"
function scrambleOpponents(state, actor, rng, allCards, playedIds) {
    const copy = JSON.parse(JSON.stringify(state));
    const ownIds = new Set(copy.players[actor].map(c => c.id));
    const pool = allCards.filter(c => !ownIds.has(c.id) && !playedIds.has(c.id));
    for (let i = 0; i < 3; i++) {
        if (i === actor) continue;
        const hand = [];
        // 地主的底牌是公开信息，必须仍在地主手里
        if (i === copy.landlord) for (const c of (copy.lordCards || [])) hand.push({ ...c });
        const need = copy.players[i].length - hand.length;
        for (let k = 0; k < need && pool.length; k++) {
            const idx = Math.floor(rng() * pool.length);
            hand.push(pool.splice(idx, 1)[0]);
        }
        copy.players[i] = hand;
    }
    return copy;
}

let failures = 0, checks = 0;
const rng = makeRng(20240601);
// 局面档位：0 = 开局（17 张手牌，走启发式路径）；3 = 中局；6 = 残局（触发盲残局/盲 MCTS）
for (const difficulty of DIFFS) {
    for (const playCount of [0, 3, 6]) {
        for (let g = 0; g < 2; g++) {
            const { state, memory, landlord } = makeState(rng, playCount);
            // 决策方：非地主的某个 AI（与人类玩家同为"对手视角"）
            const actor = (landlord + 1) % 3;
            const modA = loadAI('ai_core.js', SYMBOLS, makeRng(SEED), fast);
            const modB = loadAI('ai_core.js', SYMBOLS, makeRng(SEED), fast);
            const allCards = modA.allCards();
            const scrambled = scrambleOpponents(state, actor, makeRng(777), allCards, new Set(memory.seen));
            const memA = new modA.MasterMemory();
            const memB = new modB.MasterMemory();
            memA.seen = new Set(memory.seen);
            memB.seen = new Set(memory.seen);
            const stA = JSON.parse(JSON.stringify(state));
            const stB = JSON.parse(JSON.stringify(scrambled));
            stA.currentPlayer = actor; stB.currentPlayer = actor;
            let a = null, b = null;
            try {
                a = new modA.AICore(actor, difficulty, memA).playDecision(stA);
            } catch (e) { console.error('THROW A', difficulty, e.message); failures++; }
            try {
                b = new modB.AICore(actor, difficulty, memB).playDecision(stB);
            } catch (e) { console.error('THROW B', difficulty, e.message); failures++; }
            if (!a || !b) continue;
            checks++;
            const ka = a.map(c => c.id).sort().join(',');
            const kb = b.map(c => c.id).sort().join(',');
            if (ka !== kb) {
                failures++;
                console.error(`LEAK ${difficulty} plays=${playCount} game${g}: 决策随对手手牌改变  A=[${ka}] B=[${kb}]`);
            }
        }
    }
}
console.log(`公平性检查：${checks} 次对比，失败 ${failures}`);

// ===== 追加检查：Worker 侧的"瘦身状态"（对手只给张数）必须给出同样的决策 =====
let slimFail = 0, slimChecks = 0;
for (const difficulty of DIFFS) {
    for (const playCount of [0, 3]) {
        const { state, memory, landlord } = makeState(makeRng(20240601 + playCount), playCount);
        const actor = (landlord + 1) % 3;
        const modA = loadAI('ai_core.js', SYMBOLS, makeRng(SEED), fast);
        const modB = loadAI('ai_core.js', SYMBOLS, makeRng(SEED), fast);
        const memA = new modA.MasterMemory();
        const memB = new modB.MasterMemory();
        memA.seen = new Set(memory.seen);
        memB.seen = new Set(memory.seen);
        const full = JSON.parse(JSON.stringify(state));
        full.currentPlayer = actor;
        // 瘦身版：只保留自己的手牌，对手仅剩张数（与 Worker / 联机同步一致）
        const slim = JSON.parse(JSON.stringify(state));
        slim.players = slim.players.map((p, idx) => (idx === actor ? p : { length: p.length }));
        slim.currentPlayer = actor;
        let a = null, b = null;
        try {
            a = new modA.AICore(actor, difficulty, memA).playDecision(full);
            b = new modB.AICore(actor, difficulty, memB).playDecision(slim);
        } catch (e) { console.error('THROW slim', difficulty, e.message); slimFail++; continue; }
        if (!a || !b) { slimFail++; continue; }
        slimChecks++;
        const ka = a.map(c => c.id).sort().join(',');
        const kb = b.map(c => c.id).sort().join(',');
        if (ka !== kb) { slimFail++; console.error(`SLIM MISMATCH ${difficulty} plays=${playCount}: A=[${ka}] B=[${kb}]`); }
        // 合法性：必须是自己的手牌、且能压过上家
        const ownIds = new Set(full.players[actor].map(c => c.id));
        for (const c of (b || [])) if (!ownIds.has(c.id)) { slimFail++; console.error('ILLEGAL CARD slim', difficulty); }
        if (b && b.length > 0 && full.lastPlay && full.lastPlayerId !== actor) {
            const bt = modB.getCardType(b);
            if (!bt || !modB.canBeat(bt, full.lastPlay)) { slimFail++; console.error('CANNOT BEAT slim', difficulty); }
        }
    }
}
console.log(`瘦身状态检查：${slimChecks} 次对比，失败 ${slimFail}`);
failures += slimFail;
process.exit(failures > 0 ? 1 : 0);
