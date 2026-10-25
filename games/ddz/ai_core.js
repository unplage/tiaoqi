// ai_core.js — 共享 AI 内核（浏览器 <script> 与 Worker importScripts 双端复用）
// 依赖：无（通过 cfg()/matchRules() 适配外部参数与纠错规则）
// 浏览器：务必在 ai_learner.js 之前加载
'use strict';

// ======================== 参数访问适配层 ========================
// 优先级：ParamConfig(browser) > globalThis.__aiParamGet(worker) > globalThis.__AI_PARAMS__(bench) > DEFAULT_PARAMS
function cfg(path) {
    try {
        if (typeof ParamConfig !== 'undefined' && ParamConfig && typeof ParamConfig.get === 'function') {
            const v = ParamConfig.get(path);
            if (v !== undefined) return v;
        }
    } catch (e) {}
    try {
        if (typeof globalThis !== 'undefined') {
            const pg = globalThis.__aiParamGet;
            if (typeof pg === 'function') { const v = pg(path); if (v !== undefined) return v; }
            const ov = globalThis.__AI_PARAMS__;
            if (ov) {
                let val = ov, ok = true;
                for (const p of path.split('.')) { if (val && typeof val === 'object' && p in val) val = val[p]; else { ok = false; break; } }
                if (ok) return val;
            }
        }
    } catch (e) {}
    let val = DEFAULT_PARAMS;
    for (const p of path.split('.')) { val = (val && typeof val === 'object') ? val[p] : undefined; if (val === undefined) break; }
    return val;
}
function matchRules(ctx) {
    try {
        if (typeof CorrectionRules !== 'undefined' && CorrectionRules && typeof CorrectionRules.match === 'function') return CorrectionRules.match(ctx);
        if (typeof globalThis !== 'undefined' && typeof globalThis.__aiMatchRules === 'function') return globalThis.__aiMatchRules(ctx);
    } catch (e) {}
    return [];
}

const CardType = {
    SINGLE:'single', PAIR:'pair', TRIPLE:'triple', TRIPLE_WITH_SINGLE:'triple_single', TRIPLE_WITH_PAIR:'triple_pair',
    STRAIGHT:'straight', STRAIGHT_PAIR:'straight_pair', FOUR_WITH_TWO_SINGLE:'four_two_single', FOUR_WITH_TWO_PAIR:'four_two_pair',
    BOMB:'bomb', ROCKET:'rocket',
    PLANE:'plane', PLANE_WITH_SINGLE:'plane_single', PLANE_WITH_PAIR:'plane_pair'
};
function countValues(values) { let cnt = {}; values.forEach(v => cnt[v] = (cnt[v] || 0) + 1); return cnt; }
function isStraight(values) { for (let i = 1; i < values.length; i++) if (values[i] !== values[i-1] + 1) return false; return true; }
function getCombinations(arr, k) {
    if (k === 0) return [[]];
    if (arr.length < k) return [];
    let result = [];
    for (let i = 0; i <= arr.length - k; i++) {
        for (let sub of getCombinations(arr.slice(i + 1), k - 1))
            result.push([arr[i], ...sub]);
    }
    return result;
}
function getCardType(cards) {
    if (!cards || cards.length === 0) return null;
    const sorted = [...cards].sort((a,b)=>a.value-b.value);
    const values = sorted.map(c=>c.value);
    const uniq = [...new Set(values)];
    if (cards.length === 2 && cards.some(c=>c.id==='joker1') && cards.some(c=>c.id==='joker2')) return { type:CardType.ROCKET, value:100, cards:sorted };
    if (cards.length === 1) return { type:CardType.SINGLE, value:values[0], cards:sorted };
    if (cards.length === 2 && uniq.length === 1) return { type:CardType.PAIR, value:values[0], cards:sorted };
    if (cards.length === 3 && uniq.length === 1) return { type:CardType.TRIPLE, value:values[0], cards:sorted };
    if (cards.length === 4 && uniq.length === 1) return { type:CardType.BOMB, value:values[0]+50, cards:sorted };
    if (cards.length === 4 && uniq.length === 2) { let cnt = countValues(values); if (Object.values(cnt).includes(3)) return { type:CardType.TRIPLE_WITH_SINGLE, value:parseInt(Object.keys(cnt).find(k=>cnt[k]===3)), cards:sorted }; }
    if (cards.length === 5 && uniq.length === 2) { let cnt = countValues(values); if (Object.values(cnt).includes(3) && Object.values(cnt).includes(2)) return { type:CardType.TRIPLE_WITH_PAIR, value:parseInt(Object.keys(cnt).find(k=>cnt[k]===3)), cards:sorted }; }
    if (cards.length === 6) { let cnt = countValues(values); let four = Object.keys(cnt).find(k=>cnt[k]===4); if (four && Object.values(cnt).filter(v=>v===1).length === 2) return { type:CardType.FOUR_WITH_TWO_SINGLE, value:parseInt(four), cards:sorted }; }
    if (cards.length === 8) { let cnt = countValues(values); let four = Object.keys(cnt).find(k=>cnt[k]===4); if (four && Object.values(cnt).filter(v=>v===2).length === 2) return { type:CardType.FOUR_WITH_TWO_PAIR, value:parseInt(four), cards:sorted }; }
    if (cards.length >= 5 && uniq.length === cards.length && isStraight(values) && values[cards.length-1] <= 11 && !values.includes(12)) return { type:CardType.STRAIGHT, value:values[0], length:cards.length, cards:sorted };
    if (cards.length >= 6 && cards.length % 2 === 0) {
        let cnt = countValues(values);
        let pairs = Object.keys(cnt).filter(k=>cnt[k]===2).map(Number).sort((a,b)=>a-b);
        if (pairs.length === cards.length/2 && isStraight(pairs) && pairs[pairs.length-1] <= 11) return { type:CardType.STRAIGHT_PAIR, value:pairs[0], length:pairs.length, cards:sorted };
    }
    if (cards.length >= 6 && cards.length % 3 === 0) {
        let cnt = countValues(values);
        let tripVals = Object.keys(cnt).filter(k=>cnt[k]===3).map(Number).sort((a,b)=>a-b);
        let groupLen = cards.length / 3;
        if (tripVals.length === groupLen && groupLen >= 2 && isStraight(tripVals) && tripVals[groupLen-1] <= 11)
            return { type:CardType.PLANE, value:tripVals[0], length:groupLen, cards:sorted };
    }
    if (cards.length >= 8 && cards.length % 4 === 0) {
        let cnt = countValues(values);
        let groupLen = cards.length / 4;
        let tripVals = Object.keys(cnt).filter(k=>cnt[k]>=3).map(Number).sort((a,b)=>a-b);
        for (let i=0; i+groupLen<=tripVals.length; i++) {
            let seq = tripVals.slice(i, i+groupLen);
            if (!isStraight(seq) || seq[groupLen-1]>11) continue;
            let used = new Set(seq);
            let remain = Object.keys(cnt).filter(k=>!used.has(parseInt(k)) && cnt[k]===1);
            if (remain.length === groupLen)
                return { type:CardType.PLANE_WITH_SINGLE, value:seq[0], length:groupLen, cards:sorted };
        }
    }
    if (cards.length >= 10 && cards.length % 5 === 0) {
        let cnt = countValues(values);
        let groupLen = cards.length / 5;
        let tripVals = Object.keys(cnt).filter(k=>cnt[k]>=3).map(Number).sort((a,b)=>a-b);
        for (let i=0; i+groupLen<=tripVals.length; i++) {
            let seq = tripVals.slice(i, i+groupLen);
            if (!isStraight(seq) || seq[groupLen-1]>11) continue;
            let used = new Set(seq);
            let remain = Object.keys(cnt).filter(k=>!used.has(parseInt(k)) && cnt[k]===2);
            if (remain.length === groupLen)
                return { type:CardType.PLANE_WITH_PAIR, value:seq[0], length:groupLen, cards:sorted };
        }
    }
    return null;
}
function canBeat(current, last) {
    if (!last) return true;
    if (current.type === CardType.ROCKET) return true;
    if (last.type === CardType.ROCKET) return false;
    if (current.type === CardType.BOMB && last.type !== CardType.BOMB) return true;
    if (last.type === CardType.BOMB && current.type !== CardType.BOMB) return false;
    if (current.type !== last.type) return false;
    if (current.length && current.length !== last.length) return false;
    return current.value > last.value;
}
function getPlayPower(play) {
    if (!play) return 0;
    let type = getCardType(play);
    if (!type) return 0;
    if (type.type === CardType.ROCKET) return 1000;
    if (type.type === CardType.BOMB) return 500 + type.value;
    let base = 0;
    switch (type.type) {
        case CardType.SINGLE: base = type.value; break;
        case CardType.PAIR: base = type.value + 20; break;
        case CardType.TRIPLE: base = type.value + 40; break;
        case CardType.TRIPLE_WITH_SINGLE: base = type.value + 60; break;
        case CardType.TRIPLE_WITH_PAIR: base = type.value + 70; break;
        case CardType.STRAIGHT: base = type.value + 80 + type.length; break;
        case CardType.STRAIGHT_PAIR: base = type.value + 90 + type.length; break;
        case CardType.PLANE: base = type.value + 100 + type.length * 3; break;
        case CardType.PLANE_WITH_SINGLE: base = type.value + 110 + type.length * 3; break;
        case CardType.PLANE_WITH_PAIR: base = type.value + 120 + type.length * 3; break;
        case CardType.FOUR_WITH_TWO_SINGLE: base = type.value + 110; break;
        case CardType.FOUR_WITH_TWO_PAIR: base = type.value + 120; break;
        default: base = type.value;
    }
    return base;
}
function _canContend(lastPlay, type) {
    if (!lastPlay) return true;
    if (type === CardType.ROCKET) return true;
    if (type === CardType.BOMB) return lastPlay.type !== CardType.ROCKET;
    return type === lastPlay.type;
}

// ======================== 参数配置 ========================
const DEFAULT_PARAMS = {
    version: 4,
    weights: {
        playPower: 1.0, isBomb: -30, isRocket: -50,
        remainTotal: -2, remainSingle: -1.5, remainPair: -2,
        remainTriple: -4, remainBomb: 15, remainMaxStraight: 3,
        remainBigCards: 1, hasRocket: 10, isLandlord: 5, isFarmer: 0,
        opponentHandCount: -1, partnerHandCount: 3, outsideBombCount: -5,
        isCritical: 40, needBeat: 25
    },
    evalCoeffs: {
        bomb: 50, triple: 10, pair: 3,
        bothJokers: 50, bigJokerOnly: 18, smallJokerOnly: 10,
        ace: 9, king: 7, queen: 5, straightLenFactor: 4,
        singlePenalty: -3, pairExtra: 2, tripleExtra: 3,
        bombOutsideBonus: 8, position2Bonus: 8, landlordBonus: 20
    },
    callThresholds: {
        easy: { one: 28 },
        medium: { one: 22, two: 32, three: 42 },
        hard: { one: 20, two: 30, three: 42, bombBonus: 20, bothJokersBonus: 20, singlePenaltyFactor: 3, positionBonus: 8 },
        grandmaster: { one: 20, two: 30, three: 42, bombBonus: 20, bothJokersBonus: 20, singlePenaltyFactor: 3, positionBonus: 8 },
        legendary: null
    },
    endgameThresholds: { legendary: 17, grandmaster: 17, hard: 15, medium: 9, easy: 7 },
    // ======================== 隐藏信息（Blind AI）参数 ========================
    // 公平性：AI 只使用公开信息（自己手牌 / 各家张数 / 已出牌 / 地主底牌），
    // 对手手牌一律不可见；搜索在采样出的"可能世界"里进行并跨世界聚合。
    blind: {
        enabled: true,
        // 各环节采样多少个可能世界（0 = 关闭该环节的世界采样）
        worlds: {
            endgame: { easy: 2, medium: 3, hard: 6, grandmaster: 8, legendary: 10 },
            mcts:    { easy: 0, medium: 0, hard: 3, grandmaster: 5, legendary: 6 },
            sim:     { easy: 0, medium: 0, hard: 2, grandmaster: 3, legendary: 4 },
            call:    { easy: 0, medium: 0, hard: 0, grandmaster: 0, legendary: 6 }
        },
        // 单次决策的时间预算（毫秒）
        endgameTimeBudgetMs: { easy: 120, medium: 200, hard: 700, grandmaster: 1100, legendary: 1500 },
        mctsTimeBudgetMs:    { easy: 0, medium: 0, hard: 900, grandmaster: 1400, legendary: 1900 },
        // 跨世界聚合的鲁棒系数：均值 − λ×标准差（压制"赌对手手牌"的走法）
        robustness: 0.25,
        // 领出被压概率的估计（样本数 / 权重 / 候选数）
        beatProbSamples:   { easy: 0, medium: 0, hard: 6, grandmaster: 8, legendary: 10 },
        beatProbWeight:    { easy: 0, medium: 0, hard: 10, grandmaster: 14, legendary: 18 },
        beatProbCandidates:{ easy: 0, medium: 0, hard: 4, grandmaster: 4, legendary: 5 },
        // 对手握炸概率的修正权重（对手很可能有炸时，降低我方用炸的优先级）
        bombRiskWeight: { easy: 0, medium: 0, hard: 40, grandmaster: 40, legendary: 40 },
        // 盲 MCTS 是否使用启发式根先验（1 = 开启）
        mctsRootPriors: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 },
        // 叫分模拟次数（传奇难度）
        callTrials: { legendary: 60 }
    },
    mcts: {
        ucbC: 1.4,
        rootBranch: 12, branch: 8,
        iterations: { legendary: 20000, grandmaster: 5000, hard: 600, medium: 0, easy: 0 },
        handLimit: { legendary: 17, grandmaster: 14, hard: 12, medium: 0, easy: 0 },
        timeLimit: 4000,
        timeLimitByDiff: { legendary: 4000, grandmaster: 2500, hard: 1200 }
    },
    simulation: {
        depth: { legendary: 2, grandmaster: 1, hard: 1, medium: 0, easy: 0 },
        handLimit: { legendary: 17, grandmaster: 15, hard: 15, medium: 0, easy: 0 },
        dpBonusFactor: { legendary: 0.3 },
        oppSampleSize: { depth1: 8, depth2: 15 }
    },
    randomFactors: { legendary: 0, grandmaster: 0.05, hard: 0.1, medium: 0.3, easy: 0.6 },
    playHeuristics: {
        partnerPlay: { handLe3: -200, lastPowerGe40: -80, lastPowerLe20: -50 },
        lordBeatPartner: { needBeat: 80, handLe4: 120 },
        farmerAssist: { partnerHandLe2PlayLe2: 60 },
        farmerBeatSmallSingle: { diffLe3: 40 },
        needBeatLastHighRemain: { lastPowerGe13: -40 },
        landlordLeadSingle: { le6: 20 },
        suppressSingle: { diffLe4: 80, diffLe7: 50, diffLe10: -20, diffGt10: -40 },
        suppressPair: { diffLe4: 60, diffLe7: 35, diffLe10: -10, diffGt10: -30 },
        farmerOppLowCards: { handLe6LastPowerLe10: 100 },
        farmerVsLord: { lastPowerLe8: 40, lastPowerLe11: 20 },
        landlordLeadLowPower: { powerLe6: 30, powerGe12: -40 },
        farmerLeadHigh: { powerGe12: -40, power1114PartnerLe4: -60 },
        bombUrgent: { oppAboutToWin: 150, landlordRemainLe4: 120, remainLe2: 200 },
        bombStrategic: { fewOutside: 40, rocketBonus: 30 },
        bombLead: { bomb: -500, rocket: -1000 },
        bombWasted: { lowLastPower: -120, highLastPower: -60, notCritical: -80 },
        nearWin: { remainLe3: 100 },
        kickerPenalty: { ge11: -60, ge13: -100, hasSmallerAlternative: -120 },
        overkill: { singleLe12: -250, pairLe10: -200 }
    },
    passScores: {
        farmerPartnerBase: 200, farmerPartnerHandLe3: -50,
        lordHandLe2: -999, lordHandLe4: -150, lordHandGt4: 20,
        landlordFarmerPlayed: -50, landlordFarmerHandLe3: -200,
        passCountGe1: -40
    },
    selectLead: {
        landlord: {
            bombPenalty: 100, longGte5: 20, longGte3: 10, pairPlay: 5,
            straightBonus: 15, straightPairBonus: 10, tripleWithBonus: 8,
            planeBonus: 12, planeWithBonus: 10,
            smallValLe6: 15, controlValGe12LenLe2: 30
        },
        farmer: {
            bombPenalty: -200, comboGte3: 10, partnerLow: 50, lordNext: 10
        }
    },
    dpScores: {
        rocket: 60, bomb: 50, straight: 30, straightLenFactor: 2,
        straightPair: 25, straightPairLenFactor: 2, tripleWith: 20,
        plane: 40, planeLenFactor: 3, planeWith: 30,
        pair: 5, triple: 8, single: -5, completeBonus: 100
    },
    heuristicPlayout: {
        bestProb: 0.80, top2Prob: 0.95, stepLimit: 60
    },
    endgame: {
        maxDepth: 20, bombDepthPenalty: 1,
        maxTotalCards: 20, maxHandCards: 17, nodeLimit: 200000, timeBudgetMs: 700
    },
        aiTiming: {
            thinkingSeconds: { legendary: 5, grandmaster: 4, hard: 3, medium: 2, easy: 2 },
            delayMs: { fast: 300, normal: 700, slow: 1200 }
        },
    analysis: {
        maxGames: -1,
        deterministic: true,
        minGameInterval: 2000
    }
};


// ======================== 记牌器 ========================
class MasterMemory {
    constructor() {
        this.remain = new Array(15).fill(4);
        this.remain[13] = 1; this.remain[14] = 1;
        this.seen = new Set();
        this.history = [];
        this.playerHistory = [[], [], []];
        this.totalCardsPlayed = [0, 0, 0];
    }
    record(cards) {
        cards.forEach(c => {
            if (!this.seen.has(c.id)) {
                this.seen.add(c.id);
                if (c.value >= 0 && c.value <= 14) this.remain[c.value]--;
            }
        });
        this.history.push(cards.map(c=>c.id));
    }
    recordPlayerPlay(playerId, cards) {
        if (this.playerHistory[playerId]) {
            this.playerHistory[playerId].push(cards.map(c=>c.id));
            this.totalCardsPlayed[playerId] += cards.length;
            this.record(cards);
        }
    }
    getRemain(v) { return this.remain[v] || 0; }
    getMaxOutside(myHand) {
        for (let v=14; v>=0; v--) {
            if (this.getRemain(v) > myHand.filter(c=>c.value===v).length) return v;
        }
        return 0;
    }
    isBombPossible() {
        for (let v=0; v<=12; v++) if (this.getRemain(v) >= 4) return true;
        return false;
    }
    getRemainingCounts() { return [...this.remain]; }
    _outsideCount(value, myHand) {
        let mine = 0;
        if (myHand) for (let c of myHand) if (c.value === value) mine++;
        return this.getRemain(value) - mine;
    }
    getOutsideBombCount(myHand) {
        let cnt = 0;
        for (let v=0; v<=12; v++) if (this._outsideCount(v, myHand) >= 4) cnt++;
        return cnt;
    }
    getOutsideRocketPossible(myHand) {
        return this._outsideCount(13, myHand) >= 1 && this._outsideCount(14, myHand) >= 1;
    }
}

// ======================== 设备速度标定（移动端自动降档） ========================
// 用 AI 自身最典型的计算（枚举一手 17 张牌的所有合法出牌）做一次轻量基准，
// 估算当前设备相对基准机的速度；AI 的时间预算按此比例缩放：
//   桌面 ≈ 1.0（预算不变）；中端手机 ≈ 0.4；低端机 ≈ 0.15
// 目的：移动端既不会因为算太久而"卡住不动"，也不会被看门狗判超时而丢弃着法。
const AI_PERF = { factor: 1, calibrated: false, refMs: 0 };
function _calibrationHand() {
    // 固定的一手 17 张牌（覆盖各种牌型），保证每次标定的负载一致
    const defs = [['3',0],['3',0],['4',1],['5',2],['6',3],['7',4],['8',5],['9',6],['10',7],
        ['J',8],['Q',9],['K',10],['A',11],['2',12],['2',12],['小王',13],['大王',14]];
    const suits = ['♠','♥','♣','♦'];
    return defs.map((d, i) => ({ suit: suits[i % 4], rank: d[0], value: d[1], id: suits[i % 4] + d[0] + (i > 13 ? '_' + i : '') }));
}
function calibrateAiSpeed(force) {
    if (AI_PERF.calibrated && !force) return AI_PERF.factor;
    AI_PERF.calibrated = true;
    try {
        const hand = _calibrationHand();
        getAllValidPlays(hand, null);            // 预热（JIT）
        let t0 = Date.now();
        for (let i = 0; i < 3; i++) getAllValidPlays(hand, null);
        let dt = Date.now() - t0;
        if (!(dt > 0)) dt = 1;
        AI_PERF.refMs = dt;
        const REF = 8;                            // 基准机（常见桌面）约 8ms
        AI_PERF.factor = Math.max(0.12, Math.min(1, REF / dt));
    } catch (e) { AI_PERF.factor = 1; }
    return AI_PERF.factor;
}

// ======================== 隐藏信息信念模型（Blind AI：对手手牌不可见） ========================
// 公平性红线：AI 只能使用【公开信息】——自己的手牌、各家剩余张数、已打出的牌、地主底牌。
// 对手手牌的具体牌面一律不可见；所有搜索在"由公开信息采样出的可能世界"里进行，并跨世界聚合估值。
// 新增搜索代码请统一走 HandBelief.sampleWorld()，禁止直接读取 state.players[对手]。
function allCards() {
    if (allCards._cache) return allCards._cache;
    const suits = ['♠', '♥', '♣', '♦'];
    const ranks = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
    const cards = [];
    for (const s of suits) for (let i = 0; i < ranks.length; i++) cards.push({ suit: s, rank: ranks[i], value: i, id: s + ranks[i] });
    cards.push({ suit: 'JOKER', rank: '小王', value: 13, id: 'joker1' });
    cards.push({ suit: 'JOKER', rank: '大王', value: 14, id: 'joker2' });
    allCards._cache = cards;
    return cards;
}
function comb(n, k) { if (k < 0 || k > n || n < 0) return 0; let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; }

class HandBelief {
    constructor(playerId, state, memory) {
        this.playerId = playerId;
        this.landlord = (state.landlord === undefined || state.landlord === null || state.landlord < 0) ? -1 : state.landlord;
        this.phase = state.phase || 'playing';
        const rawPlayers = state.players || [];
        const ownRaw = Array.isArray(rawPlayers[playerId]) ? rawPlayers[playerId] : [];
        this.ownHand = ownRaw.map(c => ({ ...c }));
        this.counts = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            const p = rawPlayers[i];
            // 对手可能以三种形式出现：完整手牌数组 / 张数 / {length:n}（Worker 侧的瘦身形式）
            if (Array.isArray(p)) this.counts[i] = p.length;
            else if (typeof p === 'number') this.counts[i] = p;
            else if (p && typeof p.length === 'number') this.counts[i] = p.length;
            else this.counts[i] = 0;
        }

        const ownIds = new Set(this.ownHand.map(c => c.id));
        // 地主底牌是公开信息：地主确定后所有人都知道这 3 张在谁手里
        this.knownByPlayer = [[], [], []];
        const lordCards = state.lordCards || [];
        const lordHasBottom = this.landlord >= 0 && (this.phase === 'playing' || this.counts[this.landlord] >= 20);
        if (lordHasBottom) for (const c of lordCards) if (!ownIds.has(c.id)) this.knownByPlayer[this.landlord].push({ ...c });
        const knownIds = new Set();
        for (const list of this.knownByPlayer) for (const c of list) knownIds.add(c.id);

        // 已打出的牌 = 公开信息（记牌器）
        const playedSet = new Set();
        if (memory && memory.seen) for (const id of memory.seen) if (!ownIds.has(id) && !knownIds.has(id)) playedSet.add(id);

        // 张数校准：自己手牌 + 对手手牌(按张数) + 已打出的牌 <= 54
        let oppNeed = 0;
        for (let i = 0; i < 3; i++) if (i !== playerId) oppNeed += this.counts[i];
        const maxPlayed = Math.max(0, 54 - this.ownHand.length - oppNeed);
        if (playedSet.size > maxPlayed) {
            const arr = [...playedSet];
            while (arr.length > maxPlayed) playedSet.delete(arr.pop());
        }
        // 未见牌池（对手手牌 + 未分配的底牌）
        const pool = [];
        for (const c of allCards()) {
            if (ownIds.has(c.id) || knownIds.has(c.id) || playedSet.has(c.id)) continue;
            pool.push(c);
        }
        // 牌池不足以填满对手手牌（记牌器滞后）→ 从"已打出"里回收，保持世界划分完整
        if (pool.length < oppNeed) {
            const arr = [...playedSet];
            while (pool.length < oppNeed && arr.length > 0) {
                const id = arr.pop();
                playedSet.delete(id);
                const card = allCards().find(c => c.id === id);
                if (card) pool.push(card);
            }
        }
        this.playedIds = playedSet;
        this.pool = pool;
        this.poolCounts = new Array(15).fill(0);
        for (const c of pool) this.poolCounts[c.value]++;
    }

    // 采样一个"可能世界"：自己的手牌精确，对手手牌按未见牌池随机分配（保留地主底牌归属）
    sampleWorld() {
        const pool = this.pool.slice();
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }
        const players = [[], [], []];
        players[this.playerId] = this.ownHand.map(c => ({ ...c }));
        let ptr = 0;
        for (let i = 0; i < 3; i++) {
            if (i === this.playerId) continue;
            const hand = this.knownByPlayer[i].map(c => ({ ...c }));
            const need = this.counts[i] - hand.length;
            for (let k = 0; k < need && ptr < pool.length; k++) hand.push(pool[ptr++]);
            hand.sort((a, b) => a.value - b.value);
            players[i] = hand;
        }
        return players;
    }
    sampleWorlds(n) {
        const out = [];
        for (let i = 0; i < n; i++) out.push(this.sampleWorld());
        return out;
    }
    // 某对手握有炸弹的概率（超几何分布，只依赖未见牌池）
    bombRiskFor(oppId) {
        const n = this.counts[oppId] || 0;
        const poolSize = this.pool.length;
        if (n < 4 || poolSize < 4) return 0;
        const denom = comb(poolSize, 4);
        if (!denom) return 0;
        let risk = 0;
        for (let v = 0; v <= 12; v++) {
            if (this.poolCounts[v] < 4) continue;
            risk += comb(n, 4) / denom;
        }
        return Math.min(1, risk);
    }
    // 某对手握有王炸的概率
    rocketRiskFor(oppId) {
        const n = this.counts[oppId] || 0;
        const poolSize = this.pool.length;
        if (n < 2 || poolSize < 2) return 0;
        if (this.poolCounts[13] < 1 || this.poolCounts[14] < 1) return 0;
        return Math.min(1, comb(n, 2) / comb(poolSize, 2));
    }
    // 估计某对手能压过 play 的概率（采样其可能手牌 → 检查是否存在合法应对）
    beatProbability(play, oppId, samples) {
        const type = getCardType(play);
        if (!type) return 0;
        let hit = 0, total = 0;
        for (let s = 0; s < samples; s++) {
            const players = this.sampleWorld();
            const hand = players[oppId];
            total++;
            if (!hand || hand.length === 0) continue;
            let can = false;
            try { can = getAllValidPlays(hand, type).length > 0; } catch (e) { can = false; }
            if (can) hit++;
        }
        return total > 0 ? hit / total : 0;
    }
}

// ======================== 手牌分析 ========================
function extractHandFeatures(hand) {
    let values = hand.map(c => c.value);
    let counts = new Array(15).fill(0);
    values.forEach(v => counts[v]++);
    let features = { single:0, pair:0, triple:0, bomb:0, maxStraightLen:0, maxStraightPairLen:0, bigCards:0, hasRocket:0, total:hand.length };
    for (let v=0; v<=14; v++) {
        if (counts[v] === 1) features.single++;
        else if (counts[v] === 2) features.pair++;
        else if (counts[v] === 3) features.triple++;
        else if (counts[v] === 4) features.bomb++;
        if (v >= 12) features.bigCards += counts[v];
    }
    if (counts[13] === 1 && counts[14] === 1) features.hasRocket = 1;
    let straight = 0, best = 0;
    for (let v=0; v<=11; v++) {
        if (counts[v] >= 1) straight++;
        else { best = Math.max(best, straight); straight = 0; }
    }
    best = Math.max(best, straight);
    features.maxStraightLen = best;
    let pairStraight = 0, bestPair = 0;
    for (let v=0; v<=11; v++) {
        if (counts[v] >= 2) pairStraight++;
        else { bestPair = Math.max(bestPair, pairStraight); pairStraight = 0; }
    }
    bestPair = Math.max(bestPair, pairStraight);
    features.maxStraightPairLen = bestPair;
    return features;
}

function evaluateHandStrength(hand, memory, isLandlord, callPosition) {
    let ec = cfg('evalCoeffs');
    let score = 0, values = hand.map(c=>c.value), cnt = countValues(values);
    for (let v in cnt) {
        if (cnt[v] === 4) score += ec.bomb;
        else if (cnt[v] === 3) score += ec.triple;
        else if (cnt[v] === 2) score += ec.pair;
    }
    if (hand.some(c=>c.value===14) && hand.some(c=>c.value===13)) score += ec.bothJokers;
    else { if (hand.some(c=>c.value===14)) score += ec.bigJokerOnly; if (hand.some(c=>c.value===13)) score += ec.smallJokerOnly; }
    score += (cnt[12]||0)*ec.ace + (cnt[11]||0)*ec.king + (cnt[10]||0)*ec.queen;
    let sortedUnique = [...new Set(values.filter(v=>v<13))].sort((a,b)=>a-b);
    let maxLen = 1, cur = 1;
    for (let i=1;i<sortedUnique.length;i++) { if (sortedUnique[i] === sortedUnique[i-1]+1) cur++; else { maxLen = Math.max(maxLen, cur); cur=1; } }
    maxLen = Math.max(maxLen, cur);
    score += maxLen * ec.straightLenFactor;
    let singleCount = Object.values(cnt).filter(c => c === 1).length;
    score += singleCount * ec.singlePenalty;
    let pairCount = Object.values(cnt).filter(c => c === 2).length;
    score += pairCount * ec.pairExtra;
    let tripleCount = Object.values(cnt).filter(c => c === 3).length;
    score += tripleCount * ec.tripleExtra;
    if (memory && memory.isBombPossible()) score += ec.bombOutsideBonus;
    if (callPosition === 2) score += ec.position2Bonus;
    if (isLandlord) score += ec.landlordBonus;
    return score;
}

function extractPlayFeatures(play, hand, lastPlay, role, memory, state) {
    let playType = getCardType(play);
    let newHand = hand.filter(c => !play.includes(c));
    let handFeatures = extractHandFeatures(newHand);
    let playPower = getPlayPower(play);
    let isBomb = [CardType.BOMB, CardType.ROCKET].includes(playType.type);
    let needBeat = (lastPlay && state.lastPlayerId !== state.currentPlayer);
    let partnerId = -1;
    if (role === 'farmer') {
        for (let i = 0; i < 3; i++) {
            if (i !== state.currentPlayer && i !== state.landlord) {
                partnerId = i;
                break;
            }
        }
    }
    let kickerValue = 0;
    if (playType.type === CardType.TRIPLE_WITH_SINGLE || playType.type === CardType.TRIPLE_WITH_PAIR) {
        let cnt = countValues(play.map(c=>c.value));
        let target = playType.type === CardType.TRIPLE_WITH_SINGLE ? 1 : 2;
        let kv = Object.keys(cnt).find(k => cnt[k] === target && parseInt(k) !== playType.value);
        if (kv !== undefined) kickerValue = parseInt(kv);
    }
    if (playType.type === CardType.PLANE_WITH_SINGLE || playType.type === CardType.PLANE_WITH_PAIR) {
        let cnt = countValues(play.map(c=>c.value));
        let target = playType.type === CardType.PLANE_WITH_SINGLE ? 1 : 2;
        let kickerVals = Object.keys(cnt).filter(k => cnt[k] === target).map(Number);
        kickerValue = kickerVals.length > 0 ? Math.max(...kickerVals) : 0;
    }
    let nextPlayerId = (state.currentPlayer + 1) % 3;
    return {
        playLength: play.length, playPower, isBomb: isBomb ? 1 : 0, isRocket: (playType.type === CardType.ROCKET) ? 1 : 0,
        remainTotal: newHand.length, remainSingle: handFeatures.single, remainPair: handFeatures.pair,
        remainTriple: handFeatures.triple, remainBomb: handFeatures.bomb, remainMaxStraight: handFeatures.maxStraightLen,
        remainBigCards: handFeatures.bigCards, hasRocket: handFeatures.hasRocket,
        isLandlord: (role === 'landlord') ? 1 : 0, isFarmer: (role === 'farmer') ? 1 : 0,
        opponentHandCount: state.lastPlayerId !== -1 ? state.players[state.lastPlayerId].length : 0,
        nextPlayerHandCount: state.players[nextPlayerId] ? state.players[nextPlayerId].length : 17,
        partnerHandCount: (role === 'farmer' && partnerId !== -1) ? (state.players[partnerId]?.length || 0) : 0,
        outsideBombCount: memory.getOutsideBombCount(hand), isCritical: (newHand.length <= 3) ? 1 : 0,
        needBeat: needBeat ? 1 : 0, lastPlayType: lastPlay ? lastPlay.type : 'none', lastPlayPower: lastPlay ? lastPlay.value : 0,
        playType: playType.type, kickerValue, mainValue: playType.value
    };
}

// ======================== 出牌生成 ========================
function getAllValidPlays(hand, lastPlay = null) {
    if (!hand || hand.length === 0) return [];
    if (lastPlay && lastPlay.type === CardType.ROCKET) return [];
    let candidates = [];
    const byValue = {};
    hand.forEach(c => { if (!byValue[c.value]) byValue[c.value] = []; byValue[c.value].push(c); });
    hand.forEach(c => candidates.push([c]));
    Object.values(byValue).forEach(arr => { if (arr.length >= 2) candidates.push([arr[0], arr[1]]); });
    Object.values(byValue).forEach(arr => { if (arr.length >= 3) candidates.push([arr[0], arr[1], arr[2]]); });
    Object.values(byValue).forEach(arr => { if (arr.length === 4) candidates.push(arr); });
    if (byValue[13] && byValue[14]) candidates.push([byValue[13][0], byValue[14][0]]);
    if (_canContend(lastPlay, CardType.TRIPLE_WITH_SINGLE)) {
        for (let triple of Object.values(byValue).filter(arr=>arr.length>=3)) {
            for (let single of hand) if (single.value !== triple[0].value) candidates.push([...triple.slice(0,3), single]);
        }
    }
    if (_canContend(lastPlay, CardType.TRIPLE_WITH_PAIR)) {
        for (let triple of Object.values(byValue).filter(arr=>arr.length>=3)) {
            for (let pair of Object.values(byValue).filter(arr=>arr.length>=2 && arr[0].value !== triple[0].value)) {
                candidates.push([...triple.slice(0,3), ...pair.slice(0,2)]);
            }
        }
    }
    if (_canContend(lastPlay, CardType.FOUR_WITH_TWO_SINGLE)) {
        for (let quad of Object.values(byValue).filter(arr=>arr.length===4)) {
            let singles = hand.filter(c => c.value !== quad[0].value);
            for (let i=0;i<singles.length;i++) for (let j=i+1;j<singles.length;j++) candidates.push([...quad, singles[i], singles[j]]);
        }
    }
    if (_canContend(lastPlay, CardType.FOUR_WITH_TWO_PAIR)) {
        for (let quad of Object.values(byValue).filter(arr=>arr.length===4)) {
            let pairs = Object.values(byValue).filter(arr=>arr.length>=2 && arr[0].value !== quad[0].value);
            for (let i=0;i<pairs.length;i++) for (let j=i+1;j<pairs.length;j++) candidates.push([...quad, ...pairs[i].slice(0,2), ...pairs[j].slice(0,2)]);
        }
    }
    if (_canContend(lastPlay, CardType.STRAIGHT)) {
        let uniqueValues = [...new Set(hand.map(c=>c.value).filter(v=>v<12))].sort((a,b)=>a-b);
        for (let len=5; len<=12; len++) {
            for (let i=0; i+len <= uniqueValues.length; i++) {
                let seq = uniqueValues.slice(i, i+len);
                if (isStraight(seq)) {
                    let cards = [], ok=true;
                    for (let v of seq) { if (!byValue[v]) { ok=false; break; } cards.push(byValue[v][0]); }
                    if (ok) candidates.push(cards);
                }
            }
        }
    }
    if (_canContend(lastPlay, CardType.STRAIGHT_PAIR)) {
        let pairValues = Object.keys(byValue).filter(v => byValue[v].length >= 2 && v<12).map(Number).sort((a,b)=>a-b);
        for (let len=3; len<=6; len++) {
            for (let i=0; i+len <= pairValues.length; i++) {
                let seq = pairValues.slice(i, i+len);
                if (isStraight(seq)) {
                    let cards = [], ok=true;
                    for (let v of seq) { if (!byValue[v] || byValue[v].length<2) { ok=false; break; } cards.push(byValue[v][0], byValue[v][1]); }
                    if (ok) candidates.push(cards);
                }
            }
        }
    }
    if (_canContend(lastPlay, CardType.PLANE)) {
        let tripleValues = Object.keys(byValue).filter(v => byValue[v].length >= 3 && v<12).map(Number).sort((a,b)=>a-b);
        for (let len=2; len<=tripleValues.length; len++) {
            for (let i=0; i+len<=tripleValues.length; i++) {
                let seq = tripleValues.slice(i, i+len);
                if (isStraight(seq)) {
                    let cards = [], ok=true;
                    for (let v of seq) { if (!byValue[v] || byValue[v].length<3) { ok=false; break; } cards.push(byValue[v][0], byValue[v][1], byValue[v][2]); }
                    if (ok) candidates.push(cards);
                }
            }
        }
    }
    if (_canContend(lastPlay, CardType.PLANE_WITH_SINGLE)) {
        let tripleValues = Object.keys(byValue).filter(v => byValue[v].length >= 3 && v<12).map(Number).sort((a,b)=>a-b);
        for (let len=2; len<=tripleValues.length; len++) {
            for (let i=0; i+len<=tripleValues.length; i++) {
                let seq = tripleValues.slice(i, i+len);
                if (!isStraight(seq)) continue;
                let tripleCards = [], ok=true;
                for (let v of seq) { if (!byValue[v] || byValue[v].length<3) { ok=false; break; } tripleCards.push(byValue[v][0], byValue[v][1], byValue[v][2]); }
                if (!ok) continue;
                let usedIds = new Set(tripleCards.map(c=>c.id));
                let kickers = hand.filter(c => !usedIds.has(c.id));
                for (let combo of getCombinations(kickers, len)) {
                    candidates.push([...tripleCards, ...combo]);
                }
            }
        }
    }
    if (_canContend(lastPlay, CardType.PLANE_WITH_PAIR)) {
        let tripleValues = Object.keys(byValue).filter(v => byValue[v].length >= 3 && v<12).map(Number).sort((a,b)=>a-b);
        let pairValues = Object.keys(byValue).filter(v => byValue[v].length >= 2 && v<12).map(Number).sort((a,b)=>a-b);
        for (let len=2; len<=Math.min(tripleValues.length, 6); len++) {
            for (let i=0; i+len<=tripleValues.length; i++) {
                let seq = tripleValues.slice(i, i+len);
                if (!isStraight(seq)) continue;
                let tripleCards = [], ok=true;
                for (let v of seq) { if (!byValue[v] || byValue[v].length<3) { ok=false; break; } tripleCards.push(byValue[v][0], byValue[v][1], byValue[v][2]); }
                if (!ok) continue;
                let usedVals = new Set(seq);
                let availPairs = pairValues.filter(v => !usedVals.has(v));
                for (let combo of getCombinations(availPairs, len)) {
                    let cards = [...tripleCards];
                    let ok2 = true;
                    for (let v of combo) { if (!byValue[v] || byValue[v].length<2) { ok2=false; break; } cards.push(byValue[v][0], byValue[v][1]); }
                    if (ok2) candidates.push(cards);
                }
            }
        }
    }
    let unique = new Map();
    candidates.forEach(arr => { let key = arr.map(c=>c.id).sort().join(','); if (!unique.has(key)) unique.set(key, arr); });
    let result = Array.from(unique.values()).filter(play => getCardType(play) !== null);
    if (lastPlay) result = result.filter(play => canBeat(getCardType(play), lastPlay));
    result.sort((a,b)=>getPlayPower(a)-getPlayPower(b));
    return result;
}

// ======================== 评分系统 ========================
function scorePlay(features, role, memory, state, playerHand) {
    let score = 0;
    let W = cfg('weights');
    for (let key in W) if (features[key] !== undefined) score += features[key] * W[key];
    let isPartnerPlay = role === 'farmer' && state.lastPlayerId !== -1 && state.lastPlayerId !== state.currentPlayer && state.lastPlayerId !== state.landlord;
    let ph = cfg('playHeuristics');
    let ps = cfg('passScores');
    if (isPartnerPlay) {
        if (features.partnerHandCount <= 3) score += ph.partnerPlay.handLe3;
        if (features.lastPlayPower >= 40) score += ph.partnerPlay.lastPowerGe40;
        if (features.lastPlayPower <= 20) score += ph.partnerPlay.lastPowerLe20;
    }
    let lordBeatPartner = role === 'farmer' && state.lastPlayerId === state.landlord
        && state.lastPlay && state.passCount === 0;
    if (lordBeatPartner) {
        if (features.needBeat) score += ph.lordBeatPartner.needBeat;
        if (features.partnerHandCount <= 4) score += ph.lordBeatPartner.handLe4;
    }
    if (features.isFarmer && features.partnerHandCount <= 2 && features.playLength <= 2) score += ph.farmerAssist.partnerHandLe2PlayLe2;
    if (features.isFarmer && features.needBeat && features.lastPlayType === 'single' && features.lastPlayPower <= 10 && features.playPower > features.lastPlayPower && features.playPower - features.lastPlayPower <= 3) score += ph.farmerBeatSmallSingle.diffLe3;
    if (features.needBeat && features.lastPlayPower >= 13 && features.remainTotal > 3 && features.playPower > features.lastPlayPower) score += ph.needBeatLastHighRemain.lastPowerGe13;
    if (features.isLandlord && !features.needBeat && features.playLength === 1 && features.playPower <= 6) score += ph.landlordLeadSingle.le6;
    if (features.needBeat && features.lastPlayType === 'single' && features.lastPlayPower <= 8 && features.playPower > features.lastPlayPower) {
        let efficiency = features.playPower - features.lastPlayPower;
        if (efficiency <= 4) score += ph.suppressSingle.diffLe4;
        else if (efficiency <= 7) score += ph.suppressSingle.diffLe7;
        else if (efficiency <= 10) score += ph.suppressSingle.diffLe10;
        else score += ph.suppressSingle.diffGt10;
    }
    if (features.needBeat && features.lastPlayType === 'pair' && features.lastPlayPower <= 8 && features.playPower - 20 > features.lastPlayPower) {
        let efficiency = features.playPower - 20 - features.lastPlayPower;
        if (efficiency <= 4) score += ph.suppressPair.diffLe4;
        else if (efficiency <= 7) score += ph.suppressPair.diffLe7;
        else if (efficiency <= 10) score += ph.suppressPair.diffLe10;
        else score += ph.suppressPair.diffGt10;
    }
    let lastPlayerCards = state.lastPlayerId >= 0 && state.players[state.lastPlayerId] ? state.players[state.lastPlayerId].length : 20;
    if (features.needBeat && role === 'farmer' && lastPlayerCards <= 6 && features.lastPlayPower <= 10 && features.playPower > features.lastPlayPower) {
        score += ph.farmerOppLowCards.handLe6LastPowerLe10;
    }
    if (features.needBeat && role === 'farmer' && state.lastPlayerId === state.landlord && features.playPower > features.lastPlayPower) {
        if (features.lastPlayPower <= 8) score += ph.farmerVsLord.lastPowerLe8;
        else if (features.lastPlayPower <= 11) score += ph.farmerVsLord.lastPowerLe11;
    }
    if (features.needBeat && features.nextPlayerHandCount <= 2 && !features.isBomb && !features.isRocket) {
        if (features.playPower <= 12) score -= 200;
    }
    if (!features.needBeat && features.isLandlord && features.playLength <= 2 && features.playType === CardType.SINGLE) {
        if (features.playPower <= 6) score += ph.landlordLeadLowPower.powerLe6;
        if (features.playPower >= 12) score += ph.landlordLeadLowPower.powerGe12;
    }
    if (!features.needBeat && features.isFarmer && features.playLength === 1) {
        if (features.playPower >= 12) score += ph.farmerLeadHigh.powerGe12;
        if (features.playPower >= 11 && features.playPower <= 14 && features.partnerHandCount <= 4) score += ph.farmerLeadHigh.power1114PartnerLe4;
    }
    let oppAboutToWin;
    if (role === 'farmer') {
        oppAboutToWin = (state.players[state.landlord]?.length || 20) <= 2;
    } else {
        oppAboutToWin = [0, 1, 2].some(i => i !== state.landlord && (state.players[i]?.length || 20) <= 2);
    }
    let farmerWinPossible = role === 'farmer' && oppAboutToWin && features.needBeat;
    let lordWinPossible = role === 'landlord' && oppAboutToWin;
    if ((features.isBomb || features.isRocket) && oppAboutToWin) score += ph.bombUrgent.oppAboutToWin;
    if ((features.isBomb || features.isRocket) && role === 'landlord' && features.remainTotal <= 4) score += ph.bombUrgent.landlordRemainLe4;
    if ((features.isBomb || features.isRocket) && features.remainTotal <= 2) score += ph.bombUrgent.remainLe2;
    if (features.isBomb && memory.getOutsideBombCount(playerHand) <= 1 && !memory.getOutsideRocketPossible(playerHand)) score += ph.bombStrategic.fewOutside;
    if (features.isRocket) score += ph.bombStrategic.rocketBonus;
    if (!features.needBeat && (features.isBomb || features.isRocket)) score += features.isRocket ? ph.bombLead.rocket : ph.bombLead.bomb;
    if ((features.isBomb || features.isRocket) && features.needBeat && features.remainTotal > 5) {
        if (features.lastPlayPower < 40) score += ph.bombWasted.lowLastPower;
        if (features.lastPlayPower >= 40 && features.remainTotal > 8) score += ph.bombWasted.highLastPower;
    }
    if ((features.isBomb || features.isRocket) && features.needBeat && features.remainTotal > 6 && !oppAboutToWin) score += ph.bombWasted.notCritical;
    if (features.needBeat && features.remainTotal <= 3 && features.remainTotal + features.playLength <= (playerHand ? playerHand.length : 20)) score += ph.nearWin.remainLe3;
    if (features.playType === CardType.TRIPLE_WITH_SINGLE || features.playType === CardType.TRIPLE_WITH_PAIR || features.playType === CardType.PLANE_WITH_SINGLE || features.playType === CardType.PLANE_WITH_PAIR) {
        if (features.kickerValue >= 11) score += ph.kickerPenalty.ge11;
        if (features.kickerValue >= 13) score += ph.kickerPenalty.ge13;
        if (features.kickerValue >= 11 && playerHand && features.kickerValue) {
            let mainVal = features.mainValue || 0;
            let hasSmaller = playerHand.some(c => c.value !== mainVal && c.value < features.kickerValue);
            if (hasSmaller) score += ph.kickerPenalty.hasSmallerAlternative || -100;
        }
    }
    if ((features.isBomb || features.isRocket) && features.needBeat && features.remainTotal > 3) {
        if (features.lastPlayType === 'single' && features.lastPlayPower <= 12) score += ph.overkill.singleLe12 || -200;
        if (features.lastPlayType === 'pair' && features.lastPlayPower <= 10) score += ph.overkill.pairLe10 || -150;
    }
    if (playerHand) {
        let ruleCtx = {
            needBeat: !!features.needBeat,
            lastPlayType: features.lastPlayType,
            lastPlayPower: features.lastPlayPower,
            playType: features.playType,
            playPower: features.playPower,
            kickerValue: features.kickerValue,
            role: role,
            handSize: playerHand.length,
            isBomb: !!features.isBomb,
            isRocket: !!features.isRocket,
            isBombPlay: !!features.isBomb,
            isRocketPlay: !!features.isRocket,
            hasBothJokers: playerHand.some(c=>c.value===14) && playerHand.some(c=>c.value===13),
            hasSmallJoker: playerHand.some(c=>c.value===13),
            hasBigJoker: playerHand.some(c=>c.value===14)
        };
        let rules = matchRules(ruleCtx);
        for (let rule of rules) score += rule.penalty;
    }
    return score;
}

function computePassScore(role, state) {
    let score = 0;
    let ps = cfg('passScores');
    let lordCards = state.players[state.landlord] ? state.players[state.landlord].length : 17;
    if (role === 'farmer') {
        let isPartner = state.lastPlayerId !== -1 && state.lastPlayerId !== state.landlord;
        if (isPartner) {
            score += ps.farmerPartnerBase;
            let partnerCards = state.players[state.lastPlayerId] ? state.players[state.lastPlayerId].length : 17;
            if (partnerCards <= 3) score += ps.farmerPartnerHandLe3;
        } else if (state.lastPlayerId === state.landlord) {
            if (lordCards <= 2) score += ps.lordHandLe2;
            else if (lordCards <= 4) score += ps.lordHandLe4;
            else score += ps.lordHandGt4;
        }
    } else {
        if (state.lastPlayerId !== -1 && state.lastPlayerId !== state.landlord) {
            score += ps.landlordFarmerPlayed;
            let farmerCards = state.players[state.lastPlayerId] ? state.players[state.lastPlayerId].length : 17;
            if (farmerCards <= 3) score += ps.landlordFarmerHandLe3;
        }
    }
    let nextP = (state.currentPlayer + 1) % 3;
    let nextCards = state.players[nextP] ? state.players[nextP].length : 17;
    let isNextOpp = role === 'farmer' ? nextP === state.landlord : nextP !== state.landlord;
    if (nextCards <= 2 && isNextOpp && state.lastPlayerId !== -1 && state.lastPlayerId !== state.currentPlayer) score -= 300;
    if (state.passCount >= 1) score += ps.passCountGe1;
    return score;
}

// ======================== 对手响应模拟 ========================
function simulateOpponentResponseV2(play, hand, state, role, memory, depth = 1) {
    let newHand = hand.filter(c => !play.includes(c));
    let newState = JSON.parse(JSON.stringify(state));
    newState.players[state.currentPlayer] = newHand;
    let nextPlayer = (state.currentPlayer + 1) % 3;
    if (newState.players[nextPlayer].length === 0) return -100;
    let lastType = getCardType(play);
    function sampleOpponentPlays(oppHand, targetPlay) {
        let plays = getAllValidPlays(oppHand, targetPlay);
        if (!plays || plays.length === 0) return null;
        let n = depth >= 2 ? 15 : 8;
        if (plays.length <= n) return plays;
        let step = Math.floor(plays.length / n);
        let result = [];
        for (let i = 0; i < n; i++) result.push(plays[Math.min(i * step, plays.length - 1)]);
        return result;
    }
    function evalState(s, pid, myRoleId, depth) {
        if (s.players[pid].length === 0) {
            let winnerRole = pid === s.landlord ? 'landlord' : 'farmer';
            return winnerRole === myRoleId ? 100 : -100;
        }
        if (depth <= 0) {
            let str = evaluateHandStrength(s.players[pid], memory, pid === s.landlord);
            let sameRole = (pid === s.landlord) === (myRoleId === 'landlord');
            return sameRole ? str : -str;
        }
        let samples = sampleOpponentPlays(s.players[pid], s.lastPlay);
        if (!samples) {
            s.passCount++;
            if (s.passCount >= 2) { s.lastPlay = null; s.lastPlayerId = -1; s.passCount = 0; }
            return evalState(s, (pid + 1) % 3, myRoleId, depth - 1);
        }
        let total = 0, count = 0;
        for (let sp of samples) {
            let s2 = JSON.parse(JSON.stringify(s));
            let spIds = new Set(sp.map(c => c.id));
            s2.players[pid] = s2.players[pid].filter(c => !spIds.has(c.id));
            s2.lastPlay = getCardType(sp);
            s2.lastPlayerId = pid;
            s2.passCount = 0;
            if (s2.players[pid].length === 0) {
                let wRole = pid === s2.landlord ? 'landlord' : 'farmer';
                total += wRole === myRoleId ? 100 : -100;
            } else {
                total += evalState(s2, (pid + 1) % 3, myRoleId, depth - 1);
            }
            count++;
        }
        return count > 0 ? total / count : 0;
    }
    let score = 0;
    let opponentPlays = getAllValidPlays(newState.players[nextPlayer], lastType);
    if (!opponentPlays || opponentPlays.length === 0) {
        newState.passCount = (newState.passCount || 0) + 1;
        if (newState.passCount >= 2) { newState.lastPlay = null; newState.lastPlayerId = -1; newState.passCount = 0; }
        score = evalState(newState, (nextPlayer + 1) % 3, role, depth);
    } else {
        let n = depth >= 2 ? 15 : 8;
        let samples = opponentPlays.length <= n ? opponentPlays :
            (() => { let step = Math.floor(opponentPlays.length / n); let r = []; for (let i = 0; i < n; i++) r.push(opponentPlays[Math.min(i * step, opponentPlays.length - 1)]); return r; })();
        let weighted = 0, count = 0;
        for (let sp of samples) {
            let s2 = JSON.parse(JSON.stringify(newState));
            let spIds = new Set(sp.map(c => c.id));
            s2.players[nextPlayer] = s2.players[nextPlayer].filter(c => !spIds.has(c.id));
            s2.lastPlay = getCardType(sp);
            s2.lastPlayerId = nextPlayer;
            s2.passCount = 0;
            if (s2.players[nextPlayer].length === 0) {
                let wRole = nextPlayer === s2.landlord ? 'landlord' : 'farmer';
                weighted += wRole === role ? 100 : -100;
            } else {
                let third = (nextPlayer + 1) % 3;
                weighted += evalState(s2, third, role, depth);
            }
            count++;
        }
        score = count > 0 ? weighted / count : 0;
    }
    return score;
}

// ======================== 盲对手响应模拟（多世界聚合） ========================
// 对手手牌不可见 → 在采样出的可能世界里分别推演对手应对，再取期望。
function simulateOpponentResponseBlind(play, hand, state, role, memory, belief, depth = 1, worlds) {
    const list = (worlds && worlds.length) ? worlds : belief.sampleWorlds(1);
    if (!list.length) return 0;
    let total = 0, count = 0;
    for (const worldPlayers of list) {
        const ws = Object.assign({}, state, { players: worldPlayers.map(p => p.map(c => ({ ...c }))) });
        try {
            total += simulateOpponentResponseV2(play, hand, ws, role, memory, depth);
            count++;
        } catch (e) { /* 单个世界失败不影响整体 */ }
    }
    return count > 0 ? total / count : 0;
}

// ======================== DP 手牌分解 ========================
function decomposeHandDP(hand) {
    if (!hand || hand.length === 0) return { plays: [], score: 0 };
    if (hand.length > 14) return { plays: [], score: -999 };
    const n = hand.length;
    const idxToCard = hand;
    let cardIndex = {};
    hand.forEach((c, i) => { if (!cardIndex[c.id]) cardIndex[c.id] = []; cardIndex[c.id].push(i); });
    function cardsFromMask(mask) {
        let result = [];
        for (let i = 0; i < n; i++) if (mask & (1 << i)) result.push(idxToCard[i]);
        return result;
    }
    let allPlays = getAllValidPlays(hand, null);
    let playEntries = [];
    for (let play of allPlays) {
        let mask = 0;
        let used = {};
        for (let c of play) {
            let idx = -1;
            let arr = cardIndex[c.id] || [];
            for (let j of arr) {
                if (!(mask & (1 << j)) && !used[j]) { idx = j; break; }
            }
            if (idx >= 0) { mask |= (1 << idx); used[idx] = true; }
        }
        let type = getCardType(play);
        let ds = cfg('dpScores');
        let pscore = 0;
        if (type.type === CardType.ROCKET) pscore = ds.rocket;
        else if (type.type === CardType.BOMB) pscore = ds.bomb;
        else if (type.type === CardType.STRAIGHT) pscore = ds.straight + type.length * ds.straightLenFactor;
        else if (type.type === CardType.STRAIGHT_PAIR) pscore = ds.straightPair + type.length * ds.straightPairLenFactor;
        else if (type.type === CardType.PLANE) pscore = ds.plane + type.length * ds.planeLenFactor;
        else if (type.type === CardType.PLANE_WITH_SINGLE || type.type === CardType.PLANE_WITH_PAIR) {
            let target = type.type === CardType.PLANE_WITH_SINGLE ? 1 : 2;
            let cnt = countValues(play.map(c=>c.value));
            let kickerVals = Object.keys(cnt).filter(k => cnt[k] === target).map(Number);
            let maxKicker = kickerVals.length > 0 ? Math.max(...kickerVals) : 0;
            pscore = ds.planeWith - Math.max(0, maxKicker - 7) * 3 * type.length;
        }
        else if (type.type === CardType.TRIPLE_WITH_SINGLE || type.type === CardType.TRIPLE_WITH_PAIR) {
            let target = type.type === CardType.TRIPLE_WITH_SINGLE ? 1 : 2;
            let cnt = countValues(play.map(c=>c.value));
            let kickerVal = parseInt(Object.keys(cnt).find(k => cnt[k] === target && parseInt(k) !== type.value)) || 0;
            pscore = ds.tripleWith - Math.max(0, kickerVal - 7) * 3;
        }
        else if (type.type === CardType.PAIR) pscore = ds.pair;
        else if (type.type === CardType.TRIPLE) pscore = ds.triple;
        else pscore = ds.single;
        if (play.length === hand.length) pscore += ds.completeBonus;
        playEntries.push({ mask, score: pscore, play });
    }
    let totalMasks = 1 << n;
    let dp = new Array(totalMasks).fill(null);
    let prev = new Array(totalMasks).fill(null);
    dp[0] = 0;
    for (let mask = 0; mask < totalMasks; mask++) {
        if (dp[mask] === null) continue;
        for (let pe of playEntries) {
            if (mask & pe.mask) continue;
            let newMask = mask | pe.mask;
            let newScore = dp[mask] + pe.score;
            if (dp[newMask] === null || newScore > dp[newMask]) {
                dp[newMask] = newScore;
                prev[newMask] = { from: mask, entry: pe };
            }
        }
    }
    let bestMask = 0, bestScore = (dp[totalMasks-1] !== null) ? dp[totalMasks-1] : -999;
    if (dp[totalMasks-1] !== null) bestMask = totalMasks - 1;
    else {
        for (let mask = 0; mask < totalMasks; mask++) {
            if (dp[mask] !== null && dp[mask] > bestScore) { bestScore = dp[mask]; bestMask = mask; }
        }
    }
    let plays = [];
    let m = bestMask;
    while (m > 0 && prev[m] !== null) {
        plays.push(prev[m].entry.play);
        m = prev[m].from;
    }
    let uncovered = cardsFromMask(bestMask ^ (totalMasks - 1));
    for (let c of uncovered) plays.push([c]);
    plays.reverse();
    let remaining = hand.filter(c => !plays.flat().includes(c));
    for (let c of remaining) plays.push([c]);
    return { plays, score: bestScore };
}

// 轻量状态拷贝：牌对象只读，因此只需复制手牌数组与顶层字段，
// 比 JSON 深拷贝快一个数量级（MCTS 每次 expand / 每次 playout 都要拷贝状态）。
function _cloneStateShallow(state) {
    const s = {};
    for (const k in state) s[k] = state[k];
    s.players = (state.players || []).map(p => (Array.isArray(p) ? p.slice() : p));
    return s;
}

// ======================== 残局求解（快速 make/undo + 置换表 + 时间预算） ========================
// 关键改进：① 支持"过牌"作为根候选（原实现漏掉，会错失配合/留牌最优解）
//           ② 终局收益与深度解耦，置换表可跨路径复用（原实现按深度存，复用不安全）
//           ③ 手牌以"点数多重集"做键，同点不同花视为等价，TT 命中率显著提升
//           ④ 不再 JSON 深拷贝整个 state，改为对当前手牌 make/undo
function _staticEvalHands(hands, mySide) {
    let score = 0;
    for (let i = 0; i < 3; i++) {
        const sign = mySide.includes(i) ? 1 : -1;
        const p = hands[i];
        for (let j = 0; j < p.length; j++) score += sign * (1 + (p[j].value >= 12 ? 2 : 0));
    }
    return Math.max(-60, Math.min(60, score));
}

function _endgameStaticEval(state, myId) {
    let mySide = (myId === state.landlord) ? [myId] : [0, 1, 2].filter(i => i !== state.landlord);
    return _staticEvalHands(state.players, mySide);
}

// 由当前局面构造记牌器（已打出的牌 = 54 张中不在任何手牌里的牌），用于残局根节点排序
function _memoryFromState(state) {
    const mem = new MasterMemory();
    const inHand = new Set();
    for (const p of state.players) for (const c of p) inHand.add(c.id);
    const suits = ['♠', '♥', '♣', '♦'];
    const ranks = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
    const all = [];
    for (const suit of suits) for (let i = 0; i < ranks.length; i++) all.push({ suit, rank: ranks[i], value: i, id: suit + ranks[i] });
    all.push({ suit: 'JOKER', rank: '小王', value: 13, id: 'joker1' });
    all.push({ suit: 'JOKER', rank: '大王', value: 14, id: 'joker2' });
    for (const c of all) if (!inHand.has(c.id)) mem.record([c]);
    return mem;
}

function _endgameKeyFast(hands, cp, lastPlay, passCount) {
    let k = cp + '|' + passCount + '|' + (lastPlay ? lastPlay.type + ':' + lastPlay.value + ':' + (lastPlay.length || 0) : '-');
    for (let i = 0; i < 3; i++) {
        k += '|' + hands[i].map(c => c.value).sort((a, b) => a - b).join('.');
    }
    return k;
}

function _applyPlay(hands, cp, cards) {
    const hand = hands[cp];
    for (let i = 0; i < cards.length; i++) {
        const idx = hand.indexOf(cards[i]);
        if (idx >= 0) hand.splice(idx, 1);
    }
}
function _undoPlay(hands, cp, cards) {
    const hand = hands[cp];
    for (let i = 0; i < cards.length; i++) hand.push(cards[i]);
    hand.sort((a, b) => a.value - b.value);
}
function _orderPlayScore(play, handLen) {
    if (play.length === handLen) return 1e6;
    return play.length * 100 + (getPlayPower(play) % 1000);
}

function endgameMinimax(hands, cp, lastPlay, lastPlayerId, passCount, mySide, ctx, alpha, beta) {
    ctx.nodes++;
    if (ctx.nodes >= ctx.limit || (ctx.deadline && (ctx.nodes & 255) === 0 && Date.now() >= ctx.deadline)) {
        ctx.truncated = true;
        return _staticEvalHands(hands, mySide);
    }
    for (let i = 0; i < 3; i++) {
        if (hands[i].length === 0) return mySide.includes(i) ? 100 : -100;
    }
    if (passCount >= 2) { lastPlay = null; lastPlayerId = -1; passCount = 0; }

    const key = _endgameKeyFast(hands, cp, lastPlay, passCount);
    const ttEntry = ctx.tt.get(key);
    if (ttEntry) {
        if (ttEntry.flag === 'exact') return ttEntry.value;
        if (ttEntry.flag === 'lower' && ttEntry.value >= beta) return ttEntry.value;
        if (ttEntry.flag === 'upper' && ttEntry.value <= alpha) return ttEntry.value;
    }
    const origAlpha = alpha;

    const hand = hands[cp];
    const needBeat = lastPlay && lastPlayerId !== cp;
    const plays = needBeat ? getAllValidPlays(hand, lastPlay) : getAllValidPlays(hand, null);

    const isMax = mySide.includes(cp);
    let best = isMax ? -Infinity : Infinity;
    let childTruncated = false;

    if (needBeat) {
        // 过牌分支
        const val = endgameMinimax(hands, (cp + 1) % 3, lastPlay, lastPlayerId, passCount + 1, mySide, ctx, alpha, beta);
        best = val;
        if (isMax) { if (val > alpha) alpha = val; } else { if (val < beta) beta = val; }
        if (alpha >= beta) childTruncated = childTruncated || ctx.truncated;
    }

    if (!(needBeat && best === (isMax ? 100 : -100))) {
        const ordered = plays.slice().sort((a, b) => _orderPlayScore(b, hand.length) - _orderPlayScore(a, hand.length));
        for (const p of ordered) {
            _applyPlay(hands, cp, p);
            let val;
            if (hands[cp].length === 0) {
                val = mySide.includes(cp) ? 100 : -100;
            } else {
                val = endgameMinimax(hands, (cp + 1) % 3, getCardType(p), cp, 0, mySide, ctx, alpha, beta);
            }
            _undoPlay(hands, cp, p);
            if (isMax) {
                if (val > best) best = val;
                if (best > alpha) alpha = best;
            } else {
                if (val < best) best = val;
                if (best < beta) beta = best;
            }
            if (alpha >= beta) break;
            if (ctx.truncated) { childTruncated = true; break; }
        }
    }

    if (!ctx.truncated && !childTruncated) {
        let flag = 'exact';
        if (best <= origAlpha) flag = 'upper';
        else if (best >= beta) flag = 'lower';
        ctx.tt.set(key, { value: best, flag });
    }
    return best;
}

// 兼容旧签名（ai_learner 的精确解会调用）
function minimaxEndgame(state, currentPlayer, myId, depth, maxDepth, alpha = -999, beta = 999, ctx) {
    if (!ctx) ctx = { nodes: 0, limit: 60000, tt: new Map(), truncated: false, deadline: Date.now() + 400 };
    const mySide = (myId === state.landlord) ? [myId] : [0, 1, 2].filter(i => i !== state.landlord);
    const hands = state.players.map(p => [...p]);
    return endgameMinimax(hands, currentPlayer, state.lastPlay, state.lastPlayerId, state.passCount || 0, mySide, ctx, alpha, beta);
}

function solveEndgame(state, playerId, opts) {
    opts = opts || {};
    const _st = (typeof globalThis !== 'undefined') ? (globalThis.__ENDGAME_STATS__ = globalThis.__ENDGAME_STATS__ || { calls: 0, applied: 0, truncated: 0, immediateWin: 0, avgNodes: 0 }) : null;
    if (_st) _st.calls++;
    const hand = state.players[playerId];
    if (!hand || hand.length === 0) return null;
    const totalCards = state.players.reduce((s, p) => s + p.length, 0);
    const _mt = cfg('endgame.maxTotalCards');
    const _mh = cfg('endgame.maxHandCards');
    const maxTotal = opts.maxTotalCards !== undefined ? opts.maxTotalCards : (_mt === undefined || _mt === null ? 20 : _mt);
    const maxHand = opts.maxHandCards !== undefined ? opts.maxHandCards : (_mh === undefined || _mh === null ? 17 : _mh);
    if (hand.length > maxHand || totalCards > maxTotal) return null;

    const needBeat = state.lastPlay && state.lastPlayerId !== playerId;
    const plays = needBeat ? getAllValidPlays(hand, state.lastPlay) : getAllValidPlays(hand, null);
    const hands = state.players.map(p => [...p]);
    const mySide = (playerId === state.landlord) ? [playerId] : [0, 1, 2].filter(i => i !== state.landlord);
    const ctx = {
        nodes: 0,
        limit: opts.nodeLimit || (cfg('endgame.nodeLimit') || 120000),
        tt: new Map(),
        truncated: false,
        deadline: Date.now() + (opts.timeBudgetMs || (cfg('endgame.timeBudgetMs') || 500)),
    };

    const options = plays.slice();
    if (needBeat) options.push(null); // 过牌
    // 以学习到的启发式评分排序：保证即使预算截断，回退的也是 AI 默认最想出的牌，
    // 使残局求解成为"启发式的严格改进"而非另起炉灶。
    const mem = _memoryFromState(state);
    const role = (playerId === state.landlord) ? 'landlord' : 'farmer';
    const scoreOf = (p) => {
        if (p === null) return computePassScore(role, state);
        try {
            const f = extractPlayFeatures(p, hand, state.lastPlay, role, mem, state);
            return scorePlay(f, role, mem, state, hand);
        } catch (e) { return 0; }
    };
    options.sort((a, b) => scoreOf(b) - scoreOf(a));

    let bestPlay = null, bestScore = -Infinity, found = false;
    let searchTruncated = false;
    for (const p of options) {
        let val;
        if (p === null) {
            val = endgameMinimax(hands, (playerId + 1) % 3, state.lastPlay, state.lastPlayerId, (state.passCount || 0) + 1, mySide, ctx, -Infinity, Infinity);
        } else {
            _applyPlay(hands, playerId, p);
            if (hands[playerId].length === 0) {
                _undoPlay(hands, playerId, p);
                if (_st) { _st.applied++; _st.immediateWin++; _st.avgNodes += ctx.nodes; }
                return p; // 立即获胜
            }
            val = endgameMinimax(hands, (playerId + 1) % 3, getCardType(p), playerId, 0, mySide, ctx, -Infinity, Infinity);
            _undoPlay(hands, playerId, p);
        }
        // 该选项搜索被预算截断 → 其估值不可靠，丢弃并停止（保留此前可靠选项；若一个都没有则回退启发式首选）
        if (ctx.truncated) { searchTruncated = true; break; }
        if (val > bestScore) { bestScore = val; bestPlay = p; found = true; }
        if (bestScore >= 100) break;
    }
    if (_st) { _st.applied++; if (ctx.truncated || searchTruncated) _st.truncated++; _st.avgNodes += ctx.nodes; }
    if (found) return bestPlay;
    // 完全无法可靠搜索时，回退到按启发式排序的首个可出牌（避免退回最弱牌）
    for (const o of options) if (o && o.length > 0) return o;
    return plays[0] || null;
}

// ======================== 盲残局求解（多世界聚合，公平且稳健） ========================
// 思路：对手手牌不可见 → 从公开信息采样 K 个"可能世界"，每个世界内部做精确 minimax，
//      跨世界用「均值 − 鲁棒系数×标准差」聚合，压制"赌对了对手手牌"的过拟合走法。
function solveEndgameBlind(state, playerId, belief, opts) {
    opts = opts || {};
    const hand = state.players[playerId];
    if (!hand || hand.length === 0) return null;
    const totalCards = state.players.reduce((s, p) => s + p.length, 0);
    const maxTotal = opts.maxTotalCards !== undefined ? opts.maxTotalCards : (cfg('endgame.maxTotalCards') || 20);
    const maxHand = opts.maxHandCards !== undefined ? opts.maxHandCards : (cfg('endgame.maxHandCards') || 17);
    if (hand.length > maxHand || totalCards > maxTotal) return null;

    const needBeat = state.lastPlay && state.lastPlayerId !== playerId;
    const plays = needBeat ? getAllValidPlays(hand, state.lastPlay) : getAllValidPlays(hand, null);
    if (!plays.length) return null;
    const options = plays.slice();
    if (needBeat) options.push(null); // 过牌

    const role = (playerId === state.landlord) ? 'landlord' : 'farmer';
    const mem = opts.memory || null;
    const scoreOf = (p) => {
        if (p === null) return computePassScore(role, state);
        try {
            const f = extractPlayFeatures(p, hand, state.lastPlay, role, mem, state);
            return scorePlay(f, role, mem, state, hand);
        } catch (e) { return 0; }
    };
    options.sort((a, b) => scoreOf(b) - scoreOf(a));

    const worlds = Math.max(1, opts.worlds || 4);
    const budgetMs = opts.timeBudgetMs !== undefined ? opts.timeBudgetMs : (cfg('blind.endgameTimeBudgetMs') || 600);
    const deadline = Date.now() + budgetMs;
    const nodeLimit = opts.nodeLimit || (cfg('endgame.nodeLimit') || 200000);
    const perWorldLimit = Math.max(20000, Math.floor(nodeLimit / worlds));
    const lambda = opts.robustness !== undefined ? opts.robustness : (cfg('blind.robustness') !== undefined ? cfg('blind.robustness') : 0.25);
    const mySide = (playerId === state.landlord) ? [playerId] : [0, 1, 2].filter(i => i !== state.landlord);
    const keyOf = (p) => (p === null) ? 'pass' : p.map(c => c.id).sort().join(',');
    const agg = new Map();

    for (let w = 0; w < worlds; w++) {
        if (Date.now() > deadline) break;
        const worldPlayers = belief.sampleWorld();
        const hands = worldPlayers.map(p => [...p]);
        const ctx = {
            nodes: 0, limit: perWorldLimit, tt: new Map(), truncated: false,
            deadline: Math.min(deadline, Date.now() + Math.max(60, Math.floor(budgetMs / worlds)))
        };
        // 候选按启发式顺序评估：预算被截断时，优先保证"最想出的那几手"在每个世界里都被评估到
        for (const p of options) {
            if (Date.now() > deadline) break;
            let val;
            if (p === null) {
                val = endgameMinimax(hands, (playerId + 1) % 3, state.lastPlay, state.lastPlayerId, (state.passCount || 0) + 1, mySide, ctx, -Infinity, Infinity);
            } else {
                _applyPlay(hands, playerId, p);
                if (hands[playerId].length === 0) {
                    // 自己的手牌是精确信息 → 打空手牌必胜，与对手手牌无关
                    _undoPlay(hands, playerId, p);
                    return p;
                }
                val = endgameMinimax(hands, (playerId + 1) % 3, getCardType(p), playerId, 0, mySide, ctx, -Infinity, Infinity);
                _undoPlay(hands, playerId, p);
            }
            if (ctx.truncated) break;  // 该世界评估不可靠 → 丢弃剩余候选
            const key = keyOf(p);
            let e = agg.get(key);
            if (!e) { e = { sum: 0, sq: 0, n: 0, play: p }; agg.set(key, e); }
            e.sum += val; e.sq += val * val; e.n++;
        }
    }

    // 只在"被同样多的世界评估过"的候选之间比较，避免样本数不同造成的偏差
    let maxN = 0;
    for (const e of agg.values()) maxN = Math.max(maxN, e.n);
    let bestPlay = null, bestScore = -Infinity, found = false;
    for (const e of agg.values()) {
        if (e.n === 0 || e.n < maxN) continue;
        const mean = e.sum / e.n;
        const variance = Math.max(0, e.sq / e.n - mean * mean);
        const score = mean - lambda * Math.sqrt(variance);
        if (score > bestScore) { bestScore = score; bestPlay = e.play; found = true; }
    }
    if (found) return bestPlay;
    for (const o of options) if (o && o.length > 0) return o;
    return plays[0] || null;
}

// 精确计算某一步的胜率价值（god-view），供离线评估/自博弈使用。play=null 表示过牌。
function endgameValue(state, playerId, play, opts) {
    opts = opts || {};
    const hands = state.players.map(p => [...p]);
    const mySide = (playerId === state.landlord) ? [playerId] : [0, 1, 2].filter(i => i !== state.landlord);
    const ctx = {
        nodes: 0,
        limit: opts.nodeLimit || 400000,
        tt: new Map(),
        truncated: false,
        deadline: Date.now() + (opts.timeBudgetMs || 1500),
    };
    if (play === null || play === undefined || play.length === 0) {
        return endgameMinimax(hands, (playerId + 1) % 3, state.lastPlay, state.lastPlayerId, (state.passCount || 0) + 1, mySide, ctx, -Infinity, Infinity);
    }
    _applyPlay(hands, playerId, play);
    let v;
    if (hands[playerId].length === 0) v = 100;
    else v = endgameMinimax(hands, (playerId + 1) % 3, getCardType(play), playerId, 0, mySide, ctx, -Infinity, Infinity);
    _undoPlay(hands, playerId, play);
    return v;
}

function endgameStats() {
    if (typeof globalThis === 'undefined') return null;
    const s = globalThis.__ENDGAME_STATS__;
    if (!s) return null;
    return { calls: s.calls, applied: s.applied, truncated: s.truncated, immediateWin: s.immediateWin, avgNodes: s.applied ? Math.round(s.avgNodes / s.applied) : 0 };
}

// ======================== 启发式模拟 ========================
function heuristicPlayoutWithMode(state, startPlayer, myId, memory, deterministic) {
    let s = _cloneStateShallow(state);
    let cp = startPlayer;
    let mySide = (myId === s.landlord) ? [myId] : [0,1,2].filter(i => i !== s.landlord);
    let hp = cfg('heuristicPlayout');
    for (let step = 0; step < hp.stepLimit; step++) {
        for (let i = 0; i < 3; i++) {
            if (s.players[i].length === 0) return mySide.includes(i);
        }
        if (s.passCount >= 2) { s.lastPlay = null; s.lastPlayerId = -1; s.passCount = 0; }
        s.currentPlayer = cp;
        let hand = s.players[cp];
        if (hand.length === 0) { cp = (cp + 1) % 3; continue; }
        let needBeat = s.lastPlay && s.lastPlayerId !== cp;
        let plays = needBeat ? getAllValidPlays(hand, s.lastPlay) : getAllValidPlays(hand, null);
        if (plays.length === 0) { s.passCount++; cp = (cp + 1) % 3; continue; }
        let role = cp === s.landlord ? 'landlord' : 'farmer';
        let scored = plays.map(p => {
            let feat = extractPlayFeatures(p, hand, s.lastPlay, role, memory, s);
            return { play: p, score: scorePlay(feat, role, memory, s, hand) };
        });
        scored.sort((a,b) => b.score - a.score);
        let chosenPlay = scored[0].play;
        if (!deterministic) {
            let r = Math.random();
            if (r >= hp.bestProb && scored.length > 1) chosenPlay = scored[1].play;
            if (r >= hp.top2Prob && scored.length > 2) chosenPlay = scored[2].play;
        }
        s.players[cp] = s.players[cp].filter(c => !chosenPlay.includes(c));
        s.lastPlay = getCardType(chosenPlay);
        s.lastPlayerId = cp;
        s.passCount = 0;
        if (s.players[cp].length === 0) return mySide.includes(cp);
        cp = (cp + 1) % 3;
    }
    return false;
}

// ======================== MCTS ========================
// 根节点先验的虚拟访问次数：让启发式评分靠前的走法先被采样，提升有限迭代下的搜索效率
const MCTS_PRIOR_VISITS = 8;
class MCTSNode {
    constructor(state, play, playerToMove, myId, priors) {
        this.state = state;
        this.play = play;
        this.playerToMove = playerToMove;
        this.myId = myId;
        this.visits = 0;
        this.wins = 0;
        this.parent = null;
        this.children = [];
        this.unexpandedPlays = null;
        this.priors = priors || null;
    }
    get isTerminal() {
        return this.state.phase === 'gameover' ||
            (this.state.players && this.state.players.some((p, i) => p && p.length === 0));
    }
    get isFullyExpanded() {
        if (this.unexpandedPlays === null) return false;
        return this.unexpandedPlays.length === 0;
    }
    getUCB1(child, C) {
        if (C === undefined) C = cfg('mcts.ucbC');
        if (child.visits === 0) return 1e9;
        return child.wins / child.visits + C * Math.sqrt(Math.log(Math.max(1, this.visits)) / child.visits);
    }
    selectChild() {
        let best = null, bestScore = -1e9;
        for (let child of this.children) {
            let score = this.getUCB1(child);
            if (score > bestScore) { bestScore = score; best = child; }
        }
        return best;
    }
    expand() {
        if (this.unexpandedPlays === null) {
            const st = this.state;
            const hand = st.players[this.playerToMove];
            const needBeat = st.lastPlay && st.lastPlayerId !== this.playerToMove;
            let plays = needBeat ? getAllValidPlays(hand, st.lastPlay) : getAllValidPlays(hand, null);
            // 分支剪枝：按启发式评分保留 top-N，聚焦高价值走法（炸弹/王炸/一手清始终保留）
            const isRoot = this.parent === null;
            const cap = isRoot ? (cfg('mcts.rootBranch') || 12) : (cfg('mcts.branch') || 8);
            if (plays.length > cap) {
                const mem = _memoryFromState(st);
                const role = this.playerToMove === st.landlord ? 'landlord' : 'farmer';
                const scoreOf = (p) => {
                    try { return scorePlay(extractPlayFeatures(p, hand, st.lastPlay, role, mem, st), role, mem, st, hand); }
                    catch (e) { return 0; }
                };
                const sorted = plays.slice().sort((a, b) => scoreOf(b) - scoreOf(a));
                const keep = sorted.slice(0, cap);
                const keepSet = new Set(keep);
                for (const p of sorted) {
                    const t = getCardType(p);
                    if (t && (t.type === CardType.BOMB || t.type === CardType.ROCKET)) keepSet.add(p);
                    if (p.length === hand.length) keepSet.add(p);
                }
                plays = [...keepSet];
            }
            if (needBeat) plays.push([]);
            // 反向存储，pop 时先取启发式最优，提升 alpha 式效率
            this.unexpandedPlays = plays.reverse();
        }
        let play = this.unexpandedPlays.pop();
        let newState = _cloneStateShallow(this.state);
        let nextPlayer = (this.playerToMove + 1) % 3;
        if (!play || play.length === 0) {
            newState.passCount = (newState.passCount || 0) + 1;
        } else {
            let playIds = new Set(play.map(c => c.id));
            newState.players[this.playerToMove] = newState.players[this.playerToMove].filter(c => !playIds.has(c.id));
            newState.lastPlay = getCardType(play);
            newState.lastPlayerId = this.playerToMove;
            newState.passCount = 0;
            if (newState.players[this.playerToMove].length === 0) newState.phase = 'gameover';
        }
        if (newState.passCount >= 2) { newState.lastPlay = null; newState.lastPlayerId = -1; newState.passCount = 0; }
        let child = new MCTSNode(newState, play || [], nextPlayer, this.myId);
        // 根节点先验：虚拟访问把搜索预算导向启发式评分靠前的走法
        if (this.parent === null && this.priors) {
            const key = (play && play.length) ? play.map(c => c.id).sort().join(',') : 'pass';
            const prior = this.priors.get(key);
            if (prior !== undefined && prior !== null) {
                child.visits += MCTS_PRIOR_VISITS;
                child.wins += MCTS_PRIOR_VISITS * prior;
            }
        }
        child.parent = this;
        this.children.push(child);
        return child;
    }
    bestChild() {
        // 鲁棒选取：在访问量足够（≥最大访问量 10%）的子节点中取胜率最高者，
        // 而非简单地取访问次数最多（原实现会偏向被探索多但胜率低的走法）。
        if (this.children.length === 0) return null;
        let maxVisits = 0;
        for (let c of this.children) if (c.visits > maxVisits) maxVisits = c.visits;
        let best = null, bestRate = -1;
        for (let c of this.children) {
            if (c.visits < Math.max(1, maxVisits * 0.1)) continue;
            let rate = c.visits > 0 ? c.wins / c.visits : 0;
            if (rate > bestRate) { bestRate = rate; best = c; }
        }
        if (best) return best;
        return this.children.reduce((a, b) => (b.visits > a.visits ? b : a), this.children[0]);
    }
}

function mctsSearch(state, playerId, iterations, memory, timeLimit, opts) {
    if (timeLimit === undefined) timeLimit = cfg('mcts.timeLimit');
    let hand = state.players[playerId];
    if (!hand || hand.length === 0) return null;
    let root = new MCTSNode(_cloneStateShallow(state), null, state.currentPlayer, playerId, (opts && opts.rootPriors) || null);
    let startTime = Date.now();
    for (let i = 0; i < iterations; i++) {
        if (Date.now() - startTime > timeLimit) break;
        let node = root;
        while (!node.isTerminal && node.children.length > 0 && node.isFullyExpanded) node = node.selectChild();
        if (!node.isTerminal && !node.isFullyExpanded) node = node.expand();
        let result;
        if (node.isTerminal) {
            let mySide = (playerId === node.state.landlord) ? [playerId] : [0,1,2].filter(i => i !== node.state.landlord);
            result = node.state.players.some((p, i) => mySide.includes(i) && p && p.length === 0);
        } else {
            result = heuristicPlayoutWithMode(node.state, node.playerToMove, playerId, memory, false);
        }
        while (node) { node.visits++; if (result) node.wins++; node = node.parent; }
    }
    let best = root.bestChild();
    if (best && Array.isArray(best.play)) {
        let needBeatRoot = state.lastPlay && state.lastPlayerId !== playerId;
        if (best.play.length > 0 || needBeatRoot) {
            if (opts && opts.collectStats) return Object.assign({}, best, { stats: _collectRootStats(root) });
            return best;
        }
    }
    let needBeat = state.lastPlay && state.lastPlayerId !== playerId;
    let fallbackPlays = needBeat ? getAllValidPlays(hand, state.lastPlay) : getAllValidPlays(hand, null);
    if (fallbackPlays.length > 0) return { play: fallbackPlays[0], visits: 0, wins: 0 };
    return null;
}
// 汇总 MCTS 根节点各走法的访问/胜出统计（供多世界聚合使用）
function _collectRootStats(root) {
    const stats = new Map();
    for (const child of root.children) {
        const key = (child.play && child.play.length) ? child.play.map(c => c.id).sort().join(',') : 'pass';
        let e = stats.get(key);
        if (!e) { e = { visits: 0, wins: 0, play: child.play || [] }; stats.set(key, e); }
        e.visits += child.visits;
        e.wins += child.wins;
    }
    return stats;
}

// ======================== 盲 MCTS（多世界聚合） ========================
// 根节点先验：用启发式评分给每个根走法一个虚拟胜率（只依赖公开信息）
function _buildRootPriors(state, playerId, memory) {
    const hand = state.players[playerId];
    if (!hand || !hand.length) return null;
    const role = (playerId === state.landlord) ? 'landlord' : 'farmer';
    const needBeat = state.lastPlay && state.lastPlayerId !== playerId;
    const plays = needBeat ? getAllValidPlays(hand, state.lastPlay) : getAllValidPlays(hand, null);
    if (!plays.length) return null;
    const scored = plays.map(p => {
        let s = 0;
        try {
            const f = extractPlayFeatures(p, hand, state.lastPlay, role, memory, state);
            s = scorePlay(f, role, memory, state, hand);
        } catch (e) { s = 0; }
        return { p, s };
    }).sort((a, b) => b.s - a.s);
    const map = new Map();
    const K = Math.min(scored.length, 12);
    for (let i = 0; i < scored.length; i++) {
        const key = scored[i].p.map(c => c.id).sort().join(',');
        const rank = Math.min(i, K);
        map.set(key, 0.5 + 0.3 * (1 - rank / Math.max(1, K)));
    }
    if (needBeat) map.set('pass', 0.35);
    return map;
}

function mctsSearchBlind(state, playerId, belief, opts) {
    opts = opts || {};
    const hand = state.players[playerId];
    if (!hand || hand.length === 0) return null;
    const worlds = Math.max(1, opts.worlds || 3);
    const iterations = opts.iterations || cfg('mcts.iterations.hard') || 600;
    const budgetMs = opts.timeBudgetMs !== undefined ? opts.timeBudgetMs : (cfg('blind.mctsTimeBudgetMs.hard') || 1000);
    const deadline = Date.now() + budgetMs;
    const memory = opts.memory || null;
    const priors = (cfg('blind.mctsRootPriors.' + (opts.difficulty || 'hard')) !== 0) ? _buildRootPriors(state, playerId, memory) : null;
    const lambda = opts.robustness !== undefined ? opts.robustness : (cfg('blind.robustness') !== undefined ? cfg('blind.robustness') : 0.25);
    const agg = new Map();
    for (let w = 0; w < worlds; w++) {
        if (Date.now() > deadline) break;
        const worldPlayers = belief.sampleWorld();
        const worldState = Object.assign({}, state, { players: worldPlayers });
        const remainMs = deadline - Date.now();
        const perWorldTime = Math.max(50, Math.floor(remainMs / Math.max(1, worlds - w)));
        let res = null;
        try {
            res = mctsSearch(worldState, playerId, iterations, memory, perWorldTime, { collectStats: true, rootPriors: priors });
        } catch (e) { res = null; }
        if (!res || !res.stats) continue;
        for (const [key, e] of res.stats) {
            let a = agg.get(key);
            if (!a) { a = { visits: 0, wins: 0, play: e.play, rates: [] }; agg.set(key, a); }
            a.visits += e.visits;
            a.wins += e.wins;
            if (e.visits > 0) a.rates.push(e.wins / e.visits);   // 每个世界里的胜率，用于稳健聚合
        }
    }
    if (!agg.size) return null;
    let maxVisits = 0;
    for (const a of agg.values()) maxVisits = Math.max(maxVisits, a.visits);
    // 跨世界稳健聚合：均值 − λ×标准差（压制"赌对了某个世界"的走法），并对覆盖世界数不足的走法降权
    let best = null, bestScore = -Infinity, bestRate = 0;
    for (const a of agg.values()) {
        if (a.visits < Math.max(1, maxVisits * 0.1)) continue;
        const rate = a.visits > 0 ? a.wins / a.visits : 0;
        let score = rate;
        if (a.rates.length > 0) {
            const mean = a.rates.reduce((x, y) => x + y, 0) / a.rates.length;
            let std = 0;
            if (a.rates.length > 1) {
                const variance = a.rates.reduce((x, y) => x + (y - mean) * (y - mean), 0) / a.rates.length;
                std = Math.sqrt(variance);
            }
            const coverage = a.rates.length / Math.max(1, worlds);
            score = mean - lambda * std - 0.15 * (1 - coverage);
        }
        if (score > bestScore) { bestScore = score; best = a.play; bestRate = rate; }
    }
    if (!best) {
        let top = null;
        for (const a of agg.values()) if (!top || a.visits > top.visits) top = a;
        best = top ? top.play : null;
        bestRate = top && top.visits > 0 ? top.wins / top.visits : 0;
    }
    if (!best) return null;
    const needBeatRoot = state.lastPlay && state.lastPlayerId !== playerId;
    if (best.length > 0 || needBeatRoot) return { play: best, visits: maxVisits, wins: Math.round(bestRate * maxVisits) };
    return null;
}

// ======================== 迷你 AI 引擎 (纯计算版) ========================
class AICore {
    constructor(id, difficulty, memory) {
        this.id = id; this.difficulty = difficulty; this.memory = memory;
        // 额外预算缩放：主线程同步决策时由调用方调小（避免卡住 UI）
        this.budgetScale = 1;
    }
    // 有效时间预算 = 标称值 × 设备速度系数 × 额外缩放（移动端自动降档）
    budgetMs(path, fallback) {
        let base = cfg(path);
        if (base === undefined || base === null) base = fallback || 0;
        const scale = (AI_PERF.factor || 1) * (this.budgetScale || 1);
        return Math.max(50, Math.round(base * scale));
    }
    think(phase, state) {
        if (phase === 'call') return this.callDecision(state);
        return this.playDecision(state);
    }
    callDecision(state) {
        let curr = state.baseScore;
        let ct = cfg('callThresholds.' + this.difficulty) || {};
        if (this.difficulty === 'easy') {
            let strength = evaluateHandStrength(state.players[this.id], this.memory, false, this.id);
            return strength > (ct.one || 28) && curr < 1 ? 1 : 0;
        }
        if (this.difficulty === 'medium') {
            let strength = evaluateHandStrength(state.players[this.id], this.memory, false, this.id);
            if (strength > (ct.three || 42) && curr < 3) return 3;
            if (strength > (ct.two || 32) && curr < 2) return 2;
            if (strength > (ct.one || 22) && curr < 1) return 1;
            return 0;
        }
        if (this.difficulty === 'legendary') {
            // 叫分评估同样走"信念世界"，不窥视他人手牌
            const worlds = Math.max(1, cfg('blind.worlds.call.' + this.difficulty) || 6);
            const trials = cfg('blind.callTrials.' + this.difficulty) || 60;
            const lordCards = state.lordCards || [];
            // 以"我当地主 + 拿底牌"为前提构造信念（底牌归属公开，因此从对手牌池中剔除）
            const callState = Object.assign({}, state, {
                landlord: this.id,
                phase: 'playing',
                players: state.players.map((p, i) => (i === this.id ? [...p, ...lordCards] : p))
            });
            const belief = new HandBelief(this.id, callState, this.memory);
            let bestBid = 0, bestEV = -999;
            for (let bid = 1; bid <= 3; bid++) {
                if (bid <= curr) continue;
                let wins = 0;
                for (let i = 0; i < trials; i++) {
                    const worldPlayers = belief.sampleWorld();
                    // worldPlayers[this.id] 已经是"我当地主 + 拿底牌"后的 20 张手牌
                    const rs = Object.assign({}, state, {
                        landlord: this.id,
                        phase: 'playing',
                        players: worldPlayers.map(p => p.map(c => ({ ...c })))
                    });
                    if (heuristicPlayoutWithMode(rs, this.id, this.id, this.memory, false)) wins++;
                }
                let winRate = wins / trials;
                let ev = winRate * bid - (1 - winRate) * bid * 2;
                if (ev > bestEV) { bestEV = ev; bestBid = bid; }
            }
            return bestBid;
        }
        let strength = evaluateHandStrength(state.players[this.id], this.memory, false, this.id);
        let bombBonus = 0;
        let values = state.players[this.id].map(c=>c.value);
        let cnt = countValues(values);
        for (let v in cnt) if (cnt[v] === 4) bombBonus += (ct.bombBonus || 20);
        if (cnt[13] === 1 && cnt[14] === 1) bombBonus += (ct.bothJokersBonus || 20);
        strength += bombBonus;
        let singlePenalty = Object.values(cnt).filter(c => c === 1).length * (ct.singlePenaltyFactor || 3);
        strength -= singlePenalty;
        if (strength > (ct.three || 42) && curr < 3) return 3;
        if (strength > (ct.two || 30) && curr < 2) return 2;
        if (strength > (ct.one || 20) && curr < 1) return 1;
        return 0;
    }
    playDecision(state) {
        let hand = [...state.players[this.id]];
        if (hand.length === 0) return [];
        let lastPlay = state.lastPlay;
        let role = (this.id === state.landlord) ? 'landlord' : 'farmer';
        let partnerId = null;
        if (role === 'farmer') {
            for (let i = 0; i < 3; i++) {
                if (i !== this.id && i !== state.landlord) { partnerId = i; break; }
            }
        }
        let endgameLimit = cfg('endgameThresholds.' + this.difficulty) || 10;
        // ===== 公平性：只使用公开信息建立信念模型（对手手牌不可见） =====
        const belief = new HandBelief(this.id, state, this.memory);
        if (hand.length <= endgameLimit) {
            let egResult = solveEndgameBlind(state, this.id, belief, {
                worlds: cfg('blind.worlds.endgame.' + this.difficulty) || 4,
                timeBudgetMs: this.budgetMs('blind.endgameTimeBudgetMs.' + this.difficulty, 600),
                memory: this.memory
            });
            if (egResult !== null) return egResult;
        }
        let mctsLimit = cfg('mcts.handLimit.' + this.difficulty) || 0;
        let mctsIters = cfg('mcts.iterations.' + this.difficulty) || 0;
        if ((this.difficulty === 'hard' || this.difficulty === 'grandmaster' || this.difficulty === 'legendary') && hand.length <= mctsLimit) {
            let mctsResult = mctsSearchBlind(state, this.id, belief, {
                iterations: mctsIters,
                worlds: cfg('blind.worlds.mcts.' + this.difficulty) || 3,
                timeBudgetMs: this.budgetMs('blind.mctsTimeBudgetMs.' + this.difficulty, 1000),
                memory: this.memory,
                difficulty: this.difficulty
            });
            if (mctsResult && Array.isArray(mctsResult.play)) {
                let needBeatMcts = lastPlay && state.lastPlayerId !== this.id;
                if (mctsResult.play.length > 0 || needBeatMcts) return mctsResult.play;
            }
        }
        if (lastPlay && state.lastPlayerId !== this.id) {
            if (lastPlay.type === CardType.ROCKET) return [];
            if (lastPlay.type === CardType.BOMB) {
                let hasBeatingBomb = Object.values(hand.reduce((a,c)=>(a[c.value]=(a[c.value]||0)+1,a),{})).some(v=>v===4);
                if (!hasBeatingBomb && !(hand.some(c=>c.value===13) && hand.some(c=>c.value===14))) return [];
            }
        }
        if (!lastPlay || state.lastPlayerId === this.id) {
            let allPlays = getAllValidPlays(hand, null);
            let lead = this.selectLeadSmart(allPlays, role, hand, state, partnerId);
            return this.refineLeadByBelief(lead, allPlays, hand, state, role, belief);
        }
        let beatable = getAllValidPlays(hand, lastPlay);
        if (beatable.length === 0) return [];
        let simWorlds = Math.max(1, cfg('blind.worlds.sim.' + this.difficulty) || 3);
        let simCache = null;
        let scored = beatable.map(play => {
            let features = extractPlayFeatures(play, hand, lastPlay, role, this.memory, state);
            let baseScore = scorePlay(features, role, this.memory, state, hand);
            let simScore = 0;
            let simDepth = cfg('simulation.depth.' + this.difficulty) || 0;
            let simHandLimit = cfg('simulation.handLimit.' + this.difficulty) || 0;
            let dpBonusFactor = cfg('simulation.dpBonusFactor.' + this.difficulty) || 0;
            if (simDepth > 0 && hand.length <= simHandLimit) {
                if (!simCache) simCache = belief.sampleWorlds(simWorlds);
                simScore = simulateOpponentResponseBlind(play, hand, state, role, this.memory, belief, simDepth, simCache);
                if (dpBonusFactor > 0) {
                    let newHand = hand.filter(c => !play.includes(c));
                    let dpPlan = decomposeHandDP(newHand);
                    simScore += dpPlan.score * dpBonusFactor;
                }
            }
            return { play, score: baseScore + simScore * 0.4 };
        });
        let passScore = computePassScore(role, state);
        scored.push({ play: [], score: passScore });
        // ===== 信念修正：对手很可能握着炸弹/王炸时，我方炸弹多半会被压穿 → 降低用炸优先级 =====
        const bombRiskWeight = cfg('blind.bombRiskWeight.' + this.difficulty) || 0;
        if (bombRiskWeight > 0 && state.lastPlayerId >= 0 && state.lastPlayerId !== this.id) {
            let risk = Math.min(1, belief.bombRiskFor(state.lastPlayerId) + belief.rocketRiskFor(state.lastPlayerId));
            if (risk > 0.05) {
                for (const s of scored) {
                    if (!s.play || s.play.length === 0) continue;
                    const t = getCardType(s.play);
                    if (!t) continue;
                    if (t.type === CardType.BOMB || t.type === CardType.ROCKET) s.score -= risk * bombRiskWeight;
                }
            }
        }
        scored.sort((a,b)=>b.score - a.score);
        if (scored[0].play.length === 0) return [];
        let isCritical = (hand.length <= 3) || (this.memory.getMaxOutside(hand) <= 12 && hand.length <= 5);
        let roleP = (state.landlord === this.id) ? 'landlord' : 'farmer';
        let oppCloseToWin;
        if (roleP === 'farmer') {
            oppCloseToWin = (state.players[state.landlord]?.length || 20) <= 2;
        } else {
            oppCloseToWin = [0, 1, 2].some(i => i !== state.landlord && (state.players[i]?.length || 20) <= 2);
        }
        let noRandom = isCritical || oppCloseToWin;
        let rf = cfg('randomFactors');
        let randomFactor = rf[this.difficulty] !== undefined ? rf[this.difficulty] : 0.6;
        let chosenPlay;
        if (!noRandom && Math.random() < randomFactor && scored.length > 1 && scored[1].play.length > 0) {
            chosenPlay = scored[1].play;
        } else {
            chosenPlay = scored[0].play;
        }
        // 记录推理快照（浏览器端供 GameRecorder 使用；Worker/Node 无 window 自动跳过）
        try {
            this.lastReasoning = {
                turn: (typeof state !== 'undefined' && state.actions) ? state.actions.length : 0,
                player: this.id,
                phase: 'play',
                chosen: chosenPlay,
                chosenScore: scored.find(s => s.play === chosenPlay) ? scored.find(s => s.play === chosenPlay).score : 0,
                candidates: scored.slice(0, Math.min(scored.length, 10)).map(s => ({
                    type: s.play.length > 0 ? (getCardType(s.play) ? getCardType(s.play).type : 'unknown') : 'pass',
                    score: s.score,
                    isChosen: s.play === chosenPlay
                }))
            };
        } catch (e) { this.lastReasoning = null; }
        return chosenPlay;
    }
    // 用信念模型评估"领出被压概率"，在启发式首选与更稳的领出之间做小幅取舍
    // （只用公开信息：对手可能持有的牌来自未见牌池采样）
    refineLeadByBelief(preferred, allPlays, hand, state, role, belief) {
        if (!preferred || !allPlays || !allPlays.length) return preferred;
        const samples = cfg('blind.beatProbSamples.' + this.difficulty) || 0;
        const weight = cfg('blind.beatProbWeight.' + this.difficulty) || 0;
        if (!samples || !weight) return preferred;
        const nextId = (state.currentPlayer + 1) % 3;
        // 只有"下一个是对手"时，被压才有代价（自己人或队友接牌不算损失）
        const nextIsOpp = (role === 'landlord') ? (nextId !== state.landlord) : (nextId === state.landlord);
        if (!nextIsOpp) return preferred;
        const maxCands = cfg('blind.beatProbCandidates.' + this.difficulty) || 4;
        const cands = [preferred];
        const keyOf = (p) => p.map(c => c.id).sort().join(',');
        const prefKey = keyOf(preferred);
        for (const p of allPlays) {
            if (cands.length >= maxCands) break;
            if (p.length !== preferred.length) continue;
            if (keyOf(p) === prefKey) continue;
            cands.push(p);
        }
        let best = preferred, bestScore = -Infinity;
        for (const p of cands) {
            let prob = 0;
            try { prob = belief.beatProbability(p, nextId, samples); } catch (e) { prob = 0; }
            // 期望"能守住这手牌"的收益；非首选候选有轻微惩罚，保证不推翻手牌结构启发式
            let s = (1 - prob) * weight - (p === preferred ? 0 : 2);
            if (s > bestScore) { bestScore = s; best = p; }
        }
        return best || preferred;
    }
    selectLeadSmart(plays, role, hand, state, partnerId) {
        if (plays.length === 0) return [];
        let fullHouse = plays.find(p => p.length === hand.length);
        if (fullHouse) return fullHouse;
        if (role === 'landlord') {
            let _oppMin = Math.min(
                (state.players[(state.currentPlayer + 1) % 3] || {length:20}).length,
                (state.players[(state.currentPlayer + 2) % 3] || {length:20}).length
            );
            let nextId = (state.currentPlayer + 1) % 3;
            let nextClose = ((state.players[nextId] || {length:20}).length) <= 2;
            let dpLimit = cfg('endgameThresholds.' + this.difficulty) || 12;
            let sl = cfg('selectLead.landlord');
            if (hand.length <= dpLimit) {
                let plan = decomposeHandDP(hand);
                if (plan.plays.length > 0) {
                    let bestLead = null, bestLeadScore = -Infinity;
                    for (let p of plan.plays) {
                        let score = -getPlayPower(p);
                        let type = getCardType(p);
                        if (type && (type.type === CardType.BOMB || type.type === CardType.ROCKET)) score += sl.bombPenalty;
                        if (p.length >= 5) score += sl.longGte5;
                        else if (p.length >= 3) score += sl.longGte3;
                        else if (p.length === 2) score += sl.pairPlay;
                        if (type && type.type === CardType.STRAIGHT) score += sl.straightBonus;
                        if (type && type.type === CardType.STRAIGHT_PAIR) score += sl.straightPairBonus;
                        if (type && type.type === CardType.PLANE) score += sl.planeBonus;
                        if (type && (type.type === CardType.PLANE_WITH_SINGLE || type.type === CardType.PLANE_WITH_PAIR)) score += sl.planeWithBonus;
                        if (type && (type.type === CardType.TRIPLE_WITH_SINGLE || type.type === CardType.TRIPLE_WITH_PAIR)) score += sl.tripleWithBonus;
                        let val = p[0].value;
                        if (nextClose && p.length === 1 && val < 12) {
                            score = -500 + val * 3;
                        } else {
                            if (val <= 6) score += sl.smallValLe6;
                            if (val >= 12 && p.length <= 2) score += sl.controlValGe12LenLe2;
                            if (_oppMin <= 2 && p.length <= 2 && val < 12) score -= 500;
                        }
                        if (score > bestLeadScore) { bestLeadScore = score; bestLead = p; }
                    }
                    if (bestLead) return bestLead;
                }
            }
            let straightPlays = plays.filter(p => getCardType(p)?.type === CardType.STRAIGHT);
            if (straightPlays.length) return straightPlays.sort((a,b)=>b.length-a.length)[0];
            let planePlays = plays.filter(p => {
                let t = getCardType(p);
                return t && (t.type === CardType.PLANE || t.type === CardType.PLANE_WITH_SINGLE || t.type === CardType.PLANE_WITH_PAIR);
            });
            if (planePlays.length > 0) return planePlays.reduce((a,b) => getCardType(a).value < getCardType(b).value ? a : b);
            let triplePlays = plays.filter(p => {
                let t = getCardType(p);
                return t && (t.type === CardType.TRIPLE_WITH_SINGLE || t.type === CardType.TRIPLE_WITH_PAIR);
            });
            if (triplePlays.length > 0) return triplePlays.reduce((a,b) => getCardType(a).value < getCardType(b).value ? a : b);
            let smallPairs = plays.filter(p => p.length === 2 && getCardType(p).value <= 6);
            if (smallPairs.length > 0) return smallPairs.reduce((a,b) => getCardType(a).value < getCardType(b).value ? a : b);
            if (_oppMin > 2) {
                let twoPlay = plays.find(p => {
                    if (p.length === hand.length) return true;
                    let rest = hand.filter(c => !p.includes(c));
                    let restPlays = getAllValidPlays(rest, null);
                    return rest.length === 0 || restPlays.some(rp => rp.length === rest.length);
                });
                if (twoPlay) return twoPlay;
            }
            if (nextClose) {
                let singles = plays.filter(p => p.length === 1);
                if (singles.length > 0 && plays.every(p => p.length === 1)) {
                    return singles.sort((a,b)=>getPlayPower(b)-getPlayPower(a))[0];
                }
            }
            if (_oppMin <= 2) {
                let safe = plays.filter(p => p.length !== 1 || p[0].value >= 10);
                if (safe.length > 0) return safe.sort((a,b)=>getPlayPower(a)-getPlayPower(b))[0];
            }
            let smallSingles = plays.filter(p => p.length === 1 && p[0].value <= 6);
            if (smallSingles.length > 0) return smallSingles.reduce((a,b) => a[0].value < b[0].value ? a : b);
            return plays.sort((a,b)=>getPlayPower(a)-getPlayPower(b))[0];
        } else {
            let isLordNext = (state.landlord + 1) % 3 === this.id;
            let partnerCount = state.players[partnerId !== null ? partnerId : -1]?.length || 20;
            let lordCards = state.players[state.landlord] ? state.players[state.landlord].length : 20;
            if (isLordNext && partnerCount <= 2 && lordCards > 2) {
                return plays.reduce((a,b) => getPlayPower(a) < getPlayPower(b) ? a : b);
            }
            if (lordCards <= 2) {
                let combos = plays.filter(p => p.length >= 3 && getCardType(p)?.type !== CardType.BOMB && getCardType(p)?.type !== CardType.ROCKET);
                if (combos.length > 0) return combos.reduce((a,b) => getPlayPower(a) > getPlayPower(b) ? a : b);
                return plays.reduce((a,b) => getPlayPower(a) > getPlayPower(b) ? a : b);
            }
            if (isLordNext) {
                let midSingle = plays.find(p => p.length === 1 && p[0].value >= 7 && p[0].value <= 10);
                if (midSingle) return midSingle;
                let smallSingle = plays.find(p => p.length === 1 && p[0].value <= 6);
                if (smallSingle) return smallSingle;
                let smallPair = plays.find(p => p.length === 2 && getCardType(p).value <= 10);
                if (smallPair) return smallPair;
                let midPlay = plays.find(p => p.length >= 3 && getPlayPower(p) <= 60);
                if (midPlay) return midPlay;
            } else {
                let nextLordClose = ((state.players[(state.currentPlayer + 1) % 3] || {length:20}).length) <= 4;
                if (nextLordClose) {
                    let combos = plays.filter(p => {
                        let t = getCardType(p);
                        return p.length >= 3 && t && t.type !== CardType.BOMB && t.type !== CardType.ROCKET;
                    });
                    if (combos.length > 0) return combos.reduce((a,b) => getPlayPower(a) > getPlayPower(b) ? a : b);
                    return plays.reduce((a,b) => getPlayPower(a) > getPlayPower(b) ? a : b);
                }
                let midSingle = plays.find(p => p.length === 1 && p[0].value >= 7 && p[0].value <= 10);
                if (midSingle) return midSingle;
                let midPair = plays.find(p => p.length === 2 && getCardType(p).value >= 7 && getCardType(p).value <= 10);
                if (midPair) return midPair;
                let smallSingle = plays.find(p => p.length === 1 && p[0].value <= 6);
                if (smallSingle) return smallSingle;
                let smallPair = plays.find(p => p.length === 2 && getCardType(p).value <= 8);
                if (smallPair) return smallPair;
            }
            let dpLimit = cfg('endgameThresholds.' + this.difficulty) || 12;
            let sl = cfg('selectLead.farmer');
            if (hand.length <= dpLimit) {
                let plan = decomposeHandDP(hand);
                if (plan.plays.length > 0) {
                    let bestLead = null, bestLeadScore = -Infinity;
                    for (let p of plan.plays) {
                        let score = -getPlayPower(p);
                        let type = getCardType(p);
                        if (type && (type.type === CardType.BOMB || type.type === CardType.ROCKET)) score += sl.bombPenalty;
                        if (p.length >= 3) score += sl.comboGte3;
                        if (partnerCount <= 3) score += sl.partnerLow;
                        if (isLordNext) score += sl.lordNext;
                        if (score > bestLeadScore) { bestLeadScore = score; bestLead = p; }
                    }
                    if (bestLead) return bestLead;
                }
            }
            let midSingle2 = plays.find(p => p.length === 1 && p[0].value >= 7 && p[0].value <= 10);
            if (midSingle2) return midSingle2;
            let smallPair2 = plays.find(p => p.length === 2 && getCardType(p).value <= 8);
            if (smallPair2) return smallPair2;
            return plays.sort((a,b)=>getPlayPower(a)-getPlayPower(b))[0];
        }
    }
}

