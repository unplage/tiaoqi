// src/features.js — 手牌/出牌特征提取
'use strict';

const { CardType } = require('./constants');
const { countValues, isStraight } = require('./utils');
const { getCardType, getPlayPower, typePowerOf, minBeatPower } = require('./card_types');

function extractHandFeatures(hand) {
    if (!hand || !hand.length) {
        return { single:0, pair:0, triple:0, bomb:0, maxStraightLen:0, maxStraightPairLen:0, bigCards:0, hasRocket:0, total:0 };
    }
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
    let values = hand.map(c => c.value);
    let cnt = require('./utils').countValues(values);
    let score = 0;
    let ec = require('./params').cfg('evalCoeffs');
    for (let v in cnt) {
        if (cnt[v] === 4) score += ec.bomb;
        else if (cnt[v] === 3) score += ec.triple;
        else if (cnt[v] === 2) score += ec.pair;
    }
    if (cnt[13] === 1 && cnt[14] === 1) score += ec.bothJokers;
    else { if (cnt[14] === 1) score += ec.bigJokerOnly; if (cnt[13] === 1) score += ec.smallJokerOnly; }
    score += (cnt[12]||0)*ec.ace + (cnt[11]||0)*ec.king + (cnt[10]||0)*ec.queen;
    let sortedUnique = [...new Set(hand.map(c=>c.value).filter(v=>v<12))].sort((a,b)=>a-b);
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

module.exports = { extractHandFeatures, evaluateHandStrength };