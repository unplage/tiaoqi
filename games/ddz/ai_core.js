// ai_core.js — 共享 AI 内核（浏览器 <script> 与 Worker importScripts 双端复用）
// 依赖：无（通过 cfg()/matchRules() 适配外部参数与纠错规则）
// 浏览器：务必在 ai_learner.js 之前加载
'use strict';

// ======================== 参数访问适配层 ========================
// 优先级：ParamConfig(browser) > globalThis.__aiParamGet(worker) > globalThis.__AI_PARAMS__(bench) > DEFAULT_PARAMS
const _CFG_CACHE = new Map();
function invalidateParamCache() {
    try { _CFG_CACHE.clear(); } catch (e) {}
}
function cfg(path) {
    // 冻结参考参数：反事实标签生成时设置，使 scorePlay 用固定的上一代权重，
    // 与正在被学习的权重解耦（避免"用被学习权重给自己打标签"的闭环自证）。
    // 只在 _withRefParams 保护下生效，且跳过缓存以防污染正常决策。
    if (typeof globalThis !== 'undefined' && globalThis.__aiRefParams) {
        const rp = globalThis.__aiRefParams;
        let val = rp;
        for (const part of path.split('.')) {
            if (val && typeof val === 'object' && part in val) val = val[part];
            else { val = undefined; break; }
        }
        if (val !== undefined) return val;
    }
    const cached = _CFG_CACHE.get(path);
    if (cached !== undefined) return cached.value;
    let out;
    try {
        if (typeof ParamConfig !== 'undefined' && ParamConfig && typeof ParamConfig.get === 'function') {
            const v = ParamConfig.get(path);
            if (v !== undefined) { out = v; }
        }
    } catch (e) {}
    if (out === undefined) {
        try {
            if (typeof globalThis !== 'undefined') {
                const pg = globalThis.__aiParamGet;
                if (typeof pg === 'function') { const v = pg(path); if (v !== undefined) out = v; }
                if (out === undefined) {
                    const ov = globalThis.__AI_PARAMS__;
                    if (ov) {
                        let val = ov, ok = true;
                        for (const p of path.split('.')) { if (val && typeof val === 'object' && p in val) val = val[p]; else { ok = false; break; } }
                        if (ok) out = val;
                    }
                }
            }
        } catch (e) {}
    }
    if (out === undefined) {
        let val = DEFAULT_PARAMS;
        for (const p of path.split('.')) { val = (val && typeof val === 'object') ? val[p] : undefined; if (val === undefined) break; }
        out = val;
    }
    if (_CFG_CACHE.size > 512) _CFG_CACHE.clear();
    _CFG_CACHE.set(path, { value: out });
    return out;
}
function matchRules(ctx) {
    try {
        if (typeof CorrectionRules !== 'undefined' && CorrectionRules && typeof CorrectionRules.match === 'function') return CorrectionRules.match(ctx);
        if (typeof globalThis !== 'undefined' && typeof globalThis.__aiMatchRules === 'function') return globalThis.__aiMatchRules(ctx);
    } catch (e) {}
    return [];
}

// 确定性搜索模式：只用节点/迭代预算，不看挂钟 → 同种子同参数必然同结果
function isDeterministicSearch() {
    try { return !!cfg('search.deterministic'); } catch (e) { return false; }
}

// 自适应 MCTS 时间预算：候选少/局面简单时不吃满固定预算。
// 主线程决策与多 Worker 并行路径必须共用同一公式，否则两条路径的耗时/强度不一致。
function adaptiveMctsBudget(difficulty, candidateCount, handLength, baseBudgetMs) {
    if (cfg('blind.adaptiveMctsBudget') === false) return baseBudgetMs;
    const rootBranch = cfg('mcts.rootBranch') || 12;
    const effective = Math.max(0, Math.min(candidateCount || 0, rootBranch));
    const minMs = cfg('blind.mctsMinBudgetMs.' + difficulty) || 200;
    const perCand = cfg('blind.mctsMsPerCandidate.' + difficulty) || 40;
    const adaptive = effective * perCand + (handLength || 0) * 5;
    return Math.min(baseBudgetMs, Math.max(minMs, adaptive));
}

// 是否值得把这一手的盲 MCTS 拆到多个 Worker：
// 只在 MCTS 区间内、且残局求解器不会接管时启用。
function canParallelMcts(state, playerId, difficulty, availableWorkers) {
    if (!state || !state.players || (availableWorkers || 0) < 2) return false;
    if (difficulty !== 'hard' && difficulty !== 'grandmaster' && difficulty !== 'legendary') return false;
    const hand = state.players[playerId];
    const len = Array.isArray(hand) ? hand.length : 0;
    const mctsLimit = cfg('mcts.handLimit.' + difficulty) || 0;
    if (!len || len > mctsLimit) return false;
    // 残局求解器已经能接管时不需要并行 MCTS
    const endgameLimit = cfg('endgameThresholds.' + difficulty) || 10;
    const maxTotal = cfg('endgame.maxTotalCards') || 24;
    const maxHand = cfg('endgame.maxHandCards') || 20;
    let total = 0;
    for (const p of state.players) {
        if (Array.isArray(p)) total += p.length;
        else if (typeof p === 'number') total += p;
        else if (p && typeof p.length === 'number') total += p.length;
    }
    if (len <= endgameLimit && len <= maxHand && total <= maxTotal) return false;
    const worlds = cfg('blind.worlds.mcts.' + difficulty) || 0;
    return worlds >= 2;
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
// 牌型只取决于「点数多重集」（王炸额外取决于 joker id），
// 因此缓存键用点数计数签名 —— 比按 id 排序便宜得多。
//
// 重要：缓存**只保存牌型元数据**（type/value/length），绝不保存牌对象。
// 旧实现把首次调用那手牌的牌对象存进缓存（键不含花色），命中时返回"别手的牌"，
// 导致 GameState.lastPlay.cards 指向另一手牌 → UI 显示错误花色 / 动作日志错乱。
// 需要牌对象时用 getCardTypeWithCards()，它总是返回当前入参的牌。
const _CARD_TYPE_CACHE = new Map();
const _CARD_TYPE_CACHE_MAX = 6000;
function _cardTypeSignature(cards) {
    let cnt = new Array(15).fill(0);
    let j1 = 0, j2 = 0;
    for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        if (c && c.value >= 0 && c.value <= 14) cnt[c.value]++;
        if (c && c.id === 'joker1') j1++;
        else if (c && c.id === 'joker2') j2++;
    }
    // Array.join 在 V8 里比逐段字符串拼接快得多
    return cards.length + '|' + cnt.join(',') + (j1 ? 'J1' : '') + (j2 ? 'J2' : '');
}
function _cacheCardType(sig, type, value, length) {
    if (_CARD_TYPE_CACHE.size >= _CARD_TYPE_CACHE_MAX) _CARD_TYPE_CACHE.clear();
    _CARD_TYPE_CACHE.set(sig, { type, value, length });
    return { type, value, length };
}
// 返回牌型 + 当前这手牌（牌对象永远来自入参，不会串味）
function getCardTypeWithCards(cards) {
    const t = getCardType(cards);
    if (!t) return null;
    t.cards = cards.slice();
    return t;
}
function getCardType(cards) {
    if (!cards || cards.length === 0) return null;
    const sig = _cardTypeSignature(cards);
    const hit = _CARD_TYPE_CACHE.get(sig);
    if (hit) {
        return { type: hit.type, value: hit.value, length: hit.length };
    }
    const sorted = [...cards].sort((a,b)=>a.value-b.value);
    const values = sorted.map(c=>c.value);
    const uniq = [...new Set(values)];
    if (cards.length === 2 && cards.some(c=>c.id==='joker1') && cards.some(c=>c.id==='joker2')) return _cacheCardType(sig, CardType.ROCKET, 100, undefined);
    if (cards.length === 1) return _cacheCardType(sig, CardType.SINGLE, values[0], undefined);
    if (cards.length === 2 && uniq.length === 1) return _cacheCardType(sig, CardType.PAIR, values[0], undefined);
    if (cards.length === 3 && uniq.length === 1) return _cacheCardType(sig, CardType.TRIPLE, values[0], undefined);
    if (cards.length === 4 && uniq.length === 1) return _cacheCardType(sig, CardType.BOMB, values[0]+50, undefined);
    if (cards.length === 4 && uniq.length === 2) { let cnt = countValues(values); if (Object.values(cnt).includes(3)) return _cacheCardType(sig, CardType.TRIPLE_WITH_SINGLE, parseInt(Object.keys(cnt).find(k=>cnt[k]===3)), undefined); }
    if (cards.length === 5 && uniq.length === 2) { let cnt = countValues(values); if (Object.values(cnt).includes(3) && Object.values(cnt).includes(2)) return _cacheCardType(sig, CardType.TRIPLE_WITH_PAIR, parseInt(Object.keys(cnt).find(k=>cnt[k]===3)), undefined); }
    if (cards.length === 6) {
        let cnt = countValues(values);
        let four = Object.keys(cnt).find(k=>cnt[k]===4);
        if (four) {
            const fv = parseInt(four);
            const wingKeys = Object.keys(cnt).filter(k=>parseInt(k)!==fv);
            const wingCards = wingKeys.reduce((sum,k)=>sum+cnt[k],0);
            if (wingCards === 2 && wingKeys.every(k=>cnt[k]<=2))
                return _cacheCardType(sig, CardType.FOUR_WITH_TWO_SINGLE, fv, undefined);
        }
    }
    if (cards.length === 8) { let cnt = countValues(values); let four = Object.keys(cnt).find(k=>cnt[k]===4); if (four && Object.values(cnt).filter(v=>v===2).length === 2) return _cacheCardType(sig, CardType.FOUR_WITH_TWO_PAIR, parseInt(four), undefined); }
    if (cards.length >= 5 && uniq.length === cards.length && isStraight(values) && values[cards.length-1] <= 11 && !values.includes(12)) return _cacheCardType(sig, CardType.STRAIGHT, values[0], cards.length);
    if (cards.length >= 6 && cards.length % 2 === 0) {
        let cnt = countValues(values);
        let pairs = Object.keys(cnt).filter(k=>cnt[k]===2).map(Number).sort((a,b)=>a-b);
        if (pairs.length === cards.length/2 && isStraight(pairs) && pairs[pairs.length-1] <= 11) return _cacheCardType(sig, CardType.STRAIGHT_PAIR, pairs[0], pairs.length);
    }
    if (cards.length >= 6 && cards.length % 3 === 0) {
        let cnt = countValues(values);
        let tripVals = Object.keys(cnt).filter(k=>cnt[k]===3).map(Number).sort((a,b)=>a-b);
        let groupLen = cards.length / 3;
        if (tripVals.length === groupLen && groupLen >= 2 && isStraight(tripVals) && tripVals[groupLen-1] <= 11)
            return _cacheCardType(sig, CardType.PLANE, tripVals[0], groupLen);
    }
    if (cards.length >= 8 && cards.length % 4 === 0) {
        let cnt = countValues(values);
        let groupLen = cards.length / 4;
        let tripVals = Object.keys(cnt).filter(k=>cnt[k]===3).map(Number).sort((a,b)=>a-b);
        for (let i=0; i+groupLen<=tripVals.length; i++) {
            let seq = tripVals.slice(i, i+groupLen);
            if (!isStraight(seq) || seq[groupLen-1]>11) continue;
            let used = new Set(seq);
            let wingKeys = Object.keys(cnt).filter(k=>!used.has(parseInt(k)));
            let wingCards = wingKeys.reduce((sum,k)=>sum+cnt[k],0);
            if (wingCards !== groupLen) continue;
            if (wingKeys.some(k=>cnt[k]>2)) continue;
            return _cacheCardType(sig, CardType.PLANE_WITH_SINGLE, seq[0], groupLen);
        }
    }
    if (cards.length >= 10 && cards.length % 5 === 0) {
        let cnt = countValues(values);
        let groupLen = cards.length / 5;
        let tripVals = Object.keys(cnt).filter(k=>cnt[k]===3).map(Number).sort((a,b)=>a-b);
        for (let i=0; i+groupLen<=tripVals.length; i++) {
            let seq = tripVals.slice(i, i+groupLen);
            if (!isStraight(seq) || seq[groupLen-1]>11) continue;
            let used = new Set(seq);
            let remain = Object.keys(cnt).filter(k=>!used.has(parseInt(k)) && cnt[k]===2);
            if (remain.length === groupLen)
                return _cacheCardType(sig, CardType.PLANE_WITH_PAIR, seq[0], groupLen);
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
function typePowerOf(typeStr, value, length) {
    switch (typeStr) {
        case CardType.ROCKET: return 1000;
        case CardType.BOMB: return 500 + value;
        case CardType.SINGLE: return value;
        case CardType.PAIR: return value + 20;
        case CardType.TRIPLE: return value + 40;
        case CardType.TRIPLE_WITH_SINGLE: return value + 60;
        case CardType.TRIPLE_WITH_PAIR: return value + 70;
        case CardType.STRAIGHT: return value + 80 + (length || 5);
        case CardType.STRAIGHT_PAIR: value = value + 90 + (length || 3); return value;
        case CardType.PLANE: return value + 100 + (length || 2) * 3;
        case CardType.PLANE_WITH_SINGLE: return value + 110 + (length || 2) * 3;
        case CardType.PLANE_WITH_PAIR: return value + 120 + (length || 2) * 3;
        case CardType.FOUR_WITH_TWO_SINGLE: return value + 110;
        case CardType.FOUR_WITH_TWO_PAIR: return value + 120;
        default: return value || 0;
    }
}
function minBeatPower(typeStr, value, length) {
    if (!typeStr || typeStr === CardType.ROCKET) return 0;
    if (typeStr === CardType.BOMB) return 500 + value + 1;
    return typePowerOf(typeStr, value + 1, length);
}
function getPlayPower(play) {
    if (!play) return 0;
    let type = getCardType(play);
    if (!type) return 0;
    return typePowerOf(type.type, type.value, type.length);
}
// typePowerOf 的结果缓存（同一牌型/牌值/长度组合反复出现）
const _POWER_CACHE = new Map();
function _cachedTypePower(type, value, length) {
    const key = type + ':' + value + ':' + (length || 0);
    let v = _POWER_CACHE.get(key);
    if (v === undefined) {
        v = typePowerOf(type, value, length);
        if (_POWER_CACHE.size > 2000) _POWER_CACHE.clear();
        _POWER_CACHE.set(key, v);
    }
    return v;
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
        remainBigCards: 3, hasRocket: 10, isLandlord: 5, isFarmer: 0,
        opponentHandCount: -1, partnerHandCount: 3, outsideBombCount: -5,
        isCritical: 40, needBeat: 25,
        // 新特征：保守先验（原本全为 0 → 出厂 AI 完全不看手数/控制/威胁）
        turnsToFinish: -4, sureTricks: 3, controlCount: 2, oppThreat: -1.5, isPartnerLead: 6,
        turnsDelta: 5, controlRetained: 4, partnerFit: 1, leadOppClose: 3, bombUrgency: 12
    },
    // 按角色分桶权重：地主要压制/速胜，农民要配合/抢跑，目标不同不能共用一套。
    // 这里只填「方向性差异」的小先验，其余键仍回落到全局 weights。
    weightsByRole: {
        landlord: { remainSingle: -2.5, needBeat: 8, controlCount: 1.5, oppThreat: -0.8 },
        farmer:   { partnerHandCount: 5, isPartnerLead: 10, oppThreat: -2.2, turnsToFinish: -1.5 }
    },
    evalCoeffs: {
        bomb: 50, triple: 10, pair: 3,
        bothJokers: 50, bigJokerOnly: 18, smallJokerOnly: 10,
        ace: 9, king: 7, queen: 5, straightLenFactor: 4,
        singlePenalty: -3, pairExtra: 2, tripleExtra: 3,
        bombOutsideBonus: 8, position2Bonus: 8, landlordBonus: 20
    },
    // 统一手牌潜力参数表：callDecision / 世界模型 / 残局估值 / 特征抽取
    // 四处此前各用一套公式，学习只调 weights → 其余三套永不进化。
    // 默认值与旧 evalCoeffs 结构分完全等价（数值不变），但集中到一处可学习。
    handPotentialCoeffs: {
        bomb: 50, triple: 10, pair: 3,
        bothJokers: 50, bigJokerOnly: 18, smallJokerOnly: 10,
        ace: 9, king: 7, queen: 5, two: 11, straightLenFactor: 4,
        singlePenalty: -3, pairExtra: 2, tripleExtra: 3,
        turnsPenalty: 3.5, bigCardBonus: 1.2
    },
    callThresholds: {
        easy: { one: 28 },
        medium: { one: 22, two: 32, three: 42 },
        hard: { one: 20, two: 30, three: 42, bombBonus: 20, bothJokersBonus: 20, singlePenaltyFactor: 3, positionBonus: 8 },
        grandmaster: { one: 20, two: 30, three: 42, bombBonus: 20, bothJokersBonus: 20, singlePenaltyFactor: 3, positionBonus: 8 },
        legendary: null
    },
    endgameThresholds: { legendary: 20, grandmaster: 20, hard: 18, medium: 9, easy: 7 },
    // ======================== 隐藏信息（Blind AI）参数 ========================
    // 公平性：AI 只使用公开信息（自己手牌 / 各家张数 / 已出牌 / 地主底牌），
    // 对手手牌一律不可见；搜索在采样出的"可能世界"里进行并跨世界聚合。
    blind: {
        enabled: true,
        // 各环节采样多少个可能世界（0 = 关闭该环节的世界采样）
        worlds: {
            endgame: { easy: 2, medium: 3, hard: 6, grandmaster: 8, legendary: 12 },
            mcts:    { easy: 0, medium: 0, hard: 3, grandmaster: 5, legendary: 6 },
            sim:     { easy: 0, medium: 0, hard: 2, grandmaster: 3, legendary: 4 },
            call:    { easy: 0, medium: 0, hard: 4, grandmaster: 6, legendary: 6 }
        },
        // 单次决策的时间预算（毫秒）
        endgameTimeBudgetMs: { easy: 120, medium: 200, hard: 1500, grandmaster: 2500, legendary: 6000 },
        mctsTimeBudgetMs:    { easy: 0, medium: 0, hard: 1800, grandmaster: 3000, legendary: 4500 },
        // 跨世界聚合的鲁棒系数：均值 − λ×标准差（压制"赌对手手牌"的走法）
        robustness: 0.25,
        // 自适应 MCTS 时间预算：候选少/局面简单时不必吃满固定预算，
        // 避免 legendary 在每个局面都固定消耗 4.5s。
        adaptiveMctsBudget: true,
        mctsMinBudgetMs: { hard: 250, grandmaster: 800, legendary: 2000 },
        mctsMsPerCandidate: { hard: 30, grandmaster: 100, legendary: 400 },
        // 领出被压概率的估计（样本数 / 权重 / 候选数）
        beatProbSamples:   { easy: 0, medium: 0, hard: 6, grandmaster: 8, legendary: 10 },
        beatProbWeight:    { easy: 0, medium: 0, hard: 10, grandmaster: 14, legendary: 18 },
        beatProbCandidates:{ easy: 0, medium: 0, hard: 4, grandmaster: 4, legendary: 5 },
        // 对手握炸概率的修正权重（对手很可能有炸时，降低我方用炸的优先级）
        bombRiskWeight: { easy: 0, medium: 0, hard: 40, grandmaster: 40, legendary: 40 },
        // 盲 MCTS 是否使用启发式根先验（1 = 开启）
        mctsRootPriors: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 },
        // 信念采样是否按「手牌形状」分配。
        // 实测：结构化(1)把未见牌池的整组塞给同一对手 → 采样对手平均 0.89 个炸弹、
        // 仅 1.83 张单张（真实约 0.07 炸 / 6 单），使所有胜率估计崩溃、AI 过度保守。
        // 默认改为均匀随机(0)；保留开关供 A/B 对照。
        structuredBelief: 0,
        // MCTS 模式：'pimc' = 每世界各搜一棵树再聚合；'ismcts' = 信息集共享树（再确定性化）
        mctsMode: 'pimc',
        // 每个世界采样多少个候选并按「与公开历史的一致性」择优（叫分/过牌线索）
        worldQuality: { easy: 1, medium: 2, hard: 3, grandmaster: 3, legendary: 4 },
        // 叫分模拟次数（传奇难度）
        callTrials: { hard: 20, grandmaster: 40, legendary: 80 },
        // 每个叫分试投采样的候选世界数；过大会让叫分阶段成为耗时热点
        callWorldQuality: 2
    },
    mcts: {
        ucbC: 1.4,
        rootBranch: 12, branch: 8,
        iterations: { legendary: 30000, grandmaster: 12000, hard: 1800, medium: 0, easy: 0 },
        handLimit: { legendary: 17, grandmaster: 14, hard: 12, medium: 0, easy: 0 },
        timeLimit: 4000,
        timeLimitByDiff: { legendary: 4000, grandmaster: 2500, hard: 1200 }
    },
    simulation: {
        depth: { legendary: 2, grandmaster: 1, hard: 1, medium: 0, easy: 0 },
        handLimit: { legendary: 17, grandmaster: 15, hard: 15, medium: 0, easy: 0 },
        dpBonusFactor: { legendary: 0.3 },
        oppSampleSize: { depth1: 8, depth2: 15 },
        maxCandidates: { legendary: 10, grandmaster: 10, hard: 10, medium: 0, easy: 0 },
        dpCandidates: { legendary: 6, grandmaster: 6, hard: 6, medium: 0, easy: 0 }
    },
    randomFactors: { legendary: 0, grandmaster: 0.05, hard: 0.1, medium: 0.2, easy: 0.5 },
    // 随机乱出概率：低难度会偶尔从全部候选中乱选一手，拉开与高档位的差距。
    // 关键局面（自己快赢/对手快赢）由 noRandom 保护，不会乱出。
    blunderFactor: { easy: 0.25, medium: 0.08, hard: 0, grandmaster: 0, legendary: 0 },
    playHeuristics: {
        partnerPlay: { handLe3: -320, handLe2: -600, lastPowerGe40: -80, lastPowerLe20: -50 },
        lordBeatPartner: { needBeat: 80, handLe4: 120 },
        farmerAssist: { partnerHandLe2PlayLe2: 60 },
        farmerBeatSmallSingle: { diffLe3: 40 },
        needBeatLastHighRemain: { lastPowerGe13: -40 },
        landlordLeadSingle: { le6: 20 },
        suppressSingle: { diffLe4: 70, diffLe7: 15, diffLe10: -45, diffGt10: -110 },
        suppressPair: { diffLe4: 55, diffLe7: 10, diffLe10: -40, diffGt10: -95 },
        farmerOppLowCards: { handLe6LastPowerLe10: 100 },
        farmerVsLord: { lastPowerLe8: 40, lastPowerLe11: 20 },
        landlordLeadLowPower: { powerLe6: 30, powerGe12: -40 },
        farmerLeadHigh: { powerGe12: -40, power1114PartnerLe4: -60 },
        bombUrgent: { oppAboutToWin: 150, landlordRemainLe4: 120, remainLe2: 200 },
        bombStrategic: { fewOutside: 40, rocketBonus: 30 },
        bombLead: { bomb: -800, rocket: -1600 },
        bombWasted: { lowLastPower: -120, highLastPower: -60, notCritical: -80 },
        nearWin: { remainLe3: 100 },
        kickerPenalty: { ge11: -60, ge13: -100, hasSmallerAlternative: -120 },
        overkill: { singleLe12: -250, pairLe10: -200 }
    },
    overshoot: { weight: 0.6, max: 80, curve: 0.8 },
    comboControl: {
        tripleHigh: -45, tripleWithHigh: -70, quadHigh: -60, planeHigh: -40,
        leadHighSingle: -30, leadHighPair: -25, endgameExempt: 4
    },
    leadAdjust: {
        // 农民下一位就是地主时，不要把 ≤3 这种“白送控制权”的单张直接喂出去
        farmerTinySingleVsLandlord: 320,
        // 终局炸弹/王炸领出奖励（不再是绝对死规则）
        bombLeadLate: { bomb: 20, rocket: 30 }
    },
    passScores: {
        farmerPartnerBase: 180, farmerPartnerHandLe3: -80, farmerPartnerHandLe2: 500, farmerPartnerHandLe1: 200,
        lordHandLe2: -999, lordHandLe4: -150, lordHandGt4: -10,
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
        rocket: 60, bomb: 50, straight: 25, straightLenFactor: 1,
        straightPair: 25, straightPairLenFactor: 2, tripleWith: 20,
        plane: 40, planeLenFactor: 3, planeWith: 30,
        pair: 5, triple: 8, single: -5, completeBonus: 100
    },
    heuristicPlayout: {
        bestProb: 0.80, top2Prob: 0.95, stepLimit: 90,
        // rollout 里做「完整启发式精排」的候选数。
        // 越大 → rollout 越像根评估（搜索信号越同质化、越慢）。
        // 实测：8 比 4 强（把精排候选砍到 4 会让 rollout 明显变弱），
        // 所以默认值保持 8；提速靠缓存，不靠削弱 rollout。
        richCandidates: 8,
        // 难度档位：高档位 rollout 精排更多候选，低档位更粗糙
        richCandidatesByDiff: { easy: 4, medium: 6, hard: 8, grandmaster: 10, legendary: 16 },
        // rollout 里每个底牌组合最多派生多少个组合牌型（0 = 不限）
        maxComboPerGroup: 0
    },
    endgame: {
        maxDepth: 20, bombDepthPenalty: 1,
        maxTotalCards: 24, maxHandCards: 20, maxOptions: 10,
        nodeLimit: 200000, timeBudgetMs: 700
    },
    // ======================== 搜索预算模式 ========================
    // deterministic = true 时，搜索只用「节点数 / 迭代数」预算，不看挂钟。
    // 用途：离线评测（A/B 配对自对弈）必须可复现，否则任何增益都测不出来。
    // 运行时（浏览器对局）保持 false，用时间预算换取强度。
    search: {
        deterministic: false,
        // 离线评测可设 true：确定性模式下按难度保留 MCTS 迭代数/世界数差异。
        // 为避免 legendary(30000 迭代×6 世界) 把评测拖垮，再乘 difficultyBudgetScale。
        useDifficultyBudgets: false,
        difficultyBudgetScale: 0.01,
        minDifficultyIterations: 100,
        // 以下三项只在确定性模式（离线评测）下生效。
        // 默认值刻意取小：评测要跑几十上百局，预算太大单局就要好几秒。
        // 注意：nodeBudget 是「本次残局求解的总节点数」，不是每候选的。
        // nodeBudget 是「本次残局求解的总节点数」。
        // 旧值 1200 分给 8候选×6世界 → 每单元 25（下限 40）节点，残局 minimax
        // 实际退化成静态评估。20000 让每个单元有 ~400 节点，能搜到 2~3 层。
        nodeBudget: 20000,
        mctsIterations: 40,
        mctsWorlds: 1
    },
        aiTiming: {
            thinkingSeconds: { legendary: 8, grandmaster: 6, hard: 4, medium: 2, easy: 2 },
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
        // 对手个体化：记录各玩家在需要跟牌时选择过牌的上下文（公开信息，仅用于收窄信念）
        this.passHints = [[], [], []];
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
            // 只统计「真正第一次出现」的牌：同一张牌被重复记录（引擎 bug / 重放）不应
            // 让 totalCardsPlayed 虚增，否则记牌器与实际牌局会永久不一致。
            const fresh = cards.filter(c => !this.seen.has(c.id));
            this.playerHistory[playerId].push(cards.map(c=>c.id));
            this.totalCardsPlayed[playerId] += fresh.length;
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
    // 记录某玩家在需要跟牌时选择过牌（仅记录公开的上下文，不窥视手牌）
    recordPass(playerId, ctx) {
        if (playerId < 0 || playerId > 2 || !ctx) return;
        this.passHints[playerId].push({ type: ctx.type, value: ctx.value, length: ctx.length || 0, ts: Date.now() });
        // 保留最近 60 条，避免无限增长
        if (this.passHints[playerId].length > 60) this.passHints[playerId].shift();
    }
    // 从某玩家已出的牌型统计行为画像（全部是公开历史）：
    //  · highCardRate : 出过大牌(≥12)的次数 / 总出牌手数
    //  · comboRate    : 出过组合牌(≥3张)的次数 / 总手数（结构倾向）
    //  · bombCount    : 出过的炸/王炸次数（消耗了多少控制牌）
    //  · lastHighValue: 最近一次出的最大点数（推断"敢出这么大"）
    //  · passRate     : 需要跟牌时选择 pass 的比例（保守度）
    getPlayerProfile(oppId) {
        const empty = { highCardRate: 0, comboRate: 0, bombCount: 0, lastHighValue: 0, passRate: 0, plays: 0 };
        if (!this.playerHistory || !this.playerHistory[oppId]) return empty;
        if (!MasterMemory._idToCard) {
            MasterMemory._idToCard = new Map();
            for (const c of allCards()) MasterMemory._idToCard.set(c.id, c);
        }
        const map = MasterMemory._idToCard;
        const hist = this.playerHistory[oppId] || [];
        let high = 0, combo = 0, bombs = 0, lastHigh = 0;
        for (const ids of hist) {
            if (!Array.isArray(ids) || !ids.length) continue;
            const cards = ids.map(id => map.get(id)).filter(Boolean);
            if (!cards.length) continue;
            if (cards.length >= 3) combo++;
            if (cards.some(c => c.value >= 12)) high++;
            const maxV = Math.max(...cards.map(c => c.value));
            if (maxV > lastHigh) lastHigh = maxV;
            const t = getCardType(cards);
            if (t && (t.type === CardType.BOMB || t.type === CardType.ROCKET)) bombs++;
        }
        const passHints = (this.passHints && this.passHints[oppId]) || [];
        const totalDecisions = hist.length + passHints.length;
        return {
            highCardRate: hist.length ? high / hist.length : 0,
            comboRate: hist.length ? combo / hist.length : 0,
            bombCount: bombs, lastHighValue: lastHigh,
            passRate: totalDecisions ? passHints.length / totalDecisions : 0,
            plays: hist.length
        };
    }
    // 获取某对手在指定点数附近曾 pass 过的次数（用于降低其持有该区间大牌的概率）
    passHintsNear(oppId, value, within = 2) {
        if (!this.passHints[oppId]) return 0;
        let n = 0;
        for (const h of this.passHints[oppId]) {
            if (Math.abs(h.value - value) <= within) n++;
        }
        return n;
    }
}

// ======================== 设备速度标定（移动端自动降档） ========================
// 用 AI 自身最典型的计算（枚举一手 17 张牌的所有合法出牌）做一次轻量基准，
// 估算当前设备相对基准机的速度；AI 的时间预算按此比例缩放：
//   桌面 ≈ 1.0（预算不变）；中端手机 ≈ 0.4；低端机 ≈ 0.15
// 目的：移动端既不会因为算太久而"卡住不动"，也不会被看门狗判超时而丢弃着法。
const AI_PERF = { factor: 1, calibrated: false, refMs: 0 };
function setAiPerfOverride(value) {
    try {
        if (typeof globalThis === 'undefined') return;
        const auto = value === null || value === undefined || value === '' || value === 'auto';
        if (auto) {
            delete globalThis.__aiPerfOverride;
            AI_PERF.calibrated = false;
            return;
        }
        const n = Number(value);
        if (!Number.isFinite(n)) return;
        const v = Math.max(0.1, Math.min(2.5, n));
        globalThis.__aiPerfOverride = v;
        AI_PERF.factor = v;
        AI_PERF.calibrated = true;
    } catch (e) {}
}
function _calibrationHand() {
    // 固定的一手 17 张牌（覆盖各种牌型），保证每次标定的负载一致
    const defs = [['3',0],['3',0],['4',1],['5',2],['6',3],['7',4],['8',5],['9',6],['10',7],
        ['J',8],['Q',9],['K',10],['A',11],['2',12],['2',12],['小王',13],['大王',14]];
    const suits = ['♠','♥','♣','♦'];
    return defs.map((d, i) => ({ suit: suits[i % 4], rank: d[0], value: d[1], id: suits[i % 4] + d[0] + (i > 13 ? '_' + i : '') }));
}
function calibrateAiSpeed(force) {
    if (AI_PERF.calibrated && !force) return AI_PERF.factor;
    if (typeof globalThis !== 'undefined' && globalThis.__aiPerfOverride !== undefined) {
        AI_PERF.factor = globalThis.__aiPerfOverride;
        return AI_PERF.factor;
    }
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
// 超几何分布：从大小 poolSize 的牌池里取 slots 张，其中来自 avail 张指定牌的
// 数量 ≥ k 的概率。用于解析式计算"对手能否压过"（比采样又快又稳）。
function _hyperAtLeast(avail, poolSize, slots, k) {
    if (k <= 0) return 1;
    if (avail <= 0 || slots <= 0 || poolSize <= 0) return 0;
    if (slots > poolSize) return 0;
    if (poolSize - avail < slots - k) return 1;   // 必含
    const denom = comb(poolSize, slots);
    if (!denom) return 0;
    let p = 0;
    const maxTake = Math.min(avail, slots);
    for (let take = k; take <= maxTake; take++) {
        p += comb(avail, take) * comb(poolSize - avail, slots - take);
    }
    return p / denom;
}
function _hyperAtMost(avail, max, poolSize, slots) {
    if (max < 0) return 0;
    if (max >= slots) return 1;
    return 1 - _hyperAtLeast(avail, poolSize, slots, max + 1);
}

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
        const ownKeys = new Set(this.ownHand.map(c => (c.suit || '') + '|' + (c.rank !== undefined ? c.rank : c.value)));
        // 地主底牌是公开信息：地主确定后所有人都知道这 3 张在谁手里
        this.knownByPlayer = [[], [], []];
        const lordCards = state.lordCards || [];
        const lordHasBottom = this.landlord >= 0 && (this.phase === 'playing' || this.counts[this.landlord] >= 20);
        if (lordHasBottom) for (const c of lordCards) if (!ownIds.has(c.id)) this.knownByPlayer[this.landlord].push({ ...c });
        const knownIds = new Set();
        for (const list of this.knownByPlayer) for (const c of list) knownIds.add(c.id);

        // 地主底牌若已被打出，不能继续作为"手中已知牌"进入世界采样
        if (memory && memory.seen) {
            const playedRaw = new Set(memory.seen);
            for (let i = 0; i < 3; i++) {
                if (this.knownByPlayer[i]) {
                    this.knownByPlayer[i] = this.knownByPlayer[i].filter(c => !playedRaw.has(c.id));
                }
            }
            knownIds.clear();
            for (const list of this.knownByPlayer) for (const c of list) knownIds.add(c.id);
        }

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
            if (ownKeys.has((c.suit || '') + '|' + (c.rank !== undefined ? c.rank : c.value))) continue;
            pool.push(c);
        }
        // 牌池不足以填满对手手牌（记牌器滞后）→ 从"已打出"里回收，保持世界划分完整
        // 注意：回收的牌其实是"已经打出去的"，塞进对手手里会让世界失真。
        // 这里记录回收数量，在世界评分里降权（而不是硬塞完事）。
        let recycleCount = 0;
        if (pool.length < oppNeed) {
            const arr = [...playedSet];
            while (pool.length < oppNeed && arr.length > 0) {
                const id = arr.pop();
                playedSet.delete(id);
                const card = allCards().find(c => c.id === id);
                if (card) { pool.push(card); recycleCount++; }
            }
        }
        this.playedIds = playedSet;
        this.pool = pool;
        this.poolCounts = new Array(15).fill(0);
        for (const c of pool) this.poolCounts[c.value]++;
        this.recycleCount = recycleCount;
        // 对手个体化线索：各对手曾在需要跟牌时 pass 过的上下文（公开信息）
        this.passHints = memory && memory.passHints ? memory.passHints : [[], [], []];
        // 出牌历史画像（公开信息）：谁出过大牌/组合牌/炸弹、谁爱过牌
        this.playerProfiles = [0, 1, 2].map(i => (memory && memory.getPlayerProfile)
            ? memory.getPlayerProfile(i) : null);
        // 叫分顺序（公开信息）：最后叫分者的牌力信号强于第一个叫分者
        this.callOrder = (state.callOrder && state.callOrder.length === 3)
            ? state.callOrder.slice() : null;
        // 跨局真人风格（公开行为统计，单机模式才有）：激进/保守/爱炸弹
        this.humanStyle = (state.humanStyle && state.humanStyle.games >= 3) ? state.humanStyle : null;
        this.memory = memory;

        // ======================== 公开历史线索 ========================
        // 叫分是公开信息：叫分越高牌力通常越强（多半有炸/王炸/大对子）。
        // 旧的世界模型完全没用这条线索 —— 明明知道谁叫了 3 分，却照样把炸弹
        // 随机发给任何对手，白白浪费了大量可推断信息。
        this.callScores = (state.callScores && state.callScores.length === 3) ? state.callScores.slice() : [0, 0, 0];
        this.bidStrength = [0, 0, 0];
        this.maxBid = 0;
        for (let i = 0; i < 3; i++) {
            const b = this.callScores[i] || 0;
            if (b > this.maxBid) this.maxBid = b;
        }
        for (let i = 0; i < 3; i++) {
            const b = this.callScores[i] || 0;
            this.bidStrength[i] = b >= 3 ? 2 : (b === 2 ? 1 : 0);
        }
        if (this.landlord >= 0) this.bidStrength[this.landlord] = 2;
    }

    // 采样一个"可能世界"：自己的手牌精确，对手手牌按未见牌池分配（保留地主底牌归属）
    //
    // 关键：**按「手牌形状」采样，而不是把牌逐张随机撒出去**。
    // 均匀随机撒牌造出的"对手"几乎全是散牌（12 张 12 个点数），
    // 于是：
    //   · 对手几乎接不住任何牌 → 搜索严重高估自己的控制权 → 乱出大牌
    //   · 对手几乎不可能有炸弹 → 炸弹风险估计失真
    // 真实手牌是对子/三张/顺子成团的。这里按点数分组、整组优先分配，
    // 让采样出的手牌在结构上接近真实牌局。
    //
    // quality > 1 时：生成多个候选并按「与公开历史的一致性」择优（见 _worldLikelihood）。
    // 这是纯公开信息（叫分 / 过牌上下文 / 已打出的牌）驱动的推断，不违反公平性红线。
    sampleWorld(quality) {
        const tries = Math.max(1, quality || 1);
        if (tries === 1) return this._sampleWorldStructured();
        // softmax 加权随机抽样（温度 T=4）：argmax 会让所有世界塌到同一个似然模式，
        // 跨世界方差消失 → PIMC 的 std 惩罚与 minimax-regret 失去信号。
        const cands = [];
        let maxS = -Infinity;
        for (let i = 0; i < tries; i++) {
            const w = this._sampleWorldStructured();
            const sc = this._worldLikelihood(w);
            cands.push({ w, sc });
            if (sc > maxS) maxS = sc;
        }
        const weights = cands.map(c => Math.exp((c.sc - maxS) / 4));
        const sum = weights.reduce((a, b) => a + b, 0);
        let r = Math.random() * sum;
        for (let i = 0; i < cands.length; i++) {
            r -= weights[i];
            if (r <= 0) return cands[i].w;
        }
        return cands[cands.length - 1].w;
    }
    _sampleWorldStructured() {
        const players = [[], [], []];
        players[this.playerId] = this.ownHand.map(c => ({ ...c }));
        // 结构化采样开关：1 = 按手牌形状分配（默认，更接近真实牌局）
        //                  0 = 逐张均匀随机（旧行为，仅用于 A/B 对照）
        if (cfg('blind.structuredBelief') === 0) return this._sampleWorldUniform();
        const oppIds = [];
        for (let i = 0; i < 3; i++) if (i !== this.playerId) oppIds.push(i);
        // 处理顺序随机化：否则「先被处理的那个对手」会系统性地拿到更合适的牌组，
        // 造成座位偏置（750 局 A/B 实测该偏置存在）。
        for (let i = oppIds.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = oppIds[i]; oppIds[i] = oppIds[j]; oppIds[j] = t;
        }
        const need = [0, 0, 0];
        for (const i of oppIds) {
            players[i] = this.knownByPlayer[i].map(c => ({ ...c }));
            need[i] = Math.max(0, this.counts[i] - players[i].length);
        }
        // 未见牌池按点数分组
        const groups = new Map();
        for (const c of this.pool) {
            let g = groups.get(c.value);
            if (!g) { g = []; groups.set(c.value, g); }
            g.push(c);
        }
        const groupList = [...groups.values()];
        for (let i = groupList.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = groupList[i]; groupList[i] = groupList[j]; groupList[j] = t;
        }
        // 第一轮：整组分配（能装下就整组给同一个人 → 形成对子/三张）
        let progress = true;
        while (progress) {
            progress = false;
            for (const opp of oppIds) {
                if (need[opp] <= 0) continue;
                let picked = -1;
                for (let gi = 0; gi < groupList.length; gi++) {
                    if (groupList[gi].length <= need[opp]) { picked = gi; break; }
                }
                if (picked < 0) continue;
                const grp = groupList.splice(picked, 1)[0];
                for (const c of grp) players[opp].push(c);
                need[opp] -= grp.length;
                progress = true;
            }
        }
        // 第二轮：剩下的组按剩余容量拆分（少量散牌是真实的）
        for (const grp of groupList) {
            for (const c of grp) {
                let placed = false;
                for (const opp of oppIds) {
                    if (need[opp] > 0) { players[opp].push(c); need[opp]--; placed = true; break; }
                }
                if (!placed) break;
            }
        }
        for (let i = 0; i < 3; i++) {
            if (i === this.playerId) continue;
            players[i].sort((a, b) => a.value - b.value);
        }
        return players;
    }
    // 逐张均匀随机（旧行为）。保留用于 A/B 对照与回归基线。
    _sampleWorldUniform() {
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
    // 采样 n 个可能世界：按「与公开历史的一致性」择优。
    // 旧实现是 n 个完全独立的随机世界 —— 里面有大量与已观察到的叫分/过牌行为
    // 明显矛盾的世界（例如叫了 3 分的对手手里一把散牌）。
    sampleWorlds(n) {
        const want = Math.max(1, n || 1);
        const tries = Math.min(want + 16, want * 5);
        const cands = [];
        let maxS = -Infinity;
        for (let i = 0; i < tries; i++) {
            const w = this._sampleWorldStructured();
            const sc = this._worldLikelihood(w);
            cands.push({ players: w, sc });
            if (sc > maxS) maxS = sc;
        }
        // 按似然权重无放回抽样：既偏向高似然世界，又保留世界间方差。
        // 旧实现取 top-k，系统性压低 std，使 -λ·std 鲁棒项失效。
        const out = [];
        const pool = cands.slice();
        while (out.length < want && pool.length) {
            const ws = pool.map(c => Math.exp((c.sc - maxS) / 4));
            const sum = ws.reduce((a, b) => a + b, 0);
            let r = Math.random() * sum, idx = pool.length - 1;
            for (let i = 0; i < pool.length; i++) {
                r -= ws[i];
                if (r <= 0) { idx = i; break; }
            }
            out.push(pool[idx].players);
            pool.splice(idx, 1);
        }
        return out;
    }
    // 手牌牌力（用于与叫分档位对照）：只依赖点数结构，不看花色
    _handStrengthScore(hand) {
        // 与 evaluateHandStrength 共用同一张可学习参数表（旧实现是独立的硬编码公式）
        return handPotential(hand) * 0.6;
    }
    // 给一个采样世界打分：公开历史越吻合分越高（纯公开信息推断）
    _worldLikelihood(worldPlayers) {
        let score = 0;
        const oppIds = [];
        for (let i = 0; i < 3; i++) if (i !== this.playerId) oppIds.push(i);
        // 1) 叫分档位 ↔ 实际牌力 的秩一致性
        const entries = oppIds.map(id => ({
            id,
            tier: this.bidStrength[id],
            s: this._handStrengthScore(worldPlayers[id] || [])
        }));
        // 1) 叫分档位 ↔ 牌力的软单调似然：同 tier 不互为参照（旧实现逐位比较产生 +8/−4 纯噪声）
        let sMin = Infinity, sMax = -Infinity;
        for (const e of entries) { if (e.s < sMin) sMin = e.s; if (e.s > sMax) sMax = e.s; }
        const span = sMax - sMin || 1;
        for (const e of entries) {
            const z = (e.s - sMin) / span;
            // 最后叫分的人，其叫分是"看过前面人叫分后"的决定 → 信号更强
            let orderWeight = 1;
            if (this.callOrder && this.callOrder.length === 3) {
                const pos = this.callOrder.indexOf(e.id);
                orderWeight = 1 + Math.max(0, pos) * 0.5;   // 第1叫=1.0, 第2叫=1.5, 第3叫=2.0
            }
            score += e.tier * (2 * z - 1) * 4 * orderWeight;
        }
        // 2) 叫高分者通常握着"控制牌"（炸/王/多个2），但不再是硬条件，按张数软加分
        for (const id of oppIds) {
            if (this.bidStrength[id] < 2) continue;
            const hand = worldPlayers[id] || [];
            const cnt = new Array(15).fill(0);
            for (const c of hand) cnt[c.value]++;
            let controls = 0;
            for (let v = 0; v <= 12; v++) if (cnt[v] >= 4) controls += 2;
            if (cnt[13] > 0 && cnt[14] > 0) controls += 2;
            for (let v = 12; v <= 14; v++) controls += cnt[v] >= 2 ? 1 : 0;
            score += Math.min(6, controls * 2);
        }
        // 3) 过牌一致性：对手 pass 过的高牌，他手里通常没有同区间的大单张
        for (const id of oppIds) {
            const hints = this.passHints[id] || [];
            if (!hints.length) continue;
            const hand = worldPlayers[id] || [];
            const cnt = new Array(15).fill(0);
            for (const c of hand) cnt[c.value]++;
            for (const h of hints) {
                if (!h) continue;
                const v = h.value;
                let violations = 0;
                if (h.type === CardType.SINGLE) {
                    for (let x = v + 1; x <= 14; x++) if (cnt[x] === 1) violations++;
                } else if (h.type === CardType.PAIR || h.type === CardType.TRIPLE) {
                    const need = h.type === CardType.PAIR ? 2 : 3;
                    for (let x = v + 1; x <= 14; x++) if (cnt[x] >= need) violations++;
                } else if (h.type === CardType.BOMB || h.type === CardType.ROCKET) {
                    // 对手 pass 过炸弹 → 他手里大概率没有能压的炸/王炸
                    for (let x = 0; x <= 14; x++) if (cnt[x] >= 4) violations++;
                    if (cnt[13] > 0 && cnt[14] > 0) violations++;
                }
                // 组合牌(顺子/连对/飞机)的 pass 较复杂，跳过避免误判
                score -= Math.min(4, violations * 0.5);
            }
        }
        // 4) 出牌历史画像（结构倾向一致性）：
        //    历史 comboRate 高的对手 → 采样世界中其手牌也应有更多连续结构（成团）；
        //    历史 highCardRate 高 → 手里控牌倾向更强。只做温和调整，避免过拟合。
        for (const id of oppIds) {
            const prof = this.playerProfiles && this.playerProfiles[id];
            if (!prof || !prof.plays) continue;
            const hand = worldPlayers[id] || [];
            const f = extractHandFeatures(hand);
            const structure = f.pair + f.triple + f.bomb + (f.maxStraightLen >= 5 ? 1 : 0);
            const comboNow = hand.length ? Math.min(1, structure / 4) : 0;
            score += (prof.comboRate - 0.3) * (comboNow - 0.5) * 6;
            // 出过炸弹的对手手里控制牌少（已被消耗）→ 降低其握炸先验，
            // 但 bombRiskFor 已按 seen 剔除，这里只做很轻的风格修正
            if (prof.bombCount >= 1) score -= 0.5;
        }
        // 5) 跨局真人风格适应（仅单机、games≥3 才生效，公开行为统计）：
        //    真人历史过牌多 → 采样世界里其牌力偏弱；爱炸弹 → 控牌偏多。
        if (this.humanStyle) {
            const hs = this.humanStyle;
            const oppIdsHere = oppIds.filter(i => i !== this.playerId && i === 0);
            for (const id of oppIdsHere) {
                // 真人风格只作用于真人座位（单机固定为 0），不污染 AI 队友的信念
                const hand = worldPlayers[id] || [];
                const str = this._handStrengthScore(hand);
                const wantWeak = (hs.passRate || 0.3) - 0.3;      // >0 表示偏保守
                score -= wantWeak * str * 0.08;
                const wantControl = (hs.bombRate || 0.05) - 0.05; // >0 表示爱炸弹
                const f = extractHandFeatures(hand);
                score += wantControl * (f.bomb + f.hasRocket * 2) * 6;
            }
        }
        // 6) 记牌器滞后导致回收已打出的牌 → 世界本身不可信，降权
        score -= this.recycleCount * 0.5;
        return score;
    }
    // 某对手握有炸弹的概率：结合"未见牌池"与"地主底牌已明确归属该对手"的信息。
    // 对每个点数，按超几何分布计算该对手至少拿到 4 张的概率；已知底牌直接减少所需张数。
    bombRiskFor(oppId) {
        const n = this.counts[oppId] || 0;
        const known = this.knownByPlayer[oppId] || [];
        const knownCounts = new Array(15).fill(0);
        for (const c of known) knownCounts[c.value]++;
        const unknownSlots = n - known.length;
        const poolSize = this.pool.length;
        if (unknownSlots <= 0 || poolSize <= 0) {
            for (let v = 0; v <= 12; v++) if (knownCounts[v] >= 4) return 1;
            return 0;
        }
        let risk = 0;
        for (let v = 0; v <= 12; v++) {
            const need = Math.max(0, 4 - knownCounts[v]);
            if (need <= 0) return 1;
            const available = this.poolCounts[v] || 0;
            if (available < need) continue;
            let hit = 0;
            const maxTake = Math.min(available, unknownSlots);
            for (let take = need; take <= maxTake; take++) {
                hit += comb(available, take) * comb(poolSize - available, unknownSlots - take);
            }
            const denom = comb(poolSize, unknownSlots);
            if (denom) risk += hit / denom;
        }
        // 对手曾在高点区 pass 过，说明其手中大牌较少，下调握炸概率
        let passDiscount = 1.0;
        // 旧实现逐点数调用 passHintsNear，同一次 pass 被计最多 5 次 → 风险砍到 0.6。
        // 改为按 pass 事件去重：只统计"对手在高点数(≥10)跟牌时 pass"的次数。
        const hints = (this.memory && this.memory.passHints) ? this.memory.passHints[oppId] || [] : [];
        for (const h of hints) {
            if (h && h.value >= 10) passDiscount -= 0.08;
        }
        passDiscount = Math.max(0.5, passDiscount);
        passDiscount = Math.max(0.3, passDiscount);
        return Math.min(1, risk * passDiscount);
    }
    // 某对手握有王炸的概率（已知底牌中的大小王同样计入）
    rocketRiskFor(oppId) {
        const n = this.counts[oppId] || 0;
        const known = this.knownByPlayer[oppId] || [];
        let knownSmall = 0, knownBig = 0;
        for (const c of known) {
            if (c.value === 13) knownSmall++;
            if (c.value === 14) knownBig++;
        }
        if (knownSmall >= 1 && knownBig >= 1) return 1;
        const unknownSlots = n - known.length;
        const poolSize = this.pool.length;
        if (unknownSlots <= 0 || poolSize <= 0) return 0;
        const needSmall = knownSmall >= 1 ? 0 : 1;
        const needBig = knownBig >= 1 ? 0 : 1;
        const need = needSmall + needBig;
        if (need === 0) return 1;
        if (need === 1) {
            const value = needSmall ? 13 : 14;
            if ((this.poolCounts[value] || 0) < 1) return 0;
            return Math.min(1, comb(poolSize - 1, unknownSlots - 1) / comb(poolSize, unknownSlots));
        }
        if ((this.poolCounts[13] || 0) < 1 || (this.poolCounts[14] || 0) < 1) return 0;
        return Math.min(1, comb(poolSize - 2, unknownSlots - 2) / comb(poolSize, unknownSlots));
    }
    // 估计某对手能压过 play 的概率。
    //
    // 解析式（单/对/三/炸/王）比采样式又快又稳：采样式每次都要生成完整世界
    // 并跑一遍 getAllValidPlays（对 17 张手牌很贵），而且 10 个样本的方差极大。
    // 这里用未见牌池上的超几何分布直接算；顺子/连对/飞机等组合型仍走采样兜底。
    beatProbability(play, oppId, samples) {
        const type = getCardType(play);
        if (!type) return 0;
        let base = -1;
        if (type.type === CardType.ROCKET) return 0;
        if (type.type === CardType.SINGLE || type.type === CardType.PAIR || type.type === CardType.TRIPLE ||
            type.type === CardType.TRIPLE_WITH_SINGLE || type.type === CardType.TRIPLE_WITH_PAIR ||
            type.type === CardType.BOMB) {
            base = this._analyticBeatProb(type, oppId);
        }
        if (base < 0) base = this._sampledBeatProb(type, oppId, samples);
        // 对手曾在该点数区间 pass 过，降低其能压过的概率（公开行为约束信念）
        let hintPenalty = 0;
        const hints = this.passHints[oppId] || [];
        const pv = type.value;
        for (const h of hints) {
            if (type.type === CardType.SINGLE && h.type === 'single' && h.value >= pv) hintPenalty += 0.12;
            if ((h.type === 'bomb' || h.type === 'rocket') && type.type !== CardType.ROCKET) hintPenalty += 0.08;
        }
        return Math.max(0, Math.min(1, base - Math.min(0.5, hintPenalty)));
    }
    // 解析式：对手从未见牌池里随机拿 u 张牌，其中能凑出压过 type 的牌型的概率
    _analyticBeatProb(type, oppId) {
        const n = this.counts[oppId] || 0;
        const known = this.knownByPlayer[oppId] || [];
        const knownCounts = new Array(15).fill(0);
        for (const c of known) knownCounts[c.value]++;
        const unknownSlots = n - known.length;
        const poolSize = this.pool.length;
        if (unknownSlots <= 0 || poolSize <= 0) return 0;
        const pool = this.poolCounts;
        // 单张：至少一张比 value 大的牌
        if (type.type === CardType.SINGLE) {
            let higher = 0, leq = 0;
            for (let v = 0; v <= 14; v++) {
                if (v > type.value) higher += pool[v];
                else leq += pool[v];
            }
            if (higher <= 0) return 0;
            // 已知牌里已经有的更大牌也算
            for (let v = type.value + 1; v <= 14; v++) if (knownCounts[v] > 0) return 1;
            // 正确：至少抽到 1 张「比它大」的牌。旧代码写成 1−P(至少一张≤它)，
            // 实际算的是"全部未知牌都比它大" → 41× 低估，领出修正与 macro-pass 对单张失效。
            return _hyperAtLeast(higher, poolSize, unknownSlots, 1);
        }
        // 对子 / 三张 / 炸弹：存在一个更大点数凑够 k 张
        if (type.type === CardType.PAIR || type.type === CardType.TRIPLE || type.type === CardType.BOMB) {
            const need = type.type === CardType.PAIR ? 2 : (type.type === CardType.TRIPLE ? 3 : 4);
            // 对三带一/三带二：本体是三张，对手需要更大的三张（翅膀好找，忽略）
            let noBeat = 1;
            let anyKnown = false;
            for (let v = type.value + 1; v <= 14; v++) {
                if (knownCounts[v] >= need) return 1;
                const avail = pool[v] || 0;
                if (avail < need) continue;
                // P(该点数在对手手里 < need 张)
                const pLess = _hyperAtMost(avail, need - 1, poolSize, unknownSlots);
                noBeat *= pLess;
            }
            if (type.type === CardType.BOMB) {
                // 对手有王炸也能压炸弹
                const sAvail = pool[13] || 0, bAvail = pool[14] || 0;
                const sKnown = knownCounts[13] > 0, bKnown = knownCounts[14] > 0;
                if (sKnown && bKnown) return 1;
                let rocketProb = 0;
                if (sAvail > 0 && bAvail > 0) {
                    if (sKnown) rocketProb = _hyperAtLeast(bAvail - 1, poolSize - 1, unknownSlots, 1);
                    else if (bKnown) rocketProb = _hyperAtLeast(sAvail - 1, poolSize - 1, unknownSlots, 1);
                    else rocketProb = _hyperAtLeast(poolSize - 2, poolSize, unknownSlots, 2);
                }
                return Math.max(1 - noBeat, rocketProb);
            }
            return 1 - noBeat;
        }
        // 三带一 / 三带二：需要更大的三张（翅膀通常够）
        if (type.type === CardType.TRIPLE_WITH_SINGLE || type.type === CardType.TRIPLE_WITH_PAIR) {
            let noBeat = 1;
            for (let v = type.value + 1; v <= 14; v++) {
                if (knownCounts[v] >= 3) return 1;
                const avail = pool[v] || 0;
                if (avail < 3) continue;
                noBeat *= _hyperAtMost(avail, 2, poolSize, unknownSlots);
            }
            return 1 - noBeat;
        }
        return -1;
    }
    // 采样兜底（顺子/连对/飞机等组合型）
    _sampledBeatProb(type, oppId, samples) {
        let hit = 0, total = 0;
        const n = Math.max(1, samples || 4);
        for (let s = 0; s < n; s++) {
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

// 在冻结参考参数下执行 fn（反事实标签生成用）
function _withRefParams(refParams, fn) {
    const prev = globalThis.__aiRefParams;
    globalThis.__aiRefParams = refParams || null;
    try { return fn(); }
    finally { globalThis.__aiRefParams = prev; }
}

// ======================== 手牌分析 ========================
// 手牌特征只取决于点数多重集 → 用点数计数签名做缓存键。
// 这个函数在搜索里被调用极多次（每个候选 × 每个 rollout 步），缓存收益很大。
const _HAND_FEATURES_CACHE = new Map();
const _HAND_FEATURES_CACHE_MAX = 3000;
function extractHandFeatures(hand) {
    if (!hand || !hand.length) {
        return { single:0, pair:0, triple:0, bomb:0, maxStraightLen:0, maxStraightPairLen:0, bigCards:0, hasRocket:0, total:0 };
    }
    const sig = _cardTypeSignature(hand);
    const hit = _HAND_FEATURES_CACHE.get(sig);
    if (hit) return Object.assign({}, hit);
    const feats = _extractHandFeaturesUncached(hand);
    if (_HAND_FEATURES_CACHE.size >= _HAND_FEATURES_CACHE_MAX) _HAND_FEATURES_CACHE.clear();
    _HAND_FEATURES_CACHE.set(sig, feats);
    return Object.assign({}, feats);
}
function _extractHandFeaturesUncached(hand) {
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

// ======================== 统一手牌潜力 ========================
// 四套旧公式（evaluateHandStrength / HandBelief._handStrengthScore /
// _staticEvalHands / extractHandFeatures）此前各自为政，学习闭环只调 weights，
// 其余永不进化。这里把「结构分」集中成一个函数 + 一张参数表；
// 各调用方只保留自己的上下文修正（记牌器/角色/值域缩放）。
const _HAND_POTENTIAL_CACHE = new Map();
const _HAND_POTENTIAL_CACHE_MAX = 2000;
function handPotential(hand) {
    if (!hand || !hand.length) return 0;
    const sig = _cardTypeSignature(hand);
    const hit = _HAND_POTENTIAL_CACHE.get(sig);
    if (hit !== undefined) return hit;
    const c = cfg('handPotentialCoeffs');
    const f = extractHandFeatures(hand);
    let score = 0;
    score += f.bomb * c.bomb + f.triple * c.triple + f.pair * c.pair;
    if (f.hasRocket) score += c.bothJokers;
    else {
        if (hand.some(x => x.value === 14)) score += c.bigJokerOnly;
        if (hand.some(x => x.value === 13)) score += c.smallJokerOnly;
    }
    score += hand.filter(x => x.value === 12).length * c.two;
    score += hand.filter(x => x.value === 11).length * c.ace;
    score += hand.filter(x => x.value === 10).length * c.king;
    score += hand.filter(x => x.value === 9).length * c.queen;
    score += f.maxStraightLen * c.straightLenFactor;
    score += f.single * c.singlePenalty + f.pair * c.pairExtra + f.triple * c.tripleExtra;
    if (_HAND_POTENTIAL_CACHE.size >= _HAND_POTENTIAL_CACHE_MAX) _HAND_POTENTIAL_CACHE.clear();
    _HAND_POTENTIAL_CACHE.set(sig, score);
    return score;
}

function evaluateHandStrength(hand, memory, isLandlord, callPosition) {
    let ec = cfg('evalCoeffs');
    // 结构分统一走 handPotential（可学习参数表）；这里只保留上下文修正
    let score = handPotential(hand);
    if (memory && memory.isBombPossible()) score += ec.bombOutsideBonus;
    if (callPosition === 2) score += ec.position2Bonus;
    if (isLandlord) score += ec.landlordBonus;
    return score;
}

// outsideBombCount 只取决于手牌 + 记牌器状态，而同一轮评分里所有候选共用同一副手牌
// → 用「最近一次」的记忆缓存，避免每个候选都重算一遍（O(13n)）。
// 注意：缓存键必须带上记牌器状态 —— 对手出牌后我的手牌不变但记牌器变了，
// 只用手牌签名做键会返回过期的炸弹估计。
let _outsideMemoKey = null, _outsideMemoVal = 0;
function _outsideBombCountMemo(memory, hand) {
    if (!memory || typeof memory.getOutsideBombCount !== 'function') return 0;
    let memState = 0;
    if (memory.seen && typeof memory.seen.size === 'number') memState = memory.seen.size;
    const key = _cardTypeSignature(hand) + '#' + memState;
    if (_outsideMemoKey === key) return _outsideMemoVal;
    _outsideMemoKey = key;
    _outsideMemoVal = memory.getOutsideBombCount(hand);
    return _outsideMemoVal;
}

function extractPlayFeatures(play, hand, lastPlay, role, memory, state) {
    let playType = getCardType(play);
    // 用 id 集合代替 includes 线性查找（原来 O(手牌×出牌)）
    const playIds = new Set(play.map(c => c.id));
    let newHand = hand.filter(c => !playIds.has(c.id));
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
    // ===== 新增特征（默认权重 0 → 行为不变，可由学习闭环逐步学出）=====
    // turnsToFinish：出完这手后，按点数分解估的「还差几手」
    // sureTricks  ：剩余手牌里"对手基本压不住"的控制牌数量（控制权是斗地主的硬通货）
    // controlCount：剩余手牌里的控制牌（2 / 王）数量
    // oppThreat   ：对手手里未被消耗的大牌数量（威胁度）
    // isPartnerLead：上一手是队友出的（协作语义）
    let turnsToFinish = newHand.length ? _fastHandTurns(newHand) : 0;
    let maxOutside = 0;
    try { maxOutside = memory && memory.getMaxOutside ? memory.getMaxOutside(hand) : 0; } catch (e) { maxOutside = 0; }
    let sureTricks = 0, controlCount = 0;
    for (const c of newHand) {
        if (c.value >= 12) controlCount++;
        if (c.value > maxOutside) sureTricks++;
    }
    let oppThreat = 0;
    try {
        if (memory && memory.getRemainingCounts) {
            const rem = memory.getRemainingCounts();
            const mine = new Array(15).fill(0);
            for (const c of hand) mine[c.value]++;
            for (let v = 12; v <= 14; v++) oppThreat += Math.max(0, (rem[v] || 0) - mine[v]);
        }
    } catch (e) { oppThreat = 0; }
    const isPartnerLead = !!(lastPlay && role === 'farmer' && state.lastPlayerId !== -1 &&
        state.lastPlayerId !== state.currentPlayer && state.lastPlayerId !== state.landlord);
    return {
        playLength: play.length, playPower, isBomb: isBomb ? 1 : 0, isRocket: (playType.type === CardType.ROCKET) ? 1 : 0,
        remainTotal: newHand.length, remainSingle: handFeatures.single, remainPair: handFeatures.pair,
        remainTriple: handFeatures.triple, remainBomb: handFeatures.bomb, remainMaxStraight: handFeatures.maxStraightLen,
        remainBigCards: handFeatures.bigCards, hasRocket: handFeatures.hasRocket,
        isLandlord: (role === 'landlord') ? 1 : 0, isFarmer: (role === 'farmer') ? 1 : 0,
        opponentHandCount: state.lastPlayerId !== -1 ? state.players[state.lastPlayerId].length : 0,
        nextPlayerHandCount: state.players[nextPlayerId] ? state.players[nextPlayerId].length : 17,
        partnerHandCount: (role === 'farmer' && partnerId !== -1) ? (state.players[partnerId]?.length || 0) : 0,
        outsideBombCount: _outsideBombCountMemo(memory, hand), isCritical: (newHand.length <= 3) ? 1 : 0,
        needBeat: needBeat ? 1 : 0, lastPlayType: lastPlay ? lastPlay.type : 'none',
        lastPlayPower: lastPlay ? typePowerOf(lastPlay.type, lastPlay.value, lastPlay.length) : 0,
        lastPlayLength: lastPlay ? (lastPlay.length || 0) : 0,
        playType: playType.type, kickerValue, mainValue: playType.value,
        turnsToFinish, sureTricks, controlCount, oppThreat, isPartnerLead: isPartnerLead ? 1 : 0,
        // ===== 时机 / 牌权 / 配合 / 交叉特征 =====
        // turnsDelta：出这手让"还差几手"下降多少（>0 = 加速出完）
        turnsDelta: Math.max(0, _fastHandTurns(hand) - turnsToFinish),
        // controlRetained：这手出完后我方是否大概率仍握有下一轮牌权
        controlRetained: (playPower > maxOutside || isBomb || playType.type === CardType.ROCKET) ? 1 : 0,
        // partnerFit：队友残牌结构与本手的互补（只有张数可用时的廉价代理）
        partnerFit: (role === 'farmer' && partnerId !== -1)
            ? Math.max(0, 6 - Math.abs((state.players[partnerId]?.length || 0) - play.length)) : 0,
        // 交叉：领出且对手快走完（该不该冲）/ 炸弹且对手快走完（该不该引爆）
        leadOppClose: (!needBeat && [0,1,2].some(i => i !== state.currentPlayer &&
            (state.players[i]?.length || 20) <= 2)) ? 1 : 0,
        bombUrgency: (isBomb || playType.type === CardType.ROCKET) &&
            [0,1,2].some(i => (state.players[i]?.length || 20) <= 2) ? 1 : 0
    };
}

// ======================== 出牌生成 ========================
const _PLAY_TYPE_CACHE = new Map();
function _canonicalHand(hand) {
    return hand.slice().sort((a, b) => (a.value - b.value) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)));
}
const _VALID_PLAYS_CACHE = new Map();
const _VALID_PLAYS_CACHE_MAX = 256;
function _validPlaysKey(hand, lastPlay) {
    // 手牌按 (value,id) 排序后的序列即规范形。
    // 用「牌面索引 + 手牌内序号」编码：索引保证唯一，序号保证顺序敏感。
    // 键里必须包含具体是哪张牌（同点数的不同花色是不同的牌），
    // 所以不能只用点数多重集 —— 否则会返回别的手牌的牌 id。
    const n = hand.length;
    // 按 (value, id) 排序 —— 规范形的唯一表示
    const ord = new Array(n);
    for (let i = 0; i < n; i++) ord[i] = i;
    ord.sort((a, b) => (hand[a].value - hand[b].value) || (hand[a].id < hand[b].id ? -1 : (hand[a].id > hand[b].id ? 1 : 0)));
    // 键里必须包含**牌的身份**（同点数的不同花色是不同的牌），
    // 也不能用点数多重集 —— 否则会命中别的手牌的缓存、返回别人的牌 id。
    let key = '';
    for (let i = 0; i < n; i++) key += String.fromCharCode(_cardIdx(hand[ord[i]]));
    let lp = '-';
    if (lastPlay && lastPlay.type) {
        lp = lastPlay.type + ':' + lastPlay.value + ':' + (lastPlay.length || 0);
    }
    return key + '|' + lp;
}
// 牌面 id → 小整数索引。
// 缓存键用整数数组排序后转字符，比「字符串数组排序 + join」快一个数量级。
// 牌面 id → 小整数索引。用普通对象（而不是 Map）：属性查找在 V8 里更快。
const _CARD_INDEX = Object.create(null);
let _cardIndexNext = 1;
function _cardIdx(card) {
    let i = _CARD_INDEX[card.id];
    if (i === undefined) {
        i = _cardIndexNext++;
        _CARD_INDEX[card.id] = i;
    }
    return i;
}
// 牌点数多重集 → 键。
// 在 getAllValidPlays 内部，所有候选都取自同一副「规范手牌」，
// 因此「点数多重集相同」就等价于「同一手牌」—— 用它做去重比按 id 便宜得多
// （实测按 id 的字符串键占了 35% 的 CPU）。
function _playValueKey(cards) {
    let n = cards.length;
    if (n === 0) return '';
    const v = new Array(n);
    for (let i = 0; i < n; i++) v[i] = cards[i].value;
    v.sort((a, b) => a - b);
    return v.join(',');
}
function _playKey(cards) {
    const n = cards.length;
    if (n === 0) return '';
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = _cardIdx(cards[i]);
    a.sort((x, y) => x - y);
    // 用 charCode 拼接（索引 < 65536）
    let out = '';
    for (let i = 0; i < n; i++) out += String.fromCharCode(a[i]);
    return out;
}
function playTypeOf(play) {
    if (!play || !play.length) return null;
    const key = _playKey(play);
    const hit = _PLAY_TYPE_CACHE.get(key);
    if (hit) return hit;
    const t = getCardType(play);
    if (t) { if (_PLAY_TYPE_CACHE.size > 4000) _PLAY_TYPE_CACHE.clear(); _PLAY_TYPE_CACHE.set(key, t); }
    return t;
}
// ======================== 翅膀（挂件）组合枚举 ========================
// 按「点数」而不是「牌」枚举翅膀：斗地主里同点数的不同花色策略上完全等价，
// 旧实现按牌枚举会产生大量等价分支（稀释 MCTS 搜索预算、撑爆拆牌 DP 的状态数），
// 而飞机带翅膀的 C(n,k) 组合会直接组合爆炸。
//
// groups: [{v: 点数, cards: 该点数的 canonical 牌}]，每个点数可贡献 1..maxPerRank 张。
// 输出按「翅膀总点数」升序（优先用小牌当翅膀），再截断到 cap。
function _wingCombos(groups, need, maxPerRank, cap) {
    const out = [];
    const n = groups.length;
    if (need <= 0) return [[]];
    let avail = 0;
    for (const g of groups) avail += Math.min(g.cards.length, maxPerRank);
    if (need > avail) return [];
    // cap<=0 表示「不限」：根节点/DOM 校验需要全部合法走法，
    // 截断必须在 canBeat 过滤之后，否则唯一能压的翅膀组合会被丢掉。
    const limit = (cap > 0 ? cap : 4096);
    const hardCap = limit * 4;
    function rec(i, remaining, acc, sum) {
        if (out.length >= hardCap) return;
        if (remaining === 0) { out.push({ cards: acc.slice(), sum }); return; }
        if (i >= n) return;
        const g = groups[i];
        const maxTake = Math.min(g.cards.length, maxPerRank, remaining);
        for (let k = maxTake; k >= 1; k--) {
            for (let j = 0; j < k; j++) acc.push(g.cards[j]);
            rec(i + 1, remaining - k, acc, sum + g.v * k);
            for (let j = 0; j < k; j++) acc.pop();
            if (out.length >= hardCap) return;
        }
        rec(i + 1, remaining, acc, sum);
    }
    rec(0, need, [], 0);
    out.sort((a, b) => a.sum - b.sum);
    return out.slice(0, limit).map(o => o.cards);
}
// opts.maxComboPerGroup：限制「每组底牌」派生的组合数上限（0 = 不限）。
//
// 为什么需要它：三带一/四带二/飞机带翅膀这些牌型的候选数是组合爆炸的
// （12 个三张 × 17 张单牌 = 204 个三带一候选），枚举本身就很贵。
// 根节点与 MCTS 扩展需要**全部**合法走法（否则会漏掉好棋），
// 但 rollout 只是要挑一个像样的走法 —— 给它一个精简集即可。
// 保留的候选按「牌值从小到大」优先，因此消耗的都是小牌（正是 rollout 想要的）。
function getAllValidPlays(hand, lastPlay = null, opts) {
    if (!hand || hand.length === 0) return [];
    if (lastPlay && lastPlay.type === CardType.ROCKET) return [];
    const comboCap = (opts && opts.maxComboPerGroup) || 0;
    const cacheKey = _validPlaysKey(hand, lastPlay) + (comboCap ? ('#' + comboCap) : '');
    const cached = _VALID_PLAYS_CACHE.get(cacheKey);
    if (cached !== undefined) {
        return cached.map(p => p.slice());
    }

    // 等价牌必须稳定表示：否则同一副牌因数组顺序不同会返回“不同的那张 K”，
    // 上层链路可能在另一条 canonical 列表里选中另一张同名牌，被误判为非法牌。
    const hand2 = _canonicalHand(hand);
    let cands = [];
    const byValue = {};
    hand2.forEach(c => { if (!byValue[c.value]) byValue[c.value] = []; byValue[c.value].push(c); });
    const push = (cards, type) => cands.push({ cards, type });
    Object.values(byValue).forEach(arr => { if (arr.length >= 1) push([arr[0]], { type: CardType.SINGLE, value: arr[0].value }); });
    Object.values(byValue).forEach(arr => { if (arr.length >= 2) push([arr[0], arr[1]], { type: CardType.PAIR, value: arr[0].value }); });
    Object.values(byValue).forEach(arr => { if (arr.length >= 3) push([arr[0], arr[1], arr[2]], { type: CardType.TRIPLE, value: arr[0].value }); });
    Object.values(byValue).forEach(arr => { if (arr.length === 4) push(arr, { type: CardType.BOMB, value: arr[0].value + 50 }); });
    if (byValue[13] && byValue[14]) push([byValue[13][0], byValue[14][0]], { type: CardType.ROCKET, value: 100 });
    if (_canContend(lastPlay, CardType.TRIPLE_WITH_SINGLE)) {
        for (let triple of Object.values(byValue).filter(arr=>arr.length>=3)) {
            // 挂件按点数枚举：每个不同点数只出一个 canonical 牌（旧实现按牌枚举会产生等价分支）
            let n = 0;
            for (const v of Object.keys(byValue)) {
                const val = Number(v);
                if (val === triple[0].value) continue;
                if (comboCap && n >= comboCap) break;
                n++;
                push([...triple.slice(0,3), byValue[v][0]], { type: CardType.TRIPLE_WITH_SINGLE, value: triple[0].value });
            }
        }
    }
    if (_canContend(lastPlay, CardType.TRIPLE_WITH_PAIR)) {
        for (let triple of Object.values(byValue).filter(arr=>arr.length>=3)) {
            let n = 0;
            for (let pair of Object.values(byValue).filter(arr=>arr.length>=2 && arr[0].value !== triple[0].value)) {
                if (comboCap && n >= Math.max(1, comboCap >> 1)) break;
                n++;
                push([...triple.slice(0,3), ...pair.slice(0,2)], { type: CardType.TRIPLE_WITH_PAIR, value: triple[0].value });
            }
        }
    }
    if (_canContend(lastPlay, CardType.FOUR_WITH_TWO_SINGLE)) {
        for (let quad of Object.values(byValue).filter(arr=>arr.length===4)) {
            // 翅膀按点数枚举：两张不同点数各取一张，或同一点数取两张（拆对子）
            let wingGroups = [];
            for (const v of Object.keys(byValue)) {
                const val = Number(v);
                if (val === quad[0].value) continue;
                wingGroups.push({ v: val, cards: byValue[v].slice(0, 2) });
            }
            let combos = _wingCombos(wingGroups, 2, 2, comboCap > 0 ? comboCap : 0);
            for (let w of combos) push([...quad, ...w], { type: CardType.FOUR_WITH_TWO_SINGLE, value: quad[0].value });
        }
    }
    if (_canContend(lastPlay, CardType.FOUR_WITH_TWO_PAIR)) {
        for (let quad of Object.values(byValue).filter(arr=>arr.length===4)) {
            let pairs = Object.values(byValue).filter(arr=>arr.length>=2 && arr[0].value !== quad[0].value);
            let n = 0;
            for (let i=0;i<pairs.length;i++) for (let j=i+1;j<pairs.length;j++) {
                if (comboCap && n >= Math.max(1, comboCap >> 1)) break;
                n++;
                push([...quad, ...pairs[i].slice(0,2), ...pairs[j].slice(0,2)], { type: CardType.FOUR_WITH_TWO_PAIR, value: quad[0].value });
            }
        }
    }
    if (_canContend(lastPlay, CardType.STRAIGHT)) {
        let uniqueValues = [...new Set(hand2.map(c=>c.value).filter(v=>v<12))].sort((a,b)=>a-b);
        for (let len=5; len<=12; len++) {
            for (let i=0; i+len <= uniqueValues.length; i++) {
                let seq = uniqueValues.slice(i, i+len);
                if (isStraight(seq)) {
                    let cards = [], ok=true;
                    for (let v of seq) { if (!byValue[v]) { ok=false; break; } cards.push(byValue[v][0]); }
                    if (ok) push(cards, { type: CardType.STRAIGHT, value: seq[0], length: len });
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
                    if (ok) push(cards, { type: CardType.STRAIGHT_PAIR, value: seq[0], length: len });
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
                    if (ok) push(cards, { type: CardType.PLANE, value: seq[0], length: len });
                }
            }
        }
    }
    if (_canContend(lastPlay, CardType.PLANE_WITH_SINGLE)) {
        let tripleValues = Object.keys(byValue).filter(v => byValue[v].length >= 3 && v<12).map(Number).sort((a,b)=>a-b);
        for (let len=2; len<=tripleValues.length; len++) {
            for (let i=0; i+len<=tripleValues.length; i++) {
                const seq = tripleValues.slice(i, i+len);
                if (!isStraight(seq)) continue;
                let tripleCards = [], ok=true;
                for (const v of seq) { if (!byValue[v] || byValue[v].length<3) { ok=false; break; } tripleCards.push(byValue[v][0], byValue[v][1], byValue[v][2]); }
                if (!ok) continue;
                // 翅膀点数不能与飞机本体点数相同（getCardType 会把同点数算进本体）
                const bodyVals = new Set(seq);
                let wingGroups = [];
                for (const v of Object.keys(byValue)) {
                    const val = Number(v);
                    if (bodyVals.has(val)) continue;
                    wingGroups.push({ v: val, cards: byValue[v].slice(0, 2) });
                }
                let combos = _wingCombos(wingGroups, len, 2, comboCap > 0 ? comboCap : 0);
                for (let w of combos) {
                    const cards = [...tripleCards, ...w];
                    const vt = getCardType(cards);
                    if (vt && vt.type === CardType.PLANE_WITH_SINGLE) push(cards, vt);
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
                let n = 0;
                for (let combo of getCombinations(availPairs, len)) {
                    if (comboCap && n >= Math.max(1, comboCap >> 1)) break;
                    n++;
                    let cards = [...tripleCards];
                    let ok2 = true;
                    for (let v of combo) { if (!byValue[v] || byValue[v].length<2) { ok2=false; break; } cards.push(byValue[v][0], byValue[v][1]); }
                    if (!ok2) continue;
                    const vt = getCardType(cards);
                    if (vt && vt.type === CardType.PLANE_WITH_PAIR) push(cards, vt);
                }
            }
        }
    }
    // 去重：曾经这里有一个「按牌 id 排序拼字符串」的 Map，实测占掉 35% 的 CPU。
    // 但各生成路径本来就互不重叠（牌型不同；同一路径内 (底牌, 配件) 组合唯一），
    // 所以候选集合天然没有重复 —— 实测 600 手牌（领出 + 跟牌两种上下文）
    // 去重前后完全一致。因此直接去掉，改为由 rules_test.js 断言"无重复"，
    // 以后谁改坏了生成器会被测试挡住。
    let out = [];
    for (const entry of cands) {
        let type = entry.type;
        if (!type || !type.cards) {
            type = getCardType(entry.cards);
            if (!type) continue;
        }
        if (lastPlay && !canBeat(type, lastPlay)) continue;
        type.cards = entry.cards;
        if (_PLAY_TYPE_CACHE.size > 4000) _PLAY_TYPE_CACHE.clear();
        _PLAY_TYPE_CACHE.set(_playKey(entry.cards), type);
        out.push({ cards: entry.cards, type });
    }
    out.sort((a,b) => typePowerOf(a.type.type, a.type.value, a.type.length) - typePowerOf(b.type.type, b.type.value, b.type.length));
    const result = out.map(e => e.cards);
    if (_VALID_PLAYS_CACHE.size >= _VALID_PLAYS_CACHE_MAX) _VALID_PLAYS_CACHE.clear();
    _VALID_PLAYS_CACHE.set(cacheKey, result.map(p => p.slice()));
    return result.map(p => p.slice());
}

// ======================== 评分系统 ========================
function scorePlay(features, role, memory, state, playerHand) {
    let score = 0;
    // 权重按角色分桶：地主与农民的目标完全不同（地主要压制，农民要配合 + 抢跑），
    // 共用一套权重会让学习闭环在两个目标之间来回拉扯。
    // weightsByRole.<role>.<key> 缺省时回落到全局 weights.<key>。
    let W = cfg('weights');
    try {
        const roleW = cfg('weightsByRole.' + role);
        if (roleW && typeof roleW === 'object') {
            let merged = Object.assign({}, W);
            for (const k in roleW) if (typeof roleW[k] === 'number') merged[k] = roleW[k];
            W = merged;
        }
    } catch (e) {}
    for (let key in W) if (features[key] !== undefined) score += features[key] * W[key];
    let isPartnerPlay = role === 'farmer' && state.lastPlayerId !== -1 && state.lastPlayerId !== state.currentPlayer && state.lastPlayerId !== state.landlord;
    let ph = cfg('playHeuristics');
    let ps = cfg('passScores');
    if (isPartnerPlay) {
        if (features.partnerHandCount <= 3) score += ph.partnerPlay.handLe3;
        if (features.partnerHandCount <= 2) score += ph.partnerPlay.handLe2;
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
        let over = features.playPower - minBeatPower(features.lastPlayType, features.lastPlayPower, features.lastPlayLength);
        if (over <= 1) score += ph.suppressSingle.diffLe4;
        else if (over <= 3) score += ph.suppressSingle.diffLe7;
        else if (over <= 6) score += ph.suppressSingle.diffLe10;
        else score += ph.suppressSingle.diffGt10;
    }
    if (features.needBeat && features.lastPlayType === 'pair' && features.lastPlayPower <= 8) {
        let over = features.playPower - minBeatPower(features.lastPlayType, features.lastPlayPower, features.lastPlayLength);
        if (over <= 1) score += ph.suppressPair.diffLe4;
        else if (over <= 3) score += ph.suppressPair.diffLe7;
        else if (over <= 6) score += ph.suppressPair.diffLe10;
        else score += ph.suppressPair.diffGt10;
    }
    let lastPlayerCards = state.lastPlayerId >= 0 && state.players[state.lastPlayerId] ? state.players[state.lastPlayerId].length : 20;
    if (features.needBeat && role === 'farmer' && lastPlayerCards <= 6 && features.lastPlayPower <= 10 && features.playPower > features.lastPlayPower) {
        score += ph.farmerOppLowCards.handLe6LastPowerLe10;
    }
    if (features.needBeat && role === 'farmer' && state.lastPlayerId === state.landlord &&
        features.playPower > minBeatPower(features.lastPlayType, features.lastPlayPower, features.lastPlayLength)) {
        if (features.lastPlayPower <= 8) score += ph.farmerVsLord.lastPowerLe8;
        else if (features.lastPlayPower <= 11) score += ph.farmerVsLord.lastPowerLe11;
    }
    if (features.needBeat && features.nextPlayerHandCount <= 2 && !features.isBomb && !features.isRocket) {
        if (features.playPower <= 12) score -= 200;
    }
    let oppAboutToWinEarly;
    if (role === 'farmer') {
        oppAboutToWinEarly = (state.players[state.landlord]?.length || 20) <= 2;
    } else {
        oppAboutToWinEarly = [0, 1, 2].some(i => i !== state.landlord && (state.players[i]?.length || 20) <= 2);
    }
    if (!features.needBeat && features.isLandlord && features.playLength <= 2 && features.playType === CardType.SINGLE) {
        if (!oppAboutToWinEarly && features.playPower <= 6) score += ph.landlordLeadLowPower.powerLe6;
        if (features.playPower >= 12) score += ph.landlordLeadLowPower.powerGe12;
    }
    // 对手只剩 1~2 张：领出单张等于送他走完 → 强惩罚单张、奖励多张组合
    if (!features.needBeat && oppAboutToWinEarly) {
        if (features.playLength >= 3) score += 35;
        else if (features.playLength === 1 && features.nextPlayerHandCount <= 1) score -= 90 + features.playPower * 0.8;
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
    if (!features.needBeat && (features.isBomb || features.isRocket)) {
        let _late = features.remainTotal <= 3 || (playerHand && playerHand.length <= 6);
        if (!_late) {
            score += features.isRocket ? ph.bombLead.rocket : ph.bombLead.bomb;
        } else {
            let _bl = cfg('leadAdjust.bombLeadLate') || { bomb: 20, rocket: 30 };
            score += features.isRocket ? _bl.rocket : _bl.bomb;
        }
    }

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
    let ovW = cfg('overshoot.weight');
    if (features.needBeat && ovW && !features.isBomb && !features.isRocket && features.remainTotal > 3) {
        let minP = minBeatPower(features.lastPlayType, features.lastPlayPower, features.lastPlayLength);
        if (minP > 0) {
            let over = features.playPower - minP;
            if (over > 0) {
                const capped = Math.min(over, cfg('overshoot.max'));
                score -= capped * ovW + Math.max(0, over - 4) * Math.max(0, over - 4) * cfg('overshoot.curve');
            }
        }
    }
    let cc = cfg('comboControl');
    if (cc && features.remainTotal > (cc.endgameExempt || 4)) {
        if (features.playType === CardType.TRIPLE && features.mainValue >= 12) score += cc.tripleHigh;
        if ((features.playType === CardType.TRIPLE_WITH_SINGLE || features.playType === CardType.TRIPLE_WITH_PAIR) && features.mainValue >= 11) score += cc.tripleWithHigh;
        if ((features.playType === CardType.FOUR_WITH_TWO_SINGLE || features.playType === CardType.FOUR_WITH_TWO_PAIR) && features.mainValue >= 10) score += cc.quadHigh;
        if ((features.playType === CardType.PLANE || features.playType === CardType.PLANE_WITH_SINGLE || features.playType === CardType.PLANE_WITH_PAIR) && features.mainValue >= 10) score += cc.planeHigh;
        if (!features.needBeat && features.playLength === 1 && features.mainValue >= 11) score += cc.leadHighSingle;
        if (!features.needBeat && features.playLength === 2 && features.mainValue >= 12) score += cc.leadHighPair;
    }
    // ===== 角色协作/压制：农民保队友、压制地主；地主压制快赢农民 =====
    let _pid = state.currentPlayer;
    let _landlord = state.landlord;
    let _lastId = state.lastPlayerId;
    // 下家是对手且少牌：除非过牌会送其赢，否则应防止其接牌并优先压住
    if (features.needBeat && features.nextPlayerHandCount <= 2) {
        let nextIsOpp = role === 'farmer' ? ( ( (_pid+1)%3 ) === _landlord ) : ( ( (_pid+1)%3 ) !== _landlord );
        if (nextIsOpp && !features.isRocket) score += 60;
    }
    // 地主(对手)只剩 <=2 张：农民应尽量压住/防止其顺走
    if (role === 'farmer' && features.needBeat && _lastId === _landlord && (state.players[_landlord] ? state.players[_landlord].length : 20) <= 2) {
        if (features.playPower > (features.lastPlayPower || 0)) score += 120;
    }
    // 队友只剩 <=2 张：农民不要 unnecessarily 压过队友/抢出大牌
    if (role === 'farmer' && state.lastPlayerId !== -1 && state.lastPlayerId !== _landlord && features.needBeat) {
        let mateCards = state.players[state.lastPlayerId] ? state.players[state.lastPlayerId].length : 20;
        if (mateCards <= 2 && features.playPower >= 12) score -= 100;
    }
    // 地主面对快赢农民：强力压制
    if (role === 'landlord' && features.needBeat && _lastId !== _landlord && (state.players[_lastId] ? state.players[_lastId].length : 20) <= 2) {
        if (features.playPower > (features.lastPlayPower || 0)) score += 150;
    }
    if (playerHand) {
        let ruleCtx = {
            needBeat: !!features.needBeat,
            lastPlayType: features.lastPlayType,
            lastPlayPower: features.lastPlayPower,
            lastPlayLength: features.lastPlayLength,
            playType: features.playType,
            playPower: features.playPower,
            playLength: features.playLength,
            kickerValue: features.kickerValue,
            mainValue: features.mainValue,
            role: role,
            handSize: playerHand.length,
            isBomb: !!features.isBomb,
            isRocket: !!features.isRocket,
            isBombPlay: !!features.isBomb,
            isRocketPlay: !!features.isRocket,
            hasBothJokers: playerHand.some(c=>c.value===14) && playerHand.some(c=>c.value===13),
            hasSmallJoker: playerHand.some(c=>c.value===13),
            hasBigJoker: playerHand.some(c=>c.value===14),
            // 剩余张数类约束必须出现在上下文里：
            // 纠错规则引擎只在 ctx 里存在对应键时才应用数值比较，
            // 缺失就会被**静默丢弃** —— 例如"对手只剩 ≤2 张时才值得用炸"会退化成
            // "每次用炸都奖励"，与 overkill 规则直接对冲。
            opponentHandCount: features.opponentHandCount,
            nextPlayerHandCount: features.nextPlayerHandCount,
            partnerHandCount: features.partnerHandCount,
            remainTotal: features.remainTotal,
            remainSingle: features.remainSingle,
            remainPair: features.remainPair,
            remainTriple: features.remainTriple,
            remainBomb: features.remainBomb,
            outsideBombCount: features.outsideBombCount,
            isLandlord: !!features.isLandlord,
            isFarmer: !!features.isFarmer
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
            if (partnerCards <= 2) score += ps.farmerPartnerHandLe2;
            if (partnerCards <= 1) score += ps.farmerPartnerHandLe1;
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
    // 队友(下家)即将出完：优先过牌送其胜利
    if (nextCards <= 2 && !isNextOpp && state.lastPlayerId !== -1 && state.lastPlayerId !== state.currentPlayer) score += 150;
    if (state.passCount >= 1) score += ps.passCountGe1;
    try {
        const lastId = state.lastPlayerId;
        const oppCount = lastId >= 0 && state.players[lastId] ? state.players[lastId].length : 17;
        const passCtx = {
            target: 'pass',
            needBeat: !!state.lastPlay && state.lastPlayerId !== state.currentPlayer,
            role: role,
            opponentHandCount: oppCount,
            lastPlayerIsPartner: lastId >= 0 && lastId !== state.currentPlayer && lastId !== state.landlord
        };
        for (const rule of matchRules(passCtx)) {
            if (rule && rule.context && rule.context.target === 'pass') score += rule.penalty;
        }
    } catch (e) { /* 规则匹配失败不影响基础过牌分 */ }
    return score;
}

// ======================== 对手响应模拟 ========================
function simulateOpponentResponseV2(play, hand, state, role, memory, depth = 1) {
    const myRoleId = role === 'landlord' ? 'landlord' : 'farmer';
    const newHand = hand.filter(c => !play.includes(c));
    const newState = _cloneStateShallow(state);
    newState.players[state.currentPlayer] = newHand;
    newState.lastPlay = getCardType(play);
    newState.lastPlayerId = state.currentPlayer;
    newState.passCount = 0;

    function terminalScore(s) {
        for (let i = 0; i < 3; i++) {
            if (s.players[i] && s.players[i].length === 0) {
                const winnerRole = i === s.landlord ? 'landlord' : 'farmer';
                return winnerRole === myRoleId ? 100 : -100;
            }
        }
        return null;
    }
    function staticScore(s) {
        let mine = 0, theirs = 0;
        for (let i = 0; i < 3; i++) {
            const p = s.players[i] || [];
            let str = 0;
            try { str = evaluateHandStrength(p, memory, i === s.landlord); } catch (e) { str = p.length; }
            const sameRole = (i === s.landlord) === (myRoleId === 'landlord');
            if (sameRole) mine += str; else theirs += str;
        }
        return Math.max(-80, Math.min(80, (mine - theirs) * 0.8));
    }
    function sampleOpponentPlays(oppHand, targetPlay) {
        let plays = getAllValidPlays(oppHand, targetPlay);
        if (!plays || plays.length === 0) return null;
        let n = depth >= 2 ? 15 : 8;
        if (plays.length <= n) return plays;
        // 旧实现等距抽样（按生成器顺序，近乎随机出牌）→ 高估己方收益。
        // 改为按 scorePlay 的 softmax 抽样，让对手优先出"合理"的牌。
        const oppRole = (oppHand === s.players[s.landlord]) ? 'landlord' : 'farmer';
        let scored = plays.map(p => {
            let sc = 0;
            try { sc = scorePlay(extractPlayFeatures(p, oppHand, targetPlay, oppRole, memory, s), oppRole, memory, s, oppHand); }
            catch (e) { sc = 0; }
            return { p, sc };
        });
        scored.sort((a, b) => b.sc - a.sc);
        return scored.slice(0, n * 2).map(e => e.p);   // 保留强度靠前的一批
    }
    function evalState(s, pid, myRoleId, remainingDepth) {
        const term = terminalScore(s);
        if (term !== null) return term;
        if (remainingDepth <= 0) return staticScore(s);
        const needBeat = s.lastPlay && s.lastPlayerId !== pid;
        const samples = sampleOpponentPlays(s.players[pid], s.lastPlay);
        if (!samples || samples.length === 0) {
            if (!needBeat) return staticScore(s);
            const s2 = _cloneStateShallow(s);
            s2.passCount = (s2.passCount || 0) + 1;
            if (s2.passCount >= 2) { s2.lastPlay = null; s2.lastPlayerId = -1; s2.passCount = 0; }
            return evalState(s2, (pid + 1) % 3, myRoleId, remainingDepth - 1);
        }
        const actions = samples.slice();
        if (needBeat) actions.push([]);
        let total = 0, count = 0;
        for (const sp of actions) {
            const s2 = _cloneStateShallow(s);
            if (!sp || sp.length === 0) {
                s2.passCount = (s2.passCount || 0) + 1;
                if (s2.passCount >= 2) { s2.lastPlay = null; s2.lastPlayerId = -1; s2.passCount = 0; }
                total += evalState(s2, (pid + 1) % 3, myRoleId, remainingDepth - 1);
                count++;
                continue;
            }
            const spIds = new Set(sp.map(c => c.id));
            s2.players[pid] = s2.players[pid].filter(c => !spIds.has(c.id));
            s2.lastPlay = getCardType(sp);
            s2.lastPlayerId = pid;
            s2.passCount = 0;
            const term2 = terminalScore(s2);
            total += term2 !== null ? term2 : evalState(s2, (pid + 1) % 3, myRoleId, remainingDepth - 1);
            count++;
        }
        return count > 0 ? total / count : staticScore(s);
    }

    const rootTerm = terminalScore(newState);
    if (rootTerm !== null) return rootTerm;
    const nextPlayer = (state.currentPlayer + 1) % 3;
    const opponentPlays = getAllValidPlays(newState.players[nextPlayer], newState.lastPlay);
    if (!opponentPlays || opponentPlays.length === 0) {
        newState.passCount = (newState.passCount || 0) + 1;
        if (newState.passCount >= 2) { newState.lastPlay = null; newState.lastPlayerId = -1; newState.passCount = 0; }
        return evalState(newState, (nextPlayer + 1) % 3, myRoleId, depth);
    }
    const n = depth >= 2 ? 15 : 8;
    const samples = opponentPlays.length <= n ? opponentPlays.slice() :
        (() => { const step = Math.floor(opponentPlays.length / n); const r = []; for (let i = 0; i < n; i++) r.push(opponentPlays[Math.min(i * step, opponentPlays.length - 1)]); return r; })();
    samples.push([]);
    let weighted = 0, count = 0;
    for (const sp of samples) {
        const s2 = _cloneStateShallow(newState);
        if (!sp || sp.length === 0) {
            s2.passCount = (s2.passCount || 0) + 1;
            if (s2.passCount >= 2) { s2.lastPlay = null; s2.lastPlayerId = -1; s2.passCount = 0; }
            weighted += evalState(s2, (nextPlayer + 1) % 3, myRoleId, depth - 1);
            count++;
            continue;
        }
        const spIds = new Set(sp.map(c => c.id));
        s2.players[nextPlayer] = s2.players[nextPlayer].filter(c => !spIds.has(c.id));
        s2.lastPlay = getCardType(sp);
        s2.lastPlayerId = nextPlayer;
        s2.passCount = 0;
        const term2 = terminalScore(s2);
        weighted += term2 !== null ? term2 : evalState(s2, (nextPlayer + 1) % 3, myRoleId, depth - 1);
        count++;
    }
    return count > 0 ? weighted / count : 0;
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

// ======================== 手牌分解（点数计数状态 + 最少手数） ========================
// 斗地主里「手数」就是胜利货币：出牌次数越少越有利，因此分解的主目标必须是手数，
// 而不是手调分。旧实现是 2^n 位掩码 DP，只覆盖 ≤15 张（>15 直接返回 -999），
// 且优化的是 dpScores 手调分 → 16~20 张的局面完全没有拆牌推理。
//
// 新实现：
//   · 状态 = 点数计数向量（每个点数剩几张），状态数远小于 2^n，覆盖到 20 张；
//   · 目标 = 最少手数，同手数时再比较结构分（沿用 dpScores 的偏好）；
//   · 算法 = beam search（有界、可预测耗时），beam 宽度可配；
//   · 缓存按「点数多重集」，命中后按当前手牌重新物化牌对象（避免花色串味）。
const _DP_CACHE = new Map();
const _DP_CACHE_MAX = 256;
const _TURNS_CACHE = new Map();
const _TURNS_CACHE_MAX = 4096;

function _countVector(hand) {
    const counts = new Array(15).fill(0);
    for (const c of hand) if (c.value >= 0 && c.value <= 14) counts[c.value]++;
    return counts;
}
// 贪心估计「还需几手才能出完」——用于 beam 排序与残局静态估值。
// O(点数×段) 的轻量估算，不走完整分解（完整分解在 rollout 里太贵）。
function _fastTurnsFromCounts(counts) {
    const c = counts.slice();
    let turns = 0;
    // 顺子（连续单张，≥5）
    for (let v = 0; v <= 11; v++) {
        let len = 0;
        while (v + len <= 11 && c[v + len] > 0) len++;
        while (len >= 5) {
            for (let k = 0; k < len; k++) c[v + k]--;
            turns++;
            len = 0;
            while (v + len <= 11 && c[v + len] > 0) len++;
        }
    }
    // 飞机（连续三张，≥2 组）—— 必须先于连对！
    // 旧顺序先抽连对，会把 333444555666 拆成 1 个连对+4 单（估 5 手），
    // 而实际是一手飞机（1 手）。这个估值被 beam 排序/残局/rollout 四处复用，
    // 顺序错误会系统性高估连续三张结构的手数。
    for (let v = 0; v <= 11; v++) {
        let len = 0;
        while (v + len <= 11 && c[v + len] >= 3) len++;
        while (len >= 2) {
            for (let k = 0; k < len; k++) c[v + k] -= 3;
            turns++;
            len = 0;
            while (v + len <= 11 && c[v + len] >= 3) len++;
        }
    }
    // 连对（≥3）
    for (let v = 0; v <= 11; v++) {
        let len = 0;
        while (v + len <= 11 && c[v + len] >= 2) len++;
        while (len >= 3) {
            for (let k = 0; k < len; k++) c[v + k] -= 2;
            turns++;
            len = 0;
            while (v + len <= 11 && c[v + len] >= 2) len++;
        }
    }
    // 炸弹 / 火箭
    for (let v = 0; v <= 12; v++) if (c[v] >= 4) { turns++; c[v] -= 4; }
    if (c[13] > 0 && c[14] > 0) { turns++; c[13]--; c[14]--; }
    // 三带一
    for (let v = 0; v <= 12; v++) {
        if (c[v] >= 3) {
            c[v] -= 3;
            turns++;
            for (let w = 0; w <= 14; w++) {
                if (w === v || c[w] <= 0) continue;
                c[w]--; break;
            }
        }
    }
    // 对子 / 单张
    for (let v = 0; v <= 14; v++) {
        while (c[v] >= 2) { c[v] -= 2; turns++; }
        if (c[v] > 0) { c[v]--; turns++; }
    }
    return turns;
}
function _cachedTurns(counts) {
    const key = counts.join(',');
    let v = _TURNS_CACHE.get(key);
    if (v === undefined) {
        v = _fastTurnsFromCounts(counts);
        if (_TURNS_CACHE.size >= _TURNS_CACHE_MAX) _TURNS_CACHE.clear();
        _TURNS_CACHE.set(key, v);
    }
    return v;
}
function _fastHandTurns(hand) {
    if (!hand || !hand.length) return 0;
    return _cachedTurns(_countVector(hand));
}
// 单个走法的结构分（沿用 dpScores 偏好：成型组合好、散牌差）
function _decompActionScore(play, ds) {
    const t = getCardType(play);
    if (!t) return 0;
    if (t.type === CardType.ROCKET) return ds.rocket;
    if (t.type === CardType.BOMB) return ds.bomb;
    if (t.type === CardType.STRAIGHT) return ds.straight + t.length * ds.straightLenFactor;
    if (t.type === CardType.STRAIGHT_PAIR) return ds.straightPair + t.length * ds.straightPairLenFactor;
    if (t.type === CardType.PLANE) return ds.plane + t.length * ds.planeLenFactor;
    if (t.type === CardType.PLANE_WITH_SINGLE || t.type === CardType.PLANE_WITH_PAIR) {
        const target = t.type === CardType.PLANE_WITH_SINGLE ? 1 : 2;
        const cnt = countValues(play.map(c => c.value));
        const kickerVals = Object.keys(cnt).filter(k => cnt[k] === target).map(Number);
        const maxKicker = kickerVals.length > 0 ? Math.max(...kickerVals) : 0;
        return ds.planeWith - Math.max(0, maxKicker - 7) * 3 * t.length;
    }
    if (t.type === CardType.TRIPLE_WITH_SINGLE || t.type === CardType.TRIPLE_WITH_PAIR) {
        const target = t.type === CardType.TRIPLE_WITH_SINGLE ? 1 : 2;
        const cnt = countValues(play.map(c => c.value));
        const kickerVal = parseInt(Object.keys(cnt).find(k => cnt[k] === target && parseInt(k) !== t.value)) || 0;
        let s = ds.tripleWith - Math.max(0, kickerVal - 7) * 3;
        if (t.value >= 11) s -= 30;
        return s;
    }
    if (t.type === CardType.FOUR_WITH_TWO_SINGLE) return ds.planeWith;
    if (t.type === CardType.FOUR_WITH_TWO_PAIR) return ds.planeWith + 10;
    if (t.type === CardType.PAIR) return ds.pair;
    if (t.type === CardType.TRIPLE) { let s = ds.triple; if (t.value >= 11) s -= 30; return s; }
    return ds.single;
}
// 按点数计划物化出真实牌对象（缓存只存点数，避免不同花色的手牌互相污染）
function _materializePlan(plan, hand) {
    const pools = new Map();
    for (const c of hand) {
        if (!pools.has(c.value)) pools.set(c.value, []);
        pools.get(c.value).push(c);
    }
    const out = [];
    for (const vals of plan) {
        const cards = [];
        for (const v of vals) {
            const pool = pools.get(v);
            if (!pool || !pool.length) return null;
            cards.push(pool.pop());
        }
        out.push(cards);
    }
    return out;
}
function decomposeHandDP(hand) {
    if (!hand || hand.length === 0) return { plays: [], score: 0 };
    const _ck = hand.map(c => c.value).sort((a, b) => a - b).join('|');
    const _hit = _DP_CACHE.get(_ck);
    if (_hit) {
        const mat = _materializePlan(_hit.plan, hand);
        if (mat) return { plays: mat, score: _hit.score };
    }
    const ds = cfg('dpScores');
    const beamWidth = cfg('decompose.beam') || 48;
    const maxLevels = cfg('decompose.maxLevels') || 14;
    // 候选动作：除单张外全部合法走法（单张永远是兜底，不参与 beam 扩展）
    let allPlays = getAllValidPlays(hand, null);
    let actions = [];
    for (let play of allPlays) {
        const t = getCardType(play);
        if (!t || t.type === CardType.SINGLE) continue;
        const vec = new Array(15).fill(0);
        for (const c of play) vec[c.value]++;
        actions.push({ vec, score: _decompActionScore(play, ds), len: play.length });
    }
    // 一次出更多张的走法优先（同手数时更可能凑出成型组合）
    actions.sort((a, b) => (b.len - a.len) || (b.score - a.score));
    if (actions.length > 160) actions = actions.slice(0, 160);

    let beam = [{ counts: _countVector(hand), turns: 0, score: 0, path: [] }];
    let best = null;
    for (let level = 0; level < maxLevels; level++) {
        const next = [];
        for (const st of beam) {
            const est = _cachedTurns(st.counts);
            const total = st.turns + est;
            if (!best || total < best.turns || (total === best.turns && st.score > best.score)) {
                best = { turns: total, score: st.score, path: st.path.slice(), counts: st.counts.slice(), est };
            }
            if (est === 0) continue;
            for (const a of actions) {
                let fits = true;
                for (let v = 0; v < 15; v++) {
                    if (a.vec[v] > st.counts[v]) { fits = false; break; }
                }
                if (!fits) continue;
                const nc = st.counts.slice();
                for (let v = 0; v < 15; v++) nc[v] -= a.vec[v];
                next.push({ counts: nc, turns: st.turns + 1, score: st.score + a.score, path: st.path.concat([a]) });
            }
        }
        if (!next.length) break;
        next.sort((a, b) => {
            const ea = a.turns + _cachedTurns(a.counts);
            const eb = b.turns + _cachedTurns(b.counts);
            return (ea - eb) || (b.score - a.score);
        });
        beam = next.slice(0, beamWidth);
    }
    // 组装具体点数计划（beam 的 path 只记录了点数向量）
    let plays = [];
    if (best) {
        let remain = _countVector(hand);
        for (const a of best.path) {
            const vals = [];
            for (let v = 0; v < 15; v++) for (let k = 0; k < a.vec[v]; k++) vals.push(v);
            vals.sort((x, y) => x - y);
            for (const v of vals) remain[v]--;
            plays.push(vals);
        }
        for (let v = 0; v < 15; v++) for (let k = 0; k < remain[v]; k++) plays.push([v]);
    } else {
        plays = hand.map(c => [c.value]);
    }
    const plan = plays.map(vals => vals.slice().sort((a, b) => a - b));
    const mat = _materializePlan(plan, hand) || plan.map(vals => vals.map(v => ({ value: v, id: 'v' + v })));
    let score = best ? best.score : 0;
    if (mat.length === 1 && mat[0].length === hand.length) score += ds.completeBonus;
    if (_DP_CACHE.size >= _DP_CACHE_MAX) _DP_CACHE.clear();
    _DP_CACHE.set(_ck, { plan, score });
    return { plays: mat, score };
}

function greedyDecompose(hand) {
    if (!hand || !hand.length) return { plays: [], score: 0 };
    hand = _canonicalHand(hand);

    const plays = [];
    const used = new Set();
    const remaining = () => hand.filter(c => !used.has(c.id));
    const takeCards = (cards) => {
        for (const c of cards) used.add(c.id);
        plays.push(cards.map(c => ({ ...c })));
    };
    const reserve = (cards) => { for (const c of cards) used.add(c.id); };
    const unreservePlay = (cards) => plays.push(cards.map(c => ({ ...c })));

    const byValue = {};
    for (const c of hand) {
        if (c.value < 0 || c.value > 14) continue;
        if (!byValue[c.value]) byValue[c.value] = [];
        byValue[c.value].push(c);
    }

    const rocket = (byValue[13] && byValue[13].length && byValue[14] && byValue[14].length)
        ? [byValue[13][0], byValue[14][0]] : null;
    const bombs = [];
    for (let v = 0; v <= 12; v++) {
        if (byValue[v] && byValue[v].length === 4) bombs.push(byValue[v].slice(0, 4));
    }

    // 炸弹/王炸先“预留”给最后，但不会参与前面的顺子/连对拆解。
    const reserved = [];
    if (rocket) { reserve(rocket); reserved.push(rocket); }
    for (const b of bombs) { reserve(b); reserved.push(b); }

    const availFor = (v) => (byValue[v] || []).filter(c => !used.has(c.id));
    const canUseValue = (v) => availFor(v).length > 0;
    const findRun = (need, minLen) => {
        for (let len = Math.min(12, Math.max(2, minLen)); len >= minLen; len--) {
            for (let start = 0; start + len <= 12; start++) {
                let ok = true;
                const vals = [];
                for (let i = 0; i < len; i++) {
                    const v = start + i;
                    if (!canUseValue(v) || availFor(v).length < need) { ok = false; break; }
                    vals.push(v);
                }
                if (!ok) continue;
                const seq = [];
                for (const v of vals) {
                    const it = availFor(v);
                    for (let k = 0; k < need; k++) seq.push(it[k]);
                }
                if (seq.length) return seq;
            }
        }
        return null;
    };

    // 连对 > 顺子，先把连续结构形成
    let pairRun = findRun(2, 3);
    if (pairRun) takeCards(pairRun);
    let straightRun = findRun(1, 5);
    if (straightRun) takeCards(straightRun);

    // 三带：优先三张本体，kicker 用剩余最小的牌，避免吃 A/2/王
    for (let v = 12; v >= 0; v--) {
        if ((byValue[13] && v === 13) || (byValue[14] && v === 14)) continue;
        const avail = availFor(v);
        if (avail.length < 3) continue;
        const triple = avail.slice(0, 3);
        const kickerList = remaining().filter(c => !triple.includes(c) && c.value !== v)
            .sort((a, b) => a.value - b.value);
        if (kickerList.length) takeCards([...triple, kickerList[0]]);
        else takeCards(triple);
    }

    // 剩余对子
    const rem = remaining().slice().sort((a, b) => a.value - b.value);
    for (let i = 0; i < rem.length - 1; i++) {
        if (rem[i] && rem[i + 1] && rem[i].value === rem[i + 1].value) {
            takeCards([rem[i], rem[i + 1]]);
            i++;
        }
    }

    // 单张
    for (const c of remaining()) takeCards([c]);

    // 预留牌放最后（炸弹/王炸不该作为常规先手）
    for (const play of reserved) unreservePlay(play);

    let score = 0;
    for (const pl of plays) {
        const t = getCardType(pl);
        if (!t) continue;
        let base = pl.length * 2;
        if (t.type === CardType.STRAIGHT) base += 8 + t.length * 2;
        else if (t.type === CardType.STRAIGHT_PAIR) base += 8 + t.length * 2;
        else if (t.type === CardType.PLANE) base += 8 + t.length * 2;
        else if (t.type === CardType.TRIPLE) base += 3;
        else if (t.type === CardType.PAIR) base += 1;
        else if (t.type === CardType.BOMB || t.type === CardType.ROCKET) base -= 2;
        score += base;
    }
    return { plays, score };
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
const ENDGAME_PASS = { __endgamePass: true };
// 关键改进：① 支持"过牌"作为根候选（原实现漏掉，会错失配合/留牌最优解）
//           ② 终局收益与深度解耦，置换表可跨路径复用（原实现按深度存，复用不安全）
//           ③ 手牌以"点数多重集"做键，同点不同花视为等价，TT 命中率显著提升
//           ④ 不再 JSON 深拷贝整个 state，改为对当前手牌 make/undo
// 残局被预算截断时的静态估值：改用「还差几手出完」而不是牌数，
// 与真实目标（手数）一致；牌数/大牌只作为平手时的微调。
function _staticEvalHands(hands, mySide) {
    let score = 0;
    for (let i = 0; i < 3; i++) {
        const sign = mySide.includes(i) ? 1 : -1;
        const p = hands[i] || [];
        if (!p.length) continue;
        // 残局估值也消费统一参数表：结构分（缩放进 ±60 值域）+ 手数主导项
        const turns = _fastHandTurns(p);
        const hp = handPotential(p) * 0.06;
        let v = hp + 8 - turns * (cfg('handPotentialCoeffs').turnsPenalty || 3.5) - p.length * 0.5;
        score += sign * v;
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

function _endgameKeyFast(hands, cp, lastPlay, passCount, plies) {
    let k = cp + '|' + passCount + '|' + (lastPlay ? lastPlay.type + ':' + lastPlay.value + ':' + (lastPlay.length || 0) : '-');
    if (plies !== undefined) k += '|p' + plies;
    for (let i = 0; i < 3; i++) {
        k += '|' + hands[i].map(c => c.value).sort((a, b) => a - b).join('.');
    }
    return k;
}

function _applyPlay(hands, cp, cards) {
    const hand = hands[cp];
    for (let i = 0; i < cards.length; i++) {
        const cid = cards[i].id;
        let idx = hand.findIndex(c => c.id === cid);
        if (idx < 0) idx = hand.indexOf(cards[i]);
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

    // 深度限制（可选）：ctx.maxPlies 生效时把 plies 计入置换表键，保证缓存正确
    // ctx 始终共享（节点计数/截断标记都在 ctx 上），深度通过保存-恢复实现。
    const plies = ctx.plies || 0;
    const limited = ctx.maxPlies !== undefined && ctx.maxPlies !== null && ctx.maxPlies > 0;
    if (limited && plies >= ctx.maxPlies) {
        return _staticEvalHands(hands, mySide);
    }
    const nextCtx = ctx;

    const key = limited ? _endgameKeyFast(hands, cp, lastPlay, passCount, plies) : _endgameKeyFast(hands, cp, lastPlay, passCount);
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

    if (limited) ctx.plies = plies + 1;
    if (needBeat) {
        // 过牌分支
        const val = endgameMinimax(hands, (cp + 1) % 3, lastPlay, lastPlayerId, passCount + 1, mySide, nextCtx, alpha, beta);
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
                val = endgameMinimax(hands, (cp + 1) % 3, getCardType(p), cp, 0, mySide, nextCtx, alpha, beta);
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

    if (limited) ctx.plies = plies;
    if (!ctx.truncated && !childTruncated) {
        let flag = 'exact';
        if (best <= origAlpha) flag = 'upper';
        else if (best >= beta) flag = 'lower';
        ctx.tt.set(key, { value: best, flag });
    }
    return best;
}

// 兼容旧签名（ai_learner 的精确解会调用）
// maxDepth > 0 且 < 20 时启用深度限制（深度计入置换表键，保证缓存正确）
function minimaxEndgame(state, currentPlayer, myId, depth, maxDepth, alpha = -999, beta = 999, ctx) {
    const useDepth = typeof maxDepth === 'number' && maxDepth > 0 && maxDepth < 20;
    if (!ctx) {
        ctx = { nodes: 0, limit: 60000, tt: new Map(), truncated: false, deadline: Date.now() + 400 };
        if (useDepth) { ctx.maxPlies = maxDepth; ctx.plies = 0; }
    } else if (useDepth && ctx.maxPlies === undefined) {
        ctx.maxPlies = maxDepth; ctx.plies = depth || 0;
    }
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
    if (needBeat) options.push(ENDGAME_PASS); // 过牌
    // 以学习到的启发式评分排序：保证即使预算截断，回退的也是 AI 默认最想出的牌，
    // 使残局求解成为"启发式的严格改进"而非另起炉灶。
    const mem = _memoryFromState(state);
    const role = (playerId === state.landlord) ? 'landlord' : 'farmer';
    const scoreOf = (p) => {
        if (p === ENDGAME_PASS) return computePassScore(role, state);
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
        if (p === null || p === ENDGAME_PASS) {
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
    if (needBeat) options.push(ENDGAME_PASS); // 过牌

    const role = (playerId === state.landlord) ? 'landlord' : 'farmer';
    const mem = opts.memory || null;
    const scoreOf = (p) => {
        if (p === null || p === ENDGAME_PASS) return computePassScore(role, state);
        try {
            const f = extractPlayFeatures(p, hand, state.lastPlay, role, mem, state);
            return scorePlay(f, role, mem, state, hand);
        } catch (e) { return 0; }
    };
    options.sort((a, b) => scoreOf(b) - scoreOf(a));
    // 残局候选过多会让每个候选分到的搜索时间过短 → 全部被截断 → 残局搜索退化为启发式。
    // 这里保留启发式排序最靠前的候选（覆盖多种牌型）+ 过牌，限制候选规模。
    const maxOptions = Math.max(4, Math.min(10, opts.maxOptions || (cfg('endgame.maxOptions') || 8)));
    let trimmedOptions = options.slice(0, maxOptions);
    // 一手清是确定的胜利（自己的手牌是精确信息），不能被启发式排序裁掉
    for (const p of options) {
        if (p && p.length === hand.length && !trimmedOptions.includes(p)) trimmedOptions.push(p);
    }
    if (needBeat && !trimmedOptions.includes(ENDGAME_PASS)) trimmedOptions.push(ENDGAME_PASS);

    const worlds = Math.max(1, opts.worlds || 4);
    // 世界质量：按难度取配置（每个世界采样多个候选并按公开历史一致性择优）
    const worldQuality = Math.max(1, opts.worldQuality ||
        (cfg('blind.worldQuality.' + (opts.difficulty || 'hard')) || 1));
    const budgetMs = opts.timeBudgetMs !== undefined ? opts.timeBudgetMs : (cfg('blind.endgameTimeBudgetMs') || 600);
    const determin = isDeterministicSearch();
    const deadline = determin ? 0 : (Date.now() + budgetMs);
    const nodeLimit = opts.nodeLimit || (cfg('endgame.nodeLimit') || 200000);
    // 确定性模式：每个候选固定节点预算（与挂钟无关 → 可复现）
    // nodeBudget 的语义是「本次残局求解的**总**节点预算」，
    // 而不是「每个候选的节点预算」—— 后者会让总开销放大到
    // 候选数 × 世界数 倍（8 候选 × 2 世界 × 1200 节点 = 19200 次 getAllValidPlays），
    // 单次决策就能吃掉好几秒。
    const detNodeBudget = Math.max(300, cfg('search.nodeBudget') || 12000);
    const perCandidateNodes = Math.max(40, Math.floor(detNodeBudget / Math.max(1, trimmedOptions.length * worlds)));
    const perWorldLimit = determin ? detNodeBudget : Math.max(20000, Math.floor(nodeLimit / worlds));
    const lambda = opts.robustness !== undefined ? opts.robustness : (cfg('blind.robustness') !== undefined ? cfg('blind.robustness') : 0.25);
    const mySide = (playerId === state.landlord) ? [playerId] : [0, 1, 2].filter(i => i !== state.landlord);
    const keyOf = (p) => (p === null || p === ENDGAME_PASS) ? 'pass' : p.map(c => c.id).sort().join(',');
    const agg = new Map();
    // 跨候选/跨世界共享置换表：
    // _endgameKeyFast 用的是「点数多重集」，不同候选走出的后续局面经常重合，
    // 每个候选各建一张 TT 等于把同一批子局面反复算一遍。共享 TT 可以把同样的
    // 节点预算换成更多世界/候选（节点数与候选数解耦）。
    // TT 条目带 exact/lower/upper 标记，跨候选复用是安全的（键已包含全部必要信息）。
    const sharedTT = new Map();

    let evaluatedWorlds = 0;
    // 每个候选平均分到的时间片；候选越多每片越短，但总时间受全局 deadline 约束
    const perCandidateMs = Math.max(30, Math.floor(budgetMs / Math.max(1, worlds * trimmedOptions.length)));
    for (let w = 0; w < worlds; w++) {
        if (!determin && Date.now() > deadline) break;
        const worldPlayers = belief.sampleWorld(worldQuality);
        const hands = worldPlayers.map(p => [...p]);
        evaluatedWorlds++;
        // 每个候选使用独立 ctx（节点计数/截断标记各自独立），
        // 但置换表共享；某个候选被截断时不会污染后续候选，也不会把整轮搜索提前结束。
        for (const p of trimmedOptions) {
            if (!determin && Date.now() > deadline) break;
            const ctx = determin ? {
                nodes: 0, limit: perCandidateNodes, tt: sharedTT, truncated: false, deadline: 0
            } : {
                nodes: 0, limit: perWorldLimit, tt: sharedTT, truncated: false,
                deadline: Math.min(deadline, Date.now() + perCandidateMs)
            };
            let val;
            if (p === null || p === ENDGAME_PASS) {
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
            if (ctx.truncated) continue;
            const key = keyOf(p);
            let e = agg.get(key);
            if (!e) { e = { sum: 0, sq: 0, n: 0, play: p }; agg.set(key, e); }
            e.sum += val; e.sq += val * val; e.n++;
        }
    }

    // 候选可能只覆盖部分世界；用覆盖率惩罚替代"必须覆盖所有世界"的硬门槛，
    // 否则预算稍紧就会把所有候选一起丢掉，残局搜索完全失效。
    let bestPlay = null, bestScore = -Infinity, found = false;
    for (const e of agg.values()) {
        if (e.n <= 0) continue;
        const mean = e.sum / e.n;
        const variance = Math.max(0, e.sq / e.n - mean * mean);
        const coverage = evaluatedWorlds > 0 ? e.n / evaluatedWorlds : 0;
        // coverage 惩罚按终局值域（±100）缩放：旧 0.2 相对收益完全可忽略
        const score = mean - lambda * Math.sqrt(variance) - 3 * (1 - coverage);
        if (score > bestScore) { bestScore = score; bestPlay = e.play; found = true; }
    }
    if (found) {
        // 公开信息里的协作先验：盲搜索采样的是"随机可能世界"，看不到队友的真实残牌，
        // 容易在队友快走完时抢牌权、或地主快走完时把牌权让出去。这里只在两个明确局面
        // 用公开张数做兜底，不改动其它候选之间的搜索排序。
        try {
            if (needBeat && role === 'farmer') {
                const partnerId = [0, 1, 2].find(i => i !== playerId && i !== state.landlord);
                const isPass = bestPlay === null || bestPlay === ENDGAME_PASS;
                const lordCards = state.players[state.landlord] ? state.players[state.landlord].length : 17;
                const lastId = state.lastPlayerId;
                if (!isPass && partnerId !== undefined && lastId === partnerId) {
                    const partnerCards = state.players[partnerId] ? state.players[partnerId].length : 17;
                    if (partnerCards <= 3 && lordCards > 2 && bestPlay.length !== hand.length) return ENDGAME_PASS;
                }
                if (isPass && lastId === state.landlord && lordCards <= 2) {
                    const beats = plays.slice().sort((a, b) => getPlayPower(a) - getPlayPower(b));
                    const cheap = beats.find(p => {
                        const t = getCardType(p);
                        return t && t.type !== CardType.BOMB && t.type !== CardType.ROCKET;
                    });
                    if (cheap) return cheap;
                }
            }
        } catch (e) {}
        return bestPlay;
    }
    for (const o of trimmedOptions) if (o && o.length > 0) return o;
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
// continuous = true 时返回 [-1,1] 的连续值（MCTS 用，信息量比二值胜负大得多）
function heuristicPlayoutWithMode(state, startPlayer, myId, memory, deterministic, continuous) {
    let s = _cloneStateShallow(state);
    let cp = startPlayer;
    let mySide = (myId === s.landlord) ? [myId] : [0,1,2].filter(i => i !== s.landlord);
    const hp = cfg('heuristicPlayout');
    for (let step = 0; step < hp.stepLimit; step++) {
        for (let i = 0; i < 3; i++) {
            if (s.players[i].length === 0) return continuous ? (mySide.includes(i) ? 1 : -1) : mySide.includes(i);
        }
        if (s.passCount >= 2) { s.lastPlay = null; s.lastPlayerId = -1; s.passCount = 0; }
        s.currentPlayer = cp;
        let hand = s.players[cp];
        if (!hand || hand.length === 0) { cp = (cp + 1) % 3; continue; }
        let needBeat = s.lastPlay && s.lastPlayerId !== cp;
        // rollout 用精简候选集：组合牌型（三带一/四带二/飞机带翅膀）的候选数是
        // 组合爆炸的，全枚举会把每次 rollout 拖慢好几倍。
        // 根节点与 MCTS 扩展仍然用完整集合（不能漏掉好棋）。
        const comboCap = hp.maxComboPerGroup || 0;
        let plays = needBeat
            ? getAllValidPlays(hand, s.lastPlay, comboCap ? { maxComboPerGroup: comboCap } : undefined)
            : getAllValidPlays(hand, null, comboCap ? { maxComboPerGroup: comboCap } : undefined);
        if (plays.length === 0) { s.passCount++; cp = (cp + 1) % 3; continue; }
        const role = cp === s.landlord ? 'landlord' : 'farmer';
        const maxOutsideForRollout = memory && memory.getMaxOutside ? memory.getMaxOutside(hand) : 0;
        const minP = needBeat ? minBeatPower(s.lastPlay.type, s.lastPlay.value, s.lastPlay.length) : 0;
        let best = null, bestScore = -Infinity, bestOver = Infinity;
        let second = null, secondScore = -Infinity;
        let third = null, thirdScore = -Infinity;
        const richCands = [];
        for (let i = 0; i < plays.length; i++) {
            const pl = plays[i];
            const t = playTypeOf(pl);
            if (!t) continue;
            const pw = typePowerOf(t.type, t.value, t.length);
            // 粗排加入手数下降量 + 控制权：纯"长度×4 − 牌力×0.25"会让 rollout
            // 中地主无脑甩长牌、不留 2/王（实测地主胜率因此被压低）。
            const rest = hand.filter(c => !pl.includes(c));
            let sc = pl.length * 4 - pw * 0.25 - _fastHandTurns(rest) * 2;
            if (pw > maxOutsideForRollout) sc += 6;
            const nextCards = (s.players[(cp + 1) % 3] && s.players[(cp + 1) % 3].length) || 0;
            if (!needBeat && nextCards <= 2) {
                if (pl.length >= 3) sc += 35;
                else if (pl.length === 1 && nextCards <= 1) sc -= 90 - Math.min(pw, 20);
            }
            if (t.type === CardType.STRAIGHT || t.type === CardType.STRAIGHT_PAIR || t.type === CardType.PLANE) sc += 8;
            if (t.type === CardType.BOMB || t.type === CardType.ROCKET) sc -= 60;
            const over = needBeat ? (pw - minP) : 0;
            if (needBeat && over > 0) sc -= over * 0.6;
            richCands.push({ play: pl, score: sc });
            if (sc > bestScore) {
                third = second; thirdScore = secondScore;
                second = best; secondScore = bestScore;
                best = pl; bestScore = sc; bestOver = over;
            } else if (sc > secondScore) {
                third = second; thirdScore = secondScore;
                second = pl; secondScore = sc;
            } else if (sc > thirdScore) {
                third = pl; thirdScore = sc;
            }
        }
        if (!best) { s.passCount++; cp = (cp + 1) % 3; continue; }
        // 关键候选用完整启发式重打分：先按结构分排序并保留牌型多样性。
        //
        // 这里刻意**不**对全部候选调用 scorePlay：
        //   1) 性能：scorePlay 是搜索里最贵的函数（要抽特征 + 查规则），
        //      原实现每步要给 8 个候选打分 → 每次 rollout 成本翻倍。
        //   2) 质量：rollout 策略如果和根节点用同一个 scorePlay，
        //      MCTS 搜索的就是「我自己启发式的延伸」，会把启发式的盲点一起放大。
        //      用「便宜的排序 + 少量精排」能让 rollout 与根评估部分解耦。
        let aiDiff = 'hard';
        try { if (typeof globalThis !== 'undefined' && globalThis.__aiDifficulty) aiDiff = globalThis.__aiDifficulty; } catch (e) {}
        const RICH_MAX = cfg('heuristicPlayout.richCandidatesByDiff.' + aiDiff) ||
            cfg('heuristicPlayout.richCandidates') || 4;
        const richPool = [];
        const seenRich = new Set();
        const pushRich = (pl) => {
            if (!pl || !pl.length) return;
            const key = _playKey(pl);
            if (seenRich.has(key)) return;
            seenRich.add(key);
            richPool.push(pl);
        };
        const sortedRich = richCands.slice().sort((a, b) => b.score - a.score);
        pushRich(best); pushRich(second); pushRich(third);
        const seenTypes = new Set();
        for (const entry of sortedRich) {
            const t = playTypeOf(entry.play);
            if (!t) continue;
            if (!seenTypes.has(t.type)) { seenTypes.add(t.type); pushRich(entry.play); }
            if (richPool.length >= RICH_MAX) break;
        }
        for (const entry of sortedRich) {
            if (richPool.length >= RICH_MAX) break;
            pushRich(entry.play);
        }
        if (richPool.length > 1 && typeof scorePlay === 'function') {
            let rBest = null, rScore = -Infinity;
            for (const cand of richPool) {
                try {
                    const feat = extractPlayFeatures(cand, hand, s.lastPlay, role, memory, s);
                    const sc = scorePlay(feat, role, memory, s, hand);
                    if (sc > rScore) { rScore = sc; rBest = cand; }
                } catch (e) { /* 忽略单候选异常 */ }
            }
            if (rBest) best = rBest;
        }
        if (needBeat) {
            const lastId = s.lastPlayerId;
            const lastCards = (s.players[lastId] && s.players[lastId].length) || 0;
            const mateLead = role === 'farmer' && lastId !== s.landlord;
            const oppUrgent = lastCards <= 2;
            const cheap = bestOver <= 4;
            let doPass = false;
            if (mateLead) {
                // 队友领出：默认让牌。但如果队友并不领先、且地主/对手下一家很紧，
                // 需要允许一次“低价接管”，而不是永远机械过牌。
                const nextAfter = (cp + 1) % 3;
                const lordRem = s.players[s.landlord] ? s.players[s.landlord].length : 17;
                const partnerCards = (s.players[lastId] && s.players[lastId].length) || 0;
                const lordIsNext = role === 'farmer' && nextAfter === s.landlord;
                doPass = !(lordIsNext && lordRem <= 4 && partnerCards > 2 && cheap);
            } else if (!cheap && !oppUrgent) doPass = true;
            if (doPass) {
                s.passCount = (s.passCount || 0) + 1;
                if (s.passCount >= 2) { s.lastPlay = null; s.lastPlayerId = -1; s.passCount = 0; }
                cp = (cp + 1) % 3;
                continue;
            }
        }
        let chosenPlay = best;
        if (!deterministic) {
            const r = Math.random();
            if (r >= hp.bestProb && second) chosenPlay = second;
            if (r >= hp.top2Prob && third) chosenPlay = third;
        }
        s.players[cp] = s.players[cp].filter(c => !chosenPlay.includes(c));
        s.lastPlay = getCardType(chosenPlay);
        s.lastPlayerId = cp;
        s.passCount = 0;
        if (s.players[cp].length === 0) return continuous ? (mySide.includes(cp) ? 1 : -1) : mySide.includes(cp);
        cp = (cp + 1) % 3;
    }
    return continuous ? _playoutTerminalScore(s, mySide) : _playoutTerminalEval(s, mySide);
}

function _handTurnsEstimate(hand) {
    if (!hand || hand.length === 0) return 0;
    if (hand.length > 20) return Math.ceil(hand.length / 2);
    // rollout 里每秒要调用很多次 → 用轻量贪心估计，不跑完整 beam 分解
    return Math.max(1, _fastHandTurns(hand));
}
function _sideTurnsEstimate(players, side) {
    let turns = 0;
    for (const i of side) turns += _handTurnsEstimate(players[i] || []);
    return turns;
}

// 终局估值：按**赛跑语义**比较，而不是简单比较双方牌数。
//   地主赢的条件 = 地主比**最快的那个农民**先走完；
//   农民赢的条件 = **最快的农民**比地主先走完。
// 旧实现比较「我方牌数 vs 对方牌数」，把两个农民的牌数加起来跟地主比 ——
// 口径不对（地主只要先走完就赢，不需要比农民两张牌谁多）。
function _playoutTerminalScore(s, mySide) {
    const landlord = s.landlord;
    const lordTurns = _fastHandTurns(s.players[landlord] || []);
    const farmerIds = [0, 1, 2].filter(i => i !== landlord);
    let farmerTurns = Infinity, farmerCards = 0, farmerPower = 0;
    for (const i of farmerIds) {
        const p = s.players[i] || [];
        farmerTurns = Math.min(farmerTurns, _fastHandTurns(p));
        farmerCards += p.length;
        for (const c of p) farmerPower += 1 + (c.value >= 12 ? 3 : 0) + (c.value >= 11 ? 1 : 0);
    }
    const lordHand = s.players[landlord] || [];
    let lordCards = lordHand.length, lordPower = 0;
    for (const c of lordHand) lordPower += 1 + (c.value >= 12 ? 3 : 0) + (c.value >= 11 ? 1 : 0);
    const iAmLandlord = mySide.includes(landlord);
    const myTurns = iAmLandlord ? lordTurns : farmerTurns;
    const oppTurns = iAmLandlord ? farmerTurns : lordTurns;
    const myCards = iAmLandlord ? lordCards : farmerCards;
    const oppCards = iAmLandlord ? farmerCards : lordCards;
    const myPower = iAmLandlord ? lordPower : farmerPower;
    const oppPower = iAmLandlord ? farmerPower : lordPower;
    if (myTurns !== oppTurns) {
        // 连续值：领先 1 手 ≈ 0.34，领先 3 手及以上接近饱和
        return Math.max(-1, Math.min(1, (oppTurns - myTurns) / 3));
    }
    if (myCards !== oppCards) return (myCards < oppCards) ? 0.2 : -0.2;
    if (myPower !== oppPower) return (myPower > oppPower) ? 0.1 : -0.1;
    return 0;
}
function _playoutTerminalEval(s, mySide) {
    return _playoutTerminalScore(s, mySide) >= 0;
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
                const keepSet = new Set();
                const seenType = new Set();
                for (const p of sorted) {
                    const t = playTypeOf(p);
                    if (!t) continue;
                    if (!seenType.has(t.type)) { seenType.add(t.type); keepSet.add(p); }
                    if (keepSet.size >= cap) break;
                }
                for (const p of sorted) {
                    if (keepSet.size >= cap) break;
                    keepSet.add(p);
                }
                for (const p of sorted) {
                    const t = playTypeOf(p);
                    if (t && (t.type === CardType.BOMB || t.type === CardType.ROCKET)) keepSet.add(p);
                    if (p.length === hand.length) keepSet.add(p);
                }
                plays = [...keepSet];
            }
            if (isRoot) {
                // 战术过滤：防止短视推演诱导出"开局扔王炸 / 用大牌硬压小牌 / 压队友"等下策
                const role = this.playerToMove === st.landlord ? 'landlord' : 'farmer';
                let partnerId = -1;
                if (role === 'farmer') for (let i = 0; i < 3; i++) if (i !== this.playerToMove && i !== st.landlord) { partnerId = i; break; }
                const lordRem = st.players[st.landlord] ? st.players[st.landlord].length : 17;
                const oppRem = role === 'farmer' ? lordRem
                    : Math.min(st.players[(this.playerToMove + 1) % 3] ? st.players[(this.playerToMove + 1) % 3].length : 17,
                               st.players[(this.playerToMove + 2) % 3] ? st.players[(this.playerToMove + 2) % 3].length : 17);
                const urgent = oppRem <= 3;
                if (!urgent) {
                    const noBomb = plays.filter(p => {
                        const t = playTypeOf(p);
                        return !(t && (t.type === CardType.BOMB || t.type === CardType.ROCKET));
                    });
                    if (noBomb.length) {
                        const bombs = plays.filter(p => {
                            const t = playTypeOf(p);
                            return t && (t.type === CardType.BOMB || t.type === CardType.ROCKET);
                        });
                        if (bombs.length) noBomb.push(bombs[0]);
                        plays = noBomb;
                    }
                }
                // 「压牌幅度上限」的硬过滤已移除：
                // 它会直接剪掉"必须用大牌压住才能保住结构"的正解。
                // scorePlay 里本来就有 overshoot 惩罚（超大牌压小牌扣分），
                // 改成软先验更安全：让搜索自己判断，而不是规则替它判断。
                if (needBeat) {
                    // 队友领出时，压牌幅度小的走法保留在分支里，但先验更低（见 _buildRootPriors）
                }
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
        newState.currentPlayer = nextPlayer;
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
        let best = null, bestScore = -Infinity;
        const logN = Math.log(Math.max(2, maxVisits));
        for (let c of this.children) {
            if (c.visits < Math.max(2, maxVisits * 0.15)) continue;
            const rate = c.wins / c.visits;
            // 访问量越少，下界惩罚越大：避免低样本节点靠运气胜出。
            const score = rate - Math.sqrt(logN / c.visits);
            if (score > bestScore) { bestScore = score; best = c; }
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
    const allowEarlyStop = !(opts && opts.earlyStop === false);
    const determin = isDeterministicSearch();
    for (let i = 0; i < iterations; i++) {
        if (!determin && Date.now() - startTime > timeLimit) break;
        if (allowEarlyStop && (i & 63) === 63 && root.children.length > 1) {
            let maxV = 0;
            for (const c of root.children) if (c.visits > maxV) maxV = c.visits;
            if (maxV >= 400) {
                let topRate = -1, secondRate = -1;
                for (const c of root.children) {
                    if (c.visits < Math.max(1, maxV * 0.2)) continue;
                    const r = c.visits > 0 ? c.wins / c.visits : 0;
                    if (r > topRate) { secondRate = topRate; topRate = r; }
                    else if (r > secondRate) secondRate = r;
                }
                if (topRate >= 0.90 && topRate - secondRate >= 0.04) break;
            }
        }
        let node = root;
        while (!node.isTerminal && node.children.length > 0 && node.isFullyExpanded) node = node.selectChild();
        if (!node.isTerminal && !node.isFullyExpanded) node = node.expand();
        let result;
        if (node.isTerminal) {
            let mySide = (playerId === node.state.landlord) ? [playerId] : [0,1,2].filter(i => i !== node.state.landlord);
            result = node.state.players.some((p, i) => mySide.includes(i) && p && p.length === 0) ? 1 : -1;
        } else {
            // 连续值 [-1,1]（按"谁更接近走完"评估），比二值胜负信息量大得多：
            // 二值时"赢"和"差一步就输"在统计上完全等价，搜索无法朝后者收敛。
            result = heuristicPlayoutWithMode(node.state, node.playerToMove, playerId, memory, false, true);
        }
        // 反向传播：每个节点记录"走到该节点的-player-的期望收益"，
        // 不同阵营的走法必须取反（否则 MCTS 会把对手也当成在帮己方走牌，搜索完全失效）。
        let mySide = (playerId === state.landlord) ? [playerId] : [0, 1, 2].filter(i => i !== state.landlord);
        let cur = node;
        while (cur && cur.parent) {
            const moverIsMySide = mySide.includes(cur.parent.playerToMove);
            const val = moverIsMySide ? result : -result;
            cur.visits++;
            cur.wins += val;
            cur = cur.parent;
        }
        if (root) root.visits++;
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
// 跨 Worker / 跨世界聚合 MCTS 根统计，返回最稳健的走法。
// 优先用「最小最大遗憾」聚合（各 Worker 已按自己的世界集合算好遗憾）；
// 没有遗憾数据时退回「均值 − λ×标准差」。
function selectPlayFromMctsAgg(entries, worlds, lambda) {
    const agg = new Map();
    for (const item of entries || []) {
        if (!item || !item.key) continue;
        let a = agg.get(item.key);
        if (!a) { a = { visits: 0, wins: 0, play: item.play || [], rates: [], regretW: 0, regretSum: 0, regretSq: 0, regretN: 0 }; agg.set(item.key, a); }
        a.visits += item.visits || 0;
        a.wins += item.wins || 0;
        if (Array.isArray(item.rates)) a.rates.push(...item.rates);
        else if (item.visits > 0) a.rates.push(item.wins / item.visits);
        if (typeof item.meanRegret === 'number') {
            const w = Math.max(1, item.visits || 1);
            a.regretSum += item.meanRegret * w;
            // item.stdRegret 是标准差，合并成方差需先平方；下面的 regretSq/regretW 再开根号
            a.regretSq += (item.stdRegret || 0) ** 2 * w;
            a.regretW += w;
            a.regretN++;
        }
    }
    if (!agg.size) return null;
    let maxVisits = 0;
    for (const a of agg.values()) maxVisits = Math.max(maxVisits, a.visits);
    const totalWorlds = Math.max(1, worlds || 1);
    const lam = lambda === undefined ? 0.25 : lambda;
    let best = null, bestScore = Infinity;
    for (const a of agg.values()) {
        const rate = a.visits > 0 ? a.wins / a.visits : 0;
        let score;
        if (a.regretW > 0) {
            const meanRegret = a.regretSum / a.regretW;
            const stdRegret = Math.sqrt(a.regretSq / Math.max(1, a.regretW));
            const coverage = a.rates.length / totalWorlds;
            score = meanRegret + lam * stdRegret + 0.5 * (1 - Math.min(1, coverage));
        } else {
            const mean = a.rates.length ? a.rates.reduce((x, y) => x + y, 0) / a.rates.length : rate;
            let std = 0;
            if (a.rates.length > 1) {
                const variance = a.rates.reduce((x, y) => x + (y - mean) * (y - mean), 0) / a.rates.length;
                std = Math.sqrt(variance);
            }
            const coverage = a.rates.length / totalWorlds;
            score = -(mean - lam * std - 0.5 * (1 - coverage));   // 越小越好
        }
        if (score < bestScore) { bestScore = score; best = a.play; }
    }
    if (best) return best;
    let top = null;
    for (const a of agg.values()) if (!top || a.visits > top.visits) top = a;
    return top ? top.play : null;
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
    // 先验是「期望收益」的软先验（连续值语义，取值范围约 [-1,1]），
    // 不是「胜率」—— 早期实现用 0.5~0.85 的胜率语义，在连续奖励下会过度乐观。
    // 过牌先验：角色协作（队友领出→倾向过牌；地主领出且未接近走完→倾向压牌）
    if (needBeat) {
        let partnerId = -1;
        if (role === 'farmer') for (let i = 0; i < 3; i++) if (i !== playerId && i !== state.landlord) { partnerId = i; break; }
        const lordRem = state.players[state.landlord] ? state.players[state.landlord].length : 17;
        let passPrior = 0.12;
        if (role === 'farmer') {
            if (state.lastPlayerId === partnerId) passPrior = (state.players[partnerId] && state.players[partnerId].length <= 2) ? 0.65 : 0.30;
            else if (state.lastPlayerId === state.landlord) passPrior = lordRem <= 3 ? 0.18 : 0.04;
        } else {
            const farmerRem = Math.min(
                state.players[(playerId + 1) % 3] ? state.players[(playerId + 1) % 3].length : 17,
                state.players[(playerId + 2) % 3] ? state.players[(playerId + 2) % 3].length : 17);
            passPrior = farmerRem <= 2 ? 0.16 : 0.05;
        }
        map.set('pass', passPrior);
    }
    const minP = needBeat ? minBeatPower(state.lastPlay.type, state.lastPlay.value, state.lastPlay.length) : 0;
    for (let i = 0; i < scored.length; i++) {
        const key = scored[i].p.map(c => c.id).sort().join(',');
        const rank = Math.min(i, K);
        let prior = 0.26 * (1 - rank / Math.max(1, K));
        // 压牌幅度惩罚（替代原先的硬过滤）：用大牌硬压小牌要扣先验
        if (needBeat) {
            const t = getCardType(scored[i].p);
            if (t && t.type !== CardType.BOMB && t.type !== CardType.ROCKET) {
                const over = typePowerOf(t.type, t.value, t.length) - minP;
                if (over > 0) prior -= Math.min(0.2, over * 0.02);
            }
        }
        map.set(key, Math.max(-0.2, prior));
    }
    return map;
}

// ======================== ISMCTS（信息集 MCTS / 再确定性化） ========================
// PIMC（每个世界各搜一棵树再平均）的两个经典缺陷：
//   ① strategy fusion：不同世界的最优动作不同，均值/惩罚会把"哪个世界都不最优"的走法选出来；
//   ② 每个世界单独建树 → 搜索深度被世界数摊薄。
//
// ISMCTS 把树建在「信息集」上：
//   · 我方节点的动作选择**跨世界共享统计** → "这个动作在所有世界都站得住"由树结构保证；
//   · 对手节点是「随机节点」：每次迭代在当前世界里按策略模型抽一个对手动作；
//   · 每次迭代重新确定性化（从世界池里抽一个世界），避免在单个世界上过拟合。
//
// 世界池是预采样的（不是每次迭代都重采），否则采样开销会淹没搜索本身。
class ISMCTSNode {
    constructor(play, playerToMove, parent, key) {
        this.play = play;
        this.playerToMove = playerToMove;
        this.parent = parent || null;
        this.key = key;
        this.visits = 0;
        this.value = 0;
        this.children = new Map();
    }
}
function _ismctsSelectMyChild(node, C) {
    let best = null, bestScore = -Infinity;
    const logN = Math.log(Math.max(2, node.visits));
    for (const child of node.children.values()) {
        if (child.visits === 0) return child;      // 未访问优先
        const mean = child.value / child.visits;
        const score = mean + C * Math.sqrt(logN / child.visits);
        if (score > bestScore) { bestScore = score; best = child; }
    }
    return best;
}
// 对手动作模型：在当前世界里按启发式策略选一个动作（90% 最优 / 10% 次优，模拟对手的不确定性）
function _ismctsOpponentMove(st, cp) {
    const hand = st.players[cp];
    if (!hand || !hand.length) return [];
    const needBeat = st.lastPlay && st.lastPlayerId !== cp;
    const plays = needBeat ? getAllValidPlays(hand, st.lastPlay) : getAllValidPlays(hand, null);
    if (!plays.length) return [];
    let best = null, bestScore = -Infinity, second = null, secondScore = -Infinity;
    for (const p of plays) {
        const t = playTypeOf(p);
        if (!t) continue;
        let sc = p.length * 4 - typePowerOf(t.type, t.value, t.length) * 0.25;
        // 与 rollout 策略同源：用 scorePlay 精排（缓存后成本可控），
        // 旧实现的 90/10 贪心+次优比 PIMC 里真实搜索弱得多。
        try {
            const role = cp === st.landlord ? 'landlord' : 'farmer';
            const mem = null;
            sc = scorePlay(extractPlayFeatures(p, hand, st.lastPlay, role, mem, st), role, mem, st, hand);
        } catch (e) {}
        if (t.type === CardType.STRAIGHT || t.type === CardType.STRAIGHT_PAIR || t.type === CardType.PLANE) sc += 8;
        if (t.type === CardType.BOMB || t.type === CardType.ROCKET) sc -= 60;
        if (!needBeat) {
            const nextCards = (st.players[(cp + 1) % 3] && st.players[(cp + 1) % 3].length) || 0;
            if (nextCards <= 2) {
                if (p.length >= 3) sc += 35;
                else if (p.length === 1 && nextCards <= 1) sc -= 90 - Math.min(typePowerOf(t.type, t.value, t.length), 20);
            }
        }
        if (sc > bestScore) { second = best; secondScore = bestScore; best = p; bestScore = sc; }
        else if (sc > secondScore) { second = p; secondScore = sc; }
    }
    if (!best) return [];
    if (second && Math.random() < 0.1) return second;
    return best;
}
function mctsSearchISMCTS(state, playerId, belief, opts) {
    opts = opts || {};
    const determin = isDeterministicSearch();
    const useDiffBudgets = determin && cfg('search.useDifficultyBudgets') === true;
    const diffKey = opts.difficulty || 'hard';
    const iterations = determin
        ? (useDiffBudgets
            ? Math.max(cfg('search.minDifficultyIterations') || 100,
                Math.round((cfg('mcts.iterations.' + diffKey) || 300) * (cfg('search.difficultyBudgetScale') || 1)))
            : Math.max(1, cfg('search.mctsIterations') || 300))
        : (opts.iterations || cfg('mcts.iterations.hard') || 600);
    const budgetMs = opts.timeBudgetMs !== undefined ? opts.timeBudgetMs : (cfg('blind.mctsTimeBudgetMs.hard') || 1000);
    const deadline = determin ? 0 : (Date.now() + budgetMs);
    const memory = opts.memory || null;
    const worldQuality = Math.max(1, opts.worldQuality || (cfg('blind.worldQuality.' + (opts.difficulty || 'hard')) || 1));
    const priors = (cfg('blind.mctsRootPriors.' + (opts.difficulty || 'hard')) !== 0) ? _buildRootPriors(state, playerId, memory) : null;
    const C = cfg('mcts.ucbC') || 1.4;
    const hand = state.players[playerId];
    if (!hand || !hand.length) return null;
    const needBeatRoot = state.lastPlay && state.lastPlayerId !== playerId;
    const rootCandidates = needBeatRoot ? getAllValidPlays(hand, state.lastPlay) : getAllValidPlays(hand, null);
    if (!rootCandidates.length) return null;
    const root = new ISMCTSNode(null, state.currentPlayer, null, 'root');
    const keyOfPlay = (p) => (p && p.length) ? p.map(c => c.id).sort().join(',') : 'pass';
    const unexpanded = rootCandidates.map(p => ({ play: p, key: keyOfPlay(p) }));
    if (needBeatRoot) unexpanded.push({ play: [], key: 'pass' });
    // 根节点必须先把所有候选各展开一次，否则 UCB 会一直挑同一个高值子节点，
    // 整棵树退化成贪心（其余根走法从未被评估过）。
    const rootUnexpanded = unexpanded.slice();
    // 世界池：预采样若干世界，迭代时轮换使用（避免每次迭代都重采导致开销爆炸）
    const poolSize = Math.max(1, opts.worlds || cfg('blind.worlds.mcts.' + (opts.difficulty || 'hard')) || 3);
    const worldPool = [];
    for (let i = 0; i < poolSize; i++) worldPool.push(belief.sampleWorld(worldQuality));
    const mySide = (playerId === state.landlord) ? [playerId] : [0, 1, 2].filter(i => i !== state.landlord);
    const maxSteps = 36;

    for (let it = 0; it < iterations; it++) {
        if (!determin && Date.now() > deadline) break;
        const worldPlayers = worldPool[it % worldPool.length];
        const st = Object.assign({}, state, { players: worldPlayers.map(p => p.map(c => ({ ...c }))) });
        const path = [];
        let node = root;
        let result = 0;
        let steps = 0;
        while (steps < maxSteps) {
            steps++;
            let ended = false;
            for (let i = 0; i < 3; i++) {
                if (!st.players[i] || st.players[i].length === 0) {
                    result = mySide.includes(i) ? 1 : -1;
                    ended = true;
                    break;
                }
            }
            if (ended) break;
            const cp = node.playerToMove;
            let child = null;
            if (cp === playerId) {
                if (node === root && rootUnexpanded.length) {
                    // 根节点轮转展开：保证每个候选都被至少评估一次
                    const pick = rootUnexpanded.shift();
                    child = new ISMCTSNode(pick.play, (cp + 1) % 3, node, pick.key);
                    node.children.set(pick.key, child);
                    if (priors) {
                        const pr = priors.get(pick.key);
                        if (pr !== undefined && pr !== null) {
                            child.visits += MCTS_PRIOR_VISITS;
                            child.value += MCTS_PRIOR_VISITS * pr;
                        }
                    }
                } else {
                    child = _ismctsSelectMyChild(node, C);
                    if (!child) {
                        if (!unexpanded.length) break;
                        const pick = unexpanded.shift();
                        child = new ISMCTSNode(pick.play, (cp + 1) % 3, node, pick.key);
                        node.children.set(pick.key, child);
                        if (priors) {
                            const pr = priors.get(pick.key);
                            if (pr !== undefined && pr !== null) {
                                child.visits += MCTS_PRIOR_VISITS;
                                child.value += MCTS_PRIOR_VISITS * pr;
                            }
                        }
                    }
                }
            } else {
                const move = _ismctsOpponentMove(st, cp);
                // 牌型抽象键：不同采样世界里同语义的对手动作应合并到同一信息集节点，
                // 用具体牌 id 作键会让跨世界节点永远不重合（ISMCTS 失效的根因之一）。
                const mt = move && move.length ? getCardType(move) : null;
                const key = mt ? (CardType[mt.type] || mt.type) + ':' + mt.value + ':' + (mt.length || 0) : 'pass';
                child = node.children.get(key);
                if (!child) {
                    child = new ISMCTSNode(move || [], (cp + 1) % 3, node, key);
                    node.children.set(key, child);
                }
            }
            const chosen = child.play;
            path.push(child);
            if (!chosen || !chosen.length) {
                st.passCount = (st.passCount || 0) + 1;
            } else {
                const ids = new Set(chosen.map(c => c.id));
                st.players[cp] = st.players[cp].filter(c => !ids.has(c.id));
                st.lastPlay = getCardType(chosen);
                st.lastPlayerId = cp;
                st.passCount = 0;
            }
            if (st.passCount >= 2) { st.lastPlay = null; st.lastPlayerId = -1; st.passCount = 0; }
            st.currentPlayer = (cp + 1) % 3;
            node = child;
            if (steps >= maxSteps) { result = heuristicPlayoutWithMode(st, st.currentPlayer, playerId, memory, false, true); break; }
        }
        if (!result) result = heuristicPlayoutWithMode(st, st.currentPlayer, playerId, memory, false, true);
        for (let i = path.length - 1; i >= 0; i--) {
            const n = path[i];
            const moverIsMySide = n.parent ? mySide.includes(n.parent.playerToMove) : true;
            n.visits++;
            n.value += moverIsMySide ? result : -result;
        }
        root.visits++;
    }
    let best = null, bestScore = -Infinity;
    const logN = Math.log(Math.max(2, root.visits));
    for (const child of root.children.values()) {
        if (child.visits < 2) continue;
        const mean = child.value / child.visits;
        const score = mean - Math.sqrt(logN / child.visits);   // 保守下界（少访问的惩罚更重）
        if (score > bestScore) { bestScore = score; best = child; }
    }
    if (!best) {
        const first = root.children.values().next().value;
        best = first || null;
    }
    if (!best) return null;
    const play = best.play;
    if (!play.length && !needBeatRoot) return null;
    const rate = best.visits > 0 ? best.value / best.visits : 0;
    const result = { play, visits: best.visits, wins: Math.round(rate * best.visits) };
    // 根节点统计 → agg（跨 Worker 聚合需要同样的数据结构）
    if (opts.collectAll) {
        const entries = [];
        for (const child of root.children.values()) {
            if (!child.visits) continue;
            entries.push({
                key: child.key, visits: child.visits, wins: Math.round(child.value),
                play: child.play, rates: [child.value / child.visits]
                // 不写 meanRegret/stdRegret：ISMCTS 没有逐世界遗憾数据，
                // 让 selectPlayFromMctsAgg 回退到 rates 分支（旧写 0 会被当成"零遗憾最优"→ 必选错）
            });
        }
        if (entries.length) result.agg = entries;
    }
    return result;
}

function mctsSearchBlind(state, playerId, belief, opts) {
    opts = opts || {};
    const hand = state.players[playerId];
    if (!hand || !hand.length) return null;
    const needBeatRootEarly = state.lastPlay && state.lastPlayerId !== playerId;
    const rootPlaysEarly = getAllValidPlays(hand, needBeatRootEarly ? state.lastPlay : null);
    if (!rootPlaysEarly.length) {
        // 跟牌且一手都压不出 → 过牌是唯一合法解，不要进入 MCTS 空转整段时间预算
        if (needBeatRootEarly) return { play: [], visits: 0, wins: 0 };
        return null;
    }
    // 搜索模式：'pimc' = 每世界各搜一棵树再聚合；'ismcts' = 信息集共享树（再确定性化）
    const mode = opts.mode || cfg('blind.mctsMode') || 'pimc';
    if (mode === 'ismcts') {
        try {
            const r = mctsSearchISMCTS(state, playerId, belief, opts);
            if (r && Array.isArray(r.play)) return r;
        } catch (e) { /* 回退到 PIMC */ }
    }
    const determin = isDeterministicSearch();
    const diffKey = opts.difficulty || 'hard';
    const useDiffBudgets = determin && cfg('search.useDifficultyBudgets') === true;
    const worlds = determin
        ? (useDiffBudgets
            ? Math.max(1, cfg('blind.worlds.mcts.' + diffKey) || cfg('search.mctsWorlds') || 3)
            : Math.max(1, cfg('search.mctsWorlds') || 4))
        : Math.max(1, opts.worlds || 3);
    const iterations = determin
        ? (useDiffBudgets
            ? Math.max(cfg('search.minDifficultyIterations') || 100,
                Math.round((cfg('mcts.iterations.' + diffKey) || 300) * (cfg('search.difficultyBudgetScale') || 1)))
            : Math.max(1, cfg('search.mctsIterations') || 300))
        : (opts.iterations || cfg('mcts.iterations.hard') || 600);
    const budgetMs = opts.timeBudgetMs !== undefined ? opts.timeBudgetMs : (cfg('blind.mctsTimeBudgetMs.hard') || 1000);
    const deadline = determin ? 0 : (Date.now() + budgetMs);
    const memory = opts.memory || null;
    const worldQuality = Math.max(1, opts.worldQuality || (cfg('blind.worldQuality.' + (opts.difficulty || 'hard')) || 1));
    const priors = (cfg('blind.mctsRootPriors.' + (opts.difficulty || 'hard')) !== 0) ? _buildRootPriors(state, playerId, memory) : null;
    if (priors && opts.leadPref && opts.leadPref.length) {
        const lk = opts.leadPref.map(c => c.id).sort().join(',');
        priors.set(lk, Math.max(priors.get(lk) || 0, 0.3));
    }
    const lambda = opts.robustness !== undefined ? opts.robustness : (cfg('blind.robustness') !== undefined ? cfg('blind.robustness') : 0.25);
    const agg = new Map();
    const worldAgg = [];   // 每个世界一份根统计（用于计算"遗憾"）
    for (let w = 0; w < worlds; w++) {
        if (!determin && Date.now() > deadline) break;
        const worldPlayers = belief.sampleWorld(worldQuality);
        const worldState = Object.assign({}, state, { players: worldPlayers });
        const remainMs = deadline - Date.now();
        const perWorldTime = determin ? 1e9 : Math.max(50, Math.floor(remainMs / Math.max(1, worlds - w)));
        let res = null;
        try {
            res = mctsSearch(worldState, playerId, iterations, memory, perWorldTime, { collectStats: true, rootPriors: priors });
        } catch (e) { res = null; }
        if (!res || !res.stats) continue;
        const wmap = new Map();
        let wMax = -Infinity;
        for (const [key, e] of res.stats) {
            const rate = e.visits > 0 ? e.wins / e.visits : 0;
            wmap.set(key, rate);
            if (rate > wMax) wMax = rate;
        }
        worldAgg.push({ map: wmap, max: wMax });
        for (const [key, e] of res.stats) {
            let a = agg.get(key);
            if (!a) { a = { visits: 0, wins: 0, play: e.play, rates: [], regrets: [] }; agg.set(key, a); }
            a.visits += e.visits;
            a.wins += e.wins;
            if (e.visits > 0) a.rates.push(e.wins / e.visits);   // 每个世界里的期望收益
        }
    }
    if (!agg.size) return null;
    // ===== 跨世界聚合：最小最大遗憾（minimax regret）=====
    //
    // 旧做法是「均值 − λ×标准差」，属于 PIMC 的经典缺陷：
    // 当世界 W1 里最优走法是 A、世界 W2 里最优走法是 B 时，均值会把 A/B 都平庸的
    // C 选出来（strategy fusion）。遗憾聚合直接问："这个走法在每个世界里
    // 离该世界的最优走法差多少"，再最小化平均遗憾 —— 天然惩罚"只在某个世界好"的走法。
    const worldCount = Math.max(1, worldAgg.length);
    let best = null, bestScore = Infinity, bestRate = 0;
    for (const a of agg.values()) {
        const rate = a.visits > 0 ? a.wins / a.visits : 0;
        let meanRegret = 0, stdRegret = 0, covered = 0;
        if (worldAgg.length) {
            const regrets = [];
            for (const wa of worldAgg) {
                const r = wa.map.get(keyOfPlay(a.play));
                if (r === undefined) { regrets.push(wa.max - (-1)); continue; }  // 该世界没搜到 → 按最差算
                regrets.push(Math.max(0, wa.max - r));
                covered++;
            }
            meanRegret = regrets.reduce((x, y) => x + y, 0) / regrets.length;
            if (regrets.length > 1) {
                const varr = regrets.reduce((x, y) => x + (y - meanRegret) * (y - meanRegret), 0) / regrets.length;
                stdRegret = Math.sqrt(varr);
            }
        }
        a.meanRegret = meanRegret;
        a.stdRegret = stdRegret;
        a.coverage = covered / worldCount;
    }
    for (const [key, a] of agg.entries()) {
        const score = a.meanRegret + lambda * a.stdRegret + 0.5 * (1 - a.coverage);
        if (score < bestScore) { bestScore = score; best = a.play; bestRate = a.visits > 0 ? a.wins / a.visits : 0; }
    }
    if (!best) {
        let top = null;
        for (const a of agg.values()) if (!top || a.visits > top.visits) top = a;
        best = top ? top.play : null;
        bestRate = top && top.visits > 0 ? top.wins / top.visits : 0;
    }
    if (!best) return null;
    const needBeatRoot = state.lastPlay && state.lastPlayerId !== playerId;
    if (best.length > 0 || needBeatRoot) {
        const result = { play: best, visits: maxVisitsFor(agg), wins: Math.round(bestRate * maxVisitsFor(agg)) };
        if (opts.collectAll) {
            result.agg = [...agg.entries()].map(([key, a]) => ({
                key, visits: a.visits, wins: a.wins, play: a.play, rates: a.rates,
                meanRegret: a.meanRegret, stdRegret: a.stdRegret, coverage: a.coverage
            }));
        }
        return result;
    }
    return null;
}
function keyOfPlay(play) {
    if (!play || !play.length) return 'pass';
    return play.map(c => c.id).sort().join(',');
}
function maxVisitsFor(agg) {
    let m = 0;
    for (const a of agg.values()) if (a.visits > m) m = a.visits;
    return m;
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
    _setDifficultyContext() {
        try { if (typeof globalThis !== 'undefined') globalThis.__aiDifficulty = this.difficulty; } catch (e) {}
    }
    think(phase, state) {
        this._setDifficultyContext();
        if (phase === 'call') return this.callDecision(state);
        return this.playDecision(state);
    }
    _recordReasoning(chosen, source, scored) {
        try {
            const chosenType = chosen && chosen.length ? (getCardType(chosen) || {}).type || 'unknown' : 'pass';
            const list = Array.isArray(scored) ? scored : [];
            this.lastReasoning = {
                turn: 0,
                player: this.id,
                phase: 'play',
                source: source || 'heuristic',
                chosen: chosen || [],
                chosenScore: (list.find(s => s.chosen) || {}).score || 0,
                candidates: list.slice(0, 10).map(s => ({
                    type: s.play && s.play.length ? ((getCardType(s.play) || {}).type || 'unknown') : 'pass',
                    score: s.score,
                    isChosen: !!s.chosen || s.play === chosen
                }))
            };
            if (!list.length) {
                this.lastReasoning.candidates = [{ type: chosenType, score: 0, isChosen: true }];
            }
        } catch (e) { this.lastReasoning = null; }
    }
    callDecision(state) {
        this._setDifficultyContext();
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
        if (this.difficulty === 'hard' || this.difficulty === 'grandmaster' || this.difficulty === 'legendary') {
            // 叫分评估走"信念世界"多模拟，不窥视他人手牌。
            // 底牌在叫分阶段对任何玩家都不可见：只能从未见牌池采样 3 张作为
            // "我若成为地主会拿到的底牌"，绝不能读 state.lordCards。
            const worlds = Math.max(1, cfg('blind.worlds.call.' + this.difficulty) || 6);
            const callQuality = Math.max(1, Math.min(worlds, cfg('blind.callWorldQuality') || 2));
            const trials = cfg('blind.callTrials.' + this.difficulty) ||
                ({ hard: 20, grandmaster: 40, legendary: 60 }[this.difficulty] || 40);
            const ownIds = new Set(state.players[this.id].map(c => c.id));
            const seenIds = new Set();
            try { if (this.memory && this.memory.seen) for (const id of this.memory.seen) seenIds.add(id); } catch (e) {}
            const bottomPool = allCards().filter(c => !ownIds.has(c.id) && !seenIds.has(c.id));
            const sampleBottom = () => {
                const pool = bottomPool.slice();
                for (let i = pool.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
                }
                return pool.slice(0, 3).map(c => ({ ...c }));
            };
            let scoreSum = 0, scored = 0;
            for (let i = 0; i < trials; i++) {
                if (bottomPool.length < 3) break;
                const bottom = sampleBottom();
                const callState = Object.assign({}, state, {
                    landlord: this.id,
                    phase: 'playing',
                    players: state.players.map((p, idx) => (idx === this.id ? [...p, ...bottom] : p))
                });
                const belief = new HandBelief(this.id, callState, this.memory);
                const world = belief.sampleWorld(callQuality);
                const rs = Object.assign({}, state, {
                    landlord: this.id,
                    phase: 'playing',
                    players: world.map(p => p.map(c => ({ ...c })))
                });
                scoreSum += heuristicPlayoutWithMode(rs, this.id, this.id, this.memory, false, true);
                scored++;
            }
            const rawW = (scoreSum / Math.max(1, scored) + 1) / 2;
            // 先验收缩：把小样本估计拉向手牌强度映射的先验，降低误叫/漏叫
            const prior = Math.max(0.1, Math.min(0.9, 0.5 + evaluateHandStrength(state.players[this.id], this.memory, false, this.id) / 400));
            const winRate = (rawW * scored + prior * 12) / (scored + 12);
            let bestBid = 0, bestEV = 0;
            for (let bid = 1; bid <= 3; bid++) {
                if (bid <= curr) continue;
                // 与结算口径一致：赢 +100×底分，输 −100×底分（庄园/春天只是额外翻倍），
                // 所以 EV = bid*(2*winRate − 1)，胜率 > 0.5 就该叫。
                // 旧公式 bid*(3*winRate − 2) 错误地假设"输要赔两倍"，
                // 阈值被抬到 2/3 → 连双王四个A的牌都不叫（hard/legendary 从不叫地主）。
                // 风险建模：叫得越高，被他人抢地主/加倍后输的代价越大。
                // 用 bid 的幂次轻微惩罚高叫分（不是简单线性），并要求胜率高于 0.5 一定余量。
                const riskPremium = 0.02 * (bid - 1) * (bid - 1);
                let ev = bid * (2 * (winRate - riskPremium) - 1);
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
    // ===== 唯一出口守卫 =====
    // 所有分支（残局 / MCTS / 领出 / 跟牌 / 封锁）最终都必须给出「合法走法」：
    // 即属于 getAllValidPlays(hand, lastPlay) 的元素，或者（跟随时的）过牌。
    // 这里统一校验一次：不合法就打印诊断并回退到合法选择，绝不让非法走法流到上层
    // （上层会把整局判为 ILLEGAL_PLAY 作废，白白丢掉一局评测数据）。
    playDecision(state) {
        this._setDifficultyContext();
        let play;
        try { play = this._playDecisionImpl(state); }
        catch (e) {
            if (typeof console !== 'undefined') console.warn('[AI] playDecision threw:', e && e.message);
            play = [];
        }
        if (!Array.isArray(play)) play = [];
        const hand = (state && state.players && state.players[this.id]) || [];
        const needBeat = !!(state && state.lastPlay && state.lastPlayerId !== this.id);
        // 上层校验口径：需要跟牌时用 lastPlay 过滤；自己刚出过牌（lastPlayerId===id，
        // 即两人过牌后重新领出）时 lastPlay 在真实状态机里已被重置为 null。
        // 测试/重放状态可能残留 lastPlay → 这里同样按"领出"处理，避免误判合法领出为非法。
        const beatFilter = needBeat ? state.lastPlay : null;
        let legalPlays = [];
        try { legalPlays = getAllValidPlays(hand, beatFilter); } catch (e) { legalPlays = []; }
        if (play.length > 0) {
            let legal = false;
            try {
                const ids = new Set(play.map(c => c && c.id));
                legal = ids.size === play.length &&
                    legalPlays.some(p => p.length === play.length && p.every(c => ids.has(c.id)));
            } catch (e) { legal = false; }
            if (!legal) {
                if (typeof console !== 'undefined') {
                    console.warn('[AI] illegal play blocked:', JSON.stringify({
                        seat: this.id, diff: this.difficulty, needBeat,
                        len: play.length, ids: play.map(c => c && c.id),
                        type: (getCardType(play) || {}).type || null,
                        handLen: hand.length,
                        lastPlay: state.lastPlay ? (state.lastPlay.type + ':' + state.lastPlay.value) : null
                    }));
                }
                play = [];
            }
        }
        // 过牌只有在「需要跟牌」时才合法；领出方必须给出一手牌
        if (play.length === 0 && !needBeat && legalPlays.length) {
            try {
                play = this.selectLeadSmart(legalPlays, (this.id === state.landlord) ? 'landlord' : 'farmer', hand, state, null) || legalPlays[0];
            } catch (e) { play = legalPlays[0] || []; }
        }
        return play;
    }
    _playDecisionImpl(state) {
        this.lastReasoning = null;
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
        // 记录对手最近一次"需要跟牌却选择过牌"的公开信息，用于收窄其手牌信念
        if (state.passCount === 1 && state.lastPlay && state.lastPlayerId !== -1) {
            const passerId = (state.currentPlayer + 2) % 3;
            if (passerId !== this.id) {
                try { this.memory.recordPass(passerId, { type: state.lastPlay.type, value: state.lastPlay.value, length: state.lastPlay.length || 0 }); } catch (e) {}
            }
        }
        // ===== 公平性：只使用公开信息建立信念模型（对手手牌不可见） =====
        const belief = new HandBelief(this.id, state, this.memory);
        if (hand.length <= endgameLimit) {
            let egResult = solveEndgameBlind(state, this.id, belief, {
                worlds: cfg('blind.worlds.endgame.' + this.difficulty) || 4,
                worldQuality: cfg('blind.worldQuality.' + this.difficulty) || 1,
                timeBudgetMs: this.budgetMs('blind.endgameTimeBudgetMs.' + this.difficulty, 600),
                memory: this.memory,
                difficulty: this.difficulty
            });
            if (egResult !== null && egResult !== undefined) {
                const endgamePlay = (egResult === ENDGAME_PASS || egResult.__endgamePass) ? [] : egResult;
                this._recordReasoning(endgamePlay, 'endgame', []);
                return endgamePlay;
            }
        }
        let mctsLimit = cfg('mcts.handLimit.' + this.difficulty) || 0;
        let mctsIters = cfg('mcts.iterations.' + this.difficulty) || 0;
        if ((this.difficulty === 'hard' || this.difficulty === 'grandmaster' || this.difficulty === 'legendary') && hand.length <= mctsLimit) {
            let leadPref = null;
            let leadPool = [];
            try {
                leadPool = (lastPlay && state.lastPlayerId !== this.id)
                    ? getAllValidPlays(hand, lastPlay) : getAllValidPlays(hand, null);
                leadPref = this.selectLeadSmart(leadPool, role, hand, state, partnerId);
            } catch (e) { leadPref = null; }
            if (lastPlay && state.lastPlayerId !== this.id && leadPool.length === 0) {
                this._recordReasoning([], 'rule', []);
                return [];
            }
            const baseBudgetMs = this.budgetMs('blind.mctsTimeBudgetMs.' + this.difficulty, 1000);
            const mctsBudgetMs = adaptiveMctsBudget(this.difficulty, leadPool.length, hand.length, baseBudgetMs);
            let mctsResult = mctsSearchBlind(state, this.id, belief, {
                iterations: mctsIters,
                worlds: cfg('blind.worlds.mcts.' + this.difficulty) || 3,
                timeBudgetMs: mctsBudgetMs,
                memory: this.memory,
                difficulty: this.difficulty,
                leadPref: leadPref
            });
            if (mctsResult && Array.isArray(mctsResult.play)) {
                let needBeatMcts = lastPlay && state.lastPlayerId !== this.id;
                if (mctsResult.play.length > 0 || needBeatMcts) {
                    this._recordReasoning(mctsResult.play, 'mcts', []);
                    return mctsResult.play;
                }
            }
        }
        if (lastPlay && state.lastPlayerId !== this.id) {
            if (lastPlay.type === CardType.ROCKET) { this._recordReasoning([], 'rule', []); return []; }
            if (lastPlay.type === CardType.BOMB) {
                let hasBeatingBomb = Object.values(hand.reduce((a,c)=>(a[c.value]=(a[c.value]||0)+1,a),{})).some(v=>v===4);
                if (!hasBeatingBomb && !(hand.some(c=>c.value===13) && hand.some(c=>c.value===14))) { this._recordReasoning([], 'rule', []); return []; }
            }
        }
        if (!lastPlay || state.lastPlayerId === this.id) {
            let allPlays = getAllValidPlays(hand, null);
            let lead = this.selectLeadSmart(allPlays, role, hand, state, partnerId);
            return this.refineLeadByBelief(lead, allPlays, hand, state, role, belief);
        }
        let beatable = getAllValidPlays(hand, lastPlay);
        if (beatable.length === 0) { this._recordReasoning([], 'rule', []); return []; }
        // ===== 绝杀封锁：下家（对手）只剩 1 张 = 他再拿到一次出牌机会就赢了 =====
        // 用「对手绝对压不住」的单张（value > 记牌器算出的对手最大可能牌）堵住他这一手，
        // 他只能过牌，我们就多买到一个回合。对手只剩 1 张时不可能握有炸弹，封锁是确定的。
        {
            const nextP = (state.currentPlayer + 1) % 3;
            const nextHand = state.players[nextP] || [];
            const nextIsOpp = role === 'farmer' ? nextP === state.landlord : nextP !== state.landlord;
            if (nextIsOpp && nextHand.length === 1 && lastPlay && lastPlay.type === CardType.SINGLE) {
                // 下家只剩 1 张时不可能握炸；用「除他外的外部牌」推他这张牌的上界，
                // 而不是全桌 maxOut（大王若在第三者手里，旧规则会漏掉用 2 确定封锁的机会）。
                let maxOut = 0;
                try {
                    const rem = this.memory.getRemainingCounts ? this.memory.getRemainingCounts() : null;
                    if (rem) {
                        for (let v = 14; v >= 0; v--) {
                            let mine = 0;
                            for (const c of hand) if (c.value === v) mine++;
                            // "外面"还有这张牌，且握牌方可能是下家（只剩 1 张 → 至多 1 张同点）
                            if ((rem[v] || 0) - mine > 0) { maxOut = v; break; }
                        }
                    } else {
                        maxOut = this.memory.getMaxOutside(hand);
                    }
                } catch (e) { maxOut = 0; }
                const blocker = beatable.find(p => p.length === 1 && p[0].value > maxOut);
                if (blocker) {
                    this._recordReasoning(blocker, 'block', []);
                    return blocker;
                }
            }
        }
        let simWorlds = Math.max(1, cfg('blind.worlds.sim.' + this.difficulty) || 3);
        let simCache = null;
        let simDepth = cfg('simulation.depth.' + this.difficulty) || 0;
        let simHandLimit = cfg('simulation.handLimit.' + this.difficulty) || 0;
        let dpBonusFactor = cfg('simulation.dpBonusFactor.' + this.difficulty) || 0;
        let simMax = cfg('simulation.maxCandidates.' + this.difficulty) || 8;
        let dpMax = cfg('simulation.dpCandidates.' + this.difficulty) || 6;
        // 动态拆牌/剩余结构评分：出完此手后，剩余手牌结构越紧凑（出手步数越少、单张越少），分越高
        // 仅在残局（手牌较少）时启用动态拆牌/结构评分，避免中盘每步额外跑分解导致移动端卡顿
        const _structScore = (newHand) => {
            if (!newHand || newHand.length === 0) return 60;
            if (newHand.length > 12) return 0;
            // 拆牌已改为"点数计数 + 最少手数"目标，>15 张也能算（不再退化成贪心）
            let plan = decomposeHandDP(newHand);
            let turns = plan && plan.plays ? plan.plays.length : newHand.length;
            let feats = extractHandFeatures(newHand);
            return 50 - turns * 2.5 - feats.single * 1.5;
        };
        let baseScored = beatable.map(play => {
            let features = extractPlayFeatures(play, hand, lastPlay, role, this.memory, state);
            let newHand = hand.filter(c => !play.includes(c));
            let structScore = _structScore(newHand);
            return { play, score: scorePlay(features, role, this.memory, state, hand) + structScore * 2.0 };
        });
        baseScored.sort((a, b) => b.score - a.score);
        const simTargets = new Set(baseScored.slice(0, Math.max(1, simMax)).map(x => x.play));
        const dpTargets = new Set(baseScored.slice(0, Math.max(1, dpMax)).map(x => x.play));
        const baseSpread = baseScored.length > 1
            ? Math.max(0, baseScored[0].score - baseScored[baseScored.length - 1].score) : 0;
        const simCap = Math.max(6, baseSpread * 0.5);
        let scored = baseScored.map(entry => {
            let simScore = 0;
            if (simDepth > 0 && hand.length <= simHandLimit && simTargets.has(entry.play)) {
                if (!simCache) simCache = belief.sampleWorlds(simWorlds);
                simScore = simulateOpponentResponseBlind(entry.play, hand, state, role, this.memory, belief, simDepth, simCache);
                if (dpBonusFactor > 0 && dpTargets.has(entry.play)) {
                    let newHand = hand.filter(c => !entry.play.includes(c));
                    let dpPlan = newHand.length <= 15 ? decomposeHandDP(newHand) : greedyDecompose(newHand);
                    simScore += dpPlan.score * dpBonusFactor;
                }
            }
            const bonus = Math.max(-simCap, Math.min(simCap, simScore * 0.4));
            return { play: entry.play, score: entry.score + bonus };
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
        // ===== 宏观跟牌门禁：先判断"是否值得对付"，再决定出什么 =====
        // 若最佳非炸弹/王炸跟牌相对 pass 优势不明显，且对手快走完，直接放弃跟牌，
        // 避免"有能打的牌就硬跟，跟了更亏"的问题。
        const _bestEntry = scored[0];
        if (_bestEntry && _bestEntry.play.length > 0) {
            const _passEntry = scored.find(s => s.play.length === 0);
            const _passVal = _passEntry ? _passEntry.score : -Infinity;
            const _gap = _bestEntry.score - _passVal;
            const _topType = getCardType(_bestEntry.play);
            const _isBombRocket = _topType && (_topType.type === CardType.BOMB || _topType.type === CardType.ROCKET);
            const _oppClose = (state.lastPlayerId >= 0 && state.players[state.lastPlayerId]
                ? state.players[state.lastPlayerId].length : 17) <= 2;
            // 信念修正：若对手很可能压住我方这手跟牌 → 跟牌多半是送牌+丢控制权 → 倾向过牌
            let _likelyBeaten = false;
            try {
                // 威胁源应是「我出牌后的下一个行动者」= 下家，而不是本墩已出牌的 lastPlayerId。
                // 第三参必须是样本数（旧代码传了 state 对象 → NaN → 组合型恒返回 0）。
                const _nextId = (state.currentPlayer + 1) % 3;
                if (_nextId !== this.id) {
                    const _samples = cfg('blind.beatProbSamples.' + this.difficulty) || 6;
                    const _bp = belief.beatProbability(_bestEntry.play, _nextId, _samples);
                    _likelyBeaten = _bp > 0.5;
                }
            } catch (e) { _likelyBeaten = false; }
            if (!_isBombRocket && (_gap < 0 || (_oppClose && _gap < 18) || (_likelyBeaten && _gap < 25))) {
                this._recordReasoning([], 'macro_pass', scored.map(s => ({ play: s.play, score: s.score, chosen: s.play.length === 0 })));
                return [];
            }
        }

        if (scored[0].play.length === 0) { this._recordReasoning([], 'heuristic', scored.map(s => ({ play: s.play, score: s.score, chosen: s.play.length === 0 }))); return []; }
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
        const blunderFactor = cfg('blunderFactor.' + this.difficulty) || 0;
        if (!noRandom && blunderFactor > 0 && scored.length > 1 && Math.random() < blunderFactor) {
            chosenPlay = scored[Math.floor(Math.random() * scored.length)].play;
        } else if (!noRandom && Math.random() < randomFactor && scored.length > 1 && scored[1].play.length > 0) {
            chosenPlay = scored[1].play;
        } else {
            chosenPlay = scored[0].play;
        }
        this._recordReasoning(chosenPlay, 'heuristic', scored.map(s => ({ play: s.play, score: s.score, chosen: s.play === chosenPlay })));
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
            if (keyOf(p) === prefKey) continue;
            // 不再限制同长度：领一手对子若比单张被压概率低得多，应允许切换
            cands.push(p);
        }
        let best = preferred, bestScore = -Infinity;
        for (const p of cands) {
            let prob = 0;
            try { prob = belief.beatProbability(p, nextId, samples); } catch (e) { prob = 0; }
            // 期望"能守住这手牌"的收益；长度差异越大惩罚越重，避免为小幅概率差牺牲结构
            let s = (1 - prob) * weight - (p === preferred ? 0 : 2);
            if (s > bestScore) { bestScore = s; best = p; }
        }
        return best || preferred;
    }
    selectLeadSmart(plays, role, hand, state, partnerId) {
        if (!plays || plays.length === 0) return [];
        const handLen = hand.length;
        const landlordId = state.landlord;
        const myId = this.id;
        const countOf = (idx) => {
            const p = state.players ? state.players[idx] : null;
            if (!p) return 20;
            if (Array.isArray(p)) return p.length;
            if (typeof p === 'number') return p;
            return typeof p.length === 'number' ? p.length : 20;
        };
        const nextId = (state.currentPlayer + 1) % 3;
        const partnerId2 = role === 'farmer'
            ? [0,1,2].find(i => i !== myId && i !== landlordId)
            : -1;
        const partnerCount = partnerId2 >= 0 ? countOf(partnerId2) : 20;
        const lordCount = countOf(landlordId);
        const nextCount = countOf(nextId);
        const oppCounts = [0,1,2].filter(i => i !== landlordId).map(countOf);
        const minOpp = Math.min.apply(null, oppCounts);
        // 手里有"结构牌"(顺子/连对/飞机)时优先成组出，别一张一张地磨
        // 拆牌已支持全部手牌数（点数计数 + 最少手数），不再对 >15 张退化
        const plan = decomposeHandDP(hand);
        const planKeys = new Set();
        if (plan && plan.plays) for (const pl of plan.plays) planKeys.add(pl.map(c=>c.id).sort().join(','));
        // 拆牌算出的首手是最优出牌序列的第一步：直接给大额奖励，而不是只当集合用
        const planFirst = (plan && plan.plays && plan.plays[0])
            ? plan.plays[0].map(c => c.id).sort().join(',') : null;
        // 对手手里可能还留着的最大牌（记牌器口径）：用它判断"这手牌能不能守住"
        let maxOutside = 0;
        try { maxOutside = this.memory && this.memory.getMaxOutside ? this.memory.getMaxOutside(hand) : 0; } catch (e) { maxOutside = 0; }
        const leadScore = (p) => {
            const t = getCardType(p);
            if (!t) return -1e9;
            const power = getPlayPower(p);
            const rest = hand.filter(c => !p.some(x => x.id === c.id));
            const turnsBefore = _fastHandTurns(hand);
            const turnsAfter = rest.length ? _fastHandTurns(rest) : 0;
            // 手数下降量主导：出这手让"还差几手"减少越多越好（与残局/rollout 同口径）
            let sc = (turnsBefore - turnsAfter) * 18 + p.length * 6 - power * 0.35;
            if (t.type === CardType.BOMB || t.type === CardType.ROCKET) sc -= 420;
            if (t.type === CardType.STRAIGHT || t.type === CardType.STRAIGHT_PAIR ||
                t.type === CardType.PLANE || t.type === CardType.PLANE_WITH_SINGLE || t.type === CardType.PLANE_WITH_PAIR) sc += 8;
            if (t.type === CardType.TRIPLE_WITH_SINGLE || t.type === CardType.TRIPLE_WITH_PAIR) sc += 4;
            if (p.length === handLen) sc += 400;
            const key = p.map(c=>c.id).sort().join(',');
            if (key === planFirst) sc += 40;             // 拆牌首手：最优先
            else if (planKeys.has(key)) sc += 14;        // 拆牌后续步骤
            // 控制权奖励：这手牌对手压不住 → 下一轮还是我方领出（斗地主的硬通货）
            if (power > maxOutside && t.type !== CardType.BOMB && t.type !== CardType.ROCKET) sc += 26;
            return sc;
        };
        const fullHouse = plays.find(p => p.length === handLen);
        if (fullHouse) return fullHouse;
        if (role === 'landlord') {
            // 对手只剩 1~2 张：出多张组合最安全（他接不上），没有组合才考虑用大牌单张压制
            if (nextCount <= 2 || minOpp <= 2) {
                const safeCombos = plays.filter(p => p.length >= (nextCount <= 2 ? 3 : 2) &&
                    getCardType(p)?.type !== CardType.BOMB && getCardType(p)?.type !== CardType.ROCKET);
                if (safeCombos.length > 0) {
                    return safeCombos.sort((a,b) => (b.length - a.length) || (getPlayPower(a) - getPlayPower(b)))[0];
                }
                if (nextCount <= 1) {
                    const singles = plays.filter(p => p.length === 1);
                    if (singles.length > 0) return singles.sort((a,b) => getPlayPower(b) - getPlayPower(a))[0];
                }
            }
        } else {
            // 队友只剩 1~2 张：把牌让给队友，但只在队友确实是下家时
            if (partnerCount <= 2 && partnerId2 >= 0 && nextId === partnerId2) {
                const cheap = plays.slice().sort((a,b) => getPlayPower(a) - getPlayPower(b));
                return cheap[0];
            }
            // 地主只剩 1~2 张：同样优先安全组合，其次用最大单张压制
            if (lordCount <= 2) {
                const safeCombos = plays.filter(p => p.length >= 3 &&
                    getCardType(p)?.type !== CardType.BOMB && getCardType(p)?.type !== CardType.ROCKET);
                if (safeCombos.length > 0) return safeCombos.sort((a,b) => getPlayPower(a) - getPlayPower(b))[0];
                const singles = plays.filter(p => p.length === 1);
                if (singles.length > 0) return singles.sort((a,b) => getPlayPower(b) - getPlayPower(a))[0];
            }
        }
        let best = null, bestScore = -Infinity;
        for (const p of plays) {
            let sc = leadScore(p);
            if (role === 'farmer') {
                // 农民：地主在下一位时优先"便宜"的牌，别替地主拆大牌
                if (nextId === landlordId) {
                    // 相对评分（保留"压得住"的控制权收益，否则会无脑送小牌）
                    const t2 = getCardType(p);
                    const control = (getPlayPower(p) > maxOutside &&
                        t2 && t2.type !== CardType.BOMB && t2.type !== CardType.ROCKET) ? 40 : 0;
                    sc = p.length * 8 - getPlayPower(p) * 0.9 + control;
                }
                // 小单张（2/3）喂给地主：重罚（地主越接近走完，喂牌越致命）
                if (nextId === landlordId && p.length === 1 && p[0] && p[0].value <= 3) {
                    let _tinyPenalty = cfg('leadAdjust.farmerTinySingleVsLandlord');
                    if (typeof _tinyPenalty !== 'number') _tinyPenalty = 320;
                    sc -= _tinyPenalty;
                }
                // 队友牌多时不要单张磨蹭，尽量成组出
                if (partnerCount > 4 && p.length === 1) sc -= 8;
            } else {
                // 地主：手牌多时优先成组甩，保留单张控制
                if (handLen > 8 && p.length === 1) sc -= 6;
            }
            if (sc > bestScore) { bestScore = sc; best = p; }
        }
        return best || plays[0];
    }
}

