// src/decompose.js — 手牌分解 DP
'use strict';

const { getCardType, getAllValidPlays, CardType } = require('./card_types');
const { getCardType: getCardTypeUtil } = require('./utils');
const { _dpCacheKey, _DP_CACHE, _DP_CACHE_MAX } = require('./utils');

function decomposeHandDP(hand) {
    if (!hand || hand.length === 0) return { plays: [], score: 0 };
    if (hand.length > 15) return { plays: [], score: -999 };
    const _ck = _dpCacheKey(hand);
    const _hit = _DP_CACHE.get(_ck);
    if (_hit) return _hit;
    const n = hand.length;
    const idxToCard = hand;
    let cardIndex = {};
    hand.forEach((c, i) => { if (!cardIndex[c.id]) cardIndex[c.id] = []; cardIndex[c.id].push(i); });
    function cardsFromMask(mask) {
        let result = [];
        for (let i = 0; i < n; i++) if (mask & (1 << i)) result.push(idxToCard[i]);
        return result;
    }
    const dp = new Array(1 << n).fill(-1);
    const choice = new Array(1 << n).fill(-1);
    dp[0] = 0;
    for (let mask = 1; mask < (1 << n); mask++) {
        let sub = mask;
        while (sub) {
            const cards = cardsFromMask(sub);
            const t = getCardType(cards);
            if (t) {
                const val = t.type === require('./constants').CardType.ROCKET ? 60 :
                           t.type === require('./constants').CardType.BOMB ? 50 :
                           t.type === require('./constants').CardType.STRAIGHT ? 25 + (t.length || 5) :
                           t.type === require('./constants').CardType.STRAIGHT_PAIR ? 25 + (t.length || 3) :
                           t.type === require('./constants').CardType.PLANE ? 40 + (t.length || 2) * 3 :
                           t.type === require('./constants').CardType.TRIPLE_WITH_SINGLE ? 20 :
                           t.type === require('./constants').CardType.TRIPLE_WITH_PAIR ? 20 :
                           t.type === require('./constants').CardType.PLANE ? 40 :
                           t.type === require('./constants').CardType.PLANE_WITH_SINGLE ? 30 :
                           t.type === require('./constants').CardType.PLANE_WITH_PAIR ? 30 :
                           t.type === require('./constants').CardType.FOUR_WITH_TWO_SINGLE ? 20 :
                           t.type === require('./constants').CardType.FOUR_WITH_TWO_PAIR ? 20 :
                           t.type === require('./constants').CardType.TRIPLE_WITH_SINGLE ? 20 :
                           t.type === require('./constants').CardType.TRIPLE_WITH_PAIR ? 20 :
                           t.type === require('./constants').CardType.PLANE_WITH_SINGLE ? 30 :
                           t.type === require('./constants').CardType.PLANE_WITH_PAIR ? 30 :
                           t.type === require('./constants').CardType.FOUR_WITH_TWO_SINGLE ? 20 :
                           t.type === require('./constants').CardType.FOUR_WITH_TWO_PAIR ? 20 :
                           t.type === require('./constants').CardType.PAIR ? 5 :
                           t.type === require('./constants').CardType.TRIPLE ? 8 :
                           t.type === require('./constants').CardType.SINGLE ? -5 : 0;
                const rest = dp[mask ^ sub];
                if (rest !== -1) {
                    const val = rest + val;
                    if (val > dp[mask]) { dp[mask] = val; choice[mask] = sub; }
                }
            }
            sub = (sub - 1) & mask;
        }
    }
    if (dp[(1 << n) - 1] < 0) return { plays: [], score: -999 };
    let mask = (1 << n) - 1;
    const plays = [];
    while (mask) {
        const sub = choice[mask];
        plays.push(cardsFromMask(sub));
        mask ^= sub;
    }
    const result = { plays, score: dp[(1 << n) - 1] };
    if (_DP_CACHE.size >= _DP_CACHE_MAX) _DP_CACHE.clear();
    _DP_CACHE.set(_dpCacheKey(hand), result);
    return result;
}

function greedyDecompose(hand) {
    if (!hand || hand.length === 0) return { plays: [], score: 0 };
    let h = [...hand].sort((a,b) => b.value - a.value);
    let plays = [];
    let totalScore = 0;
    while (h.length) {
        const playsList = getAllValidPlays(h, null);
        if (!playsList.length) break;
        let best = playsList[0], bestScore = -Infinity;
        for (const p of playsList) {
            const t = getCardType(p);
            if (!t) continue;
            let sc = p.length * 4 - typePowerOf(t.type, t.value, t.length) * 0.25;
            if (sc > bestScore) { bestScore = sc; best = p; }
        }
        plays.push(best);
        totalScore += bestScore;
        const ids = new Set(best.map(c => c.id));
        h = h.filter(c => !ids.has(c.id));
    }
    return { plays, score: totalScore };
}

function typePowerOf(typeStr, value, length) {
    const { CardType } = require('./constants');
    switch (typeStr) {
        case 'rocket': return 1000;
        case 'bomb': return 500 + value;
        case 'single': return value;
        case 'pair': return value + 20;
        case 'triple': return value + 40;
        case 'triple_with_single': return value + 60;
        case 'triple_with_pair': return value + 70;
        case 'straight': return value + 80 + (length || 5);
        case 'straight_pair': return value + 90 + (length || 3);
        case 'plane': return value + 100 + (length || 2) * 3;
        case 'plane_single': return value + 110 + (length || 2) * 3;
        case 'plane_pair': return value + 120 + (length || 2) * 3;
        case 'four_two_single': return value + 110;
        case 'four_two_pair': return value + 120;
        default: return value || 0;
    }
}

module.exports = { decomposeHandDP, greedyDecompose };