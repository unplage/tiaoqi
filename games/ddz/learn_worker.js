// learn_worker.js — 学习管线 Worker（把重活从主线程彻底移走）
//
// 存在的理由：
//   旧实现在主线程同步跑「反事实分析 + 自对弈验证」，每局结束后阻塞 25~43 秒，
//   界面直接卡死；而且慢设备上根本跑不完，验证永远失败 → 参数永不落地。
//
// 这里跑的东西：
//   1) 反事实分析：把每一步与「搜索最优解」对比，找出明显更差的走法
//   2) 权重更新：把反事实标签转成评分权重的调整量
//   3) 自对弈验证：候选参数 vs 当前参数，配对同牌局 + 统计检验
//   4) 只有统计显著的提升才会被采纳并回传主线程
//
// 关键：搜索是「盲」的（看不到对手手牌），保证公平性红线不被破坏。

importScripts('ai_core.js');

// ======================== 参数注入 ========================
// Worker 里通过 __aiParamGet 提供参数，ai_core.js 的 cfg() 会优先读它。
let _baseParams = null;      // 当前生效（已采纳）的参数
let _activeOverride = null;  // A/B 评估时的临时覆盖

function paramGet(path) {
    const src = _activeOverride || _baseParams;
    if (src) {
        let val = src;
        for (const p of path.split('.')) {
            if (val && typeof val === 'object') val = val[p];
            else { val = undefined; break; }
        }
        if (val !== undefined) return val;
    }
    let val = DEFAULT_PARAMS;
    for (const p of path.split('.')) { val = val[p]; if (val === undefined) break; }
    return val;
}
globalThis.__aiParamGet = paramGet;

// 评估用的确定性覆盖：搜索只看迭代/节点预算，不看挂钟 → 同 seed 必然同结果
function deterministicParams(p) {
    const out = JSON.parse(JSON.stringify(p || {}));
    // 预算刻意比线上小：验证要跑几十上百局，必须在可接受时间内完成；
    // 而且 A/B 比较只需要"一致的策略"，不需要"最强的策略"。
    // 注意：候选自己的搜索档位必须被尊重（否则无法评估"关掉搜索"这类候选），
    // 只做下限保护，避免 0 预算导致的退化。
    const srcSearch = out.search || {};
    const src = out.blind || {};
    // 默认预算取 ai_core 的 search.* 默认值（本身就是评测档）；
    // 候选显式设置时予以尊重 —— 这样才能评估"关掉搜索"这类候选。
    out.search = Object.assign({}, srcSearch, {
        deterministic: true,
        nodeBudget: Math.max(200, srcSearch.nodeBudget || 1200),
        mctsIterations: Math.max(1, srcSearch.mctsIterations || 40),
        mctsWorlds: Math.max(1, srcSearch.mctsWorlds || 1)
    });
    out.randomFactors = Object.assign({}, out.randomFactors || {}, {
        easy: 0, medium: 0, hard: 0, grandmaster: 0, legendary: 0
    });
    // 采样世界数收敛到最小：
    //  · sim    —— 每个候选一次 rollout，最贵
    //  · endgame —— 每个候选 × 每个世界一次 minimax，节点开销大
    //  · mcts   —— 确定性模式下已由 search.mctsWorlds 接管
    // A/B 比较只需要"一致的策略"，不需要"最强的策略"。
    const worlds = {};
    const srcWorlds = (src && src.worlds) || {};
    for (const d of ['easy', 'medium', 'hard', 'grandmaster', 'legendary']) {
        worlds[d] = {
            endgame: Math.min((srcWorlds.endgame && srcWorlds.endgame[d]) || 2, 2),
            mcts: 0,
            sim: Math.min((srcWorlds.sim && srcWorlds.sim[d]) || 1, 1),
            call: Math.min((srcWorlds.call && srcWorlds.call[d]) || 2, 2)
        };
    }
    out.blind = Object.assign({}, out.blind || {}, { worlds });
    // 领出被压概率的估计很贵（每个样本都要重新采样世界并枚举对手的应牌）
    const bpS = {}, bpC = {};
    for (const d of ['easy', 'medium', 'hard', 'grandmaster', 'legendary']) {
        bpS[d] = Math.min((src.blind && src.blind.beatProbSamples && src.blind.beatProbSamples[d]) || 2, 2);
        bpC[d] = Math.min((src.blind && src.blind.beatProbCandidates && src.blind.beatProbCandidates[d]) || 2, 2);
    }
    out.blind.beatProbSamples = bpS;
    out.blind.beatProbCandidates = bpC;
    return out;
}

// 线上强度档验证：只关随机/开确定性以保证复现，保留真实搜索预算。
// 旧的 deterministicParams 把所有预算砍到 40 iter / 1 world → 在弱策略下 A/B 赢，
// 不代表线上强策略也赢。最终采纳前必须用本函数再验一次。
function strongParams(p) {
    const out = JSON.parse(JSON.stringify(p || {}));
    out.search = Object.assign({}, out.search || {}, { deterministic: true });
    out.randomFactors = Object.assign({}, out.randomFactors || {}, {
        easy: 0, medium: 0, hard: 0, grandmaster: 0, legendary: 0
    });
    return out;
}

// ======================== 统计 ========================
function wilson(wins, n, z) {
    if (!n) return { lo: 0, hi: 0 };
    z = z || 1.96;
    const p = wins / n, z2 = z * z;
    const denom = 1 + z2 / n;
    const centre = (p + z2 / (2 * n)) / denom;
    const half = (z / denom) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
    return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}
function normalCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp(-z * z / 2);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z > 0 ? 1 - p : p;
}
// McNemar 检验（配对二项）
function mcnemar(b, c) {
    const n = b + c;
    if (!n) return { p: 1 };
    const z = (Math.abs(b - c) - 1) / Math.sqrt(n);
    return { p: Math.max(0, Math.min(1, 2 * (1 - normalCdf(Math.abs(z))))) };
}

// ======================== 自对弈评估 ========================
// 配对设计：同一副牌，候选与基线各打一遍，且角色（地主/农民）严格平衡。
// 旧实现有三个致命问题：
//   1) difficulty 是自由标识符 → 浏览器里解析成 <select id="difficulty"> 这个 DOM 元素，
//      于是 AICore 拿到 "[object HTMLSelectElement]"：MCTS 全关、随机因子 0.6，
//      验证器测的是一个"半随机且不会搜索"的假 AI。
//   2) AI 出非法牌时静默替换成 plays[0] → 把 AI 的回归藏起来。
//   3) 16 秒预算只够跑 10 局，而采纳门槛要求 ≥20 局 → 永远不通过。
const SelfPlayEval = {
    _rngState: 0x2545f491,
    _rand() { this._rngState = (Math.imul(this._rngState, 1664525) + 1013904223) >>> 0; return this._rngState / 4294967296; },
    _shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this._rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; },
    _deal() {
        const suits = ['♠', '♥', '♣', '♦'];
        const ranks = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
        const deck = [];
        for (const s of suits) for (let i = 0; i < ranks.length; i++) deck.push({ suit: s, rank: ranks[i], value: i, id: s + ranks[i] });
        deck.push({ suit: 'JOKER', rank: '小王', value: 13, id: 'joker1' }, { suit: 'JOKER', rank: '大王', value: 14, id: 'joker2' });
        this._shuffle(deck);
        const hands = [[], [], []];
        for (let i = 0; i < 51; i++) hands[i % 3].push(deck.pop());
        const lordCards = deck.slice(0, 3);
        hands.forEach(h => h.sort((a, b) => a.value - b.value));
        return { hands, lordCards };
    },
    // 用指定参数决策某一座位的走法
    _decide(seat, state, memory, candSeat, cand, base, difficulty) {
        if (!difficulty || typeof difficulty !== 'string') difficulty = 'grandmaster';
        const prev = _activeOverride;
        _activeOverride = (seat === candSeat) ? cand : base;
        if (typeof invalidateParamCache === 'function') invalidateParamCache();
        try { return new AICore(seat, difficulty, memory).playDecision(state); }
        finally { _activeOverride = prev; if (typeof invalidateParamCache === 'function') invalidateParamCache(); }
    },
    _playDeal(deal, landlord, candSeat, cand, base, difficulty) {
        const players = deal.hands.map(p => p.map(c => ({ ...c })));
        players[landlord].push(...deal.lordCards);
        players[landlord].sort((a, b) => a.value - b.value);
        const memory = new MasterMemory();
        const state = {
            players, landlord, currentPlayer: landlord, lastPlay: null, lastPlayerId: -1, passCount: 0,
            baseScore: 1, bombCount: 0, firstPlayMade: false, lordPlayCount: 0, farmerPlayed: false,
            lordCards: deal.lordCards, callScores: [0, 0, 0], phase: 'playing',
        };
        let winner = -1;
        for (let guard = 0; guard < 300; guard++) {
            for (let i = 0; i < 3; i++) if (state.players[i].length === 0) { winner = i; break; }
            if (winner >= 0) break;
            if (state.passCount >= 2) { state.lastPlay = null; state.lastPlayerId = -1; state.passCount = 0; }
            const cp = state.currentPlayer;
            const hand = state.players[cp];
            const needBeat = state.lastPlay && state.lastPlayerId !== cp;
            const plays = needBeat ? getAllValidPlays(hand, state.lastPlay) : getAllValidPlays(hand, null);
            let chosen = null;
            if (plays.length === 0) chosen = [];
            else {
                try { chosen = this._decide(cp, state, memory, candSeat, cand, base, difficulty); }
                catch (e) { return { winner: -1, invalid: { seat: cp, reason: 'THROW:' + (e && e.message) } }; }
                if (!Array.isArray(chosen)) return { winner: -1, invalid: { seat: cp, reason: 'NON_ARRAY' } };
                if (chosen.length > 0) {
                    const ids = new Set(chosen.map(c => c.id));
                    if (!plays.find(p => p.length === chosen.length && p.every(c => ids.has(c.id)))) {
                        return { winner: -1, invalid: { seat: cp, reason: 'ILLEGAL_PLAY' } };
                    }
                } else if (chosen.length === 0 && !needBeat) {
                    return { winner: -1, invalid: { seat: cp, reason: 'ILLEGAL_PASS_AS_LEAD' } };
                }
            }
            if (!chosen || chosen.length === 0) { state.passCount++; }
            else {
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
        }
        if (winner < 0) {
            let b = 0, bl = 99;
            for (let i = 0; i < 3; i++) if (state.players[i].length < bl) { bl = state.players[i].length; b = i; }
            winner = b;
        }
        return { winner, invalid: null };
    },
    // 配对评估：候选 vs 基线，同一副牌、角色平衡
    async evaluate(cand, base, deals, timeBudgetMs, difficulty, seed, strength) {
        if (typeof AICore === 'undefined' || typeof getAllValidPlays === 'undefined') return null;
        difficulty = (typeof difficulty === 'string' && difficulty) ? difficulty : 'grandmaster';
        const t0 = Date.now();
        const budget = timeBudgetMs || 120000;
        const makeParams = (strength === 'strong') ? strongParams : deterministicParams;
        const candParams = makeParams(cand);
        const baseParams = makeParams(base);
        // 每次评估换种子：固定牌集会过拟合且 bootstrap CI 系统性过自信。
        // 测试可通过 seed 固定牌集以保证可复现（生产不传 → 随机）。
        this._rngState = (typeof seed === 'number' && Number.isFinite(seed))
            ? (seed >>> 0) : ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
        // 与采纳门槛统一：至少 30 局有效对局
        const minGames = Math.min(deals, 30);

        let games = 0, wins = 0, invalid = 0;
        const invalidReasons = {};
        const gameMs = [];
        const dealRates = [];     // 每副牌的候选胜率 → 用于配对 bootstrap
        const yieldToUI = () => new Promise(r => setTimeout(r, 0));

        for (let d = 0; d < deals; d++) {
            const deal = this._deal();
            // 地主轮转：角色完全平衡（旧实现用"最强手牌当地主"，地主胜率 ~66%，噪声巨大）
            const landlord = d % 3;
            let dealWins = 0, dealGames = 0;
            for (const cfg of [{ seat: landlord, isLord: true }, { seat: (landlord + 1) % 3, isLord: false }]) {
                const g0 = Date.now();
                const res = this._playDeal(deal, landlord, cfg.seat, candParams, baseParams, difficulty);
                gameMs.push(Date.now() - g0);
                if (res.invalid) {
                    invalid++;
                    const rs = res.invalid.reason || 'UNKNOWN';
                    invalidReasons[rs] = (invalidReasons[rs] || 0) + 1;
                    continue;
                }
                const candWon = cfg.isLord ? (res.winner === landlord) : (res.winner !== landlord);
                games++; dealGames++;
                if (candWon) { wins++; dealWins++; }
                await yieldToUI();
                if (Date.now() - t0 > budget) {
                    if (dealGames) dealRates.push(dealWins / dealGames);
                    return this._result(wins, games, invalid, invalidReasons, dealRates, true, games < minGames, gameMs);
                }
            }
            if (dealGames) dealRates.push(dealWins / dealGames);
        }
        return this._result(wins, games, invalid, invalidReasons, dealRates, false, games < minGames, gameMs);
    },
    _result(wins, games, invalid, invalidReasons, dealRates, partial, insufficient, gameMs) {
        const p = games > 0 ? wins / games : 0.5;
        const ci = wilson(wins, games);
        // 配对 bootstrap：按副牌为单位重采样，给出差值（相对 0.5）的置信区间
        const boot = this._bootstrap(dealRates);
        return {
            winRate: p, games, wins, invalid, invalidReasons: invalidReasons || {}, partial,
            avgGameMs: gameMs.length ? Math.round(gameMs.reduce((a, b) => a + b, 0) / gameMs.length) : 0,
            maxGameMs: gameMs.length ? Math.max.apply(null, gameMs) : 0,
            insufficient: !!insufficient,
            ciLo: ci.lo, ciHi: ci.hi,
            bootLo: boot.lo, bootHi: boot.hi,
            // 采纳条件：配对 bootstrap 的 95% 下界 > 0.5（即"优于基线"在 95% 置信度下成立）
            significant: boot.lo > 0.5
        };
    },
    _bootstrap(rates, iters) {
        const n = rates.length;
        if (!n) return { lo: 0.5, hi: 0.5 };
        iters = iters || 1500;
        const rng = makeRngLocal(0x9e3779b9);
        const means = [];
        for (let it = 0; it < iters; it++) {
            let sum = 0;
            for (let i = 0; i < n; i++) sum += rates[Math.floor(rng() * n)];
            means.push(sum / n);
        }
        means.sort((a, b) => a - b);
        return {
            lo: means[Math.max(0, Math.floor(0.025 * means.length))],
            hi: means[Math.min(means.length - 1, Math.floor(0.975 * means.length))]
        };
    }
};
function makeRngLocal(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ======================== 消息处理 ========================
const GodViewLearner = {
    _queue: [],
    _running: false,
    _adjustCount: 0,
    _ADJUST_INTERVAL: 1500,
    _lastAdjustTime: 0,
    _rngState: 0x9e3779b9,
    _statsCache: { total: 0, totalAnalyses: 0, recent20: 0, totalAdjustments: 0, avgDiff: 0 },
    _seed(seed) { this._rngState = (seed >>> 0) || 0x9e3779b9; },
    _rand() { this._rngState = (Math.imul(this._rngState, 1664525) + 1013904223) >>> 0; return this._rngState / 4294967296; },

    _initCache() {

    },

    // 权重表中与 extractPlayFeatures 字段名一致的键
    _WEIGHT_KEYS: [
        'playPower','isBomb','isRocket','remainTotal','remainSingle','remainPair',
        'remainTriple','remainBomb','remainMaxStraight','remainBigCards','hasRocket',
        'opponentHandCount','partnerHandCount','outsideBombCount','isCritical','needBeat',
        'turnsToFinish','sureTricks','controlCount','oppThreat','isPartnerLead',
        'turnsDelta','controlRetained','partnerFit','leadOppClose','bombUrgency'
    ],

    learn(game) {
        if (!game || !game.initialDeal || !game.actions || game.actions.length < 3) return;
        if (game.mode !== 'single') return;
        if (this._running) { this._queue.push(game); return; }
        this._running = true;
        let fn = () => this._run(game);
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(fn, { timeout: 4000 });
        } else {
            setTimeout(fn, 300);
        }
    },

    async _run(game) {
        try {
            this._seed(game.timestamp || Date.now());
            let stats = { checked: 0, corrected: 0, totalDelta: 0 };
            let corrections = this._analyzeGame(game, stats);
            if (corrections.length > 0) {
                this._saveCorrections(corrections);
                const applied = await this._applyAdjustments(corrections, stats);
                this._lastResult = applied || { accepted: false };
            }
        } catch (e) {
            console.warn('GodViewLearner error:', e.message);
        } finally {
            this._running = false;
            if (this._queue.length > 0) this.learn(this._queue.shift());
        }
    },

    _analyzeGame(game, stats) {
        let lordCards = game.initialDeal.lordCards.map(c => ({...c}));
        let players = game.initialDeal.players.map(p => p.map(c => ({...c})));
        let lordIdx = game.calling.landlord;
        if (lordIdx < 0) return [];
        players[lordIdx].push(...lordCards);
        players.forEach(p => p.sort((a,b)=>a.value-b.value));

        let state = {
            players: players.map(p => [...p]),
            landlord: lordIdx,
            currentPlayer: game.actions[0]?.p || 0,
            lastPlay: null, lastPlayerId: -1, passCount: 0, phase: 'playing'
        };
        let corrections = [];
        let aiPlayers = [0, 1, 2];

        for (let i = 0; i < game.actions.length; i++) {
            let action = game.actions[i];
            if (state.players.some(p => p.length === 0)) break;

            if (aiPlayers.includes(action.p)) {
                let hand = state.players[action.p];
                if (hand && hand.length > 0) {
                    stats.checked++;
                    let corr = this._checkCounterfactual(state, action, hand, lordIdx, i);
                    if (corr) { corrections.push(corr); stats.corrected++; stats.totalDelta += corr.diff; }
                }
            }
            this._advanceState(state, action);
        }
        return corrections;
    },

    _checkCounterfactual(state, action, hand, lordIdx, turnIdx) {
        let aiRole = action.p === lordIdx ? 'landlord' : 'farmer';
        let needBeat = state.lastPlay && state.lastPlayerId !== action.p;
        let isLead = !needBeat;

        let allPlays = getAllValidPlays(hand, needBeat ? state.lastPlay : null);
        if (!isLead && allPlays.length === 0) return null;
        let candidates = allPlays.slice();
        if (needBeat) candidates.push([]);

        // Step 1: Find optimal action + its win rate（过牌作为一等候选，不再单独用低样本补丁比较）
        let opt = this._findOptimal(state, action.p, candidates);
        let bestPlay = opt && opt.bestPlay ? opt.bestPlay : null;
        let bestWinRate = opt ? opt.bestWinRate : 0;

        // Step 2: Evaluate actual action's win rate
        let actualWinRate = this._evalPlay(state, action, action.p, lordIdx);

        // Step 4: Compare
        if (bestWinRate - actualWinRate < 0.20) return null;
        if (bestWinRate <= 0.3) return null;

        let actualPlay = action.pass ? [] : action.c;

        // Check they're truly different
        if (bestPlay.length === 0 && actualPlay.length === 0) return null;
        if (bestPlay.length > 0 && actualPlay.length > 0) {
            let ids1 = new Set(bestPlay.map(c => c.id));
            let ids2 = new Set(actualPlay.map(c => c.id));
            if (ids1.size === ids2.size && [...ids1].every(id => ids2.has(id))) return null;
        }

        let bestType = bestPlay.length > 0 ? getCardType(bestPlay) : null;
        let actualType = actualPlay.length > 0 ? getCardType(actualPlay) : null;

        // Step 5: Extract feature vectors for weight update
        let memory = this._buildMemoryFromState(state);
        let optFeat = null;
        if (bestPlay.length > 0) {
            optFeat = extractPlayFeatures(bestPlay, hand, state.lastPlay, aiRole, memory, state);
        }
        let actualFeat = null;
        if (actualPlay.length > 0) {
            actualFeat = extractPlayFeatures(actualPlay, hand, state.lastPlay, aiRole, memory, state);
        }

        let category = 'suboptimal';
        if (actualPlay.length === 0) category = 'bad_pass';
        else if (bestPlay.length === 0) category = 'bad_keep';
        else if ((actualType && (actualType.type === CardType.BOMB || actualType.type === CardType.ROCKET)) &&
                 !(bestType && (bestType.type === CardType.BOMB || bestType.type === CardType.ROCKET))) category = 'overkill';
        else if ((bestType && (bestType.type === CardType.BOMB || bestType.type === CardType.ROCKET)) &&
                 !(actualType && (actualType.type === CardType.BOMB || actualType.type === CardType.ROCKET))) category = 'missed_bomb';
        return {
            turnIdx, player: action.p, role: aiRole,
            diff: bestWinRate - actualWinRate,
            bestWinRate, actualWinRate,
            handSize: hand.length,
            lordSize: state.players[lordIdx]?.length || 0,
            opponentHandCount: state.lastPlayerId >= 0 && state.players[state.lastPlayerId] ? state.players[state.lastPlayerId].length : 0,
            lastPlayType: state.lastPlay?.type || 'none', lastPlayPower: state.lastPlay?.value || 0,
            isLead, category,
            actualType: actualType?.type || 'pass', bestType: bestType?.type || 'pass',
            optFeat, actualFeat
        };
    },

    _findOptimal(state, playerId, allPlays) {
        let hand = state.players[playerId];
        if (!hand || hand.length === 0 || allPlays.length === 0) return null;
        let totalCards = state.players.reduce((s, p) => s + p.length, 0);

        // Phase 1: 与线上一致的盲残局求解（旧实现 minimaxEndgame 直接读真实手牌 → 开天眼标签）
        if (hand.length <= 14 && totalCards <= 20 && typeof solveEndgameBlind !== 'undefined') {
            try {
                const belief = new HandBelief(playerId, state, null);
                const r = solveEndgameBlind(state, playerId, belief, {
                    worlds: 4, timeBudgetMs: 300, nodeLimit: 20000, difficulty: 'hard', memory: null
                });
                if (r && Array.isArray(r.play)) return { bestPlay: r.play, bestWinRate: 0.75 };
            } catch (e) { /* 回退到 rollout */ }
        }

        // Phase 2: Rollout-based approximation
        return this._solveRollout(state, playerId, allPlays);
    },

    _solveExact(state, playerId, allPlays) {
        let bestPlay = null, bestScore = -Infinity, found = false;
        for (let p of allPlays) {
            let simState = JSON.parse(JSON.stringify(state));
            let nextPlayer = (playerId + 1) % 3;
            let lastPlay, lastPlayerId, passCount;
            if (!p || p.length === 0) {
                passCount = (simState.passCount || 0) + 1;
                lastPlay = simState.lastPlay;
                lastPlayerId = simState.lastPlayerId;
                if (passCount >= 2) { lastPlay = null; lastPlayerId = -1; passCount = 0; }
            } else {
                let pIds = new Set(p.map(c => c.id));
                simState.players[playerId] = simState.players[playerId].filter(c => !pIds.has(c.id));
                if (simState.players[playerId].length === 0) {
                    return { bestPlay: p, bestWinRate: 1.0 };
                }
                lastPlay = getCardType(p);
                lastPlayerId = playerId;
                passCount = 0;
            }
            simState.lastPlay = lastPlay;
            simState.lastPlayerId = lastPlayerId;
            simState.passCount = passCount;
            let score = minimaxEndgame(simState, nextPlayer, playerId, 0, 20);
            if (score > bestScore) { bestScore = score; bestPlay = p; found = true; }
        }
        if (found) {
            let wr = Math.max(0, Math.min(1, (bestScore + 100) / 200));
            return { bestPlay, bestWinRate: wr };
        }
        return null;
    },

    _solveRollout(state, playerId, allPlays) {
        let memory = this._buildMemoryFromState(state);
        let role = playerId === state.landlord ? 'landlord' : 'farmer';
        // 冻结参考权重：标签生成用固定的默认参数，与正在被学习的权重解耦。
        // 旧实现用当前权重生成 rollout 又反过来更新同一批权重 → 闭环自证，学不出新策略。
        const refParams = (typeof DEFAULT_PARAMS !== 'undefined') ? DEFAULT_PARAMS : null;
        const withRef = (fn) => {
            if (typeof _withRefParams === 'function' && refParams) return _withRefParams(refParams, fn);
            return fn();
        };
        let scored = withRef(() => allPlays.map(p => {
            if (!p || p.length === 0) return { play: [], score: computePassScore(role, state) };
            let feat = extractPlayFeatures(p, state.players[playerId], state.lastPlay, role, memory, state);
            return { play: p, score: scorePlay(feat, role, memory, state, state.players[playerId]) };
        }));
        scored.sort((a, b) => b.score - a.score);
        // 不再只看启发式 top-8：保留全部候选中的高分项 + 牌型多样性 + 少量探索项，
        // 让复盘能发现启发式之外的更优动作。
        const candidates = [];
        const seen = new Set();
        const push = (play) => {
            const key = play.length ? play.map(c => c.id).sort().join(',') : 'pass';
            if (seen.has(key)) return;
            seen.add(key);
            candidates.push(play);
        };
        const seenTypes = new Set();
        for (const entry of scored) {
            const t = entry.play.length ? getCardType(entry.play) : null;
            if (!t || !seenTypes.has(t.type)) { if (t) seenTypes.add(t.type); push(entry.play); }
            if (candidates.length >= 10) break;
        }
        for (const entry of scored) {
            if (candidates.length >= 12) break;
            push(entry.play);
        }
        let bestPlay = null, bestWinRate = -1;
        for (const play of candidates) {
            let simState = JSON.parse(JSON.stringify(state));
            if (!play || play.length === 0) {
                const pc = (simState.passCount || 0) + 1;
                if (pc >= 2) { simState.lastPlay = null; simState.lastPlayerId = -1; simState.passCount = 0; }
                else simState.passCount = pc;
            } else {
                let ids = new Set(play.map(c => c.id));
                simState.players[playerId] = simState.players[playerId].filter(c => !ids.has(c.id));
                simState.lastPlay = getCardType(play);
                simState.lastPlayerId = playerId;
                simState.passCount = 0;
                if (simState.players[playerId].length === 0) {
                    return { bestPlay: play, bestWinRate: 1.0 };
                }
            }
            let wins = 0, trials = 12;
            for (let t = 0; t < trials; t++) {
                if (this._simulateGame(simState, (playerId+1)%3, playerId, state.landlord)) wins++;
            }
            let wr = wins / trials;
            if (wr > bestWinRate) { bestWinRate = wr; bestPlay = play; }
        }
        if (bestWinRate >= 0) return { bestPlay, bestWinRate };
        return null;
    },

    _evalPlay(state, action, aiPlayerId, lordIdx) {
        let simState = JSON.parse(JSON.stringify(state));
        if (action.pass) {
            simState.passCount++;
        } else {
            let ids = new Set(action.c.map(c => c.id));
            simState.players[action.p] = simState.players[action.p].filter(c => !ids.has(c.id));
            simState.lastPlay = getCardType(action.c.map(c => ({...c})));
            simState.lastPlayerId = action.p;
            simState.passCount = 0;
        }
        if (simState.players[action.p].length === 0) return 1.0;
        let wins = 0, trials = 12;
        for (let t = 0; t < trials; t++) {
            if (this._simulateGame(simState, (action.p+1)%3, aiPlayerId, lordIdx)) wins++;
        }
        return wins / trials;
    },

    _buildMemoryFromState(state) {
        const mem = new MasterMemory();
        // 将已经打出的牌（54 张里不在任何手牌中的牌）标记为可见，使 rollout 的记牌信息与当前局面一致
        const suits = ['♠', '♥', '♣', '♦'];
        const ranks = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
        const inHand = new Set();
        for (const p of state.players) for (const c of p) inHand.add(c.id);
        const all = [];
        for (const suit of suits) for (let i = 0; i < ranks.length; i++) all.push({ suit, rank: ranks[i], value: i, id: suit + ranks[i] });
        all.push({ suit: 'JOKER', rank: '小王', value: 13, id: 'joker1' });
        all.push({ suit: 'JOKER', rank: '大王', value: 14, id: 'joker2' });
        for (const c of all) if (!inHand.has(c.id)) mem.record([c]);
        return mem;
    },

    _simulateGame(startState, startPlayer, aiPlayerId, lordIdx, memory) {
        let s = JSON.parse(JSON.stringify(startState));
        let cp = startPlayer;
        if (!memory) memory = this._buildMemoryFromState(s);
        let limit = 50;
        for (let step = 0; step < limit; step++) {
            for (let i = 0; i < 3; i++) {
                if (s.players[i].length === 0) {
                    return aiPlayerId === lordIdx ? i === lordIdx : i !== lordIdx;
                }
            }
            if (s.passCount >= 2) { s.lastPlay = null; s.lastPlayerId = -1; s.passCount = 0; }
            let hand = s.players[cp];
            if (!hand || hand.length === 0) { cp = (cp + 1) % 3; continue; }
            let needBeat = s.lastPlay && s.lastPlayerId !== cp;
            let plays = needBeat ? getAllValidPlays(hand, s.lastPlay) : getAllValidPlays(hand, null);
            if (plays.length === 0) { s.passCount++; cp = (cp + 1) % 3; continue; }
            let role = cp === s.landlord ? 'landlord' : 'farmer';
            let scored = plays.map(p => {
                let feat = extractPlayFeatures(p, hand, s.lastPlay, role, memory, s);
                return { play: p, score: scorePlay(feat, role, memory, s, hand) };
            });
            // 过牌必须作为候选之一：之前 rollout 只会“有牌必打”，会严重高估主动出牌。
            scored.push({ play: [], score: computePassScore(role, s) });
            scored.sort((a, b) => b.score - a.score);
            let chosen = scored[0].play;
            if (chosen.length === 0) {
                s.passCount++;
                cp = (cp + 1) % 3;
                continue;
            }
            if (this._rand() < 0.12 && scored.length > 1 && scored[1].play.length > 0) {
                chosen = scored[1].play;
            }
            s.players[cp] = s.players[cp].filter(c => !chosen.includes(c));
            memory.recordPlayerPlay(cp, chosen);
            s.lastPlay = getCardType(chosen);
            s.lastPlayerId = cp;
            s.passCount = 0;
            cp = (cp + 1) % 3;
        }
        // 到达 step limit 时，用“我方是否更快走完 + 牌力”给出近似终局判断，
        // 而不是永远返回 false（会把所有 rollout 都判成输，污染反事实标签）。
        try {
            let mySide = (aiPlayerId === lordIdx) ? [aiPlayerId] : [0, 1, 2].filter(i => i !== lordIdx);
            let myLen = 0, oppLen = 0;
            for (let i = 0; i < 3; i++) {
                const len = (s.players[i] || []).length;
                if (mySide.includes(i)) myLen += len; else oppLen += len;
            }
            if (myLen !== oppLen) return myLen < oppLen;
            let myPower = 0, oppPower = 0;
            for (let i = 0; i < 3; i++) {
                let pw = 0;
                for (const c of (s.players[i] || [])) pw += 1 + (c.value >= 12 ? 3 : 0) + (c.value >= 11 ? 1 : 0);
                if (mySide.includes(i)) myPower += pw; else oppPower += pw;
            }
            return myPower >= oppPower;
        } catch (e) { return false; }
    },

    _advanceState(state, action) {
        if (action.pass) {
            state.passCount++;
            if (state.passCount >= 2) { state.lastPlay = null; state.lastPlayerId = -1; state.passCount = 0; }
        } else {
            let ids = new Set(action.c.map(c => c.id));
            state.players[action.p] = state.players[action.p].filter(c => !ids.has(c.id));
            state.lastPlay = getCardType(action.c.map(c => ({...c})));
            state.lastPlayerId = action.p;
            state.passCount = 0;
        }
        state.currentPlayer = (action.p + 1) % 3;
    },

    _saveCorrections(corrections) {
        this._statsCache.total += corrections.length;
    },

    // 世界模型 / 搜索的关键标量参数：之前完全硬编码，学习闭环碰不到。
    // 每项：{ def: 默认值, min, max, step: 单批最大步长 }
    _TUNABLE_PARAMS: {
        'blind.bombRiskWeight.hard':       { def: 40, min: 10, max: 70, step: 4 },
        'blind.bombRiskWeight.grandmaster':{ def: 40, min: 10, max: 70, step: 4 },
        'blind.bombRiskWeight.legendary':  { def: 40, min: 10, max: 70, step: 4 },
        'blind.beatProbWeight.hard':       { def: 10, min: 2, max: 20, step: 1.5 },
        'blind.beatProbWeight.grandmaster':{ def: 14, min: 3, max: 24, step: 2 },
        'blind.beatProbWeight.legendary':  { def: 18, min: 4, max: 30, step: 2 },
        'blind.robustness':                { def: 0.25, min: 0.1, max: 0.5, step: 0.03 },
        'mcts.ucbC':                       { def: 1.4, min: 0.8, max: 2.2, step: 0.1 },
        'endgame.maxOptions':              { def: 10, min: 6, max: 14, step: 1 },
        'mcts.rootBranch':                 { def: 12, min: 8, max: 16, step: 1 },
        'heuristicPlayout.richCandidates': { def: 8, min: 6, max: 12, step: 1 }
    },

    _FEATURE_SCALE: {
        playPower: 20, isBomb: 1, isRocket: 1, remainTotal: 20, remainSingle: 8, remainPair: 8,
        remainTriple: 6, remainBomb: 4, remainMaxStraight: 12, remainBigCards: 8, hasRocket: 1,
        isLandlord: 1, isFarmer: 1, opponentHandCount: 20, partnerHandCount: 20, outsideBombCount: 8,
        isCritical: 1, needBeat: 1,
        turnsToFinish: 6, sureTricks: 6, controlCount: 6, oppThreat: 8, isPartnerLead: 1,
        turnsDelta: 6, controlRetained: 1, partnerFit: 6, leadOppClose: 1, bombUrgency: 1
    },

    _effectiveParams() {
        const cur = _baseParams || DEFAULT_PARAMS;
        return JSON.parse(JSON.stringify(cur));
    },

    _defaultWeight(key) {
        const w = DEFAULT_PARAMS.weights;
        return (w && typeof w[key] === 'number') ? w[key] : 0;
    },

    _setNested(obj, path, value) {
        const parts = path.split('.');
        let o = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
            o = o[parts[i]];
        }
        o[parts[parts.length - 1]] = value;
    },

    async _applyAdjustments(corrections, stats) {
        let now = Date.now();
        if (now - this._lastAdjustTime < this._ADJUST_INTERVAL) return;
        this._lastAdjustTime = now;

        // 学习率：按「权重绝对步长」定义，而不是靠特征归一化后再乘一个小系数。
        // 旧实现：(Δfeature/scale) * lr，其中 playPower 的 scale=1000、lr=0.05
        //        → 单次调整量 ≈ 1e-4，再被 0.0005 阈值过滤掉
        //        → playPower（最重要的权重）**永远学不到**，其余权重也是"学了就等于没学"。
        let lr = 0.06 / (1 + 0.002 * this._adjustCount);
        if (lr < 0.01) lr = 0.01;

        let weightDeltas = {};
        let heuristicDeltas = {};
        const acc = {};   // 先按 key 聚合求均值，避免 correction 数量直接放大步长

        // 世界模型参数的调整方向由纠错类型驱动（全是公开对局结果，不看对手手牌）
        const categoryCount = { overkill: 0, missed_bomb: 0, bad_pass: 0, bad_keep: 0 };
        for (let corr of corrections) {
            if (corr.diff < 0.25) continue;
            if (categoryCount[corr.category] !== undefined) categoryCount[corr.category]++;

            // --- A: 线性权重更新（特征差按量纲归一化 → 取均值 → 乘学习率）---
            // 地主与农民目标不同 → 权重按角色分桶统计（weightsByRole.<role>.<key>）
            const roleKey = corr.role === 'landlord' ? 'landlord' : 'farmer';
            if (corr.optFeat && corr.actualFeat) {
                for (let key of this._WEIGHT_KEYS) {
                    let vOpt = corr.optFeat[key];
                    let vAct = corr.actualFeat[key];
                    if (vOpt === undefined || vAct === undefined) continue;
                    let delta = vOpt - vAct;
                    if (Math.abs(delta) < 0.01) continue;
                    let scale = this._FEATURE_SCALE[key] || 10;
                    const norm = delta / scale;              // 归一化到约 [-1,1]
                    if (Math.abs(norm) < 0.02) continue;
                    // 全局桶（所有样本）+ 角色桶（只含该角色样本）
                    for (const bucket of ['*', roleKey]) {
                        const ak = bucket + '.' + key;
                        if (!acc[ak]) acc[ak] = { sum: 0, n: 0 };
                        acc[ak].sum += norm; acc[ak].n++;
                    }
                }
            }

            // --- B: 启发式惩罚调整（按触发次数求均值，避免 correction 数量放大步长）---
            const addH = (key, val) => {
                if (!heuristicDeltas[key]) heuristicDeltas[key] = { sum: 0, n: 0 };
                heuristicDeltas[key].sum += val; heuristicDeltas[key].n++;
            };
            if (corr.actualType === 'pass' && corr.bestWinRate > 0.5 && corr.handSize >= 3) {
                addH('passScores.lordHandGt4', -3);
                addH('passScores.farmerPartnerBase', -3);
            }

            let isBombBest = corr.bestType === 'bomb' || corr.bestType === 'rocket';
            let isBombActual = corr.actualType === 'bomb' || corr.actualType === 'rocket';

            if (isBombBest && !isBombActual && corr.bestWinRate > 0.6) {
                addH('playHeuristics.bombUrgent.oppAboutToWin', 8);
            }
            if (!isBombBest && isBombActual && corr.actualWinRate < 0.4) {
                addH('playHeuristics.bombWasted.lowLastPower', -5);
                addH('playHeuristics.bombWasted.highLastPower', -5);
            }
        }

        // 构建候选参数（权重按默认值附近的有界窗口裁剪，防止漂移失控）
        for (const ak in acc) {
            const mean = acc[ak].sum / Math.max(1, acc[ak].n);
            weightDeltas[ak] = mean * lr;
        }

        let candidate = this._effectiveParams();
        let changed = 0;
        for (const ak in weightDeltas) {
            // ak 形如 "*.playPower"（全局桶）/ "landlord.playPower"（角色桶）
            const dot = ak.indexOf('.');
            const role = ak.slice(0, dot);
            const key = ak.slice(dot + 1);
            const isGlobal = role === '*';
            const path = isGlobal ? ('weights.' + key) : ('weightsByRole.' + role + '.' + key);
            let cur = paramGet(path);
            if (typeof cur !== 'number') cur = 0;
            let def = this._defaultWeight(key);
            let range = Math.max(4, Math.abs(def) * 3.0);
            // 单批次步长上限：避免一次学崩（上限为默认权重的 15%，新特征用绝对上限）
            let maxStep = def === 0 ? 0.4 : Math.max(0.05, Math.abs(def) * 0.15);
            let step = Math.max(-maxStep, Math.min(maxStep, weightDeltas[ak]));
            let nv = Math.max(def - range, Math.min(def + range, cur + step));
            if (Math.abs(nv - cur) < 0.002) continue;
            this._setNested(candidate, path, Math.round(nv * 10000) / 10000);
            changed++;
        }
        for (let path in heuristicDeltas) {
            const hd = heuristicDeltas[path];
            const delta = (hd.sum / Math.max(1, hd.n)) * lr;
            let cur = paramGet(path);
            if (typeof cur !== 'number') continue;
            let nv = Math.max(-999, Math.min(999, cur + delta));
            if (Math.abs(nv - cur) < 0.0005) continue;
            this._setNested(candidate, path, Math.round(nv * 10000) / 10000);
            changed++;
        }
        // ===== 世界模型 / 搜索参数调整（纠错类型驱动 + 有界裁剪）=====
        const tuneHints = [];
        const n = Math.max(1, corrections.length);
        // 炸弹用多了 → 提高 bombRisk；错过炸弹 → 降低 bombRisk
        const bombDir = (categoryCount.overkill - categoryCount.missed_bomb) / n;
        if (Math.abs(bombDir) > 0.05) {
            for (const d of ['hard','grandmaster','legendary'])
                tuneHints.push({ path: 'blind.bombRiskWeight.' + d, dir: bombDir });
        }
        // 不该过牌却过了 → 提高 beatProbWeight；不该出却出了 → 降低
        const beatDir = (categoryCount.bad_pass - categoryCount.bad_keep) / n;
        if (Math.abs(beatDir) > 0.05) {
            for (const d of ['hard','grandmaster','legendary'])
                tuneHints.push({ path: 'blind.beatProbWeight.' + d, dir: beatDir });
        }
        for (const hint of tuneHints) {
            const spec = this._TUNABLE_PARAMS[hint.path];
            if (!spec) continue;
            const cur = paramGet(hint.path);
            if (typeof cur !== 'number') continue;
            const step = Math.max(-spec.step, Math.min(spec.step, hint.dir * spec.step * 3));
            const nv = Math.max(spec.min, Math.min(spec.max, Math.round((cur + step) * 10000) / 10000));
            if (Math.abs(nv - cur) < 0.0005) continue;
            this._setNested(candidate, hint.path, nv);
            changed++;
        }

        if (changed === 0) return;

        // 自我对弈 A/B 验证：候选参数必须不劣于当前参数才采纳。
        // 之前 6 副牌 + 0.45 门禁，几乎无法区分噪声与真实提升，因此这里提升到
        // 10 副牌 / 20 paired games，并要求 A/B 胜率不低于 50%。
        let base = this._effectiveParams();
        let validation = null;
        // ===== 两级验证门禁 =====
        // 第 1 级：弱档快速筛选（40 iter / 1 world），排除明显更差的候选
        try { validation = await SelfPlayEval.evaluate(candidate, base, 30, 90000, 'grandmaster', undefined, 'fast'); }
        catch (e) { validation = null; }
        stats.validated = true;
        stats.validationWinRate = validation ? validation.winRate : null;
        stats.validationGames = validation ? validation.games : 0;
        let accepted = false;
        if (validation && !validation.insufficient && validation.games >= 30 && validation.invalid === 0
            && validation.bootLo > 0.5) {
            // 第 2 级：线上强度档确认（保留真实 MCTS/世界预算）。
            // 弱档赢不代表强档也赢 —— 必须在强档再验一次才采纳。
            // 强档更贵：12 副牌/24 局，预算 240s；门槛略放宽到 winRate>0.55 && bootLo>0.45
            // （样本少 CI 宽，但第 1 级已提供较强的筛选证据）。
            let strong = null;
            try { strong = await SelfPlayEval.evaluate(candidate, base, 12, 240000, 'grandmaster', undefined, 'strong'); }
            catch (e) { strong = null; }
            stats.strongValidation = strong ? {
                winRate: strong.winRate, games: strong.games, bootLo: strong.bootLo
            } : null;
            accepted = !!(strong && !strong.insufficient && strong.games >= 16 &&
                strong.invalid === 0 && strong.winRate > 0.55 && strong.bootLo > 0.45);
            stats.validationLowerBound = strong ? strong.bootLo : validation.bootLo;
            stats.validationUpperBound = strong ? strong.bootHi : validation.bootHi;
        }
        if (!accepted) {
            this._statsCache.rejected = (this._statsCache.rejected || 0) + 1;
            this._statsCache.lastValidation = stats.validationWinRate;
            return { accepted: false, validation };
        }

        this._adjustCount++;
        this._statsCache.totalAdjustments = this._adjustCount;
        this._statsCache.accepted = (this._statsCache.accepted || 0) + 1;
        this._statsCache.lastValidation = stats.validationWinRate;
        return { accepted: true, params: candidate, validation };
    },

    getStats() { return this._statsCache; },

    getRecentCorrections() { return Promise.resolve([]); }
};;

function post(msg) { try { self.postMessage(msg); } catch (e) {} }

self.onmessage = async function (e) {
    const msg = e.data || {};
    try {
        switch (msg.cmd) {
            case 'init': {
                _baseParams = msg.baseParams || null;
                post({ status: 'ready' });
                break;
            }
            case 'evaluate': {
                const res = await SelfPlayEval.evaluate(msg.candParams, msg.baseParams, msg.deals || 30, msg.timeBudgetMs || 90000, msg.difficulty, msg.seed, msg.strength);
                post({ taskId: msg.taskId, validation: res });
                break;
            }
            case 'learn': {
                if (msg.baseParams) _baseParams = msg.baseParams;
                // 单例化：旧实现每条 learn 消息重建 learner → _adjustCount 归零、lr 永不退火
                if (!globalThis.__ddzLearner) {
                    globalThis.__ddzLearner = Object.create(GodViewLearner);
                    globalThis.__ddzLearner._queue = []; globalThis.__ddzLearner._running = false;
                    globalThis.__ddzLearner._adjustCount = 0; globalThis.__ddzLearner._lastAdjustTime = 0;
                    globalThis.__ddzLearner._statsCache = { total: 0, totalAnalyses: 0, recent20: 0, totalAdjustments: 0, avgDiff: 0, accepted: 0, rejected: 0 };
                }
                const learner = globalThis.__ddzLearner;
                learner._seed((msg.game && msg.game.timestamp) || Date.now());
                const stats = { checked: 0, corrected: 0, totalDelta: 0 };
                const corrections = learner._analyzeGame(msg.game, stats);
                let applied = { accepted: false };
                if (corrections.length > 0) {
                    learner._saveCorrections(corrections);
                    post({ cmd: 'corrections', taskId: 'corrections', corrections });
                    applied = await learner._applyAdjustments(corrections, stats);
                }
                post({
                    taskId: msg.taskId,
                    accepted: !!(applied && applied.accepted),
                    params: applied && applied.params ? applied.params : null,
                    validation: applied && applied.validation ? applied.validation : null,
                    corrections: corrections,
                    stats: stats
                });
                break;
            }
            case 'selfplay': {
                // 自博弈产生带标签的位置（未来用于训练评估网络）
                const res = await SelfPlayEval.evaluate(msg.candParams, msg.baseParams, msg.deals || 10, msg.timeBudgetMs || 30000, msg.difficulty);
                post({ taskId: msg.taskId, validation: res });
                break;
            }
        }
    } catch (err) {
        post({ taskId: msg.taskId, error: (err && err.message) ? err.message : String(err) });
    }
};
post({ status: 'ready' });
