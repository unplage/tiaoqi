// src/params.js — 参数配置与访问层
'use strict';

const DEFAULT_PARAMS = {
    version: 4,
    weights: {
        playPower: 1.0, isBomb: -30, isRocket: -50,
        remainTotal: -2, remainSingle: -1.5, remainPair: -2,
        remainTriple: -4, remainBomb: 15, remainMaxStraight: 3,
        remainBigCards: 3, hasRocket: 10, isLandlord: 5, isFarmer: 0,
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
    endgameThresholds: { legendary: 20, grandmaster: 20, hard: 18, medium: 9, easy: 7 },
    blind: {
        enabled: true,
        worlds: {
            endgame: { easy: 2, medium: 3, hard: 6, grandmaster: 8, legendary: 10 },
            mcts:    { easy: 0, medium: 0, hard: 3, grandmaster: 5, legendary: 6 },
            sim:     { easy: 0, medium: 0, hard: 2, grandmaster: 3, legendary: 4 },
            call:    { easy: 0, medium: 0, hard: 4, grandmaster: 6, legendary: 6 }
        },
        endgameTimeBudgetMs: { easy: 120, medium: 200, hard: 1500, grandmaster: 2500, legendary: 3500 },
        mctsTimeBudgetMs:    { easy: 0, medium: 0, hard: 1800, grandmaster: 3000, legendary: 4500 },
        robustness: 0.25,
        beatProbSamples:   { easy: 0, medium: 0, hard: 6, grandmaster: 8, legendary: 10 },
        beatProbWeight:    { easy: 0, medium: 0, hard: 10, grandmaster: 14, legendary: 18 },
        beatProbCandidates:{ easy: 0, medium: 0, hard: 4, grandmaster: 4, legendary: 5 },
        bombRiskWeight: { easy: 0, medium: 0, hard: 40, grandmaster: 40, legendary: 40 },
        mctsRootPriors: { easy: 0, medium: 0, hard: 1, grandmaster: 1, legendary: 1 },
        callTrials: { legendary: 60 }
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
        farmerTinySingleVsLandlord: 1000,
        bombLeadLate: { bomb: 20, rocket: 30 }
    },
    passScores: {
        farmerPartnerBase: 180, farmerPartnerHandLe3: -80, farmerPartnerHandLe2: 500,
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
        bestProb: 0.80, top2Prob: 0.95, stepLimit: 90
    },
    endgame: {
        maxDepth: 20, bombDepthPenalty: 1,
        maxTotalCards: 24, maxHandCards: 20, maxOptions: 8,
        nodeLimit: 200000, timeBudgetMs: 700
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

const _CFG_CACHE = new Map();

function invalidateParamCache() {
    try { _CFG_CACHE.clear(); } catch (e) {}
}

function cfg(path) {
    const cached = _CFG_CACHE.get(path);
    if (cached !== undefined) return cached.value;
    let out;
    let val = DEFAULT_PARAMS;
    for (const p of path.split('.')) { val = (val && typeof val === 'object') ? val[p] : undefined; if (val === undefined) break; }
    out = val;
    if (_CFG_CACHE.size > 512) _CFG_CACHE.clear();
    _CFG_CACHE.set(path, { value: out });
    return out;
}

class ParamConfig {
    constructor() {
        this._overrides = null;
        this._defaults = DEFAULT_PARAMS;
        this._listeners = [];
    }
    init() {
        let saved = null;
        try { saved = localStorage.getItem('landlord_ai_params'); } catch (e) { saved = null; }
        if (saved) {
            try {
                let data = JSON.parse(saved);
                if (data && data.version === this._defaults.version) {
                    this._overrides = data;
                    return;
                }
            } catch (e) {}
        }
        this._overrides = null;
    }
    get(path) {
        let parts = path.split('.');
        let val = this._overrides;
        if (val) {
            for (let p of parts) { if (val && typeof val === 'object') val = val[p]; else { val = undefined; break; } }
            if (val !== undefined) return val;
        }
        val = this._defaults;
        for (let p of parts) { val = val[p]; if (val === undefined) break; }
        return val;
    }
    set(path, value) { /* ... */ }
    export() { let base = this._overrides ? this._overrides : this._defaults; return JSON.stringify(base, null, 2); }
    import(jsonStr) { /* ... */ }
    reset() { /* ... */ }
    onChange(fn) { if (typeof fn === 'function') this._listeners.push(fn); }
    _persist() { /* ... */ }
}

module.exports = { DEFAULT_PARAMS, cfg, invalidateParamCache, ParamConfig };